/* 自带 libc 的「系统那一半」判据：文件、目录、时间、环境、进程。
 * 与 glibc 那份逐行比（时间那一行只比格式，不比值）。 */
int printf(const char *fmt, ...);
void *fopen(const char *, const char *);
unsigned long fwrite(const void *, unsigned long, unsigned long, void *);
unsigned long fread(void *, unsigned long, unsigned long, void *);
int fclose(void *);
int fseek(void *, long, int);
long ftell(void *);
int remove(const char *);
int mkdir(const char *, unsigned int);
int rmdir(const char *);
void *opendir(const char *);
void *readdir(void *);
int closedir(void *);
char *getenv(const char *);
int setenv(const char *, const char *, int);
int system(const char *);
int pipe(int *);
long write(int, const void *, unsigned long);
long read(int, void *, unsigned long);
int close(int);
long time(long *);
unsigned long strftime(char *, unsigned long, const char *, const void *);
void *localtime(const long *);
int atexit(void (*)(void));
char *strerror(int);
int sscanf(const char *, const char *, ...);
int setjmp(void *);
void longjmp(void *, int);

/* `jmp_buf` 两条腿上不一样大（Linux 200、Darwin 192），而这份探子两边共用 ——
 * 所以自己开一块 256 字节的，比两边都大。 */
static long jb[32];

static void bye(void) { printf("atexit 跑了\n"); }

/* 递归三层再 `longjmp` 回去：跳过的那三个帧是「sp 有没有收回去」的判据。 */
static void deep(int n) {
  if (n > 0) {
    deep(n - 1);
    return;
  }
  longjmp(jb, 7);
}

int main(void) {
  /* 1. 文件 */
  void *f = fopen("/tmp/omni-probe.txt", "w");
  printf("fopen w: %d\n", f != 0);
  fwrite("hello libc", 1, 10, f);
  fclose(f);
  char buf[32];
  f = fopen("/tmp/omni-probe.txt", "r");
  unsigned long n = fread(buf, 1, 31, f);
  buf[n] = 0;
  printf("fread %lu: %s ftell=%ld\n", n, buf, ftell(f));
  fseek(f, 6, 0);
  n = fread(buf, 1, 31, f);
  buf[n] = 0;
  printf("fseek+fread: %s\n", buf);
  fclose(f);
  printf("remove: %d\n", remove("/tmp/omni-probe.txt"));

  /* 2. 目录 */
  printf("mkdir: %d\n", mkdir("/tmp/omni-probe-dir", 0755));
  void *d = opendir("/tmp/omni-probe-dir");
  int cnt = 0;
  while (readdir(d) != 0) cnt++;
  closedir(d);
  printf("readdir 条数（. 与 ..）: %d\n", cnt);
  printf("rmdir: %d\n", rmdir("/tmp/omni-probe-dir"));

  /* 3. 环境 */
  printf("PATH 有没有: %d\n", getenv("PATH") != 0);
  setenv("OMNI_PROBE", "42", 1);
  printf("setenv/getenv: %s\n", getenv("OMNI_PROBE"));

  /* 4. 时间（只看格式对不对） */
  long t = time(0);
  char ts[64];
  unsigned long k = strftime(ts, sizeof(ts), "%Y-%m-%d %H:%M:%S", localtime(&t));
  printf("strftime %lu 字符，年份四位: %d\n", k,
    ts[0] >= '2' && ts[4] == '-' && ts[7] == '-' && ts[13] == ':');

  /* 5. 进程与管道。这两格是 Darwin 与 Linux 差得最开的地方（`fork` 的第二个返回值在
   *    x1、`pipe` 的两个 fd 都在寄存器上），所以**两边跑同一段**、逐行比。 */
  printf("system(true) 状态字: %d\n", system("true"));
  int fd[2];
  int pr = pipe(fd);
  char pb[16];
  long wn = write(fd[1], "pipe ok", 7);
  long rn = read(fd[0], pb, 15);
  pb[rn < 0 ? 0 : rn] = 0;
  close(fd[0]);
  close(fd[1]);
  printf("pipe %d: 写 %ld 读 %ld 「%s」\n", pr, wn, rn, pb);

  /* 6. 杂 */
  printf("strerror(2): %s\n", strerror(2));
  int a = 0; double b = 0.0; char w[16];
  int got = sscanf("17 2.5 abc", "%d %lf %s", &a, &b, w);
  printf("sscanf %d: %d %.1f %s\n", got, a, b, w);
  /* 7. setjmp/longjmp。两条腿上要存的东西完全不同（x86_64 是 rbx/r12-r15，
   *    arm64 是 x19-x28 与 d8-d15），可**看得见的行为只有一个**，所以照旧逐行比。
   *    `deep` 递归三层再跳回来 —— 跳过的三个帧就是「sp 收回去了没有」的判据。 */
  volatile int stage = 0;
  int r = setjmp(jb);
  if (r == 0) {
    stage = 1;
    deep(3);
    printf("到不了这儿\n");
  }
  printf("setjmp/longjmp: r=%d stage=%d\n", r, stage);
  int z = setjmp(jb);
  if (z == 0) longjmp(jb, 0);       /* C11 7.13.2.1：0 要换成 1 */
  printf("longjmp(0) 换成: %d\n", z);

  atexit(bye);
  return 0;
}
