// 套一层（以上）的闭包。三件事一起：
//  - 里层匿名函数抓外层匿名函数的形参/局部量：抓不到的名字顺着 cap.prev 往上问一层，
//    外层于是也跟着抓一格（plain.asy:101 的 restoreThunk、:173 的 Iter_int）。
//  - 闭包体里的局部量被里层闭包**改**：那一格照样装箱，箱子整个往下传，
//    穿两层之后还是同一格（不然就变回按值了）。
//  - 函数体里的**具名**函数在闭包里也能抓外层的局部量（plain_markers.asy 那一形）。
using fn = int(int);
using maker = fn(int);
maker mk = new fn(int a) {
  return new int(int b) { return a * 100 + b; };
};
write(mk(7)(3));
write(mk(2)(9));

using maker2 = maker(int);
maker2 o = new maker(int x) {
  return new fn(int y) {
    return new int(int z) { return x * 100 + y * 10 + z; };
  };
};
write(o(1)(2)(3));

int twice(int v) { return 2v; }
maker m2 = new fn(int a) {
  return new int(int b) { return twice(a) + b; };
};
write(m2(5)(1));

using thunk = void();
using getter = int();
struct Box { thunk adv; getter get; }
using boxmaker = Box();
boxmaker bm = new Box() {
  int index = 100;
  Box r;
  r.adv = new void() { index += 5; };
  r.get = new int() { return index; };
  return r;
};
Box c = bm();
write(c.get());
c.adv();
c.adv();
write(c.get());

// 具名函数在闭包里抓外层的局部量
using strmaker = string();
strmaker sm = new string() {
  string tag = "ab";
  string wrap(string s) { return tag + s + tag; }
  return wrap("-");
};
write(sm());
