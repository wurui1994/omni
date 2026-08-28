// 按引用捕获（这一刀）：会被闭包抓走、而且还会被改的那一格**装箱** ——
// 一格长度 1 的数组，读写都穿过去，闭包抓走的是那个数组本身，于是里外是同一格。
// 量过 asy 的答案就在下面这些 write 上（`asy -noV` 原样跑）。

// 改在闭包**之后**：asy 是按引用的，h 看见的是 99+1
int mut(int n) {
  int m = n;
  int h(int) = new int(int x) {return x + m;};
  m = 99;
  return h(1);
}
write(mut(5));

// 闭包**自己**改：函数体里的具名函数也是闭包（localFunClo 那一支）
int counter() {
  int n = 0;
  int bump() { ++n; return n; }
  write(bump()); write(bump()); write(n);
  return n;
}
write(counter());

// 复合赋值也穿过箱子
real acc() {
  real s = 1;
  void add(real x) { s += x; s *= 2; }
  add(2); add(3);
  return s;
}
write(acc());

// 形参也装箱（plain_arrows.asy:245 的形状：闭包抓了形参，函数后面又改它）
int fp(int n) {
  int g() { return n; }
  n = 40;
  return g() + 2;
}
write(fp(1));

int hp(int n) {
  void bump() { n += 10; }
  bump(); bump();
  return n;
}
write(hp(5));

// collections/iter.asy 的形状：unravel 出来的字段装三个闭包，共用一格 index
struct It { int get(); void adv(); bool ok(); }
It iter(int[] items) {
  int index = 0;
  It r;
  unravel r;
  adv = new void() { ++index; };
  get = new int() { return items[index]; };
  ok = new bool() { return index < items.length; };
  return r;
}
int[] xs = {3, 1, 4};
It i = iter(xs);
while (i.ok()) { write(i.get()); i.adv(); }
