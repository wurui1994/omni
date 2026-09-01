/* SDK 的三条标准流（第八刀第十七片）。
 *
 * SDK 的 `<stdio.h>` 里 `stdout` 是 `__stdoutp` —— 一个**外部全局量**
 * （`extern FILE *`），不是我们自带那份头文件里的 `__omni_stdout()`。
 * 这一份用例证的就是「宿主填的全局量」这条路：data 段里一格，入口处一条
 * `__omni_stream_init` 把句柄写进去。
 *
 * stdout 与 stderr 在测试轴上分开对账（我们的 stdout 带缓冲、stderr 直写，
 * 终端上两条流的交错与 tcc 那边相反 —— 这一条是刻意的，见 libc.js 的 streamWrite）。 */
#include <stdio.h>
#include <string.h>

int main(void) {
  fprintf(stdout, "out %d\n", 7);
  fputs("via fputs\n", stdout);
  fprintf(stderr, "err %s\n", "here");
  fputc('x', stdout);
  fputc('\n', stdout);
  fprintf(stdout, "%d\n", (int)strlen("stdout 也是一格"));
  return 5;
}
