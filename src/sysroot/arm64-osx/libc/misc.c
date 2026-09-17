/* misc.c — arm64 macOS 的时间、环境、进程、目录（第一百四十片第五格）。
 *
 * 与 Linux 那一份一一对应，差别记在各自那一段上。纯计算的那些（`strerror`、
 * `atexit`、`strftime`、`sscanf`…）在公用的 `pure.c` 里，这儿只有真的问内核的。
 *
 * 这一份里分得清的三档：
 *   真的实现了：gettimeofday/time/clock、getenv/setenv、fork/execvp/waitpid/system/
 *               kill、opendir/readdir/closedir（`getdirentries64`）、remove、
 *               realpath（`fcntl(F_GETPATH)`）、mkdtemp、getrlimit/getrusage、
 *               setjmp/longjmp（后端那两条 op）、**sigaction**（第十六格，跳板 mmap+mprotect，
 *               见那一段注释）、alarm（`setitimer`）、getpid
 *   回失败但不崩：pthread 一族（回 EAGAIN，运行时有退路）
 *   调到就崩：  dlopen 一族
 */
#include "libc.h"

char **environ;

/* io.c 里那几个（这一份要用，声明在这儿一处）。 */
int unlink(const char *p);
int rmdir(const char *p);
int mkdir(const char *p, unsigned int mode);
long readlink(const char *p, char *buf, unsigned long n);

/* ---- 时间。Darwin 没有 `clock_gettime` 这个 syscall（那是 libSystem 走 commpage
 * 做的），所以走 `gettimeofday`（116）：秒 + 微秒。 */
struct __timeval { long sec; int usec; int pad; };

long time(long *tp) {
  struct __timeval tv;
  tv.sec = 0; tv.usec = 0;
  __omni_syscall(SYS_gettimeofday, (long)&tv, 0, 0);
  if (tp != (long *)0) *tp = tv.sec;
  return tv.sec;
}

/* `clock()`：CLOCKS_PER_SEC 是 1000000，所以回微秒。这儿用的是**墙上时间**
 * （Darwin 的 CPU 时间要 `getrusage`）—— 明说：与 glibc 的 `clock()` 语义不同。 */
long clock(void) {
  struct __timeval tv;
  tv.sec = 0; tv.usec = 0;
  __omni_syscall(SYS_gettimeofday, (long)&tv, 0, 0);
  return tv.sec * 1000000L + (long)tv.usec;
}

/* POSIX 的 `clock_gettime(which, ts)`：拿 `gettimeofday` 凑出来（纳秒位补 0 到微秒）。 */
struct __timespec { long sec; long nsec; };
int clock_gettime(int which, struct __timespec *ts) {
  (void)which;
  struct __timeval tv;
  tv.sec = 0; tv.usec = 0;
  long r = __libc_check(__omni_syscall(SYS_gettimeofday, (long)&tv, 0, 0));
  if (r < 0) return -1;
  ts->sec = tv.sec;
  ts->nsec = (long)tv.usec * 1000L;
  return 0;
}

/* ---- 环境变量（与 Linux 那一份同一份逻辑：`environ` 是一串 `NAME=VALUE`）。 */
char *getenv(const char *name) {
  if (environ == (char **)0) return (char *)0;
  unsigned long n = strlen(name);
  char **p = environ;
  while (*p != (char *)0) {
    const char *e = *p;
    unsigned long k = 0;
    while (k < n && e[k] == name[k]) k++;
    if (k == n && e[n] == '=') return (char *)(e + n + 1);
    p++;
  }
  return (char *)0;
}

static int envOwned;
static int envOwn(void) {
  if (envOwned) return 0;
  unsigned long n = 0;
  if (environ != (char **)0) while (environ[n] != (char *)0) n++;
  char **t = (char **)malloc((n + 8) * sizeof(char *));
  if (t == (char **)0) return -1;
  unsigned long i = 0;
  while (i < n) { t[i] = environ[i]; i++; }
  t[n] = (char *)0;
  environ = t;
  envOwned = 1;
  return 0;
}

int setenv(const char *name, const char *val, int overwrite) {
  if (envOwn() < 0) return -1;
  unsigned long nl = strlen(name);
  unsigned long vl = strlen(val);
  char *ent = (char *)malloc(nl + vl + 2);
  if (ent == (char *)0) return -1;
  memcpy(ent, name, nl);
  ent[nl] = '=';
  memcpy(ent + nl + 1, val, vl);
  ent[nl + vl + 1] = 0;
  unsigned long i = 0;
  while (environ[i] != (char *)0) {
    const char *e = environ[i];
    unsigned long k = 0;
    while (k < nl && e[k] == name[k]) k++;
    if (k == nl && e[nl] == '=') {
      if (!overwrite) { free(ent); return 0; }
      environ[i] = ent;
      return 0;
    }
    i++;
  }
  char **t = (char **)malloc((i + 9) * sizeof(char *));
  if (t == (char **)0) { free(ent); return -1; }
  unsigned long j = 0;
  while (j < i) { t[j] = environ[j]; j++; }
  t[i] = ent;
  t[i + 1] = (char *)0;
  environ = t;
  return 0;
}

int unsetenv(const char *name) {
  if (environ == (char **)0) return 0;
  if (envOwn() < 0) return -1;
  unsigned long nl = strlen(name);
  unsigned long i = 0;
  while (environ[i] != (char *)0) {
    const char *e = environ[i];
    unsigned long k = 0;
    while (k < nl && e[k] == name[k]) k++;
    if (k == nl && e[nl] == '=') {
      unsigned long j = i;
      while (environ[j] != (char *)0) { environ[j] = environ[j + 1]; j++; }
      continue;
    }
    i++;
  }
  return 0;
}

/* ---- 进程。
 *
 * `fork` 这一格是 Darwin 与 Linux 差得最开的地方：Darwin 的 `fork` 交回**两个**
 * 寄存器 —— x0 是 pid、**x1 是「我是不是子进程」**（父 0、子 1）。子进程里 x0 装的是
 * 父的 pid，所以只看 x0 的话父子都以为自己是父。量到过：`system("true")` 之后
 * 探子的后四行印了**两遍** —— 那就是子进程接着往下跑。
 *
 * 所以这一格要的是 `__omni_syscall2`（`OP.SYSCALL2`，见 `mir/ir.js`）：第二格是
 * 「第二个返回值写到哪儿」的地址，`svc` 之后后端补一条 `str x1, [x9]`。有了它，
 * 「我是谁」这一句就是读一个本地变量 —— 子进程读到的是它自己那份栈上的 1。
 *
 * `pipe` 同一个形状（两个 fd 在 x0/x1 上），在 io.c 里。
 */
int fork(void) {
  long child = 0;
  long pid = __libc_check(__omni_syscall2(SYS_fork, (long)&child));
  if (pid < 0) return -1;
  return child ? 0 : (int)pid;
}
int kill(int pid, int sig) { return (int)__libc_check(__omni_syscall(SYS_kill, pid, sig)); }
int waitpid(int pid, int *status, int opts) {
  return (int)__libc_check(__omni_syscall(SYS_wait4, pid, (long)status, opts, 0));
}
int wait(int *status) { return waitpid(-1, status, 0); }

int execve(const char *path, char *const argv[], char *const envp[]) {
  return (int)__libc_check(__omni_syscall(SYS_execve, (long)path, (long)argv, (long)envp));
}

int execvp(const char *file, char *const argv[]) {
  if (strchr(file, '/') != (char *)0) return execve(file, argv, environ);
  const char *path = getenv("PATH");
  if (path == (const char *)0) path = "/usr/bin:/bin:/usr/sbin:/sbin";
  char buf[1024];
  unsigned long fl = strlen(file);
  const char *p = path;
  while (1) {
    const char *e = p;
    while (*e && *e != ':') e++;
    unsigned long dl = (unsigned long)(e - p);
    if (dl + 1 + fl + 1 < sizeof(buf)) {
      memcpy(buf, p, dl);
      buf[dl] = '/';
      memcpy(buf + dl + 1, file, fl);
      buf[dl + 1 + fl] = 0;
      execve(buf, argv, environ);        /* 成功就不回来了 */
    }
    if (*e == 0) break;
    p = e + 1;
  }
  return -1;
}

/* `system`：fork + `/bin/sh -c` + wait，与 x86_64-linux 那一份逐行同形 —— 差别都在
 * `fork` 里（上面那一段），到这一层已经看不出来了。 */
int system(const char *cmd) {
  if (cmd == (const char *)0) return 1;         /* 「有没有 shell」：有 */
  int pid = fork();
  if (pid < 0) return -1;
  if (pid == 0) {
    char *av[4];
    av[0] = (char *)"/bin/sh";
    av[1] = (char *)"-c";
    av[2] = (char *)cmd;
    av[3] = (char *)0;
    execve("/bin/sh", av, environ);
    _exit(127);
  }
  int st = 0;
  waitpid(pid, &st, 0);
  return st;
}

/* `alarm` 原先是「收下参数什么都不做」—— 那时 `sigaction` 回 ENOSYS，闹钟响了也没人接。
 * 现在 `sigaction` 是真的了，这一格也补上：Darwin **没有 `alarm` 这个号**，走
 * `setitimer(ITIMER_REAL, …)`（83）。`struct itimerval` 是两个 `timeval`，
 * Darwin 的 `timeval` = `{long tv_sec; int tv_usec;}`（对齐到 8，所以一格 16 字节）。 */
unsigned int alarm(unsigned int sec) {
  unsigned long nv[4];
  unsigned long ov[4];
  nv[0] = 0; nv[1] = 0;                     /* it_interval：不重复 */
  nv[2] = (unsigned long)sec; nv[3] = 0;    /* it_value */
  for (int i = 0; i < 4; i++) ov[i] = 0;
  long r = __omni_syscall(SYS_setitimer, 0 /* ITIMER_REAL */, (long)nv, (long)ov);
  if (r < 0 && r >= -4095) { __libc_errno_val = (int)-r; return 0; }
  return (unsigned int)ov[2];               /* 上一个闹钟还剩几秒 */
}
int getpid(void) { return (int)__omni_syscall(SYS_getpid); }

/* ---- 目录：`getdirentries64`（344）。Darwin 回的记录是
 *   {u64 d_ino, u64 d_seekoff, u16 d_reclen, u16 d_namlen, u8 d_type, char d_name[]}
 * —— 名字从第 **21** 字节起（Linux 的 `getdents64` 是 19：那边没有 `d_namlen`）。
 * 这一格是「同一件事、两套记录」的典型，所以 opendir 一族只能是目标专有的。 */
struct __dirent {
  unsigned long d_ino;
  long d_off;
  unsigned short d_reclen;
  unsigned char d_type;
  char d_name[1024];
};
struct __DIR {
  int fd;
  int pos;
  int len;
  long seek;
  char buf[4096];
  struct __dirent ent;
};
typedef struct __DIR DIR;

DIR *opendir(const char *path) {
  int fd = open(path, 0x00100000 /* O_RDONLY | O_DIRECTORY(0x100000) */, 0);
  if (fd < 0) return (DIR *)0;
  DIR *d = (DIR *)malloc(sizeof(DIR));
  if (d == (DIR *)0) { close(fd); return (DIR *)0; }
  d->fd = fd; d->pos = 0; d->len = 0; d->seek = 0;
  return d;
}

struct __dirent *readdir(DIR *d) {
  if (d->pos >= d->len) {
    long r = __libc_check(__omni_syscall(SYS_getdirentries64, d->fd, (long)d->buf, 4096,
      (long)&d->seek));
    if (r <= 0) return (struct __dirent *)0;
    d->len = (int)r;
    d->pos = 0;
  }
  char *rec = d->buf + d->pos;
  unsigned short reclen = *(unsigned short *)(rec + 16);
  /* 与 Linux 那一份同一道守门（malloc 那一格的教训）：0 或越界就当读完。 */
  if (reclen == 0 || d->pos + (int)reclen > d->len) {
    d->pos = d->len;
    return (struct __dirent *)0;
  }
  d->pos += reclen;
  d->ent.d_ino = *(unsigned long *)rec;
  d->ent.d_off = *(long *)(rec + 8);
  d->ent.d_reclen = reclen;
  d->ent.d_type = *(unsigned char *)(rec + 20);
  unsigned short namlen = *(unsigned short *)(rec + 18);
  if (namlen > 1023) namlen = 1023;
  memcpy(d->ent.d_name, rec + 21, namlen);
  d->ent.d_name[namlen] = 0;
  return &d->ent;
}

int closedir(DIR *d) {
  int r = close(d->fd);
  free(d);
  return r;
}

/* ---- 文件系统的那几样 */
int remove(const char *path) {
  int r = unlink(path);
  if (r == 0) return 0;
  return rmdir(path);            /* 是目录：`unlink` 回 EPERM/EISDIR，换 `rmdir` */
}

/* `realpath`：Darwin 没有 `/proc`，走 `fcntl(fd, F_GETPATH, buf)`（F_GETPATH = 50，
 * 内核把这个 fd 的绝对路径写进那块 ≥ PATH_MAX 的地方）。 */
char *realpath(const char *path, char *out) {
  int fd = open(path, 0, 0);
  if (fd < 0) return (char *)0;
  char *buf = out != (char *)0 ? out : (char *)malloc(1024);
  if (buf == (char *)0) { close(fd); return (char *)0; }
  long r = __libc_check(__omni_syscall(SYS_fcntl, fd, 50 /* F_GETPATH */, (long)buf));
  close(fd);
  if (r < 0) { if (out == (char *)0) free(buf); return (char *)0; }
  return buf;
}

char *mkdtemp(char *tmpl) {
  unsigned long n = strlen(tmpl);
  if (n < 6) return (char *)0;
  static unsigned long seq;
  int tries = 0;
  while (tries < 128) {
    long t = clock();
    unsigned long v = (unsigned long)t + seq * 7919UL + (unsigned long)tries * 104729UL;
    seq++;
    int i = 0;
    while (i < 6) {
      const char *tab = "abcdefghijklmnopqrstuvwxyz0123456789";
      tmpl[n - 6 + i] = tab[v % 36];
      v /= 36;
      i++;
    }
    if (mkdir(tmpl, 0700) == 0) return tmpl;
    tries++;
  }
  return (char *)0;
}

/* ---- 资源 */
int getrlimit(int which, void *rl) {
  return (int)__libc_check(__omni_syscall(SYS_getrlimit, which, (long)rl));
}
int getrusage(int who, void *ru) {
  return (int)__libc_check(__omni_syscall(SYS_getrusage, who, (long)ru));
}

/* ---- 信号（第一百四十片第十六格）。**真的装得上了**，两条腿的做法不一样。
 *
 * Linux 那边内核跳 `restorer`，两条指令就够；Darwin 这边内核跳的是**用户给的
 * `sa_tramp`**，而且那个跳板要干三件事：把 x1（infostyle）、x4（uctx）、x5（token）
 * 存住，按 `handler(sig, siginfo, uctx)` 调过去，回来再 `sigreturn(uctx, infostyle,
 * token)`（号 184）。token 那一格是新内核要的，少了就拒。
 *
 * 跳板同样是**运行时自己写的机器码**（`mmap` 一页 → 填 15 条 arm64 指令 →
 * `mprotect` 成可执行）。Apple Silicon 上 W^X 是真的，但「先可写、再改成可执行」
 * 这条路对没上 hardened runtime 的进程是通的 —— 单开一格量过才敢这么写。
 *
 * 进内核那份结构（`struct __sigaction`，24 字节）与用户那份（16 字节，见
 * include/signal.h）不是一个形状：内核那份中间多一格 `sa_tramp`，`sa_mask` 是
 * **32 位**（Darwin 的 sigset_t 就是 `unsigned int`，所以只有 1..32 号）。 */
#define MOVX(d, s) (0xAA0003E0u | ((unsigned int)(s) << 16) | (unsigned int)(d))

struct __ksigaction {
  unsigned long handler;
  unsigned long tramp;
  unsigned int mask;
  int flags;
};

static unsigned long sigTramp;      /* 那一页在哪儿（0 = 还没要过） */

static unsigned long sigTrampGet(void) {
  if (sigTramp) return sigTramp;
  long p = __omni_syscall(SYS_mmap, 0, 16384, 3 /* READ|WRITE */,
                          0x1002 /* PRIVATE|ANON */, -1, 0);
  if (p < 0 && p >= -4095) return 0;
  unsigned int *c = (unsigned int *)p;
  int i = 0;
  c[i++] = MOVX(19, 0);                            /* x19 = handler */
  c[i++] = MOVX(20, 4);                            /* x20 = uctx */
  c[i++] = MOVX(21, 1);                            /* x21 = infostyle */
  c[i++] = MOVX(22, 5);                            /* x22 = token */
  c[i++] = MOVX(0, 2);                             /* x0 = sig */
  c[i++] = MOVX(1, 3);                             /* x1 = siginfo */
  c[i++] = MOVX(2, 20);                            /* x2 = uctx */
  c[i++] = 0xD63F0000u | (19u << 5);               /* blr x19 */
  c[i++] = MOVX(0, 20);
  c[i++] = MOVX(1, 21);
  c[i++] = MOVX(2, 22);
  c[i++] = 0xD2800000u | (184u << 5) | 16u;        /* movz x16, #184（sigreturn） */
  c[i++] = 0xF2A00000u | (0x200u << 5) | 16u;      /* movk x16, #0x200, lsl #16 */
  c[i++] = 0xD4001001u;                            /* svc #0x80 */
  c[i++] = 0xD4200000u;                            /* brk #0（sigreturn 不回来） */
  long m = __omni_syscall(SYS_mprotect, p, 16384, 5 /* READ|EXEC */);
  if (m < 0 && m >= -4095) return 0;
  sigTramp = (unsigned long)p;
  return sigTramp;
}

int sigaction(int sig, const void *act, void *old) {
  struct __ksigaction k;
  struct __ksigaction ko;
  const unsigned char *a = (const unsigned char *)act;
  unsigned char *o = (unsigned char *)old;
  if (act) {
    unsigned long t = sigTrampGet();
    if (t == 0) { __libc_errno_val = 78 /* ENOSYS */; return -1; }
    k.handler = *(const unsigned long *)a;
    k.mask = *(const unsigned int *)(a + 8);
    k.flags = *(const int *)(a + 12);
    k.tramp = t;
  }
  long r = __omni_syscall(SYS_sigaction, sig, act ? (long)&k : 0, old ? (long)&ko : 0);
  if (r < 0 && r >= -4095) { __libc_errno_val = (int)-r; return -1; }
  if (old) {
    *(unsigned long *)o = ko.handler;
    *(unsigned int *)(o + 8) = ko.mask;
    *(int *)(o + 12) = ko.flags;
  }
  return 0;
}

/* Darwin 的 `sigset_t` 是**一个 32 位字**（1..32 号），Linux 那边是 16 个 64 位字 ——
 * 所以这五格两条腿各一份，提不到公用的 `pure.c` 里去。原先那两格「回 0 什么都不做」
 * 是假话：没清过的 set 会带着栈上的垃圾进内核。 */
int sigemptyset(void *set) { *(unsigned int *)set = 0; return 0; }
int sigfillset(void *set) { *(unsigned int *)set = ~0u; return 0; }
int sigaddset(void *set, int sig) {
  if (sig < 1 || sig > 32) { __libc_errno_val = 22 /* EINVAL */; return -1; }
  *(unsigned int *)set |= 1u << (sig - 1);
  return 0;
}
int sigdelset(void *set, int sig) {
  if (sig < 1 || sig > 32) { __libc_errno_val = 22 /* EINVAL */; return -1; }
  *(unsigned int *)set &= ~(1u << (sig - 1));
  return 0;
}
int sigismember(const void *set, int sig) {
  if (sig < 1 || sig > 32) { __libc_errno_val = 22 /* EINVAL */; return -1; }
  return (*(const unsigned int *)set >> (sig - 1)) & 1 ? 1 : 0;
}

int pthread_create(void *t, const void *a, void *(*fn)(void *), void *arg) {
  (void)t; (void)a; (void)fn; (void)arg;
  return 35;                        /* EAGAIN（Darwin 的号）—— 调用方有退路 */
}
int pthread_join(unsigned long t, void **r) { (void)t; (void)r; return 3; }
unsigned long pthread_self(void) { return 1; }
int pthread_attr_init(void *a) { (void)a; return 0; }
int pthread_attr_destroy(void *a) { (void)a; return 0; }
int pthread_attr_setstacksize(void *a, unsigned long n) { (void)a; (void)n; return 0; }
int pthread_attr_getstacksize(void *a, unsigned long *n) { (void)a; if (n) *n = 8388608; return 0; }
/* Darwin 专有的那两个（运行时用它们问「主线程的栈有多大」）。 */
int pthread_main_np(void) { return 1; }
unsigned long pthread_get_stacksize_np(unsigned long t) { (void)t; return 8388608; }

/* ---- 调到就崩的那几格 */
void *dlopen(const char *p, int f) { (void)p; (void)f; __libc_unimpl("dlopen"); return (void *)0; }
void *dlsym(void *h, const char *n) { (void)h; (void)n; __libc_unimpl("dlsym"); return (void *)0; }
int dlclose(void *h) { (void)h; __libc_unimpl("dlclose"); return -1; }
char *dlerror(void) { return (char *)0; }

/* `setjmp`/`longjmp`：与 Linux 那一份**同一行代码**，差别全在后端（`OP.SETJMP` 存的是
 * x19-x28 与 d8-d15、调用者的 x29/sp 与返回地址，布局见 `arm64/from_mir.js`）。
 * `jmp_buf` 在这条腿上是 192 字节（`include/setjmp.h` 量的），我们只用头 168。 */
int setjmp(void *env) { return __omni_setjmp(env); }
void longjmp(void *env, int val) { __omni_longjmp(env, val); }
/* `sigsetjmp`/`siglongjmp`：信号掩码那一格我们没有（`sigaction` 都还回 ENOSYS），
 * 所以 `savemask` 收下就丢 —— 与 Linux 那一份同一个理由。 */
int sigsetjmp(void *env, int savemask) { (void)savemask; return __omni_setjmp(env); }
void siglongjmp(void *env, int val) { __omni_longjmp(env, val); }

/* ---- Darwin 的 `isnan` 一族（第一百四十片第八格）。
 *
 * 这八个名字是**头文件的账**，不是数学的账：Darwin 的 `<math.h>` 把 `isnan(x)` 展开成
 * `__isnand((double)x)`（我们那份 `include/math.h` 照着量到的外部符号写的，见它的文件头），
 * 而 glibc 展开成 `__isnan`。所以判断本身一份都不重写 —— 全在公用的 `math.c` 里，
 * 这儿只把名字接过去。float 那四个转成 double 再问：nan / inf / 符号位在放宽这一步
 * 都不会变。
 *
 * 为什么非要有：整份编译器（`dist/build/omni.c`）里 `isfinite` 是真有人用的，量到过
 * `macho: 符号 '___isfinited' 没有定义` —— 链接那一步才说话。 */
int __isnan(double x);
int __isinf(double x);
int __finite(double x);
int __signbit(double x);

int __isnand(double x) { return __isnan(x); }
int __isnanf(float x) { return __isnan((double)x); }
int __isinfd(double x) { return __isinf(x); }
int __isinff(float x) { return __isinf((double)x); }
int __isfinited(double x) { return __finite(x); }
int __isfinitef(float x) { return __finite((double)x); }
int __signbitd(double x) { return __signbit(x); }
int __signbitf(float x) { return __signbit((double)x); }
