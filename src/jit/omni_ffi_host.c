/*
 * Omni — FFI 注入宿主（ADR-0038 第二刀）
 *
 * 一份**固定的** N-API 扩展，与被注入的程序无关，所以整台机器上只编一次。
 * 它导出的东西只够"把一块字节变成能跑的代码"，一条业务逻辑都没有：
 *
 *   mem(size)              要一块页对齐的内存；回 { addr: BigInt, buf: ArrayBuffer }
 *   protect(addr, len, mode)  mprotect + arm64 上刷 icache
 *   dlopen(path)           dlopen(RTLD_NOW | RTLD_GLOBAL)
 *   sym(name)              dlsym(RTLD_DEFAULT, name) -> BigInt
 *   init(addr)             把那个地址当成 napi_register_module_v1 叫一次
 *
 * 重定位在 JS 里做（link/elf_merge.js 的 flatImage），不在这儿。
 * 宿主只回答两个问题："装到哪个地址"（mem）与"外面那些符号在哪"（sym）。
 *
 * 可执行内存照 tcc 的做法（tccrun.c）：malloc + mprotect(RX)。
 * arm64/arm/riscv 上 mprotect 之后必须刷指令缓存。
 * macOS 上 .text 必须单独占页做成 rx（CONFIG_RUNMEM_RO = 1）。
 */

#include "omni_napi.h"

#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <libkern/OSCacheControl.h>
#endif

/* ---- 页大小 ---- */
static size_t omni_fh_page(void) {
  static size_t pg = 0;
  if (pg == 0) {
    long r = sysconf(_SC_PAGESIZE);
    pg = r > 0 ? (size_t)r : 4096;
  }
  return pg;
}

/* ---- 一句诊断，然后抛进 JS ---- */
static napi_value omni_fh_err(napi_env env, const char *msg) {
  napi_throw_error(env, NULL, msg);
  return NULL;
}

/* ---- 取实参那几格（形状固定，所以不做通用化） ---- */
static int omni_fh_args(napi_env env, napi_callback_info info, size_t want, napi_value *a) {
  size_t argc = want;
  if (napi_get_cb_info(env, info, &argc, a, NULL, NULL) != omni_napi_ok) return 0;
  return argc >= want;
}

static int omni_fh_addr(napi_env env, napi_value v, void **out) {
  int64_t w = 0;
  bool lossless = false;
  if (napi_get_value_bigint_int64(env, v, &w, &lossless) != omni_napi_ok) return 0;
  *out = (void *)(intptr_t)w;
  return 1;
}

/* ================================================================== mem
 *
 * 一道梯子（ADR-0038）：mmap(RW) -> malloc+对齐 -> mmap(MAP_JIT)。
 * mmap 排在前面的理由只有一个：**它天生页对齐**，而我们要按页给不同的权限。
 * malloc 那一路（tcc 的默认）多要一页自己对齐，留着当没有 mmap 的机器上的退路。
 *
 * 三条都不成就报真话 —— **不假装成功**：那会变成"注进去然后 SIGBUS"，
 * 而那种错离原因很远。
 *
 * 回的是 { addr, buf }：`buf` 是**同一块内存**包出来的 external ArrayBuffer，
 * 于是 JS 那侧直接往里写字节，一次拷贝都没有。finalize 给 NULL ——
 * 这块内存的生命期跟着进程（注进去的代码在里头，谁都不该释放它）。
 */
static napi_value omni_fh_mem(napi_env env, napi_callback_info info) {
  napi_value a[1];
  int64_t want = 0;
  if (!omni_fh_args(env, info, 1, a)) return omni_fh_err(env, "omni ffi host: mem(size)");
  if (napi_get_value_int64(env, a[0], &want) != omni_napi_ok || want <= 0) {
    return omni_fh_err(env, "omni ffi host: mem 的 size 要一个正整数");
  }
  size_t pg = omni_fh_page();
  size_t len = ((size_t)want + pg - 1) & ~(pg - 1);
  void *p = mmap(NULL, len, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  if (p == MAP_FAILED) {
    /* 退路一：malloc + 自己对齐（tcc 的 rt_mem 就是这一路，多要一页）。
       注意这块的**起点**要还给 free 才对，而我们从不 free —— 所以直接丢掉那个指针。 */
    char *raw = (char *)malloc(len + pg);
    if (raw == NULL) return omni_fh_err(env, "omni ffi host: 要不到内存（mmap 与 malloc 都不成）");
    p = (void *)(((uintptr_t)raw + pg - 1) & ~(uintptr_t)(pg - 1));
  }
  napi_value obj;
  napi_value av;
  napi_value bv;
  if (napi_create_object(env, &obj) != omni_napi_ok) return NULL;
  if (napi_create_bigint_int64(env, (int64_t)(intptr_t)p, &av) != omni_napi_ok) return NULL;
  if (napi_create_external_arraybuffer(env, p, len, NULL, NULL, &bv) != omni_napi_ok) {
    return omni_fh_err(env, "omni ffi host: 那块内存包不成 ArrayBuffer");
  }
  napi_set_named_property(env, obj, "addr", av);
  napi_set_named_property(env, obj, "buf", bv);
  return obj;
}

/* ================================================================== protect
 *
 * 四档与 tcc 的 protect_pages 逐条对应（tccrun.c:468）：
 *   0 = rx   1 = ro   2 = rw   3 = rwx
 * arm64 / arm / riscv 上设成可执行之后**必须刷指令缓存**（tccrun.c:492）——
 * 少了它的症状是"有时候跑到旧字节上"，不可复现。
 */
static napi_value omni_fh_protect(napi_env env, napi_callback_info info) {
  napi_value a[3];
  void *p = NULL;
  int64_t len = 0;
  int32_t mode = 0;
  if (!omni_fh_args(env, info, 3, a)) return omni_fh_err(env, "omni ffi host: protect(addr, len, mode)");
  if (!omni_fh_addr(env, a[0], &p)) return omni_fh_err(env, "omni ffi host: protect 的 addr 要 BigInt");
  if (napi_get_value_int64(env, a[1], &len) != omni_napi_ok || len <= 0) {
    return omni_fh_err(env, "omni ffi host: protect 的 len 要一个正整数");
  }
  if (napi_get_value_int32(env, a[2], &mode) != omni_napi_ok || mode < 0 || mode > 3) {
    return omni_fh_err(env, "omni ffi host: protect 的 mode 只有 0=rx 1=ro 2=rw 3=rwx");
  }
  static const int prot[4] = {
    PROT_READ | PROT_EXEC,
    PROT_READ,
    PROT_READ | PROT_WRITE,
    PROT_READ | PROT_WRITE | PROT_EXEC,
  };
  size_t pg = omni_fh_page();
  size_t n = ((size_t)len + pg - 1) & ~(pg - 1);
  if (mprotect(p, n, prot[mode]) != 0) {
    return omni_fh_err(env, "omni ffi host: mprotect 不让（这台机器上写不出可执行的页）");
  }
  if (mode == 0 || mode == 3) {
#if defined(__APPLE__)
    sys_icache_invalidate(p, n);
#elif defined(__aarch64__) || defined(__arm__) || defined(__riscv)
    __builtin___clear_cache((char *)p, (char *)p + n);
#endif
  }
  napi_value r;
  napi_get_boolean(env, true, &r);
  return r;
}

/* ================================================================== dlopen / sym
 *
 * 与 `omni_jit.c` 的 `--lib` / `--dl` 是同一件事、同一个立场（ADR-0022 决策 2）：
 * `(lib …)` 说的那几个库先 `dlopen(RTLD_GLOBAL)` 进这个进程，然后所有外部符号
 * 一律问 `dlsym(RTLD_DEFAULT, …)` —— 那一格同时看得见 node 自己导出的 napi_*，
 * 所以注进去的代码里那些 `napi_create_function` 也是这么解的。
 */
static napi_value omni_fh_dlopen(napi_env env, napi_callback_info info) {
  napi_value a[1];
  char path[4096];
  size_t n = 0;
  if (!omni_fh_args(env, info, 1, a)) return omni_fh_err(env, "omni ffi host: dlopen(path)");
  if (napi_get_value_string_utf8(env, a[0], path, sizeof path, &n) != omni_napi_ok) {
    return omni_fh_err(env, "omni ffi host: dlopen 的 path 太长或者不是串");
  }
  void *h = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
  napi_value r;
  napi_get_boolean(env, h != NULL, &r);
  return r;
}

static napi_value omni_fh_sym(napi_env env, napi_callback_info info) {
  napi_value a[1];
  char name[512];
  size_t n = 0;
  if (!omni_fh_args(env, info, 1, a)) return omni_fh_err(env, "omni ffi host: sym(name)");
  if (napi_get_value_string_utf8(env, a[0], name, sizeof name, &n) != omni_napi_ok) {
    return omni_fh_err(env, "omni ffi host: sym 的 name 太长或者不是串");
  }
  void *p = dlsym(RTLD_DEFAULT, name);
  /* 查不着回 0n（**不抛**）：谁该报这句话是调用方的事 —— 它知道那个名字是从哪条
     声明来的，报出来的话比 "symbol not found" 有用。 */
  napi_value r;
  napi_create_bigint_int64(env, (int64_t)(intptr_t)p, &r);
  return r;
}

/* ================================================================== init
 *
 * 把那个地址当成 `napi_value (*)(napi_env, napi_value)` 叫一次 —— 也就是被注入的
 * 那份代码里的 `napi_register_module_v1`。递进去一个空对象，把它回的那个交出来。
 *
 * 这是整条路唯一一次"跳进注进去的字节"。在此之前 JS 那侧必须已经：
 * 写完字节 · 打完重定位 · `protect(rx)` 过 `.text`。次序错了就是 SIGBUS 或者跑错字节。
 */
static napi_value omni_fh_init(napi_env env, napi_callback_info info) {
  napi_value a[1];
  void *p = NULL;
  if (!omni_fh_args(env, info, 1, a)) return omni_fh_err(env, "omni ffi host: init(addr)");
  if (!omni_fh_addr(env, a[0], &p) || p == NULL) {
    return omni_fh_err(env, "omni ffi host: init 的 addr 要一格非零 BigInt");
  }
  napi_value exports;
  if (napi_create_object(env, &exports) != omni_napi_ok) return NULL;
  napi_value (*entry)(napi_env, napi_value) = (napi_value (*)(napi_env, napi_value))p;
  return entry(env, exports);
}

/* ================================================================== 装配 */
static napi_value omni_fh_pagesize(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value r;
  napi_create_int32(env, (int32_t)omni_fh_page(), &r);
  return r;
}

static void omni_fh_put(napi_env env, napi_value exports, const char *name, napi_callback cb) {
  napi_value f;
  if (napi_create_function(env, name, (size_t)-1, cb, NULL, &f) != omni_napi_ok) return;
  napi_set_named_property(env, exports, name, f);
}

napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  omni_fh_put(env, exports, "page", omni_fh_pagesize);
  omni_fh_put(env, exports, "mem", omni_fh_mem);
  omni_fh_put(env, exports, "protect", omni_fh_protect);
  omni_fh_put(env, exports, "dlopen", omni_fh_dlopen);
  omni_fh_put(env, exports, "sym", omni_fh_sym);
  omni_fh_put(env, exports, "init", omni_fh_init);
  return exports;
}


