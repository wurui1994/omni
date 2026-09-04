/* node 宿主面里"结果是数组"的那几个（ADR-0011 落地顺序第 4 步）
 *
 * 本体在 omni_js_host.c；这里只放 readdir / argv / spawnSync 三个，理由和
 * omni_js_arr.h 一样：它们要造 list<dynamic>，而 list<dynamic> 是生成 TU 里的宏实例。
 * 必须在 OMNI_JS_ARR 之后展开（用它的 omni_js_arr_wrap）。
 *
 * spawnSync 的结果没有做成对象，而是三元数组 [status, stdout, stderr]：
 * 量过的四处调用只读这三个字段，做成 dict 还要多一层键的字符串化。
 *
 * 注意宏体里**每一行**都得有行尾反斜杠，注释行也要（反斜杠续行发生在删注释之前），
 * 所以解释一律写在 #define 外面。
 */
#ifndef OMNI_JS_HOST_H
#define OMNI_JS_HOST_H

#define OMNI_JS_HOST(LT, DT) \
static omni_dyn omni_js_fs_readdir(omni_dyn path) { \
  void *d = omni_host_dir_open(path); \
  LT out = LT##_new(); \
  for (;;) { \
    const char *name = omni_host_dir_next(d); \
    if (!name) break; \
    LT##_push(out, omni_host_str_of_cstr(name)); \
  } \
  omni_host_dir_close(d); \
  return omni_js_arr_wrap(out); \
} \
static omni_dyn omni_js_proc_args(void) { \
  int n = omni_host_user_argc(); \
  LT out = LT##_new(); \
  LT##_reserve(out, n); \
  for (int i = 0; i < n; i++) out->items[i] = omni_host_str_of_cstr(omni_host_user_arg(i)); \
  out->len = n; \
  return omni_js_arr_wrap(out); \
} \
/* 两个入口共用的那一段。`inp` 非 NULL 就喂进子进程的 stdin。 */ \
static omni_dyn omni_js_spawn_core(omni_dyn cmd, omni_dyn args, omni_dyn mode, const char *inp) { \
  LT a = omni_js_arr_of(args); \
  char **argv = (char **)omni_alloc((size_t)(a->len + 2) * sizeof(char *)); \
  omni_str c = omni_s16_to_utf8(omni_js_as_s16(cmd)); \
  argv[0] = omni_cstr(c); \
  for (int64_t i = 0; i < a->len; i++) { \
    argv[i + 1] = omni_cstr(omni_s16_to_utf8(omni_js_as_s16(a->items[i]))); \
  } \
  argv[a->len + 1] = NULL; \
  omni_s16 m = omni_js_as_s16(mode); \
  if (m.len != 1) omni_error("spawn mode must be one of 'c' / 'o' / 'i'"); \
  omni_str out, err; \
  int status = omni_host_spawn(argv[0], argv, (int)m.p[0], inp, &out, &err); \
  LT r = LT##_new(); \
  LT##_reserve(r, 3); \
  r->items[0] = omni_dyn_of_real((double)status); \
  r->items[1] = omni_dyn_of_s16(omni_s16_of_utf8(out)); \
  r->items[2] = omni_dyn_of_s16(omni_s16_of_utf8(err)); \
  r->len = 3; \
  return omni_js_arr_wrap(r); \
} \
static omni_dyn omni_js_proc_spawn(omni_dyn cmd, omni_dyn args, omni_dyn mode) { \
  return omni_js_spawn_core(cmd, args, mode, NULL); \
} \
/* 第 4 个参数**总是一段字符串**：空串 = 不喂（照旧 /dev/null 或继承）。刻意不收 */ \
/* `undefined` —— 那要一个"这个 dyn 是不是 undefined"的判据，收空串就是纯数据。 */ \
static omni_dyn omni_js_proc_spawn_in(omni_dyn cmd, omni_dyn args, omni_dyn mode, omni_dyn input) { \
  omni_str ins = omni_s16_to_utf8(omni_js_as_s16(input)); \
  return omni_js_spawn_core(cmd, args, mode, ins.len == 0 ? NULL : omni_cstr(ins)); \
}

#endif /* OMNI_JS_HOST_H */
