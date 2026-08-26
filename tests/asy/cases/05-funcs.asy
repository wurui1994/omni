// 函数。这一刀不做重载，所以每个名字只有一个签名；类型是符号表的事，
// 而这一层还没有符号表 —— 于是形参与返回类型都是**写出来**的那份。
int fact(int n) {
  if (n <= 1) return 1;
  return n * fact(n - 1);
}
write(fact(0), fact(1), fact(6));

int fib(int n) {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}
write(fib(10));

// void：没有 return 也要能落地
void greet(string who) {
  write("hi ", who);
}
greet("omni");
greet("asy");

// 提前 return
string sign(int x) {
  if (x > 0) return "+";
  if (x < 0) return "-";
  return "0";
}
write(sign(3), sign(-3), sign(0));

// 互递归写不出来：asy 里 `bool odd(int n);` 是**声明一个函数类型的变量**并初始化成 null，
// 真 asy 跑到就是 "dereference of null function"（量过）。所以这里不放互递归。

// 多参数 + 表达式实参
int clamp(int x, int lo, int hi) {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}
write(clamp(5, 0, 3), clamp(-1, 0, 3), clamp(2, 0, 3));

// 局部变量遮住全局同名量
int v = 100;
int shadow(int v) {
  return v * 2;
}
write(shadow(7), v);

// 参数在函数里被改：asy 传值
int bump(int x) {
  x += 1;
  return x;
}
int w = 1;
write(bump(w), w);
