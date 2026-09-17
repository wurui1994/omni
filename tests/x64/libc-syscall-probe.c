/* 自带 libc 的「问内核那一层」判据：**每一格都真的调一次**。
 *
 * 为什么单独一份：`libc-sys-probe.c` 比的是「输出与平台 libc 逐行相同」，所以它只能装
 * 两边行为一样的那些格子。可**调用号本身对不对**是另一类账 —— 号错了的症状不是输出不同，
 * 是当场 SIGSYS（`Bad system call: 12`），而且离病根很远：量到过整份编译器一起来就死，
 * 而真凶只是 `getcwd` 那一个号（326 在 arm64 macOS 上无效，Apple 自己的
 * `syscall(326, …)` 也一样崩）。
 *
 * 所以这一份的形状是「一行一格，自己判自己」：死在第几行就是第几格的号或摆法不对。
 * 断言只挑**两边都成立**的那些（`/tmp` 在不在、回值是不是 0），不比具体数字。
 *
 * 跑法见 `tests/c/libc-self.js`（本机 arm64 macOS 上自己编自己链自己跑）。
 */
int printf(const char *, ...);
long time(long *);
int clock_gettime(int, void *);
char *getcwd(char *, unsigned long);
int isatty(int);
int access(const char *, int);
int stat(const char *, void *);
long readlink(const char *, char *, unsigned long);
int getrlimit(int, void *);
int getrusage(int, void *);
int kill(int, int);
char *realpath(const char *, char *);

static int pass = 0;
static int fail = 0;

static void gate(const char *name, int ok) {
  if (ok) { pass++; printf("ok   %s\n", name); }
  else { fail++; printf("FAIL %s\n", name); }
}

int main(void) {
  char buf[4096];
  char st[256];                 /* struct stat / rusage / rlimit 都装得下 */
  gate("time", time(0) > 1000000000L);
  gate("clock_gettime", clock_gettime(0, st) == 0);
  char *cwd = getcwd(buf, sizeof(buf));
  gate("getcwd", cwd != 0 && cwd[0] == '/');
  isatty(1);                    /* 回什么看有没有终端，这一格只问「不崩」 */
  gate("isatty（只问不崩）", 1);
  gate("access(/tmp)", access("/tmp", 0) == 0);
  gate("stat(/tmp)", stat("/tmp", st) == 0);
  readlink("/tmp", buf, sizeof(buf));   /* macOS 上是 11、Linux 上 -1 —— 不比值 */
  gate("readlink（只问不崩）", 1);
  gate("getrlimit(RLIMIT_STACK)", getrlimit(3, st) == 0);
  gate("getrusage(SELF)", getrusage(0, st) == 0);
  gate("kill(0, 0)", kill(0, 0) == 0);
  char *rp = realpath("/tmp", buf);
  gate("realpath(/tmp)", rp != 0 && rp[0] == '/');
  printf("%d passed, %d failed\n", pass, fail);
  return fail == 0 ? 0 : 1;
}
