// 第六十刀：形参默认值不再拦住"当函数值用"。asy 的函数类型里带那一格
// （`void(picture pic=<default>, frame f, path g)`），但两个方向的赋值它都收，
// 所以在"接得住谁"上那一格可以忽略；我们照"全部形参"那一份记类型。
// plain_markers.asy:62 的 markuniform 与 plain_arrows.asy:34 的 `real size(pen p)=arrowsize;`
// 都是这一格。

typedef int fn(int a, int b);

// 带默认值的**具名**函数当值用
int add(int a, int b = 10) { return a + b; }
fn f = add;
write(f(1, 2));
// 直接调还是走调用处填默认值那一条（先前就通）
write(add(1));

// 带默认值的**匿名**函数：类型与不带默认值的 typedef 对得上
fn g = new int(int a, int b = 100) { return a * b; };
write(g(3, 4));

// 重载集里带默认值的那一份也能按目标类型挑出来
int pick(string s) { return length(s); }
int pick(int a, int b = 7) { return a - b; }
fn h = pick;
write(h(9, 4));
write(pick("abc"));

// 默认值那一格在**类型**上被忽略：带默认值的类型与不带的互相赋值都通
typedef int gn(int a, int b = 3);
gn k = add;
write(k(5, 6));
fn m = k;
write(m(5, 6));
