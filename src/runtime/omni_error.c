/* 运行时错误：统一走 stderr + 退出码 70，并且先 fflush(stdout)，
   否则 stdout 的缓冲会让错误消息跑到正常输出前面 —— JS 后端的 $rt_error 也是先 $flush()。

   `OMNI_NULLCK_IMPL_TU`：omni.h 里 `omni_nullck` 有一个**同名的宏**（见那儿的注：
   -O0 与 tcc 都不内联 static inline，而它是生成代码里最密的一个调用）。这个 TU 要
   定义的正是那个真符号（run-llvm 那条腿 call 它），所以在 include 之前把宏关掉。 */
#define OMNI_NULLCK_IMPL_TU 1
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

/* 空引用与下标越界这两句单独出成函数：omni.h 里的 omni_nullck / omni_arr_blob_at_i
   是**宏**（理由见那儿），而它们的展开点有上万个 —— 冷路径留在宏里就是把消息串与
   omni_errorf 的实参复制上万份，预处理后的那份 .c 会翻倍。消息逐字不变。 */
void omni_err_null(void) { omni_error("null reference"); }

/* `omni_nullck` 的真符号（宏在这个 TU 里是关掉的）。run-llvm 那条腿只能 call 符号，
   所以这一份必须在；C 那条腿走的是 omni.h 里那个同名宏，一次调用都不发。 */
void *omni_nullck(void *p) {
  if (!p) omni_err_null();
  return p;
}

void omni_err_range(int64_t i, int64_t len) {
  omni_errorf("array index out of range: %lld (length %lld)", (long long) i,
              (long long) len);
}
