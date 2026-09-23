// **类模板 + 构造函数 / 析构函数**：`Holder<int> a(5);` 与 `Holder<double> b(1.5);`
// 各单态出一格记录，构造与析构也各发一份。
//
// 从前这两格当场报（`C.instClass` 里那两句）。落法与非模板那条路是**同一条**：
// 构造函数是一格交记录的普通函数（`Holder__int__ctor1`）、析构挂在作用域出口上
// （公共层那格 `{ kind: 'scope' }`）。单态化那半本来就把类型形参摆进 `C.aliases`
// 再读一遍树，所以这一刀只是把"发签名 + 发体"那两趟补齐，没有新机制。
//
// 钉住六件事：成员初始化表在两种实参类型上各跑一次、方法照旧、两格实例的析构**互不相干**、
// 析构的次序（量之间逆序）、**类模板 + 继承**（基类的字段与方法都摊进来：`c.id` 与
// `c.tag()`），以及**析构串成链**（`~Cell` 完了再跑 `~Tag`）。
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

/* **类模板 + 继承**：基类得是已经登记过的普通类，摊平走的是同一份 `flatten`
   （字段接在前面、方法按名字继承、**析构串成链**）。基类那侧有虚函数当场报 ——
   虚那条路是"整块合成一格记录"，而实例是第二、三遍中间现造的，那一趟早过去了。 */
struct Tag {
  int id;
  int tag() {
    return id * 100;
  }
  ~Tag() {
    printf("~Tag %d\n", id);
  }
};

template <class T>
struct Cell : Tag {
  T v;
  Cell(T x) : v(x) {
  }
  T get() {
    return v;
  }
  int both() {
    return tag() + id;
  }
  ~Cell() {
    printf("~Cell\n");
  }
};

int main() {
  Holder<int> a(5);
  a.bump(3);
  printf("%d\n", a.get());
  printf("%d\n", a.n);
  Holder<double> b(1.5);
  printf("%.2f\n", b.get());
  Cell<int> c(7);
  c.id = 2;
  printf("%d %d %d\n", c.get(), c.tag(), c.both());
  return 0;
}
