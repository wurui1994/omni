// 第六十九刀：写在函数体里的 struct、写在方法体/闭包体里的函数，与 `x.operator init(…)`。
// 每一格的期望值都是 `asy -noV` 印出来的。

// 1) struct 写在**函数体**里（plain_Label.asy:591 的 stringfont 就是这个形状）：
//    构造函数与方法的正文都要发出来。
int bodyStruct(int k)
{
  struct box {
    int n;
    void operator init(int k) { n = k * 3; }
    int twice() { return n * 2; }
  }
  box b = box(k);
  return b.twice();
}
write(bodyStruct(4));           // 24

// 2) 方法体里的函数抓接收者：显式 `this.` 与裸字段名两种写法。
struct acc {
  int base = 10;
  int bump(int k) { return base + k; }
  int useBare(int k) {
    int f(int x) { return base + x; }
    return f(k);
  }
  int useThis(int k) {
    int g(int x) { return this.bump(x); }
    return g(k);
  }
}
acc a;
write(a.useBare(5));            // 15
write(a.useThis(7));            // 17

// 3) 闭包体里的函数抓外层的形参（graph.asy:837 的 omit 就是这个形状）。
typedef int clampfn(int);
clampfn mk(int lo, int hi)
{
  return new int(int x) {
    int clamp(int v) { return v < lo ? lo : (v > hi ? hi : v); }
    return clamp(x);
  };
}
clampfn c = mk(2, 6);
write(c(0));                    // 2
write(c(4));                    // 4
write(c(9));                    // 6

// 4) `x.operator init(…)`：对象已经在手，只跑一遍正文（collections/map.asy:110）。
struct cell {
  int v = 1;
  string tag = "-";
  void operator init(int v, string tag = "d") { this.v = v; this.tag = tag; }
}
cell z;
z.operator init(5);
write(z.v);                     // 5
write(z.tag);                   // d
z.operator init(6, "x");
write(z.v);                     // 6
write(z.tag);                   // x

// 5) 算符重载写在**函数体**里（plain_Label.asy:46）。
int opInBody()
{
  int operator *(string s, int k) { return length(s) * k; }
  return "abcd" * 3;
}
write(opInBody());              // 12

// 6) 形参默认值是花括号数组初值（graph.asy:2146 的 `real[] dmx={}`）。
int tot(int[] a = {}, int[] b = {1, 2, 3})
{
  int s = 0;
  for (int x : a) s += x;
  for (int x : b) s += x;
  return s;
}
write(tot());                   // 6
write(tot(new int[] {10}));     // 16

// 7) 元素是**函数类型**的数组（graph 里那一族回调数组）：copy 与 delete 都要现生一份 helper。
typedef void thunk();
thunk[] fs;
int hits = 0;
fs.push(new void() { ++hits; });
fs.push(new void() { hits += 10; });
thunk[] gs = copy(fs);
for (thunk f : gs) f();
write(hits);                    // 11
gs.delete();
write(gs.length);               // 0
write(fs.length);               // 2

// 8) 内建面那两格：`font(pen)` 与 `makepen`/`nib`。
write(font(currentpen) == font(fontsize(9)));   // true
write(font(fontcommand("\\Large")));            // \Large
write(length(nib(currentpen)));                 // -1
write(length(nib(makepen((0,0)--(1,0)--(1,1)--(0,1)--cycle))));  // 4

// 9) `(real) s` 转不动时不报错（asy 那边是一格 Default，只存不读就通）。
real bad = (real) "3.14git";
write("stored");                                // stored
