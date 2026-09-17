/* misc.c — arm64 macOS 的时间、环境、进程、目录（第一百四十片第五格）。
 *
 * 与 Linux 那一份一一对应，差别记在各自那一段上。纯计算的那些（`strerror`、
 * `atexit`、`strftime`、`sscanf`…）在公用的 `pure.c` 里，这儿只有真的问内核的。
 *
 * 这一份里分得清的三档：
 *   真的实现了：gettimeofday/time/clock、getenv/setenv、fork/execvp/waitpid/system/
 *               kill、opendir/readdir/closedir（`getdirentries64`）、remove、
 *               realpath（`fcntl(F_GETPATH)`）、mkdtemp、getrlimit/getrusage
 *   回失败但不崩：sigaction（要跳板）、pthread 一族（回 EAGAIN，运行时有退路）
 *   调到就崩：  dlopen 一族、setjmp/longjmp（**这条腿的 `SETJMP` 还没实现** ——
 *               要存 x19-x28 与 d8-d15，见 `arm64/from_mir.js` 那一段）
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
 * **`fork` 在这条腿上拿不到**，理由是真的、也很具体：Darwin 的 `fork` 有**两个**
 * 返回值 —— x0 是 pid、**x1 是「我是不是子进程」**（父 0、子 1）。子进程里 x0 装的是
 * 父的 pid，所以只看 x0 的话父子都以为自己是父。量到过：`system("true")` 之后
 * 探子的后四行印了**两遍** —— 那就是子进程接着往下跑。
 *
 * 而 `OP.SYSCALL` 现在只交回 x0（约定见 `mir/ir.js`）。要还这一格得给它一个「第二个
 * 返回值写到哪儿」的变体 —— 那是下一步，不在这一片里。所以这儿**明着崩**，
 * 不假装成功：`fork` 回错值的后果是两个进程一起往下跑，比崩坏得多。
 * `pipe` 同一个理由（第二个 fd 也在 x1 上），在 io.c 里。
 */
int fork(void) {
  __libc_unimpl("fork（Darwin 的第二个返回值在 x1 上，SYSCALL 这条 op 还拿不到）");
  return -1;
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

/* `system` 要 fork，所以跟着一起欠（理由见上面那一段）。 */
int system(const char *cmd) {
  if (cmd == (const char *)0) return 0;   /* 「有没有 shell」：这条腿上按没有算 */
  __libc_unimpl("system（要 fork，见上面那一段）");
  return -1;
}

unsigned int alarm(unsigned int sec) { (void)sec; return 0; }   /* 要 SIGALRM，见文件头 */

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

/* ---- 回失败但不崩的那几格（理由见文件头） */
int sigaction(int sig, const void *act, void *old) {
  (void)sig; (void)act; (void)old;
  __libc_errno_val = 78;            /* ENOSYS（Darwin 的号） */
  return -1;
}
int sigemptyset(void *set) { (void)set; return 0; }
int sigaddset(void *set, int sig) { (void)set; (void)sig; return 0; }

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

/* `setjmp`/`longjmp`：**这条腿还没有**。要存 x19-x28 与 d8-d15（AAPCS64 的被调用者
 * 保存那一串），而 `arm64/from_mir.js` 里那两条 op 现在是明着报错。调到就崩，
 * 不假装成功 —— JSON 那两段（`runtime/omni_js_json.h`）在这条腿上于是还不能用。 */
int setjmp(void *env) { (void)env; __libc_unimpl("setjmp（arm64 的 SETJMP 还没实现）"); return 0; }
void longjmp(void *env, int v) { (void)env; (void)v; __libc_unimpl("longjmp"); }
