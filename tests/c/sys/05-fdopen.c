/* 第八刀第二十四片：编出来的 tinycc 走到**产物**那一路上撞的那几格。
 *
 *   `open` 的第三个实参是**变参**   —— 产物的权限（0777 & ~umask），少这一格
 *                                      链接成功了但跑不起来
 *   `fdopen`                       —— tinycc 写产物是 `open` + `fdopen`
 *   `strpbrk`                      —— `.tbd`（SDK 的 dylib 存根）那个解析器
 *   `system`                       —— `codesign -f -s -`，arm64 macOS 上没签名跑不了
 *
 * 在 `sys/` 而不在 `gen/`：这几个的声明与 `O_*` / `S_I*` 的数值都在真的系统头里。 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/wait.h>

static const char *PATH = "/tmp/omni-fdopen-24.txt";

int main(void) {
  int sum = 0;

  /* ---- `open` 建、`fdopen` 包成 FILE*、`fprintf` 写、`fclose` 落盘 */
  int fd = open(PATH, O_WRONLY | O_CREAT | O_TRUNC, 0755);
  if (fd < 0) { printf("open failed\n"); return 1; }
  FILE *fp = fdopen(fd, "w");
  if (fp == NULL) { printf("fdopen failed\n"); return 2; }
  fprintf(fp, "one=%d two=%s\n", 42, "yes");
  if (fclose(fp) != 0) { printf("fclose failed\n"); return 3; }

  /* ---- 权限：第三个实参那 0755 过一次 umask（本机 022 -> 0755）。
   * 用 `test -x` 问而不是 `stat` —— 要的就是「可执行位在不在」这一格，
   * 而 `struct stat` 的字段布局是另一片的事。
   *
   * macOS 的 `WEXITSTATUS` 是 `(*(int *)&(x)) >> 8`，**要一个左值** ——
   * 所以先落进变量再问。 */
  int stx = system("test -x /tmp/omni-fdopen-24.txt");
  printf("exec=%d\n", WEXITSTATUS(stx));
  int stn = system("test -x /tmp/omni-fdopen-24.txt/nope");
  printf("noexec=%d\n", WEXITSTATUS(stn));

  /* ---- 读回来对一遍 */
  fp = fopen(PATH, "r");
  char buf[64];
  if (fgets(buf, sizeof(buf), fp) == NULL) { printf("fgets failed\n"); return 5; }
  fseek(fp, 0, SEEK_END);
  long size = ftell(fp);
  fclose(fp);
  printf("read %ld [%s]", size, buf);
  sum += (int)size;

  /* ---- `strpbrk`：找第一个落在那一组里的字符 */
  const char *s = "install-name: /usr/lib/libSystem.B.dylib\n";
  const char *p = strpbrk(s, "\n \"'");
  printf("pbrk=%ld [%c]\n", p == NULL ? -1L : (long)(p - s), p == NULL ? '?' : (*p == '\n' ? 'N' : *p));
  printf("pbrk2=%d pbrk3=%d\n", strpbrk("abc", "xyz") == NULL, strpbrk("abc", "") == NULL);
  sum += (int)(p - s);

  /* ---- `system`：回的是 `wait(2)` 那套编码，不是裸的退出码。
   * 子进程的输出**先**出来 —— 真的 `system` 不冲调用方的 stdio 缓冲。 */
  int st1 = system("exit 5");
  printf("sys1 %d %d\n", WIFEXITED(st1) != 0, WEXITSTATUS(st1));
  sum += WEXITSTATUS(st1);
  int st2 = system("printf 'from-the-shell\\n'");
  printf("sys2 %d %d\n", WIFEXITED(st2) != 0, WEXITSTATUS(st2));

  unlink(PATH);
  printf("sum=%d\n", sum);
  return sum & 0xff;
}
