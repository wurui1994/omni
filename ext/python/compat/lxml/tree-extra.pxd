# ext/python/compat/lxml/tree-extra.pxd —— **wheel 那份 tree.pxd 被裁掉的尾巴**
#
# 这三格的 **C 定义在 `lxml/includes/etree_defs.h` 里**（wheel 带着那个头），缺的只是
# Cython 侧的声明 —— 上游把它们写在 `includes/tree.pxd` 末尾，而 wheel 打包时裁掉了。
# 构建脚本把这一段**追加**到工作副本那份 tree.pxd 后面（不改第三方源码本身）。
cdef extern from "etree_defs.h":
    void* lxml_malloc(size_t count, size_t item_size) nogil
    void* lxml_realloc(void* mem, size_t count, size_t item_size) nogil
    void lxml_free(void* mem) nogil
