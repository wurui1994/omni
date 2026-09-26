/* ext/python/rt/shim/pycore_pystate.h —— dtoa.c 只为了一件事包它：`_PyInterpreterState_GET()`
 *
 * dtoa.c 把 Bigint 的空闲链与"5 的幂"缓存挂在解释器状态上（`interp->dtoa`）。
 * 我们没有解释器，所以给它一格**进程级**的状态 —— 单线程口径，与"借一格纯算法"相称。
 *
 * 明写一格边界：**这一格不是线程安全的**。CPython 那边靠 GIL / 每解释器状态挡住它；
 * 我们这儿要多线程用，得给这格状态加一把锁或者改成 thread-local，那是另一笔账。
 */
#ifndef OMNI_PY_SHIM_PYSTATE_H
#define OMNI_PY_SHIM_PYSTATE_H

#include "pycore_interp_structs.h"

extern PyInterpreterState omni_py_interp;

static inline PyInterpreterState *_PyInterpreterState_GET(void) {
    return &omni_py_interp;
}

#endif /* OMNI_PY_SHIM_PYSTATE_H */
