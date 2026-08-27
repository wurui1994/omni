// 记录名在声明**之前**用：asy 自己也拒 —— 量过 `asy -noV` 报 "no type of name 'A'"。
// asy 的名字解析是顺序的，类型名也不例外（函数候选那一半见 strict/forward-ref）。
// 我们两遍降级天然会看见后面的声明，所以 type() 里要按声明下标裁一刀；不裁就是
// "比 asy 多接受一门语言"。这一条**不带** ASY_NOPE：不是还没做，是程序本来就不对。
A a;
write(a.x);
struct A { int x = 3; }
