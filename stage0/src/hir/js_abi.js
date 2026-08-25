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
  js_asFn: { js: '$js_asFn', c: 'omni_js_as_fn', arity: 1 },
  js_truthy: { js: '$js_truthy', c: 'omni_js_truthy', arity: 1, ret: 'bool' },
  js_typeof: { js: '$js_typeof', c: 'omni_js_typeof', arity: 1 },
  js_str: { js: '$js_str', c: 'omni_js_str', arity: 1 },
  js_add: { js: '$js_add', c: 'omni_js_add', arity: 2 },
  js_neg: { js: '$js_neg', c: 'omni_js_neg', arity: 1 },
  js_arith: { js: '$js_arith', c: 'omni_js_arith', arity: 2, lit: ['op'] },
  js_bitop: { js: '$js_bitop', c: 'omni_js_bitop', arity: 2, lit: ['op'] },
  js_bitnot: { js: '$js_bitnot', c: 'omni_js_bitnot', arity: 1 },
  js_cmp: { js: '$js_cmp', c: 'omni_js_cmp', arity: 2, lit: ['op'], ret: 'bool' },
  js_eq: { js: '$js_eq', c: 'omni_js_eq', arity: 2, lit: ['strict'], ret: 'bool' },

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
  js_str_includes: { js: '$js_str_includes', c: 'omni_js_str_includes', arity: 2, ret: 'bool' },
  js_str_starts_with: { js: '$js_str_starts_with', c: 'omni_js_str_starts_with', arity: 3, ret: 'bool' },
  js_str_ends_with: { js: '$js_str_ends_with', c: 'omni_js_str_ends_with', arity: 2, ret: 'bool' },
  js_str_of_char_code: { js: '$js_str_of_char_code', c: 'omni_js_str_of_char_code', arity: 1 },
  js_str_of_code_point: { js: '$js_str_of_code_point', c: 'omni_js_str_of_code_point', arity: 1 },

  // ---------------------------------------------------------------- Array
  // JS 的 Array 就是 list<dynamic>。length 与下标是 Number（real），不是 int。
  // 这一批在 C 侧长在宏里（runtime/omni_js_arr.h）—— 运行时的 .c 看不见容器实例。
  js_arr_new: { js: '$js_arr_new', c: 'omni_js_arr_new', arity: 0 },
  js_arr_len: { js: '$js_arr_len', c: 'omni_js_arr_len', arity: 1 },
  js_arr_get: { js: '$js_arr_get', c: 'omni_js_arr_get', arity: 2 },
  js_arr_set: { js: '$js_arr_set', c: 'omni_js_arr_set', arity: 3, ret: 'void' },
  js_arr_push: { js: '$js_arr_push', c: 'omni_js_arr_push', arity: 2 },
  // a.push(x, ...ys)：实参拼成一个 list 整段追加（定长的 op 表达不了可变实参）
  js_arr_push_all: { js: '$js_arr_push_all', c: 'omni_js_arr_push_all', arity: 2 },
  js_arr_pop: { js: '$js_arr_pop', c: 'omni_js_arr_pop', arity: 1 },
  js_arr_slice: { js: '$js_arr_slice', c: 'omni_js_arr_slice', arity: 3 },
  js_arr_concat: { js: '$js_arr_concat', c: 'omni_js_arr_concat', arity: 2 },
  js_arr_reverse: { js: '$js_arr_reverse', c: 'omni_js_arr_reverse', arity: 1 },
  js_arr_fill: { js: '$js_arr_fill', c: 'omni_js_arr_fill', arity: 2 },
  js_arr_is_array: { js: '$js_arr_is_array', c: 'omni_js_arr_is_array', arity: 1, ret: 'bool' },
  js_arr_from: { js: '$js_arr_from', c: 'omni_js_arr_from', arity: 1 },
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
  // new Map(pairs) / new Set(items)：初值只收 list，缺参数就是空容器
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
  js_num_to_precision: { js: '$js_num_to_precision', c: 'omni_js_num_to_precision', arity: 2 },
  js_num_to_string: { js: '$js_num_to_string', c: 'omni_js_num_to_string', arity: 2 },
  // op: 'a' abs / 't' trunc / 'f' floor / 'c' ceil / 'M' max / 'm' min
  js_math: { js: '$js_math', c: 'omni_js_math', arity: 2, lit: ['op'] },

  // ---------------------------------------------------------------- JSON
  // 只有 stringify：量过一遍，JSON.parse 全仓库 0 处用到，封闭的 ABI 就不收它。
  // 实参形态也是量出来的 —— 绝大多数是一个实参给字符串加引号，只有 cli 的 dump
  // 用了 (v, replacer, 2)。replacer 只支持函数形式。
  js_json_stringify: { js: '$js_json_stringify', c: 'omni_js_json_stringify', arity: 3, throws: true },

  // ---------------------------------------------------------------- RegExp
  // 模式与 flags 是普通的 string 实参（不是 lit）：两侧都按字面量做编译缓存，C 侧的键
  // 就是字面量指针，JS 侧是 "模式\0flags"。仓库里的正则全是字面量，而且没有一处读写
  // lastIndex（量过：所有 .test 的正则都不带 g），所以这一层不需要 RegExp 对象。
  js_re_test: { js: '$js_re_test', c: 'omni_js_re_test', arity: 3, ret: 'bool' },
  js_re_match: { js: '$js_re_match', c: 'omni_js_re_match', arity: 3 },
  js_re_split: { js: '$js_re_split', c: 'omni_js_re_split', arity: 4 },
  js_re_replace: { js: '$js_re_replace', c: 'omni_js_re_replace', arity: 4, throws: true },

  // -------------------------------------------------- 字符串/数组的其余缺口
  // 都是量出来的：split 的字符串分隔符形式 4 处（'/' 与 '\n'，都不带 limit），
  // parseInt(hex, 16) 2 处，Buffer.from(s, 'utf8') 1 处（backend-c 发字符串字面量），
  // Array.prototype.entries() 1 处（hir/check.js 的 params.entries()）。
  js_str_split: { js: '$js_str_split', c: 'omni_js_str_split', arity: 2 },
  js_utf8_bytes: { js: '$js_utf8_bytes', c: 'omni_js_utf8_bytes', arity: 1 },
  js_num_parse_int: { js: '$js_num_parse_int', c: 'omni_js_num_parse_int', arity: 2 },
  js_arr_entries: { js: '$js_arr_entries', c: 'omni_js_arr_entries', arity: 1 },

  // ------------------------------------------------- for-of 与 o[k]（lower.js 用）
  // iter：数组原样返回（下标迭代是活的），字符串按码点切，Map 给 [k,v]，Set 给元素。
  // idx_get/idx_set：o[k] 按接收者标签派发 —— 这不是"成员名"，进不了 JS_METHODS 表。
  js_iter: { js: '$js_iter', c: 'omni_js_iter', arity: 1 },
  js_idx_get: { js: '$js_idx_get', c: 'omni_js_idx_get', arity: 2 },
  js_idx_set: { js: '$js_idx_set', c: 'omni_js_idx_set', arity: 3 },

  // ---------------------------------------------------------------- node 宿主面
  // 只收"真的要问操作系统"的东西。path 的 join/dirname/basename/resolve/relative/
  // isAbsolute 是纯字符串计算，写在 stage0/src/host/path.js 里两个后端一起用 ——
  // 进 ABI 只会多出一处"宿主实现与我的实现是否逐字符一致"的分叉点。crypto 的
  // sha256 同理，不进 ABI。
  // 失败一律抛（和 node 的同步 API 一致），到 try/catch 落地时接进 pending-error 槽。
  js_fs_read_text: { js: '$js_fs_read_text', c: 'omni_js_fs_read_text', arity: 1 },
  js_fs_write_text: { js: '$js_fs_write_text', c: 'omni_js_fs_write_text', arity: 2 },
  js_fs_exists: { js: '$js_fs_exists', c: 'omni_js_fs_exists', arity: 1, ret: 'bool' },
  js_fs_readdir: { js: '$js_fs_readdir', c: 'omni_js_fs_readdir', arity: 1 },
  js_fs_mtime_ms: { js: '$js_fs_mtime_ms', c: 'omni_js_fs_mtime_ms', arity: 1 },
  js_fs_size: { js: '$js_fs_size', c: 'omni_js_fs_size', arity: 1 },
  js_fs_mkdtemp: { js: '$js_fs_mkdtemp', c: 'omni_js_fs_mkdtemp', arity: 1 },
  js_fs_rename: { js: '$js_fs_rename', c: 'omni_js_fs_rename', arity: 2 },
  js_fs_realpath: { js: '$js_fs_realpath', c: 'omni_js_fs_realpath', arity: 1 },
  js_proc_args: { js: '$js_proc_args', c: 'omni_js_proc_args', arity: 0 },
  js_proc_cwd: { js: '$js_proc_cwd', c: 'omni_js_proc_cwd', arity: 0 },
  js_proc_env: { js: '$js_proc_env', c: 'omni_js_proc_env', arity: 1 },
  js_proc_stdout_write: { js: '$js_proc_stdout_write', c: 'omni_js_proc_stdout_write', arity: 1 },
  js_proc_stderr_write: { js: '$js_proc_stderr_write', c: 'omni_js_proc_stderr_write', arity: 1 },
  js_proc_exit_code: { js: '$js_proc_exit_code', c: 'omni_js_proc_exit_code', arity: 1 },
  js_proc_stdin_is_tty: { js: '$js_proc_stdin_is_tty', c: 'omni_js_proc_stdin_is_tty', arity: 0, ret: 'bool' },
  js_proc_read_line: { js: '$js_proc_read_line', c: 'omni_js_proc_read_line', arity: 0 },
  // 结果是 [status, stdout, stderr]；mode 'c' 全捕获 / 'o' stdout 直通 / 'i' 全直通
  js_proc_spawn: { js: '$js_proc_spawn', c: 'omni_js_proc_spawn', arity: 3 },
  js_os_tmpdir: { js: '$js_os_tmpdir', c: 'omni_js_os_tmpdir', arity: 0 },
  js_install_dir: { js: '$js_install_dir', c: 'omni_js_install_dir', arity: 0 },
  // 宿主里跑一段生成的 JS。原生构建里没有 JS 引擎，C 侧只会报错（omni_js_host.c）——
  // 存在的理由是编译器自己的 `omni run` 与 REPL 要能降级，见 host/native.js 的说明。
  // captured 版把 stdout/stderr 收进字符串，结果是 [out, err, failed]。
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
  js_err_new: { js: '$js_err_new', c: 'omni_js_err_new', arity: 2 },
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
};

/** @type {Record<string, Record<string, string>>} */
export const JS_PROPS = {
  length: { list: 'js_arr_len', string: 'js_str_len' },
  size: { Map: 'js_map_size', Set: 'js_set_size' },
};
/** @type {Record<string, {on: Record<string, string>, lit?: Record<string, any>}>} */
export const JS_METHODS = {
  // String
  at: { on: { string: 'js_str_at' } },
  charCodeAt: { on: { string: 'js_str_char_code_at' } },
  codePointAt: { on: { string: 'js_str_code_point_at' } },
  repeat: { on: { string: 'js_str_repeat' } },
  padStart: { on: { string: 'js_str_pad_start' } },
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
  concat: { on: { list: 'js_arr_concat' } },
  reverse: { on: { list: 'js_arr_reverse' } },
  fill: { on: { list: 'js_arr_fill' } },
  join: { on: { list: 'js_arr_join' } },
  map: { on: { list: 'js_arr_map' } },
  filter: { on: { list: 'js_arr_filter' } },
  forEach: { on: { list: 'js_arr_for_each' } },
  some: { on: { list: 'js_arr_some' } },
  every: { on: { list: 'js_arr_every' } },
  find: { on: { list: 'js_arr_find' } },
  findIndex: { on: { list: 'js_arr_find_index' } },
  reduce: { on: { list: 'js_arr_reduce' } },
  flatMap: { on: { list: 'js_arr_flat_map' } },
  sort: { on: { list: 'js_arr_sort' } },

  // Map / Set
  get: { on: { Map: 'js_map_get' } },
  set: { on: { Map: 'js_map_set' } },
  add: { on: { Set: 'js_set_add' } },
  has: { on: { Map: 'js_map_has', Set: 'js_set_has' } },
  delete: { on: { Map: 'js_map_delete', Set: 'js_set_delete' } },
  keys: { on: { Map: 'js_map_keys' } },
  values: { on: { Map: 'js_map_values' } },

  // Number
  toString: { on: { real: 'js_num_to_string' } },
  toPrecision: { on: { real: 'js_num_to_precision' } },
};
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

