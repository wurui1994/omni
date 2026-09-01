/* 第六刀第九片：switch。结构化控制流下它是「层层嵌套的 block」，
 * 一个标签 = 关掉一层，于是**贯穿自动就对**。
 * 密集的值走 BRTABLE，疏的走一串比较 —— 两条路都要跟 tcc 逐字节相同。 */

#include <stdio.h>

/* 密集：0..4 连号，走 BRTABLE */
static int dense(int x) {
  switch (x) {
  case 0: return 10;
  case 1: return 11;
  case 2: return 12;
  case 3: return 13;
  case 4: return 14;
  default: return -1;
  }
}

/* 疏：值差得很远，走比较链 */
static int sparse(int x) {
  switch (x) {
  case 1: return 100;
  case 1000000: return 200;
  case -7: return 300;
  default: return 0;
  }
}

/* 贯穿：没有 break 就掉到下一个标签 */
static int fall(int x) {
  int s = 0;
  switch (x) {
  case 1:
    s += 1;
  case 2:
    s += 2;
  case 3:
    s += 4;
    break;
  case 4:
    s += 8;
  }
  return s;
}

/* default 在中间，而且它后面的标签照样能贯穿到 */
static int middef(int x) {
  int s = 0;
  switch (x) {
  case 1:
    s = 1;
    break;
  default:
    s = 100;
  case 2:
    s += 2;
    break;
  case 3:
    s = 3;
  }
  return s;
}

/* 没有 default：一个都没命中就整块跳过 */
static int nodef(int x) {
  int s = 5;
  switch (x) {
  case 7: s = 70; break;
  case 8: s = 80; break;
  }
  return s;
}

/* switch 套在循环里：break 归 switch，continue 归循环 */
static int inloop(int n) {
  int s = 0;
  int i;
  for (i = 0; i < n; i++) {
    switch (i % 4) {
    case 0:
      continue;              /* 归 for */
    case 1:
      s += 1;
      break;                 /* 归 switch */
    case 2:
      if (i > 5) s += 100;
      s += 2;
      break;
    default:
      s += 3;
      break;
    }
    s += 1000;               /* break 落到这儿，continue 不 */
  }
  return s;
}

/* switch 套 switch：里层的 case 归里层 */
static int nested(int a, int b) {
  int s = 0;
  switch (a) {
  case 1:
    switch (b) {
    case 1: s = 11; break;
    case 2: s = 12; break;
    default: s = 19;
    }
    break;
  case 2:
    s = 20;
    break;
  default:
    s = 90;
  }
  return s;
}

/* enum 与 char 当控制表达式；case 的值要按提升之后的类型收口 */
enum E { A, B, C };
static int onenum(enum E e) {
  switch (e) {
  case A: return 1;
  case B: return 2;
  case C: return 3;
  }
  return 0;
}

static int onchar(char c) {
  switch (c) {
  case 'a': return 1;
  case 'z': return 26;
  case '\n': return 99;
  }
  return 0;
}

/* long long 的控制表达式，值超过 32 位 */
static int wide(long long x) {
  switch (x) {
  case 0: return 1;
  case 4294967296LL: return 2;      /* 2^32 —— 截成 32 位会与 case 0 撞 */
  case 4294967297LL: return 3;
  default: return 0;
  }
}

/* 空的 switch 与只有 default 的 switch */
static int weird(int x) {
  int s = 0;
  switch (x) {
  }
  switch (x) {
  default: s = 7;
  }
  return s;
}

int main(void) {
  int s = 0;
  int i;

  for (i = -1; i <= 5; i++) s += dense(i);
  printf("dense=%d\n", s);                    /* 10+..+14 = 60，两个 -1 -> 58 */

  s += sparse(1) + sparse(1000000) + sparse(-7) + sparse(5);   /* 600 */
  for (i = 0; i <= 5; i++) s += fall(i);      /* 7+6+4+8+0+0 = 25 */
  for (i = 0; i <= 4; i++) s += middef(i);    /* 102+1+2+3+102 = 210 */
  s += nodef(7) + nodef(8) + nodef(9);        /* 70+80+5 = 155 */
  s += inloop(9);
  s += nested(1, 1) + nested(1, 2) + nested(1, 5) + nested(2, 0) + nested(9, 0);
  s += onenum(A) + onenum(B) + onenum(C);     /* 6 */
  s += onchar('a') + onchar('z') + onchar('\n') + onchar('q');  /* 126 */
  s += wide(0) + wide(4294967296LL) + wide(4294967297LL) + wide(99);  /* 6 */
  s += weird(3);                              /* 7 */

  printf("inloop=%d nested=%d\n", inloop(9), nested(1, 2));
  printf("s=%d\n", s);
  return s & 255;
}
