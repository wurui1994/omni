/* 对象式宏。要钉住的是「什么时候停止展开」—— 递归防护那条链。 */

#define ONE 1
#define TWO ONE + ONE
#define THREE TWO + ONE
int a = THREE;

/* 空宏体：名字整个消失，但它占的位置要留一个空格的余地 */
#define NOTHING
int b = NOTHING 1 NOTHING;
int NOTHING c;

/* 自指：展开一次就停（`#define REC REC`），不是死循环 */
#define REC REC
#define REC2 REC2 + REC2
int d = REC;
int e = REC2;

/* 互相引用：两个都只展开一次 */
#define PING PONG
#define PONG PING
int f = PING;

/* 展开的结果里出现别的宏名，那些要接着展开 */
#define LEVEL1 LEVEL2
#define LEVEL2 LEVEL3
#define LEVEL3 42
int g = LEVEL1;

/* #undef 之后名字回到普通标识符 */
#define GONE 7
int h = GONE;
#undef GONE
int i = GONE;
#undef GONE
#undef NEVER_DEFINED

/* 重定义成同一个东西是允许的（tcc 连警告都不出） */
#define SAME 1
#define SAME 1
int j = SAME;

/* 宏名与关键字同形：`#define int long` 是合法的，而且真的会生效 */
#define myint int
myint k;

/* 宏体里的空白折成一个，首尾的不留 */
#define SPACES    1    +    2
int l = SPACES;

/* 宏体里可以有任何记号，包括不配对的括号与逗号 */
#define OPEN (
#define CLOSE )
#define COMMA ,
int m[] = OPEN 1 COMMA 2 CLOSE;

/* 展开出来的东西不会被当成指令：`#` 在展开结果里只是个记号 */
#define HASH #
int n = 1; HASH define not_a_directive
