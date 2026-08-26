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
import { JS_ABI, JS_ALL, JS_MEMBERS, JS_TAG_C } from '../hir/js_abi.js';

/** dict/set 的键需要 hash；list.contains 只需要 eq */
const HASH_FN = { int: 'omni_hash_int', real: 'omni_hash_real', bool: 'omni_hash_bool', string: 'omni_hash_string' };
const EQ_FN = {
  int: 'omni_eq_int', real: 'omni_eq_real', bool: 'omni_eq_bool', string: 'omni_eq_string',
  dynamic: 'omni_eq_dyn', class: 'omni_eq_ref',
};
const KSTR_FN = { int: 'omni_kstr_int', real: 'omni_kstr_real', bool: 'omni_kstr_bool', string: 'omni_kstr_string' };
const DYN_TAG = { list: 'OMNI_DYN_LIST', dict: 'OMNI_DYN_DICT' };
// int64 的下界。写成"减一"而不是 -9223372036854775808n：那个正的字面量本身超出 int64，
// 自举的时候（编译器自己被降级成 int64 的世界）读它就会报 invalid integer。
const INT64_MIN_VALUE = -9223372036854775807n - 1n;

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
    const aggs = this.sortAggregates();
    const enums = this.mod.enums ?? [];
    const classes = this.mod.classes ?? [];
    const containers = this.mod.containers ?? [];
    const closures = this.mod.closures ?? [];
    const fnTypes = this.mod.fnTypes ?? [];

    this.out.push(this.opts.amalgamate ? amalgamate().trim() : RUNTIME_INCLUDE);
    this.line();
    for (const t of containers) this.line(`OMNI_REF_DECL(${cTypeName(t)})`);
    for (const c of classes) this.line(`OMNI_REF_DECL(c_${c.name})`);
    this.line();
    for (const a of aggs) {
      if (a.k === 'struct') this.structBody(a.t);
      else this.enumBody(a.t);
    }
    for (const c of classes) this.classBody(c);
    for (const t of containers) this.containerBody(t);
    this.line();
    for (const t of containers) this.containerDefine(t);
    this.dynBridge(containers);
    // 深装箱助手（print(list<int>) 之类，ADR-0008）：先全部前置声明，再出函数体 ——
    // 嵌套容器的内外顺序不用管，交给前置声明
    const boxDeeps = this.mod.boxDeeps ?? [];
    for (const t of boxDeeps) this.line(`static omni_dyn omni_box_${cTypeName(t)}(${cTypeName(t)} a);`);
    for (const t of boxDeeps) this.boxDeepFn(t);
    this.line();
    for (const c of closures) this.closureBody(c);
    for (const t of fnTypes) this.fnCallHelper(t);
    this.line();
    // 零值构造按拓扑序发：enum 的零值要调它第一个变体载荷的零值构造，struct 反过来也一样
    for (const a of aggs) {
      if (a.k === 'struct') this.structNew(a.t);
      else this.enumNew(a.t);
    }
    for (const e of enums) this.enumMakers(e);
    for (const c of classes) this.classNew(c);
    // JS 前端的模块级变量（ADR-0011）：顶层函数要能互相看见，所以是真全局，
    // 不是 omni_main 的局部量。初值一律 undefined，赋值发生在 omni_main 里。
    for (const g of this.mod.jsGlobals ?? []) this.line(`static omni_dyn g_${g.name} = { .tag = OMNI_DYN_UNDEF };`);
    for (const f of this.mod.funcs) this.line(`${this.proto(f)};`);
    this.line();
    for (const c of closures) this.closureMake(c);
    for (const f of this.mod.funcs) this.func(f);
    // argc/argv 要存下来：process.argv 与"我装在哪"（import.meta.url 的对应物）都要它。
    // 退出码走 omni_host_exit_code —— process.exitCode 是个可写的槽，不是返回值。
    this.line(`int main(int argc, char **argv) { omni_host_init(argc, argv); ${this.mod.entry}(); omni_js_check_uncaught(); fflush(stdout); return omni_host_exit_code(); }`);
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

  /**
   * struct 与 enum 一起按"按值嵌套"拓扑排序：C 里按值嵌套要求被嵌套者已是完整类型，
   * 而 struct 的字段可以是 enum、enum 的载荷也可以是 struct，两者必须排在同一张序里。
   * 返回 `{k, t}` 的有序表。环在检查器里已经报过诊断（ADR-0012），这里只留一个断言。
   */
  sortAggregates() {
    const structs = new Map(this.mod.structs.map((s) => [s.name, s]));
    const enums = new Map((this.mod.enums ?? []).map((e) => [e.name, e]));
    const done = new Set();
    const order = [];
    const visit = (t, stack) => {
      if (!t || (t.k !== 'struct' && t.k !== 'enum')) return;
      const key = `${t.k}:${t.name}`;
      if (done.has(key)) return;
      if (stack.has(key)) throw new Error(`recursive aggregate by value: ${t.name}`);
      stack.add(key);
      const inner = [];
      if (t.k === 'struct') {
        for (const f of t.fields) inner.push(f.type);
      } else {
        for (const v of t.variants) for (const f of v.fields) inner.push(f.type);
      }
      for (const it of inner) {
        const dep = it.k === 'struct' ? structs.get(it.name) : it.k === 'enum' ? enums.get(it.name) : null;
        visit(dep, stack);
      }
      stack.delete(key);
      done.add(key);
      order.push({ k: t.k, t });
    };
    for (const s of this.mod.structs) visit(s, new Set());
    for (const e of enums.values()) visit(e, new Set());
    return order;
  }

  /**
   * tagged union（ADR-0012）：`int64_t tag` + 一个 union。tag 用 int64_t 而不是 int，
   * 因为 `EnumTag` 在 OIR 里的类型是 `int`（= i64），这样比较不需要任何转换。
   * 无载荷的变体不进 union —— C99 没有空结构体；全都无载荷时连 union 都不发。
   */
  enumBody(e) {
    const withPayload = e.variants.filter((v) => v.fields.length > 0);
    this.line(`struct e_${e.name}_s {`);
    this.indent++;
    this.line('int64_t tag;');
    if (withPayload.length) {
      this.line('union {');
      this.indent++;
      for (const v of withPayload) {
        const fs = v.fields.map((f) => `${cTypeName(f.type)} f_${f.name};`).join(' ');
        this.line(`struct { ${fs} } v_${v.name};`);
      }
      this.indent--;
      this.line('} u;');
    }
    this.indent--;
    this.line('};');
    this.line(`typedef struct e_${e.name}_s e_${e.name};`);
  }

  /** 零值 = 第一个变体 + 各载荷字段的零值（与 JS 后端的 $new_E 对齐） */
  enumNew(e) {
    this.line(`static e_${e.name} omni_new_E_${e.name}(void) {`);
    this.indent++;
    this.line(`e_${e.name} v;`);
    this.line('v.tag = INT64_C(0);');
    for (const f of e.variants[0].fields) {
      this.line(`v.u.v_${e.variants[0].name}.f_${f.name} = ${this.zeroExpr(f.type)};`);
    }
    this.line('return v;');
    this.indent--;
    this.line('}');
  }

  /**
   * 每个变体一个构造函数。不用 C99 的复合字面量 + 指定初始化：那样在
   * `-Wextra` 下会为"union 里没被初始化的成员"报一片 missing-field-initializers。
   */
  enumMakers(e) {
    for (const [i, v] of e.variants.entries()) {
      const ps = v.fields.map((f) => `${cTypeName(f.type)} f_${f.name}`);
      this.line(`static e_${e.name} omni_mk_E_${e.name}_${v.name}(${ps.length ? ps.join(', ') : 'void'}) {`);
      this.indent++;
      this.line(`e_${e.name} v;`);
      this.line(`v.tag = INT64_C(${i});`);
      for (const f of v.fields) this.line(`v.u.v_${v.name}.f_${f.name} = f_${f.name};`);
      this.line('return v;');
      this.indent--;
      this.line('}');
    }
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
   * 深装箱（ADR-0008）：把一个静态容器按元素转成 dynamic。C 侧的容器是单态的，
   * `list<int>` 与 `list<dynamic>` 是两个类型，所以转换函数只能**按类型生成**。
   * JS 侧不需要这一步（那边 dynamic 是无标签的，boxDeep 就是恒等）。
   */
  boxDeepFn(t) {
    const n = cTypeName(t);
    this.line(`static omni_dyn omni_box_${n}(${n} a) {`);
    if (t.k === 'list') {
      this.line('  omni_list_dynamic out = omni_list_dynamic_new();');
      this.line('  omni_list_dynamic_reserve(out, a->len);');
      this.line(`  for (int64_t i = 0; i < a->len; i++) out->items[out->len++] = ${this.boxElem(t.elem, 'a->items[i]')};`);
      this.line('  return omni_dyn_of_ref((void *)out, OMNI_DYN_LIST);');
    } else {
      this.line('  omni_dict_string_dynamic out = omni_dict_string_dynamic_new();');
      this.line(`  ${cTypeName(listType(t.key))} ks = ${n}_keys(a);`);
      this.line('  for (int64_t i = 0; i < ks->len; i++) {');
      this.line(`    omni_dict_string_dynamic_set(out, ks->items[i], ${this.boxElem(t.val, `${n}_get(a, ks->items[i])`)});`);
      this.line('  }');
      this.line('  return omni_dyn_of_ref((void *)out, OMNI_DYN_DICT);');
    }
    this.line('}');
  }

  boxElem(t, expr) {
    switch (t.k) {
      case 'int': return `omni_dyn_of_int(${expr})`;
      case 'real': return `omni_dyn_of_real(${expr})`;
      case 'bool': return `omni_dyn_of_bool(${expr})`;
      case 'string': return `omni_dyn_of_string(${expr})`;
      case 'dynamic': return expr;
      default: return `omni_box_${cTypeName(t)}(${expr})`;
    }
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
      this.line('OMNI_JS_JSON(omni_list_dynamic, omni_dict_string_dynamic)');
      // RE 也在 ARR 之后：回调走 ARR 里的 omni_js_call，match/split 的结果是 list<dynamic>
      this.line('OMNI_JS_RE(omni_list_dynamic, omni_dict_string_dynamic)');
      this.line('OMNI_JS_STR_ARR(omni_list_dynamic, omni_dict_string_dynamic)');
      this.line('OMNI_JS_HOST(omni_list_dynamic, omni_dict_string_dynamic)');
      // 成员派发器：调的全是上面这些宏摊出来的 static 函数，所以只能在这之后生成
      this.memberDispatch();
      this.callOpDispatch();
    }
  }

  /**
   * 按名字调 op 的分派器（`js_call_op`，ADR-0013）。JS 后端 backend-js/emit.js 的
   * callOpDispatch 是逐行的孪生。解释器是唯一的用户 —— 它手里的 op 名字是运行期的值。
   *
   * 名字先一次转码成 UTF-8，再按**长度**分组 memcmp：138 条 op 顺着比一遍太贵，
   * 按长度分完每组只剩几条。lit 排在 args 前面由调用方铺平，这里按类型取出来：
   * 字符串 lit 是单个字符（`'<'`），bool lit 走 truthy。
   */
  callOpDispatch() {
    const A = (i) => `omni_js_arr_get(args, omni_dyn_of_real(${i}.0))`;
    this.line('static omni_str omni_js_op_name_(omni_dyn v) {');
    this.indent++;
    this.line('if (v.tag == OMNI_DYN_STR16) return omni_s16_to_utf8(v.u.s16);');
    this.line('if (v.tag == OMNI_DYN_STRING) return v.u.s;');
    this.line('omni_error("op name must be a string");');
    this.line('return omni_str_new("", 0);');
    this.indent--;
    this.line('}');
    this.line('static omni_dyn omni_js_call_op(omni_dyn name, omni_dyn args) {');
    this.indent++;
    this.line('omni_str nm_ = omni_js_op_name_(name);');
    this.line('switch (nm_.len) {');
    this.indent++;
    const byLen = new Map();
    for (const [name, abi] of Object.entries(JS_ABI)) {
      if (name === 'js_call_op' || abi.raw === true) continue;  // 不自递归；raw 的签名不统一
      if (!byLen.has(name.length)) byLen.set(name.length, []);
      byLen.get(name.length).push([name, abi]);
    }
    for (const len of [...byLen.keys()].sort((a, b) => a - b)) {
      this.line(`case ${len}:`);
      this.indent++;
      for (const [name, abi] of byLen.get(len)) {
        const lits = (abi.lit ?? []).map((k, i) => (k === 'strict'
          ? `omni_js_truthy(${A(i)})`
          : `omni_js_op_name_(${A(i)}).p[0]`));
        const as = [];
        for (let ai = 0; ai < abi.arity; ai++) {
          const x = A(ai + lits.length);
          // raw: 'str' 的 C 形参是 omni_str（js_s16 是唯一一条）—— 取出字符串再传
          as.push(abi.raw === 'str' && ai === 0 ? `omni_js_op_name_(${x})` : x);
        }
        const call = `${abi.c}(${[...lits, ...as].join(', ')})`;
        const ret = abi.ret === 'void' ? `${call}; return omni_dyn_undef();`
          : abi.ret === 'bool' ? `return omni_dyn_of_bool(${call});`
            : `return ${call};`;
        this.line(`if (memcmp(nm_.p, ${JSON.stringify(name)}, ${len}) == 0) { ${ret} }`);
      }
      this.line('break;');
      this.indent--;
    }
    this.indent--;
    this.line('}');
    this.line('omni_errorf("no such op: %.*s", (int)nm_.len, nm_.p);');
    this.line('return omni_dyn_undef();');
    this.indent--;
    this.line('}');
  }

  /**
   * 成员派发器（ADR-0011 第 9 节）。表在 hir/js_abi.js，这里只按表生成 —— 发射器里
   * 不出现任何成员名。JS 后端 backend-js/emit.js 的 memberDispatch 是逐行的孪生。
   */
  memberDispatch() {
    for (const d of Object.values(JS_MEMBERS)) {
      const m = d.member;
      const ps = ['r'];
      for (let i = 0; i < m.argc; i++) ps.push(`a${i}`);
      const lits = Object.values(m.lit ?? {}).map((v) => (typeof v === 'string' ? `'${v}'` : String(v)));
      const ret = d.ret === 'bool' ? 'bool' : 'omni_dyn';
      this.line(`static ${ret} ${d.c}(${ps.map((p) => `omni_dyn ${p}`).join(', ')}) {`);
      this.indent++;
      this.line('switch (r.tag) {');
      this.indent++;
      for (const [tag, op] of Object.entries(m.on)) {
        const abi = JS_ABI[op];
        // arity 只数 dynamic 实参（含接收者），lit 是额外排在前面的编译期常量
        const call = `${abi.c}(${[...lits, ...ps.slice(0, abi.arity)].join(', ')})`;
        this.line(abi.ret === 'void'
          ? `case ${JS_TAG_C[tag]}: ${call}; return omni_dyn_undef();`
          : `case ${JS_TAG_C[tag]}: return ${call};`);
      }
      // 表外的接收者：属性就是普通属性，方法就是"取属性再当函数调"（ADR-0011 决策 12）
      const get = `omni_js_obj_get(r, omni_dyn_of_s16(omni_js_s16_lit(${JSON.stringify(m.name)})))`;
      if (m.kind === 'prop') {
        this.line(`default: return ${get};`);
      } else {
        const argv = m.argc ? `${m.argc}, a_` : '0, NULL';
        const call = `omni_js_call_n(${get}, ${argv})`;
        const ret = d.ret === 'bool' ? `omni_js_truthy(${call})` : call;
        this.line(m.argc
          ? `default: { const omni_dyn a_[] = { ${ps.slice(1).join(', ')} }; return ${ret}; }`
          : `default: return ${ret};`);
      }
      this.indent--;
      this.line('}');
      this.line(d.ret === 'bool' ? 'return false;' : 'return omni_dyn_undef();');
      this.indent--;
      this.line('}');
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
      case 'enum': return `omni_new_E_${t.name}()`;
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
      case 'ZeroEnum': return `omni_new_E_${e.type.name}()`;
      case 'MakeEnum':
        return `omni_mk_E_${e.type.name}_${e.variant}(${e.args.map((x) => this.expr(x)).join(', ')})`;
      case 'EnumTag': return `(${this.expr(e.object)}).tag`;
      case 'EnumPayload': return `(${this.expr(e.object)}).u.v_${e.variant}.f_${e.name}`;
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
      // JS 前端的模块级变量（ADR-0011）：一个真全局，可读可写
      case 'JsGlobal': return `g_${e.name}`;
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
        if (v === INT64_MIN_VALUE) return 'INT64_MIN';
        return `INT64_C(${v})`;
      }
      case 'real': return cReal(e.value);
      case 'bool': return e.value ? 'true' : 'false';
      case 'string': {
        const bytes = utf8Bytes(e.value);
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
      case 'boxDeep': return `omni_box_${cTypeName(e.argType)}(${a[0]})`;
      case 'dynAdd': return `omni_dyn_arith('+', ${a[0]}, ${a[1]})`;
      case 'dynSub': return `omni_dyn_arith('-', ${a[0]}, ${a[1]})`;
      case 'dynMul': return `omni_dyn_arith('*', ${a[0]}, ${a[1]})`;
      case 'dynDiv': return `omni_dyn_arith('/', ${a[0]}, ${a[1]})`;
      case 'dynMod': return `omni_dyn_arith('%', ${a[0]}, ${a[1]})`;
      case 'dynNeg': return `omni_dyn_neg(${a[0]})`;
      // JS 前端的运算语义（ADR-0011）。规则写在 runtime/omni_js.c 里，与 prelude.js 一一对应。
      case 'js_undef': return 'omni_dyn_undef()';
      case 'js_ofFn': return `omni_dyn_of_fn(${a[0]})`;
      // 字符串字面量平时经 UTF-8 进来，但落单的代理项在 UTF-8 里没有合法编码
      // （Buffer.from 会替成 U+FFFD），这一种只能按码元发。JS 侧不需要对应处理：
      // JSON.stringify 自己就会把落单代理项转义成 \uXXXX，那边天然无损。
      case 'js_s16': {
        const arg = e.args[0];
        if (arg && arg.kind === 'Const' && typeof arg.value === 'string' && hasLoneSurrogate(arg.value)) {
          const units = [];
          for (let i = 0; i < arg.value.length; i++) units.push(`0x${arg.value.charCodeAt(i).toString(16)}`);
          return `omni_dyn_of_s16(omni_s16_of_units((const uint16_t[]){${units.join(', ')}}, ${units.length}))`;
        }
        return `omni_js_s16(${a[0]})`;
      }
      default: {
        const abi = JS_ALL[e.name];
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

function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) { i++; continue; }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

/**
 * 字符串的 UTF-8 字节。不用 Buffer / TextEncoder：那是宿主的东西，而这个文件自己也要
 * 被降级（封闭 ABI，ADR-0011 决策 2）。全程只用加法、乘法、取模 —— 位运算在这个值域
 * 里只对 int 成立，而这里的一切都是 real。
 * 落单的代理项按 node 的 Buffer 一样换成 U+FFFD，否则两代生成的 C 会不一样。
 */
function utf8Bytes(s) {
  const out = [];
  const push3 = (c) => {
    out.push(224 + Math.floor(c / 4096));
    out.push(128 + (Math.floor(c / 64) % 64));
    out.push(128 + (c % 64));
  };
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) { push3(0xfffd); continue; }   // 落单的低位代理项
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d < 0xdc00 || d > 0xdfff) { push3(0xfffd); continue; }   // 落单的高位代理项
      c = 0x10000 + (c - 0xd800) * 1024 + (d - 0xdc00);
      i++;
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(192 + Math.floor(c / 64)); out.push(128 + (c % 64)); }
    else if (c < 0x10000) push3(c);
    else {
      out.push(240 + Math.floor(c / 262144));
      out.push(128 + (Math.floor(c / 4096) % 64));
      out.push(128 + (Math.floor(c / 64) % 64));
      out.push(128 + (c % 64));
    }
  }
  return out;
}

function cString(bytes) {
  let s = '"';
  for (const b of bytes) {
    if (b === 0x22) s += '\\"';
    else if (b === 0x5c) s += '\\\\';
    else if (b === 0x0a) s += '\\n';
    else if (b === 0x0d) s += '\\r';
    else if (b === 0x09) s += '\\t';
    // 问号一律转义：C99 里 ??= ??( ??/ ... 是三字符组，编译器会在**看字符串之前**替换掉
    // （clang 只给个 warning 就换了），于是 '??=' 这个字面量在产出里变成 '#'，长度还对不上。
    // 词法器的标点表里就有它，所以自举出来的编译器认不出 ??= —— 是这么发现的。
    else if (b === 0x3f) s += '\\?';
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
