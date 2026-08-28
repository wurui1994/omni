// struct 名字当值用就是那一族**构造函数**，所以没写 `operator init` 的 struct 拿不出值来。
// 量过 asy 报 "no matching variable of name 'Q'"（3.13）并退 1。
struct Q { int a = 7; }
Q makeQ() = Q;
write(makeQ().a);
