// static 的方法体里调**实例方法**：量过 asy 报 "static use of dynamic variable" 并退 1。
// 这一条钉的还有**理由的顺序**：实例方法明明写在前面，所以不能报成"声明在后面"。
struct C {
  int v = 1;
  int inst() { return v; }
  static int f() { return inst(); }
}
write(C.f());
