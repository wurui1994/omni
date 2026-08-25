// Omni stage0 — JS 后端：OIR -> ES2020
//
// 语义映射（这是永久兼容层，不能"差不多"，见 ADR-0005 / ADR-0006）：
//   int    = i64 -> BigInt，+ - * << 经 BigInt.asIntN(64) 回绕
//   real   = f64 -> number
//   string = UTF-8 字节序列 -> JS 字符串 + 字节视图（length/byteAt/substr 按字节）
//   struct = 值类型 -> 赋值/传参/返回都深拷贝
//   class  = 引用类型 -> 普通对象；字段访问带 null 检查（C 侧同样检查，避免段错误 vs 异常的分叉）
//   list/dict/set -> Array / Map / Set（Map 天然保持插入序）
//   dynamic -> JS 原生值（null/boolean/BigInt/number/string/Array/Map）

import { JS_PRELUDE } from './prelude.js';
import { typeKey } from '../hir/types.js';
import { JS_ABI, JS_ALL, JS_MEMBERS } from '../hir/js_abi.js';

class JsEmitter {
  constructor(mod) {
    this.mod = mod;
    this.out = [];
    this.indent = 0;
    this.tmp = 0;
  }

  line(s) {
    this.out.push('  '.repeat(this.indent) + s);
  }

  emit() {
    this.out.push(JS_PRELUDE.trim());
    this.memberDispatch();
    for (const s of this.mod.structs) this.struct(s);
    for (const c of this.mod.classes ?? []) this.classDecl(c);
    for (const c of this.mod.closures ?? []) this.closureMake(c);
    // JS 前端的模块级变量（ADR-0011）：顶层函数要能互相看见，所以是真全局，
    // 不是 omni_main 的局部量。C 侧对应一批 static omni_dyn。
    for (const g of this.mod.jsGlobals ?? []) this.line(`let g_${g.name} = undefined;`);
    for (const f of this.mod.funcs) this.func(f);
    this.line(`${this.mod.entry}();`);
    // 没人接的错误：和 C 侧的 main 一样，在入口返回之后查一次（ADR-0007 决定 1）
    this.line('$js_check_uncaught();');
    this.line('$flush();');
    return this.out.join('\n') + '\n';
  }

  /**
   * 成员派发器（ADR-0011 第 9 节）。表在 hir/js_abi.js，这里只按表生成：
   * 接收者的标签决定叫哪个 op，表外的成员名当场报错。C 后端有一份逐行对应的生成。
   */
  memberDispatch() {
    for (const d of Object.values(JS_MEMBERS)) {
      const m = d.member;
      const ps = ['r', ...Array.from({ length: m.argc }, (_, i) => `a${i}`)];
      const lits = Object.values(m.lit ?? {}).map((v) => JSON.stringify(v));
      this.line(`function ${d.js}(${ps.join(', ')}) {`);
      this.indent++;
      this.line('switch ($dynTag(r)) {');
      this.indent++;
      for (const [tag, op] of Object.entries(m.on)) {
        const abi = JS_ABI[op];
        // arity 只数 dynamic 实参（含接收者），lit 是额外排在前面的编译期常量
        const args = [...lits, ...ps.slice(0, abi.arity)];
        this.line(`case ${JSON.stringify(tag)}: return ${abi.js}(${args.join(', ')});`);
      }
      // 表外的接收者：属性就是普通属性，方法就是"取属性再当函数调"（ADR-0011 决策 12）
      const get = `$js_obj_get(r, ${JSON.stringify(m.name)})`;
      if (m.kind === 'prop') {
        this.line(`default: return ${get};`);
      } else {
        const call = `$js_call_n(${get}, [${ps.slice(1).join(', ')}])`;
        this.line(`default: return ${d.ret === 'bool' ? `$js_truthy(${call})` : call};`);
      }
      this.indent--;
      this.line('}');
      this.indent--;
      this.line('}');
    }
  }

  /**
   * 闭包记录的构造函数。捕获**在这里**被拷进记录 —— 不靠 JS 的词法作用域，
   * 因为 JS 的闭包是按引用捕获的，而 Omni 规定按值（ADR-0010）；靠宿主的话
   * `for` 循环里创建的闭包在 JS 与 C 上会给出不同答案。
   */
  closureMake(c) {
    const ps = c.captures.map((f) => `c_${f.name}`);
    const fields = c.captures.map((f) => `c_${f.name}: c_${f.name}`);
    this.line(`function ${c.make}(${ps.join(', ')}) { return { fp: ${c.mangled}${fields.length ? `, ${fields.join(', ')}` : ''} }; }`);
  }

  struct(s) {
    const init = s.fields.map((f) => `${f.name}: ${this.zero(f.type)}`).join(', ');
    this.line(`function $new_S${s.name}() { return { ${init} }; }`);
    const copy = s.fields
      .map((f) => `${f.name}: ${f.type.k === 'struct' ? `$cp_S${f.type.name}(v.${f.name})` : `v.${f.name}`}`)
      .join(', ');
    this.line(`function $cp_S${s.name}(v) { return { ${copy} }; }`);
  }

  classDecl(c) {
    const init = c.fields.map((f) => `${f.name}: ${this.zero(f.type)}`).join(', ');
    this.line(`function $new_C${c.name}() { return { ${init} }; }`);
  }

  zero(t) {
    switch (t.k) {
      case 'int': return '0n';
      case 'real': return '0';
      case 'bool': return 'false';
      case 'string': return '""';
      case 'struct': return `$new_S${t.name}()`;
      case 'class': case 'dynamic': case 'null': case 'fn': return 'null';
      case 'list': return '[]';
      case 'dict': return 'new Map()';
      case 'set': return 'new Set()';
      default: throw new Error(`zero: ${t.k}`);
    }
  }

  func(f) {
    // 闭包体的第一个形参是闭包记录本身：捕获从它上面读（C 侧同一套约定）
    const params = [...(f.closureId === undefined ? [] : ['self']), ...f.params.map((p) => `v_${p.name}`)];
    this.line(`function ${f.mangled}(${params.join(', ')}) {`);
    this.indent++;
    // 结构体形参按值传递：入口处深拷贝，等价于 C 的值语义
    for (const p of f.params) {
      if (p.type.k === 'struct') this.line(`v_${p.name} = $cp_S${p.type.name}(v_${p.name});`);
    }
    for (const s of f.body.stmts) this.stmt(s);
    this.indent--;
    this.line('}');
  }

  body(stmts) {
    this.indent++;
    for (const x of stmts) this.stmt(x);
    this.indent--;
  }

  stmt(s) {
    switch (s.kind) {
      case 'Block':
        if (s.transparent) { for (const x of s.stmts) this.stmt(x); break; }
        this.line('{');
        this.body(s.stmts);
        this.line('}');
        break;
      case 'Local':
        this.line(`let v_${s.name} = ${this.rvalue(s.init, s.type)};`);
        break;
      case 'ExprStmt':
        this.line(`${this.expr(s.expr)};`);
        break;
      case 'If':
        this.line(`if (${this.expr(s.cond)}) {`);
        this.body(s.then.stmts);
        if (s.otherwise) {
          this.line('} else {');
          this.body(s.otherwise.stmts);
        }
        this.line('}');
        break;
      case 'While':
        this.line(`while (${this.expr(s.cond)}) {`);
        this.body(s.body.stmts);
        this.line('}');
        break;
      case 'For':
        // init 可能声明多个变量，放在外层块里；step 仍在 for 头部，保证 continue 语义
        this.line('{');
        this.indent++;
        if (s.init) this.stmt(s.init);
        this.line(`for (; ${s.cond ? this.expr(s.cond) : ''}; ${s.step ? this.expr(s.step) : ''}) {`);
        this.body(s.body.stmts);
        this.line('}');
        this.indent--;
        this.line('}');
        break;
      case 'ForIn': {
        const t = s.iterable.type;
        const src = t.k === 'dict' ? `${this.expr(s.iterable)}.keys()` : this.expr(s.iterable);
        const it = `$it${this.tmp++}`;
        this.line(`for (const ${it} of ${src}) {`);
        this.indent++;
        this.line(`let v_${s.varName} = ${this.convert(it, s.elemType, s.varType)};`);
        this.indent--;
        this.body(s.body.stmts);
        this.line('}');
        break;
      }
      case 'Return':
        this.line(s.value ? `return ${this.rvalue(s.value, s.value.type)};` : 'return;');
        break;
      case 'Break': this.line('break;'); break;
      case 'Continue': this.line('continue;'); break;
      default: throw new Error(`js.stmt: ${s.kind}`);
    }
  }

  /** 迭代变量类型与元素类型不同时的转换（目前只有 int -> real 与装箱） */
  convert(code, from, to) {
    if (from.k === 'int' && to.k === 'real') return `Number(${code})`;
    return code;
  }

  /** 需要值语义的位置（初始化/赋值/传参/返回）：结构体左值要拷贝 */
  rvalue(e, type) {
    const src = this.expr(e);
    if (type && type.k === 'struct' && (e.kind === 'VarRef' || e.kind === 'Field')) {
      return `$cp_S${type.name}(${src})`;
    }
    return src;
  }
  expr(e) {
    switch (e.kind) {
      case 'Const':
        if (e.type.k === 'int') return `${e.value}n`;
        if (e.type.k === 'real') return fmtRealLit(e.value);
        if (e.type.k === 'bool') return String(e.value);
        return JSON.stringify(e.value);
      case 'ZeroStruct': return `$new_S${e.type.name}()`;
      case 'NullLit': case 'NullRef': case 'DynNull': case 'NullFn': return 'null';
      case 'NewObject': return `$new_C${e.type.name}()`;
      case 'MakeClosure': return `${e.make}(${e.args.map((x) => this.rvalue(x, x.type)).join(', ')})`;
      case 'CaptureRef': return `self.c_${e.name}`;
      case 'CallFn':
        return `$callFn(${[this.expr(e.callee), ...e.args.map((a) => this.rvalue(a, a.type))].join(', ')})`;
      case 'NewContainer': return this.zero(e.type);
      case 'ListLit': return `[${e.items.map((x) => this.rvalue(x, x.type)).join(', ')}]`;
      case 'SetLit': return `new Set([${e.items.map((x) => this.expr(x)).join(', ')}])`;
      case 'DictLit':
        return `new Map([${e.entries.map((en) => `[${this.expr(en.key)}, ${this.rvalue(en.value, en.value.type)}]`).join(', ')}])`;
      case 'VarRef': return `v_${e.name}`;
      case 'Field': {
        const obj = this.expr(e.object);
        // class 是引用类型，可能为 null；两个后端都显式检查，错误消息一致
        return e.object.type.k === 'class' ? `$nullCheck(${obj}).${e.name}` : `${obj}.${e.name}`;
      }
      case 'Cast':
        if (e.from.k === 'int' && e.type.k === 'real') return `Number(${this.expr(e.expr)})`;
        throw new Error(`js.cast: ${e.from.k}->${e.type.k}`);
      // 装箱在 JS 里是恒等操作：dynamic 就是原生值（ADR-0006 第 2 节）
      case 'Box': return this.expr(e.expr);
      case 'Logic': return `(${this.expr(e.left)} ${e.op} ${this.expr(e.right)})`;
      case 'Un':
        // 一元负号也会溢出：-INT64_MIN == INT64_MIN，必须回绕（C 侧走 omni_neg）
        if (e.op === '-' && e.type.k === 'int') return `$W(-${this.expr(e.operand)})`;
        return `(${e.op}${this.expr(e.operand)})`;
      case 'Cmp': {
        if (e.opType.k === 'dynamic') {
          const eq = `$dynEq(${this.expr(e.left)}, ${this.expr(e.right)})`;
          return e.op === '==' ? eq : `(!${eq})`;
        }
        const op = e.op === '==' ? '===' : e.op === '!=' ? '!==' : e.op;
        return `(${this.expr(e.left)} ${op} ${this.expr(e.right)})`;
      }
      case 'Bin': return this.bin(e);
      // JS 前端的模块级变量（ADR-0011）：一个真全局，可读可写
      case 'JsGlobal': return `g_${e.name}`;
      case 'Ternary': return `(${this.expr(e.cond)} ? ${this.expr(e.then)} : ${this.expr(e.otherwise)})`;
      case 'Assign': return `(${this.expr(e.target)} = ${this.rvalue(e.value, e.type)})`;
      case 'IndexGet': {
        const fn = e.recvType.k === 'list' ? '$listGet' : '$dictGet';
        return `${fn}(${this.expr(e.obj)}, ${this.expr(e.index)})`;
      }
      case 'IndexSet': {
        const fn = e.recvType.k === 'list' ? '$listSet' : '$dictSet';
        return `${fn}(${this.expr(e.obj)}, ${this.expr(e.index)}, ${this.rvalue(e.value, e.type)})`;
      }
      case 'Call':
        return `${e.func}(${e.args.map((a) => this.rvalue(a, a.type)).join(', ')})`;
      case 'Builtin': return this.builtin(e);
      default: throw new Error(`js.expr: ${e.kind}`);
    }
  }

  bin(e) {
    const a = this.expr(e.left);
    const b = this.expr(e.right);
    if (e.opType.k === 'int') {
      switch (e.op) {
        case '+': case '-': case '*': return `$W(${a} ${e.op} ${b})`;
        case '/': return `$div(${a}, ${b})`;
        case '%': return `$mod(${a}, ${b})`;
        case '<<': return `$W(${a} << (${b} & 63n))`;
        case '>>': return `(${a} >> (${b} & 63n))`;
        case '&': case '|': case '^': return `(${a} ${e.op} ${b})`;
        default: throw new Error(`js.bin int: ${e.op}`);
      }
    }
    if (e.opType.k === 'real') {
      if (e.op === '%') return `$fmod(${a}, ${b})`;
      return `(${a} ${e.op} ${b})`;
    }
    if (e.opType.k === 'string' && e.op === '+') return `(${a} + ${b})`;
    throw new Error(`js.bin: ${e.op} on ${e.opType.k}`);
  }

  builtin(e) {
    const a = e.args.map((x) => this.expr(x));
    const recv = e.recvType;
    switch (e.name) {
      case 'print': return `$print($str_${e.argType.k}(${a[0]}))`;
      case 'to_string': return `$str_${e.argType.k}(${a[0]})`;
      case 'trunc': return `$trunc(${a[0]})`;
      case 'chr': return `$chr(${a[0]})`;
      case 'fail': return `$rt_error(${a[0]})`;
      case 'repr': return `$repr_real(${a[0]})`;
      case 'int_of_string': return `$int_of_string(${a[0]})`;
      case 'real_of_string': return `$real_of_string(${a[0]})`;
      case 'len':
        if (recv.k === 'string') return `$slen(${a[0]})`;
        return recv.k === 'list' ? `BigInt(${a[0]}.length)` : `BigInt(${a[0]}.size)`;
      case 'push': return `${a[0]}.push(${a[1]})`;
      case 'add': return `${a[0]}.add(${a[1]})`;
      case 'pop': return `$listPop(${a[0]})`;
      case 'clear': return `(${a[0]}.length = 0)`;
      case 'contains':
        if (recv.k === 'list') return `${a[0]}.includes(${a[1]})`;
        return `${a[0]}.has(${a[1]})`;
      case 'dictGet': return `$dictGet(${a[0]}, ${a[1]})`;
      case 'dictSet': return `$dictSet(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'remove': return `${a[0]}.delete(${a[1]})`;
      case 'keys': return `[...${a[0]}.keys()]`;
      case 'items': return `[...${a[0]}]`;
      case 'byteAt': return `$byteAt(${a[0]}, ${a[1]})`;
      case 'substr': return `$substr(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'indexOf': return `$indexOf(${a[0]}, ${a[1]})`;
      case 'join': return `${a[0]}.join(${a[1]})`;
      case 'tag': return `$dynTag(${a[0]})`;
      case 'asInt': return `$dynAs(${a[0]}, "int")`;
      case 'asReal': return `$dynAs(${a[0]}, "real")`;
      case 'asBool': return `$dynAs(${a[0]}, "bool")`;
      case 'asString': return `$dynAs(${a[0]}, "string")`;
      case 'asList': return `$dynAs(${a[0]}, "list")`;
      case 'asDict': return `$dynAs(${a[0]}, "dict")`;
      case 'dynGet': return `$dynGet(${a[0]}, ${a[1]})`;
      case 'dynSet': return `$dynSet(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'dynLen': return `$dynLen(${a[0]})`;
      case 'dynIter': return `$dynIter(${a[0]})`;
      case 'dynPush': return `$dynPush(${a[0]}, ${a[1]})`;
      case 'dynHas': return `$dynHas(${a[0]}, ${a[1]})`;
      case 'dynKeys': return `$dynKeys(${a[0]})`;
      // JS 前端的运算语义与宿主库（ADR-0011）。这些 op 只由 frontend-js/lower.js 产生，
      // Omni 源码里造不出来 —— truthiness 与 `+` 的双重含义不属于 Omni 语言。
      // 这两个不是函数调用，单列；其余一律走 JS_ABI 表，加 op 不用改这里。
      case 'js_undef': return 'undefined';
      case 'js_ofFn': return a[0];
      default: {
        const abi = JS_ALL[e.name];
        if (!abi) throw new Error(`js.builtin: ${e.name}`);
        const lits = (abi.lit ?? []).map((k) => {
          const v = e[k];
          return typeof v === 'string' ? JSON.stringify(v) : String(v === true);
        });
        return `${abi.js}(${[...lits, ...a].join(', ')})`;
      }
    }
  }
}

function fmtRealLit(v) {
  if (Number.isFinite(v)) return Number.isInteger(v) && Math.abs(v) < 1e21 ? `${v}.0` : String(v);
  return v > 0 ? 'Infinity' : Number.isNaN(v) ? 'NaN' : '-Infinity';
}

/** @param {any} mod OIR 模块 */
export function emitJs(mod) {
  return new JsEmitter(mod).emit();
}
