/* 第八刀第五十六片：实参里的宏不许吃外面的记号流。
 *
 * `qq(qq)(2)`（tcctest.c:262，注释就写着 "should not eat stream"）：展开实参 `qq` 时
 * 它是个函数式宏名，于是要预看下一个记号是不是 `(` —— 那个 `(` 必须**看不到**，
 * 因为它在实参之外。实现就是让每个实参的记号串以 TOK_EOF 收尾。 */
#include <stdio.h>

int qq(int x) { return x + 40; }
#define qq(x) x

#define F(a) a
#define G2(a, b) a b
#define STR(x) #x
#define J(a, b) a ## b
#define VA(f, ...) printf(f, ## __VA_ARGS__)
#define EMPTY
#define CALLIT(m) m(5)

static int add(int a, int b) { return a + b; }
#define add(a, b) add((a), (b))

int main(void) {
  /* 实参末尾的函数式宏名：后面的 `(2)` 不算它的实参，所以留下的是函数 qq */
  printf("qq=%d %d\n", qq(qq)(2), F(qq)(3));

  /* 两层也一样 */
  printf("w=%d\n", F(F(qq))(4));

  /* 宏在自己的展开里不再展开（「刷蓝漆」）：add 展开成对函数 add 的调用 */
  printf("add=%d\n", add(2, 3));

  /* 空实参、字符串化、粘贴、可变实参：加了 TOK_EOF 之后这些还得照旧 */
  printf("s=[%s] [%s] [%s]\n", STR(qq(1)), STR(), STR(a b));
  printf("j=%d %d\n", J(1, 2), J(, 7));
  VA("va\n");
  VA("va %d %d\n", 7, 8);
  printf("g=%d\n", G2(1, +2));
  printf("e=%d\n", F(EMPTY 9));

  /* 实参里的宏名后面**确实**跟着 `(` 的那一种照旧是一次调用 */
  printf("c=%d\n", CALLIT(qq));
  return 0;
}
