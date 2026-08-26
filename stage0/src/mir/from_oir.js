/**
 * OIR -> MIR（ADR-0014 决策 6）。
 *
 * OIR 是**树**：表达式嵌套、语句嵌套、类型挂在每个节点上。MIR 是**线性的定长记录表**，
 * 类型收进 8 位的 `t` 字段，多态收进单态的 op 名字。这份文件就是这两件事：
 *
 *   1. 树形表达式 -> 线性 SSA。求值顺序在这里**被钉死**（先左后右、实参从左到右），
 *      不再由后端各自决定 —— 四个后端的行为差异有一半来自这里，钉死它是 MIR 存在的
 *      主要理由之一。
 *   2. 可变变量 -> 槽位（`LOAD`/`STORE`）。见 mir/ir.js 文件头第 1 条：这一层不做
 *      phi，`mem2reg` 是 LLVM 的活，而闭包解释器要的就是槽位。
 *
 * 保留下来的结构：`If`/`While`/`For`/`ForIn` 全部落成 `BLOCK`/`LOOP`/`IF` 标记，
 * `break`/`continue` 落成按层数的 `BR` —— 不生成 goto，不生成基本块。
 *
 * 没有覆盖到的 OIR 节点一律**当场报错**，不静默降级：MIR 的下游是四个后端，
 * 一个悄悄少掉的节点会在四处各自表现成不同的错答案。
 */

import { OmniError } from '../source/diag.js';
import { typeKey } from '../hir/types.js';
import { JS_ALL } from '../hir/js_abi.js';
import {
  OP, REF_NONE, MirFunc, MirModule,
  T_VOID, T_I64, T_F64, T_BOOL, T_STR, T_DYN, T_AGG,
  CVT_I2F, CVT_F2I, CVT_BOX,
} from './ir.js';

/** real 的规范文本。哈希要稳定，所以整数值统一写成 `1.0` 这种形状。 */
function realText(v) {
  const s = String(v);
  if (s === 'Infinity') return 'inf';
  if (s === '-Infinity') return '-inf';
  if (s === 'NaN') return 'nan';
  // 刻意用正则而不是 Number.isInteger：后者不在封闭 ABI 里（ADR-0011 决策 2）
  return /^-?[0-9]+$/.test(s) ? `${s}.0` : s;
}

export function lowerToMir(oir) {
  return new ToMir(oir).run();
}

class ToMir {
  constructor(oir) {
    this.oir = oir;
    this.mod = new MirModule(oir.entry);
    this.f = null;        // 当前函数
    this.scopes = [];     // 名字 -> 槽号，块级遮蔽靠链
    this.regions = [];    // 区域栈，元素是 'if' / 'break' / 'continue' / 'loop'
  }

  run() {
    const m = this.mod;
    for (const g of this.oir.jsGlobals ?? []) m.globalNo(g.name);
    // 闭包模板先登记：MakeClosure 要按 make 名字查号，而它可能出现在模板之前
    for (const c of this.oir.closures ?? []) {
      m.closures.push({ make: c.make, funcName: c.mangled, captures: c.captures.map((x) => x.name) });
    }
    this.closureNo = new Map();
    for (let i = 0; i < m.closures.length; i++) this.closureNo.set(m.closures[i].make, i);
    // 函数也要先全部登记：CALL 用下标，而调用可以往前也可以往后
    for (const f of this.oir.funcs) {
      m.addFunc(new MirFunc(f.mangled, f.params.map((p) => ({ name: p.name, t: this.ty(p.type) })), this.ty(f.ret)));
    }
    for (let i = 0; i < this.oir.funcs.length; i++) this.func(this.oir.funcs[i], m.funcs[i]);
    return m;
  }

  /* ---------------------------------------------------------------- 类型 */

  /** OIR 类型 -> MIR 的 8 位类型码。聚合的身份不在这里，在指令的 aux 上。 */
  ty(t) {
    if (t === undefined || t === null) return T_VOID;
    switch (t.k) {
      case 'void': return T_VOID;
      case 'int': return T_I64;
      case 'real': return T_F64;
      case 'bool': return T_BOOL;
      case 'string': return T_STR;
      case 'dynamic': return T_DYN;
      // null 字面量：能赋给 class 引用、函数值与 dynamic，三者在 MIR 里都是「一个引用」
      case 'null': return T_AGG;
      default: return T_AGG;
    }
  }

  /** 聚合的身份号。key 用 OIR 的 typeKey，所以同一个类型只进池一次。 */
  aggNo(t) {
    const fields = t.fields === undefined ? undefined : t.fields.map((x) => x.name);
    // enum 的载荷是按变体摊平的（ADR-0012），字段名表按变体顺序拼起来
    let fs = fields;
    if (t.k === 'enum') {
      fs = [];
      for (const v of t.variants) for (const x of v.fields) fs.push(`${v.name}.${x.name}`);
    }
    return this.mod.typeNo(typeKey(t), { kind: t.k, name: nameOf(t), fields: fs });
  }

  /* ------------------------------------------------------------ 函数与作用域 */

  func(src, mf) {
    this.f = mf;
    this.scopes = [new Map()];
    this.regions = [];
    if (src.closureId !== undefined) {
      mf.closureId = src.closureId;
      this.captures = this.mod.closures[src.closureId].captures;
    } else {
      this.captures = [];
    }
    // 形参就是槽位。struct/enum 形参按值传（ADR-0005），入口处拷一份 ——
    // JS 后端在函数头做同一件事，这里把它显式化成一条 COPY。
    for (const p of src.params) {
      const s = this.declare(p.name, this.ty(p.type));
      if (p.type.k === 'struct' || p.type.k === 'enum') {
        const v = mf.emit(OP.LOAD, this.ty(p.type), REF_NONE, REF_NONE, s);
        const c = mf.emit(OP.COPY, this.ty(p.type), v, REF_NONE, this.aggNo(p.type));
        mf.emit(OP.STORE, T_VOID, c, REF_NONE, s);
      }
    }
    for (const st of src.body.stmts) this.stmt(st);
    this.f = null;
  }

  declare(name, t) {
    const s = this.f.slot(name, t);
    this.scopes[this.scopes.length - 1].set(name, s);
    return s;
  }

  lookup(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const s = this.scopes[i].get(name);
      if (s !== undefined) return s;
    }
    throw new OmniError(`mir: 未绑定的变量 '${name}'（函数 ${this.f.name}）`);
  }

  /** 匿名的临时槽。逻辑运算符与三元表达式要落在槽上（见 ir.js 头第 1 条）。 */
  temp(t, why) {
    return this.f.slot(`$${why}${this.f.slots.length}`, t);
  }

  /* ---------------------------------------------------------------- 语句 */

  /** 区域：开一层、跑一段、关一层。层数记账全在这里，别处不许碰 this.regions。 */
  open(op, label, a) {
    this.f.emit(op, T_VOID, a, REF_NONE, 0);
    this.regions.push(label);
  }

  close() {
    this.regions.pop();
    this.f.emit(OP.END, T_VOID, REF_NONE, REF_NONE, 0);
  }

  /** 往外数第几层能找到这个标签。找不到就是前端漏了检查，属于编译器 bug。 */
  levelOf(label) {
    for (let i = this.regions.length - 1; i >= 0; i--) {
      if (this.regions[i] === label) return this.regions.length - 1 - i;
    }
    throw new OmniError(`mir: ${label} 没有对应的区域（函数 ${this.f.name}）`);
  }

  block(stmts) {
    this.scopes.push(new Map());
    for (const s of stmts) this.stmt(s);
    this.scopes.pop();
  }

  stmt(s) {
    const f = this.f;
    switch (s.kind) {
      case 'Block':
        // 纯作用域不占区域层：MIR 的层数只为 BR 服务，多一层就要多记一次账
        this.block(s.stmts);
        return;
      case 'Local': {
        const t = this.ty(s.type);
        const v = this.rvalue(s.init, s.type);
        const slot = this.declare(s.name, t);
        f.emit(OP.STORE, T_VOID, v, REF_NONE, slot);
        return;
      }
      case 'ExprStmt':
        this.expr(s.expr);
        return;
      case 'If': {
        const c = this.expr(s.cond);
        this.open(OP.IF, 'if', c);
        this.block(s.then.stmts);
        if (s.otherwise) {
          this.regions.pop();
          f.emit(OP.ELSE, T_VOID, REF_NONE, REF_NONE, 0);
          this.regions.push('if');
          this.block(s.otherwise.stmts);
        }
        this.close();
        return;
      }
      default:
        this.stmt2(s);
    }
  }

  /** 循环与跳转。分两个方法只是为了每个都读得完。 */
  stmt2(s) {
    const f = this.f;
    switch (s.kind) {
      // while：`BLOCK{ LOOP{ BRIF !cond ^1; body; BR ^0 } }` —— 层数语义同 wasm。
      // continue 就是回到 LOOP 头，所以 LOOP 这一层的标签是 'continue'。
      case 'While': {
        this.open(OP.BLOCK, 'break', REF_NONE);
        this.open(OP.LOOP, 'continue', REF_NONE);
        const c = this.expr(s.cond);
        const nc = f.emit(OP.NOT, T_BOOL, c, REF_NONE, 0);
        f.emit(OP.BRIF, T_VOID, nc, REF_NONE, this.levelOf('break'));
        this.block(s.body.stmts);
        f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, this.levelOf('continue'));
        this.close();
        this.close();
        return;
      }
      // for：步进必须在 continue 之后跑，所以 body 再包一层 BLOCK 当 continue 的落点：
      //   BLOCK{ init; LOOP{ BRIF !cond ^1; BLOCK{ body }; step; BR ^0 } }
      case 'For': {
        this.scopes.push(new Map());
        this.open(OP.BLOCK, 'break', REF_NONE);
        if (s.init) this.stmt(s.init);
        this.open(OP.LOOP, 'loop', REF_NONE);
        if (s.cond) {
          const c = this.expr(s.cond);
          const nc = f.emit(OP.NOT, T_BOOL, c, REF_NONE, 0);
          f.emit(OP.BRIF, T_VOID, nc, REF_NONE, this.levelOf('break'));
        }
        this.open(OP.BLOCK, 'continue', REF_NONE);
        this.block(s.body.stmts);
        this.close();
        if (s.step) this.expr(s.step);
        f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, this.levelOf('loop'));
        this.close();
        this.close();
        this.scopes.pop();
        return;
      }
      case 'ForIn': return this.forIn(s);
      case 'Return': {
        const v = s.value === undefined || s.value === null
          ? REF_NONE : this.rvalue(s.value, s.value.type);
        f.emit(OP.RET, T_VOID, v, REF_NONE, 0);
        return;
      }
      case 'Break':
        f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, this.levelOf('break'));
        return;
      case 'Continue':
        f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, this.levelOf('continue'));
        return;
      default:
        throw new OmniError(`mir: 还没有处理的语句 ${s.kind}`);
    }
  }

  /**
   * for-in。MIR 里没有迭代器概念 —— 迭代降成「下标 + 长度」，因为四个后端里只有
   * 解释器能便宜地表示迭代器状态，另外三个都要把它摊成下标循环。
   * dict 迭代键、set 迭代元素，各用一条单态 op 先取出一条 list（与 JS/C 后端同语义）。
   */
  forIn(s) {
    const f = this.f;
    const it = s.iterable.type;
    let seq = this.expr(s.iterable);
    let elemT = s.elemType;
    if (it.k === 'dict') seq = f.emit(OP.CALLOP, T_AGG, this.mod.opNo('keys.dict'), f.pushArgs([seq]), 0);
    else if (it.k === 'set') seq = f.emit(OP.CALLOP, T_AGG, this.mod.opNo('items.set'), f.pushArgs([seq]), 0);
    else if (it.k !== 'list') throw new OmniError(`mir: for-in 还不支持 ${it.k}`);

    this.scopes.push(new Map());
    const iSlot = this.temp(T_I64, 'i');
    const seqSlot = this.temp(T_AGG, 'seq');
    f.emit(OP.STORE, T_VOID, seq, REF_NONE, seqSlot);
    f.emit(OP.STORE, T_VOID, this.mod.consts.int(0), REF_NONE, iSlot);

    this.open(OP.BLOCK, 'break', REF_NONE);
    this.open(OP.LOOP, 'loop', REF_NONE);
    const sq = f.emit(OP.LOAD, T_AGG, REF_NONE, REF_NONE, seqSlot);
    const i = f.emit(OP.LOAD, T_I64, REF_NONE, REF_NONE, iSlot);
    // 长度每轮取一次：JS 的 for-of 在数组上是活的，C 侧的下标循环也是每轮比一次
    const n = f.emit(OP.CALLOP, T_I64, this.mod.opNo('len.list'), f.pushArgs([sq]), 0);
    const done = f.emit(OP.GE, T_BOOL, i, n, 0);
    f.emit(OP.BRIF, T_VOID, done, REF_NONE, this.levelOf('break'));
    const raw = f.emit(OP.IDXGET, this.ty(elemT), sq, i, this.aggNo(it.k === 'list' ? it : { k: 'list', elem: elemT }));
    const v = this.convert(raw, elemT, s.varType);
    const vs = this.declare(s.varName, this.ty(s.varType));
    f.emit(OP.STORE, T_VOID, v, REF_NONE, vs);
    this.open(OP.BLOCK, 'continue', REF_NONE);
    this.block(s.body.stmts);
    this.close();
    const i2 = f.emit(OP.LOAD, T_I64, REF_NONE, REF_NONE, iSlot);
    const inc = f.emit(OP.ADD, T_I64, i2, this.mod.consts.int(1), 0);
    f.emit(OP.STORE, T_VOID, inc, REF_NONE, iSlot);
    f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, this.levelOf('loop'));
    this.close();
    this.close();
    this.scopes.pop();
  }

  /** 迭代变量与元素类型不同时的转换（目前只有 int -> real，和 JS 后端同一条规则）。 */
  convert(ref, from, to) {
    if (from.k === 'int' && to.k === 'real') {
      return this.f.emit(OP.CVT, T_F64, ref, REF_NONE, CVT_I2F);
    }
    return ref;
  }

  /* -------------------------------------------------------------- 表达式 */

  /**
   * 需要值语义的位置（初始化 / 赋值 / 传参 / 返回）：struct 与 enum 的左值要拷贝。
   * 判「是不是左值」的三个节点种类与 JS 后端逐条相同 —— 两边不一致就会在
   * 「改了副本还是改了本体」上分叉，而那种 bug 只在深层容器里才看得见。
   */
  rvalue(e, type) {
    const v = this.expr(e);
    const lval = e.kind === 'VarRef' || e.kind === 'Field' || e.kind === 'EnumPayload';
    if (type && lval && (type.k === 'struct' || type.k === 'enum')) {
      return this.f.emit(OP.COPY, this.ty(type), v, REF_NONE, this.aggNo(type));
    }
    return v;
  }

  args(list) {
    const refs = [];
    for (const a of list) refs.push(this.rvalue(a, a.type));
    return this.f.pushArgs(refs);
  }

  expr(e) {
    const f = this.f;
    const K = this.mod.consts;
    switch (e.kind) {
      case 'Const':
        if (e.type.k === 'int') return K.int(e.value);
        if (e.type.k === 'real') return K.real(realText(e.value));
        if (e.type.k === 'bool') return K.bool(e.value);
        if (e.type.k === 'string') return K.str(e.value);
        throw new OmniError(`mir: 不认识的常量类型 ${e.type.k}`);
      case 'NullLit': case 'NullRef': case 'DynNull': case 'NullFn':
        return K.nul(this.ty(e.type));
      case 'ZeroStruct': case 'ZeroEnum': case 'NewObject': case 'NewContainer':
        return f.emit(OP.NEW, this.ty(e.type), REF_NONE, REF_NONE, this.aggNo(e.type));
      case 'MakeEnum':
        return f.emit(OP.MKENUM, T_AGG, e.tag, this.args(e.args), this.aggNo(e.type));
      case 'EnumTag':
        return f.emit(OP.ETAG, T_I64, this.expr(e.object), REF_NONE, this.aggNo(e.object.type));
      case 'EnumPayload': case 'Field':
        return f.emit(OP.FLD, this.ty(e.type), this.expr(e.object), REF_NONE,
          this.mod.accNo(this.aggNo(e.object.type), e.name));
      case 'VarRef':
        return f.emit(OP.LOAD, this.ty(e.type), REF_NONE, REF_NONE, this.lookup(e.name));
      case 'JsGlobal':
        return f.emit(OP.GLOAD, T_DYN, REF_NONE, REF_NONE, this.mod.globalNo(e.name));
      case 'CaptureRef': {
        const i = this.captures.indexOf(e.name);
        if (i < 0) throw new OmniError(`mir: 捕获 '${e.name}' 不在 ${f.name} 的捕获表里`);
        return f.emit(OP.CAPTURE, this.ty(e.type), REF_NONE, REF_NONE, i);
      }
      default:
        return this.expr2(e);
    }
  }

  /** 运算、调用、容器、赋值。 */
  expr2(e) {
    const f = this.f;
    switch (e.kind) {
      case 'Bin': return f.emit(mirBinOp(e.op), this.ty(e.opType), this.expr(e.left), this.expr(e.right), 0);
      case 'Cmp':
        // `t` 是操作数的类型、结果是 bool（见 ir.js 的 op 表）：dyn 比较靠这一位才认得出来
        return f.emit(mirCmpOp(e.op), this.ty(e.opType), this.expr(e.left), this.expr(e.right), 0);
      case 'Un': {
        const v = this.expr(e.operand);
        if (e.op === '-') return f.emit(OP.NEG, this.ty(e.type), v, REF_NONE, 0);
        if (e.op === '!') return f.emit(OP.NOT, T_BOOL, v, REF_NONE, 0);
        if (e.op === '~') return f.emit(OP.BNOT, this.ty(e.type), v, REF_NONE, 0);
        throw new OmniError(`mir: 一元 ${e.op}`);
      }
      case 'Cast': {
        const v = this.expr(e.expr);
        if (e.from.k === 'int' && e.type.k === 'real') return f.emit(OP.CVT, T_F64, v, REF_NONE, CVT_I2F);
        if (e.from.k === 'real' && e.type.k === 'int') return f.emit(OP.CVT, T_I64, v, REF_NONE, CVT_F2I);
        throw new OmniError(`mir: 转换 ${e.from.k} -> ${e.type.k}`);
      }
      // 装箱在 JS 域是恒等（dynamic 就是原生值），在 C 域是打标签。MIR 保留这条指令 ——
      // 「哪里发生装箱」是后端要知道的事实，丢掉它 C 后端就得自己重新推一遍。
      case 'Box': return f.emit(OP.CVT, T_DYN, this.expr(e.expr), REF_NONE, CVT_BOX);
      case 'Logic': return this.logic(e);
      case 'Ternary': return this.ternary(e);
      case 'Assign': return this.assign(e);
      case 'ListLit': case 'SetLit':
        return f.emit(OP.AGGLIT, T_AGG, REF_NONE, this.args(e.items), this.aggNo(e.type));
      case 'DictLit': {
        const refs = [];
        for (const en of e.entries) {
          refs.push(this.expr(en.key));
          refs.push(this.rvalue(en.value, en.value.type));
        }
        return f.emit(OP.AGGLIT, T_AGG, REF_NONE, f.pushArgs(refs), this.aggNo(e.type));
      }
      case 'IndexGet':
        return f.emit(OP.IDXGET, this.ty(e.type), this.expr(e.obj), this.expr(e.index), this.aggNo(e.recvType));
      case 'IndexSet': {
        const o = this.expr(e.obj);
        const i = this.expr(e.index);
        const v = this.rvalue(e.value, e.type);
        return f.emit(OP.IDXSET, this.ty(e.type), o, f.pushArgs([i, v]), this.aggNo(e.recvType));
      }
      case 'Call':
        return f.emit(OP.CALL, this.ty(e.type), this.mod.funcNo(e.func), this.args(e.args), 0);
      case 'CallFn':
        return f.emit(OP.CALLFN, this.ty(e.type), this.expr(e.callee), this.args(e.args), 0);
      case 'CCall':
        return f.emit(OP.CCALL, this.ty(e.type), this.mod.cabiNo(e.entry), this.args(e.args), 0);
      case 'MakeClosure': {
        const no = this.closureNo.get(e.make);
        if (no === undefined) throw new OmniError(`mir: 没有这个闭包模板 ${e.make}`);
        return f.emit(OP.CLOSURE, T_AGG, no, this.args(e.args), 0);
      }
      case 'Builtin': return this.builtin(e);
      default:
        throw new OmniError(`mir: 还没有处理的表达式 ${e.kind}`);
    }
  }

  /**
   * `&&` / `||`：短路是**控制流**，不是运算。落成「临时槽 + IF」——
   * 这样 MIR 里不存在「有条件求值的表达式」这种东西，四个后端都不用自己发明短路。
   */
  logic(e) {
    const f = this.f;
    const slot = this.temp(T_BOOL, 'logic');
    const a = this.expr(e.left);
    f.emit(OP.STORE, T_VOID, a, REF_NONE, slot);
    if (e.op === '&&') {
      this.open(OP.IF, 'if', a);
      const b = this.expr(e.right);
      f.emit(OP.STORE, T_VOID, b, REF_NONE, slot);
      this.close();
    } else if (e.op === '||') {
      this.open(OP.IF, 'if', a);
      this.regions.pop();
      f.emit(OP.ELSE, T_VOID, REF_NONE, REF_NONE, 0);
      this.regions.push('if');
      const b = this.expr(e.right);
      f.emit(OP.STORE, T_VOID, b, REF_NONE, slot);
      this.close();
    } else {
      throw new OmniError(`mir: 逻辑运算 ${e.op}`);
    }
    return f.emit(OP.LOAD, T_BOOL, REF_NONE, REF_NONE, slot);
  }

  ternary(e) {
    const f = this.f;
    const t = this.ty(e.type);
    const slot = this.temp(t, 'sel');
    const c = this.expr(e.cond);
    this.open(OP.IF, 'if', c);
    f.emit(OP.STORE, T_VOID, this.rvalue(e.then, e.type), REF_NONE, slot);
    this.regions.pop();
    f.emit(OP.ELSE, T_VOID, REF_NONE, REF_NONE, 0);
    this.regions.push('if');
    f.emit(OP.STORE, T_VOID, this.rvalue(e.otherwise, e.type), REF_NONE, slot);
    this.close();
    return f.emit(OP.LOAD, t, REF_NONE, REF_NONE, slot);
  }

  /** 赋值的结果是被赋的值（OIR 里赋值是表达式）。 */
  assign(e) {
    const f = this.f;
    const tgt = e.target;
    const v = this.rvalue(e.value, e.type);
    if (tgt.kind === 'VarRef') {
      f.emit(OP.STORE, T_VOID, v, REF_NONE, this.lookup(tgt.name));
      return v;
    }
    if (tgt.kind === 'JsGlobal') {
      f.emit(OP.GSTORE, T_VOID, v, REF_NONE, this.mod.globalNo(tgt.name));
      return v;
    }
    if (tgt.kind === 'Field' || tgt.kind === 'EnumPayload') {
      const o = this.expr(tgt.object);
      f.emit(OP.FLDSET, T_VOID, o, v, this.mod.accNo(this.aggNo(tgt.object.type), tgt.name));
      return v;
    }
    throw new OmniError(`mir: 不能赋值给 ${tgt.kind}`);
  }

  /**
   * 内建与封闭 ABI 的 op（OIR 的 `Builtin`）→ 一条 `CALLOP`。
   *
   * 两处刻意的规范化：
   *   - **名字单态化**：OIR 的 `len` 靠 `recvType` 区分 list/string/dict，MIR 里是
   *     `len.list` / `len.string`。多态留在名字里，后端与解释器就只需要一张平表，
   *     不必各自再实现一次「按接收者类型选实现」。
   *   - **编译期常量实参进 op 号**：封闭 ABI 里 `lit:` 那些（`js_arith` 的 op、
   *     `js_str_trim` 的 side…）不是运行期值，塞进实参池会让它们看起来像运行期值。
   */
  builtin(e) {
    const f = this.f;
    // 这两个不是调用：JS 域的 undefined 是个常量，js_ofFn 是恒等（ADR-0011）
    if (e.name === 'js_undef') return this.mod.consts.intern(T_DYN, 'undef', 'undefined');
    if (e.name === 'js_ofFn') return this.expr(e.args[0]);

    let name = e.name;
    if (e.argType !== undefined && e.argType !== null) name = `${name}.${e.argType.k}`;
    else if (e.recvType !== undefined && e.recvType !== null) name = `${name}.${e.recvType.k}`;
    const abi = JS_ALL[e.name];
    const lits = [];
    for (const k of (abi === undefined ? [] : abi.lit ?? [])) lits.push(e[k]);

    const refs = [];
    for (const a of e.args) refs.push(this.rvalue(a, a.type));
    return f.emit(OP.CALLOP, this.ty(e.type), this.mod.opNo(name, lits), f.pushArgs(refs), 0);
  }
}

function mirBinOp(op) {
  switch (op) {
    case '+': return OP.ADD;
    case '-': return OP.SUB;
    case '*': return OP.MUL;
    case '/': return OP.DIV;
    case '%': return OP.MOD;
    case '<<': return OP.SHL;
    case '>>': return OP.SHR;
    case '&': return OP.BAND;
    case '|': return OP.BOR;
    case '^': return OP.BXOR;
    default: throw new OmniError(`mir: 二元 ${op}`);
  }
}

function mirCmpOp(op) {
  switch (op) {
    case '==': return OP.EQ;
    case '!=': return OP.NE;
    case '<': return OP.LT;
    case '>=': return OP.GE;
    case '<=': return OP.LE;
    case '>': return OP.GT;
    default: throw new OmniError(`mir: 比较 ${op}`);
  }
}

/** 类型的显示名。容器没有名字，用 typeKey 当名字 —— 它已经是规范化的。 */
function nameOf(t) {
  if (t.k === 'struct' || t.k === 'class' || t.k === 'enum') return t.name;
  return typeKey(t);
}
