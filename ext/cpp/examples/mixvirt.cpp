// 虚函数 **+ 多继承**：一个类从两个基类各继承一族虚方法。
//
// 从前这一格当场报（`planVirtuals` 里那句"虚函数 + 多继承还没接"）。拦路的不是"新节点"，
// 是**分组**：从前按 `bases[0]` 往上走找一格"根"，多继承时根不止一个。现在改成按
// **连通块**分 —— `Box : Shape, Printable` 把 `Shape` 那棵与 `Printable` 那棵连成一块，
// 整块合成一格记录（字段并集 + 一格 `__vt`），于是"通过第二基类的指针调"也只是同一格
// 记录上的另一种静态类型。
//
// 钉住四件事：通过**第一**基类的指针调、通过**第二**基类的指针调（这才是多继承真正的坑）、
// 一个基类是纯虚接口而另一个有体（两族虚方法的兜底各不相同），以及基类的非虚方法里
// 调虚方法（`twice()` 在基类自己的对象与派生类的对象上各走一支）。
#include <stdio.h>

struct Printable {
  virtual int ink() = 0;
};

struct Shape {
  int w;
  virtual int area() {
    return w;
  }
  int twice() {
    return area() * 2;
  }
};

struct Box : Shape, Printable {
  int h;
  int area() {
    return w * h;
  }
  int ink() {
    return w + h;
  }
};

struct Dot : Printable {
  int n;
  int ink() {
    return n * 10;
  }
};

int byShape(Shape *s) {
  return s->area();
}

int byPrint(Printable *p) {
  return p->ink();
}

int main() {
  Shape s;
  s.w = 5;
  Box b;
  b.w = 3;
  b.h = 4;
  Dot d;
  d.n = 7;
  printf("%d\n", byShape(&s));
  printf("%d\n", byShape(&b));
  printf("%d\n", byPrint(&b));
  printf("%d\n", byPrint(&d));
  printf("%d\n", b.twice());
  printf("%d\n", s.twice());
  return 0;
}
