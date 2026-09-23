// **`T&`（按引用传标量）**：出参那个形状 —— 真实 C/C++ 里最常见的一格。
//
// 从前这一格**答案静默地错**：声明符上那个 `&` 被无声地丢掉，`bump(y, 3)` 改的是副本，
// `y` 还是 5（而 `c++` 给 8）。两把尺子都不问这件事，所以它一直红着没人知道。
//
// 落法是**把借出去的量装进一格盒子**（`__ref_int` —— 只有一格字段 `v` 的记录，记录本来
// 就是引用语义）。三处配合：①引用形参的类型换成盒子，体里读写那个名字都走 `.v`；
// ②降体**之前**先扫一趟树（`borrowedLocals`），看哪几格局部量被借出去了 —— 它们的
// 声明要发成盒子；③调用点在那个位置上交**盒子本身**，不是盒子里的值。
// 图上一格新东西也没加：落的全是现成的记录、字段读写与调用。
//
// 钉住七件事：改得动调用者那一格、**引用形参再借给别人**（`twice` 里的 `bump(x, x)`）、
// 两格引用一起（`swap2`）、`double&`、同一格量既按引用借出去又照常当值用、
// 按指针收的出参（`int*` + `*p` + `&y`），以及**方法上的出参**（`acc.take(got)`）。
#include <stdio.h>

void bump(int& x, int d) {
  x = x + d;
}

void twice(int& x) {
  bump(x, x);
}

void swap2(int& a, int& b) {
  int t = a;
  a = b;
  b = t;
}

void scale(double& r, double k) {
  r = r * k;
}

/* **按指针收的出参**（`int*` + `*p` + 调用点 `&y`）落成同一台机器 —— 那是 C 那半边
   的写法，真实代码里与 `T&` 一样常见。指针只接这一种用法，别的当场报。 */
void addTo(int* p, int d) {
  *p = *p + d;
}

/* **方法上的出参**（没重载、非虚那一档）：与自由函数同一台机器，只是形参表第一格是
   接收者，所以实参的下标要减一。 */
struct Acc {
  int n;
  void take(int& out) {
    out = n;
    n = 0;
  }
  /* **方法体里裸写**的那一格（`take(z)` = `this->take(z)`）：名字要先按 `this` 的类挑
     出来才看得见出参那张表，不然只有调用点没换、体里换了，方言当场报"形参是 __ref_int"。 */
  int pull() {
    int z = 0;
    take(z);
    return z;
  }
};

/* **构造上的出参**（`Grab(int& out)`）：与方法那一格同一台机器，只认"这个类只有一份
   构造"那一档 —— 名字定得死，调用点才能在**求值之前**知道哪几格要交盒子。两种写法都接：
   声明形（`Grab gr(g);`，实参在声明符的 `(ctor …)` 里）与函数式（`Grab(g)`，一格普通调用）。 */
struct Grab {
  int v;
  Grab(int& out) {
    out = out + 100;
    v = out;
  }
};

int main() {
  int y = 5;
  bump(y, 3);
  printf("%d\n", y);
  twice(y);
  printf("%d\n", y);
  printf("%d\n", y + 1);
  int a = 1;
  int b = 2;
  swap2(a, b);
  printf("%d %d\n", a, b);
  double r = 2.0;
  scale(r, 1.5);
  printf("%.2f\n", r);
  int c = 10;
  addTo(&c, 7);
  printf("%d\n", c);
  Acc acc;
  acc.n = 9;
  int got = 0;
  acc.take(got);
  printf("%d %d\n", got, acc.n);
  int g = 1;
  Grab gr(g);
  printf("%d %d\n", g, gr.v);
  Grab gr2 = Grab(g);
  printf("%d %d\n", g, gr2.v);
  acc.n = 4;
  printf("%d %d\n", acc.pull(), acc.n);
  return 0;
}
