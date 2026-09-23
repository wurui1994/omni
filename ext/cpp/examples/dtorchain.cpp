// 继承时的析构：**派生类自己那一份先跑，再一层层往基类走**（C++ 的次序）。
//
// 从前一个类只记一份 `dtor`，而且**不串链** —— `Mid m;` 出作用域只跑 `~Mid()`，
// `~Base()` 那一段安静地没跑。这一格把链补上：`C.scoped` 记的是**整条链**，
// 出口处照链的次序各调一次（公共层那格 `{ kind: 'scope' }` 负责"每个出口都补一遍"）。
//
// 钉住四件事：单层继承的两段、两层继承的三段、**中间那层没有析构**时跳过它、
// 以及同一个作用域里两格对象按**逆序**销毁（C++ 的规矩）。
#include <stdio.h>

struct Base {
  int id;
  ~Base() {
    printf("~Base %d\n", id);
  }
};

struct Mid : Base {
  ~Mid() {
    printf("~Mid %d\n", id);
  }
};

// 中间这层**没有**析构函数 —— 链上要跳过它
struct Plain : Base {
  int extra;
};

struct Leaf : Mid {
  ~Leaf() {
    printf("~Leaf %d\n", id);
  }
};

void one() {
  Mid m;
  m.id = 1;
}

void two() {
  Leaf l;
  l.id = 2;
}

void skip() {
  Plain p;
  p.id = 3;
}

void pair() {
  Mid a;
  a.id = 4;
  Mid b;
  b.id = 5;
}

int main() {
  one();
  two();
  skip();
  pair();
  return 0;
}
