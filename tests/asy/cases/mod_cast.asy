// 第二十七刀：`import` 把模块里的 `operator cast` 一起带进来（量过 asy 也这样）。
struct C {
  int n;
}

C operator cast(int x) {
  C c = new C;
  c.n = x + 7;
  return c;
}

int useC(C c) {
  return c.n;
}
