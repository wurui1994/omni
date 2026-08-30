// Omni stage0 — OIR 解释器（ADR-0013 阶段 1）
//
// 这是第三个执行器，前两个是"生成 JS 交给宿主引擎"和"生成 C 交给 cc"。它们都在借别人的
// 执行器；这一个是自己的：产物里的编译器不带 node、不带 cc 也能执行代码。
//
// 为什么解释 OIR 而不是 JS 语法树：两个语法前端都已经降级到 OIR，解释这一层，两种语法
// 一起覆盖，而且能进现有的逐字节比对（node == omni-js == omni-c == omni-interp）。
//
// 为什么写在编译器自己的源码里：这份文件会被 JS 前端降级、被 C 后端编译，于是 node 宿主上
// 它是 JS、原生构建里它是 C —— 只有一份实现，不会分叉。
//
// 值表示与 JS 后端逐条相同（ADR-0006 第 2 节、ADR-0011）：
//   int -> BigInt（回绕到 64 位）  real -> number   string -> JS 字符串（按 UTF-8 字节计长）
//   bool -> boolean               list -> Array     dict -> Map（插入序）  set -> Set
//   struct/enum/class -> 普通对象  函数值 -> **本文件里造出来的 lambda**
//
// 最后那条是 ADR-0013 决策 3 的落点：解释器造的函数值就是本语言的一个闭包，降级后是一条
// 普通闭包记录，所以 C 侧的 ABI op（`xs.sort(cmp)` 之类）拿到它就能直接调，不需要任何胶水。

import { OmniError } from '../source/diag.js';
import { stderr, wrapFn, callFnValue } from '../host/native.js';
import { callBuiltin, zeroOf, newInstance, flushOut, failRt, jsCallFn, vecHsum, bufNew, bufGet, bufSet, arrNew, arrLen, arrGet, arrSet, arrPush, arrPop, ptrNew, ptrChk, ptrTChk, ptrLoad, ptrStore, ptrAdd, ptrSub, InterpFail, InterpUncaught } from './builtin.js';

// 语句的结果：正常走完 / break / continue / return。刻意不用异常做控制流 —— C 侧的
// throw 是"待决错误标志 + 普通跳转"（ADR-0007），用信号值两个宿主上形状一致。
const NEXT = 0;
const BREAK = 1;
const CONTINUE = 2;
const RETURN = 3;

/** 一层作用域。链式查找：块级 let 与 for 的初始化都要能遮蔽外层 */
class Env {
  constructor(parent) {
    this.vars = new Map();
    this.parent = parent;
  }

  declare(name, v) {
    this.vars.set(name, v);
  }

  lookup(name) {
    let e = this;
    while (e !== undefined) {
      // 一次探测就够：值是 undefined 的槽才多探一次（JS 里 undefined 是个正经值，
      // 所以不能只看 get 的结果）
      const v = e.vars.get(name);
      if (v !== undefined || e.vars.has(name)) return v;
      e = e.parent;
    }
    throw new OmniError(`interp: unbound variable '${name}'`);
  }

  assign(name, v) {
    let e = this;
    while (e !== undefined) {
      if (e.vars.has(name)) { e.vars.set(name, v); return v; }
      e = e.parent;
    }
    throw new OmniError(`interp: assignment to unbound variable '${name}'`);
  }
}

class Interp {
  constructor(mod) {
    this.mod = mod;
    // 名字 -> 定义。OIR 里函数、结构体、enum、类、闭包都是按名字互相引用的
    this.funcs = new Map();
    for (const f of mod.funcs) this.funcs.set(f.mangled, f);
    this.structs = new Map();
    for (const s of mod.structs) this.structs.set(s.name, s);
    this.enums = new Map();
    for (const e of mod.enums ?? []) this.enums.set(e.name, e);
    this.classes = new Map();
    for (const c of mod.classes ?? []) this.classes.set(c.name, c);
    this.closures = new Map();
    for (const c of mod.closures ?? []) this.closures.set(c.make, c);
    // JS 前端的模块级变量（ADR-0011）：顶层函数要互相看见，所以是一张真全局表
    this.globals = new Map();
    for (const g of mod.jsGlobals ?? []) this.globals.set(g.name, undefined);
    // 核心方言的模块级变量（第二十四刀）：同一张表。初值是 omni_main 最前面那几句赋的，
    // 这里只要把格子开出来。
    for (const g of mod.globals ?? []) this.globals.set(g.name, undefined);
    this.ret = undefined;
    this.depth = 0;
  }

  run() {
    const entry = this.funcs.get(this.mod.entry);
    if (entry === undefined) throw new OmniError(`interp: no entry function '${this.mod.entry}'`);
    this.callFunc(entry, undefined, []);
    return 0;
  }

  /**
   * 调一个 OIR 函数。captures 是闭包记录（Map，name -> 值）或 undefined。
   * 形参的 struct / enum 在入口深拷贝 —— 值语义（ADR-0005），和两个后端逐条一致。
   */
  callFunc(f, captures, args) {
    this.depth = this.depth + 1;
    if (this.depth > 4000) throw new OmniError('interp: call stack too deep');
    const env = new Env(undefined);
    for (let i = 0; i < f.params.length; i++) {
      const p = f.params[i];
      const raw = i < args.length ? args[i] : zeroOf(p.type, this);
      env.declare(p.name, this.copyOf(p.type, raw));
    }
    const frame = { captures };
    this.ret = undefined;
    const sig = this.block(f.body, env, frame);
    const out = sig === RETURN ? this.ret : undefined;
    this.ret = undefined;
    this.depth = this.depth - 1;
    return out;
  }

  /** 一串语句。作用域由调用方给：Block 自己开新的，函数体用形参那一层 */
  block(b, env, frame) {
    for (const s of b.stmts) {
      const sig = this.stmt(s, env, frame);
      if (sig !== NEXT) return sig;
    }
    return NEXT;
  }

  /**
   * 块要不要新开一层作用域：只有**直接**声明了局部量的块才需要。判断结果缓存在节点上。
   * 嵌套的块与 for 的初始化各自会开自己那一层，所以只看直接子语句就够。
   * 循环体每轮仍然是新的一层（scope 每次都造），闭包捕获本来是按值拷（ADR-0010），
   * 所以少开的那些层不影响语义 —— 少的是分配。
   */
  scope(b, env) {
    let s = b.iscoped;
    if (s === undefined) {
      s = false;
      for (const st of b.stmts) {
        if (st.kind === 'Local') { s = true; break; }
      }
      b.iscoped = s;
    }
    return s ? new Env(env) : env;
  }

  stmt(s, env, frame) {
    switch (s.kind) {
      case 'Block':
        // transparent 的块不开作用域：降级器用它把多条语句塞进一个位置（if 的分支等）
        return this.block(s, s.transparent ? env : this.scope(s, env), frame);
      case 'Local':
        env.declare(s.name, this.rvalue(s.init, s.type, env, frame));
        return NEXT;
      case 'ExprStmt':
        this.eval(s.expr, env, frame);
        return NEXT;
      case 'If': {
        if (this.cond(s.cond, env, frame)) return this.block(s.then, this.scope(s.then, env), frame);
        if (s.otherwise) return this.stmt(s.otherwise, env, frame);
        return NEXT;
      }
      case 'While':
        while (this.cond(s.cond, env, frame)) {
          const sig = this.block(s.body, this.scope(s.body, env), frame);
          if (sig === BREAK) break;
          if (sig === RETURN) return sig;
        }
        return NEXT;
      case 'For': {
        // init 单独一层：它声明的变量要能被 cond / step 看见，又不能漏到外面
        const outer = new Env(env);
        if (s.init) this.stmt(s.init, outer, frame);
        while (s.cond === undefined || s.cond === null || this.cond(s.cond, outer, frame)) {
          const sig = this.block(s.body, this.scope(s.body, outer), frame);
          if (sig === BREAK) break;
          if (sig === RETURN) return sig;
          if (s.step) this.eval(s.step, outer, frame);
        }
        return NEXT;
      }
      case 'ForIn': return this.forIn(s, env, frame);
      case 'Return':
        this.ret = s.value ? this.rvalue(s.value, s.value.type, env, frame) : undefined;
        return RETURN;
      case 'Break': return BREAK;
      case 'Continue': return CONTINUE;
      default: throw new OmniError(`interp.stmt: ${s.kind}`);
    }
  }

  /** 条件位置的值一定已经是 bool（truthiness 由降级器插的 js_truthy 负责） */
  cond(e, env, frame) {
    return this.eval(e, env, frame) === true;
  }

  /**
   * for-in。可迭代物按静态类型决定怎么走：dict 迭代键，其余直接迭代自己。
   * 元素类型与迭代变量类型不同时要转换（目前只有 int -> real），和 JS 后端的 convert 一致。
   */
  forIn(s, env, frame) {
    const t = s.iterable.type;
    const src = this.eval(s.iterable, env, frame);
    const items = t.k === 'dict' ? [...src.keys()] : (t.k === 'set' ? [...src] : src);
    for (const raw of items) {
      const inner = new Env(env);
      const v = s.elemType.k === 'int' && s.varType.k === 'real' ? Number(raw) : raw;
      inner.declare(s.varName, v);
      const sig = this.block(s.body, inner, frame);
      if (sig === BREAK) break;
      if (sig === RETURN) return sig;
    }
    return NEXT;
  }

  /** 需要值语义的位置（初始化 / 赋值 / 传参 / 返回）：struct 与 enum 的左值要拷贝 */
  rvalue(e, type, env, frame) {
    const v = this.eval(e, env, frame);
    const lval = e.kind === 'VarRef' || e.kind === 'Field' || e.kind === 'EnumPayload'
      || e.kind === 'CaptureRef' || e.kind === 'JsGlobal' || e.kind === 'GlobalRef';
    if (type && lval) return this.copyOf(type, v);
    return v;
  }

  /** 解引用前的检查，回一个偏移。fat 查空 + 查范围，thin 只查空（范围已经丢了）。 */
  ptrChk(p, size, env, frame) {
    const v = this.eval(p, env, frame);
    return p.type.k === 'tptr' ? ptrTChk(v) : ptrChk(v, size);
  }

  /** struct / enum / vec 是值类型，深拷贝；其余（含 class）是引用，原样 */
  copyOf(t, v) {
    if (t === undefined || v === null || v === undefined) return v;
    // 向量的道都是标量，一层浅拷贝就是深拷贝
    if (t.k === 'vec') return v.slice();
    if (t.k === 'struct') {
      const def = this.structs.get(t.name);
      const out = {};
      for (const f of def.fields) out[f.name] = this.copyOf(f.type, v[f.name]);
      return out;
    }
    if (t.k === 'enum') {
      const def = this.enums.get(t.name);
      const out = { $t: v.$t };
      const variant = def.variants[Number(v.$t)];
      for (const f of variant.fields) out[f.name] = this.copyOf(f.type, v[f.name]);
      return out;
    }
    return v;
  }

  eval(e, env, frame) {
    switch (e.kind) {
      case 'Const':
        return e.type.k === 'int' ? BigInt(e.value) : e.value;
      case 'ZeroStruct': case 'ZeroEnum': case 'NewContainer':
        return zeroOf(e.type, this);
      case 'NewObject': return newInstance(e.type, this);
      case 'MakeEnum': {
        const def = this.enums.get(e.type.name);
        const variant = def.variants[e.tag];
        const out = { $t: BigInt(e.tag) };
        for (let i = 0; i < e.args.length; i++) {
          out[variant.fields[i].name] = this.rvalue(e.args[i], e.args[i].type, env, frame);
        }
        return out;
      }
      case 'EnumTag': return this.eval(e.object, env, frame).$t;
      case 'EnumPayload': return this.eval(e.object, env, frame)[e.name];
      case 'NullLit': case 'NullRef': case 'DynNull': case 'NullFn': return null;
      case 'MakeClosure': return this.makeClosure(e, env, frame);
      case 'CaptureRef': return frame.captures.get(e.name);
      case 'CallFn': {
        const c = e.callee;
        if (c.kind === 'Builtin' && c.name === 'js_asFn') {
          // JS 的动态调用（lower.js 的 dynCall）。js_asFn 是条 raw op —— 它返回的是函数值
          // 本身，过不了 dynamic 的边界，所以整条并成宿主的 js_call_fn：函数值不是函数时的
          // 检查与消息也就留在宿主那一份里（$js_asFn / omni_js_as_fn），和后端发射的
          // $js_call / omni_js_call 是同一条路。实参已经是一条实参表，直接交过去。
          const fv = this.eval(c.args[0], env, frame);
          return jsCallFn(fv, this.rvalue(e.args[0], e.args[0].type, env, frame));
        }
        const f = this.eval(c, env, frame);
        if (f === null || f === undefined) failRt('call of a null function value');
        // 走 ABI 的调用口（js_call_fn）：函数值是这一代的闭包记录，实参是一条 list。
        // 不能写成 `f(...args)` —— 那在 node 上成立、在原生构建上是另一回事（决策 3）。
        return callFnValue(f, e.args.map((a) => this.rvalue(a, a.type, env, frame)));
      }
      case 'ListLit': return e.items.map((x) => this.rvalue(x, x.type, env, frame));
      case 'SetLit': return new Set(e.items.map((x) => this.eval(x, env, frame)));
      case 'DictLit': {
        const m = new Map();
        for (const en of e.entries) {
          m.set(this.eval(en.key, env, frame), this.rvalue(en.value, en.value.type, env, frame));
        }
        return m;
      }
      case 'VarRef': return env.lookup(e.name);
      // 向量四条（ADR-0014 门槛 6 第一阶段）。宿主表示 = 长度等于宽度的数组，
      // 每道一个标量；hsum 的求值顺序在 vecHsum 里钉死。
      case 'VecSplat': {
        const v = this.eval(e.value, env, frame);
        const out = [];
        for (let i = 0; i < e.type.lanes; i++) out.push(v);
        return out;
      }
      case 'VecLit': return e.lanes.map((x) => this.eval(x, env, frame));
      case 'VecLane': return this.eval(e.vec, env, frame)[e.lane];
      case 'VecHsum': return vecHsum(e.vec.type, this.eval(e.vec, env, frame));
      // 缓冲四条（门槛 7 第一阶段）。宿主表示是普通数组，引用语义 —— 所以 copyOf 不动它。
      case 'BufNew': return bufNew(e.type.elem.k, this.eval(e.count, env, frame));
      case 'BufLen': return BigInt(this.eval(e.buf, env, frame).length);
      case 'BufGet': return bufGet(this.eval(e.buf, env, frame), this.eval(e.index, env, frame));
      case 'BufSet': {
        const b = this.eval(e.buf, env, frame);
        const i = this.eval(e.index, env, frame);
        return bufSet(b, i, this.eval(e.value, env, frame));
      }
      // 数组六条（门槛 2 第四刀）。也是普通数组、也是引用语义，copyOf 同样不动它。
      // 末位那个布尔是"元素是值语义、存进去要拷一份"（只有向量），按**静态类型**给 ——
      // 多维数组那一刀之后 Array.isArray 分不开向量与行（见 builtin.js 的 arrCopy）。
      case 'ArrNew': return arrNew(this.eval(e.count, env, frame), this.eval(e.zero, env, frame), e.type.elem.k === 'vec');
      case 'ArrLen': return arrLen(this.eval(e.arr, env, frame));
      case 'ArrGet': return arrGet(this.eval(e.arr, env, frame), this.eval(e.index, env, frame));
      case 'ArrSet': {
        const a = this.eval(e.arr, env, frame);
        const i = this.eval(e.index, env, frame);
        return arrSet(a, i, this.eval(e.value, env, frame), e.arr.type.elem.k === 'vec');
      }
      case 'ArrPush': {
        const a = this.eval(e.arr, env, frame);
        return arrPush(a, this.eval(e.value, env, frame), e.arr.type.elem.k === 'vec');
      }
      case 'ArrPop': return arrPop(this.eval(e.arr, env, frame));
      // 指针（ADR-0016）。这条腿与 backend-js 共用同一套模拟：宿主表示 fat = [addr, base, end]、
      // thin = 一个数。求值顺序在这里显式写出（先 ptr 后 value），因为 C 侧的
      // `*(T*)omni_pchk(p, n) = v` 里那两个子表达式的顺序是未定义的 —— 靠这里钉死。
      case 'PtrNull': return e.type.k === 'tptr' ? 0 : [0, 0, 0];
      case 'PtrNew': return ptrNew(this.eval(e.count, env, frame), e.size);
      case 'PtrIsNull': {
        const p = this.eval(e.ptr, env, frame);
        return (e.ptr.type.k === 'tptr' ? p : p[0]) === 0;
      }
      case 'PtrThin': return this.eval(e.ptr, env, frame)[0];
      case 'PtrLoad': return ptrLoad(e.type.k, this.ptrChk(e.ptr, e.size, env, frame));
      case 'PtrStore': {
        const a = this.ptrChk(e.ptr, e.size, env, frame);
        return ptrStore(e.type.k, a, this.eval(e.value, env, frame));
      }
      case 'PtrAdd': {
        const p = this.eval(e.ptr, env, frame);
        const k = this.eval(e.delta, env, frame);
        return e.ptr.type.k === 'tptr' ? p + Number(k) * e.size : ptrAdd(p, k, e.size);
      }
      case 'PtrField': {
        const p = this.eval(e.ptr, env, frame);
        return e.ptr.type.k === 'tptr' ? p + e.off : ptrAdd(p, BigInt(e.off), 1);
      }
      case 'PtrSub': {
        const a = this.eval(e.a, env, frame);
        const b = this.eval(e.b, env, frame);
        return e.a.type.k === 'tptr' ? BigInt((a - b) / e.size) : ptrSub(a, b, e.size);
      }
      // 只比**地址那一个字**：fat 在这一层是个三元数组，两个指向同一格的指针各是一份
      // 拷贝，`===` 比引用就永远不等。跨块也有定义：地址不同，答案是 false。
      case 'PtrEq': {
        const a = this.eval(e.a, env, frame);
        const b = this.eval(e.b, env, frame);
        return e.a.type.k === 'tptr' ? a === b : a[0] === b[0];
      }
      case 'JsGlobal': return this.globals.get(e.name);
      case 'GlobalRef': return this.globals.get(e.name);
      case 'Field': {
        const o = this.eval(e.object, env, frame);
        // class 是引用类型，可能为 null：两个后端都显式检查，消息一致（prelude 的 $nullCheck）
        if (e.object.type.k === 'class' && (o === null || o === undefined)) {
          failRt('null reference');
        }
        return o[e.name];
      }
      case 'Cast': return e.from.k === 'int' && e.type.k === 'real'
        ? Number(this.eval(e.expr, env, frame))
        : this.eval(e.expr, env, frame);
      // 装箱在这里是恒等：dynamic 就是原生值（ADR-0006 第 2 节）
      case 'Box': return this.eval(e.expr, env, frame);
      case 'Logic':
        return e.op === '&&'
          ? (this.cond(e.left, env, frame) ? this.cond(e.right, env, frame) : false)
          : (this.cond(e.left, env, frame) ? true : this.cond(e.right, env, frame));
      case 'Ternary':
        return this.cond(e.cond, env, frame)
          ? this.eval(e.then, env, frame)
          : this.eval(e.otherwise, env, frame);
      case 'Assign': return this.assign(e, env, frame);
      case 'Call': {
        const f = this.funcs.get(e.func);
        if (f === undefined) throw new OmniError(`interp: no such function '${e.func}'`);
        return this.callFunc(f, undefined, e.args.map((a) => this.rvalue(a, a.type, env, frame)));
      }
      default: return callBuiltin(this, e, env, frame);
    }
  }

  /**
   * 闭包。捕获在这里按值拷进记录（ADR-0010）——不靠宿主的词法作用域，那是按引用捕获的，
   * `for` 里创建的闭包会在两个后端给出不同答案。
   *
   * 返回的是**本文件里的一个 lambda**。这一句是 ADR-0013 决策 3 的落点：降级之后它就是
   * 一条普通的闭包记录（第一字段是函数指针），所以 C 侧的 ABI op 拿到它可以直接调，
   * 解释出来的函数与 AOT 编出来的函数在 C 侧不可区分。
   */
  makeClosure(e, env, frame) {
    const def = this.closures.get(e.make);
    if (def === undefined) throw new OmniError(`interp: no such closure '${e.make}'`);
    const caps = new Map();
    for (let i = 0; i < def.captures.length; i++) {
      const a = e.args[i];
      caps.set(def.captures[i].name, this.rvalue(a, a.type, env, frame));
    }
    const body = this.funcs.get(def.mangled);
    if (body === undefined) throw new OmniError(`interp: closure body '${def.mangled}' is missing`);
    // wrapFn：解释器造出来的函数值必须**就是**这一代的闭包记录，宿主库那些回调 op
    // （xs.map(f) 之类）拿到它才能直接调（ADR-0013 决策 3）。fp 收到的那条 list 是
    // **实参表**：JS 域的函数体只有一个形参，绑的就是整条表，所以要再包一层；Omni 域的
    // 函数体形参是按位置绑的，那条表本身就是位置实参。判据在模块上（lower.js 的 js: true）。
    if (this.mod.js === true) return wrapFn((self, args) => this.callFunc(body, caps, [args]));
    return wrapFn((self, args) => this.callFunc(body, caps, args));
  }

  assign(e, env, frame) {
    const t = e.target;
    const v = this.rvalue(e.value, e.type, env, frame);
    switch (t.kind) {
      case 'VarRef': return env.assign(t.name, v);
      case 'JsGlobal': this.globals.set(t.name, v); return v;
      case 'GlobalRef': this.globals.set(t.name, v); return v;
      case 'CaptureRef': frame.captures.set(t.name, v); return v;
      case 'Field': case 'EnumPayload': {
        const o = this.eval(t.object, env, frame);
        if (o === null || o === undefined) failRt('null reference');
        o[t.name] = v;
        return v;
      }
      default: throw new OmniError(`interp.assign: ${t.kind}`);
    }
  }
}

/**
 * 解释执行一个 OIR 模块，返回进程退出码。
 * 被解释的程序自己的运行期错误在这里收住：和编译出来的程序一样，`omni: runtime error: ...`
 * 走 stderr、退出码 70（ADR-0005），而不是当成编译器自己的错误。
 * @param {any} mod OIR 模块
 */
export function interpret(mod) {
  const I = new Interp(mod);
  try {
    I.run();
  } catch (e) {
    if (e instanceof InterpFail) {
      stderr(`omni: runtime error: ${e.message}\n`);
      return 70;
    }
    // 没被 catch 住的 throw：两个后端都只打这一行（宿主的栈回溯 C 侧打不出来）
    if (e instanceof InterpUncaught) {
      stderr(`omni: uncaught: ${e.message}\n`);
      return 70;
    }
    throw e;
  }
  flushOut();
  return 0;
}

/**
 * 常驻解释器会话（REPL 用）。
 *
 * 解释器的状态本来就是**按名字**的几张表（funcs / structs / enums / classes / closures /
 * globals），所以"增量"在这一层几乎是免费的：新一批的定义并进表里，全局量的格子留着不动，
 * 然后只跑这一批的入口函数 —— 旧批次不重跑。REPL 因此不再需要"重放整个会话"。
 *
 * 为什么 REPL 走这个执行器而不是把 JS 后端的产物 eval 掉：这一份是我们自己的执行器
 * （ADR-0013），而且它在五方逐字节比对里，语义与 JS/C 两条腿是同一套 builtin.js。
 */
export class InterpSession {
  constructor() {
    this.I = new Interp({
      funcs: [], structs: [], enums: [], classes: [], closures: [], globals: [], entry: null,
    });
    // 常驻的顶层作用域：每批的入口函数**共用**它，所以第一批的 `x = 10` 第二批还在。
    // 检查器那边对应的是 Checker.topScope —— 两边必须一起在，否则会一边过检查一边找不到变量。
    this.env = new Env(undefined);
  }

  /** 把一批新增的 OIR 并进会话。同名重定义按后来者算（REPL 里重新定义一个函数是常事）。 */
  install(mod) {
    const I = this.I;
    if (mod.js === true) I.mod.js = true;
    for (const f of mod.funcs ?? []) I.funcs.set(f.mangled, f);
    for (const s of mod.structs ?? []) I.structs.set(s.name, s);
    for (const e of mod.enums ?? []) I.enums.set(e.name, e);
    for (const c of mod.classes ?? []) I.classes.set(c.name, c);
    for (const c of mod.closures ?? []) I.closures.set(c.make, c);
    // 全局量的**值**要留住：只给没见过的名字开格子
    for (const g of mod.jsGlobals ?? []) if (!I.globals.has(g.name)) I.globals.set(g.name, undefined);
    for (const g of mod.globals ?? []) if (!I.globals.has(g.name)) I.globals.set(g.name, undefined);
  }

  /**
   * 跑一批的入口函数。它的顶层作用域是会话那一个（`this.env`），不是新开的 ——
   * 于是上一批声明的变量这一批还在。运行期错误收在这里：一批跑挂了不该掀翻会话。
   * @returns {{failed: boolean, err: string}}
   */
  runEntry(name) {
    const f = this.I.funcs.get(name);
    if (f === undefined) throw new OmniError(`interp: no entry function '${name}'`);
    try {
      this.I.depth = 0;
      this.I.ret = undefined;
      this.I.block(f.body, this.env, { captures: undefined });
      this.I.ret = undefined;
    } catch (e) {
      flushOut();
      if (e instanceof InterpFail) return { failed: true, err: `omni: runtime error: ${e.message}\n` };
      if (e instanceof InterpUncaught) return { failed: true, err: `omni: uncaught: ${e.message}\n` };
      throw e;
    }
    flushOut();
    return { failed: false, err: '' };
  }
}


