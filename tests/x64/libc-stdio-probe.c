/* `FILE *` 那一层的逐行对账：打开模式、fread/fwrite 的 size×n 语义、fseek/ftell 的三种
 * whence、rewind、fgets 的三种收尾、fgetc/ungetc、feof/ferror/clearerr、
 * fputs/fputc/puts、fflush、fprintf/fscanf 到文件、带 NUL 的二进制块。
 *
 * 与「系统那一半」那份探子的分工：那一份问的是「这些调用通不通」，这一份问的是
 * **边角的语义对不对** —— 比如 `fread(buf, 3, 5, f)` 在只剩 7 字节时该回 2（不是 7/3）、
 * `fgets` 读到不带换行的末尾该把内容留下并回 buf、`ungetc` 退回来的那一个字节
 * 下一次 `fgetc` 必须先看见。
 */
int printf(const char *, ...);
void *fopen(const char *, const char *);
int fclose(void *);
unsigned long fread(void *, unsigned long, unsigned long, void *);
unsigned long fwrite(const void *, unsigned long, unsigned long, void *);
int fseek(void *, long, int);
long ftell(void *);
void rewind(void *);
int fgetc(void *);
int ungetc(int, void *);
char *fgets(char *, int, void *);
int fputs(const char *, void *);
int fputc(int, void *);
int puts(const char *);
int fflush(void *);
int feof(void *);
int ferror(void *);
void clearerr(void *);
int fprintf(void *, const char *, ...);
int fscanf(void *, const char *, ...);
int remove(const char *);

#define PATH "/tmp/omni-stdio-probe.txt"

int main(void) {
  /* 1. 写：fputs / fputc / fprintf / fwrite（带 NUL 的块） */
  void *f = fopen(PATH, "w");
  printf("fopen w: %d\n", f != 0);
  printf("fputs: %d\n", fputs("line one\n", f) >= 0);
  fputc('x', f);
  fputc('\n', f);
  printf("fprintf: %d\n", fprintf(f, "n=%d s=%s\n", 42, "abc"));
  char bin[6];
  bin[0] = 'A'; bin[1] = 0; bin[2] = 'B'; bin[3] = 0; bin[4] = 'C'; bin[5] = '\n';
  printf("fwrite: %lu\n", fwrite(bin, 1, 6, f));
  printf("fflush: %d\n", fflush(f));
  printf("fclose: %d\n", fclose(f));

  /* 2. 读：fgets 的三种收尾 + ftell */
  f = fopen(PATH, "r");
  char buf[64];
  printf("fgets 1: %d 「%s」\n", fgets(buf, sizeof(buf), f) != 0, buf);
  printf("ftell 之后: %ld\n", ftell(f));
  printf("fgets n=2: 「%s」\n", fgets(buf, 2, f) != 0 ? buf : "(null)");
  printf("fgets 剩下: 「%s」\n", fgets(buf, sizeof(buf), f) != 0 ? buf : "(null)");

  /* 3. fseek 三种 whence + fread 的 size×n。
   *
   * **一句里只许有一处副作用**：第一版写的是
   *   `printf("... %d ftell=%ld\n", fseek(f, 0, 2) == 0, ftell(f));`
   * 实参的求值次序在 C 里是**未定的** —— 我们的前端从左往右（先 seek 再 ftell），
   * 而 Linux 上 gcc 编出来的是从右往左（先 ftell 再 seek），于是同一份探子两边差三行。
   * 那三行差**不是 libc 的账，是探子自己的账**（一开始还以为是「两把尺子彼此不一样」）。
   * 所以这儿一律先做、再问、再印。 */
  int r1 = fseek(f, 0, 2);
  long p1 = ftell(f);
  printf("fseek END: %d ftell=%ld\n", r1 == 0, p1);
  int r2 = fseek(f, 0, 0);
  long p2 = ftell(f);
  printf("fseek SET 0: %d ftell=%ld\n", r2 == 0, p2);
  int r3 = fseek(f, 4, 1);
  long p3 = ftell(f);
  printf("fseek CUR +4: %d ftell=%ld\n", r3 == 0, p3);
  rewind(f);
  long p4 = ftell(f);
  printf("rewind 之后 ftell=%ld\n", p4);
  char blk[32];
  /* 文件一共 28 字节。`fread(blk, 3, 5, f)` 回的是**整格**的个数。 */
  unsigned long got = fread(blk, 3, 5, f);
  long p5 = ftell(f);
  printf("fread(3, 5) -> %lu 格，ftell=%ld\n", got, p5);

  /* 4. fgetc / ungetc（位置摆在开头，读一个再退回去） */
  rewind(f);
  int c1 = fgetc(f);
  printf("fgetc: %c\n", c1);
  printf("ungetc: %d\n", ungetc(c1, f) == c1);
  int c2 = fgetc(f);
  printf("退回来的那一个先看见: %d\n", c1 == c2);

  /* 5. 一路读到头：feof / ferror / clearerr */
  int n = 0;
  while (fgetc(f) >= 0) n++;
  printf("读到头: 又读了 %d 个 feof=%d ferror=%d\n", n, feof(f) != 0, ferror(f));
  clearerr(f);
  printf("clearerr 之后: feof=%d\n", feof(f));
  fclose(f);

  /* 6. 追加模式 + fscanf */
  f = fopen(PATH, "a");
  fprintf(f, "77 88\n");
  fclose(f);
  f = fopen(PATH, "r");
  fseek(f, -6, 2);
  int a = 0;
  int b = 0;
  int nf = fscanf(f, "%d %d", &a, &b);
  printf("fscanf %d: %d %d\n", nf, a, b);
  fclose(f);

  /* 7. 打不开的那一路 */
  void *bad = fopen("/no/such/dir/x.txt", "r");
  printf("fopen 失败回 0: %d\n", bad == 0);
  printf("remove: %d\n", remove(PATH));
  puts("puts 收尾");
  return 0;
}
