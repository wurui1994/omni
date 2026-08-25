/**
 * JS 前端的 Builtin ABI（ADR-0011 第 2 节）—— 唯一的真源。
 *
 * 宿主库不在 Omni 里重写，而是收成这一张封闭的 op 表，两边各实现一次：
 *   JS 后端 -> backend-js/prelude.js 里的 `js`  字段那个函数
 *   C  后端 -> runtime/omni_js*.c   里的 `c`   字段那个函数
 *
 * 表里没有的东西，降级时就不许用 —— 这是"封闭"的含义。加一个 op 的成本是：
 * 这里一行 + 两个实现 + tests/oir 里一条对照 node 的用例。三样缺一不可。
 *
 * 约定：
 *   - 所有参数与返回值都是 dynamic，除了 ret/args 里写了别的
 *   - `lit` 列出的是**编译期常量参数**，从 OIR 节点的同名字段取，排在实参前面
 *   - 名字里的 arr/str/map/set/obj 是接收者的静态期望；运行期由实现自己检查标签
 */

/** @type {Record<string, {js: string, c: string, arity: number, lit?: string[], pure?: boolean}>} */
export const JS_ABI = {
  // ---------------------------------------------------------------- 值与运算
  js_asFn: { js: '$js_asFn', c: 'omni_js_as_fn', arity: 1 },
  js_truthy: { js: '$js_truthy', c: 'omni_js_truthy', arity: 1 },
  js_typeof: { js: '$js_typeof', c: 'omni_js_typeof', arity: 1 },
  js_str: { js: '$js_str', c: 'omni_js_str', arity: 1 },
  js_add: { js: '$js_add', c: 'omni_js_add', arity: 2 },
  js_neg: { js: '$js_neg', c: 'omni_js_neg', arity: 1 },
  js_arith: { js: '$js_arith', c: 'omni_js_arith', arity: 2, lit: ['op'] },
  js_bitop: { js: '$js_bitop', c: 'omni_js_bitop', arity: 2, lit: ['op'] },
  js_bitnot: { js: '$js_bitnot', c: 'omni_js_bitnot', arity: 1 },
  js_cmp: { js: '$js_cmp', c: 'omni_js_cmp', arity: 2, lit: ['op'] },
  js_eq: { js: '$js_eq', c: 'omni_js_eq', arity: 2, lit: ['strict'] },

  // ---------------------------------------------------------------- 输出
  // JS 的 String 是 UTF-16，落到 stdout 要转回 UTF-8。收成一个 op，让"什么时候转码"
  // 是一处显式边界，而不是散在各个打印点上。
  js_println: { js: '$js_println', c: 'omni_js_println', arity: 1 },

  // ---------------------------------------------------------------- String
  // 下标、长度一律按 UTF-16 码元（ADR-0011 第 8 节）。缺席的实参传 js_undef。
  // js_s16 是入口：源码里的字面量是 UTF-8 的 Omni string，进 JS 域先转成码元序列。
  js_s16: { js: '$js_s16', c: 'omni_js_s16', arity: 1 },
  js_str_len: { js: '$js_str_len', c: 'omni_js_str_len', arity: 1 },
  js_str_index: { js: '$js_str_index', c: 'omni_js_str_index', arity: 2 },
  js_str_at: { js: '$js_str_at', c: 'omni_js_str_at', arity: 2 },
  js_str_char_code_at: { js: '$js_str_char_code_at', c: 'omni_js_str_char_code_at', arity: 2 },
  js_str_code_point_at: { js: '$js_str_code_point_at', c: 'omni_js_str_code_point_at', arity: 2 },
  js_str_slice: { js: '$js_str_slice', c: 'omni_js_str_slice', arity: 3 },
  js_str_repeat: { js: '$js_str_repeat', c: 'omni_js_str_repeat', arity: 2 },
  js_str_pad_start: { js: '$js_str_pad_start', c: 'omni_js_str_pad_start', arity: 3 },
  js_str_trim: { js: '$js_str_trim', c: 'omni_js_str_trim', arity: 1, lit: ['side'] },
  js_str_lower: { js: '$js_str_lower', c: 'omni_js_str_lower', arity: 1 },
  js_str_upper: { js: '$js_str_upper', c: 'omni_js_str_upper', arity: 1 },
  js_str_index_of: { js: '$js_str_index_of', c: 'omni_js_str_index_of', arity: 3 },
  js_str_last_index_of: { js: '$js_str_last_index_of', c: 'omni_js_str_last_index_of', arity: 2 },
  js_str_includes: { js: '$js_str_includes', c: 'omni_js_str_includes', arity: 2 },
  js_str_starts_with: { js: '$js_str_starts_with', c: 'omni_js_str_starts_with', arity: 3 },
  js_str_ends_with: { js: '$js_str_ends_with', c: 'omni_js_str_ends_with', arity: 2 },
  js_str_of_char_code: { js: '$js_str_of_char_code', c: 'omni_js_str_of_char_code', arity: 1 },
  js_str_of_code_point: { js: '$js_str_of_code_point', c: 'omni_js_str_of_code_point', arity: 1 },
};
