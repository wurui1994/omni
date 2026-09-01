/* 第六刀第一片：语句 —— if/else、while、do、for、break、continue、嵌套作用域。 */
int main(void) {
  int s = 0;

  /* if / else if / else */
  int x = 3;
  if (x == 1) s += 10;
  else if (x == 3) s += 20;
  else s += 30;                   /* 20 */

  /* 空语句体与不带 else 的 if */
  if (0) s += 100;
  if (1) ;
  s += 1;                         /* 21 */

  /* while + continue + break */
  int i = 0;
  while (i < 10) {
    i++;
    if (i == 2) continue;
    if (i == 7) break;
    s += i;                       /* 1+3+4+5+6 = 19 -> 40 */
  }
  s += i;                         /* 7 -> 47 */

  /* while 的条件是「非零」，不是「等于 1」 */
  int n = 3;
  while (n) { n--; s++; }         /* 3 -> 50 */

  /* do-while 至少跑一遍 */
  int j = 100;
  do { s++; j++; } while (j < 0); /* 1 -> 51 */

  /* do-while 里的 continue 去测条件，不是跳过条件 */
  int k = 0;
  do {
    k++;
    if (k < 3) continue;
    s += k;                       /* 3 -> 54 */
  } while (k < 3);

  /* for：三段都有 */
  int a;
  for (a = 0; a < 5; a++) s += a;  /* 0+1+2+3+4 = 10 -> 64 */

  /* for 的声明式初始化（C99），以及 continue 之后步进照跑 */
  for (int b = 0; b < 6; b++) {
    if (b == 2) continue;
    s += b;                        /* 0+1+3+4+5 = 13 -> 77 */
  }

  /* for 的三段都可以空 */
  int c = 0;
  for (;;) {
    c++;
    if (c == 4) break;
  }
  s += c;                          /* 4 -> 81 */

  for (c = 0; c < 3;) { c++; }
  s += c;                          /* 3 -> 84 */

  /* 步进段有逗号表达式 */
  int p;
  int q;
  for (p = 0, q = 10; p < q; p++, q--) s++;   /* 5 轮 -> 89 */

  /* 嵌套循环：break 只跳出最里那一层 */
  int r = 0;
  for (int m = 0; m < 3; m++) {
    for (int t = 0; t < 3; t++) {
      if (t == 1) break;
      r++;
    }
  }
  s += r;                          /* 3 -> 92 */

  /* 嵌套循环：continue 也只作用于最里那一层 */
  r = 0;
  for (int m = 0; m < 3; m++) {
    for (int t = 0; t < 3; t++) {
      if (t == 1) continue;
      r++;
    }
  }
  s += r;                          /* 6 -> 98 */

  /* 内层作用域遮蔽外层同名变量 */
  int v = 1;
  {
    int v = 40;
    s += v;                        /* 40 -> 138 */
  }
  s += v;                          /* 1 -> 139 */

  /* 循环体里声明的变量每轮都是新的 */
  for (int m = 0; m < 3; m++) {
    int fresh = 2;
    fresh++;
    s += fresh;                    /* 3*3 = 9 -> 148 */
  }

  /* if 的分支里 return */
  if (s == 148) return s + 1;
  return 0;
}
