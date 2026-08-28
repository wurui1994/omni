// 四个小口子，都是量着真 asy 补的：
//  - 维度挂在**名字**后面：`real x[]` 就是 `real[] x`，形参、字段、`... T inset[]` 三处。
//  - 六分量字面量 `(x,y,xx,xy,yx,yy)` 是一个 transform（camp.y 那条产生式）。
//  - transform 的 `==` 是**逐分量**比（runtime.in 的 transformEquals）。
//  - `real identity(real)` 是内建函数（builtin.cc:767/848），跟 transform identity() 同名。
//  - 嵌套 struct 的方法体里认得**自己**的名字（plain_picture.asy:236 的 bounds3）。
void f(real x[]) { write(x.length); }
real[] a = {1,2,3};
f(a);
void g(real x[][]) { write(x.length); }
real[][] m = {{1,2},{3,4}};
g(m);
void h(pair align=(0,0) ... real inset[]) { write(inset.length); }
h((1,1), 1, 2, 3);

struct S { real x[]; }
S s;
s.x = new real[] {4,5};
write(s.x.length);

transform t = (1,2,3,4,5,6);
write(t);
write((0,0,0,0,0,0));
write((0,0,1,0,0,1) == identity());
write((1,0,1,0,0,1) != identity());

real twice(real x) { return 2x; }
real apply(real fn(real), real v) { return fn(v); }
write(apply(identity, 7));
write(apply(twice, 7));

struct Outer {
  struct Inner {
    int v = 3;
    Inner copy() {
      Inner b = new Inner;
      b.v = v;
      return b;
    }
  }
  Inner in;
  int twice() { Inner q = in.copy(); return q.v * 2; }
}
Outer o;
o.in.v = 9;
write(o.twice());
write(o.in.copy().v);
