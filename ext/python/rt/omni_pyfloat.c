/* ext/python/rt/omni_pyfloat.c —— 封闭 ABI 的那一层皮（算法全在借来的那两份 .c 里）
 *
 * 这一份里只有三件事：
 *   1. 那格**进程级的"解释器状态"**（dtoa.c 把 Bigint 的空闲链挂在它上头）；
 *   2. `PyErr_*` 落到哪儿（一格串）；
 *   3. 三个封闭 ABI 的函数。
 */
#include "Python.h"
#include "pycore_dtoa.h"          /* CPython 自己那份：三个 _Py_dg_* 原型 + _dtoa_state_INIT */
#include "pycore_pystate.h"       /* 我们那格 _PyInterpreterState_GET() */

#include <stdarg.h>

#include "omni_pyfloat.h"

/* ---- 状态 ---------------------------------------------------------------- */

/* `_dtoa_state_INIT` 是 CPython 自己那个宏（`Include/internal/pycore_dtoa.h`）：
   它把 `preallocated_next` 指到同一格结构里的那块预分配内存上。自引用的静态初始化
   在 C 里是合法的（取的是正在定义的那个对象的地址）。 */
PyInterpreterState omni_py_interp = { .dtoa = _dtoa_state_INIT(&omni_py_interp) };

/* `PyExc_*` 只当标记用（`PyErr_Format` 把它丢掉）—— 对象层一格都没有。 */
static char omni_exc_value[] = "ValueError";
static char omni_exc_overflow[] = "OverflowError";
PyObject *PyExc_ValueError = (PyObject *)omni_exc_value;
PyObject *PyExc_OverflowError = (PyObject *)omni_exc_overflow;

char omni_py_err[256] = { 0 };

PyObject *omni_py_err_set(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(omni_py_err, sizeof omni_py_err, fmt, ap);
    va_end(ap);
    return NULL;
}

const char *omni_py_last_error(void) { return omni_py_err; }

/** `p5s` 那张"5 的幂"缓存要先建起来（CPython 在起解释器时调这一格）。只做一次。 */
static void omni_py_dtoa_once(void) {
    static int done = 0;
    if (done) return;
    done = 1;
#if _PY_SHORT_FLOAT_REPR == 1 && !defined(Py_USING_MEMORY_DEBUGGER)
    PyStatus st = _PyDtoa_Init(&omni_py_interp);
    if (st._err) {
        omni_py_err_set("_PyDtoa_Init: %s", st._msg == NULL ? "failed" : st._msg);
    }
#endif
}

/* ---- 封闭 ABI ------------------------------------------------------------ */

int omni_py_float_repr(double v, char *buf, size_t cap) {
    omni_py_err[0] = 0;
    omni_py_dtoa_once();
    /* `'r'` + `Py_DTSF_ADD_DOT_0` —— 与 `Objects/floatobject.c` 的 `float_repr` 逐格相同。 */
    char *s = PyOS_double_to_string(v, 'r', 0, Py_DTSF_ADD_DOT_0, NULL);
    if (s == NULL) {
        if (omni_py_err[0] == 0) omni_py_err_set("PyOS_double_to_string failed");
        return -1;
    }
    size_t n = strlen(s);
    if (n + 1 > cap) {
        PyMem_Free(s);
        omni_py_err_set("repr needs %zu bytes, buffer has %zu", n + 1, cap);
        return -1;
    }
    memcpy(buf, s, n + 1);
    PyMem_Free(s);
    return 0;
}

int omni_py_float_from_string(const char *s, double *out) {
    omni_py_err[0] = 0;
    omni_py_dtoa_once();
    char *end = NULL;
    double v = PyOS_string_to_double(s, &end, NULL);
    if (omni_py_err[0] != 0) return -1;
    /* CPython 那一侧允许尾随空白（`float(" 1.5 ")`），别的字符不许。 */
    while (end != NULL && (*end == ' ' || *end == '\t' || *end == '\n' || *end == '\r')) end++;
    if (end != NULL && *end != 0) {
        omni_py_err_set("could not convert string to float: '%s'", s);
        return -1;
    }
    *out = v;
    return 0;
}
