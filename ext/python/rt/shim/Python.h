/* ext/python/rt/shim/Python.h —— **给借来的那几份 CPython 的 C 垫的一层地板**
 *
 * 这一门的架构线是"解析与执行归我们，运行时借 CPython 的 C"（`ext/python/SPEC.md` §一）。
 * 借的第一批是 `Python/dtoa.c` + `Python/pystrtod.c`：浮点与串之间那两条**正确舍入**的
 * 转换（David Gay 的 dtoa + CPython 的 `repr` 排版规则）。那两份 `.c` 我们**一个字都不改**。
 *
 * 可它们 `#include <Python.h>` —— 而真正的 Python.h 后面跟着整个对象层与解释器状态。
 * 所以这儿垫一层：把那两份 `.c` 真正用到的东西**一格一格**给出来。
 * 到底用到哪些不是猜的，是量出来的（`grep -o '\b_\?Py[A-Za-z_]*\b'` 那两份文件）：
 *
 *   PyMem_Malloc / PyMem_Free   -> malloc / free
 *   PyInterpreterState          -> 只为了 `->dtoa` 那一格（Bigint 的空闲链与 5 的幂缓存）
 *   PyStatus / PyStatus_Ok / PyStatus_NoMemory  -> 只有 _PyDtoa_Init / _PyDtoa_Fini 用
 *   PyErr_* / PyExc_ValueError  -> 记一格错，由 `omni_pyfloat.c` 那一侧问
 *   Py_ssize_t / Py_ISDIGIT / Py_TOLOWER / Py_TOUPPER / Py_SAFE_DOWNCAST / Py_UNREACHABLE
 *   Py_NAN / PyOS_snprintf / Py_LOCAL_INLINE / PyAPI_FUNC / _Py_FALLTHROUGH
 *
 * **凡是 CPython 自己有的，都用它的**（不在这儿抄第二份）：
 *   * `Py_DTSF_*` / `Py_DTST_*` 与两个函数原型 -> CPython 的 `Include/pystrtod.h`；
 *   * `_PY_SHORT_FLOAT_REPR` 与 `_Py_SET_53BIT_PRECISION_*` -> `Include/internal/pycore_pymath.h`；
 *   * `struct Bigint` / `struct _dtoa_state` -> 由 `gen-pyshim.js` 从
 *     `Include/internal/pycore_interp_structs.h` **原样切出来**，不手抄（抄了会与那棵树分叉）。
 *   * `HAVE_GCC_ASM_FOR_X87` 这一族六个宏 -> `gen-pyconf.js` 真探一遍（`omni_pyconf.h`）。
 */
#ifndef OMNI_PY_SHIM_PYTHON_H
#define OMNI_PY_SHIM_PYTHON_H

/* 探出来的那六个宏。`Py_BUILD_CORE` 是 pycore_* 那几份头自己要的。 */
#include "omni_pyconf.h"

#include <assert.h>
#include <float.h>
#include <math.h>
#include <errno.h>
#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PyAPI_FUNC(RTYPE) RTYPE
#define PyAPI_DATA(RTYPE) extern RTYPE
#define Py_LOCAL_INLINE(type) static inline type
#define _Py_FALLTHROUGH ((void)0)

typedef ptrdiff_t Py_ssize_t;
/** 对象层一格都不要 —— 这儿只需要"有这么个不透明类型"（`PyExc_ValueError` 的类型）。 */
typedef struct _omni_py_object PyObject;
/** **先声明**：CPython 自己那份 `pycore_dtoa.h` 里的两条原型要它，而它的定义在
 *  生成出来的 `pycore_interp_structs.h` 里（那一份由 dtoa.c 自己包）。 */
typedef struct _omni_py_interp PyInterpreterState;

#define PyMem_Malloc(n)      malloc(n)
#define PyMem_Free(p)        free(p)
#define PyMem_Realloc(p, n)  realloc((p), (n))

/** `_PyDtoa_Init` / `_PyDtoa_Fini` 的返回类型。这一路我们自己不走（见 omni_pyfloat.c）。 */
typedef struct { int _err; const char *_msg; } PyStatus;
#define PyStatus_Ok()        omni_py_status_ok()
#define PyStatus_NoMemory()  omni_py_status_nomem()
static inline PyStatus omni_py_status_ok(void) { PyStatus s; s._err = 0; s._msg = NULL; return s; }
static inline PyStatus omni_py_status_nomem(void) { PyStatus s; s._err = 1; s._msg = "out of memory"; return s; }

#define Py_SAFE_DOWNCAST(VALUE, WIDE, NARROW) ((NARROW)(VALUE))
#define Py_UNREACHABLE() abort()

/* **ASCII 口径**（CPython 的 `Py_ISDIGIT` 一族也是 ASCII，不看 locale）。 */
#define Py_ISDIGIT(c) ((unsigned char)(c) >= '0' && (unsigned char)(c) <= '9')
#define Py_TOLOWER(c) (((unsigned char)(c) >= 'A' && (unsigned char)(c) <= 'Z') \
                       ? (char)((unsigned char)(c) + 32) : (char)(c))
#define Py_TOUPPER(c) (((unsigned char)(c) >= 'a' && (unsigned char)(c) <= 'z') \
                       ? (char)((unsigned char)(c) - 32) : (char)(c))

#define Py_NAN ((double)NAN)
#define PyOS_snprintf snprintf

/* ---- 错那一侧。pystrtod.c 在溢出与串格式不对时叫它们；这儿记下来，由 omni_pyfloat.c 问。 */
extern PyObject *PyExc_ValueError;
extern PyObject *PyExc_OverflowError;
/** 最近一次错的话（没错是空串）。 */
extern char omni_py_err[256];
PyObject *omni_py_err_set(const char *fmt, ...);
#define PyErr_Format(exc, ...)   (void)(exc), omni_py_err_set(__VA_ARGS__)
#define PyErr_NoMemory()         omni_py_err_set("out of memory")
#define PyErr_BadInternalCall()  (void)omni_py_err_set("bad internal call")
#define PyErr_SetString(exc, s)  (void)(exc), (void)omni_py_err_set("%s", (s))

/* `Py_DTSF_*` / `Py_DTST_*` 与那两个函数的原型 —— **用 CPython 自己那份公开头**。 */
#include "pystrtod.h"

#endif /* OMNI_PY_SHIM_PYTHON_H */
