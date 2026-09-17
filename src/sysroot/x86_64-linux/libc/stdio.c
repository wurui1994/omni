/* stdio.c — printf / fprintf / snprintf 家族（第一百四十片）。
 *
 * 只实现 %d %ld %lld %u %lu %llu %x %lx %llx %s %c %p %% 与宽度/零填充。
 * 浮点（%f %e %g）先不做 —— 我们自己的编译器里 printf 只印整数和字符串。
 */
#include "syscall.h"

/* ---- 三条标准流 ---- */
static int __stdout_fd = 1;
static int __stderr_fd = 2;
static int __stdin_fd  = 0;

/* FILE 只是一个 fd 的壳。 */
struct __FILE { int fd; };
typedef struct __FILE FILE;
static FILE __stdin_f  = { 0 };
static FILE __stdout_f = { 1 };
static FILE __stderr_f = { 2 };
FILE *stdin  = &__stdin_f;
FILE *stdout = &__stdout_f;
FILE *stderr = &__stderr_f;

/* ---- 内部格式化引擎 ---- */

typedef struct {
  char *buf;
  unsigned long pos;
  unsigned long cap;      /* 0 = 直接写 fd */
  int fd;                 /* cap==0 时用 */
} FmtOut;

static void fmtPut(FmtOut *o, char c) {
  if (o->cap > 0) {
    if (o->pos < o->cap - 1) o->buf[o->pos] = c;
    o->pos++;
  } else {
    __omni_syscall(SYS_write, o->fd, (long)&c, 1);
    o->pos++;
  }
}

static void fmtStr(FmtOut *o, const char *s) {
  if (s == (const char *)0) s = "(null)";
  while (*s) fmtPut(o, *s++);
}

static void fmtUint(FmtOut *o, unsigned long long v, int base, int width, char pad) {
  char tmp[24];
  int n = 0;
  if (v == 0) { tmp[n++] = '0'; }
  else {
    while (v) {
      int d = (int)(v % (unsigned long long)base);
      tmp[n++] = d < 10 ? (char)('0' + d) : (char)('a' + d - 10);
      v /= (unsigned long long)base;
    }
  }
  while (n < width) { fmtPut(o, pad); width--; }
  while (n > 0) fmtPut(o, tmp[--n]);
}

static void fmtInt(FmtOut *o, long long v, int width, char pad) {
  if (v < 0) { fmtPut(o, '-'); v = -v; if (width > 0) width--; }
  fmtUint(o, (unsigned long long)v, 10, width, pad);
}

static int doFmt(FmtOut *o, const char *fmt, __builtin_va_list ap) {
  while (*fmt) {
    if (*fmt != '%') { fmtPut(o, *fmt++); continue; }
    fmt++;
    /* flags */
    char pad = ' ';
    if (*fmt == '0') { pad = '0'; fmt++; }
    /* width */
    int width = 0;
    while (*fmt >= '0' && *fmt <= '9') { width = width * 10 + (*fmt - '0'); fmt++; }
    /* length */
    int lng = 0;
    while (*fmt == 'l') { lng++; fmt++; }
    /* specifier */
    char spec = *fmt++;
    if (spec == 'd' || spec == 'i') {
      long long v;
      if (lng >= 2) v = __builtin_va_arg(ap, long long);
      else if (lng == 1) v = __builtin_va_arg(ap, long);
      else v = __builtin_va_arg(ap, int);
      fmtInt(o, v, width, pad);
    } else if (spec == 'u') {
      unsigned long long v;
      if (lng >= 2) v = __builtin_va_arg(ap, unsigned long long);
      else if (lng == 1) v = (unsigned long)__builtin_va_arg(ap, unsigned long);
      else v = (unsigned int)__builtin_va_arg(ap, unsigned int);
      fmtUint(o, v, 10, width, pad);
    } else if (spec == 'x') {
      unsigned long long v;
      if (lng >= 2) v = __builtin_va_arg(ap, unsigned long long);
      else if (lng == 1) v = (unsigned long)__builtin_va_arg(ap, unsigned long);
      else v = (unsigned int)__builtin_va_arg(ap, unsigned int);
      fmtUint(o, v, 16, width, pad);
    } else if (spec == 's') {
      const char *s = __builtin_va_arg(ap, const char *);
      fmtStr(o, s);
    } else if (spec == 'c') {
      int c = __builtin_va_arg(ap, int);
      fmtPut(o, (char)c);
    } else if (spec == 'p') {
      void *p = __builtin_va_arg(ap, void *);
      fmtPut(o, '0'); fmtPut(o, 'x');
      fmtUint(o, (unsigned long long)(unsigned long)p, 16, 0, '0');
    } else if (spec == '%') {
      fmtPut(o, '%');
    } else {
      fmtPut(o, '%'); fmtPut(o, spec);
    }
  }
  return (int)o->pos;
}

/* ---- 公开接口 ---- */

int vsnprintf(char *buf, unsigned long n, const char *fmt, __builtin_va_list ap) {
  FmtOut o;
  o.buf = buf; o.pos = 0; o.cap = n; o.fd = -1;
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

int vfprintf(FILE *f, const char *fmt, __builtin_va_list ap) {
  FmtOut o;
  o.buf = (char *)0; o.pos = 0; o.cap = 0; o.fd = f->fd;
  return doFmt(&o, fmt, ap);
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

int puts(const char *s) {
  FmtOut o;
  o.buf = (char *)0; o.pos = 0; o.cap = 0; o.fd = 1;
  fmtStr(&o, s);
  fmtPut(&o, '\n');
  return (int)o.pos;
}

int fputc(int c, FILE *f) {
  char ch = (char)c;
  __omni_syscall(SYS_write, f->fd, (long)&ch, 1);
  return c;
}

int putchar(int c) { return fputc(c, stdout); }

int fflush(FILE *f) {
  (void)f;
  return 0;  /* 无缓冲 —— 每次 write 都是 syscall */
}

void _exit(int code) {
  __omni_syscall(SYS_exit_group, code);
  for (;;) __omni_syscall(SYS_exit, code);
}

void exit(int code) {
  /* atexit 回调先不做 —— 直接退。 */
  _exit(code);
}

void abort(void) {
  __omni_syscall(SYS_kill, 0, 6);  /* SIGABRT = 6，kill(0, 6) = 杀自己 */
  _exit(127);
}
