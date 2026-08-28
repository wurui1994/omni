// 同名的变量遮住了函数名：是哪一个由**目标类型**定案（asy 的名字按签名查）。
// 原型是 plain_constants.asy:39 的 `restricted transform identity;` —— 那格模块级变量
// 与 `real identity(real)` / `transform identity()` 共存，于是 plain_picture.asy:85 的
// `scaleT(identity, identity)` 要的是两个 `real(real)`，而 `transform t=identity` 要那格变量。
struct TF { real a=1; real b=0; }
typedef real rfn(real);
restricted TF identity;
real identity(real x) { return x; }
TF identity() { TF t; t.a=3; return t; }
real apply(rfn f, real x) { return f(x); }
real twice(rfn f, real x) { return f(x) + f(x); }

// 实参位置：槽要 rfn，挑函数那一份（fit 里的 shadowFns 那一档）
write(apply(identity, 2.5));
write(twice(identity, 4));
// 初值位置：目标类型是 rfn，挑函数（coerce 里那一档）
rfn g = identity;
write(g(1.5));
// 目标类型是 TF：还是那格变量
TF t = identity;
write(t.a);
write(t.b + 6);
// 调用那格函数：`identity()` 与 `identity(x)` 都是函数，不是变量
TF u = identity();
write(u.a);
write(identity(9.0));
// 赋值位置也一样
rfn h;
h = identity;
write(h(2) + 1);
