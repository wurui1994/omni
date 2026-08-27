// asy 自己就不收：write 没有收结构体的重载 —— 量过 asy 报
// "no matching function 'write(A)'"（7.6）。这条守的是诊断出自 asy 这一层，
// 不是漏出核心方言那句 `(tostr E) 只接受 int / real / bool`。
struct A { int x; }
A a;
a.x = 3;
write(a);
