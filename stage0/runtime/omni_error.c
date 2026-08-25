/* 运行时错误：统一走 stderr + 退出码 70，并且先 fflush(stdout)，
   否则 stdout 的缓冲会让错误消息跑到正常输出前面 —— JS 后端的 $rt_error 也是先 $flush()。 */
#include "omni.h"

void omni_error(const char *msg) {
  fflush(stdout);
  fprintf(stderr, "omni: runtime error: %s\n", msg);
  exit(70);
}

void omni_errorf(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(NULL, 0, fmt, ap);
  va_end(ap);
  if (n < 0) omni_error("formatting failed");
  char *buf = (char *)malloc((size_t)n + 1);
  if (!buf) omni_error("out of memory");
  va_start(ap, fmt);
  vsnprintf(buf, (size_t)n + 1, fmt, ap);
  va_end(ap);
  omni_error(buf);
}

/* 用户显式 fail()：omni_str 不保证以 NUL 结尾，所以用 %.*s */
void omni_fail(omni_str msg) {
  fflush(stdout);
  fprintf(stderr, "omni: runtime error: %.*s\n", (int)msg.len, msg.p);
  exit(70);
}
