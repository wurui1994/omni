/* ext/python/compat/omni_py_compat.h —— **让第三方的老源码在我们这份运行时上编得过**
 *
 * 口径（用户定的）：**怎么兼容是我们说了算**。第三方的 C / Cython 源码里引用的那些
 * 「上一版还在、这一版删了」的 CPython API，不是"我们做不到"，是**我们还没说它等于什么**。
 * 这一份就是说那件事的地方：一格一格写清「原来是什么语义、我们拿什么顶、为什么等价」。
 *
 * 两条纪律：
 *   1. **等价才顶**。拿不出等价语义的，顶成"当场炸"而不是"悄悄给个数"——
 *      静静答错比编不过坏得多。
 *   2. **死代码要标出来**。有些名字只出现在「旧表示」那一支里，而那一支在 3.12 之后
 *      永远不执行（`PyUnicode_IS_READY` 恒真）—— 那几格顶成不可达，并写明为什么。
 *
 * 用法：编第三方那些 `.c` 的时候 `-include .../omni_py_compat.h`（在 `Python.h` 之后）。
 */
#ifndef OMNI_PY_COMPAT_H
#define OMNI_PY_COMPAT_H

#include <Python.h>

/* ---------------------------------------------------------------- PEP-393 之前的那一族
 *
 * 3.12 删掉了「旧的 Py_UNICODE 表示」那一整套（`wstr` 那几格）。用它们的代码一律长这样：
 *
 *     if (PyUnicode_IS_READY(u)) { …新表示… } else { …旧表示… }
 *
 * 而 `PyUnicode_IS_READY` 从 3.12 起**恒真**（所有 str 都是紧凑表示）。所以：
 *   - `PyUnicode_IS_READY` 顶成 1；
 *   - 另外那两个只在 `else` 里出现 —— **不可达**。顶成"炸"，于是万一真走到了
 *     （说明我们对恒真这件事判断错了），是一句明话，不是一个错数。
 */
#ifndef PyUnicode_IS_READY
#define PyUnicode_IS_READY(op) (1)
#endif

#ifndef PyUnicode_GET_DATA_SIZE
#define PyUnicode_GET_DATA_SIZE(op) \
  (Py_FatalError("PyUnicode_GET_DATA_SIZE: 3.12 起没有旧表示了，这一支本该不可达"), \
   (Py_ssize_t)0)
#endif

#ifndef PyUnicode_AS_DATA
#define PyUnicode_AS_DATA(op) \
  (Py_FatalError("PyUnicode_AS_DATA: 3.12 起没有旧表示了，这一支本该不可达"), \
   (const char *)NULL)
#endif

/* ---------------------------------------------------------------- 切片下标
 *
 * `_PyEval_SliceIndex(PyObject *v, Py_ssize_t *pi)`：3.11 之前的内部函数 ——
 * 把一个对象转成切片下标，`None` 不动 `*pi`，成功回 1、出错回 0。
 * **这一格是活代码**（`slice.step` 那两处），所以要真等价：
 *   - `None` 不动；
 *   - 整数走 `PyNumber_AsSsize_t`，溢出按 C 的老行为夹到边界（老实现也是这么做的：
 *     它用 `PyNumber_AsSsize_t(v, NULL)`，NULL 就是"夹住、不抛"）；
 *   - 不是整数就 `TypeError` 并回 0。
 */
static inline int omni_py_slice_index(PyObject *v, Py_ssize_t *pi) {
  if (v == NULL || v == Py_None) return 1;
  if (PyIndex_Check(v)) {
    Py_ssize_t x = PyNumber_AsSsize_t(v, NULL);
    if (x == -1 && PyErr_Occurred()) return 0;
    *pi = x;
    return 1;
  }
  PyErr_SetString(PyExc_TypeError,
                  "slice indices must be integers or None or have an __index__ method");
  return 0;
}

#ifndef _PyEval_SliceIndex
#define _PyEval_SliceIndex(v, pi) omni_py_slice_index((v), (pi))
#endif

/* ---------------------------------------------------------------- 第三方源码里的小工具
 *
 * lxml 的 `python.pxd` 里原本是三个 Cython `inline`。放到 C 这一侧的理由很实在：
 * pxd 里的 inline 交给 Cython 推类型，而**变参调用点要的是确定的 C 类型** ——
 * `PyBytes_FromFormat("…%s", …, _cstr(e))` 那一处上，Cython 会把"推不出来的"当 Python
 * 对象，于是报 `Python object cannot be passed as a varargs parameter`。写成宏之后
 * 类型由 C 说，一格歧义都没有。
 */
#ifndef _cstr
#define _cstr(s) ((const char *)PyBytes_AS_STRING(s))
#endif

#ifndef __cstr
#define __cstr(s) ((const char *)(s))
#endif

/* `_isString`：`etree_defs.h` 里也有同名宏（先包含谁都一样，语义相同）。 */
#ifndef _isString
#define _isString(obj) (PyUnicode_Check(obj) || PyBytes_Check(obj))
#endif

#endif /* OMNI_PY_COMPAT_H */
