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
import { C_ABI, C_TYPE, C_IN, C_OUT } from '../hir/c_abi.js';
import { utf8Bytes } from '../host/utf8.js';

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

/** 向量上第一阶段只有这四条（ADR-0014 决策 6）：算符 -> C 侧助手名的后缀 */
const C_VEC_OPS = [['+', 'add'], ['-', 'sub'], ['*', 'mul'], ['/', 'div']];

class CEmitter {
  constructor(mod, opts = {}) {
    this.mod = mod;
    this.out = [];
    this.indent = 0;
    this.tmp = 0;
    this.opts = opts;
    // JS 字符串字面量池（见 s16Lit）。Map 保证发射顺序稳定 —— 自举要逐字节可复现。
    this.s16pool = new Map();
    this.s16At = -1;
    // 用到的向量形状（typeKey -> 类型）。和字面量池同一套路：边发射边收，最后回填。
    // 为什么不在 mod 里像 containers 那样先算好：向量没有实例化那一层（没有方法、
    // 没有装箱桥），一个形状要发的就是几个 static inline，边遇边记最省事。
    this.vecs = new Map();
    this.vecAt = -1;
    // 用到的缓冲形状（门槛 7 第一阶段）。和向量共用那个回填位：两者都是"按 (元素) 生成
    // 一小段定义"，分两个位置只会多一处要对齐的顺序。
    this.bufs = new Map();
  }

  line(s = '') {
    this.out.push(s ? '  '.repeat(this.indent) + s : '');
  }

  /**
   * JS 的字符串字面量：静态 UTF-16 数据，取用时零成本。
   *
   * 以前是 `omni_js_s16(omni_str_new("kind", 4))`，每求值一次就 UTF-8 -> UTF-16 转一遍、
   * 在 arena 里分配一块（omni_js_s16_lit 更狠，还过一次 omni_str_fmt 也就是 printf）。
   * 解释器把 OIR 节点当 dict 读，`e.kind` 这种取字段全是字符串字面量，于是这条成了
   * 原生构建上最热的分配点：量过，原生解释器 90% 的时间在 obj_get/memcmp/of_utf8 上，
   * 500MB 常驻里绝大部分是这些一次性的键。字面量是编译期已知的，转换也就该在编译期做完。
   */
  s16Lit(s) {
    let id = this.s16pool.get(s);
    if (id === undefined) {
      id = `k_s16_${this.s16pool.size}`;
      this.s16pool.set(s, id);
    }
    return id;
  }

  /** 用到一个向量形状就记下来，最后在 vecAt 那个位置把它的定义回填进去 */
  noteVec(t) {
    if (t !== undefined && t !== null && t.k === 'vec' && !this.vecs.has(typeKey(t))) {
      this.vecs.set(typeKey(t), t);
    }
    if (t !== undefined && t !== null && t.k === 'buf' && !this.bufs.has(typeKey(t))) {
      this.bufs.set(typeKey(t), t);
    }
    return t;
  }

  /**
   * 每个用到的缓冲形状：`{长度, 指针}` 按值传，加上 new / get / set 三个 static inline。
   *
   * 长度跟着值走（不是"调用方另记一个 n"）：`blen` 在六条腿上都要 O(1) 答得出来，
   * 而这个形状和 GPU 上 StorageBuffer 里的 runtime array + 一个长度 uniform 是对应的。
   * 越界的消息与 list 那句逐字对齐（omni_container.h:50）—— 那句已经在三份实现里
   * 对过一次，照抄比再对一次便宜。
   */
  bufLines() {
    const out = [];
    for (const t of this.bufs.values()) {
      const n = cTypeName(t);
      const el = cTypeName(t.elem);
      const zero = t.elem.k === 'int' ? 'INT64_C(0)' : '0.0';
      const oob = `omni_errorf("buffer index out of range: %lld (length %lld)", (long long)i, (long long)b.n)`;
      out.push(`typedef struct { int64_t n; ${el} *p; } ${n};`);
      out.push(`static inline ${n} ${n}_new(int64_t n) {`);
      out.push(`  if (n < 0) omni_errorf("buffer length cannot be negative: %lld", (long long)n);`);
      out.push(`  ${n} b; b.n = n; b.p = n == 0 ? NULL : (${el} *)omni_alloc((size_t)n * sizeof(${el}));`);
      out.push(`  for (int64_t i = 0; i < n; i++) b.p[i] = ${zero};`);
      out.push('  return b;');
      out.push('}');
      out.push(`static inline ${el} ${n}_get(${n} b, int64_t i) { if (i < 0 || i >= b.n) ${oob}; return b.p[i]; }`);
      out.push(`static inline ${el} ${n}_set(${n} b, int64_t i, ${el} v) { if (i < 0 || i >= b.n) ${oob}; b.p[i] = v; return v; }`);
    }
    return out;
  }

  /**
   * 每个用到的向量形状在 C 侧的定义：一个按值传的定长数组结构体，加几个 static inline。
   *
   * C 备选路径上向量是**标量化**的（ADR-0014 决策 6 唯一许可的合法化）。刻意不用
   * `__attribute__((vector_size(...)))`：那等于把「与 LLVM 那条腿逐位相同」的责任交给
   * clang 的自动向量化，而它不承诺求值顺序 —— 门槛 6 要的恰恰是求值顺序。
   *
   * 每一道上的运算由 binCode 拼出来，和标量表达式是**同一份发射代码**：
   * int 的回绕、除零的消息文本因此不可能在"向量道"和"标量"之间分叉。
   */
  vecLines() {
    if (this.vecs.size === 0) return [''];
    const out = ['/* 定长向量（ADR-0014 决策 6）：结构体按值传 + 逐道标量化 */'];
    for (const t of this.vecs.values()) {
      const n = cTypeName(t);
      const el = cTypeName(t.elem);
      const w = t.lanes;
      out.push(`typedef struct { ${el} l[${w}]; } ${n};`);
      out.push(`static inline ${n} ${n}_splat(${el} x) { ${n} r; for (int i = 0; i < ${w}; i++) r.l[i] = x; return r; }`);
      // 取道走函数而不是就地 `.l[i]`：`f(x).l[2]` 是在非左值结构体的数组成员上取下标，
      // C99 里那是没定义的（形参是左值，所以搬进函数就没这个问题）
      out.push(`static inline ${el} ${n}_lane(${n} v, int i) { return v.l[i]; }`);
      for (const op of C_VEC_OPS) {
        const lane = this.binCode(op[0], t.elem, 'a.l[i]', 'b.l[i]');
        out.push(`static inline ${n} ${n}_${op[1]}(${n} a, ${n} b) { ${n} r; for (int i = 0; i < ${w}; i++) r.l[i] = ${lane}; return r; }`);
      }
      // 严格左到右：((v0+v1)+v2)+v3。浮点加法不结合，所以这个顺序就是规格（门槛 6）
      const step = this.binCode('+', t.elem, 'acc', 'v.l[i]');
      out.push(`static inline ${el} ${n}_hsum(${n} v) { ${el} acc = v.l[0]; for (int i = 1; i < ${w}; i++) acc = ${step}; return acc; }`);
    }
    return out;
  }

  /**
   * 用到的外部 C 符号的 extern 原型（ADR-0014 决策 4）。
   * 不 `#include <stdlib.h>` 之类：那会把别人的整套声明拖进来，而我们只想要这几条，
   * 且原型必须与 `C_ABI` 里写的**逐字一致** —— 声明就在这里，对不对一眼看得见。
   * libc 的那几条在 omni.h 已经 include 的头里也有声明，重复声明同一个原型是合法的。
   */
  cAbiExterns() {
    const used = this.mod.cabi ?? [];
    if (used.length === 0) return [];
    const out = ['/* 外部 C 符号（src/hir/c_abi.js） */'];
    for (const name of used) {
      const sig = C_ABI[name];
      if (sig.std) continue;   // 标准头已经声明过，见 c_abi.js 里 std 的说明
      const ps = sig.params.length > 0 ? sig.params.map((p) => C_TYPE[p]).join(', ') : 'void';
      out.push(`extern ${C_TYPE[sig.ret]} ${sig.sym}(${ps});`);
    }
    return out.length > 1 ? out : [];
  }

  s16PoolLines() {
    const out = [];
    for (const [s, id] of this.s16pool) {
      const units = [];
      for (let i = 0; i < s.length; i++) units.push(`0x${s.charCodeAt(i).toString(16)}`);
      // 空串也得有个合法的数组：C 里 {} 不是有效的初始化式
      out.push(`static const uint16_t ${id}_u[] = { ${units.length > 0 ? units.join(', ') : '0'} };`);
      out.push(`static const omni_s16 ${id} = { ${id}_u, ${s.length} };`);
      // UTF-8 的孪生体：对象的键在字典里就是 UTF-8，取属性走 ${id}_s 直接免掉一次转换和分配
      const bytes = utf8Bytes(s);
      out.push(`static const char ${id}_b[] = ${cString(bytes)};`);
      out.push(`static const omni_str ${id}_s = { ${id}_b, ${bytes.length} };`);
    }
    return out;
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
    // 字符串字面量池的落点：只需要 omni.h 里的 omni_s16，所以放在最前面（内容最后回填）
    this.s16At = this.out.length;
    this.line();
    for (const line of this.cAbiExterns()) this.line(line);
    // 向量的定义位（内容最后回填）：放在聚合体之前，将来 struct 里能按值嵌套向量
    this.vecAt = this.out.length;
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
    this.out[this.s16At] = this.s16PoolLines().join('\n');
    this.out[this.vecAt] = this.vecLines().concat(this.bufLines()).join('\n');
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
   * 比较**在 UTF-16 上直接做**，比的是字面量池里的静态数据：转码成 UTF-8 再 memcmp
   * 要在每次 op 调用上分配一块并走一遍转换，量过是原生解释器最热的分配点之一。
   * 先按长度分组（138 条顺着比一遍太贵，分完每组只剩几条），组内逐条 s16 相等。
   * lit 排在 args 前面由调用方铺平，这里按类型取出来：字符串 lit 是单个码元（`'<'`），
   * bool lit 走 truthy。
   */
  callOpDispatch() {
    const A = (i) => `omni_js_arr_get(args, omni_dyn_of_real(${i}.0))`;
    // op 名字（与 raw:'str' 那一条的实参）取 s16。STRING 标签也认：Omni 侧的 string
    // 传进来时是 UTF-8，那一路要转，但它不在热路径上。
    this.line('static omni_s16 omni_js_op_key_(omni_dyn v) {');
    this.indent++;
    this.line('if (v.tag == OMNI_DYN_STR16) return v.u.s16;');
    this.line('if (v.tag == OMNI_DYN_STRING) return omni_s16_of_utf8(v.u.s);');
    this.line('omni_error("op name must be a string");');
    this.line('return omni_s16_of_utf8(omni_str_new("", 0));');
    this.indent--;
    this.line('}');
    this.line('static omni_str omni_js_op_name_(omni_dyn v) {');
    this.indent++;
    this.line('return omni_s16_to_utf8(omni_js_op_key_(v));');
    this.indent--;
    this.line('}');
    this.line('static omni_dyn omni_js_call_op(omni_dyn name, omni_dyn args) {');
    this.indent++;
    this.line('omni_s16 nm_ = omni_js_op_key_(name);');
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
          : `(char)omni_js_op_key_(${A(i)}).p[0]`));
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
        this.line(`if (omni_s16_eq(nm_, ${this.s16Lit(name)})) { ${ret} }`);
      }
      this.line('break;');
      this.indent--;
    }
    this.indent--;
    this.line('}');
    this.line('omni_str bad_ = omni_s16_to_utf8(nm_);');
    this.line('omni_errorf("no such op: %.*s", (int)bad_.len, bad_.p);');
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
      const get = `omni_js_obj_getk(r, ${this.s16Lit(m.name)}_s)`;
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
    // 形参/返回值里的向量形状也要登记：一个只做"接进来再传出去"的函数体里
    // 可能一条向量运算都没有，但它的原型仍然要那个 typedef
    this.noteVec(f.ret);
    for (const p of f.params) this.noteVec(p.type);
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
        this.noteVec(s.type);
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
      // 向量四条（ADR-0014 门槛 6 第一阶段）。splat / lane / hsum 都走那个形状的助手：
      // 复合字面量里把标量重复 N 次会把子表达式求值 N 次，而 (lane E N) 的 E 可能有副作用。
      case 'VecSplat':
        this.noteVec(e.type);
        return `${cTypeName(e.type)}_splat(${this.expr(e.value)})`;
      case 'VecLit': {
        this.noteVec(e.type);
        const lanes = e.lanes.map((x) => this.expr(x)).join(', ');
        return `(${cTypeName(e.type)}){{${lanes}}}`;
      }
      case 'VecLane':
        this.noteVec(e.vec.type);
        return `${cTypeName(e.vec.type)}_lane(${this.expr(e.vec)}, ${e.lane})`;
      case 'VecHsum':
        this.noteVec(e.vec.type);
        return `${cTypeName(e.vec.type)}_hsum(${this.expr(e.vec)})`;
      // 缓冲四条（门槛 7 第一阶段）。结构体按值传，但里面的指针是共享的 —— 引用语义
      // 因此不需要任何拷贝助手：传一份 {n, p} 的副本，指向的还是同一段存储。
      case 'BufNew':
        this.noteVec(e.type);
        return `${cTypeName(e.type)}_new(${this.expr(e.count)})`;
      case 'BufLen':
        this.noteVec(e.buf.type);
        return `(${this.expr(e.buf)}).n`;
      case 'BufGet':
        this.noteVec(e.buf.type);
        return `${cTypeName(e.buf.type)}_get(${this.expr(e.buf)}, ${this.expr(e.index)})`;
      case 'BufSet':
        this.noteVec(e.buf.type);
        return `${cTypeName(e.buf.type)}_set(${this.expr(e.buf)}, ${this.expr(e.index)}, ${this.expr(e.value)})`;
      // 数组六条（门槛 2 第四刀）。这里不生成任何结构体或助手 —— 实现在运行时的
      // omni_arr.c 里已经按元素单态好了，`cTypeName` 给出的就是那四个 typedef 之一，
      // 函数名就是它加后缀。run-llvm 那条腿调的是同一个符号，所以两边不可能分叉。
      case 'ArrNew':
        return `${cTypeName(e.type)}_new(${this.expr(e.count)}, ${this.expr(e.zero)})`;
      case 'ArrLen':
        return `${cTypeName(e.arr.type)}_len(${this.expr(e.arr)})`;
      case 'ArrGet':
        return `${cTypeName(e.arr.type)}_get(${this.expr(e.arr)}, ${this.expr(e.index)})`;
      case 'ArrSet':
        return `${cTypeName(e.arr.type)}_set(${this.expr(e.arr)}, ${this.expr(e.index)}, ${this.expr(e.value)})`;
      case 'ArrPush':
        return `${cTypeName(e.arr.type)}_push(${this.expr(e.arr)}, ${this.expr(e.value)})`;
      case 'ArrPop':
        return `${cTypeName(e.arr.type)}_pop(${this.expr(e.arr)})`;
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
      // 外部 C 符号（ADR-0014 决策 4）：实参逐个 marshal，返回值再 marshal 回来。
      // void 的那些包成逗号表达式，让整条仍然是个 dynamic 表达式。
      case 'CCall': {
        const sig = C_ABI[e.entry];
        const args = e.args.map((a, i) => `${C_IN[sig.params[i]]}(${this.expr(a)})`);
        const call = `${sig.sym}(${args.join(', ')})`;
        if (sig.ret === 'void') return `(${call}, omni_dyn_undef())`;
        return `${C_OUT[sig.ret]}(${call})`;
      }
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
    // 向量：整条运算收进那个形状的助手里（逐道展开在助手体内，见 vecLines）
    if (e.opType.k === 'vec') {
      this.noteVec(e.opType);
      const suffix = C_VEC_OPS.find((x) => x[0] === e.op);
      if (suffix === undefined) throw new Error(`c.bin vec: ${e.op}`);
      return `${cTypeName(e.opType)}_${suffix[1]}(${a}, ${b})`;
    }
    return this.binCode(e.op, e.opType, a, b);
  }

  /** 二元运算的代码拼装。操作数已经是代码串：标量路径与向量的逐道路径共用它 */
  binCode(op, opType, a, b) {
    if (opType.k === 'int') {
      switch (op) {
        case '+': return `omni_add(${a}, ${b})`;
        case '-': return `omni_sub(${a}, ${b})`;
        case '*': return `omni_mul(${a}, ${b})`;
        case '/': return `omni_div(${a}, ${b})`;
        case '%': return `omni_mod(${a}, ${b})`;
        case '<<': return `omni_shl(${a}, ${b})`;
        case '>>': return `omni_shr(${a}, ${b})`;
        case '&': case '|': case '^': return `(${a} ${op} ${b})`;
        default: throw new Error(`c.bin int: ${op}`);
      }
    }
    if (opType.k === 'real') {
      if (op === '%') return `fmod(${a}, ${b})`;
      return `(${a} ${op} ${b})`;
    }
    if (opType.k === 'string' && op === '+') return `omni_str_cat(${a}, ${b})`;
    throw new Error(`c.bin: ${op} on ${opType.k}`);
  }

  builtin(e) {
    const a = e.args.map((x) => this.expr(x));
    const recv = e.recvType;
    switch (e.name) {
      case 'print': return `omni_print_${e.argType.k}(${a[0]})`;
      case 'to_string': return `omni_str_${e.argType.k}(${a[0]})`;
      case 'to_string_g': return `omni_str_realg(${a[0]}, ${a[1]})`;
      // real 上的数学函数：`rmath_sqrt` -> `omni_r_sqrt`（runtime/omni_math.c）。
      // 名单由核心方言把关（sexpr/lower.js 的 RMATH）。
      case 'rmath_sqrt': case 'rmath_fabs': case 'rmath_floor': case 'rmath_ceil':
      case 'rmath_round': case 'rmath_pow': case 'rmath_fmod':
        return `omni_r_${e.name.slice(6)}(${a.join(', ')})`;
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
      // 字符串字面量走字面量池（见 s16Lit）：编译期就是 UTF-16 静态数据，取用时零成本。
      // 落单的代理项在 UTF-8 里没有合法编码（Buffer.from 会替成 U+FFFD），按码元发这一条
      // 顺带也解决了 —— 池子存的本来就是码元。JS 侧不需要对应处理：JSON.stringify 自己
      // 就会把落单代理项转义成 \uXXXX，那边天然无损。
      case 'js_s16': {
        const arg = e.args[0];
        if (arg && arg.kind === 'Const' && typeof arg.value === 'string') {
          return `omni_dyn_of_s16(${this.s16Lit(arg.value)})`;
        }
        return `omni_js_s16(${a[0]})`;
      }
      // 下标是编译期常量时走 geti：实参表读参数（arr_get(args, 0)）是最高频的一条
      case 'js_arr_get': {
        const k = constIndex(e.args[1]);
        if (k !== null) return `omni_js_arr_geti(${a[0]}, ${k})`;
        return `omni_js_arr_get(${a[0]}, ${a[1]})`;
      }
      // `x === "字面量"`：特化成能内联的 omni_js_eq_s16k（见 omni.h）。switch 降下来是
      // 一条 if-else 链，编译器自己的 switch (e.kind) 动辄四十路，省下的是四十次调用。
      case 'js_eq': {
        if (e.strict === true) {
          const l = constKey(e.args[0]);
          const r = constKey(e.args[1]);
          if (r !== null) return `omni_js_eq_s16k(${a[0]}, ${this.s16Lit(r)})`;
          if (l !== null) return `omni_js_eq_s16k(${a[1]}, ${this.s16Lit(l)})`;
        }
        return `omni_js_eq(${e.strict === true}, ${a[0]}, ${a[1]})`;
      }
      // 键是字面量时走 ...k：字典的键口径是 UTF-8，字面量池里已经算好了一份静态的，
      // 免掉 omni_js_prop 每次的 UTF-16 -> UTF-8 转换和 arena 分配（见 omni_js_obj.h）。
      case 'js_obj_get': case 'js_obj_set': case 'js_obj_has': case 'js_obj_delete': {
        const k = constKey(e.args[1]);
        if (k !== null) {
          const args = [a[0], `${this.s16Lit(k)}_s`, ...a.slice(2)];
          return `omni_${e.name}k(${args.join(', ')})`;
        }
        return `${JS_ALL[e.name].c}(${a.join(', ')})`;
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
 * 字符串的 UTF-8 字节：搬到 `host/utf8.js` 了 —— LLVM 后端第二阶段也要它，
 * 而复制第二份的下场是两条腿在落单代理项上分叉（见那个文件的头）。
 */

/**
 * 属性键里编译期就定下来的那个字符串。前端把 `o.k` / `o['k']` / `'k' in o` 都降成
 * `js_s16(Const)`（见 frontend-js/lower.js 的 s16），所以只认这一个形状。
 * 不是字面量就返回 null，调用点退回通用的那条。
 * @returns {string | null}
 */
function constKey(n) {
  if (!n || n.kind !== 'Builtin' || n.name !== 'js_s16') return null;
  const c = n.args[0];
  if (!c || c.kind !== 'Const' || typeof c.value !== 'string') return null;
  return c.value;
}

/**
 * 下标里编译期就定下来的那个整数。JS 域的数只有 real 一种，所以还要确认它真是个整数
 * 且落在安全整数范围里 —— 不然 `(int64_t)` 的口径和 omni_js_arr_i 的就不是一回事了。
 * @returns {string | null}
 */
function constIndex(n) {
  if (n && n.kind === 'Box') n = n.expr;
  if (!n || n.kind !== 'Const' || typeof n.value !== 'number') return null;
  if (!Number.isInteger(n.value) || Math.abs(n.value) > 9007199254740991) return null;
  return String(n.value);
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
