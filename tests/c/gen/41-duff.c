/* 第八刀第十五片：`case` 标签长在里层的控制结构里 —— 真的 Duff's device。
 *
 * 这一格原来是钉子（`gen-bad/duff.c`）。做法：长在里层的 case 在状态机眼里**就是一个
 * 没有名字的标签** —— 第一遍领个编号，分派那边发一小段蹦床「写状态、回函数那圈 LOOP」，
 * 此后与一条 `goto` 走的是同一条路。
 */
#include <stdio.h>
#include <string.h>

/* 教科书上那个：`case 0:` 直接长在 switch 体上，`case 7..1` 长在 `do` 的循环体里 */
static void duff(char *to, const char *from, int count) {
  int n = (count + 7) / 8;
  if (count <= 0) return;
  switch (count % 8) {
  case 0: do { *to++ = *from++;
  case 7:      *to++ = *from++;
  case 6:      *to++ = *from++;
  case 5:      *to++ = *from++;
  case 4:      *to++ = *from++;
  case 3:      *to++ = *from++;
  case 2:      *to++ = *from++;
  case 1:      *to++ = *from++;
          } while (--n > 0);
  }
}

/* case 长在 `if` 的两半里 */
static int in_if(int x, int flag) {
  int t = 0;
  switch (x) {
  case 0:
    t += 1;
    if (flag) {
  case 1:
      t += 10;
    } else {
  case 2:
      t += 100;
    }
    t += 1000;
    break;
  case 3:
    t += 10000;
    break;
  }
  return t;
}

/* case 长在 `while` 的循环体里，而且与一条真的语句标签混在一起 */
static int in_while(int x) {
  int t = 0;
  int i = 0;
  switch (x) {
  case 0:
    t += 1;
    while (i < 3) {
      i++;
  case 1:
      t += 10;
      if (t > 100) goto out;
    }
    t += 1000;
    break;
  default:
    t += 100000;
  }
out:
  t += 1;
  return t;
}

int main(void) {
  int s = 0;

  /* Duff：五种长度各拷一遍，逐字节比 */
  {
    static const char src[] = "abcdefghijklmnopq";
    char dst[24];
    int lens[5];
    int i;
    lens[0] = 1; lens[1] = 7; lens[2] = 8; lens[3] = 9; lens[4] = 17;
    for (i = 0; i < 5; i++) {
      memset(dst, '.', sizeof(dst));
      dst[lens[i]] = 0;
      duff(dst, src, lens[i]);
      printf("duff %2d [%s]\n", lens[i], dst);
      s += (memcmp(dst, src, lens[i]) == 0);
    }
  }

  /* 那个经典的 `n % 8` 分派：每种余数都要落在对的那一格上 */
  {
    int x;
    for (x = 0; x < 4; x++) printf("if %d %d %d\n", x, in_if(x, 1), in_if(x, 0));
    s += 4;
  }
  {
    int x;
    for (x = 0; x < 3; x++) printf("while %d %d\n", x, in_while(x));
    s += 3;
  }

  /* 最小的那个形状：case 长在 `do` 里，贯穿一路加下来 */
  {
    int n;
    for (n = 0; n < 4; n++) {
      int t = 0;
      switch (n % 4) {
      case 0:
        do {
          t += 1000;
      case 3:
          t += 100;
      case 2:
          t += 10;
      case 1:
          t += 1;
        } while (0);
      }
      printf("small %d %d\n", n, t);
      s += 1;
    }
  }

  printf("s=%d\n", s);
  return s;
}
