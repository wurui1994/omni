// 隐式缩放 `3cm`：asy 那边它就是 `operator *(3, cm)`，这里量的是"跟 * 完全同一条路"
real cm = 2.5;
int  k  = 4;
pair p = (1,2);
triple t = (1,2,3);

write(3cm);      // real
write(3k);       // int 乘 int 还是 int
write(2.5cm);    // 字面量本身可以是 real
write(2p);       // pair 上是复数乘
write(2(1,2));   // 右边是括号表达式
write(2t);       // triple 上是逐分量
write(-3cm);     // 前缀负号在外面
write(3cm*2);    // 缩放比 `*` 紧

real f(real x) { return x + 1; }
write(2f(3));    // 右边是调用

int[] arr = {1,2,3};
write(2arr[1]);  // 右边是下标

// 用户定义的 `operator *` 也就跟着能用（缩放不另立一套解析）
struct A { int v; }
A operator *(int k, A a) { A r = new A; r.v = k * a.v; return r; }
A a = new A; a.v = 7;
write((3a).v);
