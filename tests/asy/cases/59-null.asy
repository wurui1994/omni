struct A {
  int x;
  void operator init(int x) { this.x = x; }
}

// 类型来自左边的声明
A a = null;
write(a == null);
write(a != null);
a = A(3);
write(a == null);
write(a != null);
write(a.x);

// 函数值：collections/map.asy:11 的 `restricted bool isNullValue(V) = null;` 就是这个形状
typedef bool P(int);
P p = null;
write(p == null);
bool even(int n) { return n % 2 == 0; }
p = even;
write(p == null);
write(p != null);
write(p(4));

// 比较的另一边给类型，左右都试
write(null == a);
write(null != p);

// 数组也是引用，`int[] r = null;` asy 收（math.asy:160 的 `int[] edge = … : null;`）。
// 但**不能拿它跟 null 比** —— asy 的 `operator ==(int[],int[])` 是逐元素的，
// 量过 `r == null` 报运行期错误 "dereference of null array"。所以这里只声明，不比较。
int[] r = null;
r = new int[3];
write(r.length);

// struct 的字段与形参
struct B { A inner; P q; }
B b = new B;
write(b.inner == null);
write(b.q == null);
b.inner = a;
write(b.inner == null);
b.inner = null;
write(b.inner == null);

bool isnil(A v) { return v == null; }
write(isnil(null));
write(isnil(a));

A pick(bool yes, A v) { if (yes) return v; return null; }
write(pick(true, a) == null);
write(pick(false, a) == null);
