// 函数值的**模块级**变量（第三十七刀）：函数体里也看得见的那种。
//
// 在这一刀之前，`asyGlobalNames` 那一遍只按节点形状认标量与聚合，两种函数值写法
// （`real f(real) = …` 的 fundecidstart、`typedef` 别名）都落成 ok:false，于是它退化成
// 入口里的一个 `(let …)` —— 文件级直着用没事，函数体里一读就报"函数里改文件级变量"。
//
// 量出来的理由：`graph.asy` 里 `ticklabel`、`axis` 这一族全是这个形状。
//
// 顺序那一条要注意（量过 graph.asy:267 的 `ticklabel LogFormat=LogFormat(10);`）：
// 正在声明的那个变量在**自己的初值**里还不可见 —— 右边那个名字是**函数**。
// 下面 `pick` 那一段就是这个形状。

typedef int F(int);

int thrice(int x) {return x * 3;}
int quad(int x) {return x * 4;}

// typedef 别名那种写法
F h;
void set1() { h = thrice; }
int use1() { return h(5); }
write(h == null);
set1();
write(h == null);
write(use1());
write(h(2));

// 形参表跟在名字后面那种写法
int g(int) = quad;
int use2() { return g(5); }
write(use2());
void set2() { g = thrice; }
set2();
write(use2());

// 声明自己的初值里那个名字是**函数**，不是这个变量
F pick(int k) { return k == 0 ? thrice : quad; }
F pick = pick(0);
write(pick(5));

// 函数里换掉它，另一个函数里看得见（就是"模块级"这三个字的意思）
void set3() { pick = quad; }
int use3() { return pick(5); }
set3();
write(use3());
