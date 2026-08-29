// 同一个文件里**同签名声明好几遍**：asy 那边每一份都是一格新变量，先写的那份在
// "它之后、后一份之前"那一段照样看得见（不是"后一份把先一份覆盖掉"）。
// interpolate1.asy 就是这个形状：七个 `real f(real x)` 挨着，每个 `y=map(f,x);`
// 用的都是它上面最近那一份。
real f(real x) { return x+1; }
real[] a = {1,2};
real[] y = map(f,a);
write(y[0],y[1]);
write(f(0));

real f(real x) { return x+10; }
real[] z = map(f,a);
write(z[0],z[1]);
write(f(0));

// 第三份：链要接得上（前两份都得让位）
real f(real x) { return x+100; }
write(f(0));

// 返回类型不进签名身份：`int s(int)` 之后 `real s(int)` 还是同一格签名，
// 后一份说话（cases/16 也钉着这一条，这里再钉"前面那一段用前一份"）。
int s(int x) { return x; }
write(s(5));
real s(int x) { return 2.5; }
write(s(5));

// 真正的重载（形参不同）不受影响：两份都在
string g(int x) { return "g-int"; }
string g(string x) { return "g-string"; }
write(g(1)); write(g("q"));

// 形参遮住文件级那格**数组**：`sin(x)` 走的是标量那份，不是内建面的 `real[] sin(real[])`
// （interpolate1.asy:75 那一族的形状）。
real[] xs;
real sn(real xs) { return sin(xs); }
write(sn(0.5));
