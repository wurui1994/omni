// static 的方法体里读**实例字段**：量过 asy 报 "static use of dynamic variable" 并退 1 ——
// 那里没有接收者，这不是我们没做。
struct C {
  int v = 1;
  static int f() { return v; }
}
write(C.f());
