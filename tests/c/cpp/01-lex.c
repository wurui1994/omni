/* 词法：期望值不写在这里 —— 它是 `tcc -E -P` 的输出，逐字节比。
   这一份要钉住的是「输出还能再被读一遍」：记号之间该有空格的地方必须有。 */

int a;
    int    b;	int c;

/* 注释在输出里是一个空格 */
int/**/d;
int e/* 跨
多行的注释，行号要照数 */;

// 行注释也是一个空格
int f;

/* 行拼接：反斜杠加换行，在词法之前就消失，但行号照加 */
int g\
h;
char *s = "a\
b";

/* 相邻记号会不会粘：pp_need_space 那四条 */
int i = 1;
int j = 0x1e+2;
int k = 1e+5 == 100000;
int l = + +a;
int m = - -a;
int n = a+ +b;
int o = a- -b;

/* 数是「预处理数」，原文照抄，不在这一步解释 */
double p1 = 1.5e-3, p2 = 0x1p3, p3 = 0xdeadBEEF, p4 = 007;
long long p6 = 18446744073709551615ULL;

/* 字符串与字符常量：转义一个都不解，原样印回 */
char *q1 = "he said \"hi\"\n";
char *q2 = "\0\1\xff\\";
char q3 = '\'';
char q4 = '\\';
wchar_t *q5 = L"wide";
wchar_t q6 = L'w';

/* 运算符的最长匹配 */
int r1 = a << 1, r2 = a >> 1, r3 = a <<= 1, r4 = a >>= 1;
int r5 = a <= b, r6 = a >= b, r7 = a == b, r8 = a != b;
int r9 = a && b, r10 = a || b, r11 = a & b, r12 = a | b;
int r13 = a += 1, r14 = a -= 1, r15 = a *= 1, r16 = a /= 1;
int r17 = a %= 1, r18 = a &= 1, r19 = a |= 1, r20 = a ^= 1;
int r21 = a++, r22 = a--, r23 = ++a, r24 = --a;
struct S { int x; } *sp; int r25 = sp->x, r26 = (*sp).x;
int r27[3] = { 1, 2, 3 };
int r28 = a ? b : c;
int r29 = ~a, r30 = !a;
void va(int, ...);
