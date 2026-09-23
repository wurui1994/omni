// **数组形参**与**`<math.h>`** —— C 那一族里两格最常见的东西。
//
// 1. **数组形参**（`int sumArr(int xs[], int n)`）：声明符上那个 `[]` 从前**没人看** ——
//    形参当成一格 `int`，体里 `xs[i]` 就报"aget 的实参要是数组"（"声明符上的修饰有没有人
//    看"那一类的第四次）。收成一格**列表**：方言的列表本来就是引用语义，与 C 里"数组退化成
//    指针、改得动调用者那一片"对得上（`scaleArr` 那一行钉的就是这个）。
//    **`int* xs` 不走这条** —— 那个写法在这条腿上专指**出参**（`__ref_int` 那格盒子，见
//    `refparam.cpp`）。两种写法在 C++ 里没法分辨谁是谁，所以这门定死：要数组就写 `[]`。
//
// 2. **`<math.h>`**：公共层有现成的 `(rmath "sqrt" …)`（go 的 `math.Sqrt`、lua 的
//    `math.floor`、V 的 `math.sqrt` 落的是同一格），而那张表的**名字与元数与 C99 逐字相同**
//    —— 所以这一门直接转过去，实参补 `toreal`（方言那一格只收 real）。程序自己定义了同名
//    函数时不抢。`abs` / `labs` 不在那张表里（它们是**整数**上的）：摊成"先存一格临时量、
//    再一格三目"—— 不许把实参写两遍，它可能带副作用。
//
// 顺带钉住三格本来就对的：**聚合初始化**（`P p = {3, 4};`）、**`const P&` 形参**、
// **按值返回一格记录**。
#include <stdio.h>
#include <math.h>

struct P {
  int x;
  int y;
};

int sumArr(int xs[], int n) {
  int s = 0;
  for (int i = 0; i < n; i++) {
    s += xs[i];
  }
  return s;
}

/* 改得动调用者那一片 —— 数组形参是引用语义（与 C 一样）。 */
void scaleArr(double ys[], int n, double k) {
  for (int i = 0; i < n; i++) {
    ys[i] = ys[i] * k;
  }
}

int area(const P& p) {
  return p.x * p.y;
}

P make(int a, int b) {
  P r;
  r.x = a;
  r.y = b;
  return r;
}

int main() {
  int xs[3] = {1, 2, 3};
  printf("%d\n", sumArr(xs, 3));
  double ys[2] = {1.5, 2.0};
  scaleArr(ys, 2, 2.0);
  printf("%.2f %.2f\n", ys[0], ys[1]);
  P p = {3, 4};
  printf("%d\n", area(p));
  P q = make(5, 6);
  printf("%d %d\n", q.x, q.y);
  printf("%.3f %.3f %d\n", sqrt(2.0), fabs(-1.5), abs(-7));
  printf("%.3f %.3f %.3f\n", pow(2.0, 10.0), floor(2.7), hypot(3.0, 4.0));
  printf("%.4f %d\n", atan2(1.0, 1.0), abs(9));
  return 0;
}
