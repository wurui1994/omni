// 29-modstruct 引的模块（mod_ 开头的不是用例）：struct、带默认实参的函数、一个 int 重载。
struct P { int x; }
int addp(P p, int d = 5) { return p.x + d; }
int f(int a) { return a * 10; }
