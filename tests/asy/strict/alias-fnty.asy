// alias 在 asy 那边不是一个泛型函数，而是 builtin.cc 给**每个记录类型**（:673）与
// 每个数组类型（:604-614）现生的一条 `bool(T,T)`。函数类型上没有这一条 ——
// 量过 asy 报 "no matching function 'alias(int(int), int(int))'"（4.12）。
// 这条守的是"补了 alias 之后没顺手把它做成对一切类型都通的东西"。
int f(int x) { return x; }
typedef int fn(int);
fn g = f;
write(alias(g, g));
