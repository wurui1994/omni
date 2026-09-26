/* ext/python/rt/omni_pyfloat.h —— **借 CPython 的 C 做浮点与串之间的转换**
 *
 * 这一层是"解析与执行归我们，运行时借 CPython 的 C"那条线的第一格实物。
 * 里头的算法一个字都不是我们写的：`Python/dtoa.c`（David Gay 的正确舍入转换）与
 * `Python/pystrtod.c`（CPython 的 repr 排版规则）**原样编进来**，这儿只给封闭的 C ABI。
 *
 * 为什么非借不可：`repr(0.1)` 要印 `0.1` 而不是 `0.1000000000000000055`，靠的是
 * "最短往返"那套算法；而 `repr(1e15)` 要印 `1000000000000000.0`、`repr(1e16)` 要印
 * `1e+16`，靠的是 CPython 自己那条门槛。用 `%.17g` 或者"15/16/17 位里挑第一个能往返的"
 * 都能对上大多数值，**但不是全部** —— 而"大多数对"在这条链上等于没做。
 */
#ifndef OMNI_PYFLOAT_H
#define OMNI_PYFLOAT_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * python 的 `repr(v)` / `str(v)`（3.1 起两者相同）写进 `buf`。
 * 回 0 = 成了；回 -1 = 装不下或者出错（`omni_py_last_error()` 有话）。
 */
int omni_py_float_repr(double v, char *buf, size_t cap);

/**
 * python 的 `float(s)`：认小数、指数、`inf` / `nan`，**不认下划线**
 * （那一格在 CPython 里是 `_Py_string_to_number_with_underscores`，属于对象层）。
 * 回 0 = 成了（值写进 `*out`）；回 -1 = 不是一个数，或者溢出。
 */
int omni_py_float_from_string(const char *s, double *out);

/** 最近一次错的话（没错回空串）。 */
const char *omni_py_last_error(void);

#ifdef __cplusplus
}
#endif

#endif /* OMNI_PYFLOAT_H */
