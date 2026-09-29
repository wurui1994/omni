# ext/python/compat/lxml/python.pxd —— **我们自己补的那份**（lxml 的 wheel 里没打包它）
#
# lxml 的 `etree.pyx` 从 `lxml.python` cimport 48 个名字，而 wheel 只打包了
# `lxml/includes/*.pxd` —— 顶层这份没有。它本身只是一张**声明表**（CPython 的 C API 长
# 什么样），所以我们自己写一份就行：名字与签名照 CPython 的头，被删掉的那几个走
# `omni_py_compat.h`（编的时候 `-include` 它）。
#
# 口径：这不是"给 lxml 打补丁"，是**我们说清那些名字等于什么**。
cdef extern from *:
    # lxml 上游就是这么写的：给 `const char` 起一个能当类型名用的名字。
    ctypedef char const_char "const char"

cdef extern from "Python.h":
    ctypedef struct PyObject
    ctypedef Py_ssize_t Py_hash_t

    # ---- 版本与平台
    int PY_VERSION_HEX
    bint PY_BIG_ENDIAN

    # ---- 引用计数
    void Py_INCREF(object)
    void Py_DECREF(object)

    # ---- bytes
    char* PyBytes_AS_STRING(object)
    Py_ssize_t PyBytes_GET_SIZE(object)
    object PyBytes_FromFormat(char* format, ...)
    bint PyBytes_CheckExact(object)

    # ---- unicode（新表示那一族；旧的两格在 omni_py_compat.h 里顶）
    void* PyUnicode_DATA(object)
    Py_ssize_t PyUnicode_GET_LENGTH(object)
    int PyUnicode_KIND(object)
    Py_UCS4 PyUnicode_MAX_CHAR_VALUE(object)
    bint PyUnicode_IS_READY(object)
    Py_ssize_t PyUnicode_GET_DATA_SIZE(object)
    const_char* PyUnicode_AS_DATA(object)
    object PyUnicode_Decode(const_char* s, Py_ssize_t size, const_char* encoding, const_char* errors)
    object PyUnicode_AsUTF8String(object)
    object PyUnicode_AsASCIIString(object)
    object PyUnicode_AsEncodedString(object, const_char* encoding, const_char* errors)
    bint PyUnicode_CheckExact(object)

    # ---- 容器
    PyObject* PyDict_GetItem(object dict, object key)
    Py_ssize_t PyList_GET_SIZE(object)
    bint PyTuple_CheckExact(object)
    object PyTuple_GET_ITEM(object, Py_ssize_t)
    bint PySequence_Check(object)
    bint PyNumber_Check(object)
    object PyObject_RichCompare(object, object, int)
    int PySlice_GetIndicesEx(object slice, Py_ssize_t length,
                             Py_ssize_t* start, Py_ssize_t* stop,
                             Py_ssize_t* step, Py_ssize_t* slicelength) except -1

    # ---- 错误与状态
    object PyErr_SetFromErrno(object type)
    PyObject* PyThreadState_GetDict()
    object PyOS_FSPath(object)

    # ---- 切片下标（3.11 之前的内部函数；我们那份垫片给的是等价语义）
    int _PyEval_SliceIndex(object, Py_ssize_t*) except 0


    # `_fqtypename(o)` —— `etree_defs.h` 里的宏（`Py_TYPE(o)->tp_name`）。lxml 拿它印
    # "你给的这个对象是什么类型"那句诊断。声明在这儿是因为 lxml 从 `python` 那个模块用它。
    const_char* _fqtypename(object o)

    # ---- 缓冲协议那两格标志
    int PyBUF_WRITABLE
    int PyBUF_FORMAT

cdef extern from "pythread.h":
    ctypedef void* PyThread_type_lock
    int WAIT_LOCK
    PyThread_type_lock PyThread_allocate_lock()
    void PyThread_free_lock(PyThread_type_lock)
    int PyThread_acquire_lock(PyThread_type_lock, int mode) nogil
    void PyThread_release_lock(PyThread_type_lock) nogil

# PyPy 那一支：我们不是 PyPy。
cdef enum:
    IS_PYPY = 0

cdef extern from "etree_defs.h":
    # 三格分配器也从 `python` 这个模块用（上游的 python.pxd 与 tree.pxd 里都声明了它们）。
    void* lxml_malloc(size_t count, size_t item_size) nogil
    void* lxml_realloc(void* mem, size_t count, size_t item_size) nogil
    void lxml_free(void* mem) nogil
    # PyCapsule 那一格（`etree_defs.h:238`）：把别人给的 xmlDoc 从胶囊里取出来。
    void* lxml_unpack_xmldoc_capsule(object capsule, bint* is_owned) except NULL

cdef extern from "omni_py_compat.h":
    # 三格小工具在 C 那一侧（见那份头里的理由：变参调用点要确定的 C 类型）。
    const_char* _cstr(object s)
    const_char* __cstr(const void* s)
    bint _isString(object obj)
