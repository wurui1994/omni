/*
 * Omni — N-API 的声明，**我们自己那一份**（ADR-0038）
 *
 * 为什么不 `#include <node_api.h>`：那份头文件在 `node-api-headers` / `node-gyp` 那些包里，
 * 而这条路要的是"不外挂"。N-API 是一份**稳定 ABI**（node 自己的兼容承诺），符号在装载时
 * 从 node 的可执行文件里解出来 —— 所以这一侧要的只有"函数长什么样"，而那是可以照着
 * ABI 抄一遍的。抄错的代价也是可见的：类型对不上当场是一次崩溃或一个错值，不是静默的。
 *
 * 只写**用得到的那几条**（ADR-0038 的值表那一节），一条不多：这份头文件的身份是
 * "那道门的宽度"，多写一条就是多一格没人验过的约定。
 *
 * 不透明类型照 N-API 自己的做法（`struct napi_env__ *`）：这一侧不碰它们的内部。
 *
 * 装载那一侧要的两件事：
 *   - 导出一个 `napi_register_module_v1(env, exports)` —— node 按这个名字找入口；
 *   - 链接时 macOS 上要 `-undefined dynamic_lookup`（符号在宿主进程里，不在任何库里），
 *     ELF 上默认就允许未定义符号，什么都不用加。
 */

#ifndef OMNI_NAPI_H
#define OMNI_NAPI_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;

/* `napi_ok` 是 0；别的码这一侧不分类（出错就是出错，报的是"第几个实参取不出来"）。 */
typedef int napi_status;
#define omni_napi_ok 0

typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);

/* ---- 取实参与回值 ---- */
extern napi_status napi_get_cb_info(napi_env env, napi_callback_info info, size_t *argc,
                                   napi_value *argv, napi_value *this_arg, void **data);
extern napi_status napi_get_undefined(napi_env env, napi_value *result);
extern napi_status napi_get_boolean(napi_env env, bool value, napi_value *result);

/* ---- 标量：进 ---- */
extern napi_status napi_get_value_double(napi_env env, napi_value value, double *result);
extern napi_status napi_get_value_int32(napi_env env, napi_value value, int32_t *result);
extern napi_status napi_get_value_bool(napi_env env, napi_value value, bool *result);
extern napi_status napi_get_value_bigint_int64(napi_env env, napi_value value,
                                              int64_t *result, bool *lossless);

/* ---- 标量：出 ---- */
extern napi_status napi_create_double(napi_env env, double value, napi_value *result);
extern napi_status napi_create_int32(napi_env env, int32_t value, napi_value *result);
extern napi_status napi_create_bigint_int64(napi_env env, int64_t value, napi_value *result);

/* ---- 串（kinds 串与出错的消息用；C 实参里的串走 arena，不走这儿） ---- */
extern napi_status napi_get_value_string_utf8(napi_env env, napi_value value, char *buf,
                                             size_t bufsize, size_t *result);

/* ---- arena 的真地址（ADR-0038 第二条约定） ---- */
extern napi_status napi_get_arraybuffer_info(napi_env env, napi_value arraybuffer,
                                            void **data, size_t *byte_length);

/* ---- 注入那条路要的三条（ADR-0038 第二刀）：造个对象、把一块**我们自己的内存**
       包成 ArrayBuffer 交给 JS 直接写（零拷贝）、以及取一格 int64。 ---- */
typedef void (*napi_finalize)(napi_env env, void *data, void *hint);
extern napi_status napi_create_object(napi_env env, napi_value *result);
extern napi_status napi_create_external_arraybuffer(napi_env env, void *external_data,
                                                    size_t byte_length, napi_finalize finalize_cb,
                                                    void *finalize_hint, napi_value *result);
extern napi_status napi_get_value_int64(napi_env env, napi_value value, int64_t *result);

/* ---- 建那几格导出的函数 ---- */
extern napi_status napi_create_function(napi_env env, const char *utf8name, size_t length,
                                        napi_callback cb, void *data, napi_value *result);
extern napi_status napi_set_named_property(napi_env env, napi_value object,
                                           const char *utf8name, napi_value value);

/* ---- 报错（抛一个 JS 的 Error 出去，与别处的诊断同一个出口） ---- */
extern napi_status napi_throw_error(napi_env env, const char *code, const char *msg);

#endif /* OMNI_NAPI_H */
