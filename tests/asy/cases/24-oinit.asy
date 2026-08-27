// 文件级的 `T operator init()`（asy 前端第二十二刀）：它换掉 `T t;` 的隐式构造。
// 每条都量过（asy -noV）：
//   - `A a;` 拿到的是那份构造回的对象，而 `A a = new A;` 绕开它（只有字段默认值）；
//   - 构造调用 `A(…)`（struct 体里那份 void operator init）也**不**走它 —— 量过
//     `A(3)` 拿到的是字段默认值，所以那份 operator init 的体里写 `new A` 不会递归；
//   - **顺序解析**：写在 `A a;` 后面的那份不算；两份都写就是各管后面那一段；
//   - **内嵌记录字段也走它**，但按**那个 struct 声明处**的可见性定：写在 oi 前面的
//     struct 里那格是字段默认值，写在后面的才是 oi 的结果；
//   - 每次都是**新对象**（引用语义没变，改一个不动另一个）。
struct A {
  int x;
  real w = 0.5;
  void operator init(int n) { x = n * 100; }
  int get() { return x + 1; }
}

// 这个 struct 在 oi 之前，所以它那格用的是字段默认值
struct Early { A a; int tag = 1; }

A operator init() { A r = new A; r.x = 7; return r; }

// 这个在 oi 之后，那格走 oi
struct Late { A a; int tag = 2; }

A a;
write(a.x); write(a.w); write(a.get());
A raw = new A;
write(raw.x); write(raw.w);
A made = A(3);
write(made.x); write(made.w);

Early e;
write(e.a.x); write(e.tag);
Late l;
write(l.a.x); write(l.tag);

// 每次都是新对象
A p; A q;
p.x = 555;
write(p.x); write(q.x);

// 函数里声明的也走它（函数体的名字按函数的位置解析，oi 在前面）
int viaFn() { A t; return t.x * 2; }
write(viaFn());

// 形参与返回值不受影响：搬的还是句柄
A same(A z) { z.x = 42; return z; }
A r2;
A r3 = same(r2);
write(r2.x); write(r3.x);

// 数组元素**不**走 oi：asy 那边 `new A[2]` 的格子是未初始化的（读就报错），
// 我们填空引用；这里只看长度与 push 进去的那个，不读没写过的格子。
A[] xs;
xs.push(a);
xs.push(A(2));
write(xs.length); write(xs[0].x); write(xs[1].x);

// 第二份 oi：从这里往后 `A a;` 换成它
A operator init() { A r = new A; r.x = 9; return r; }
A after;
write(after.x);
struct Later { A a; }
Later lt;
write(lt.a.x);
