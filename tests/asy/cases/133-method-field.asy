// 第六十二刀：方法就是一格函数值字段、operator init 当方法值、`var` 也能被 typedef 掉。
//
// 四条都是量出来的（`asy -noV`）：
//   - 有体的方法可以整个换掉（`b.deffill = new int(int){…}`），换的是**那个实例**那一格；
//   - `((F)m.operator init)()` 调的是**绑在 m 上**的那份 void 方法 —— 改的是 m 自己，
//     不是造一个新对象（plain 那条路上是 collections/map.asy:102）；
//   - `typedef int var;` 之后 `var` 就是个普通类型名，`var[] v = {…}` 与 `var x;` 都通
//     （按"类型推断"讲后者连 asy 自己都拒 —— simplex2.asy:16 靠这一条）；
//   - 花括号初值也能当**字段的默认值**。

struct AH {
  int size = 7;
  int deffill(int p) { return p + 1; }
}

AH a;
AH b;
b.deffill = new int(int p) { return p * 10; };
write(a.deffill(3));
write(b.deffill(3));
write(a.size);

struct M {
  int x;
  void operator init() { x = 3; }
  void operator init(int v) { x = v; }
}

// `operator init` 当函数值：类型是 `void(…)`，不是 `M(…)`
using F = void();
M m;
F f = m.operator init;
f();
write(m.x);

// 强制转换那一格：括号里那个类型就是定案的依据
M m2;
((F) m2.operator init)();
write(m2.x);

// 方法体里的 `using` 是体内一句语句 —— 紧接着那一句就该认得它
struct N {
  M inner;
  int y;
  void bump() {
    using G = void(int);
    ((G) inner.operator init)(9);
    y = inner.x;
  }
}
N n;
n.bump();
write(n.y);

// `var` 被 typedef 掉之后就是个普通类型名
struct P {
  typedef int var;
  static var A = 4;
  static var B = 6;
  var[] v = {A, B};
  var pick;
  int sum() {
    var t = 0;
    for (var i = 0; i < v.length; ++i) t += v[i];
    return t + pick;
  }
}
P p;
p.pick = 100;
write(p.sum());
write(p.v.length);
