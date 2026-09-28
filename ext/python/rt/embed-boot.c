/* ext/python/rt/embed-boot.c —— 语言层要的那层**薄皮**（门三的一半）。
 *
 * 为什么必须有它：方言的 `(cabi …)` 只有 i32/i64/ptr/f64/bool/void 这几个类型词
 * （`sexpr/lower.js` 的 `CABI_CORE`），`PyConfig` 那种结构过不去。所以"初始化借来的
 * 运行时"这件事收成**一个 C ABI 函数**，而这一份 C 自己也由我们那台 C 前端编。
 * 这就是 adapter 将来该发的形状：`(ccall omni_py_boot …)` 一句话。
 *
 * 标准库的路径由 `-DPY_LIB_DIR` 给（门二那一份证过：把 `encodings` 冻进来就可以不要它）。 */
#include "Python.h"

int omni_py_boot(const char *libdir) {
  PyConfig cfg;
  PyConfig_InitIsolatedConfig(&cfg);
  cfg.site_import = 0;
  cfg.module_search_paths_set = 1;
  wchar_t *lib = Py_DecodeLocale(libdir, NULL);
  PyWideStringList_Append(&cfg.module_search_paths, lib);
  PyStatus st = Py_InitializeFromConfig(&cfg);
  PyConfig_Clear(&cfg);
  return PyStatus_Exception(st) ? 1 : 0;
}

int omni_py_fini(void) { return Py_FinalizeEx(); }
