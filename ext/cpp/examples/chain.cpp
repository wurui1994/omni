// **方法链（`return *this;`）那三格洞** —— 一趟探针撞出来的，三格都在"声明符上的修饰
// 有没有人看"这一类里（这是第五、六次）：
//
// 1. **返回类型带 `&` 时那格方法整个消失**：`Acc& add(int)` 的 `(fn …)` 不在声明符的
//    第一层，而埋在一层 `ptr` 底下（`&` 也是 ptr 的一种）。收类的那一趟只看第一层，
//    于是这格方法**没被收**，调用点报"`.add()` 这一格方法还没接" —— 病灶在收集那一头，
//    报错的地方却在调用点。现在统一走一格 `fnOf(声明符)`：往 `ptr` / `paren` 底下找。
//
// 2. **`*this`**：从前"这一格表达式还没接"。`*this` 与 `this` 在这条腿上是同一样东西
//    （记录本来就是引用语义，没有"解引用"这道手续），所以 `deref` 碰上 `this` 就交
//    接收者本身。有了它，`a.add(2).add(5).get()` 这种链式写法整条通。
//
// 3. **`void bump(Acc& a)`**：记录上的 `&` 从前没人看，于是与"按值收"走同一条路 ——
//    进门第一句拷一份，函数改的是副本、调用者那格记录**一点没变**（第十四个"答案静默
//    地错"：不报错、不崩，只是少改了一笔）。记录是引用语义，这一格要做的只有"别拷"。
//
// 钉住六件事：两次链式调用（中间那格返回值接着当接收者）、链式里混两个不同的方法、
// 把 `*this` 接到一格 `Acc&` 变量上（它与原对象是同一份）、`Acc&` 形参改得动调用者
// 那格、多实参的链式（`Pt&`）、以及一格 `const Acc&` 形参只读着用。
#include <stdio.h>

struct Acc {
  int n;
  Acc& add(int x) { n = n + x; return *this; }
  Acc& scale(int k) { n = n * k; return *this; }
  Acc& self() { return *this; }
  int get() { return n; }
};

struct Pt {
  int x;
  int y;
  Pt& shift(int dx, int dy) { x = x + dx; y = y + dy; return *this; }
};

void bump(Acc& a) { a.add(100); }

int sum(const Acc& a, const Pt& p) { return a.n + p.x + p.y; }

int main() {
  Acc a;
  a.n = 0;
  printf("%d\n", a.add(2).add(5).get());
  printf("%d\n", a.scale(3).add(1).get());
  Acc& r = a.self();
  r.add(1000);
  printf("%d\n", a.get());
  bump(a);
  printf("%d\n", a.n);
  Pt p;
  p.x = 1;
  p.y = 2;
  p.shift(10, 20).shift(100, 200);
  printf("%d %d\n", p.x, p.y);
  printf("%d\n", sum(a, p));
  return 0;
}
