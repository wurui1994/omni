/* pure.c — 公用那一半里「纯计算」的杂项（第一百四十片第五格）。
 *
 * 这几样从各目标的 `misc.c` 里提出来：它们**一行 syscall 都没有**，两个目标上
 * 一模一样，抄第二份就是留两处会飘的账。
 *   - `strerror`：一张表
 *   - `atexit` / `__cxa_atexit` / `__libc_run_atexit`：一张 32 格的表，倒着跑
 *   - `gmtime_r` / `localtime_r` / `strftime`：把秒数掰成年月日（UTC，没有时区库）
 *   - `sscanf`：三四种转换的解析
 *
 * 只有「现在几点」（`time`）要问内核，那一格留在各目标的 `misc.c` 里。
 */
#include "libc.h"

int snprintf(char *buf, unsigned long n, const char *fmt, ...);
long long strtoll(const char *s, char **end, int base);
double strtod(const char *s, char **end);

/* ---- errno 那张表。只列我们自己回得出来的那些（别的印号）。
 * 号是 Linux 的那一套（1..34），macOS 的前 34 个与它**大体重合但不完全一样**
 * （EDEADLK 那一带岔开）—— 这一格明说：印出来的话对不上时以 errno 号为准。 */
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

/* ---- `atexit`：一张 32 格的表，`exit` 那边**倒着**调（C11 7.22.4.4 第 3 段）。
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

/* ---- 把秒数掰成年月日（UTC，没有时区文件）。
 * 天数 -> 年月日用 civil_from_days 那条封闭公式（把三月当年初，于是闰年那一天落在
 * 末尾，一个分支都不用）。 */
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

/* ---- `sscanf`：只认 `%d %ld %lld %u %x %f %lf %s %c` 与格式串里的字面量/空白。 */
/* 解析那一趟的**真身**：`used` 回「吃掉了多少个字符」——`fscanf` 靠它把文件位置退回去
 * （第一百四十片第十三格）。`sscanf` 与 `fscanf` 都只是它的一层皮。 */
int __libc_vsscanf(const char *src, const char *fmt, __builtin_va_list ap, int *used) {
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
  if (used != (int *)0) *used = (int)(s - src);
  return got;
}

int sscanf(const char *src, const char *fmt, ...) {
  __builtin_va_list ap;
  __builtin_va_start(ap, fmt);
  int got = __libc_vsscanf(src, fmt, ap, (int *)0);
  __builtin_va_end(ap);
  return got;
}

/* ---- 回失败但不崩的那几格（这些在两个目标上同一个实现：不碰内核） */
int backtrace(void **buf, int n) { (void)buf; (void)n; return 0; }
char **backtrace_symbols(void *const *buf, int n) { (void)buf; (void)n; return (char **)0; }

/* ---- `qsort` / `bsearch`（第一百四十片第十二格）。
 *
 * 两个头文件里早就声明了它们，可**谁都没实现** —— 量到的是链接时一句
 * `macho: 符号 '_bsearch' 没有定义`（`qsort` 排在它后面，还没轮到报）。
 *
 * `qsort` 用**堆排序**，三条硬约束逼出来的：
 *   - 不许 `malloc`（libc 内部再要堆容易绕回自己），所以就地换
 *   - 不许递归（栈深度要有上界）—— 堆排序是两个循环
 *   - **最坏也是 O(n log n)**：快排的最坏是 O(n²)，而这一份没有随机数可用来防
 * 代价是不稳定（C 标准也不要求稳定）。元素按字节搬 —— `sz` 是运行期的数。 */
static void qsSwap(char *a, char *b, unsigned long sz) {
  for (unsigned long i = 0; i < sz; i++) {
    char t = a[i];
    a[i] = b[i];
    b[i] = t;
  }
}

static void qsSift(char *base, unsigned long n, unsigned long i, unsigned long sz,
  int (*cmp)(const void *, const void *)) {
  for (;;) {
    unsigned long big = i;
    unsigned long l = 2 * i + 1;
    unsigned long r = l + 1;
    if (l < n && cmp(base + l * sz, base + big * sz) > 0) big = l;
    if (r < n && cmp(base + r * sz, base + big * sz) > 0) big = r;
    if (big == i) return;
    qsSwap(base + i * sz, base + big * sz, sz);
    i = big;
  }
}

void qsort(void *base, unsigned long n, unsigned long sz,
  int (*cmp)(const void *, const void *)) {
  if (n < 2 || sz == 0) return;
  char *b = (char *)base;
  /* 建堆：从最后一个非叶子往前。循环变量从 `n / 2` 数到 1、里头用 `i - 1`，
   * 免得在 0 上减一绕回（这儿的类型是无符号的）。 */
  for (unsigned long i = n / 2; i > 0; i--) qsSift(b, n, i - 1, sz, cmp);
  for (unsigned long end = n - 1; end > 0; end--) {
    qsSwap(b, b + end * sz, sz);
    qsSift(b, end, 0, sz, cmp);
  }
}

/* `bsearch`：二分。区间记成「起点 + 个数」而不是「左右下标」—— 下标那一版在
 * 空区间上要用 -1，而这儿是无符号的（与上面建堆那一行同一个坑）。 */
void *bsearch(const void *key, const void *base, unsigned long n, unsigned long sz,
  int (*cmp)(const void *, const void *)) {
  const char *b = (const char *)base;
  while (n > 0) {
    unsigned long half = n / 2;
    const char *mid = b + half * sz;
    int c = cmp(key, mid);
    if (c == 0) return (void *)mid;
    if (c > 0) { b = mid + sz; n = n - half - 1; }
    else n = half;
  }
  return (void *)0;
}

