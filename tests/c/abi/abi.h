/* 按值收发 struct 的 ABI：形状按 AAPCS64 与 SysV x86_64 的**分岔**挑（第一百三十一片）。
 *
 * 一份定义、一份调用，两份各自可以由我们或者由 cc 编 —— 三种混法都要与「两份都 cc 编」
 * 逐字节相同（见 `tests/c/run.js` 第 4.7 节）。挑这八个形状是因为它们各自落在一条不同的
 * ABI 规则上，少一个就有一条规则没人看着：
 *
 *   S8   8 字节         一个整数寄存器（arm64 C.10 / SysV 一个 INTEGER 格）
 *   S16  16 字节        两个整数寄存器
 *   S24  24 字节        **超过 16**：arm64 换成指针（B.3）、SysV 进 MEMORY 走栈
 *   D2   两个 double    arm64 的 **HFA**（B.2/C.2，两个 v 寄存器）、SysV 两个 SSE 格
 *   F3   三个 float     HFA 的第二种宽度（12 字节，三个 s 寄存器）
 *   I12  12 字节        **不是 8 的整数倍**：末格不满，读写都不许越过那一块
 *   C5   5 字节         同上，更窄
 *   mix  掺着来          两串寄存器各自数、放不下的落栈 —— 「串位」只在这一条上露出来
 *
 * 第九格是**变参里的聚合**（第一百五十四片）：`...` 后面的 struct 与固定形参那一套不是
 * 同一条路。arm64 上 >16 字节的聚合在变参区里放的是**一个指针**（B.3 照旧生效），≤16 的
 * 摊在格子里；SysV 上一律摊在栈上。读的那一侧（`va_arg`）必须与写的那一侧同一条规则 ——
 * 而「两头用同一套错约定」是自洽的，所以这一条也得放到"与 cc 对账"这张桌子上来。
 * 量出来的：`va_arg` 那一侧从前一律按"内容摊在格子里"算，24 字节的 struct 读到的是垃圾。
 */
typedef struct { long long a; } S8;
typedef struct { long long a, b; } S16;
typedef struct { long long a, b, c; } S24;
typedef struct { double x, y; } D2;
typedef struct { float p, q, r; } F3;
typedef struct { int i; int j; int k; } I12;
typedef struct { char c[5]; } C5;

long long take8(S8 s);
long long take16(S16 s);
long long take24(S24 s);
double takeD2(D2 d);
double takeF3(F3 f);
long long takeI12(I12 v);
long long takeC5(C5 v);
long long mix(long long z, S16 s, double d, D2 dd, S24 big, int t);
/* 变参那一格：一趟里把 >16、≤16、HFA、标量四种都过一遍（次序刻意掺着）。 */
long long vamix(int n, ...);

S8 mk8(long long a);
S16 mk16(long long a, long long b);
S24 mk24(long long a, long long b, long long c);
D2 mkD2(double x, double y);
F3 mkF3(float p, float q, float r);
I12 mkI12(int i, int j, int k);
C5 mkC5(char c0, char c4);
