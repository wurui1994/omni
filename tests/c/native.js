#!/usr/bin/env node
/* C -> MIR -> 真机器码，**native 口径**（ADR-0017 第九刀第十九片）。
 *
 * 这一条是把两头接起来的第一条：前端（`lowerCNative`）出的 MIR 里没有线性内存 ——
 * 局部量的帧是一条 `FRAME`，`&x` 是真地址 —— 后端（arm64 / x86_64）把它编成机器码，
 * 写成 `.o`，交给 clang 与一份手写的 `main.c` 链起来，**在真机器上跑**。
 *
 * oracle 是 **clang 自己**：同一份 `.c` 加同一份 `main.c`，一边用我们的后端、一边整份交给
 * clang，两边的 stdout 逐字节比。这比写死期望值强得多 —— 期望值是「C 的语义」，
 * 而 clang 比我手算可靠。
 *
 * 用例都只用**局部量、形参、指针、数组、struct、递归、控制流**：字符串字面量与全局量
 * 还没落到符号上（那是下一片），前端会明着报，本文件末尾有一组用例专门查这件事。
 *
 * 跑法：`node tests/c/native.js`
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { lowerCNative } from '../../stage0/src/frontend-c/tccgen.js';
import { verifyMir } from '../../stage0/src/mir/verify.js';
import { genModule as genArm64 } from '../../stage0/src/arm64/from_mir.js';
import { genModule as genX64 } from '../../stage0/src/x64/from_mir.js';
import { writeObject } from '../../stage0/src/link/macho.js';

const HOST = { readFile: () => null, includeDirs: [], dirname: () => '.', join: (a, b) => `${a}/${b}` };

/* 每条用例是一个 `long long probeN(void)`。名字由下标给，于是一份源码里装得下所有用例，
 * 一次前端、一次后端、一次链接 —— clang 跑三次而不是三十次。 */
const CASES = [
  ['局部量与算术', 'long long a = 7, b = 35; return a * b - 5;'],
  ['取地址：写进去要看得见', 'int x = 3; int *p = &x; *p = 42; return x;'],
  ['取形参的地址', 'return helper_addr(17);'],
  ['帧上的数组', 'int a[5]; int i; long long s = 0;'
    + ' for (i = 0; i < 5; i++) a[i] = i * i;'
    + ' for (i = 0; i < 5; i++) s += a[i]; return s;'],
  ['指针走数组', 'int a[4]; int *p = a; a[0] = 1; a[1] = 2; a[2] = 4; a[3] = 8;'
    + ' return p[0] + *(p + 1) + *(p + 2) + p[3];'],
  ['帧上的 struct，地址传给别人', 'struct P q; q.x = 3; q.y = 4; return sq(&q);'],
  ['两块不串味', 'int u = 100, v = 7; swap(&u, &v); return u * 1000 + v;'],
  ['递归：每一层一个帧', 'return fib(20);'],
  ['递归里取地址', 'return depth(6);'],
  ['double 落在帧上', 'double d = 2.5; double *p = &d; *p = *p * 4; return (long long) d;'],
  ['char 数组：自己数长度', 'char s[8]; int i; s[0] = 104; s[1] = 105; s[2] = 33; s[3] = 0;'
    + ' for (i = 0; s[i] != 0; i++) ; return i;'],
  ['switch 与嵌套块', 'int i; long long s = 0;'
    + ' for (i = 0; i < 6; i++) { switch (i) { case 0: case 1: s += 1; break;'
    + ' case 2: { int t = i * 10; s += t; break; } default: s -= i; } } return s;'],
  ['union 在帧上', 'union U u; u.i = 0x41424344; return u.b[0] + u.b[3];'],
  ['二维数组', 'int m[3][3]; int i, j; long long s = 0;'
    + ' for (i = 0; i < 3; i++) for (j = 0; j < 3; j++) m[i][j] = i * 3 + j;'
    + ' for (i = 0; i < 3; i++) s += m[i][i]; return s;'],
  /* 串常量（第二十片）：字节进 __DATA 的一个符号，值是**符号的地址**。 */
  ['串常量：按字节读', 'char *p = "hi!"; return p[0] * 100 + p[2];'],
  ['串常量：末尾有 0', 'char *p = "abcd"; int n = 0; while (p[n] != 0) n++; return n;'],
  ['串常量：sizeof 是数组的大小', 'return sizeof("abcd");'],
  ['串常量：地址交给真的 strlen', 'return (long long) strlen("hello, world");'],
  ['串常量：指针算术', 'char *p = "abcdef"; return *(p + 3) - *p;'],
  /* 宽串常量（第三十三片）：一格四字节，与窄串同一个办法（一个 __DATA 符号）。
   * 这儿一律写 int 而不是 wchar_t —— 这个目标上它就是 int，而 SUPPORT 里没有 stddef.h。 */
  ['宽串：按格读', 'int *p = L"hi!"; return p[0] * 100 + p[2];'],
  ['宽串：sizeof 是格数乘四', 'return sizeof(L"abcd");'],
  ['宽串：末尾那一格是 0', 'int *p = L"abcd"; int n = 0; while (p[n] != 0) n++; return n;'],
  ['宽串：非 ASCII 的一格是一个码位', 'int *p = L"\\u00e9!"; return p[0] * 100 + p[1];'],
  ['宽串：全局的初值里的宽串', 'return g_wp[0] * 100 + g_wp[1];'],
  ['宽串：铺进全局数组', 'return g_wa[0] * 1000 + g_wa[1] * 10 + g_wa[2];'],
  /* 全局量（第二十一片）：一块字节 + 一个符号，地址靠 `GADDR`。 */
  ['全局：写进去再读回来', 'g_i = 1234567; return g_i;'],
  ['全局：带初值', 'return g_init;'],
  ['全局：数组按下标写', 'int i; long long s = 0; for (i = 0; i < 8; i++) g_arr[i] = i * i;'
    + ' for (i = 0; i < 8; i++) s += g_arr[i]; return s;'],
  ['全局：数组的初值', 'return g_ai[0] + g_ai[1] * 10 + g_ai[2] * 100 + g_ai[3] * 1000;'],
  ['全局：struct 的成员', 'g_p.x = 3; g_p.y = 4; return sq(&g_p);'],
  ['全局：struct 的初值', 'return g_ps.x * 100 + g_ps.y;'],
  ['全局：取地址交给别人', 'int *p = &g_i; *p = 99; return g_i;'],
  ['全局：char 数组当串用', 'g_buf[0] = 111; g_buf[1] = 107; g_buf[2] = 0;'
    + ' return (long long) strlen(g_buf);'],
  ['全局：double', 'g_d = 1.5; return (long long) (g_d * 8);'],
  ['全局：static 局部量记着上次', 'return bump() * 100 + bump() * 10 + bump();'],
  /* 变参调用（第二十二片）：真的 libc 按真 ABI 读实参。苹果的 arm64 上变参走栈、
   * SysV 的 x86_64 上进寄存器加一个 `al` —— 同一段 C，两条腿的代码差得远。 */
  ['变参：snprintf 数出来的长度', 'char b[32]; return snprintf(b, 32, "%d-%d", 42, 7);'],
  ['变参：snprintf 写出来的字节', 'char b[32]; snprintf(b, 32, "%d-%d", 42, 7);'
    + ' return b[0] * 100 + b[2] + b[3];'],
  ['变参：串实参', 'char b[32]; snprintf(b, 32, "[%s]", "hi"); return b[1] * 10 + b[3];'],
  ['变参：double 实参', 'char b[32]; snprintf(b, 32, "%.2f", 1.5);'
    + ' return b[0] * 1000 + b[2] * 10 + b[3];'],
  ['变参：整数与 double 混着', 'char b[40]; int n = snprintf(b, 40, "%d %.1f %d", 1, 2.5, 3);'
    + ' return n * 100 + b[2] + b[6];'],
  ['变参：一个变参都没有', 'char b[8]; return snprintf(b, 8, "hi") * 100 + b[0];'],
  /* 堆：native 上没有线性内存，malloc/free 就是**普通的外部 C 调用**，没有我们自己的堆。 */
  ['堆：malloc 出来的地方写得进读得出',
    'int *p = (int *) malloc(4 * sizeof(int)); if (!p) return -1;'
    + ' for (int i = 0; i < 4; i++) p[i] = i * i + 1;'
    + ' long long s = 0; for (int i = 0; i < 4; i++) s += p[i];'
    + ' free(p); return s;'],
  ['堆：两块互不相干', 'int *a = (int *) malloc(16); int *b = (int *) malloc(16);'
    + ' if (!a || !b) return -1; *a = 111; *b = 222;'
    + ' long long r = (long long) *a * 1000 + *b; free(a); free(b); return r;'],
  ['固定实参过八个（后几个走栈）', 'return ten(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);'],
  ['固定的 double 实参过八个', 'return (long long) tend(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);'],
  /* 变参函数的**定义**（第二十五片）。个数刻意跨过「寄存器装得下」那条线。 */
  ['变参的定义：四个 int', 'return vsum(4, 1, 2, 3, 4);'],
  ['变参的定义：十个 int（要溢到栈上）', 'return vsum(10, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10);'],
  ['变参的定义：十个 double（要溢到栈上）',
    'return (long long) vdsum(10, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0);'],
  ['变参的定义：类型混着（i64、double、指针）', 'return vmix(3, 7LL, 2.5, "abcd");'],
  ['变参的定义：va_list 传给别人（vprintf 那个形状）', 'return vhead(5, 2, 4, 6, 8, 10);'],
  ['变参的定义：一个变参都没取', 'return vsum(0, 1, 2);'],
  /* va_copy（第三十二片）。 */
  ['va_copy：抄一份，两边各走一遍', 'return vtwice(4, 1, 2, 3, 4);'],
  ['va_copy：十个 int（跨过寄存器那条线）', 'return vtwice(10, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10);'],
  ['va_copy：走了一格之后再抄', 'return vskip(3, 7, 8, 9);'],
  ['va_copy：在收 va_list 的那种函数里抄', 'return vhead2(4, 1, 2, 3, 4);'],
  /* 函数指针（第二十七片）：取地址是真符号地址，调用是间接调用。 */
  ['函数指针：直接调', 'long long (*f)(long long) = dbl; return f(21);'],
  ['函数指针：当实参传下去', 'return apply(trip, 7);'],
  ['函数指针：一张表', 'long long (*t[2])(long long) = {dbl, trip};'
    + ' return t[0](5) * 100 + t[1](5);'],
  ['函数指针：改指向', 'long long (*f)(long long) = dbl; long long a = f(3);'
    + ' f = trip; return a * 100 + f(3);'],
  ['函数指针：比一比', 'long long (*f)(long long) = trip;'
    + ' return (f == dbl) * 10 + (f == trip) + (f != 0) * 100;'],
  ['函数指针：返回 double 的', 'double (*f)(double) = dscale; return (long long) (f(6.0) * 2);'],
  ['函数指针：不带名字也能调（先转成指针）', 'return (*dbl)(50) + pickAdd(1);'],
  /* 初值里的地址（第二十八片）：数据节里的重定位。 */
  ['初值里的地址：指着另一个全局', 'return *g_pg;'],
  ['初值里的地址：带加数（数组里第三格）', 'return *g_p2;'],
  ['初值里的地址：加数是负的', 'return *g_pm;'],
  ['初值里的地址：指着成员', 'return *g_pb;'],
  ['初值里的地址：串常量', 'return g_msg[0] * 100 + (long long) strlen(g_msg);'],
  ['初值里的地址：串常量带加数', 'return g_msg2[0] * 100 + (long long) strlen(g_msg2);'],
  ['初值里的地址：一张串的表',
    'return g_tab[0][0] + g_tab[1][0] * 10 + g_tab[2][0] * 100;'],
  ['初值里的地址：一个函数', 'return g_fp(11);'],
  /* 上界那两格（第二十九片）。 */
  ['帧偏移过 4096（&b 要两条 add）', 'return bigframe();'],
  ['全局要 16/32 字节对齐',
    'return ((long long) &g_al16 % 16) * 1000 + ((long long) &g_al32 % 32) * 100'
    + ' + g_al16 * 10 + g_al32;'],
  /* 非 ASCII 的串常量（第三十片）。 */
  ['非 ASCII 的串常量：局部',
    'char *p = "\\xe4\\xb8\\x96"; return (unsigned char) p[0] * 10000L'
    + ' + (unsigned char) p[1] * 100L + (unsigned char) p[2];'],
  ['非 ASCII 的串常量：全局的初值',
    'return (unsigned char) g_uni[0] * 10000L + (unsigned char) g_uni[1] * 100L + g_uni[2];'],
  ['非 ASCII 的串常量：长度还是字节数', 'return (long long) strlen("\\xe4\\xb8\\x96" "ab");'],
  /* 外部的全局量（第三十一片）。 */
  ['外部的全局量：读', 'return host_g;'],
  ['外部的全局量：写完再读回来', 'host_g = 88; long long r = host_g; host_g = 77; return r;'],
  ['外部的全局量：数组', 'return host_arr[0] * 100 + host_arr[2];'],
  ['外部的全局量：取地址', 'return &host_arr[2] - &host_arr[0];'],
  ['外部的全局量：住在 dylib 里的（标准流的那个指针）', 'return __stdoutp != 0;'],
  ['外部的全局量：errno 那一格（macOS 的 __error）', '*__error() = 42; return *__error();'],
  /* 静态的复合字面量（第三十四片）。 */
  ['静态复合字面量：数组', 'return g_cl[0] * 100 + g_cl[1] * 10 + g_cl[2];'],
  ['静态复合字面量：取 struct 的地址', 'return g_clp->x * 100 + g_clp->y;'],
  ['静态复合字面量：char 数组交给真的 strlen', 'return (long long) strlen(g_cls) * 100 + g_cls[1];'],
  ['静态复合字面量：标量的那一种（值就是里面那一项）', 'return (long long) g_clv;'],
  ['静态复合字面量：没写满的那几格是 0', 'return g_clpart[0] * 10 + g_clpart[3];'],
  ['静态复合字面量：地址加了偏移', 'return g_cloff[0] * 10 + g_cloff[-2];'],
  /* 外部变参函数的地址（第三十五片）：取的是真 libc 里那个符号，按指针调也得按变参 ABI。 */
  ['变参函数指针：按指针调 snprintf',
    'int (*fp)(char *, unsigned long, const char *, ...) = snprintf;'
    + ' char b[32]; return fp(b, 32, "%d-%d", 42, 7);'],
  ['变参函数指针：写出来的字节',
    'int (*fp)(char *, unsigned long, const char *, ...) = snprintf;'
    + ' char b[32]; fp(b, 32, "%d-%d", 42, 7); return b[0] * 100 + b[2] + b[4];'],
  ['变参函数指针：跨过寄存器那条线（八个变参）',
    'int (*fp)(char *, unsigned long, const char *, ...) = snprintf;'
    + ' char b[40]; return fp(b, 40, "%d%d%d%d%d%d%d%d", 1, 2, 3, 4, 5, 6, 7, 8);'],
  ['变参函数指针：double 混着',
    'int (*fp)(char *, unsigned long, const char *, ...) = snprintf;'
    + ' char b[40]; fp(b, 40, "%d %.1f %d", 1, 2.5, 3); return b[2] * 100 + b[4];'],
  ['变参函数指针：一个变参都没有',
    'int (*fp)(char *, unsigned long, const char *, ...) = snprintf;'
    + ' char b[8]; return fp(b, 8, "hi") * 100 + b[0];'],
  ['变参函数指针：与直接用那个名字是同一个地址',
    'int (*fp)(char *, unsigned long, const char *, ...) = snprintf; return fp == snprintf;'],
  /* 变长数组与 alloca（第三十六片）：栈顶真的会动。 */
  ['变长数组：按下标读写', 'int n = 5; int a[n]; int i; long long s = 0;'
    + ' for (i = 0; i < n; i++) a[i] = i * i; for (i = 0; i < n; i++) s += a[i]; return s;'],
  ['变长数组：sizeof 是运行期的', 'int n = 7; int a[n]; return sizeof a;'],
  ['变长数组：地址交给别人', 'int n = 2; int a[n]; a[0] = 3; a[1] = 4;'
    + ' return sq((struct P *) a);'],
  ['变长数组：循环里每一圈收回来', 'int i; long long s = 0;'
    + ' for (i = 1; i <= 200; i++) { int a[i]; a[0] = i; a[i - 1] = i; s += a[0] + a[i - 1]; }'
    + ' return s;'],
  ['变长数组：两个套着', 'int n = 3; int a[n]; { int b[n * 2]; b[5] = 9; a[0] = b[5]; }'
    + ' return a[0];'],
  ['变长数组：中间还调了变参的', 'int n = 4; int a[n]; char b[32]; a[3] = 7;'
    + ' snprintf(b, 32, "%d-%d-%d", 1, 2, 3); return a[3] * 100 + b[0] + b[4];'],
  ['alloca：写进去再读回来', 'char *p = __builtin_alloca(16); p[0] = 3; p[15] = 4;'
    + ' return p[0] * 100 + p[15];'],
  ['alloca：两块不串味', 'char *p = __builtin_alloca(32); char *q = __builtin_alloca(32);'
    + ' p[0] = 1; q[0] = 2; return p[0] * 10 + q[0];'],
  ['alloca：地址交给真的 snprintf', 'char *p = __builtin_alloca(32);'
    + ' snprintf(p, 32, "%d", 4242); return (long long) strlen(p) * 10000 + 4242 - 4242;'],
];

const SUPPORT = `struct P { int x; int y; };
union U { int i; unsigned char b[4]; };
extern unsigned long strlen(const char *);
extern int snprintf(char *, unsigned long, const char *, ...);
extern void *malloc(unsigned long);
extern void free(void *);
long long ten(long long a, long long b, long long c, long long d, long long e,
  long long f, long long g, long long h, long long i, long long j) {
  return a + b*2 + c*3 + d*4 + e*5 + f*6 + g*7 + h*8 + i*9 + j*10; }
double tend(double a, double b, double c, double d, double e,
  double f, double g, double h, double i, double j) {
  return a + b*2 + c*3 + d*4 + e*5 + f*6 + g*7 + h*8 + i*9 + j*10; }
long long helper_addr(int n) { int *p = &n; *p = *p + 1; return n * 2; }
long long sq(struct P *p) { return (long long) p->x * p->x + (long long) p->y * p->y; }
void swap(int *a, int *b) { int t = *a; *a = *b; *b = t; }
long long fib(int n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }
long long depth(int n) { long long here = n; long long *p = &here;
  if (n == 0) return 0; return *p + depth(n - 1); }
int g_i;
int g_init = 4242;
int g_arr[8];
int g_ai[4] = {7, 6, 5, 4};
struct P g_p;
struct P g_ps = {12, 34};
char g_buf[8];
double g_d;
long long bump(void) { static int n = 1; n = n * 2; return n; }
/* 变参函数的定义（第二十五片）。用 __builtin_* 而不是 stdarg.h 的宏：
 * 这一套源码要**同时**喂给 clang（oracle）与我们自己，而 clang 也认这几个内建。 */
long long vsum(int n, ...) {
  __builtin_va_list ap;
  long long s = 0;
  int i;
  __builtin_va_start(ap, n);
  for (i = 0; i < n; i++) s += __builtin_va_arg(ap, int);
  __builtin_va_end(ap);
  return s;
}
double vdsum(int n, ...) {
  __builtin_va_list ap;
  double s = 0;
  int i;
  __builtin_va_start(ap, n);
  for (i = 0; i < n; i++) s += __builtin_va_arg(ap, double);
  __builtin_va_end(ap);
  return s;
}
long long vmix(int n, ...) {
  __builtin_va_list ap;
  __builtin_va_start(ap, n);
  long long a = __builtin_va_arg(ap, long long);
  double d = __builtin_va_arg(ap, double);
  char *p = __builtin_va_arg(ap, char *);
  __builtin_va_end(ap);
  return a + (long long) d * 10 + (long long) strlen(p) * 100;
}
/* va_list 当形参传给别人 —— vprintf 那一族就是这个形状。 */
long long vrelay(int n, __builtin_va_list ap) {
  long long s = 0;
  int i;
  for (i = 0; i < n; i++) s += __builtin_va_arg(ap, int);
  return s;
}
long long vhead(int n, ...) {
  __builtin_va_list ap;
  __builtin_va_start(ap, n);
  long long r = vrelay(n, ap);
  __builtin_va_end(ap);
  return r;
}
/* va_copy（第三十二片）：抄的是**一份新的游标**。这几条都刻意「抄完之后两边各走一遍」——
 * 如果只抄了个指针（SysV 上直接赋值就是那样），第二遍会从第一遍停下的地方接着读。 */
long long vtwice(int n, ...) {
  __builtin_va_list ap, ap2;
  long long a = 0, b = 0;
  int i;
  __builtin_va_start(ap, n);
  __builtin_va_copy(ap2, ap);
  for (i = 0; i < n; i++) a += __builtin_va_arg(ap2, int);
  __builtin_va_end(ap2);
  for (i = 0; i < n; i++) b += __builtin_va_arg(ap, int);
  __builtin_va_end(ap);
  return a * 1000 + b;
}
/* 走了一格之后再抄 —— 抄的是当前的游标，不是起点。 */
long long vskip(int n, ...) {
  __builtin_va_list ap, ap2;
  long long r;
  __builtin_va_start(ap, n);
  __builtin_va_arg(ap, int);
  __builtin_va_copy(ap2, ap);
  r = __builtin_va_arg(ap2, int) * 10 + __builtin_va_arg(ap, int);
  __builtin_va_end(ap2);
  __builtin_va_end(ap);
  return r;
}
/* 在**收 va_list 当形参**的函数里 va_copy：这种函数自己不是变参的，
 * 而 SysV 上它照样要一块新的 24 字节结构。 */
long long vrelay2(int n, __builtin_va_list ap) {
  __builtin_va_list ap2;
  long long s = 0;
  int i;
  __builtin_va_copy(ap2, ap);
  for (i = 0; i < n; i++) s += __builtin_va_arg(ap2, int) * 2;
  __builtin_va_end(ap2);
  for (i = 0; i < n; i++) s += __builtin_va_arg(ap, int);
  return s;
}
long long vhead2(int n, ...) {
  __builtin_va_list ap;
  __builtin_va_start(ap, n);
  long long r = vrelay2(n, ap);
  __builtin_va_end(ap);
  return r;
}
/* 函数指针（第二十七片）：值是符号的真地址，调用是 blr / call *r。 */
long long dbl(long long x) { return x * 2; }
long long trip(long long x) { return x * 3; }
long long apply(long long (*f)(long long), long long x) { return f(x); }
long long pickAdd(int n) { return n == 0 ? dbl(10) : trip(10); }
double dscale(double x) { return x * 2.5; }
/* 初值里的地址（第二十八片）：这几格在目标文件里是**数据节的重定位** ——
 * 编译期算不出来的东西，链接器填。 */
int g_targ = 41;
int g_arr2[4] = {5, 6, 7, 8};
int *g_pg = &g_targ;
int *g_p2 = g_arr2 + 2;
int *g_pm = &g_arr2[3] - 1;
char *g_msg = "omni";
char *g_msg2 = "omni" + 2;
struct P g_pp = {12, 34};
int *g_pb = &g_pp.y;
long long (*g_fp)(long long) = dbl;
char *g_tab[3] = {"aa", "bb", "cc"};
/* 上界那两格（第二十九片）：帧偏移过 4096（取 b 的地址要两条 add），
 * 以及要 16/32 字节对齐的全局（__data 那一节的对齐字段按内容算）。 */
long long bigframe(void) {
  char a[5000]; char b[16]; int i;
  for (i = 0; i < 5000; i++) a[i] = (char) (i % 5);
  b[0] = 9; b[15] = 3;
  return a[4999] * 100 + b[0] * 10 + b[15];
}
int g_al16 __attribute__((aligned(16))) = 5;
int g_al32 __attribute__((aligned(32))) = 6;
/* 非 ASCII 的串常量（第三十片）：常量池里是一串**字节**，不是一串字符。 */
char *g_uni = "\\xc3\\xa9!";
/* 宽串（第三十三片）：一格一个码位。写 int 是因为这个目标上 wchar_t 就是 int。 */
int *g_wp = L"xy";
int g_wa[] = L"ab";
/* 静态的复合字面量（第三十四片）：文件作用域上的 (T){…} 是一块**没有名字**的静态数据，
 * 于是它在数据段里成了一个编出来名字的符号，指向它的初值是一条重定位。 */
int *g_cl = (int []){ 3, 2, 1 };
struct P *g_clp = &(struct P){ 71, 72 };
char *g_cls = (char []){ 'h', 'i', 0 };
void *g_clv = (void *){ (void *) 52 };
int *g_clpart = (int [4]){ 9 };
int *g_cloff = (int []){ 4, 5, 6 } + 2;
/* 外部的全局量（第三十一片）：这个 .o 里它们是**未定义符号**，取地址要过 GOT。
 * host_g 与 host_arr 由 main.c 定义（那份是 clang 编的），
 * __stdoutp 与 __error 来自真的 libc —— 后两个正是「住在 dylib 里」那一种。 */
extern int host_g;
extern long long host_arr[3];
extern void *__stdoutp;
extern int *__error(void);
`;

let src = SUPPORT;
for (let i = 0; i < CASES.length; i++) src += `long long probe${i}(void) { ${CASES[i][1]} }\n`;

/* main.c 由 clang 编，`host_g`/`host_arr` 的**定义**放在这一边 ——
 * probe.c 那一边只声明，于是它们在我们的 .o 里是未定义符号。 */
const mainSrc = ['int host_g = 77;', 'long long host_arr[3] = {5, 6, 7};'];
mainSrc.push('extern long long probe0(void);');
for (let i = 1; i < CASES.length; i++) mainSrc.push(`extern long long probe${i}(void);`);
mainSrc.push('extern int printf(const char *, ...);');
mainSrc.push('int main(void) {');
for (let i = 0; i < CASES.length; i++) mainSrc.push(`  printf("%lld\\n", probe${i}());`);
mainSrc.push('  return 0;\n}');
const MAIN = mainSrc.join('\n');

// ---------------------------------------------------------------- 前端
let failed = 0;
let total = 0;
const fail = (what, ours, want) => {
  failed++;
  process.stdout.write(`  FAIL ${what}\n    ours ${ours}\n    want ${want}\n`);
};

const { mod } = lowerCNative('probe.c', src, HOST);
const errs = verifyMir(mod);
if (errs.length > 0) {
  process.stdout.write(`c/native: MIR 不良构：\n  ${errs.join('\n  ')}\n`);
  process.exit(1);
}
/* native 这条腿上**一格线性内存都不该有**。这一条不是形式：只要 `mod.mem` 非空，
 * 就说明有东西又落回偏移上去了，而那种指针在真机器上指向 64K 那个地址。 */
total++;
if (mod.mem !== null) fail('native 的模块没有线性内存', JSON.stringify(mod.mem), 'null');

// ---------------------------------------------------------------- 后端 + 真跑
const CLANG = ['/usr/bin/clang', '/opt/homebrew/opt/llvm/bin/clang'].find((p) => existsSync(p));
if (CLANG === undefined) {
  process.stdout.write('c/native: 没找到 clang，跳过\n');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'omni-cnative-'));
try {
  const srcPath = join(dir, 'probe.c');
  const mainPath = join(dir, 'main.c');
  writeFileSync(srcPath, src);
  writeFileSync(mainPath, MAIN);

  /* oracle：整份交给 clang（本机架构就够 —— C 的语义与架构无关）。 */
  const oraclePath = join(dir, 'oracle');
  execFileSync(CLANG, [srcPath, mainPath, '-o', oraclePath], { stdio: 'pipe' });
  const want = execFileSync(oraclePath, [], { encoding: 'utf8' }).trim().split('\n');
  if (want.length !== CASES.length) {
    process.stdout.write(`c/native: oracle 印了 ${want.length} 行，用例 ${CASES.length} 条\n`);
    process.exit(1);
  }

  const legs = [{ arch: 'x86_64', gen: genX64, cc: ['-arch', 'x86_64'] }];
  /* arm64 那条腿只在 Apple Silicon 上跑得起来（x86_64 那条靠 Rosetta，反过来没有）。 */
  if (process.arch === 'arm64') legs.unshift({ arch: 'arm64', gen: genArm64, cc: ['-arch', 'arm64'] });

  for (const leg of legs) {
    const blob = leg.gen(mod);
    const defs = [];
    for (let k = 0; k < mod.funcs.length; k++) {
      defs.push({ name: mod.funcs[k].name, off: blob.offsets[k] });
    }
    const objPath = join(dir, `probe-${leg.arch}.o`);
    writeFileSync(objPath, writeObject(blob.bytes, blob.data,
      [...defs, ...blob.dataSyms], [...blob.relocs, ...blob.dataRelocs],
      leg.arch, blob.dataAlign));
    const progPath = join(dir, `prog-${leg.arch}`);
    execFileSync(CLANG, [...leg.cc, mainPath, objPath, '-o', progPath], { stdio: 'pipe' });
    const out = execFileSync(progPath, [], { encoding: 'utf8' }).trim().split('\n');
    for (let i = 0; i < CASES.length; i++) {
      total++;
      if (out[i] === want[i]) continue;
      fail(`${leg.arch}：${CASES[i][0]}`, out[i], want[i]);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 边界
/* 这一节曾经列着「还要线性内存的那些东西必须明着报」。第三十六片之后它**空了** ——
 * native 这条腿上再没有哪一格偷偷落回偏移上去，所以那一栏一条都不剩。
 * 唯一的守卫留在前端里：`mod.mem !== null` 那一条（见上面）。 */

process.stdout.write(`\n${total - failed} passed, ${failed} failed\n`);
if (failed !== 0) process.exitCode = 1;
