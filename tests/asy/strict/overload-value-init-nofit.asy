// 有多个重载的名字当**变量的初值**，而没有一份与左边的类型同型：asy 也拒 —— 量过
// `asy -noV` 报 "cannot cast expression to 'string(string, string)'"（10.27）。
//
// 与 overload-value-nofit 是一对：那条是**实参**位置（fit 那一段），这条是**声明**位置
// （第三十五刀新铺的 coerce 那一段）。两条都只认同型的一份，不给任何转换余量 ——
// 给了余量就是比 asy 多接受一门语言。不带 ASY_NOPE：不是还没做，是程序本来就不对。
int both(int a, int b) {return a + b;}
real both(real a, real b) {return a * b;}
int ok(int,int) = both;
write(ok(2,5));
string s(string,string) = both;
