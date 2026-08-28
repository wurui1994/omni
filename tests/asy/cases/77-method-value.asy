// 把**方法**取出来当值（第四十三刀）。asy 那边它是绑住接收者的闭包 —— 量过：
// 取出来之后改 `a.n`，再调回的是**新值**（9，不是 7），也就是绑的是那个对象，
// 不是取出来那一刻的字段值。我们的方法是"多一个 this 形参的普通函数"，所以这一层
// 现造一个只抓接收者的闭包（`(cfn …)` + `(mkclo …)`，与匿名函数同一副零件）；
// struct 是引用语义，`(mkclo …)` 按值抓的是那个引用，于是"改字段看得见"是自然对上的。
// 这个文件从 bad/fn-value.asy 搬过来 —— 那一条钉的就是这一刀之前的"还没做"。
struct A {
  int n = 5;
  int get() { return n; }
  int add(int k) { return n + k; }
}
A a; a.n = 7;
int f() = a.get;
write(f());
a.n = 9;
write(f());
int g(int) = a.add;
write(g(3));
// struct 体里把自己的方法取出来（plain_bounds.asy:247 的 `addPath=addPathToEmptyArray;`
// 就是这一句）：接收者是隐含的 this，一个函数类型的字段收着它，方法里还能换掉。
struct B {
  int m = 2;
  int step();
  int one() { return m + 1; }
  int two() { return m + 2; }
  step = one;
  void flip() { step = two; }
}
B b; write(b.step());
b.flip(); write(b.step());
