/* 函数式宏。最容易写错的一格是「名字后面没跟 `(` 就不是一次调用」——
   而那个 `(` 可以在下一行、可以隔着注释、甚至可以在上一层宏展开的尾巴之后。 */

#define ADD(a, b) ((a) + (b))
int a = ADD(1, 2);
int b = ADD(ADD(1, 2), 3);

/* `(` 必须紧贴宏名才是函数式宏：这一个是对象式的，体就是 `(x) x` */
#define NOTFUNC (x) x
int c = NOTFUNC;

/* 名字后面没有 `(`：原样留下，不报错 */
#define F(x) [x]
int d = 1; /* F 单独出现 */
int e = sizeof F;
int f = F (1);

/* `(` 在下一行 */
int g = ADD
  (1,
   2);

/* `(` 隔着注释 */
int h = ADD/* 中间 */(3, 4);

/* 空实参是合法的 */
#define E1(x) [x]
#define E2(x, y) [x|y]
int i = E1();
int j = E2(,);
int k = E2(1,);
int l = E2(,2);

/* 一个形参都没有的宏只能用 `()` 调 */
#define NOARG() 99
int m = NOARG();

/* 括号要配平地切分逗号：这是一个实参，不是两个 */
#define ONEARG(x) <x>
int n = ONEARG((1, 2));
int o = ONEARG(f(1, 2));

/* 实参里的记号先整个展开一遍，再代进去 */
#define VAL 5
int p = ADD(VAL, VAL);

/* 实参被用了多次：展开结果缓存，但每次都要代进去 */
#define TWICE(x) (x) + (x)
int q = TWICE(ADD(1, 2));

/* 形参与外面的同名标识符不冲突 */
#define SHADOW(a) (a + 1)
int a2 = SHADOW(a);

/* 宏调用的实参里可以有换行与注释，它们折成一个空格 */
int r = ADD(
  1,   /* 第一个 */
  2    /* 第二个 */
);

/* 递归的函数式宏：展开一次就停 */
#define RF(x) RF(x) + 1
int s = RF(1);

/* 展开结果的末尾是另一个函数式宏名，而它的 `(` 在调用点之后 —— tcc 会接着往下读 */
#define TAIL ADD
int t = TAIL(6, 7);

/* 形参名恰好是关键字或另一个宏名 */
#define KW(int) (int)
int u = KW(8);

/* 一层宏的**体里**又调一个函数式宏，而那个 `(` 前面隔着一个空格。
   `tccpp.c:3286` 的 `while (t == ' ' || --i)` 是短路的：空白**不减**那个计数。
   数错的话 `SP(zz)` 会被当成两个实参 —— tcc 自己的 `ELFW(ST_BIND)` 撞的正是这一格
   （第八刀第二十片）。 */
#define BRK(val) [val]
#define SP(val) BRK (val)
int v = 0; /* SP(zz) 在下一行 */
int w[] = { SP(1), SP(2) };
#define ELFW(sym) ELF32_##sym
#define ELF32_ST_BIND(i) ((i) >> 4)
int x1 = ELFW(ST_BIND) (0x12);
