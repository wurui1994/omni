/* 文本 -> 值。文法必须与 JS 后端 ($int_of_string / $real_of_string) 逐条一致：
   libc 的 strtoll/strtod 比我们宽松（吃前导空白、0x 前缀、inf/nan），所以先自己校验一遍文法，
   通过之后才交给 libc 做实际转换。 */
#include "omni.h"

int64_t omni_int_of_string(omni_str s) {
  int64_t i = 0;
  if (i < s.len && (s.p[i] == '+' || s.p[i] == '-')) i++;
  int64_t digits = 0;
  for (; i < s.len; i++, digits++) if (s.p[i] < '0' || s.p[i] > '9') break;
  if (digits == 0 || i != s.len) omni_errorf("invalid integer: \"%.*s\"", (int)s.len, s.p);
  char *c = omni_cstr(s);
  errno = 0;
  char *end = NULL;
  long long v = strtoll(c, &end, 10);
  if (errno == ERANGE || *end) omni_errorf("invalid integer: \"%.*s\"", (int)s.len, s.p);
  free(c);
  return (int64_t)v;
}

double omni_real_of_string(omni_str s) {
  /* 文法：[+-]?(D+.D* | .D+)([eE][+-]?D+)? */
  int64_t i = 0;
  if (i < s.len && (s.p[i] == '+' || s.p[i] == '-')) i++;
  int64_t intd = 0, frad = 0;
  while (i < s.len && s.p[i] >= '0' && s.p[i] <= '9') { i++; intd++; }
  if (i < s.len && s.p[i] == '.') {
    i++;
    while (i < s.len && s.p[i] >= '0' && s.p[i] <= '9') { i++; frad++; }
  }
  bool ok = intd > 0 || frad > 0;
  if (ok && i < s.len && (s.p[i] == 'e' || s.p[i] == 'E')) {
    i++;
    if (i < s.len && (s.p[i] == '+' || s.p[i] == '-')) i++;
    int64_t expd = 0;
    while (i < s.len && s.p[i] >= '0' && s.p[i] <= '9') { i++; expd++; }
    if (expd == 0) ok = false;
  }
  if (!ok || i != s.len) omni_errorf("invalid real: \"%.*s\"", (int)s.len, s.p);
  char *c = omni_cstr(s);
  double v = strtod(c, NULL);
  free(c);
  return v;
}
