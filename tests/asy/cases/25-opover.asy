// 算符重载（asy 前端第二十三刀）。每条都量过（asy -noV）：
//   - `V operator +(V,V)` 之后 `a + b` 走它；`-`（一元与二元同名也分得开）、`*`、`/`、
//     `==`、`<` 一样；
//   - 复合赋值就是 `x = x op y`：只定义了 `+` 时 `a += b` 也通（变量、字段、数组元素都是）；
//   - 混合类型（`V * int`）照旧按签名挑；
//   - `!=` **不会**借用 `==` —— 只定义 `==` 时 `a != b` 还是内建的身份比较（引用语义）；
//   - `--` 在语法上是 join 那一档（不是 binary），自己定义 `operator --` 也认；
//   - 算符跟普通函数在同一张候选表里，所以重载、默认实参、顺序解析一条不差。
struct V {
  int x;
  void operator init(int x) { this.x = x; }
  int get() { return x; }
}

V operator +(V a, V b) { return V(a.x + b.x); }
V operator -(V a, V b) { return V(a.x - b.x); }
V operator -(V a) { return V(-a.x); }
V operator *(V a, int k) { return V(a.x * k); }
V operator *(int k, V a) { return V(a.x * k + 1); }
real operator /(V a, V b) { return a.x / b.x; }
bool operator ==(V a, V b) { return a.x == b.x; }
bool operator <(V a, V b) { return a.x < b.x; }
int operator --(V a, V b) { return a.x * 10 + b.x; }
V operator ^^(V a, V b) { return V(a.x * 100 + b.x); }

V a = V(2), b = V(5);
write((a + b).x);
write((b - a).x);
write((-b).x);
write((a * 3).x);
write((3 * a).x);
write(b / a);
write(a == V(2));
write(a == b);
write(a != V(2));
write(a < b);
write(b < a);
write(a -- b);
write((a ^^ b).x);

// 链式与嵌套：出来还是 V，接着点方法也行
write((a + b + V(1)).x);
write((a + b).get());
write((-(a + b)).x);

// 复合赋值：变量、字段、数组元素
V c = V(1);
c += V(10);
write(c.x);
c -= V(4);
write(c.x);

struct Box { V v; }
Box bx;
bx.v = V(3);
bx.v += V(30);
write(bx.v.x);

V[] vs;
vs.push(V(7));
vs[0] += V(70);
write(vs[0].x);

// 重载与顺序解析：算符也在同一张候选表里
V k1 = V(4);
write((k1 * 2).x);
write((2 * k1).x);

// 当实参、当返回值
int sum(V p) { return p.x; }
write(sum(a + b));
V twice(V p) { return p + p; }
write(twice(b).x);

// 默认实参在算符上也管用（它就是个函数）
V operator /(V p, int k = 2) { return V(p.x # k); }
write((V(9) / 3).x);

// `--` 上要**转换**的那一档：内建的 `--` 不存在（那是 guide 的），所以这一档只有用户那份，
// 实参得转换也照走它（int -> real 各一分）。
int operator --(real p, real q) { return (int) (p * 10 + q); }
write(1 -- 2);
