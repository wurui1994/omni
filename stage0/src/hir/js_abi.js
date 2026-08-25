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

  // ---------------------------------------------------------------- Array
  // JS 的 Array 就是 list<dynamic>。length 与下标是 Number（real），不是 int。
  // 这一批在 C 侧长在宏里（runtime/omni_js_arr.h）—— 运行时的 .c 看不见容器实例。
  js_arr_new: { js: '$js_arr_new', c: 'omni_js_arr_new', arity: 0 },
  js_arr_len: { js: '$js_arr_len', c: 'omni_js_arr_len', arity: 1 },
  js_arr_get: { js: '$js_arr_get', c: 'omni_js_arr_get', arity: 2 },
  js_arr_set: { js: '$js_arr_set', c: 'omni_js_arr_set', arity: 3 },
  js_arr_push: { js: '$js_arr_push', c: 'omni_js_arr_push', arity: 2 },
  js_arr_pop: { js: '$js_arr_pop', c: 'omni_js_arr_pop', arity: 1 },
  js_arr_slice: { js: '$js_arr_slice', c: 'omni_js_arr_slice', arity: 3 },
  js_arr_concat: { js: '$js_arr_concat', c: 'omni_js_arr_concat', arity: 2 },
  js_arr_reverse: { js: '$js_arr_reverse', c: 'omni_js_arr_reverse', arity: 1 },
  js_arr_fill: { js: '$js_arr_fill', c: 'omni_js_arr_fill', arity: 2 },
  js_arr_is_array: { js: '$js_arr_is_array', c: 'omni_js_arr_is_array', arity: 1 },
  js_arr_from: { js: '$js_arr_from', c: 'omni_js_arr_from', arity: 1 },
  js_arr_index_of: { js: '$js_arr_index_of', c: 'omni_js_arr_index_of', arity: 2 },
  js_arr_last_index_of: { js: '$js_arr_last_index_of', c: 'omni_js_arr_last_index_of', arity: 2 },
  js_arr_includes: { js: '$js_arr_includes', c: 'omni_js_arr_includes', arity: 2 },
  js_arr_join: { js: '$js_arr_join', c: 'omni_js_arr_join', arity: 2 },
  js_arr_map: { js: '$js_arr_map', c: 'omni_js_arr_map', arity: 2 },
  js_arr_filter: { js: '$js_arr_filter', c: 'omni_js_arr_filter', arity: 2 },
  js_arr_for_each: { js: '$js_arr_for_each', c: 'omni_js_arr_for_each', arity: 2 },
  js_arr_some: { js: '$js_arr_some', c: 'omni_js_arr_some', arity: 2 },
  js_arr_every: { js: '$js_arr_every', c: 'omni_js_arr_every', arity: 2 },
  js_arr_find: { js: '$js_arr_find', c: 'omni_js_arr_find', arity: 2 },
  js_arr_find_index: { js: '$js_arr_find_index', c: 'omni_js_arr_find_index', arity: 2 },
  js_arr_reduce: { js: '$js_arr_reduce', c: 'omni_js_arr_reduce', arity: 3 },
  js_arr_flat_map: { js: '$js_arr_flat_map', c: 'omni_js_arr_flat_map', arity: 2 },
  js_arr_sort: { js: '$js_arr_sort', c: 'omni_js_arr_sort', arity: 2 },

  // ------------------------------------------------- 普通对象 / Map / Set
  // 对象 -> dict<string, dynamic>，键是属性名的 UTF-8（进出转码）。
  // Map/Set -> 同一种 dict，但键是带标签的规范化字符串，条目里存着原键 ——
  // 量过的源码里有两张 Map 用数字键，"1" 不能和 1n 撞（见 ADR-0011 的"已量过的宿主面"）。
  js_obj_new: { js: '$js_obj_new', c: 'omni_js_obj_new', arity: 0 },
  js_obj_get: { js: '$js_obj_get', c: 'omni_js_obj_get', arity: 2 },
  js_obj_set: { js: '$js_obj_set', c: 'omni_js_obj_set', arity: 3 },
  js_obj_has: { js: '$js_obj_has', c: 'omni_js_obj_has', arity: 2 },
  js_obj_delete: { js: '$js_obj_delete', c: 'omni_js_obj_delete', arity: 2 },
  js_obj_keys: { js: '$js_obj_keys', c: 'omni_js_obj_keys', arity: 1 },
  js_obj_values: { js: '$js_obj_values', c: 'omni_js_obj_values', arity: 1 },
  js_obj_entries: { js: '$js_obj_entries', c: 'omni_js_obj_entries', arity: 1 },

  js_map_new: { js: '$js_map_new', c: 'omni_js_map_new', arity: 0 },
  js_map_size: { js: '$js_map_size', c: 'omni_js_map_size', arity: 1 },
  js_map_has: { js: '$js_map_has', c: 'omni_js_map_has', arity: 2 },
  js_map_get: { js: '$js_map_get', c: 'omni_js_map_get', arity: 2 },
  js_map_set: { js: '$js_map_set', c: 'omni_js_map_set', arity: 3 },
  js_map_delete: { js: '$js_map_delete', c: 'omni_js_map_delete', arity: 2 },
  js_map_keys: { js: '$js_map_keys', c: 'omni_js_map_keys', arity: 1 },
  js_map_values: { js: '$js_map_values', c: 'omni_js_map_values', arity: 1 },
  js_map_entries: { js: '$js_map_entries', c: 'omni_js_map_entries', arity: 1 },

  js_set_new: { js: '$js_set_new', c: 'omni_js_set_new', arity: 0 },
  js_set_size: { js: '$js_set_size', c: 'omni_js_set_size', arity: 1 },
  js_set_has: { js: '$js_set_has', c: 'omni_js_set_has', arity: 2 },
  js_set_add: { js: '$js_set_add', c: 'omni_js_set_add', arity: 2 },
  js_set_delete: { js: '$js_set_delete', c: 'omni_js_set_delete', arity: 2 },
  js_set_items: { js: '$js_set_items', c: 'omni_js_set_items', arity: 1 },

  // ---------------------------------------------------------------- Number / Math
  // toPrecision 与 toString(radix) 在自举的关键路径上：编译器自己用它们把 double 与
  // 字节写进生成的 C（cReal 的 toPrecision(17)、cString 的 toString(8)）。
  js_num_is_nan: { js: '$js_num_is_nan', c: 'omni_js_num_is_nan', arity: 1 },
  js_num_is_finite: { js: '$js_num_is_finite', c: 'omni_js_num_is_finite', arity: 1 },
  js_num_is_integer: { js: '$js_num_is_integer', c: 'omni_js_num_is_integer', arity: 1 },
  js_num_of: { js: '$js_num_of', c: 'omni_js_num_of', arity: 1 },
  js_bigint_of: { js: '$js_bigint_of', c: 'omni_js_bigint_of', arity: 1 },
  js_bigint_as_int_n: { js: '$js_bigint_as_int_n', c: 'omni_js_bigint_as_int_n', arity: 2 },
  js_num_to_precision: { js: '$js_num_to_precision', c: 'omni_js_num_to_precision', arity: 2 },
  js_num_to_string: { js: '$js_num_to_string', c: 'omni_js_num_to_string', arity: 2 },
  // op: 'a' abs / 't' trunc / 'f' floor / 'c' ceil / 'M' max / 'm' min
  js_math: { js: '$js_math', c: 'omni_js_math', arity: 2, lit: ['op'] },

  // ---------------------------------------------------------------- JSON
  // 只有 stringify：量过一遍，JSON.parse 全仓库 0 处用到，封闭的 ABI 就不收它。
  // 实参形态也是量出来的 —— 绝大多数是一个实参给字符串加引号，只有 cli 的 dump
  // 用了 (v, replacer, 2)。replacer 只支持函数形式。
  js_json_stringify: { js: '$js_json_stringify', c: 'omni_js_json_stringify', arity: 3 },
};
