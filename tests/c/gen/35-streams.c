/* 第八刀第九片：三条标准流（`stdout` / `stderr` / `FILE`）。
 *
 * 这一片**只有那三条**，真的文件（`fopen`）是下一片。
 *
 * 它同时改了测试轴的口径：在这之前 `gen/` 那一组把「tcc 的 stderr 非空」一律当成
 * 「tcc 拒了这份用例」，而这一份用例正是要往 stderr 写字。现在 stderr 也逐字节对账
 * （`tests/c/run.js` 的 `isTccDiag`）。
 */
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

/* 往 stderr 写诊断 —— tinycc 自己的源码满地都是这个形状 */
static void warn(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  fprintf(stderr, "warning: ");
  vfprintf(stderr, fmt, ap);
  va_end(ap);
}

int main(void) {
  /* ---- fprintf 到 stdout：与 printf 是同一条流 */
  printf("via printf\n");
  fprintf(stdout, "via fprintf %d %s\n", 7, "str");

  /* ---- fputs 不补换行（与 puts 不同），回的只保证非负 */
  int r = fputs("fputs", stdout);
  fputs("-more\n", stdout);
  printf("fputs %d\n", r >= 0);

  /* ---- fputc 回写下去的那个字符 */
  int c = fputc('X', stdout);
  fputc('\n', stdout);
  printf("fputc %d\n", c);

  /* ---- fwrite 回的是**成员个数**，不是字节数 */
  char buf[9] = "abcdefgh";
  size_t got = fwrite(buf, 2, 4, stdout);
  fputc('\n', stdout);
  printf("fwrite %d\n", (int)got);
  /* 长度是 0 的一次：什么都不写，回 0 */
  printf("zero %d\n", (int)fwrite(buf, 0, 4, stdout));

  /* ---- fflush 认 NULL（所有流一起冲） */
  printf("before flush\n");
  fflush(stdout);
  fflush(NULL);

  /* ---- 三条流的句柄互不相同，而且都不是 NULL */
  printf("handles %d %d %d\n",
    stdout != NULL, stderr != NULL, stdout != stderr);

  /* ---- stderr：这几行进的是另一条流，与上面那些不在同一份对账里 */
  fprintf(stderr, "to stderr %d\n", 42);
  fputs("fputs to stderr\n", stderr);
  warn("in %s at %d\n", "here", 3);

  return (int)strlen("streams") + (r >= 0) + (int)got;
}
