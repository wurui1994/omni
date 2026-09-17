/* stdio.c — printf 那一族（第一百四十片）。
 *
 * 认的转换：`%d %i %u %x %o %c %s %p %f %e %g %%`，长度前缀 `l`/`ll`/`z`，
 * 宽度与精度（含 `*`），标志 `-`（左对齐）与 `0`（零填充）。
 * 一格 256 字节的攒写缓冲 —— 不是为了「缓冲的语义」，是为了少发 syscall
 * （`fflush` 照旧是把攒着的吐出去，不留任何跨调用的状态）。
 *
 * **浮点那三条的精度**：数字是「归一化 + 逐位取整」抠出来的（`fmtDigits`），
 * 全在 double 上算，所以最后一两位可能与 glibc 差一个 ulp。量法与量到的数记在
 * `tests/x64/docker-run.sh` 上。真的最短往返（Ryu / Grisu）是另一件事，没做。
 */
#include "libc.h"

static FILE __stdin_f  = { 0, 0, 0 };
static FILE __stdout_f = { 1, 0, 0 };
static FILE __stderr_f = { 2, 0, 0 };
FILE *stdin  = &__stdin_f;
FILE *stdout = &__stdout_f;
FILE *stderr = &__stderr_f;

typedef struct {
  char *buf;              /* cap > 0：往这块写（snprintf） */
  unsigned long pos;      /* 已经「产出」多少字符（snprintf 的返回值要它） */
  unsigned long cap;      /* 0 = 往 fd 写 */
  int fd;
  char hold[256];         /* fd 那一路的攒写缓冲 */
  int held;
} FmtOut;

static void fmtFlush(FmtOut *o) {
  if (o->held > 0) {
    write(o->fd, o->hold, (unsigned long)o->held);
    o->held = 0;
  }
}

static void fmtPut(FmtOut *o, char c) {
  o->pos++;
  if (o->cap > 0) {
    if (o->pos <= o->cap - 1) o->buf[o->pos - 1] = c;
    return;
  }
  o->hold[o->held++] = c;
  if (o->held == 256) fmtFlush(o);
}

static void fmtStr(FmtOut *o, const char *s, int maxn) {
  if (s == (const char *)0) s = "(null)";
  int k = 0;
  while (*s && (maxn < 0 || k < maxn)) { fmtPut(o, *s++); k++; }
}

/* 一个无符号整数，base 进制。宽度与填充由调用方先摆好（这一格只出数字）。 */
static int fmtUintTo(char *tmp, unsigned long long v, int base, int upper) {
  int n = 0;
  if (v == 0) { tmp[n++] = '0'; return n; }
  while (v) {
    int d = (int)(v % (unsigned long long)base);
    tmp[n++] = d < 10 ? (char)('0' + d)
      : (char)((upper ? 'A' : 'a') + d - 10);
    v /= (unsigned long long)base;
  }
  return n;
}

/* 把 `tmp` 里倒着的 n 位数按宽度/对齐吐出去。`pre` 是符号那一位（'-' 或 0）。 */
static void fmtPad(FmtOut *o, char *tmp, int n, int width, char pad, int left, char pre) {
  int total = n + (pre ? 1 : 0);
  if (!left) {
    /* 零填充时符号要在填充**之前**（`-007` 而不是 `00-7`）。 */
    if (pad == '0' && pre) { fmtPut(o, pre); pre = 0; }
    while (total < width) { fmtPut(o, pad); total++; }
  }
  if (pre) fmtPut(o, pre);
  while (n > 0) fmtPut(o, tmp[--n]);
  if (left) while (total < width) { fmtPut(o, ' '); total++; }
}

/* ---- 浮点：`nd` 位有效数字 + 十进制指数（第一百四十片）。
 *
 * 归一化到 `[1, 10)` 再逐位 `d = (int)x; x = (x - d) * 10`。全在 double 上算，
 * 所以 17 位那一档最后一两位可能与 glibc 差一个 ulp（量到的数记在 docker-run.sh）。
 * 归一化用**乘/除 10 的幂**而不是 `log10`：这一份不许依赖 math.c（那边反过来也
 * 不依赖这儿），而且 `log10` 自己就有误差。 */
static int fmtDigits(double v, int nd, char *out, int *e10) {
  int e = 0;
  if (v == 0.0) {
    int k = 0;
    while (k < nd) out[k++] = '0';
    *e10 = 0;
    return nd;
  }
  while (v >= 10.0) { v /= 10.0; e++; }
  while (v < 1.0) { v *= 10.0; e--; }
  int k = 0;
  while (k < nd) {
    int d = (int)v;
    if (d > 9) d = 9;            /* 舍入的边角：1e17 那一档 v 可能刚过 10 */
    out[k++] = (char)('0' + d);
    v = (v - (double)d) * 10.0;
  }
  /* 末位四舍五入：剩下的 v 是「下一位及以后」。 */
  if (v >= 5.0) {
    int j = nd - 1;
    while (j >= 0) {
      if (out[j] != '9') { out[j]++; break; }
      out[j] = '0';
      j--;
    }
    if (j < 0) {                 /* 999… 全进位：变成 1 后头补 0，指数 +1 */
      out[0] = '1';
      int m = 1;
      while (m < nd) out[m++] = '0';
      e++;
    }
  }
  *e10 = e;
  return nd;
}

/* `%f`：定点。`prec` 位小数（默认 6）。
 *
 * `tmp` 得放得下**整数部分的全部位数** —— double 最大 1.8e308，那是 309 位，
 * 再加小数与小数点。第一版给了 64 字节，量到的后果是 `printf("%f", 1e100)` 把栈上
 * 后面那一片写花（输出里一长串 NUL）。所以这一格是 512，而且每一步都守着上界。
 *
 * 与 glibc 的差别（明说）：那边 `%f` 印的是这个 double 的**精确十进制展开**
 * （1e100 那一行 100 位数字全是真的），我们只有前 25 位有效数字是真的、后头补零 ——
 * 精确展开要大整数，这一份没有。 */
static void fmtFixed(FmtOut *o, double v, int prec, int width, char pad, int left, char pre) {
  char dg[32];
  int e10 = 0;
  int nd;
  {
    double t = v;
    int e = 0;
    if (t != 0.0) { while (t >= 10.0) { t /= 10.0; e++; } while (t < 1.0) { t *= 10.0; e--; } }
    nd = e + 1 + prec;
    if (nd < 1) nd = 1;
    if (nd > 25) nd = 25;
  }
  fmtDigits(v, nd, dg, &e10);
  char tmp[512];
  const int cap = 512;
  int n = 0;                       /* tmp 是倒着放的（fmtPad 从后往前吐） */
  int frac = prec;
  int idx = e10 + prec;            /* dg 里最后那一位小数的下标 */
  while (frac > 0 && n < cap) {
    tmp[n++] = (idx >= 0 && idx < nd) ? dg[idx] : '0';
    idx--; frac--;
  }
  if (prec > 0 && n < cap) tmp[n++] = '.';
  if (e10 < 0 || v == 0.0) { if (n < cap) tmp[n++] = '0'; }
  else {
    int i = e10;
    while (i >= 0 && n < cap) {
      tmp[n++] = (i < nd) ? dg[i] : '0';
      i--;
    }
  }
  fmtPad(o, tmp, n, width, pad, left, pre);
}

/* `%e`：科学计数。`prec` 位小数（默认 6），指数至少两位。 */
static void fmtSci(FmtOut *o, double v, int prec, int width, char pad, int left, char pre,
  int upper) {
  char dg[32];
  int e10 = 0;
  int nd = prec + 1;
  if (nd > 25) nd = 25;
  fmtDigits(v, nd, dg, &e10);
  if (v == 0.0) e10 = 0;
  char tmp[128];
  const int cap = 128;
  int n = 0;                        /* 倒着放 */
  /* 指数：`e±dd` */
  int ex = e10 < 0 ? -e10 : e10;
  char ed[8];
  int en = fmtUintTo(ed, (unsigned long long)ex, 10, 0);
  if (en < 2) ed[en++] = '0';       /* 至少两位 */
  int k = 0;
  while (k < en) tmp[n++] = ed[k++];        /* ed 本来倒着，直接倒进 tmp = 正序 */
  tmp[n++] = e10 < 0 ? '-' : '+';
  tmp[n++] = upper ? 'E' : 'e';
  /* 小数位（倒着）。要的位数比抠得出来的多时（`%.30e`）后头补零 —— 有效数字封顶
   * 在 25 位，再往后是猜的，补零至少不撒谎。 */
  int want = prec;
  int have = nd - 1;
  while (want > have && n < cap) { tmp[n++] = '0'; want--; }
  int i = have;
  while (i >= 1 && n < cap) { tmp[n++] = dg[i]; i--; }
  if (prec > 0 && n < cap) tmp[n++] = '.';
  if (n < cap) tmp[n++] = dg[0];
  fmtPad(o, tmp, n, width, pad, left, pre);
}

/* `%g`：有效数字 `prec` 位（默认 6，0 当 1），指数在 [-4, prec) 之外走 `%e`，
 * 而且**去掉末尾的零**（C11 7.21.6.1 第 8 段）。 */
static void fmtGen(FmtOut *o, double v, int prec, int width, char pad, int left, char pre,
  int upper) {
  if (prec == 0) prec = 1;
  char dg[40];
  int e10 = 0;
  int nd = prec > 25 ? 25 : prec;
  fmtDigits(v, nd, dg, &e10);
  if (v == 0.0) e10 = 0;
  /* 去零：从末位往前砍（至少留一位） */
  int keep = nd;
  while (keep > 1 && dg[keep - 1] == '0') keep--;
  if (e10 < -4 || e10 >= prec) {
    /* 走 `%e`，小数位 = keep - 1。重新抠一遍最省事（位数变了）。 */
    fmtSci(o, v, keep - 1, width, pad, left, pre, upper);
    return;
  }
  int fprec = keep - 1 - e10;
  if (fprec < 0) fprec = 0;
  fmtFixed(o, v, fprec, width, pad, left, pre);
}

/* ---- 格式串那一趟 */
static int doFmt(FmtOut *o, const char *fmt, __builtin_va_list ap) {
  while (*fmt) {
    if (*fmt != '%') { fmtPut(o, *fmt++); continue; }
    fmt++;
    /* 标志 */
    int left = 0;
    char pad = ' ';
    char pre = 0;
    while (*fmt == '-' || *fmt == '0' || *fmt == '+' || *fmt == ' ' || *fmt == '#') {
      if (*fmt == '-') left = 1;
      else if (*fmt == '0') pad = '0';
      else if (*fmt == '+') pre = '+';
      fmt++;
    }
    /* 宽度 */
    int width = 0;
    if (*fmt == '*') { width = __builtin_va_arg(ap, int); fmt++; if (width < 0) { left = 1; width = -width; } }
    else while (*fmt >= '0' && *fmt <= '9') { width = width * 10 + (*fmt - '0'); fmt++; }
    /* 精度 */
    int prec = -1;
    if (*fmt == '.') {
      fmt++;
      prec = 0;
      if (*fmt == '*') { prec = __builtin_va_arg(ap, int); fmt++; }
      else while (*fmt >= '0' && *fmt <= '9') { prec = prec * 10 + (*fmt - '0'); fmt++; }
    }
    /* 长度前缀（`z`/`t` 都当 long） */
    int lng = 0;
    while (*fmt == 'l') { lng++; fmt++; }
    if (*fmt == 'z' || *fmt == 't' || *fmt == 'j') { lng = 1; fmt++; }
    if (*fmt == 'h') { fmt++; if (*fmt == 'h') fmt++; }
    if (*fmt == 'L') fmt++;
    char spec = *fmt++;
    char tmp[80];
    if (spec == 'd' || spec == 'i') {
      long long v = lng >= 2 ? __builtin_va_arg(ap, long long)
        : (lng == 1 ? (long long)__builtin_va_arg(ap, long) : (long long)__builtin_va_arg(ap, int));
      if (v < 0) { pre = '-'; v = -v; }
      fmtPad(o, tmp, fmtUintTo(tmp, (unsigned long long)v, 10, 0), width, pad, left, pre);
    } else if (spec == 'u' || spec == 'x' || spec == 'X' || spec == 'o') {
      unsigned long long v = lng >= 2 ? __builtin_va_arg(ap, unsigned long long)
        : (lng == 1 ? (unsigned long long)__builtin_va_arg(ap, unsigned long)
          : (unsigned long long)__builtin_va_arg(ap, unsigned int));
      int base = spec == 'u' ? 10 : (spec == 'o' ? 8 : 16);
      fmtPad(o, tmp, fmtUintTo(tmp, v, base, spec == 'X'), width, pad, left, 0);
    } else if (spec == 's') {
      /* 宽度对 `%s` 也算（`%10s` / `%-10s`）—— 第一版漏了这一格，量到的是
       * `printf("%10s", "ab")` 一个空格都不补。 */
      const char *s = __builtin_va_arg(ap, const char *);
      if (s == (const char *)0) s = "(null)";
      int sl = (int)strlen(s);
      if (prec >= 0 && prec < sl) sl = prec;
      if (!left) { int q = sl; while (q < width) { fmtPut(o, ' '); q++; } }
      fmtStr(o, s, prec);
      if (left) { int q = sl; while (q < width) { fmtPut(o, ' '); q++; } }
    } else if (spec == 'c') {
      fmtPut(o, (char)__builtin_va_arg(ap, int));
    } else if (spec == 'p') {
      void *p = __builtin_va_arg(ap, void *);
      fmtPut(o, '0'); fmtPut(o, 'x');
      fmtPad(o, tmp, fmtUintTo(tmp, (unsigned long long)(unsigned long)p, 16, 0), 0, ' ', 0, 0);
    } else if (spec == 'f' || spec == 'F' || spec == 'e' || spec == 'E'
      || spec == 'g' || spec == 'G') {
      double v = __builtin_va_arg(ap, double);
      if (v < 0.0) { pre = '-'; v = -v; }
      /* nan / inf：位模式认出来（这一份不依赖 math.c）。 */
      if (v != v) { fmtStr(o, "nan", -1); continue; }
      if (v > 1.7976931348623157e308) { fmtStr(o, pre == '-' ? "-inf" : "inf", -1); continue; }
      if (spec == 'f' || spec == 'F') fmtFixed(o, v, prec < 0 ? 6 : prec, width, pad, left, pre);
      else if (spec == 'e' || spec == 'E') {
        fmtSci(o, v, prec < 0 ? 6 : prec, width, pad, left, pre, spec == 'E');
      } else fmtGen(o, v, prec < 0 ? 6 : prec, width, pad, left, pre, spec == 'G');
    } else if (spec == '%') {
      fmtPut(o, '%');
    } else {
      fmtPut(o, '%'); fmtPut(o, spec);
    }
  }
  return (int)o->pos;
}

/* ---- 公开的那几个 */
static void outInit(FmtOut *o, char *buf, unsigned long cap, int fd) {
  o->buf = buf; o->pos = 0; o->cap = cap; o->fd = fd; o->held = 0;
}

int vsnprintf(char *buf, unsigned long n, const char *fmt, __builtin_va_list ap) {
  FmtOut o;
  outInit(&o, buf, n, -1);
  int r = doFmt(&o, fmt, ap);
  if (buf != (char *)0 && n > 0) buf[o.pos < n ? o.pos : n - 1] = 0;
  return r;
}

int snprintf(char *buf, unsigned long n, const char *fmt, ...) {
  __builtin_va_list ap;
  __builtin_va_start(ap, fmt);
  int r = vsnprintf(buf, n, fmt, ap);
  __builtin_va_end(ap);
  return r;
}

int sprintf(char *buf, const char *fmt, ...) {
  __builtin_va_list ap;
  __builtin_va_start(ap, fmt);
  /* 没有上限：给一个大得离谱的 cap（调用方自己保证够）。 */
  int r = vsnprintf(buf, 0x7fffffff, fmt, ap);
  __builtin_va_end(ap);
  return r;
}

int vfprintf(FILE *f, const char *fmt, __builtin_va_list ap) {
  FmtOut o;
  outInit(&o, (char *)0, 0, f->fd);
  int r = doFmt(&o, fmt, ap);
  fmtFlush(&o);
  return r;
}

int fprintf(FILE *f, const char *fmt, ...) {
  __builtin_va_list ap;
  __builtin_va_start(ap, fmt);
  int r = vfprintf(f, fmt, ap);
  __builtin_va_end(ap);
  return r;
}

int printf(const char *fmt, ...) {
  __builtin_va_list ap;
  __builtin_va_start(ap, fmt);
  int r = vfprintf(stdout, fmt, ap);
  __builtin_va_end(ap);
  return r;
}

int vprintf(const char *fmt, __builtin_va_list ap) { return vfprintf(stdout, fmt, ap); }

/* ---- 单字符与收场 */
int fputc(int c, FILE *f) {
  char ch = (char)c;
  if (write(f->fd, &ch, 1) != 1) { f->err = 1; return -1; }
  return c;
}
int putchar(int c) { return fputc(c, stdout); }
int putc(int c, FILE *f) { return fputc(c, f); }

int fputs(const char *s, FILE *f) {
  unsigned long n = strlen(s);
  return write(f->fd, s, n) == (long)n ? 0 : -1;
}

int puts(const char *s) {
  if (fputs(s, stdout) < 0) return -1;
  return fputc('\n', stdout) < 0 ? -1 : 0;
}

/* 无缓冲（每次 write 都是 syscall），所以这一条本来就没事可做。 */
int fflush(FILE *f) { (void)f; return 0; }

void _exit(int code) {
  __omni_syscall(SYS_exit_group, code);
  for (;;) __omni_syscall(SYS_exit, code);
}

/* `atexit` 注册的那些在这儿倒着跑（表在 `misc.c` 上）。 */
void exit(int code) {
  __libc_run_atexit();
  _exit(code);
}

void abort(void) {
  /* `kill(0, SIGABRT)`：0 号进程组就是自己那一组。信号处置默认是「核心转储」，
   * 于是 shell 看到的是 134（128 + 6）而不是我们自己编的退出码。 */
  __omni_syscall(SYS_kill, 0, 6);
  _exit(134);
}

void __libc_unimpl(const char *what) {
  const char *p = "omni libc: 还没实现：";
  write(2, p, strlen(p));
  write(2, what, strlen(what));
  write(2, "\n", 1);
  abort();
}
