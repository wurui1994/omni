/* ext/python/rt/embed-frozen-probe.c —— 第五格判据的**第二问：产物自带标准库**。
   `embed-probe.c` 那一问里初始化还要读磁盘上的 `Lib`（`encodings` 是纯 python）——
   那是"整份运行时进产物"的最后一格缺口。这一份把它堵上：
     * `encodings` 那一族用**我们自己编出来的** `_freeze_module` 冻成头（`embed.js` 现做）；
     * 运行前把 `PyImport_FrozenModules` 换成"内置那张表 + 我们这几格"（这是 CPython 给
       嵌入方留的口子，`Include/cpython/import.h:30`）；
     * `module_search_paths` **留空** —— 磁盘上一个字都不读。
   答案照旧与本机 python3 比。 */
#include <stdio.h>
#include <stdlib.h>
#include "Python.h"

#include "encodings.h"
#include "encodings.aliases.h"
#include "encodings.utf_8.h"
#include "encodings.ascii.h"
#include "encodings.latin_1.h"

static struct _frozen extra[] = {
  {"encodings", _Py_M__encodings, (int)sizeof(_Py_M__encodings), 1},
  {"encodings.aliases", _Py_M__encodings_aliases, (int)sizeof(_Py_M__encodings_aliases), 0},
  {"encodings.utf_8", _Py_M__encodings_utf_8, (int)sizeof(_Py_M__encodings_utf_8), 0},
  {"encodings.ascii", _Py_M__encodings_ascii, (int)sizeof(_Py_M__encodings_ascii), 0},
  {"encodings.latin_1", _Py_M__encodings_latin_1, (int)sizeof(_Py_M__encodings_latin_1), 0},
};

int main(void) {
  const struct _frozen *base = PyImport_FrozenModules;
  int n = 0;
  while (base != NULL && base[n].name != NULL) n++;
  int m = (int)(sizeof(extra) / sizeof(extra[0]));
  struct _frozen *all = (struct _frozen *)calloc((size_t)(n + m + 1), sizeof(struct _frozen));
  if (all == NULL) { printf("oom\n"); return 1; }
  for (int i = 0; i < n; i++) all[i] = base[i];
  for (int i = 0; i < m; i++) all[n + i] = extra[i];
  PyImport_FrozenModules = all;

  PyConfig cfg;
  PyConfig_InitIsolatedConfig(&cfg);
  cfg.site_import = 0;
  cfg.module_search_paths_set = 1;   /* 空 —— 不读磁盘 */
  PyStatus st = Py_InitializeFromConfig(&cfg);
  PyConfig_Clear(&cfg);
  if (PyStatus_Exception(st)) { printf("init failed\n"); return 1; }

  PyObject *s = PyUnicode_FromString("42");
  PyObject *z = PyObject_CallMethod(s, "zfill", "i", 5);
  if (z == NULL) { printf("zfill NULL\n"); PyErr_Print(); return 1; }
  printf("%s\n", PyUnicode_AsUTF8(z));
  PyObject *big = PyNumber_Power(PyLong_FromLong(7), PyLong_FromLong(80), Py_None);
  printf("%s\n", PyUnicode_AsUTF8(PyObject_Str(big)));
  Py_Finalize();
  return 0;
}
