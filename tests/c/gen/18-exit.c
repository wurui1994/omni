/* 第六刀第十七片：`exit` —— 从任意深处一路退出去。
 * arm64 上凡是用 printf 的用例都必须先有它的声明，否则 tcc 自己会编错（变参 ABI）；
 * 第八刀第三片起那个声明从头文件来。 */
#include <stdio.h>
#include <stdlib.h>

static int trace = 0;

/* exit 之后的语句一句都不该跑到 —— 这里故意放一句 printf 当哨兵。 */
static int leave(int code) {
  printf("leave %d trace=%d\n", code, trace);
  exit(code);
  printf("BUG: exit returned\n");
  return 0;
}

/* 循环里套 switch，switch 里 return 一个「不回来」的调用 —— 结构化控制流那条纪律下
 * 这是最容易出错的形状：BLOCK/LOOP 的层数还欠着，栈却已经不打算退回去了。 */
static int depth(int n) {
  int i;
  for (i = 0; i < 10; i++) {
    trace = (trace * 10 + n) % 100000;
    switch (n) {
      case 0:
        return leave(300);
      default:
        break;
    }
    if (i == 2) return depth(n - 1) + 1;
  }
  return -1;
}

int main(void) {
  int i;
  char buf[8];
  printf("start\n");
  for (i = 0; i < 3; i++) printf("i=%d\n", i);
  buf[0] = 'z';
  buf[1] = 0;
  printf("buf=%s\n", buf);
  printf("depth=%d\n", depth(3));
  printf("BUG: reached the end\n");
  return 5;
}
