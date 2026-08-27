// asy 自己就不收：`null` 没有类型，标量上没有空引用这回事 —— 量过 asy 报
// "cannot cast 'null' to 'int'"（5.9）。这条守的是诊断出自 asy 这一层。
int f(int n) { return n; }
write(f(1));
int x = null;
write(x);
