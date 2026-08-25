// Omni stage0 — C 后端：OIR -> C99
//
// C 后端是自举的必经之路，因此它的正确性优先于一切。输出要求：
//   1) 只 #include "omni.h"，运行时是 stage0/runtime/ 下真正的 C 文件（不再内联进来）；
//      需要单文件时走 `emit-c --amalgamate`
//   2) 可读、可 gdb —— 生成的 C 是给人看的第一手调试材料
//   3) 无编译器扩展（computed goto 等留到 VM 阶段再作为可选开关）
//
// 发射顺序是被 C 的"用前须完整"规则逼出来的，改动前先读懂：
//   运行时 -> 容器/类的指针 typedef -> struct 定义 -> class 定义
//   -> 容器结构体 -> 容器函数 -> struct/class 的零值构造 -> 函数原型 -> 函数体
// 引用类型（容器、class）全是指针 typedef，所以互相嵌套无需任何拓扑假设；
// 只有"按值嵌套"的 struct 需要拓扑排序。

import { RUNTIME_INCLUDE, amalgamate } from '../runtime/c_runtime.js';
import { cTypeName, listType, typeKey } from '../hir/types.js';
import { JS_ABI } from '../hir/js_abi.js';

/** dict/set 的键需要 hash；list.contains 只需要 eq */
const HASH_FN = { int: 'omni_hash_int', real: 'omni_hash_real', bool: 'omni_hash_bool', string: 'omni_hash_string' };
const EQ_FN = {
  int: 'omni_eq_int', real: 'omni_eq_real', bool: 'omni_eq_bool', string: 'omni_eq_string',
  dynamic: 'omni_eq_dyn', class: 'omni_eq_ref',
};
const KSTR_FN = { int: 'omni_kstr_int', real: 'omni_kstr_real', bool: 'omni_kstr_bool', string: 'omni_kstr_string' };
const DYN_TAG = { list: 'OMNI_DYN_LIST', dict: 'OMNI_DYN_DICT' };

class CEmitter {
  constructor(mod, opts = {}) {
    this.mod = mod;
    this.out = [];
    this.indent = 0;
    this.tmp = 0;
    this.opts = opts;
  }

  line(s = '') {
    this.out.push(s ? '  '.repeat(this.indent) + s : '');
  }

  emit() {
    const structs = this.sortStructs();
    const classes = this.mod.classes ?? [];
    const containers = this.mod.containers ?? [];
    const closures = this.mod.closures ?? [];
    const fnTypes = this.mod.fnTypes ?? [];

    this.out.push(this.opts.amalgamate ? amalgamate().trim() : RUNTIME_INCLUDE);
    this.line();
    for (const t of containers) this.line(`OMNI_REF_DECL(${cTypeName(t)})`);
    for (const c of classes) this.line(`OMNI_REF_DECL(c_${c.name})`);
    this.line();
    for (const s of structs) this.structBody(s);
    for (const c of classes) this.classBody(c);
    for (const t of containers) this.containerBody(t);
    this.line();
    for (const t of containers) this.containerDefine(t);
    this.dynBridge(containers);
    this.line();
    for (const c of closures) this.closureBody(c);
    for (const t of fnTypes) this.fnCallHelper(t);
    this.line();
    for (const s of structs) this.structNew(s);
    for (const c of classes) this.classNew(c);
    for (const f of this.mod.funcs) this.line(`${this.proto(f)};`);
    this.line();
    for (const c of closures) this.closureMake(c);
    for (const f of this.mod.funcs) this.func(f);
    this.line(`int main(void) { ${this.mod.entry}(); fflush(stdout); return 0; }`);
    return this.out.join('\n') + '\n';
  }

  /**
   * 闭包记录（ADR-0010）。第一个字段必须是 `fp`，与 `struct omni_closure_s` 布局一致 ——
   * 调用助手只认得那一个字段，捕获的部分由被调函数自己按本布局解释。
   */
  closureBody(c) {
    this.line(`struct ${c.mangled}_env {`);
    this.indent++;
    this.line('omni_fnptr fp;');
    for (const f of c.captures) this.line(`${cTypeName(f.type)} c_${f.name};`);
    this.indent--;
    this.line('};');
  }

  closureMake(c) {
    const ps = c.captures.map((f) => `${cTypeName(f.type)} c_${f.name}`);
    this.line(`static omni_fn ${c.make}(${ps.length ? ps.join(', ') : 'void'}) {`);
    this.indent++;
    this.line(`struct ${c.mangled}_env *e = (struct ${c.mangled}_env *)omni_alloc(sizeof *e);`);
    this.line(`e->fp = (omni_fnptr)${c.mangled};`);
    for (const f of c.captures) this.line(`e->c_${f.name} = c_${f.name};`);
    this.line('return (omni_fn)e;');
    this.indent--;
    this.line('}');
  }

  /**
   * 每个函数值签名一个类型化的调用助手。为什么不在调用处直接展开强制转换：那样 `f` 会被
   * 求值两次（一次取 fp、一次当 self 传进去），`get_handler()(x)` 就会调用两次 get_handler。
   */
  fnCallHelper(t) {
    const ret = cTypeName(t.ret);
    const decl = t.params.map((p, i) => `${cTypeName(p)} a${i}`);
    const sig = `${ret} (*)(omni_fn${t.params.map((p) => `, ${cTypeName(p)}`).join('')})`;
    const call = `((${sig})omni_fn_ck(f)->fp)(f${t.params.map((_, i) => `, a${i}`).join('')})`;
    this.line(`static inline ${ret} omni_call_${typeKey(t)}(omni_fn f${decl.length ? `, ${decl.join(', ')}` : ''}) {`);
    this.indent++;
    this.line(t.ret.k === 'void' ? `${call};` : `return ${call};`);
    this.indent--;
    this.line('}');
  }

  /** 结构体按字段依赖拓扑排序：C 里按值嵌套要求被嵌套者已是完整类型 */
  sortStructs() {
    const byName = new Map(this.mod.structs.map((s) => [s.name, s]));
    const done = new Set();
    const order = [];
    const visit = (s, stack) => {
      if (done.has(s.name)) return;
      if (stack.has(s.name)) throw new Error(`recursive struct by value: ${s.name}`);
      stack.add(s.name);
      for (const f of s.fields) {
        if (f.type.k === 'struct') visit(byName.get(f.type.name), stack);
      }
      stack.delete(s.name);
      done.add(s.name);
      order.push(s);
    };
    for (const s of this.mod.structs) visit(s, new Set());
    return order;
  }

  structBody(s) {
    this.line(`struct s_${s.name}_s {`);
    this.indent++;
    for (const f of s.fields) this.line(`${cTypeName(f.type)} f_${f.name};`);
    this.indent--;
    this.line(`};`);
    this.line(`typedef struct s_${s.name}_s s_${s.name};`);
  }

  classBody(c) {
    this.line(`struct c_${c.name}_s {`);
    this.indent++;
    for (const f of c.fields) this.line(`${cTypeName(f.type)} f_${f.name};`);
    this.indent--;
    this.line(`};`);
  }

  containerBody(t) {
    const n = cTypeName(t);
    if (t.k === 'list') this.line(`OMNI_LIST_BODY(${n}, ${cTypeName(t.elem)})`);
    else if (t.k === 'dict') this.line(`OMNI_DICT_BODY(${n}, ${cTypeName(t.key)}, ${cTypeName(t.val)})`);
    else this.line(`OMNI_SET_BODY(${n}, ${cTypeName(t.elem)})`);
  }

  containerDefine(t) {
    const n = cTypeName(t);
    if (t.k === 'list') {
      this.line(`OMNI_LIST_DEFINE(${n}, ${cTypeName(t.elem)})`);
      const eq = EQ_FN[t.elem.k];
      if (eq) this.line(`OMNI_LIST_EQ_DEFINE(${n}, ${cTypeName(t.elem)}, ${eq})`);
      return;
    }
    if (t.k === 'dict') {
      this.line(`OMNI_DICT_DEFINE(${n}, ${cTypeName(t.key)}, ${cTypeName(t.val)}, `
        + `${HASH_FN[t.key.k]}, ${EQ_FN[t.key.k]}, ${KSTR_FN[t.key.k]}, ${cTypeName(listType(t.key))})`);
      return;
    }
    this.line(`OMNI_SET_DEFINE(${n}, ${cTypeName(t.elem)}, `
      + `${HASH_FN[t.elem.k]}, ${EQ_FN[t.elem.k]}, ${cTypeName(listType(t.elem))})`);
  }

  /**
   * dynamic 的运行期分派桥。只有当 `list<dynamic>` 与 `dict<string,dynamic>` 都实例化了才发射
   * —— 检查器在生成任何 dyn* 操作时都会登记这两个类型，所以需要时一定在。
   */
  dynBridge(containers) {
    const names = new Set(containers.map((t) => cTypeName(t)));
    if (names.has('omni_list_dynamic') && names.has('omni_dict_string_dynamic')) {
      this.line('OMNI_DYN_BRIDGE(omni_list_dynamic, omni_dict_string_dynamic)');
      // JS 宿主库里碰容器的那批 op（ADR-0011）。同一个理由：要具体的容器类型，
      // 所以只能在这两个实例化之后展开。
      this.line('OMNI_JS_ARR(omni_list_dynamic, omni_dict_string_dynamic)');
      // OBJ 在 ARR 之后：Map 的条目值是个两元素 list，要用到 ARR 里的 omni_js_arr_wrap
      this.line('OMNI_JS_OBJ(omni_list_dynamic, omni_dict_string_dynamic)');
    }
  }

  /** 零值构造：容器字段必须是**新建的空容器**，不能是 NULL —— 与 JS 后端的 $new_S 对齐 */
  structNew(s) {
    this.line(`static s_${s.name} omni_new_S_${s.name}(void) {`);
    this.indent++;
    this.line(`s_${s.name} v;`);
    for (const f of s.fields) this.line(`v.f_${f.name} = ${this.zeroExpr(f.type)};`);
    this.line('return v;');
    this.indent--;
    this.line('}');
  }

  classNew(c) {
    this.line(`static c_${c.name} omni_new_C_${c.name}(void) {`);
    this.indent++;
    this.line(`c_${c.name} o = (c_${c.name})omni_alloc(sizeof(struct c_${c.name}_s));`);
    for (const f of c.fields) this.line(`o->f_${f.name} = ${this.zeroExpr(f.type)};`);
    this.line('return o;');
    this.indent--;
    this.line('}');
  }

  zeroExpr(t) {
    switch (t.k) {
      case 'int': return 'INT64_C(0)';
      case 'real': return '0.0';
      case 'bool': return 'false';
      case 'string': return 'omni_str_new("", 0)';
      case 'struct': return `omni_new_S_${t.name}()`;
      case 'class': case 'fn': return 'NULL';
      case 'dynamic': return 'omni_dyn_null()';
      case 'list': case 'dict': case 'set': return `${cTypeName(t)}_new()`;
      default: throw new Error(`c.zero: ${t.k}`);
    }
  }
  proto(f) {
    // 闭包体的第一个形参是闭包记录自己：既是"环境"，也是被 self 指针解释的那块内存
    const self = f.closureId === undefined ? [] : ['omni_fn self_'];
    const params = [...self, ...f.params.map((p) => `${cTypeName(p.type)} v_${p.name}`)];
    return `static ${cTypeName(f.ret)} ${f.mangled}(${params.length ? params.join(', ') : 'void'})`;
  }

  func(f) {
    this.line(`${this.proto(f)} {`);
    this.indent++;
    if (f.closureId !== undefined) {
      const c = (this.mod.closures ?? [])[f.closureId];
      if (c.captures.length) this.line(`struct ${c.mangled}_env *self = (struct ${c.mangled}_env *)self_;`);
      else this.line('(void)self_;');
    }
    for (const s of f.body.stmts) this.stmt(s);
    this.indent--;
    this.line('}');
    this.line();
  }

  stmt(s) {
    switch (s.kind) {
      case 'Block':
        if (s.transparent) { for (const x of s.stmts) this.stmt(x); break; }
        this.line('{');
        this.indent++;
        for (const x of s.stmts) this.stmt(x);
        this.indent--;
        this.line('}');
        break;
      case 'Local':
        this.line(`${cTypeName(s.type)} v_${s.name} = ${this.expr(s.init)};`);
        break;
      case 'ExprStmt':
        this.line(`${this.expr(s.expr)};`);
        break;
      case 'If':
        this.line(`if (${this.expr(s.cond)}) {`);
        this.indent++;
        for (const x of s.then.stmts) this.stmt(x);
        this.indent--;
        if (s.otherwise) {
          this.line('} else {');
          this.indent++;
          for (const x of s.otherwise.stmts) this.stmt(x);
          this.indent--;
        }
        this.line('}');
        break;
      case 'While':
        this.line(`while (${this.expr(s.cond)}) {`);
        this.indent++;
        for (const x of s.body.stmts) this.stmt(x);
        this.indent--;
        this.line('}');
        break;
      case 'For':
        this.line('{');
        this.indent++;
        if (s.init) this.stmt(s.init);
        this.line(`for (; ${s.cond ? this.expr(s.cond) : ''}; ${s.step ? this.expr(s.step) : ''}) {`);
        this.indent++;
        for (const x of s.body.stmts) this.stmt(x);
        this.indent--;
        this.line('}');
        this.indent--;
        this.line('}');
        break;
      case 'ForIn': this.forIn(s); break;
      case 'Return':
        this.line(s.value ? `return ${this.expr(s.value)};` : 'return;');
        break;
      case 'Break': this.line('break;'); break;
      case 'Continue': this.line('continue;'); break;
      default: throw new Error(`c.stmt: ${s.kind}`);
    }
  }

  /**
   * 迭代协议：list 走 items[0..len)，dict/set 走 keys[0..n) 并跳过墓碑。
   * 条目数组即插入序，所以顺序与 JS 的 Map/Set 迭代逐位一致（ADR-0006）。
   */
  forIn(s) {
    const t = s.iterable.type;
    const id = this.tmp++;
    const c = `it${id}_c`;
    const i = `it${id}_i`;
    this.line('{');
    this.indent++;
    this.line(`${cTypeName(t)} ${c} = ${this.expr(s.iterable)};`);
    const bound = t.k === 'list' ? `${c}->len` : `${c}->n`;
    this.line(`for (int64_t ${i} = 0; ${i} < ${bound}; ${i}++) {`);
    this.indent++;
    if (t.k !== 'list') this.line(`if (!${c}->live[${i}]) continue;`);
    const slot = t.k === 'list' ? `${c}->items[${i}]` : `${c}->keys[${i}]`;
    this.line(`${cTypeName(s.varType)} v_${s.varName} = ${this.convert(slot, s.elemType, s.varType)};`);
    for (const x of s.body.stmts) this.stmt(x);
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
  }

  /** 迭代变量类型与元素类型不同时的转换（int -> real、装箱） */
  convert(code, from, to) {
    if (from.k === 'int' && to.k === 'real') return `(double)(${code})`;
    if (to.k === 'dynamic' && from.k !== 'dynamic') return this.box(code, from);
    return code;
  }

  box(code, from) {
    switch (from.k) {
      case 'int': return `omni_dyn_of_int(${code})`;
      case 'real': return `omni_dyn_of_real(${code})`;
      case 'bool': return `omni_dyn_of_bool(${code})`;
      case 'string': return `omni_dyn_of_string(${code})`;
      case 'list': case 'dict': return `omni_dyn_of_ref((void *)(${code}), ${DYN_TAG[from.k]})`;
      case 'dynamic': return code;
      case 'null': return 'omni_dyn_null()';
      default: throw new Error(`c.box: ${from.k}`);
    }
  }
  expr(e) {
    switch (e.kind) {
      case 'Const': return this.constant(e);
      case 'ZeroStruct': return `omni_new_S_${e.type.name}()`;
      case 'NullLit': case 'NullRef': case 'NullFn': return 'NULL';
      case 'DynNull': return 'omni_dyn_null()';
      case 'NewObject': return `omni_new_C_${e.type.name}()`;
      case 'MakeClosure': return `${e.make}(${e.args.map((x) => this.expr(x)).join(', ')})`;
      case 'CaptureRef': return `self->c_${e.name}`;
      case 'CallFn':
        return `omni_call_${typeKey(e.fnType)}(${[this.expr(e.callee), ...e.args.map((a) => this.expr(a))].join(', ')})`;
      case 'NewContainer': return `${cTypeName(e.type)}_new()`;
      case 'ListLit': return this.listLit(e);
      case 'DictLit': return this.dictLit(e);
      case 'SetLit': return this.setLit(e);
      case 'VarRef': return `v_${e.name}`;
      case 'Field': {
        const obj = this.expr(e.object);
        // class 是引用，可能为 null：显式检查，避免"段错误 vs 异常"的跨后端分叉
        return e.object.type.k === 'class'
          ? `((${cTypeName(e.object.type)})omni_nullck(${obj}))->f_${e.name}`
          : `${obj}.f_${e.name}`;
      }
      case 'Cast':
        if (e.from.k === 'int' && e.type.k === 'real') return `(double)(${this.expr(e.expr)})`;
        throw new Error(`c.cast: ${e.from.k}->${e.type.k}`);
      case 'Box': return this.box(this.expr(e.expr), e.from);
      case 'Logic': return `(${this.expr(e.left)} ${e.op} ${this.expr(e.right)})`;
      case 'Un':
        if (e.op === '-' && e.type.k === 'int') return `omni_neg(${this.expr(e.operand)})`;
        return `(${e.op}${this.expr(e.operand)})`;
      case 'Cmp': {
        if (e.opType.k === 'string') {
          return `(omni_str_cmp(${this.expr(e.left)}, ${this.expr(e.right)}) ${e.op} 0)`;
        }
        if (e.opType.k === 'dynamic') {
          const eq = `omni_dyn_eq(${this.expr(e.left)}, ${this.expr(e.right)})`;
          return e.op === '==' ? eq : `(!${eq})`;
        }
        return `(${this.expr(e.left)} ${e.op} ${this.expr(e.right)})`;
      }
      case 'Bin': return this.bin(e);
      case 'Ternary': return `(${this.expr(e.cond)} ? ${this.expr(e.then)} : ${this.expr(e.otherwise)})`;
      case 'Assign': return `(${this.expr(e.target)} = ${this.expr(e.value)})`;
      case 'IndexGet': return `${cTypeName(e.recvType)}_get(${this.expr(e.obj)}, ${this.expr(e.index)})`;
      case 'IndexSet':
        return `${cTypeName(e.recvType)}_set(${this.expr(e.obj)}, ${this.expr(e.index)}, ${this.expr(e.value)})`;
      case 'Call': return `${e.func}(${e.args.map((a) => this.expr(a)).join(', ')})`;
      case 'Builtin': return this.builtin(e);
      default: throw new Error(`c.expr: ${e.kind}`);
    }
  }

  /** 容器字面量用复合字面量传数组，避免为了构造值而引入语句表达式 */
  listLit(e) {
    const n = cTypeName(e.type);
    if (!e.items.length) return `${n}_from(NULL, 0)`;
    const items = e.items.map((x) => this.expr(x)).join(', ');
    return `${n}_from((${cTypeName(e.type.elem)}[]){${items}}, ${e.items.length})`;
  }

  dictLit(e) {
    const n = cTypeName(e.type);
    if (!e.entries.length) return `${n}_from(NULL, NULL, 0)`;
    const ks = e.entries.map((en) => this.expr(en.key)).join(', ');
    const vs = e.entries.map((en) => this.expr(en.value)).join(', ');
    return `${n}_from((${cTypeName(e.type.key)}[]){${ks}}, (${cTypeName(e.type.val)}[]){${vs}}, ${e.entries.length})`;
  }

  setLit(e) {
    const n = cTypeName(e.type);
    if (!e.items.length) return `${n}_from(NULL, 0)`;
    const items = e.items.map((x) => this.expr(x)).join(', ');
    return `${n}_from((${cTypeName(e.type.elem)}[]){${items}}, ${e.items.length})`;
  }

  constant(e) {
    switch (e.type.k) {
      case 'int': {
        const v = e.value;
        if (v === -(2n ** 63n)) return 'INT64_MIN';
        return `INT64_C(${v})`;
      }
      case 'real': return cReal(e.value);
      case 'bool': return e.value ? 'true' : 'false';
      case 'string': {
        const bytes = Buffer.from(e.value, 'utf8');
        return `omni_str_new(${cString(bytes)}, ${bytes.length})`;
      }
      default: throw new Error(`c.const: ${e.type.k}`);
    }
  }

  bin(e) {
    const a = this.expr(e.left);
    const b = this.expr(e.right);
    if (e.opType.k === 'int') {
      switch (e.op) {
        case '+': return `omni_add(${a}, ${b})`;
        case '-': return `omni_sub(${a}, ${b})`;
        case '*': return `omni_mul(${a}, ${b})`;
        case '/': return `omni_div(${a}, ${b})`;
        case '%': return `omni_mod(${a}, ${b})`;
        case '<<': return `omni_shl(${a}, ${b})`;
        case '>>': return `omni_shr(${a}, ${b})`;
        case '&': case '|': case '^': return `(${a} ${e.op} ${b})`;
        default: throw new Error(`c.bin int: ${e.op}`);
      }
    }
    if (e.opType.k === 'real') {
      if (e.op === '%') return `fmod(${a}, ${b})`;
      return `(${a} ${e.op} ${b})`;
    }
    if (e.opType.k === 'string' && e.op === '+') return `omni_str_cat(${a}, ${b})`;
    throw new Error(`c.bin: ${e.op} on ${e.opType.k}`);
  }

  builtin(e) {
    const a = e.args.map((x) => this.expr(x));
    const recv = e.recvType;
    switch (e.name) {
      case 'print': return `omni_print_${e.argType.k}(${a[0]})`;
      case 'to_string': return `omni_str_${e.argType.k}(${a[0]})`;
      case 'trunc': return `omni_trunc(${a[0]})`;
      case 'chr': return `omni_chr(${a[0]})`;
      case 'fail': return `omni_fail(${a[0]})`;
      case 'repr': return `omni_repr_real(${a[0]})`;
      case 'int_of_string': return `omni_int_of_string(${a[0]})`;
      case 'real_of_string': return `omni_real_of_string(${a[0]})`;
      case 'len':
        return recv.k === 'string' ? `omni_str_len(${a[0]})` : `${cTypeName(recv)}_len(${a[0]})`;
      case 'push': case 'add': case 'pop': case 'clear':
      case 'contains': case 'remove': case 'keys': case 'items':
        return `${cTypeName(recv)}_${e.name}(${a.join(', ')})`;
      case 'dictGet': return `${cTypeName(recv)}_get(${a.join(', ')})`;
      case 'dictSet': return `${cTypeName(recv)}_set(${a.join(', ')})`;
      case 'byteAt': return `omni_byte_at(${a[0]}, ${a[1]})`;
      case 'substr': return `omni_substr(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'indexOf': return `omni_index_of(${a[0]}, ${a[1]})`;
      // list<string>.join：直接把条目数组交给运行时，一次算总长一次分配
      case 'join': return `omni_str_join(${a[0]}->items, ${a[0]}->len, ${a[1]})`;
      case 'tag': return `omni_dyn_tag(${a[0]})`;
      case 'asInt': return `omni_dyn_as_int(${a[0]})`;
      case 'asReal': return `omni_dyn_as_real(${a[0]})`;
      case 'asBool': return `omni_dyn_as_bool(${a[0]})`;
      case 'asString': return `omni_dyn_as_string(${a[0]})`;
      case 'asList': return `(${cTypeName(e.type)})omni_dyn_as_ref(${a[0]}, OMNI_DYN_LIST)`;
      case 'asDict': return `(${cTypeName(e.type)})omni_dyn_as_ref(${a[0]}, OMNI_DYN_DICT)`;
      case 'dynGet': return `omni_dyn_get(${a[0]}, ${a[1]})`;
      case 'dynSet': return `omni_dyn_set_at(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'dynLen': return `omni_dyn_len(${a[0]})`;
      case 'dynIter': return `omni_dyn_iter(${a[0]})`;
      case 'dynPush': return `omni_dyn_push(${a[0]}, ${a[1]})`;
      case 'dynHas': return `omni_dyn_has(${a[0]}, ${a[1]})`;
      case 'dynKeys': return `omni_dyn_keys_of(${a[0]})`;
      // JS 前端的运算语义（ADR-0011）。规则写在 runtime/omni_js.c 里，与 prelude.js 一一对应。
      case 'js_undef': return 'omni_dyn_undef()';
      case 'js_ofFn': return `omni_dyn_of_fn(${a[0]})`;
      default: {
        const abi = JS_ABI[e.name];
        if (!abi) throw new Error(`c.builtin: ${e.name}`);
        const lits = (abi.lit ?? []).map((k) => {
          const v = e[k];
          return typeof v === 'string' ? `'${v}'` : String(v === true);
        });
        return `${abi.c}(${[...lits, ...a].join(', ')})`;
      }
    }
  }
}

function cReal(v) {
  if (Number.isNaN(v)) return '(0.0/0.0)';
  if (v === Infinity) return '(1.0/0.0)';
  if (v === -Infinity) return '(-1.0/0.0)';
  // 17 位有效数字保证 double 往返无损
  const s = v.toPrecision(17);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
}

function cString(bytes) {
  let s = '"';
  for (const b of bytes) {
    if (b === 0x22) s += '\\"';
    else if (b === 0x5c) s += '\\\\';
    else if (b === 0x0a) s += '\\n';
    else if (b === 0x0d) s += '\\r';
    else if (b === 0x09) s += '\\t';
    else if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
    else s += `\\${b.toString(8).padStart(3, '0')}`;
  }
  return `${s}"`;
}

/** @param {any} mod OIR 模块 */
/** @param {any} mod OIR 模块 @param {{amalgamate?: boolean}} opts */
export function emitC(mod, opts = {}) {
  return new CEmitter(mod, opts).emit();
}
