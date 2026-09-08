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
 *   - `ret: 'bool'` 是 C 侧真的返回 `bool` 的那些（成员派发器要照它定返回类型）
 *   - `lit` 列出的是**编译期常量参数**，从 OIR 节点的同名字段取，排在实参前面
 *   - 名字里的 arr/str/map/set/obj 是接收者的静态期望；运行期由实现自己检查标签
 */

/** @type {Record<string, {js: string, c: string, arity: number, lit?: string[], ret?: string, pure?: boolean}>} */
export const JS_ABI = {
  // ---------------------------------------------------------------- 值与运算
  // raw：签名不是清一色的 omni_dyn（这一条返回 omni_fn），所以按名字调不了 —— 见
  // js_call_op 与两个后端的 callOpDispatch。它只出现在降级器静态发出来的位置上。
  js_asFn: { js: '$js_asFn', c: 'omni_js_as_fn', arity: 1, raw: true },
  js_truthy: { js: '$js_truthy', c: 'omni_js_truthy', arity: 1, ret: 'bool' },
  js_typeof: { js: '$js_typeof', c: 'omni_js_typeof', arity: 1 },
  js_str: { js: '$js_str', c: 'omni_js_str', arity: 1 },
  js_add: { js: '$js_add', c: 'omni_js_add', arity: 2 },
  js_neg: { js: '$js_neg', c: 'omni_js_neg', arity: 1 },
  // op: '-' '*' '/' '%' 加 'p' 幂（JS 的 `**`）。`+` 不在这儿 —— 它要先问字符串，是 js_add。
  // 幂那一格与别的算术一视同仁：int 那一支**照样回卷到 64 位**（ADR-0005 的值语义 ——
  // 这个值域里的 int 就是 int64，不是无界的 BigInt），所以 `2n ** 64n` 是 0，不是 2^64。
  js_arith: { js: '$js_arith', c: 'omni_js_arith', arity: 2, lit: ['op'] },
  js_bitop: { js: '$js_bitop', c: 'omni_js_bitop', arity: 2, lit: ['op'] },
  js_bitnot: { js: '$js_bitnot', c: 'omni_js_bitnot', arity: 1 },
  js_cmp: { js: '$js_cmp', c: 'omni_js_cmp', arity: 2, lit: ['op'], ret: 'bool' },
  js_eq: { js: '$js_eq', c: 'omni_js_eq', arity: 2, lit: ['strict'], ret: 'bool' },

  // ---------------------------------------------------------------- 输出
  // JS 的 String 是 UTF-16，落到 stdout 要转回 UTF-8。收成一个 op，让"什么时候转码"
  // 是一处显式边界，而不是散在各个打印点上。
  js_println: { js: '$js_println', c: 'omni_js_println', arity: 1, ret: 'void' },

  // ---------------------------------------------------------------- String
  // 下标、长度一律按 UTF-16 码元（ADR-0011 第 8 节）。缺席的实参传 js_undef。
  // js_s16 是入口：源码里的字面量是 UTF-8 的 Omni string，进 JS 域先转成码元序列。
  // raw: 'str' —— C 侧的形参是 omni_str 而不是 omni_dyn，按名字调的时候要先取出字符串
  // （见两个后端的 callOpDispatch）。解释器要用它：Omni 的 string 进 JS 域得转成码元序列。
  js_s16: { js: '$js_s16', c: 'omni_js_s16', arity: 1, raw: 'str' },
  js_str_len: { js: '$js_str_len', c: 'omni_js_str_len', arity: 1 },
  js_str_index: { js: '$js_str_index', c: 'omni_js_str_index', arity: 2 },
  js_str_at: { js: '$js_str_at', c: 'omni_js_str_at', arity: 2 },
  js_str_char_at: { js: '$js_str_char_at', c: 'omni_js_str_char_at', arity: 2 },
  js_str_char_code_at: { js: '$js_str_char_code_at', c: 'omni_js_str_char_code_at', arity: 2 },
  js_str_code_point_at: { js: '$js_str_code_point_at', c: 'omni_js_str_code_point_at', arity: 2 },
  js_str_slice: { js: '$js_str_slice', c: 'omni_js_str_slice', arity: 3 },
  js_str_repeat: { js: '$js_str_repeat', c: 'omni_js_str_repeat', arity: 2 },
  js_str_pad_start: { js: '$js_str_pad_start', c: 'omni_js_str_pad_start', arity: 3 },
  js_str_pad_end: { js: '$js_str_pad_end', c: 'omni_js_str_pad_end', arity: 3 },
  // replaceAll：**只收字符串模式**。正则那一支要 lastIndex 与替换串里的 $1，
  // 那两样在 js_re_* 那一族里（regexp 接收者由 lower.js 静态发过去）。
  js_str_replace_all: { js: '$js_str_replace_all', c: 'omni_js_str_replace_all', arity: 3 },
  js_str_trim: { js: '$js_str_trim', c: 'omni_js_str_trim', arity: 1, lit: ['side'] },
  js_str_lower: { js: '$js_str_lower', c: 'omni_js_str_lower', arity: 1 },
  js_str_upper: { js: '$js_str_upper', c: 'omni_js_str_upper', arity: 1 },
  js_str_index_of: { js: '$js_str_index_of', c: 'omni_js_str_index_of', arity: 3 },
  js_str_last_index_of: { js: '$js_str_last_index_of', c: 'omni_js_str_last_index_of', arity: 3 },
  js_str_includes: { js: '$js_str_includes', c: 'omni_js_str_includes', arity: 2, ret: 'bool' },
  js_str_starts_with: { js: '$js_str_starts_with', c: 'omni_js_str_starts_with', arity: 3, ret: 'bool' },
  js_str_ends_with: { js: '$js_str_ends_with', c: 'omni_js_str_ends_with', arity: 2, ret: 'bool' },
  js_str_of_char_code: { js: '$js_str_of_char_code', c: 'omni_js_str_of_char_code', arity: 1 },
  js_str_of_code_point: { js: '$js_str_of_code_point', c: 'omni_js_str_of_code_point', arity: 1 },

  // ---------------------------------------------------------------- Array
  // JS 的 Array 就是 list<dynamic>。length 与下标是 Number（real），不是 int。
  // 这一批在 C 侧长在宏里（runtime/omni_js_arr.h）—— 运行时的 .c 看不见容器实例。
  js_arr_new: { js: '$js_arr_new', c: 'omni_js_arr_new', arity: 0 },
  // new Array(n)：长度 n、每一格 undefined。这个值域里"洞"与 undefined 不可区分 ——
  // C 侧的 list 本来就是密的，所以两侧都老老实实把每一格填成 undefined。
  // 实参不是数时与 JS 一样：那就是一格元素（new Array("x") 是 ["x"]）。
  js_arr_new_n: { js: '$js_arr_new_n', c: 'omni_js_arr_new_n', arity: 1 },
  js_arr_len: { js: '$js_arr_len', c: 'omni_js_arr_len', arity: 1 },
  js_arr_get: { js: '$js_arr_get', c: 'omni_js_arr_get', arity: 2 },
  js_arr_set: { js: '$js_arr_set', c: 'omni_js_arr_set', arity: 3, ret: 'void' },
  js_arr_push: { js: '$js_arr_push', c: 'omni_js_arr_push', arity: 2 },
  // a.push(x, ...ys)：实参拼成一个 list 整段追加（定长的 op 表达不了可变实参）。
  // 落到的是**派发器**：接收者不是 list 时退回"取属性、当函数调"（决策 12），
  // 因为 `x.push()` / `x.push(...xs)` 这两种形状在降级时分不出接收者是谁。
  js_arr_push_all: { js: '$js_arr_push_dyn', c: 'omni_js_arr_push_dyn', arity: 2 },
  js_arr_pop: { js: '$js_arr_pop', c: 'omni_js_arr_pop', arity: 1 },
  // a.unshift(x)：往头上插一格（第一百〇四刀）。从前 ABI 里没有它，而编译器自己
  // 新写的代码用上了（asy 前端往 `(main …)` 头上补一句），量出来的样子是自举出来的
  // 那份当场 `omni rt: undefined is not a function` —— 动态接收者上取 "unshift"
  // 取到 undefined。**只收一个实参**：可变实参的形状与 push 一样要走派发器，
  // 而源码里只有一处、只插一格，等真有第二处再长那一格。
  js_arr_unshift: { js: '$js_arr_unshift', c: 'omni_js_arr_unshift', arity: 2 },
  js_arr_slice: { js: '$js_arr_slice', c: 'omni_js_arr_slice', arity: 3 },
  js_arr_concat: { js: '$js_arr_concat', c: 'omni_js_arr_concat', arity: 2 },
  js_arr_reverse: { js: '$js_arr_reverse', c: 'omni_js_arr_reverse', arity: 1 },
  js_arr_fill: { js: '$js_arr_fill', c: 'omni_js_arr_fill', arity: 2 },
  js_arr_is_array: { js: '$js_arr_is_array', c: 'omni_js_arr_is_array', arity: 1, ret: 'bool' },
  js_arr_from: { js: '$js_arr_from', c: 'omni_js_arr_from', arity: 1 },
  // a.at(i)：负下标从尾部数（`a[-1]` 在 JS 里是取属性，不是取末元素），越界 undefined
  js_arr_at: { js: '$js_arr_at', c: 'omni_js_arr_at', arity: 2 },
  js_arr_index_of: { js: '$js_arr_index_of', c: 'omni_js_arr_index_of', arity: 2 },
  js_arr_last_index_of: { js: '$js_arr_last_index_of', c: 'omni_js_arr_last_index_of', arity: 2 },
  js_arr_includes: { js: '$js_arr_includes', c: 'omni_js_arr_includes', arity: 2, ret: 'bool' },
  js_arr_join: { js: '$js_arr_join', c: 'omni_js_arr_join', arity: 2 },
  // throws: true —— 回调是用户代码，会往 pending 槽里放东西（见文件末尾 throw/try 那节）
  js_arr_map: { js: '$js_arr_map', c: 'omni_js_arr_map', arity: 2, throws: true },
  js_arr_filter: { js: '$js_arr_filter', c: 'omni_js_arr_filter', arity: 2, throws: true },
  js_arr_for_each: { js: '$js_arr_for_each', c: 'omni_js_arr_for_each', arity: 2, ret: 'void', throws: true },
  js_arr_some: { js: '$js_arr_some', c: 'omni_js_arr_some', arity: 2, ret: 'bool', throws: true },
  js_arr_every: { js: '$js_arr_every', c: 'omni_js_arr_every', arity: 2, ret: 'bool', throws: true },
  js_arr_find: { js: '$js_arr_find', c: 'omni_js_arr_find', arity: 2, throws: true },
  js_arr_find_index: { js: '$js_arr_find_index', c: 'omni_js_arr_find_index', arity: 2, throws: true },
  js_arr_reduce: { js: '$js_arr_reduce', c: 'omni_js_arr_reduce', arity: 3, throws: true },
  js_arr_flat_map: { js: '$js_arr_flat_map', c: 'omni_js_arr_flat_map', arity: 2, throws: true },
  js_arr_sort: { js: '$js_arr_sort', c: 'omni_js_arr_sort', arity: 2, throws: true },
  js_arr_reduce_right: { js: '$js_arr_reduce_right', c: 'omni_js_arr_reduce_right', arity: 3, throws: true },
  // flat 的深度默认 1，Infinity 也收（到不了的层自然停）。不递归调自己：
  // 深度是个计数，用显式的两层循环摊平，省得深数组把 C 栈捅穿。
  js_arr_flat: { js: '$js_arr_flat', c: 'omni_js_arr_flat', arity: 2 },
  // toSorted：先整段拷贝再就地排 —— sort 那份的稳定性与比较器语义一个字不改
  js_arr_to_sorted: { js: '$js_arr_to_sorted', c: 'omni_js_arr_to_sorted', arity: 2, throws: true },

  // ------------------------------------------------- 普通对象 / Map / Set
  // 对象 -> dict<string, dynamic>，键是属性名的 UTF-8（进出转码）。
  // Map/Set -> 同一种 dict，但键是带标签的规范化字符串，条目里存着原键 ——
  // 量过的源码里有两张 Map 用数字键，"1" 不能和 1n 撞（见 ADR-0011 的"已量过的宿主面"）。
  js_obj_new: { js: '$js_obj_new', c: 'omni_js_obj_new', arity: 0 },
  js_obj_get: { js: '$js_obj_get', c: 'omni_js_obj_get', arity: 2 },
  js_obj_set: { js: '$js_obj_set', c: 'omni_js_obj_set', arity: 3 },
  js_obj_has: { js: '$js_obj_has', c: 'omni_js_obj_has', arity: 2, ret: 'bool' },
  js_obj_delete: { js: '$js_obj_delete', c: 'omni_js_obj_delete', arity: 2, ret: 'bool' },
  js_obj_keys: { js: '$js_obj_keys', c: 'omni_js_obj_keys', arity: 1 },
  js_obj_values: { js: '$js_obj_values', c: 'omni_js_obj_values', arity: 1 },
  js_obj_entries: { js: '$js_obj_entries', c: 'omni_js_obj_entries', arity: 1 },
  // { ...src, k: v } 的展开那一步：把 src 的自有键抄进 dst，返回 dst
  js_obj_assign: { js: '$js_obj_assign', c: 'omni_js_obj_assign', arity: 2 },

  // ------------------------------------------------- 真对象 / Symbol（ADR-0020 P1）
  // 上面那一族（js_obj_*）的载体是 dict<string,dynamic>：没有原型、没有描述符、
  // 没有 Symbol 键，于是访问器、defineProperty、instanceof 的链、迭代器协议都做不出来。
  // 这一族是新的那一格 —— 原型链 + 属性槽（数据/访问器 + writable/enumerable/configurable）。
  // 迁移期两格并存：编译器自己的源码还跑在上面那族上，一个字节都不动。
  //
  // **C 侧还没落地**（omni_js_object.c 是下一片）。现在没有任何降级会发这些 op，所以
  // 生成的 C 里引用不到它们 —— 这一条写在明处，不假装两边已经齐了。
  js_obj_new_p: { js: '$js_obj_new_p', c: 'omni_js_obj_new_p', arity: 1 },
  js_obj_proto_get: { js: '$js_obj_proto_get', c: 'omni_js_obj_proto_get', arity: 1 },
  js_obj_proto_set: { js: '$js_obj_proto_set', c: 'omni_js_obj_proto_set', arity: 2 },
  // 取/设属性的**完整语义**：沿原型链、触发访问器、按可写性决定落不落自有槽。
  js_getp: { js: '$js_getp', c: 'omni_js_getp', arity: 2 },
  js_setp: { js: '$js_setp', c: 'omni_js_setp', arity: 3 },
  js_obj_has_p: { js: '$js_obj_has_p', c: 'omni_js_obj_has_p', arity: 2, ret: 'bool' },
  js_obj_del_p: { js: '$js_obj_del_p', c: 'omni_js_obj_del_p', arity: 2, ret: 'bool' },
  js_obj_has_own: { js: '$js_obj_has_own', c: 'omni_js_obj_has_own', arity: 2, ret: 'bool' },
  // desc 进出都是**一格真对象**（不是 dict）：Object.defineProperty 的实参就是它。
  js_obj_def: { js: '$js_obj_def', c: 'omni_js_obj_def', arity: 3, throws: true },
  js_obj_desc: { js: '$js_obj_desc', c: 'omni_js_obj_desc', arity: 2 },
  // sel: 's' 字符串键 / 'y' Symbol 键 / 'a' 全部 / 'e' 可枚举的字符串键（Object.keys）
  // **不能叫 kind**：lit 的字段名会直接落在 Builtin 节点身上，而 `kind` 是 IR 节点自己的
  // 判别字段 —— 叫 kind 的话发射器把这一格当成"一个 kind 为 'a' 的表达式"，当场 js.expr: a
  js_obj_own_keys: { js: '$js_obj_own_keys', c: 'omni_js_obj_own_keys', arity: 1, lit: ['sel'] },
  js_obj_freeze: { js: '$js_obj_freeze', c: 'omni_js_obj_freeze', arity: 1 },
  js_obj_seal: { js: '$js_obj_seal', c: 'omni_js_obj_seal', arity: 1 },
  js_obj_prevent_ext: { js: '$js_obj_prevent_ext', c: 'omni_js_obj_prevent_ext', arity: 1 },
  js_obj_is_frozen: { js: '$js_obj_is_frozen', c: 'omni_js_obj_is_frozen', arity: 1, ret: 'bool' },
  js_obj_is_sealed: { js: '$js_obj_is_sealed', c: 'omni_js_obj_is_sealed', arity: 1, ret: 'bool' },
  js_obj_is_ext: { js: '$js_obj_is_ext', c: 'omni_js_obj_is_ext', arity: 1, ret: 'bool' },
  js_obj_to_string: { js: '$js_obj_to_string', c: 'omni_js_obj_to_string', arity: 1 },
  // Object.fromEntries：吃一串 [k, v]（数组 / Map / 任何可迭代的），出一格真对象
  js_obj_from_entries: { js: '$js_obj_from_entries', c: 'omni_js_obj_from_entries', arity: 1 },
  // 带接收者的调用。ADR-0011 那一代的 this 是捕获的 cell，所以对编译出来的函数这是
  // 空操作；原型上的内建方法必须靠它拿到接收者（prelude 里那一格 fp2）。
  js_call_this: { js: '$js_call_this', c: 'omni_js_call_this', arity: 3 },
  // 函数入口取接收者（读一次就清）。与上面那条成一对：this 走一格运行期的槽，而不是
  // 改函数签名 —— 改签名要动闭包记录、MakeClosure 与两个后端的调用约定。
  js_this_take: { js: '$js_this_take', c: 'omni_js_this_take', arity: 0 },
  js_instanceof: { js: '$js_instanceof', c: 'omni_js_instanceof', arity: 2, ret: 'bool' },
  // hint: 'n' number / 's' string / 'd' default（规范的 ToPrimitive）
  js_to_prim: { js: '$js_to_prim', c: 'omni_js_to_prim', arity: 1, lit: ['hint'] },
  // 迭代器协议：拿迭代器、走一步（结果是 { value, done } 那一格对象）
  js_iter_proto: { js: '$js_iter_proto', c: 'omni_js_iter_proto', arity: 1 },
  js_iter_next: { js: '$js_iter_next', c: 'omni_js_iter_next', arity: 1 },
  // for-in 走一遍的那一串键：自有 + 继承来的可枚举字符串键，去重（ADR-0020 P3）
  js_for_in_keys: { js: '$js_for_in_keys', c: 'omni_js_for_in_keys', arity: 1 },
  js_sym_new: { js: '$js_sym_new', c: 'omni_js_sym_new', arity: 1 },
  js_sym_for: { js: '$js_sym_for', c: 'omni_js_sym_for', arity: 1 },
  js_sym_key_for: { js: '$js_sym_key_for', c: 'omni_js_sym_key_for', arity: 1 },
  js_sym_desc: { js: '$js_sym_desc', c: 'omni_js_sym_desc', arity: 1 },
  js_sym_str: { js: '$js_sym_str', c: 'omni_js_sym_str', arity: 1 },
  // well-known Symbol：名字是编译期常量（iterator / asyncIterator / toPrimitive /
  // toStringTag / hasInstance / …）。lit 的字段名**刻意不叫 name** —— OIR 的 Builtin
  // 节点自己有一格 `name`（op 的名字），lit 铺进去会把它盖掉（量出来的：
  // "js.builtin: toStringTag"）。
  js_sym_wk: { js: '$js_sym_wk', c: 'omni_js_sym_wk', arity: 0, lit: ['wk'] },
  // 内建原型（Object / Function / Array / String / Number / Boolean / Symbol /
  // Error / Map / Set / RegExp / Iterator）—— 内建方法就住在这些对象上
  js_realm_proto: { js: '$js_realm_proto', c: 'omni_js_realm_proto', arity: 0, lit: ['proto'] },
  // globalThis：一格普通的真对象，每个 realm 一份（见 prelude 里 gt 那一格的说明）
  js_global_this: { js: '$js_global_this', c: 'omni_js_global_this', arity: 0 },
  // new Date(ms)：一格真对象，毫秒在隐藏槽 $ms 里，取值面挂在 realm 的 dateP 上。
  // `Date.now()` 不走这里 —— 它就是 js_now_ms。
  js_date_new: { js: '$js_date_new', c: 'omni_js_date_new', arity: 1 },
  /* new Proxy(target, handler)（ADR-0020 P4）：代理与普通对象是同一种值，差别只在
     属性访问的五个入口上多问一句陷阱（get / set / has / deleteProperty / ownKeys）。
     apply/construct 与规范那套不变量校验都不做 —— 见 prelude 里 $js_px_trap 的说明。 */
  js_proxy_new: { js: '$js_proxy_new', c: 'omni_js_proxy_new', arity: 2 },
  /* Promise 与作业队列（ADR-0020 P2 的前半）。then / catch / finally 不在这张表里 ——
     它们住在 realm 的 promP 上，`p.then(f)` 走的是"取属性 + 带接收者调用"那条通用路。
     js_jobs_run 由降级器补在 main 的**末尾**（只在这个模块真用到 Promise 时才补）：
     这个值域里没有事件循环，"调用栈空了"只有那一处可观测。 */
  js_promise_new: { js: '$js_promise_new', c: 'omni_js_promise_new', arity: 1, throws: true },
  js_promise_resolved: { js: '$js_promise_resolved', c: 'omni_js_promise_resolved', arity: 1 },
  js_promise_rejected: { js: '$js_promise_rejected', c: 'omni_js_promise_rejected', arity: 1 },
  js_promise_all: { js: '$js_promise_all', c: 'omni_js_promise_all', arity: 1, throws: true },
  js_jobs_run: { js: '$js_jobs_run', c: 'omni_js_jobs_run', arity: 0, ret: 'void', throws: true },

  js_map_new: { js: '$js_map_new', c: 'omni_js_map_new', arity: 0 },
  js_map_size: { js: '$js_map_size', c: 'omni_js_map_size', arity: 1 },
  js_map_has: { js: '$js_map_has', c: 'omni_js_map_has', arity: 2, ret: 'bool' },
  js_map_get: { js: '$js_map_get', c: 'omni_js_map_get', arity: 2 },
  js_map_set: { js: '$js_map_set', c: 'omni_js_map_set', arity: 3 },
  js_map_delete: { js: '$js_map_delete', c: 'omni_js_map_delete', arity: 2, ret: 'bool' },
  js_map_keys: { js: '$js_map_keys', c: 'omni_js_map_keys', arity: 1 },
  js_map_values: { js: '$js_map_values', c: 'omni_js_map_values', arity: 1 },
  js_map_entries: { js: '$js_map_entries', c: 'omni_js_map_entries', arity: 1 },

  js_set_new: { js: '$js_set_new', c: 'omni_js_set_new', arity: 0 },
  js_set_size: { js: '$js_set_size', c: 'omni_js_set_size', arity: 1 },
  js_set_has: { js: '$js_set_has', c: 'omni_js_set_has', arity: 2, ret: 'bool' },
  js_set_add: { js: '$js_set_add', c: 'omni_js_set_add', arity: 2 },
  js_set_delete: { js: '$js_set_delete', c: 'omni_js_set_delete', arity: 2, ret: 'bool' },
  js_set_items: { js: '$js_set_items', c: 'omni_js_set_items', arity: 1 },
  // new Map(pairs) / new Set(items)：初值收 list，也收同类容器（浅拷贝），缺参数就是空容器
  js_map_of_pairs: { js: '$js_map_of_pairs', c: 'omni_js_map_of_pairs', arity: 1 },
  js_set_of_list: { js: '$js_set_of_list', c: 'omni_js_set_of_list', arity: 1 },

  // ---------------------------------------------------------------- Number / Math
  // toPrecision 与 toString(radix) 在自举的关键路径上：编译器自己用它们把 double 与
  // 字节写进生成的 C（cReal 的 toPrecision(17)、cString 的 toString(8)）。
  js_num_is_nan: { js: '$js_num_is_nan', c: 'omni_js_num_is_nan', arity: 1, ret: 'bool' },
  js_num_is_finite: { js: '$js_num_is_finite', c: 'omni_js_num_is_finite', arity: 1, ret: 'bool' },
  js_num_is_integer: { js: '$js_num_is_integer', c: 'omni_js_num_is_integer', arity: 1, ret: 'bool' },
  js_num_of: { js: '$js_num_of', c: 'omni_js_num_of', arity: 1 },
  js_bigint_of: { js: '$js_bigint_of', c: 'omni_js_bigint_of', arity: 1 },
  js_bigint_as_int_n: { js: '$js_bigint_as_int_n', c: 'omni_js_bigint_as_int_n', arity: 2 },
  // asUintN 的结果可能落在 [2^63, 2^64)：JS 那边是个普通 BigInt，C 那边装不进
  // int64_t，所以值域里多一格无符号 64 位（omni.h 的 OMNI_DYN_UINT）。
  // 量到的用法只有 interp/builtin.js 的 udiv/umod/u< 与 u>>，那几个在 [0, 2^64)
  // 里都不溢出；别的运算碰上这一格会响 —— 那是画出来的边界，不是悄悄算错。
  js_bigint_as_uint_n: { js: '$js_bigint_as_uint_n', c: 'omni_js_bigint_as_uint_n', arity: 2 },
  js_num_to_precision: { js: '$js_num_to_precision', c: 'omni_js_num_to_precision', arity: 2 },
  js_num_to_string: { js: '$js_num_to_string', c: 'omni_js_num_to_string', arity: 2 },
  // op: 'a' abs / 't' trunc / 'f' floor / 'c' ceil / 'M' max / 'm' min
  //     后加的四个只给核心方言的 (rmath …) 用：'s' sqrt / 'r' round（C 的离零舍入，
  //     不是 Math.round）/ 'p' pow / 'o' fmod
  //     超越函数（同样只给 rmath 用，C 转手 libm、JS 转手 Math.*）：
  //     'S' sin / 'C' cos / 'T' tan / 'I' asin / 'A' acos / 'N' atan / '2' atan2 /
  //     'H' sinh / 'D' cosh / 'G' tanh / 'J' asinh / 'K' acosh / 'L' atanh /
  //     'E' exp / 'X' expm1 / 'O' log / 'Q' log10 / 'P' log1p / 'B' cbrt / 'Y' hypot
  //     'F' fround（ADR-0017 第一刀）：C 那边是一次 `(float)` 强制转换。MIR 的 f32
  //     语义（每步之后舍一次到单精度）靠它，而闭包解释器要在自举出来的编译器里也这么算。
  //     'W' nextafter（ADR-0019 路 2）：**JS 侧是手写的** —— `Math.*` 里没有 nextafter，
  //     而区间算术要「往上/往下挪一个 ulp」，用别的算符做不出来。权威是 C 的 `nextafter`；
  //     它是精确运算（IEEE-754 5.3.1 的 nextUp/nextDown），所以两侧可以要求逐字节相同。
  js_math: { js: '$js_math', c: 'omni_js_math', arity: 2, lit: ['op'] },

  // ---------------------------------------------------------------- JSON
  // 实参形态是量出来的 —— stringify 绝大多数是一个实参给字符串加引号，只有 cli 的 dump
  // 用了 (v, replacer, 2)。replacer 只支持函数形式。
  //
  // parse 从前不在表里（那时量到 0 处用到）。asy 的接口索引把 .aif 读回来之后就有一处：
  // cli.js:792 的 `JSON.parse(readText(p))`。封闭的 ABI 该长的时候就长 —— 反过来把编译器
  // 自己的源码改窄是把问题挪个地方。reviver 仍不收：仓库里 parse 全是一个实参。
  js_json_stringify: { js: '$js_json_stringify', c: 'omni_js_json_stringify', arity: 3, throws: true },
  js_json_parse: { js: '$js_json_parse', c: 'omni_js_json_parse', arity: 2, throws: true },

  // ---------------------------------------------------------------- RegExp
  // 模式与 flags 是普通的 string 实参（不是 lit）：两侧都按字面量做编译缓存，C 侧的键
  // 就是字面量指针，JS 侧是 "模式\0flags"。仓库里的正则全是字面量，而且没有一处读写
  // lastIndex（量过：所有 .test 的正则都不带 g），所以这一层不需要 RegExp 对象。
  js_re_test: { js: '$js_re_test', c: 'omni_js_re_test', arity: 3, ret: 'bool' },
  js_re_match: { js: '$js_re_match', c: 'omni_js_re_match', arity: 3 },
  js_re_split: { js: '$js_re_split', c: 'omni_js_re_split', arity: 4 },
  js_re_replace: { js: '$js_re_replace', c: 'omni_js_re_replace', arity: 4, throws: true },
  // 决策 10 的第二半：字面量不在上面四个接收位上时，求值出**一格正则对象**
  // （source / flags / lastIndex 三元组，编译产物照旧走上面那个缓存）。
  // 只长 exec 一格：量过，仓库里正则当值的用法就是 `re.exec(s)` 的循环。
  js_re_new: { js: '$js_re_new', c: 'omni_js_re_new', arity: 2 },
  js_re_exec: { js: '$js_re_exec', c: 'omni_js_re_exec', arity: 2 },
  /* 正则对象的 lastIndex（ADR-0020 P4）。它本来就在两侧的三元组里（src/flags/li）——
     缺的只是"能读能写"。写的那一条不走成员表：`r.lastIndex = 0` 降成 js_idx_set，
     所以 idx_set 里认这一格（regexp 上只有这一个可写的属性）。 */
  js_re_last_index: { js: '$js_re_last_index', c: 'omni_js_re_last_index', arity: 1 },

  // ------------------------------------------- 字节缓冲（ArrayBuffer / 两种视图）
  // interp/builtin.js 用它们模拟指针内存（ADR-0016）：一块 arena，"地址"就是偏移。
  // 值域里因此多一格 bytes（omni.h 的 OMNI_DYN_BYTES），载荷是 {p, len} —— 一个
  // **视图**。ArrayBuffer 与它上面的 Uint8Array / DataView 在这里是同一种值，区别只在
  // off/len 怎么截：三者共享同一块内存，别名关系于是天然成立。
  //
  // 存取一律**显式按字节拼**（不 memcpy 一个 int64/double 下去）：这样与宿主的 DataView
  // 逐位相同，不看机器的字节序。le 那个实参照 DataView 的签名收，两种都真支持。
  js_buf_new: { js: '$js_buf_new', c: 'omni_js_buf_new', arity: 1 },
  js_buf_view: { js: '$js_buf_view', c: 'omni_js_buf_view', arity: 3 },
  js_buf_len: { js: '$js_buf_len', c: 'omni_js_buf_len', arity: 1 },
  js_buf_set: { js: '$js_buf_set', c: 'omni_js_buf_set', arity: 2, ret: 'void' },
  js_buf_fill: { js: '$js_buf_fill', c: 'omni_js_buf_fill', arity: 2 },
  js_buf_get_u8: { js: '$js_buf_get_u8', c: 'omni_js_buf_get_u8', arity: 2 },
  js_buf_set_u8: { js: '$js_buf_set_u8', c: 'omni_js_buf_set_u8', arity: 3, ret: 'void' },
  js_buf_get_i64: { js: '$js_buf_get_i64', c: 'omni_js_buf_get_i64', arity: 3 },
  js_buf_set_i64: { js: '$js_buf_set_i64', c: 'omni_js_buf_set_i64', arity: 4, ret: 'void' },
  js_buf_get_f64: { js: '$js_buf_get_f64', c: 'omni_js_buf_get_f64', arity: 3 },
  js_buf_set_f64: { js: '$js_buf_set_f64', c: 'omni_js_buf_set_f64', arity: 4, ret: 'void' },
  /* DataView 的定宽整数与 float32（ADR-0020 P4）。一个 op 收全部宽度，宽度走 lit：
     'b' int8 / 'B' uint8 / 'h' int16 / 'H' uint16 / 'i' int32 / 'I' uint32 / 'f' float32。
     十二个方法名各占一格 op 的话 ABI 会胖一圈，而它们的区别只有"几个字节、有没有符号"。
     BigInt64 与 Float64 仍是上面那两条老 op —— 它们的**值域**不同（bigint / 双精度）。 */
  js_buf_getn: { js: '$js_buf_getn', c: 'omni_js_buf_getn', arity: 3, lit: ['sel'] },
  js_buf_setn: { js: '$js_buf_setn', c: 'omni_js_buf_setn', arity: 4, ret: 'void', lit: ['sel'] },
  // TextEncoder 是无状态的，但 `new TextEncoder().encode(t)` 是两步，所以那一格也得
  // 有个值。单独一个标签而不是拿 bytes 塞个哨兵 —— 哨兵一漏就是悄悄算错。
  js_text_enc_new: { js: '$js_text_enc_new', c: 'omni_js_text_enc_new', arity: 0 },
  js_text_encode: { js: '$js_text_encode', c: 'omni_js_text_encode', arity: 2 },

  // -------------------------------------------------- 字符串/数组的其余缺口
  // 都是量出来的：split 的字符串分隔符形式 4 处（'/' 与 '\n'，都不带 limit），
  // parseInt(hex, 16) 2 处，Buffer.from(s, 'utf8') 1 处（backend-c 发字符串字面量），
  // Array.prototype.entries() 1 处（hir/check.js 的 params.entries()）。
  js_str_split: { js: '$js_str_split', c: 'omni_js_str_split', arity: 2 },
  js_utf8_bytes: { js: '$js_utf8_bytes', c: 'omni_js_utf8_bytes', arity: 1 },
  js_num_parse_int: { js: '$js_num_parse_int', c: 'omni_js_num_parse_int', arity: 2 },
  // parseFloat：与 Number(s) 不是一回事 —— 吃最长的合法前缀，后面有垃圾也不报错，
  // 而且**不认** 0x / Infinity 以外的那些 strtod 扩展（C 那份为此手划前缀再 strtod）。
  js_num_parse_float: { js: '$js_num_parse_float', c: 'omni_js_num_parse_float', arity: 1 },
  js_arr_entries: { js: '$js_arr_entries', c: 'omni_js_arr_entries', arity: 1 },

  // ------------------------------------------------- for-of 与 o[k]（lower.js 用）
  // iter：数组原样返回（下标迭代是活的），字符串按码点切，Map 给 [k,v]，Set 给元素。
  // idx_get/idx_set：o[k] 按接收者标签派发 —— 这不是"成员名"，进不了 JS_METHODS 表。
  js_iter: { js: '$js_iter', c: 'omni_js_iter', arity: 1 },
  js_idx_get: { js: '$js_idx_get', c: 'omni_js_idx_get', arity: 2 },
  js_idx_set: { js: '$js_idx_set', c: 'omni_js_idx_set', arity: 3 },

  // ---------------------------------------------------------------- node 宿主面
  // 只收"真的要问操作系统"的东西。path 的 join/dirname/basename/resolve/relative/
  // isAbsolute 是纯字符串计算，写在 src/core/host/path.js 里两个后端一起用 ——
  // 进 ABI 只会多出一处"宿主实现与我的实现是否逐字符一致"的分叉点。crypto 的
  // sha256 同理，不进 ABI。
  // 失败一律抛（和 node 的同步 API 一致），到 try/catch 落地时接进 pending-error 槽。
  js_fs_read_text: { js: '$js_fs_read_text', c: 'omni_js_fs_read_text', arity: 1 },
  js_fs_write_text: { js: '$js_fs_write_text', c: 'omni_js_fs_write_text', arity: 2 },
  js_fs_exists: { js: '$js_fs_exists', c: 'omni_js_fs_exists', arity: 1, ret: 'bool' },
  js_fs_readdir: { js: '$js_fs_readdir', c: 'omni_js_fs_readdir', arity: 1 },
  // 是不是目录（不存在也回 false）。走一遍文件系统而不是看名字：装好的那份里编译器
  // 自己就叫 `omni`，没有后缀 —— 靠"名字里有没有点"猜就会 readdir 一个普通文件。
  js_fs_is_dir: { js: '$js_fs_is_dir', c: 'omni_js_fs_is_dir', arity: 1, ret: 'bool' },
  js_fs_mtime_ms: { js: '$js_fs_mtime_ms', c: 'omni_js_fs_mtime_ms', arity: 1 },
  js_fs_size: { js: '$js_fs_size', c: 'omni_js_fs_size', arity: 1 },
  js_fs_mkdtemp: { js: '$js_fs_mkdtemp', c: 'omni_js_fs_mkdtemp', arity: 1 },
  js_fs_mkdir_all: { js: '$js_fs_mkdir_all', c: 'omni_js_fs_mkdir_all', arity: 1 },
  js_fs_rename: { js: '$js_fs_rename', c: 'omni_js_fs_rename', arity: 2 },
  js_fs_remove: { js: '$js_fs_remove', c: 'omni_js_fs_remove', arity: 1 },
  /* 字节口径那四条（ADR-0017 第八刀）：一个字符一个字节（node 侧是 latin1）。
   * 与 read_text/write_text/stdout_write 的区别只在**不编解码** —— 这条腿要写出
   * 可执行文件、要让 printf("%c", 0xff) 落一个 0xff 字节。 */
  js_fs_read_bytes: { js: '$js_fs_read_bytes', c: 'omni_js_fs_read_bytes', arity: 1 },
  js_fs_write_bytes: { js: '$js_fs_write_bytes', c: 'omni_js_fs_write_bytes', arity: 3 },
  js_proc_stdout_bytes: { js: '$js_proc_stdout_bytes', c: 'omni_js_proc_stdout_bytes', arity: 1 },
  js_proc_stderr_bytes: { js: '$js_proc_stderr_bytes', c: 'omni_js_proc_stderr_bytes', arity: 1 },
  /* i32 的运算三条（ADR-0013 第三刀）。进出都是**规范形的 int32**（一个 number）。
   * `op` 是运算符文本，与 `interp/builtin.js` 的 `binOp` 用的那一套字符串相同
   * （`+ - * / % u/ u% & | ^ << >> u>>`）—— 两处对不上就是两套语义。
   * 除零**不在 op 里查**：调用方先报那条运行期错误，两条腿的消息才逐字相同。 */
  js_i32_op: { js: '$js_i32_op', c: 'omni_js_i32_op', arity: 3 },
  js_i32_tou: { js: '$js_i32_tou', c: 'omni_js_i32_tou', arity: 1 },
  js_i32_wrap: { js: '$js_i32_wrap', c: 'omni_js_i32_wrap', arity: 1 },
  js_fs_realpath: { js: '$js_fs_realpath', c: 'omni_js_fs_realpath', arity: 1 },
  js_proc_args: { js: '$js_proc_args', c: 'omni_js_proc_args', arity: 0 },
  js_proc_cwd: { js: '$js_proc_cwd', c: 'omni_js_proc_cwd', arity: 0 },
  js_proc_env: { js: '$js_proc_env', c: 'omni_js_proc_env', arity: 1 },
  /* 写宿主的一格环境（与上一条成一对，ADR-0015）。为什么要有"写"：CLI 的 `-f svg`
   * 除了设自己进程里那一格，还要让 spawn 出去的 node / 链好的可执行文件都看见 ——
   * 子进程继承环境，所以设一次就够，产物本身不必记住格式。 */
  js_proc_set_env: { js: '$js_proc_set_env', c: 'omni_js_proc_set_env', arity: 2 },
  js_proc_stdout_write: { js: '$js_proc_stdout_write', c: 'omni_js_proc_stdout_write', arity: 1 },
  js_proc_stderr_write: { js: '$js_proc_stderr_write', c: 'omni_js_proc_stderr_write', arity: 1 },
  js_proc_exit_code: { js: '$js_proc_exit_code', c: 'omni_js_proc_exit_code', arity: 1 },
  js_proc_stdin_is_tty: { js: '$js_proc_stdin_is_tty', c: 'omni_js_proc_stdin_is_tty', arity: 0, ret: 'bool' },
  js_proc_read_line: { js: '$js_proc_read_line', c: 'omni_js_proc_read_line', arity: 0 },
  // 结果是 [status, stdout, stderr]；mode 'c' 全捕获 / 'o' stdout 直通 / 'i' 全直通
  js_proc_spawn: { js: '$js_proc_spawn', c: 'omni_js_proc_spawn', arity: 3 },
  /* 与上面那条的差别只有一格：**把第 4 个参数那段文本喂进子进程的 stdin**。
     刻意**另开一条**而不是给 `js_proc_spawn` 加参数 —— 那条有二十来个调用点，
     改签名就得二十处一起动，而封闭 ABI 上"改形状"比"多一条"贵得多。
     加它的理由是 ADR-0019 决策八：「IR 走 stdin，磁盘上一个字节都不写」。 */
  js_proc_spawn_in: { js: '$js_proc_spawn_in', c: 'omni_js_proc_spawn_in', arity: 4 },
  js_os_tmpdir: { js: '$js_os_tmpdir', c: 'omni_js_os_tmpdir', arity: 0 },
  // 墙上时钟毫秒。要计的是"这一步花了多久"，大头是子进程（clang、另一代编译器），
  // 所以必须是墙上时间而不是 CPU 时间。
  js_now_ms: { js: '$js_now_ms', c: 'omni_js_now_ms', arity: 0 },
  /* 一趟"跑"的墙上时限（`omni run --timeout`）：第一个参数是毫秒（<= 0 = 撤掉），
     第二个是到点要印的那句话 —— 印字的人不一定还是编译器自己（本进程那一路是看门狗
     线程 / SIGALRM 处理函数在印），所以文本得先交给宿主。
     为什么这一格非在宿主不可：`run` 的"跑"有两种形态，子进程那一路能靠 spawn 的时限，
     本进程那一路（`js_eval`、解释器）是同一根线程上的同步循环 —— 定时器一格都不转。 */
  js_run_timeout: { js: '$js_run_timeout', c: 'omni_js_run_timeout', arity: 2 },
  // 本地时间的日历字段，14 位数字 YYYYMMDDHHMMSS（见 host/native.js 的 localStamp）。
  // `__DATE__` / `__TIME__` 要它：六个字段得是同一个瞬间的，而排版归编译器。
  js_local_stamp: { js: '$js_local_stamp', c: 'omni_js_local_stamp', arity: 0 },
  js_install_dir: { js: '$js_install_dir', c: 'omni_js_install_dir', arity: 0 },
  // 宿主里跑一段生成的 JS。原生构建里没有 JS 引擎，C 侧只会报错（omni_js_host.c）——
  // 存在的理由是编译器自己的 `omni run` 与 REPL 要能降级，见 host/native.js 的说明。
  // captured 版把 stdout/stderr 收进字符串，结果是 [out, err, failed]。
  // has_engine 是"先问能力"：宿主的错误不是可以 catch 的异常，所以 `omni run` 必须先
  // 知道这一代有没有引擎，才能决定是进程内 eval 还是走 C 路径。
  js_has_engine: { js: '$js_has_engine', c: 'omni_js_has_engine', arity: 0, ret: 'bool' },
  // dynamic 的运行期标签名。解释器（ADR-0013）靠它认出一个 dynamic 里装的是什么 ——
  // `instanceof Map` 不在语言子集里（ADR-0011 决策 15），而 C 侧本来就有标签。
  js_type_tag: { js: '$js_type_tag', c: 'omni_js_type_tag', arity: 1 },
  // 按名字调一条 op：`js_call_op("js_arr_get", [xs, i])`。解释器（ADR-0013）唯一的出口 ——
  // 它拿到的 op 名字是运行期的值，而 op 调用在两个后端里都是编译期展开的。
  // 两个后端各自**按这张表生成**那个分派函数（emit.js 的 callOpDispatch），所以往表里加
  // 一条 op 自动就进了解释器，没有手抄 138 份包装的余地。
  js_call_op: { js: '$js_call_op', c: 'omni_js_call_op', arity: 2 },
  // 解释器造出来的函数值要能被宿主库那些回调 op 调（`xs.map(f)`），所以它必须**就是**
  // 这一代的闭包记录（ADR-0013 决策 3）。编译出来的两代里它本来就是，于是 wrap 是恒等；
  // 只有"在 node 上直接跑源码"那一代不是（那里它是个裸 JS 函数），由 native.js 补成记录。
  js_wrap_fn: { js: '$js_wrap_fn', c: 'omni_js_wrap_fn', arity: 1 },
  // 调一个函数值：实参是一条 list（JS 的函数在 Omni 里只有这一个签名，ADR-0011 第 1 节）。
  js_call_fn: { js: '$js_call_fn', c: 'omni_js_call_fn', arity: 2 },
  // real 的两种文本化。解释器不写第三份浮点格式化：在哪个宿主上就用那个宿主已有的那一份
  // （prelude 的 $fmt_real/$repr_real、runtime 的 omni_str_real/omni_repr_real），
  // 于是解释执行与编译执行打印出同一串字符是构造性的，不靠三份代码碰巧一致。
  js_fmt_real: { js: '$js_fmt_real', c: 'omni_js_fmt_real', arity: 1 },
  // 同上，但按 N 位有效数字 —— 核心方言的 `(tostr E N)` 在解释器上走这一条。
  js_fmt_real_g: { js: '$js_fmt_real_g', c: 'omni_js_fmt_real_g', arity: 2 },
  // `%f` / `%e` / `%g` 那三种排版：解释器上 `(sfix …)` / `(ssci …)` / `(sgen …)` 走它们。
  // `js_fmt_gen` 的第三个实参是"留不留尾随零"（`sgen` 与 `sgenk` 的分工）。
  js_fmt_fixed: { js: '$js_fmt_fixed', c: 'omni_js_fmt_fixed', arity: 2 },
  js_fmt_sci: { js: '$js_fmt_sci', c: 'omni_js_fmt_sci', arity: 2 },
  js_fmt_gen: { js: '$js_fmt_gen', c: 'omni_js_fmt_gen', arity: 3 },
  js_repr_real: { js: '$js_repr_real', c: 'omni_js_repr_real', arity: 1 },
  js_eval: { js: '$js_eval', c: 'omni_js_eval', arity: 1 },
  js_eval_captured: { js: '$js_eval_captured', c: 'omni_js_eval_captured', arity: 1 },

  // ------------------------------------------------- throw / try（ADR-0007 决定 1）
  // 只有一个"待处理错误"的槽：throw 往里放，可能出错的调用点之后 pending 查一下，
  // catch 用 take 取出并清空。跳转本身是 lower.js 发的普通控制流，不进 ABI。
  //
  // throws: true 的意思是"这个 op 可能往槽里放东西"，lower.js 据此决定要不要在语句
  // 后面插 pending 检查（ADR-0011 决策 14）。回调类的 op 全算 —— 用户的回调会抛。
  js_throw: { js: '$js_throw', c: 'omni_js_throw', arity: 1, throws: true },
  js_pending: { js: '$js_pending', c: 'omni_js_pending', arity: 0, ret: 'bool' },
  js_take_pending: { js: '$js_take_pending', c: 'omni_js_take_pending', arity: 0 },
  // 异常对象就是普通对象：{ $cls: [类名…], message }。is_a 查 $cls 链，不认的值给 false
  // （`e instanceof X` 里的 e 可能是任何被抛出来的东西，包括字符串）
  // new Error(msg, opts)（决策 15 + ADR-0020 P4）：cls 是 ["TypeError","Error"] 这样的
  // 链（js_is_a 顺着它认 catch 的类型），name 就是链头，opts 只看 cause 那一格。
  js_err_new: { js: '$js_err_new', c: 'omni_js_err_new', arity: 3 },
  js_is_a: { js: '$js_is_a', c: 'omni_js_is_a', arity: 2, ret: 'bool' },
};

/* ----------------------------------------- 成员派发（ADR-0011 第 9 节）
 * `x.length` / `x.push(v)` 的接收者是什么，静态不知道 —— 编译器源码里全是无标注的
 * JS。所以下面两张表写下"成员名 -> 每个标签用哪个 op"，两个后端各自**生成**一个
 * 按标签 switch 的派发函数，发射器里不出现任何成员名：
 *   属性 js_p_<名>(recv)          方法 js_m_<名>(recv, a0, ...)
 * 派发器的形参个数取各分支里最多的那个（缺席的实参由 lower.js 补 js_undef），
 * 每个分支只取自己需要的前几个。返回类型也从分支取：同名的所有分支必须一致。
 * 标签名与 omni_dyn_tag_name() / $dynTag() 逐字相同。
 *
 * 表里没有的成员名，落到派发器的 default 分支 —— 现在是当场报错；类实例的方法表
 * （ADR-0011 落地顺序 6c）将来接进来的位置就是那里。
 */
export const JS_TAG_C = {
  list: 'OMNI_DYN_LIST',
  string: 'OMNI_DYN_STR16',
  dict: 'OMNI_DYN_DICT',
  Map: 'OMNI_DYN_MAP',
  Set: 'OMNI_DYN_SET',
  real: 'OMNI_DYN_REAL',
  regexp: 'OMNI_DYN_RE',
  bytes: 'OMNI_DYN_BYTES',
  TextEncoder: 'OMNI_DYN_TEXTENC',
};

/** @type {Record<string, Record<string, string>>} */
export const JS_PROPS = {
  length: { list: 'js_arr_len', string: 'js_str_len', bytes: 'js_buf_len' },
  size: { Map: 'js_map_size', Set: 'js_set_size' },
  lastIndex: { regexp: 'js_re_last_index' },
  // ArrayBuffer 与 DataView 上都叫 byteLength；这一格里三者是同一种值，所以同一个 op
  byteLength: { bytes: 'js_buf_len' },
};
/** @type {Record<string, {on: Record<string, string>, lit?: Record<string, any>}>} */
export const JS_METHODS = {
  // String
  at: { on: { list: 'js_arr_at', string: 'js_str_at' } },
  // charAt 与 at 不是一回事：越界给空串、且不认负下标（规范 22.1.3.1）
  charAt: { on: { string: 'js_str_char_at' } },
  charCodeAt: { on: { string: 'js_str_char_code_at' } },
  codePointAt: { on: { string: 'js_str_code_point_at' } },
  repeat: { on: { string: 'js_str_repeat' } },
  padStart: { on: { string: 'js_str_pad_start' } },
  padEnd: { on: { string: 'js_str_pad_end' } },
  replaceAll: { on: { string: 'js_str_replace_all' } },
  trim: { on: { string: 'js_str_trim' }, lit: { side: 'b' } },
  trimStart: { on: { string: 'js_str_trim' }, lit: { side: 'l' } },
  trimEnd: { on: { string: 'js_str_trim' }, lit: { side: 'r' } },
  toLowerCase: { on: { string: 'js_str_lower' } },
  toUpperCase: { on: { string: 'js_str_upper' } },
  startsWith: { on: { string: 'js_str_starts_with' } },
  endsWith: { on: { string: 'js_str_ends_with' } },
  // 分隔符是字符串的那一支在这里；正则那一支由 lower.js 静态发成 js_re_split
  split: { on: { string: 'js_str_split' } },

  // 两种接收者都有的。形参个数取多的那支（string 的 indexOf 还带 from），
  // list 分支只吃前面几个
  slice: { on: { list: 'js_arr_slice', string: 'js_str_slice' } },
  indexOf: { on: { list: 'js_arr_index_of', string: 'js_str_index_of' } },
  lastIndexOf: { on: { list: 'js_arr_last_index_of', string: 'js_str_last_index_of' } },
  includes: { on: { list: 'js_arr_includes', string: 'js_str_includes' } },
  entries: { on: { list: 'js_arr_entries', Map: 'js_map_entries' } },

  // Array
  push: { on: { list: 'js_arr_push' } },
  pop: { on: { list: 'js_arr_pop' } },
  unshift: { on: { list: 'js_arr_unshift' } },
  concat: { on: { list: 'js_arr_concat' } },
  reverse: { on: { list: 'js_arr_reverse' } },
  fill: { on: { list: 'js_arr_fill', bytes: 'js_buf_fill' } },
  exec: { on: { regexp: 'js_re_exec' } },
  // 字节缓冲上的那几个（DataView / Uint8Array 的方法）
  getUint8: { on: { bytes: 'js_buf_get_u8' } },
  setUint8: { on: { bytes: 'js_buf_set_u8' } },
  // 定宽那一族走同一个 op，宽度在 lit 里（见 js_buf_getn 那一行的注释）
  getInt8: { on: { bytes: 'js_buf_getn' }, lit: { sel: 'b' } },
  setInt8: { on: { bytes: 'js_buf_setn' }, lit: { sel: 'b' } },
  getInt16: { on: { bytes: 'js_buf_getn' }, lit: { sel: 'h' } },
  setInt16: { on: { bytes: 'js_buf_setn' }, lit: { sel: 'h' } },
  getUint16: { on: { bytes: 'js_buf_getn' }, lit: { sel: 'H' } },
  setUint16: { on: { bytes: 'js_buf_setn' }, lit: { sel: 'H' } },
  getInt32: { on: { bytes: 'js_buf_getn' }, lit: { sel: 'i' } },
  setInt32: { on: { bytes: 'js_buf_setn' }, lit: { sel: 'i' } },
  getUint32: { on: { bytes: 'js_buf_getn' }, lit: { sel: 'I' } },
  setUint32: { on: { bytes: 'js_buf_setn' }, lit: { sel: 'I' } },
  getFloat32: { on: { bytes: 'js_buf_getn' }, lit: { sel: 'f' } },
  setFloat32: { on: { bytes: 'js_buf_setn' }, lit: { sel: 'f' } },
  getBigInt64: { on: { bytes: 'js_buf_get_i64' } },
  setBigInt64: { on: { bytes: 'js_buf_set_i64' } },
  getFloat64: { on: { bytes: 'js_buf_get_f64' } },
  setFloat64: { on: { bytes: 'js_buf_set_f64' } },
  encode: { on: { TextEncoder: 'js_text_encode' } },
  join: { on: { list: 'js_arr_join' } },
  map: { on: { list: 'js_arr_map' } },
  filter: { on: { list: 'js_arr_filter' } },
  forEach: { on: { list: 'js_arr_for_each' } },
  some: { on: { list: 'js_arr_some' } },
  every: { on: { list: 'js_arr_every' } },
  find: { on: { list: 'js_arr_find' } },
  findIndex: { on: { list: 'js_arr_find_index' } },
  reduce: { on: { list: 'js_arr_reduce' } },
  reduceRight: { on: { list: 'js_arr_reduce_right' } },
  flat: { on: { list: 'js_arr_flat' } },
  flatMap: { on: { list: 'js_arr_flat_map' } },
  sort: { on: { list: 'js_arr_sort' } },
  toSorted: { on: { list: 'js_arr_to_sorted' } },

  // Map / Set
  get: { on: { Map: 'js_map_get' } },
  set: { on: { Map: 'js_map_set', bytes: 'js_buf_set' } },
  add: { on: { Set: 'js_set_add' } },
  has: { on: { Map: 'js_map_has', Set: 'js_set_has' } },
  delete: { on: { Map: 'js_map_delete', Set: 'js_set_delete' } },
  keys: { on: { Map: 'js_map_keys' } },
  values: { on: { Map: 'js_map_values' } },

  // Number
  toString: { on: { real: 'js_num_to_string' } },
  toPrecision: { on: { real: 'js_num_to_precision' } },
};
/* ADR-0020 P1 那一族（真对象 / Symbol / 迭代器协议）**现在只有 JS 侧的实现**。
 * 名字列在这一处清单里，`noC` 由下面这几行打上 —— 一处清单胜过四十行里各写一遍，
 * 而且 C 侧补齐之后只删一段。
 *
 * 谁看这一位：`backend-c/emit.js` 生成 `omni_js_call_op` 那张按名字派发的表时跳过它们
 * （不然生成的 C 引用一堆还不存在的 `omni_js_*`，`tests/oir` 立刻红）。于是"两边还没齐"
 * 这件事是**机器可见**的，不是注释里的一句承诺。
 *
 * 代价写在明处：这一族 op 现在只在 node 宿主（JS 后端与解释器）上成立。降级器一旦开始
 * 发它们，C 那条腿上的 JS 程序就会在链接期缺符号 —— 所以 C 孪生必须在"降级器翻过去"
 * 之前落地（ADR-0020 的 P1-c）。 */
const P1_JS_ONLY = [
  'js_obj_new_p', 'js_obj_proto_get', 'js_obj_proto_set', 'js_getp', 'js_setp',
  'js_obj_has_p', 'js_obj_del_p', 'js_obj_has_own', 'js_obj_def', 'js_obj_desc',
  'js_obj_own_keys', 'js_obj_freeze', 'js_obj_seal', 'js_obj_prevent_ext',
  'js_obj_is_frozen', 'js_obj_is_sealed', 'js_obj_is_ext', 'js_obj_to_string',
  'js_obj_from_entries',
  'js_instanceof', 'js_to_prim', 'js_iter_proto', 'js_iter_next', 'js_for_in_keys',
  'js_sym_new', 'js_sym_for', 'js_sym_key_for', 'js_sym_desc', 'js_sym_str',
  'js_sym_wk', 'js_realm_proto', 'js_global_this', 'js_date_new', 'js_proxy_new',
  'js_promise_new', 'js_promise_resolved', 'js_promise_rejected', 'js_promise_all',
  'js_jobs_run',
];
for (const n of P1_JS_ONLY) JS_ABI[n].noC = true;

/* 派生：把上面两张表摊成和 JS_ABI 同形的条目（多一个 member 字段给生成器用），
 * 发射器查 op 名字时两张表合起来看。表写错了在这里就炸，不用等 C 编译器。 */
export const JS_MEMBERS = {};

function abiOf(op) {
  const abi = JS_ABI[op];
  if (!abi) throw new Error(`js_abi: 成员表引用了表外的 op ${op}`);
  return abi;
}
function retOf(name, on) {
  // void 的分支（forEach）在派发器里返回 undefined，所以按 dyn 算
  const rets = new Set(Object.values(on).map((op) => (abiOf(op).ret === 'bool' ? 'bool' : 'dyn')));
  if (rets.size !== 1) throw new Error(`js_abi: 成员 ${name} 各分支的返回类型不一致`);
  return [...rets][0];
}
for (const [name, on] of Object.entries(JS_PROPS)) {
  for (const op of Object.values(on)) {
    if (abiOf(op).arity !== 1) throw new Error(`js_abi: 属性 ${name} 的 ${op} 不是一元的`);
  }
  JS_MEMBERS[`js_p_${name}`] = {
    js: `$js_p_${name}`, c: `omni_js_p_${name}`, arity: 1, ret: retOf(name, on),
    member: { kind: 'prop', name, on, argc: 0 },
  };
}
for (const [name, m] of Object.entries(JS_METHODS)) {
  // 派发器的形参个数 = 各标签里最大的那个（Math.max(...arr) 的展开不在语言子集里）
  let argc = 0;
  for (const op of Object.values(m.on)) {
    const a = abiOf(op).arity - 1;
    if (a > argc) argc = a;
  }
  JS_MEMBERS[`js_m_${name}`] = {
    js: `$js_m_${name}`, c: `omni_js_m_${name}`, arity: 1 + argc, ret: retOf(name, m.on),
    member: { kind: 'method', name, on: m.on, lit: m.lit, argc },
  };
}

/** 发射器认的全部 op：ABI 表 + 生成出来的成员派发器 */
export const JS_ALL = { ...JS_ABI, ...JS_MEMBERS };

