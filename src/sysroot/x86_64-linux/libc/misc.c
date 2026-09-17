/* misc.c — 时间、环境、进程、目录、信号那一摊（第一百四十片）。
 *
 * 这一份里**每一格都分得清**：
 *   真的实现了：clock_gettime / time / clock / getenv / setenv / fork / execvp /
 *               waitpid / system / kill / alarm / opendir / readdir / closedir /
 *               remove / realpath / mkdtemp / getrlimit / getrusage / atexit /
 *               localtime_r / strftime（UTC）/ strerror / sscanf（三种转换）/
 *               **sigaction**（第十五格，跳板 mmap+mprotect，见那一段的注释）
 *   回失败但不崩：backtrace 一族（诊断用，回 0 比崩好）、pthread 一族（回 EAGAIN ——
 *               调用方本来就有退路，见那一段）
 *   调到就崩：  dlopen 一族（`__libc_unimpl`）—— 悄悄回一个假句柄的后果是
 *               调用方拿着它往下跑，那比崩在原地坏得多。
 */
#include "libc.h"

/* `environ`：`_start` 那儿算出来的（argv 的终止空指针后面就是它）。 */
char **environ;

/* ---- 时间 */
struct __timespec { long sec; long nsec; };

int clock_gettime(int which, struct __timespec *ts) {
  return (int)__libc_check(__omni_syscall(SYS_clock_gettime, which, (long)ts));
}

long time(long *tp) {
  struct __timespec ts;
  ts.sec = 0; ts.nsec = 0;
  clock_gettime(0 /* CLOCK_REALTIME */, &ts);
  if (tp != (long *)0) *tp = ts.sec;
  return ts.sec;
}

/* `clock()`：CLOCKS_PER_SEC 在 glibc 上是 1000000，所以回微秒。
 * 用 CLOCK_PROCESS_CPUTIME_ID（2）—— 与 glibc 的 `clock()` 同一个钟。 */
long clock(void) {
  struct __timespec ts;
  ts.sec = 0; ts.nsec = 0;
  clock_gettime(2, &ts);
  return ts.sec * 1000000L + ts.nsec / 1000L;
}

/* ---- 环境变量。`environ` 是一串 `NAME=VALUE`。 */
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

/* `setenv`/`unsetenv`：`environ` 那张表可能是内核给的（改不动），所以第一次写的时候
 * 整表搬到堆上。表尾那格空指针留着。 */
static int envOwned;
static unsigned long envCount(void) {
  unsigned long n = 0;
  if (environ != (char **)0) while (environ[n] != (char *)0) n++;
  return n;
}
static int envOwn(void) {
  if (envOwned) return 0;
  unsigned long n = envCount();
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
  /* 尾巴上加一格：`envOwn` 多留了 8 格，用完再搬一次。 */
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

/* ---- 进程 */
int fork(void) { return (int)__libc_check(__omni_syscall(SYS_fork)); }
int kill(int pid, int sig) { return (int)__libc_check(__omni_syscall(SYS_kill, pid, sig)); }
int waitpid(int pid, int *status, int opts) {
  return (int)__libc_check(__omni_syscall(SYS_wait4, pid, (long)status, opts, 0));
}
int wait(int *status) { return waitpid(-1, status, 0); }

int execve(const char *path, char *const argv[], char *const envp[]) {
  return (int)__libc_check(__omni_syscall(SYS_execve, (long)path, (long)argv, (long)envp));
}

/* `execvp`：名字里有 `/` 就直接 execve，否则按 `PATH` 一段段试。 */
int execvp(const char *file, char *const argv[]) {
  if (strchr(file, '/') != (char *)0) return execve(file, argv, environ);
  const char *path = getenv("PATH");
  if (path == (const char *)0) path = "/usr/local/bin:/usr/bin:/bin";
  char buf[4096];
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

/* `system`：fork + `/bin/sh -c`。回的是 `waitpid` 那个原始状态字（与 glibc 一样）。 */
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

/* `alarm` 原先是「收下参数什么都不做」—— 那时 `sigaction` 回 ENOSYS，闹钟响了也没人接，
 * 于是干脆不设。现在 `sigaction` 是真的了，这一格也就该是真的（号 37）。 */
unsigned int alarm(unsigned int sec) {
  return (unsigned int)__omni_syscall(SYS_alarm, (long)sec);
}
int getpid(void) { return (int)__omni_syscall(SYS_getpid); }

/* ---- 目录：`getdents64`（217）。内核回的是一串变长记录：
 *   {u64 ino, i64 off, u16 reclen, u8 type, char name[]}  —— name 从第 19 字节起。
 * 我们把它包成 POSIX 的 `DIR`/`struct dirent`（后者按**我们自己头里的布局**）。 */
struct __dirent {
  unsigned long d_ino;
  long d_off;
  unsigned short d_reclen;
  unsigned char d_type;
  char d_name[256];
};
struct __DIR {
  int fd;
  int pos;
  int len;
  char buf[4096];
  struct __dirent ent;
};
typedef struct __DIR DIR;

DIR *opendir(const char *path) {
  int fd = open(path, 0 | 0200000 /* O_RDONLY | O_DIRECTORY */, 0);
  if (fd < 0) return (DIR *)0;
  DIR *d = (DIR *)malloc(sizeof(DIR));
  if (d == (DIR *)0) { close(fd); return (DIR *)0; }
  d->fd = fd; d->pos = 0; d->len = 0;
  return d;
}

struct __dirent *readdir(DIR *d) {
  if (d->pos >= d->len) {
    long r = __libc_check(__omni_syscall(217 /* getdents64 */, d->fd, (long)d->buf, 4096));
    if (r <= 0) return (struct __dirent *)0;
    d->len = (int)r;
    d->pos = 0;
  }
  char *rec = d->buf + d->pos;
  unsigned short reclen = *(unsigned short *)(rec + 16);
  /* `reclen == 0` 就当读完了。**同一类错刚在 malloc 上栽过**（`p += bsz` 里的
   * `bsz = 0` 原地转圈）：调用方是 `while (readdir(d) != 0)`，这儿一格不动就是
   * 一个永不结束的循环，而症状会出现在离这儿很远的地方。 */
  if (reclen == 0 || d->pos + (int)reclen > d->len) { d->pos = d->len; return (struct __dirent *)0; }
  d->pos += reclen;
  d->ent.d_ino = *(unsigned long *)rec;
  d->ent.d_off = *(long *)(rec + 8);
  d->ent.d_reclen = reclen;
  d->ent.d_type = *(unsigned char *)(rec + 18);
  const char *nm = rec + 19;
  unsigned long n = strlen(nm);
  if (n > 255) n = 255;
  memcpy(d->ent.d_name, nm, n);
  d->ent.d_name[n] = 0;
  return &d->ent;
}

int closedir(DIR *d) {
  int r = close(d->fd);
  free(d);
  return r;
}

/* ---- 文件系统的那几样 */
int unlink(const char *p);
int rmdir(const char *p);
int remove(const char *path) {
  int r = unlink(path);
  if (r == 0) return 0;
  return rmdir(path);            /* 是目录：`unlink` 回 EISDIR，换 `rmdir` */
}

/* `realpath`：`open(path, O_PATH)` 之后读 `/proc/self/fd/N` 那条符号链接 ——
 * 内核已经把 `.`/`..`/符号链接都解完了，所以这一格不用自己走路径。 */
long readlink(const char *path, char *buf, unsigned long n) {
  return __libc_check(__omni_syscall(89 /* readlink */, (long)path, (long)buf, (long)n));
}
char *realpath(const char *path, char *out) {
  int fd = open(path, 010000000 /* O_PATH */, 0);
  if (fd < 0) return (char *)0;
  char lnk[64];
  const char *pre = "/proc/self/fd/";
  unsigned long pl = strlen(pre);
  memcpy(lnk, pre, pl);
  int k = 0;
  char dg[16];
  int v = fd;
  if (v == 0) dg[k++] = '0';
  while (v > 0) { dg[k++] = (char)('0' + v % 10); v /= 10; }
  int j = 0;
  while (k > 0) lnk[pl + j++] = dg[--k];
  lnk[pl + j] = 0;
  char *buf = out != (char *)0 ? out : (char *)malloc(4096);
  if (buf == (char *)0) { close(fd); return (char *)0; }
  long r = readlink(lnk, buf, 4095);
  close(fd);
  if (r < 0) { if (out == (char *)0) free(buf); return (char *)0; }
  buf[r] = 0;
  return buf;
}

/* `mkdtemp`：把末尾六个 `X` 换成一串字符再 `mkdir`，撞了就换。
 * 「随机」是纳秒时钟加一格计数 —— 这一份里没有 `/dev/urandom` 那条路。 */
int mkdir(const char *p, unsigned int mode);
char *mkdtemp(char *tmpl) {
  unsigned long n = strlen(tmpl);
  if (n < 6) return (char *)0;
  static unsigned long seq;
  int tries = 0;
  while (tries < 128) {
    struct __timespec ts;
    ts.sec = 0; ts.nsec = 0;
    clock_gettime(1 /* CLOCK_MONOTONIC */, &ts);
    unsigned long v = (unsigned long)ts.nsec + seq * 7919UL + (unsigned long)tries * 104729UL;
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

/* ---- 资源（atexit / 时间的格式化 / errno 那张表 / sscanf 都挪去公用的 `pure.c` 了） */
int getrlimit(int which, void *rl) {
  return (int)__libc_check(__omni_syscall(97 /* getrlimit */, which, (long)rl));
}
int setrlimit(int which, const void *rl) {
  return (int)__libc_check(__omni_syscall(160 /* setrlimit */, which, (long)rl));
}
int getrusage(int who, void *ru) {
  return (int)__libc_check(__omni_syscall(98 /* getrusage */, who, (long)ru));
}

/* `atexit`：一张 32 格的表，`exit` 那边**倒着**调（C11 7.22.4.4 第 3 段）。
 * `__cxa_atexit` 也落这儿（多一个参数，我们不管 dso 那一格 —— 没有动态卸载）。 */
/* ---- 信号处理（第一百四十片第十五格）。**真的装得上了**。
 *
 * 之前这一格回 ENOSYS，理由写的是「要 SA_RESTORER 那个跳板，得等汇编器」。汇编器不用等 ——
 * 跳板是**运行时自己写出来的**：
 *
 * 一、为什么非要跳板。`rt_sigaction` 的内核结构里有一格 `restorer`，处理函数返回之后
 *     内核**跳到它**，它必须执行 `rt_sigreturn`（号 15）把被信号打断的上下文换回来。
 *     C 函数当不了这个跳板：任何序言都会动 rsp，而 `rt_sigreturn` 读的正是「进来时
 *     rsp 指着的那一帧」。所以它只能是两条指令、序言一个字节都不许有。
 * 二、于是不写在 .text 里，而是 `mmap` 一页可写的、把那 9 个字节填进去、再 `mprotect`
 *     成可执行：`48 c7 c0 0f 00 00 00`（mov rax, 15）+ `0f 05`（syscall）。
 *     一次装好存着，之后所有信号共用（内核只要它的地址）。
 * 三、用户那份 `struct sigaction` 与内核那份**不是同一个形状**：内核的是
 *     `{ handler, flags, restorer, mask }`（flags 在第二格！），mask 是 8 字节；
 *     用户那份是 `{ handler, mask[128], flags@136, restorer@144 }`（见 include/signal.h）。
 *     这一层就是那个翻译，外加 `sigsetsize = 8` 这个第四个参数（少了它内核回 EINVAL）。
 */
#define SA_RESTORER 0x04000000

struct __ksigaction {
  unsigned long handler;
  unsigned long flags;
  unsigned long restorer;
  unsigned long mask;
};

static unsigned long sigTramp;      /* 那 9 个字节在哪儿（0 = 还没要过） */

static unsigned long sigTrampGet(void) {
  if (sigTramp) return sigTramp;
  long p = __omni_syscall(SYS_mmap, 0, 4096, 3 /* READ|WRITE */,
                          0x22 /* PRIVATE|ANONYMOUS */, -1, 0);
  if (p < 0 && p >= -4095) return 0;
  unsigned char *c = (unsigned char *)p;
  c[0] = 0x48; c[1] = 0xc7; c[2] = 0xc0;             /* mov rax, imm32 */
  c[3] = 15; c[4] = 0; c[5] = 0; c[6] = 0;           /*   imm32 = 15 = rt_sigreturn */
  c[7] = 0x0f; c[8] = 0x05;                          /* syscall */
  long m = __omni_syscall(SYS_mprotect, p, 4096, 5 /* READ|EXEC */);
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
    if (t == 0) { __libc_errno_val = 38 /* ENOSYS */; return -1; }
    k.handler = *(const unsigned long *)a;
    k.mask = *(const unsigned long *)(a + 8);         /* 1..64 号就在头 64 位里 */
    k.flags = (unsigned long)(unsigned int)*(const int *)(a + 136);
    k.flags |= SA_RESTORER;
    k.restorer = t;
  }
  long r = __omni_syscall(SYS_rt_sigaction, sig, act ? (long)&k : 0,
                          old ? (long)&ko : 0, 8 /* sigsetsize */);
  if (r < 0 && r >= -4095) { __libc_errno_val = (int)-r; return -1; }
  if (old) {
    *(unsigned long *)o = ko.handler;
    for (int i = 0; i < 16; i++) ((unsigned long *)(o + 8))[i] = 0;
    *(unsigned long *)(o + 8) = ko.mask;
    *(int *)(o + 136) = (int)(unsigned int)(ko.flags & ~(unsigned long)SA_RESTORER);
    *(unsigned long *)(o + 144) = ko.restorer;
  }
  return 0;
}

/* `sigset_t` 是 16 个 64 位字（128 字节）。这三格原先是「回 0 什么都不做」——
 * 那是**假话**：没 memset 过的 set 会带着栈上的垃圾进内核。 */
int sigemptyset(void *set) {
  unsigned long *s = (unsigned long *)set;
  for (int i = 0; i < 16; i++) s[i] = 0;
  return 0;
}
int sigfillset(void *set) {
  unsigned long *s = (unsigned long *)set;
  for (int i = 0; i < 16; i++) s[i] = ~(unsigned long)0;
  return 0;
}
int sigaddset(void *set, int sig) {
  if (sig < 1 || sig > 1024) { __libc_errno_val = 22 /* EINVAL */; return -1; }
  ((unsigned long *)set)[(sig - 1) / 64] |= (unsigned long)1 << ((sig - 1) % 64);
  return 0;
}
int sigdelset(void *set, int sig) {
  if (sig < 1 || sig > 1024) { __libc_errno_val = 22 /* EINVAL */; return -1; }
  ((unsigned long *)set)[(sig - 1) / 64] &= ~((unsigned long)1 << ((sig - 1) % 64));
  return 0;
}
int sigismember(const void *set, int sig) {
  if (sig < 1 || sig > 1024) { __libc_errno_val = 22 /* EINVAL */; return -1; }
  return (((const unsigned long *)set)[(sig - 1) / 64]
    >> ((sig - 1) % 64)) & 1 ? 1 : 0;
}

/* ---- 调到就崩的那几格 */
void *dlopen(const char *p, int f) { (void)p; (void)f; __libc_unimpl("dlopen"); return (void *)0; }
void *dlsym(void *h, const char *n) { (void)h; (void)n; __libc_unimpl("dlsym"); return (void *)0; }
int dlclose(void *h) { (void)h; __libc_unimpl("dlclose"); return -1; }
char *dlerror(void) { return (char *)0; }
/* ---- 非局部跳转（第一百四十片第三格）。
 *
 * 薄薄一层：内容全在那两条 op 上（`mir/ir.js` 的 `SETJMP`）。存的是**这一层的调用者**
 * 接着往下走要的东西 —— 所以 `longjmp` 跳回去的落点是 `setjmp(...)` 那个调用点的下一条，
 * 与 glibc 那份汇编同一个效果。
 *
 * `jmp_buf` 是 200 字节（glibc 的尺寸，见 `include/setjmp.h`），我们只用头 64。 */
int setjmp(void *env) { return __omni_setjmp(env); }
void longjmp(void *env, int val) { __omni_longjmp(env, val); }
/* `sigsetjmp`/`siglongjmp`：`savemask` 现在**真的存**（第十七格）。
 *
 * 存哪儿：`jmp_buf` 是 200 字节，`__omni_setjmp` 只用头 64 —— 所以旗子放在偏移 168、
 * 掩码放在 176（两条腿都装得下：Linux 200、Darwin 192）。掩码只存头 64 位，因为
 * 我们能装的号就在 1..64 里。
 * 顺序要紧：`siglongjmp` **先把掩码换回来、再跳** —— 跳过去之后这一层的栈就没了。 */
int sigsetjmp(void *env, int savemask) {
  unsigned char *e = (unsigned char *)env;
  *(long *)(e + 168) = savemask ? 1 : 0;
  if (savemask) {
    unsigned long cur = 0;
    __omni_syscall(SYS_rt_sigprocmask, 0 /* SIG_BLOCK，set=0 只是问 */, 0, (long)&cur, 8);
    *(unsigned long *)(e + 176) = cur;
  }
  return __omni_setjmp(env);
}
void siglongjmp(void *env, int val) {
  unsigned char *e = (unsigned char *)env;
  if (*(long *)(e + 168)) {
    unsigned long m = *(unsigned long *)(e + 176);
    __omni_syscall(SYS_rt_sigprocmask, 2 /* SIG_SETMASK */, (long)&m, 0, 8);
  }
  __omni_longjmp(env, val);
}

/* `sigprocmask(how, set, old)`：`how` 是 0=BLOCK / 1=UNBLOCK / 2=SETMASK（Linux 的号，
 * 与 Darwin 的 1/2/3 **不一样** —— 各自那份头里定义）。内核那一层要 `sigsetsize=8`。 */
int sigprocmask(int how, const void *set, void *old) {
  unsigned long s = 0;
  unsigned long o = 0;
  if (set) s = *(const unsigned long *)set;
  long r = __omni_syscall(SYS_rt_sigprocmask, how, set ? (long)&s : 0,
                          old ? (long)&o : 0, 8);
  if (r < 0 && r >= -4095) { __libc_errno_val = (int)-r; return -1; }
  if (old) {
    unsigned long *po = (unsigned long *)old;
    for (int i = 0; i < 16; i++) po[i] = 0;
    po[0] = o;
  }
  return 0;
}
int sigpending(void *set) {
  unsigned long o = 0;
  long r = __omni_syscall(127 /* rt_sigpending */, (long)&o, 8);
  if (r < 0 && r >= -4095) { __libc_errno_val = (int)-r; return -1; }
  unsigned long *po = (unsigned long *)set;
  for (int i = 0; i < 16; i++) po[i] = 0;
  po[0] = o;
  return 0;
}

/* ---- 线程：**照约定回失败**，不崩。
 *
 * 真的实现要 `clone` + futex + TLS，那是另一件事。但「回失败」在这儿不是敷衍 ——
 * POSIX 说 `pthread_create` 失败回 `EAGAIN`，而我们的运行时**本来就写了退路**
 * （`omni_js_host.c:88`：开不出线程就直接调 `entry()`）。崩在这儿反而把一条本来
 * 走得通的路堵死。量到的：这一改之后 `fib.omni --libc self` 从 `rc=134`（abort）
 * 变成正常跑完。 */
int pthread_create(void *t, const void *a, void *(*fn)(void *), void *arg) {
  (void)t; (void)a; (void)fn; (void)arg;
  return 11;                        /* EAGAIN */
}
int pthread_join(unsigned long t, void **r) {
  (void)t; (void)r;
  return 3;                         /* ESRCH：没有这个线程 */
}
unsigned long pthread_self(void) { return 1; }
int pthread_attr_init(void *a) { (void)a; return 0; }
int pthread_attr_destroy(void *a) { (void)a; return 0; }
int pthread_attr_setstacksize(void *a, unsigned long n) { (void)a; (void)n; return 0; }
int pthread_attr_getstacksize(void *a, unsigned long *n) { (void)a; if (n) *n = 8388608; return 0; }
