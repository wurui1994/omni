/* 第八刀第十片：真的文件（`fopen` / `fread` / `fgets` / `fseek` / `fclose`）。
 *
 * 用 `/tmp` 下一个固定的名字：两条腿跑同一份用例、写同一个文件，而工作目录不留东西。
 * 文件名不进 stdout，所以它不影响对账。
 *
 * 宿主那边是**整份快照**（`fopen` 时读进来、`fclose` 时落盘）—— 刻意的简化，
 * 见 ADR-0017 第八刀第十片。这一份用例只用「同一次运行里写出去再读回来」，
 * 那条路上快照与真的 IO 没有区别。
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *PATH = "/tmp/omni-c-gen36.txt";

int main(void) {
  /* ---- 写：三行，混着 fputs / fprintf / fwrite */
  FILE *w = fopen(PATH, "w");
  printf("open-w %d\n", w != NULL);
  fputs("first line\n", w);
  fprintf(w, "n=%d s=%s\n", 42, "mid");
  fwrite("last line\n", 1, 10, w);
  printf("close-w %d\n", fclose(w));

  /* ---- 读回来：fgets 一行一行 */
  FILE *r = fopen(PATH, "r");
  printf("open-r %d\n", r != NULL);
  char line[64];
  int no = 0;
  while (fgets(line, sizeof(line), r) != NULL) {
    no++;
    printf("line%d [%s] %d\n", no, line, (int)strlen(line));
  }
  printf("eof %d lines %d\n", feof(r) != 0, no);

  /* ---- 回到开头再来一遍：fseek 要清掉 eof 标志 */
  fseek(r, 0, SEEK_SET);
  printf("after-seek eof %d tell %ld\n", feof(r) != 0, ftell(r));

  /* ---- fread：回**成员个数**，读不满的那个成员不算 */
  char buf[8];
  size_t got = fread(buf, 3, 2, r);
  printf("fread %d [%.6s]\n", (int)got, buf);
  printf("tell %ld\n", ftell(r));

  /* ---- SEEK_END + ftell 就是文件长度 */
  fseek(r, 0, SEEK_END);
  long size = ftell(r);
  printf("size %ld\n", size);

  /* ---- SEEK_CUR 往回走 */
  fseek(r, -10, SEEK_CUR);
  fgets(line, sizeof(line), r);
  printf("tail [%s]", line);

  /* ---- 一个字符一个字符读到底，然后 feof */
  fseek(r, 0, SEEK_SET);
  int n = 0;
  int c;
  while ((c = fgetc(r)) != EOF) n++;
  printf("bytes %d eof %d\n", n, feof(r) != 0);

  /* ---- rewind 之后 fread 满一整份 */
  rewind(r);
  char *all = malloc((size_t)size + 1);
  size_t k = fread(all, 1, (size_t)size, r);
  all[k] = 0;
  printf("all %d %d\n", (int)k, (int)strlen(all));
  free(all);
  printf("close-r %d\n", fclose(r));

  /* ---- 打不开的一份：回 NULL */
  FILE *bad = fopen("/tmp/omni-c-gen36-nope/x.txt", "r");
  printf("missing %d\n", bad == NULL);

  /* ---- 追加模式：接在后面而不是清掉 */
  FILE *ap = fopen(PATH, "a");
  fputs("appended\n", ap);
  fclose(ap);
  FILE *r2 = fopen(PATH, "r");
  fseek(r2, 0, SEEK_END);
  printf("grew %d\n", ftell(r2) == size + 9);
  fclose(r2);

  return (int)(size % 100) + no;
}
