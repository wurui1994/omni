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
/* 嵌在块里那一段自己的 buf（理由写在 main 里那一段的头上）。 */
static jmp_buf jb3;

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
/* 嵌在块里那一段的跳法（隔一层，与 `inner` 一样要退掉中间的帧） */
static void jump3(int n) { printf("  jump3(%d)\n", n); longjmp(jb3, n); }

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

  /* ---- 跳回**嵌在块里**的那一格（JS 腿也发这一对了，ADR-0047）。
   *
   * 上面几格的 `setjmp` 都在函数的最外一层，而 JS 那条腿是靠"从函数开头重新走一遍、
   * 把沿路的语句跳过去"落回去的 —— 所以真正要验的是**落点藏在 if / else / 循环里**
   * 的形状：导航要认得该进哪一支、该进几层。
   *
   * 这一段用**自己那个 buf**（`jb3`）：拿上面的 `jb` 会落回 round 那一格（它是最后
   * 装上去的），于是两格互相跳个没完 —— 一开始就是这么写错的。 */
  volatile int deep = 0;
  volatile int i;
  if (sum > 0) {                       /* 落点在 then 那一支里，再套一层循环 */
    for (i = 0; i < 2; i++) {
      r = setjmp(jb3);
      printf("deep i=%d r=%d\n", i, r);
      if (r == 0 && deep == 0) { deep = 1; jump3(7); }
    }
  } else {
    printf("不该走到这儿\n");
  }
  sum += deep;

  /* 落点在 **else** 那一支里：导航的时候那个条件不重算，靠"$rs 指着哪一支"决定 */
  if (sum < 0) {
    printf("也不该走到这儿\n");
  } else {
    r = setjmp(jb3);
    printf("else r=%d\n", r);
    if (r == 0) jump3(3);
    sum += r;
  }

  /* ---- 跳完之后照常往下走：setjmp 那一帧的局部量还在 */
  printf("sum=%d\n", sum);
  return sum & 0xff;
}
