/* 第八刀第二十二片：`setjmp` / `longjmp`。
 *
 * tinycc 的错误恢复就是这一对（libtcc.c 的 `_tcc_error` -> `longjmp(s1->error_jmp_buf, 1)`，
 * 落点在 `tcc_compile` 的 `if (setjmp(…) == 0)`），所以编出来的 tcc 一报错就要走它。
 *
 * 在 `sys/` 而不在 `gen/`：`jmp_buf` 的形状（多大、什么类型）由真的 `<setjmp.h>` 定。
 *
 * `volatile`：C11 7.13.2.1 只保证 `volatile` 的自动变量在 longjmp 之后还是那个值。
 * 用静态的与 volatile 的，两条腿才都在标准里，而不是在比「谁的未定义行为一样」。 */
#include <stdio.h>
#include <setjmp.h>

static jmp_buf jb;
static jmp_buf jb2;

/* 隔一层再跳：中间那些帧要被退掉 */
static void inner(int n) {
  printf("  inner(%d)\n", n);
  longjmp(jb, n);
}
static void outer(int n) {
  printf(" outer(%d)\n", n);
  inner(n);
  printf(" outer 不该回来\n");
}

/* `longjmp(buf, 0)` 那一格：setjmp 那边该回 1，不是 0 */
static void zero_jump(void) { longjmp(jb2, 0); }

int main(void) {
  int sum = 0;

  /* ---- 一次跳：setjmp 先回 0，longjmp 之后回 v */
  int r = setjmp(jb);
  printf("setjmp=%d\n", r);
  if (r == 0) outer(5);
  sum += r;

  /* ---- 同一个 buf 上再装一次，后一次盖掉前一次 */
  volatile int rounds = 0;
  r = setjmp(jb);
  rounds = rounds + 1;
  printf("round %d r=%d\n", rounds, r);
  if (rounds < 3) inner(rounds * 10);
  sum += rounds;

  /* ---- v 是 0 的那一格 */
  r = setjmp(jb2);
  if (r == 0) {
    printf("zero: 去跳\n");
    zero_jump();
  }
  printf("zero: r=%d\n", r);
  sum += r;

  /* ---- 跳完之后照常往下走：setjmp 那一帧的局部量还在 */
  printf("sum=%d\n", sum);
  return sum & 0xff;
}
