// 类模板：**一组实参一格记录**（单态化，与函数模板同一条路）。
//
// `Box<int>` 落成一格叫 `Box__int` 的普通记录，方法跟着叫 `Box__int_get` ——
// 于是字段读写、方法分派、发体一格都不用另写。用点（`Box<int> b;`）第一次要到才造。
//
// 钉住五件事：两组实参各一份（int 与 double 互不影响）、方法的形参/返回值是 `T`、
// 类模板里用函数模板、**同一格实例只造一遍**（两个变量共用 `Box__int`）、
// 以及类模板的记录当**返回值**交出去。
#include <stdio.h>

template <class T>
struct Box {
  T v;
  void set(T x) {
    v = x;
  }
  T get() {
    return v;
  }
  T twice() {
    return get() + get();
  }
};

Box<int> mk(int a) {
  Box<int> b;
  b.set(a);
  return b;
}

int main() {
  Box<int> bi;
  bi.set(7);
  printf("%d\n", bi.get());
  printf("%d\n", bi.twice());
  Box<double> bd;
  bd.set(1.5);
  printf("%g\n", bd.get());
  printf("%g\n", bd.twice());
  Box<int> b2;
  b2.set(4);
  printf("%d\n", b2.get());
  printf("%d\n", bi.get());
  Box<int> b3 = mk(9);
  printf("%d\n", b3.twice());
  return 0;
}
