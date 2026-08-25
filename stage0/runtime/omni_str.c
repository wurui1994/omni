/* 字符串：不可变 UTF-8 字节序列。构造/比较/取字节/substr 在 omni.h 里（内联），
   这里放要分配或要扫描的那些。 */
#include "omni.h"

omni_str omni_str_cat(omni_str a, omni_str b) {
  char *buf = (char *)omni_alloc((size_t)(a.len + b.len + 1));
  if (a.len) memcpy(buf, a.p, (size_t)a.len);
  if (b.len) memcpy(buf + a.len, b.p, (size_t)b.len);
  buf[a.len + b.len] = 0;
  return omni_str_new(buf, a.len + b.len);
}

omni_str omni_str_fmt(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(NULL, 0, fmt, ap);
  va_end(ap);
  if (n < 0) omni_error("formatting failed");
  char *buf = (char *)omni_alloc((size_t)n + 1);
  va_start(ap, fmt);
  vsnprintf(buf, (size_t)n + 1, fmt, ap);
  va_end(ap);
  return omni_str_new(buf, n);
}

/* 按字节找子串。空串在位置 0 命中，和 JS 的 indexOf 一致。 */
int64_t omni_index_of(omni_str s, omni_str needle) {
  for (int64_t i = 0; i + needle.len <= s.len; i++) {
    if (needle.len == 0 || memcmp(s.p + i, needle.p, (size_t)needle.len) == 0) return i;
  }
  return -1;
}

/* JS 的 String.fromCodePoint 对代理区返回孤立代理，写出去就是 U+FFFD，这里保持一致 */
omni_str omni_chr(int64_t cp) {
  if (cp < 0 || cp > 0x10ffff) {
    omni_errorf("chr(): code point out of range: %lld", (long long)cp);
  }
  if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
  char *b = (char *)omni_alloc(5);
  int64_t n;
  if (cp < 0x80) { b[0] = (char)cp; n = 1; }
  else if (cp < 0x800) { b[0] = (char)(0xc0 | (cp >> 6)); b[1] = (char)(0x80 | (cp & 0x3f)); n = 2; }
  else if (cp < 0x10000) {
    b[0] = (char)(0xe0 | (cp >> 12));
    b[1] = (char)(0x80 | ((cp >> 6) & 0x3f));
    b[2] = (char)(0x80 | (cp & 0x3f));
    n = 3;
  } else {
    b[0] = (char)(0xf0 | (cp >> 18));
    b[1] = (char)(0x80 | ((cp >> 12) & 0x3f));
    b[2] = (char)(0x80 | ((cp >> 6) & 0x3f));
    b[3] = (char)(0x80 | (cp & 0x3f));
    n = 4;
  }
  b[n] = 0;
  return omni_str_new(b, n);
}

/* 交给 libc 之前要一份 NUL 结尾的副本：omni_str 可能是别名进来的切片 */
char *omni_cstr(omni_str s) {
  char *b = (char *)omni_alloc((size_t)s.len + 1);
  if (s.len) memcpy(b, s.p, (size_t)s.len);
  b[s.len] = 0;
  return b;
}
