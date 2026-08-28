// 第五十六刀：剩下那一批 C++ 内建（colors/quotient/stripextension/prepend/straight/
// history/saveline），加上 alias —— 后者在 asy 那边不是一个函数，而是 builtin.cc 给
// 每个记录类型（:673）与每个数组类型（:604-614）现生的一条 `bool(T,T)`。

// runtime.in:413 colors(pen)：按颜色空间给 1/3/4 道，invisible 是 0 道
write(colors(gray(0.25)));
write(colors(rgb(0.1,0.2,0.3)));
write(colors(cmyk(0.1,0.2,0.3,0.4)));
write(colors(invisible()).length);

// runmath.in:191 → mathop.h:260 quotient：整除**往下**取整
write(quotient(7,2));
write(quotient(-7,2));
write(quotient(7,-2));

// runsystem.in:204 → util.cc:265 stripextension：最后一个点起砍掉，没有点就原样
write(stripextension("a/b.c.d"));
write(stripextension("abc"));
write(stripextension("a.b/c"));

// runpicture.in:326 prepend(frame,frame)：src 插到 dest **前面**，盒子是两个的并
frame f; frame g;
_draw(f, (0,0)--(1,1), currentpen);
_draw(g, (5,5)--(6,6), currentpen);
prepend(f, g);
write(min(f));
write(max(f));

// runpath.in:152 → path.h:167 straight(path,int)：`--` 那些段都是直线段；非闭合路径
// **越界回 false**，闭合的走 imod。（"不是直线段"那一格要 `..`，路径连接这一刀还没做，
// 所以这里量不到 —— 差别写在明处。）
path p = (0,0)--(1,0)--(2,1);
write(straight(p,0));
write(straight(p,2));
write(straight(p,7));
path q = (0,0)--(1,0)--(1,1)--cycle;
write(straight(q,3));

// runhistory.in 的 `#else` 那一路：没有 readline 就是空表加空操作
write(history("omni-nosuch").length);
saveline("omni-nosuch", "x", false);

// alias：比身份。量过 `alias(a,null)` 是 false，函数类型上没有 alias
struct A { int x; }
A a; A b = a;
write(alias(a,b));
write(alias(a,new A));
write(alias(a,null));
int[] u; int[] v = u;
write(alias(u,v));
write(alias(u,new int[]));
