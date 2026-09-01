/* `#`（字符串化）与 `##`（粘接）。这两个是宏里唯一「不展开实参」的位置，
   而 `##` 粘出来的字节要**重新过一遍词法** —— 粘成一个标识符还是两个记号，差别很大。 */

#define STR(x) #x
#define XSTR(x) STR(x)

/* `#` 拿的是**原文**，不是展开后的值 */
#define VAL 42
char *a = STR(VAL);
char *b = XSTR(VAL);

/* 原文里的空白折成一个空格，首尾不留 */
char *c = STR(  1   +   2  );

/* 引号与反斜杠要转义；单引号不要 */
char *e = STR("quoted");
char *f = STR('c');
char *g = STR(a\b);
char *h = STR("has \"inner\" quotes");

/* `##` 粘出一个标识符 */
#define CAT(a, b) a##b
int CAT(foo, bar) = 1;
int CAT(x, 1) = 2;
char *i = STR(CAT(a, b));

/* 粘出一个运算符 */
#define OP(a, b) a##b
int j = 1 OP(+, +) 2;
int k = 1 OP(<, <) 2;

/* 粘接的两侧不展开实参 */
#define AB ab
char *l = STR(CAT(A, B));
#define A a
#define B b
char *m = STR(CAT(A, B));

/* 空实参 + `##`：占位符消失 */
#define CAT3(a, b, c) a##b##c
int CAT3(p, , q) = 3;
int CAT3(, r, ) = 4;

/* 两级粘接与展开的先后 */
#define JOIN(a, b) CAT(a, b)
#define PREFIX my
int JOIN(PREFIX, _var) = 5;
int CAT(PREFIX, _var2) = 6;

/* 可变实参 */
#define LOG(fmt, ...) printf(fmt, __VA_ARGS__)
void printf(const char *, ...);
void n(void) { LOG("%d %d\n", 1, 2); }

/* `, ## __VA_ARGS__`：可变实参为空时把那个逗号一起吃掉（gcc 的老把戏） */
#define LOG2(fmt, ...) printf(fmt , ## __VA_ARGS__)
void o(void) { LOG2("x\n"); LOG2("%d\n", 7); }

/* 命名的可变实参（gcc 的 `args...` 写法） */
#define LOG3(fmt, args...) printf(fmt, args)
void p(void) { LOG3("%d\n", 8); }

/* 可变实参整个省掉 */
#define LOG4(fmt, ...) printf(fmt)
void q(void) { LOG4("y\n"); }

/* 可变实参里的逗号不切分 */
#define COUNT(...) f(__VA_ARGS__)
void r(void) { COUNT(1, 2, 3); }

/* `#` 作用在可变实参上 */
#define STRV(...) #__VA_ARGS__
char *s = STRV(1, 2, 3);
char *t = STRV();
