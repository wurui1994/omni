// asy 自己就不收：asy 的名字解析是顺序的，a 的体里还看不见后面才声明的 b ——
// 量过 asy 报 "no matching variable 'b'"（1.23）。我们两遍降级，所以这条边界要专门守。
int a(int n) { return b(n) + 1; }
int b(int n) { return n * 2; }
write(a(3));
