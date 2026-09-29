# ext/python/compat/lxml/cvarargs.pxd —— **我们自己补的那份**（wheel 里也没打包它）
#
# lxml 的 `xmlerror.pxi` 用它把 libxml2/libxslt 的变参回调（`void f(void*, char*, ...)`）
# 拆开。`va_int` / `va_charptr` 那两格的 **C 定义在 `etree_defs.h:28-29`**（wheel 带着
# 那个头）—— Cython 不能直接写 `va_arg`，所以上游用宏包一层。这份只是声明表。
cdef extern from "stdarg.h":
    ctypedef struct va_list:
        pass
    void va_start(va_list ap, ...) nogil
    void va_end(va_list ap) nogil

cdef extern from "etree_defs.h":
    int va_int(va_list ap) nogil
    char* va_charptr(va_list ap) nogil
