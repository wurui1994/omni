// 一批：默认值那一段里的闭包能抓被调方的形参 / `this.f = f` 也算"这个名字被赋过值"
// / 数组那一格的 dot

// 1) 默认值里的匿名函数抓同一张形参表里的前一格（ode.asy:25 的形状）
real[] mk(real[][] w, real[] steps=sequence(new real(int i){return sum(w[i]);}, w.length))
{
  return steps;
}

real[][] w = {{1,2},{3,4,5},{6}};
write(mk(w));
write(mk(w, new real[] {9,8,7}));

// 2) struct 的 operator init 那一路：默认值在被调方的作用域里求，体里改的是字段
struct S {
  real[][] weights;
  real[] steps;
  void operator init(real[][] weights,
                     real[] steps=sequence(new real(int i){return sum(weights[i]);},
                                           weights.length)) {
    this.weights = weights;
    this.steps = steps;
  }
}

S s = S(w);
write(s.steps);
write(s.weights[1][2]);

// 3) 带体的方法在 `this.f = f` 之后就是函数类型的**字段**（ode.asy:34 的形状）
struct T {
  real f(real x) { return x + 1; }
  void operator init(real f(real)) {
    this.f = f;
  }
}

T t = T(new real(real x) { return x * 10; });
write(t.f(3));
real g(real) = t.f;
write(g(4));

// 4) 数组那一格的 dot（runarray.in 的 `real dot(real[], real[])`）
write(dot(new real[] {1,2}, new real[] {3,4}));
write(dot(w[1], new real[] {1,1,1}));
