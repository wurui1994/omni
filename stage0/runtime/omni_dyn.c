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
    /* 无符号 64 位那一格（ADR-0011）：在 JS 域里它就是一个 BigInt，所以名字与 INT
       一样是 "int" —— 错误消息里不该冒出一个源语言里没有的类型名 */
    "int",
    /* 正则对象（ADR-0011 决策 10）：JS 的 typeof 是 "object"，但错误消息里要能认出来 */
    "regexp",
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
    case OMNI_DYN_INT: case OMNI_DYN_UINT: return a.u.i == b.u.i;
    case OMNI_DYN_REAL: return a.u.r == b.u.r;
    case OMNI_DYN_STRING: return omni_str_cmp(a.u.s, b.u.s) == 0;
    default: return a.u.ref == b.u.ref;  /* 容器按引用相等，和 JS 侧一致 */
  }
}

/* dynamic 上的算术。标签严格，**不做** JS 那套强制转换 —— dynamic 是 Omni 的动态通道，
   不是 any："1" + 1 在这里是错误，不是 "11"。规则与静态那半边逐条对齐：两个 int 是 int64
   回绕，掺进 real 就都按 real 算，两个 string 只有 '+' 是拼接。其余组合是运行期错误，
   消息点名两边的标签 —— 与 backend-js/prelude.js 的 $dynArith 逐字一致。 */
static bool dyn_num(omni_dyn v) { return v.tag == OMNI_DYN_INT || v.tag == OMNI_DYN_REAL; }

static double dyn_r(omni_dyn v) { return v.tag == OMNI_DYN_INT ? (double)v.u.i : v.u.r; }

omni_dyn omni_dyn_arith(char op, omni_dyn a, omni_dyn b) {
  if (a.tag == OMNI_DYN_INT && b.tag == OMNI_DYN_INT) {
    int64_t x = a.u.i, y = b.u.i;
    switch (op) {
      case '+': return omni_dyn_of_int(omni_add(x, y));
      case '-': return omni_dyn_of_int(omni_sub(x, y));
      case '*': return omni_dyn_of_int(omni_mul(x, y));
      case '/': return omni_dyn_of_int(omni_div(x, y));
      default: return omni_dyn_of_int(omni_mod(x, y));
    }
  }
  if (dyn_num(a) && dyn_num(b)) {
    double x = dyn_r(a), y = dyn_r(b);
    switch (op) {
      case '+': return omni_dyn_of_real(x + y);
      case '-': return omni_dyn_of_real(x - y);
      case '*': return omni_dyn_of_real(x * y);
      case '/': return omni_dyn_of_real(x / y);
      default: return omni_dyn_of_real(fmod(x, y));
    }
  }
  if (op == '+' && a.tag == OMNI_DYN_STRING && b.tag == OMNI_DYN_STRING) {
    return omni_dyn_of_string(omni_str_cat(a.u.s, b.u.s));
  }
  omni_errorf("cannot apply '%c' to %s and %s", op, omni_dyn_tag_name(a.tag), omni_dyn_tag_name(b.tag));
  return omni_dyn_null();
}

omni_dyn omni_dyn_neg(omni_dyn a) {
  if (a.tag == OMNI_DYN_INT) return omni_dyn_of_int(omni_neg(a.u.i));
  if (a.tag == OMNI_DYN_REAL) return omni_dyn_of_real(-a.u.r);
  omni_errorf("cannot apply unary '-' to %s", omni_dyn_tag_name(a.tag));
  return omni_dyn_null();
}
