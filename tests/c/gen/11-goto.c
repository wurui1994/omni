/* 第六刀第十片：goto。结构化控制流下它是一台**状态机** ——
 * 带标签的块外面套一圈 LOOP，循环开头按状态分派，`goto Li` = 写状态 + 回到开头。
 * 与 switch 共用「一个标签关掉一层 block」那个骨架，多的只有 LOOP 与状态槽。
 *
 * printf 一定要先有声明：arm64 的变参走栈，没声明时 **tcc 自己**会编错，
 * 那样 oracle 就不能用了（第五片踩过）。第八刀第三片起它从 `<stdio.h>` 来。 */

#include <stdio.h>

/* 往回跳 —— tinycc 自己的源码里到处是这个形状（`goto redo;`） */
static int back(int n) {
  int s = 0;
  int i = 0;
again:
  s += i;
  i++;
  if (i < n) goto again;
  return s;
}

/* 往前跳：跳过中间一段 */
static int fwd(int x) {
  int s = 1;
  if (x > 0) goto skip;
  s += 10;
  s += 20;
skip:
  s += 100;
  return s;
}

/* 从循环里跳出去：标签在外围的块上，于是要跨过 for 那几层 */
static int out(int n) {
  int s = 0;
  int i;
  for (i = 0; i < n; i++) {
    s += i;
    if (s > 10) goto done;
  }
  s += 1000;
done:
  return s;
}

/* 一个块上好几个标签，而且互相跳（前向、后向混着） */
static int chain(int x) {
  int s = 0;
  if (x == 1) goto one;
  if (x == 2) goto two;
  goto three;
one:
  s += 1;
  goto three;
two:
  s += 2;
three:
  s += 4;
  return s;
}

/* 嵌套：里层块自己有标签，而里层也能跳到外层的标签 */
static int nest(int x) {
  int s = 0;
  {
    int i = 0;
  inner:
    i++;
    s += i;
    if (i < 3) goto inner;
    if (x) goto outer;
    s += 100;
  }
  s += 1000;
outer:
  return s;
}

/* 出错收尾那个形状（tinycc 里的 `goto fail;`） */
static int cleanup(int x) {
  int s = 0;
  if (x & 1) goto fail;
  s += 1;
  if (x & 2) goto fail;
  s += 2;
  return s;
fail:
  s += 100;
  return s;
}

/* 标签与局部量同名：C 有四个独立的名字空间（C11 6.2.3） */
static int shadow(void) {
  int done = 5;
  goto done;
done:
  return done;
}

/* switch 里跳到 switch 外的标签 */
static int fromsw(int x) {
  int s = 0;
  switch (x) {
  case 1: s = 1; goto end;
  case 2: s = 2; break;
  default: s = 9;
  }
  s += 100;
end:
  return s;
}

/* 循环里的 goto 当 continue 用：标签在循环体自己那个块上 */
static int inloop(int n) {
  int s = 0;
  int i;
  for (i = 0; i < n; i++) {
    if (i & 1) goto next;
    s += i;
  next:
    s += 1;
  }
  return s;
}

/* 两层循环，goto 一把跳到最外面 */
static int deep(void) {
  int s = 0;
  int i, j;
  for (i = 0; i < 5; i++) {
    for (j = 0; j < 5; j++) {
      s += 1;
      if (i * j > 4) goto stop;
    }
    s += 100;
  }
  s += 10000;
stop:
  return s;
}

int main(void) {
  int s = 0;

  s += back(1) + back(5) + back(0);          /* 0 + 10 + 0 */
  s += fwd(1) + fwd(-1);                     /* 101 + 131 */
  s += out(3) + out(9);                       /* 1003 + 15 */
  s += chain(1) + chain(2) + chain(3);        /* 5 + 6 + 4 */
  s += nest(0) + nest(1);                     /* 1106 + 6 */
  s += cleanup(0) + cleanup(1) + cleanup(2);  /* 3 + 100 + 101 */
  s += shadow();                              /* 5 */
  s += fromsw(1) + fromsw(2) + fromsw(7);     /* 1 + 102 + 109 */
  s += inloop(6);                             /* 0+2+4 + 6 = 12 */
  s += deep();                                /* 5+100 + 5+100 + 4 = 214 */

  printf("back=%d fwd=%d out=%d\n", back(5), fwd(-1), out(9));
  printf("nest=%d deep=%d inloop=%d\n", nest(0), deep(), inloop(6));
  printf("s=%d\n", s);
  return s & 255;
}
