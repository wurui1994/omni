/* dynamic 的非内联部分：标签名表和结构相等。构造与取值在 omni.h 里（内联）。 */
#include "omni.h"

const char *omni_dyn_tag_name(int t) {
  static const char *names[] = {
    "null", "bool", "int", "real", "string", "list", "dict",
    /* 这三个只由 JS 前端产生（ADR-0011）；Omni 源码造不出来。str16 在 JS 的 typeof 里
       报 "string"，但错误信息里要能和 UTF-8 的 string 区分开，所以标签名不一样 */
    "undefined", "function", "str16",
    /* Map / Set：底子还是 dict<string, dynamic>，但标签必须分开 —— o.has(k) 这类成员
       派发只有标签能区分 Map 和普通对象（ADR-0011） */
    "Map", "Set",
  };
  return names[t];
}

omni_str omni_dyn_tag(omni_dyn v) {
  const char *n = omni_dyn_tag_name(v.tag);
  return omni_str_new(n, (int64_t)strlen(n));
}

bool omni_dyn_eq(omni_dyn a, omni_dyn b) {
  if (a.tag != b.tag) return false;
  switch (a.tag) {
    case OMNI_DYN_NULL: return true;
    case OMNI_DYN_BOOL: return a.u.b == b.u.b;
    case OMNI_DYN_INT: return a.u.i == b.u.i;
    case OMNI_DYN_REAL: return a.u.r == b.u.r;
    case OMNI_DYN_STRING: return omni_str_cmp(a.u.s, b.u.s) == 0;
    default: return a.u.ref == b.u.ref;  /* 容器按引用相等，和 JS 侧一致 */
  }
}
