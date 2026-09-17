/* misc.c — 时间、环境、进程、目录、信号那一摊（第一百四十片）。
 *
 * 这一份里**每一格都分得清**：
 *   真的实现了：clock_gettime / time / clock / getenv / setenv / fork / execvp /
 *               waitpid / system / kill / alarm / opendir / readdir / closedir /
 *               remove / realpath / mkdtemp / getrlimit / getrusage / atexit /
 *               localtime_r / strftime（UTC）/ strerror / sscanf（三种转换）
 *   回失败但不崩：sigaction（要 SA_RESTORER 那个跳板，得等汇编器）、
 *               backtrace 一族（诊断用，回 0 比崩好）、pthread 一族（回 EAGAIN ——
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

unsigned int alarm(unsigned int sec) { (void)sec; return 0; }   /* 要 SIGALRM，见文件头 */

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

/* ---- 资源与 atexit */
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
#define ATEXIT_MAX 32
static void (*atexitFns[ATEXIT_MAX])(void);
static int atexitN;
int atexit(void (*fn)(void)) {
  if (atexitN >= ATEXIT_MAX) return -1;
  atexitFns[atexitN++] = fn;
  return 0;
}
int __cxa_atexit(void (*fn)(void *), void *arg, void *dso) {
  (void)arg; (void)dso;
  return atexit((void (*)(void))fn);
}
void __libc_run_atexit(void) {
  while (atexitN > 0) {
    atexitN--;
    atexitFns[atexitN]();
  }
}

/* ---- 时间的「掰成年月日」那一半（UTC，没有时区文件）。
 * 天数 -> 年月日用的是 civil_from_days 那条封闭公式（把三月当年初，于是闰年的那一天
 * 落在末尾，一个分支都不用）。 */
struct __tm {
  int tm_sec, tm_min, tm_hour, tm_mday, tm_mon, tm_year;
  int tm_wday, tm_yday, tm_isdst;
  long tm_gmtoff;
  const char *tm_zone;
};

struct __tm *gmtime_r(const long *tp, struct __tm *tm) {
  long t = *tp;
  long days = t / 86400;
  long rem = t % 86400;
  if (rem < 0) { rem += 86400; days--; }
  tm->tm_hour = (int)(rem / 3600);
  tm->tm_min = (int)((rem % 3600) / 60);
  tm->tm_sec = (int)(rem % 60);
  tm->tm_wday = (int)((days + 4) % 7);          /* 1970-01-01 是星期四 */
  if (tm->tm_wday < 0) tm->tm_wday += 7;
  long z = days + 719468;                        /* 挪到 0000-03-01 起 */
  long era = (z >= 0 ? z : z - 146096) / 146097;
  unsigned long doe = (unsigned long)(z - era * 146097);
  unsigned long yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  long y = (long)yoe + era * 400;
  unsigned long doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  unsigned long mp = (5 * doy + 2) / 153;
  unsigned long d = doy - (153 * mp + 2) / 5 + 1;
  unsigned long m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) y++;
  tm->tm_year = (int)(y - 1900);
  tm->tm_mon = (int)m - 1;
  tm->tm_mday = (int)d;
  /* yday：从当年 1 月 1 日起的天数。用「当年 1 月 1 日的 days」反推。 */
  static const int cum[12] = { 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334 };
  int leap = ((y % 4 == 0 && y % 100 != 0) || y % 400 == 0) ? 1 : 0;
  tm->tm_yday = cum[tm->tm_mon] + (int)d - 1 + ((tm->tm_mon > 1) ? leap : 0);
  tm->tm_isdst = 0;
  tm->tm_gmtoff = 0;
  tm->tm_zone = "UTC";
  return tm;
}
/* 没有时区数据库，所以本地时间**就是 UTC**（明说：`%Z` 印出来是 UTC）。 */
struct __tm *localtime_r(const long *tp, struct __tm *tm) { return gmtime_r(tp, tm); }
static struct __tm tmStatic;
struct __tm *localtime(const long *tp) { return localtime_r(tp, &tmStatic); }
struct __tm *gmtime(const long *tp) { return gmtime_r(tp, &tmStatic); }

/* `strftime`：只认我们的运行时用得到的那几个转换 —— `%Y %m %d %H %M %S %y %j %Z %%`
 * 加 `%F`（= `%Y-%m-%d`）与 `%T`（= `%H:%M:%S`）。别的原样留着（不猜）。 */
int snprintf(char *buf, unsigned long n, const char *fmt, ...);
unsigned long strftime(char *buf, unsigned long cap, const char *fmt, const struct __tm *tm) {
  unsigned long k = 0;
  const char *p = fmt;
  while (*p && k + 1 < cap) {
    if (*p != '%') { buf[k++] = *p++; continue; }
    p++;
    char two[8];
    const char *w = (const char *)0;
    int num = -1;
    int width = 2;
    if (*p == 'Y') { num = tm->tm_year + 1900; width = 4; }
    else if (*p == 'y') num = (tm->tm_year + 1900) % 100;
    else if (*p == 'm') num = tm->tm_mon + 1;
    else if (*p == 'd') num = tm->tm_mday;
    else if (*p == 'H') num = tm->tm_hour;
    else if (*p == 'M') num = tm->tm_min;
    else if (*p == 'S') num = tm->tm_sec;
    else if (*p == 'j') { num = tm->tm_yday + 1; width = 3; }
    else if (*p == 'Z') w = "UTC";
    else if (*p == '%') w = "%";
    else if (*p == 'F') {
      k += (unsigned long)snprintf(buf + k, cap - k, "%04d-%02d-%02d",
        tm->tm_year + 1900, tm->tm_mon + 1, tm->tm_mday);
      p++;
      continue;
    } else if (*p == 'T') {
      k += (unsigned long)snprintf(buf + k, cap - k, "%02d:%02d:%02d",
        tm->tm_hour, tm->tm_min, tm->tm_sec);
      p++;
      continue;
    } else { buf[k++] = '%'; if (*p) buf[k++] = *p; if (*p) p++; continue; }
    if (num >= 0) {
      snprintf(two, sizeof(two), width == 4 ? "%04d" : (width == 3 ? "%03d" : "%02d"), num);
      w = two;
    }
    while (*w && k + 1 < cap) buf[k++] = *w++;
    p++;
  }
  if (k < cap) buf[k] = 0;
  return k;
}

/* ---- errno 那张表。只列我们自己回得出来的那些（别的印号）。 */
static const char *ERRTAB[35] = {
  "Success", "Operation not permitted", "No such file or directory",
  "No such process", "Interrupted system call", "Input/output error",
  "No such device or address", "Argument list too long", "Exec format error",
  "Bad file descriptor", "No child processes", "Resource temporarily unavailable",
  "Cannot allocate memory", "Permission denied", "Bad address",
  "Block device required", "Device or resource busy", "File exists",
  "Invalid cross-device link", "No such device", "Not a directory",
  "Is a directory", "Invalid argument", "Too many open files in system",
  "Too many open files", "Inappropriate ioctl for device", "Text file busy",
  "File too large", "No space left on device", "Illegal seek",
  "Read-only file system", "Too many links", "Broken pipe",
  "Numerical argument out of domain", "Numerical result out of range"
};
static char errBuf[64];
char *strerror(int e) {
  if (e >= 0 && e < 35) return (char *)ERRTAB[e];
  snprintf(errBuf, sizeof(errBuf), "Unknown error %d", e);
  return errBuf;
}

/* ---- `sscanf`：只认 `%d %ld %lld %u %x %f %lf %s %c` 与格式串里的字面量/空白。
 * 我们的运行时用它读数字，不用它做通用解析 —— 别的转换回「读到几个」时就停住。 */
long long strtoll(const char *s, char **end, int base);
double strtod(const char *s, char **end);
int sscanf(const char *src, const char *fmt, ...) {
  __builtin_va_list ap;
  __builtin_va_start(ap, fmt);
  const char *s = src;
  const char *f = fmt;
  int got = 0;
  while (*f) {
    if (*f == ' ' || *f == '\t' || *f == '\n') {
      while (*s == ' ' || *s == '\t' || *s == '\n') s++;
      f++;
      continue;
    }
    if (*f != '%') {
      if (*s != *f) break;
      s++; f++;
      continue;
    }
    f++;
    int lng = 0;
    while (*f == 'l') { lng++; f++; }
    if (*f == 'z') { lng = 1; f++; }
    char sp = *f++;
    while (sp != 'c' && (*s == ' ' || *s == '\t' || *s == '\n')) s++;
    if (sp == 'd' || sp == 'i' || sp == 'u' || sp == 'x') {
      char *end = (char *)0;
      long long v = strtoll(s, &end, sp == 'x' ? 16 : 10);
      if (end == s) break;
      s = end;
      if (lng >= 2) *__builtin_va_arg(ap, long long *) = v;
      else if (lng == 1) *__builtin_va_arg(ap, long *) = (long)v;
      else *__builtin_va_arg(ap, int *) = (int)v;
      got++;
    } else if (sp == 'f' || sp == 'g' || sp == 'e') {
      char *end = (char *)0;
      double v = strtod(s, &end);
      if (end == s) break;
      s = end;
      if (lng >= 1) *__builtin_va_arg(ap, double *) = v;
      else *__builtin_va_arg(ap, float *) = (float)v;
      got++;
    } else if (sp == 's') {
      char *out = __builtin_va_arg(ap, char *);
      int k = 0;
      while (*s && *s != ' ' && *s != '\t' && *s != '\n') out[k++] = *s++;
      out[k] = 0;
      if (k == 0) break;
      got++;
    } else if (sp == 'c') {
      char *out = __builtin_va_arg(ap, char *);
      if (*s == 0) break;
      *out = *s++;
      got++;
    } else break;
  }
  __builtin_va_end(ap);
  return got;
}

/* ---- 回失败但不崩的那几格（理由见文件头） */
int sigaction(int sig, const void *act, void *old) {
  (void)sig; (void)act; (void)old;
  __libc_errno_val = 38;            /* ENOSYS */
  return -1;
}
int sigemptyset(void *set) { (void)set; return 0; }
int sigaddset(void *set, int sig) { (void)set; (void)sig; return 0; }
int backtrace(void **buf, int n) { (void)buf; (void)n; return 0; }
char **backtrace_symbols(void *const *buf, int n) { (void)buf; (void)n; return (char **)0; }

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
/* `sigsetjmp`/`siglongjmp`：信号掩码那一格我们没有（`sigaction` 都还回 ENOSYS），
 * 所以与不带 sig 的那一对同一个实现 —— `savemask` 忽略。 */
int sigsetjmp(void *env, int savemask) { (void)savemask; return __omni_setjmp(env); }
void siglongjmp(void *env, int val) { __omni_longjmp(env, val); }

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
