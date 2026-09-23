// **类模板 + 构造函数 / 析构函数**：`Holder<int> a(5);` 与 `Holder<double> b(1.5);`
// 各单态出一格记录，构造与析构也各发一份。
//
// 从前这两格当场报（`C.instClass` 里那两句）。落法与非模板那条路是**同一条**：
// 构造函数是一格交记录的普通函数（`Holder__int__ctor1`）、析构挂在作用域出口上
// （公共层那格 `{ kind: 'scope' }`）。单态化那半本来就把类型形参摆进 `C.aliases`
// 再读一遍树，所以这一刀只是把"发签名 + 发体"那两趟补齐，没有新机制。
//
// 钉住四件事：成员初始化表在两种实参类型上各跑一次、方法照旧、两格实例的析构**互不相干**，
// 以及析构的次序（量之间逆序 —— `b` 先走）。
#include <stdio.h>

template <class T>
struct Holder {
  T v;
  int n;
  Holder(T start) : v(start), n(1) {
  }
  ~Holder() {
    printf("~Holder %d\n", n);
  }
  T get() {
    return v;
  }
  void bump(T d) {
    v = v + d;
    n = n + 1;
  }
};

int main() {
  Holder<int> a(5);
  a.bump(3);
  printf("%d\n", a.get());
  printf("%d\n", a.n);
  Holder<double> b(1.5);
  printf("%.2f\n", b.get());
  return 0;
}
