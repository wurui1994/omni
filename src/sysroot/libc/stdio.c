/* stdio.c — printf 那一族（第一百四十片）。
 *
 * 认的转换：`%d %i %u %x %o %c %s %p %f %e %g %%`，长度前缀 `l`/`ll`/`z`，
 * 宽度与精度（含 `*`），标志 `-`（左对齐）与 `0`（零填充）。
 * 一格 256 字节的攒写缓冲 —— 不是为了「缓冲的语义」，是为了少发 syscall
 * （`fflush` 照旧是把攒着的吐出去，不留任何跨调用的状态）。
 *
 * **浮点那三条是精确的**（第九格）：数字从**位模式**摊成十进制（`decExpand`，
 * 基 10^9 的大整数），收位是半到偶 —— 与平台 libc 逐行相同（155 行的对账 0 行不同，
 * 判据 `tests/c/libc-float.js`）。改之前那一版是「归一化 + 逐位取整」，41 行不同。
 */
#include "libc.h"

/* 三条标准流。**FILE 那三个对象是公用的、名字是目标专有的**：glibc 认 `stdout`
 * 这个指针符号，Darwin 认 `__stdoutp`（SDK 的 `<stdio.h>` 里 `#define stdout __stdoutp`）。
 * 所以对象在这儿摆一份、导出出去，Darwin 那三个名字在 `arm64-osx/libc/io.c` 里
 * 指向同一份 —— 两条腿上都不会出现「两个 stdout 各攒一半」。 */
FILE __libc_stdin_f  = { 0, 0, 0 };
FILE __libc_stdout_f = { 1, 0, 0 };
FILE __libc_stderr_f = { 2, 0, 0 };
FILE *stdin  = &__libc_stdin_f;
FILE *stdout = &__libc_stdout_f;
FILE *stderr = &__libc_stderr_f;

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

/* ---- 浮点：**精确的十进制展开**（第一百四十片第九格）。
 *
 * 一个 double 就是 `m × 2^e`（m 是 53 位整数）—— 它的十进制展开**是有限的**，所以
 * 「精确」不需要 dragon4 那套循环，只要一个大整数乘法。那个大整数在公用的 `dec.c` 里
 * （`__libc_dec_of_me`）—— 解析那一头（`strtox.c` 的 `strtod`）要的是同一件东西的
 * 反方向，所以它不摆在这一份里。
 *
 * 上一版是「归一化到 [1,10) 再逐位取整」，全在 double 上算，末一两位会差一个 ulp
 * （量到的是 41 行不同 / 155 行）。**也试过「只除一次」那一版，更差，没收**：
 * `2.2250738585072014e-308` 印成 `4.4674407370955161e-306`（`10^(e10-16)` 自己就溢了）。
 * 现在这一条路上一次浮点运算都没有 —— 位模式进来，整数出去。 */
#define DEC_DIGITS 1200

/* `v`（> 0、有限）的精确十进制展开。数字串没有前导零，`*frac` 是小数点右边的位数
 * （也就是这串数字要往左退多少位）。回值是数字个数。 */
static int decExpand(double v, char *digits, int cap, int *frac) {
  union { double d; unsigned long long u; } b;
  b.d = v;
  int E = (int)((b.u >> 52) & 0x7ff);
  unsigned long long M = b.u & 0xfffffffffffffULL;
  if (E == 0) return __libc_dec_of_me(M, -1074, digits, cap, frac);   /* 非规格化 */
  return __libc_dec_of_me(M | (1ULL << 52), E - 1075, digits, cap, frac);
}
/* 摊完再按要求收位。两种要法：
 *   `fixedMode == 0`：要 `want` 位**有效数字**（`%e` / `%g`）
 *   `fixedMode == 1`：要小数点后 `want` 位（`%f`）—— 位数由指数定
 * 出：`out` 里的数字（回值是几位）、`*e10` 是第一位的十进制指数。
 *
 * 舍入是**半到偶**（glibc 默认那一档：exact 值离两边一样远时取偶数末位）。判据里
 * `9007199254740992` 与 `4503599627370497` 那两行专门盯这一格。 */
static int fmtRound(double v, int want, int fixedMode, char *out, int cap, int *e10) {
  if (v == 0.0) {
    int nd = fixedMode ? 1 : (want < 1 ? 1 : want);
    if (nd > cap) nd = cap;
    for (int i = 0; i < nd; i++) out[i] = '0';
    *e10 = 0;
    return nd;
  }
  char dg[DEC_DIGITS];
  int frac = 0;
  int L = decExpand(v, dg, DEC_DIGITS, &frac);
  int e = L - frac - 1;                     /* 第一位有效数字的十进制指数 */
  int nd = fixedMode ? e + 1 + want : want;
  if (nd > cap) nd = cap;
  if (nd < 0) nd = 0;
  for (int k = 0; k < nd; k++) out[k] = (k < L) ? dg[k] : '0';
  int up = 0;
  if (nd < L) {
    char c = dg[nd];
    if (c > '5') up = 1;
    else if (c == '5') {
      int rest = 0;
      for (int i = nd + 1; i < L; i++) if (dg[i] != '0') { rest = 1; break; }
      up = rest ? 1 : (nd > 0 ? ((out[nd - 1] - '0') & 1) : 0);
    }
  }
  if (up) {
    int j = nd - 1;
    while (j >= 0) {
      if (out[j] != '9') { out[j]++; break; }
      out[j] = '0';
      j--;
    }
    if (j < 0) {                            /* 999… 全进位：1 后头补零，指数 +1 */
      if (nd == 0) { if (cap > 0) { out[0] = '1'; nd = 1; } }
      else { out[0] = '1'; for (int m = 1; m < nd; m++) out[m] = '0'; }
      e++;
    }
  }
  if (nd == 0 && cap > 0) out[0] = '0';
  *e10 = e;
  return nd;
}

/* `%f`：定点。`prec` 位小数（默认 6）。
 *
 * `tmp` 得放得下**整数部分的全部位数** —— double 最大 1.8e308，那是 309 位，再加小数与
 * 小数点。第一版给了 64 字节，量到的后果是 `printf("%f", 1e100)` 把栈上后面那一片写花
 * （输出里一长串 NUL）。所以这一格是 1200（309 + 小数点 + 精度），每一步都守着上界。
 *
 * 数字来自 `fmtRound`（精确展开），所以 `1e100` 那一行的一百位数字**全是真的**，
 * 与 glibc 逐字节相同 —— 上一版只有前 25 位是真的、后头补零。 */
static void fmtFixed(FmtOut *o, double v, int prec, int width, char pad, int left, char pre) {
  char dg[DEC_DIGITS];
  int e10 = 0;
  int nd = fmtRound(v, prec, 1, dg, DEC_DIGITS, &e10);
  char tmp[DEC_DIGITS];
  const int cap = DEC_DIGITS;
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
  char dg[DEC_DIGITS];
  int e10 = 0;
  int want = prec + 1;
  if (want > DEC_DIGITS) want = DEC_DIGITS;
  int nd = fmtRound(v, want, 0, dg, DEC_DIGITS, &e10);
  if (v == 0.0) e10 = 0;
  char tmp[DEC_DIGITS];
  const int cap = DEC_DIGITS;
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
  /* 小数位（倒着）。要的位数比摊得出来的多时（`%.30e`）后头补零 —— 那是**对的**，
   * 不是偷懒：double 的十进制展开有限，超出那么多位本来就全是零。 */
  int wantf = prec;
  int have = nd - 1;
  while (wantf > have && n < cap) { tmp[n++] = '0'; wantf--; }
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
  char dg[DEC_DIGITS];
  int e10 = 0;
  int nd = fmtRound(v, prec > DEC_DIGITS ? DEC_DIGITS : prec, 0, dg, DEC_DIGITS, &e10);
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
      /* 符号看**位模式**，不是 `v < 0`：`-0.0 < 0.0` 是假的，而 glibc 印的是 `-0`
       * （C11 7.21.6.1：负号照符号位走）。量到过这一格 —— 五行里差的就是那个减号。 */
      {
        union { double d; unsigned long long u; } sb;
        sb.d = v;
        if ((sb.u >> 63) != 0) { pre = '-'; v = -v; }
      }
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
