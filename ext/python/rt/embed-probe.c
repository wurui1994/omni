/* ext/python/rt/embed-probe.c —— **第五格判据的被试者**：我们自己编出来的一份 C，
   把借来的那份 CPython 运行时当库用。
   进门那一格要的是四件事连着对：初始化（`Py_InitializeFromConfig`）、建串
   （`PyUnicode_FromString`）、调方法（`PyObject_CallMethod`）、取回 UTF-8
   （`PyUnicode_AsUTF8`）。挑的三格答案分别落在三族借来的代码上：
     * `str.zfill` / `str.center` -> `Objects/unicodeobject.c`（15436 行那一份）；
     * `7 ** 80`                  -> `Objects/longobject.c`（大整数 —— 我们自己的 int 是 64 位，
                                     所以这一格只能是借来的那份在答）；
     * `repr(0.1 + 0.2)`          -> `Python/dtoa.c`。
   判据不写死期望值：答案与本机 python3 的同一句话比（口径与 `tests/python/run.js` 一条）。

   `PY_LIB_DIR` 由 `embed.js` 用 `-D` 给。为什么要它：借来的运行时初始化要 `encodings`
   （纯 python，住在标准库里）—— 这一格就是"整份运行时进产物"那个决定的账的一部分：
   **`.o` 全进产物了，标准库还在磁盘上**。要去掉它得把那几份 `.py` 也冻进来（第四把尺子
   `freeze.js` 已经有那套工具了）。 */
#include <stdio.h>
#include "Python.h"

static int show(const char *what, PyObject *o) {
  if (o == NULL) { printf("%s: NULL\n", what); PyErr_Print(); return 1; }
  const char *s = PyUnicode_AsUTF8(o);
  if (s == NULL) { printf("%s: (not str)\n", what); return 1; }
  printf("%s\n", s);
  return 0;
}

int main(void) {
  PyConfig cfg;
  PyConfig_InitIsolatedConfig(&cfg);
  cfg.site_import = 0;
  cfg.module_search_paths_set = 1;
  wchar_t *lib = Py_DecodeLocale(PY_LIB_DIR, NULL);
  PyWideStringList_Append(&cfg.module_search_paths, lib);
  PyStatus st = Py_InitializeFromConfig(&cfg);
  PyConfig_Clear(&cfg);
  if (PyStatus_Exception(st)) { printf("init failed\n"); return 1; }

  int bad = 0;
  PyObject *s = PyUnicode_FromString("42");
  bad |= show("zfill", PyObject_CallMethod(s, "zfill", "i", 5));
  bad |= show("center", PyObject_CallMethod(s, "center", "is", 7, "*"));
  PyObject *big = PyNumber_Power(PyLong_FromLong(7), PyLong_FromLong(80), Py_None);
  bad |= show("pow", PyObject_Str(big));
  PyObject *f = PyFloat_FromDouble(0.1 + 0.2);
  bad |= show("repr", PyObject_Repr(f));
  Py_Finalize();
  return bad;
}
