// intersections(path, pair, pair)（runpath.in:235）与 cubicroots（runmath.in:333）。
// 两个正文都是照抄 path.cc：cubicroots 是 path.cc:154 的解析解、路径与直线求交是
// path.cc:815 的 lineintersections —— 每一段把三次贝塞尔投到"到直线的有向距离"上，
// 解那个三次多项式的实根，再按**点**去重、升序。
//
// 这一格卡着 `import three;` **跑**不起来：plain_paths.asy:318 的
// `pair inside(path, pen)` 要它，three_surface 的 regularize 一路调下来，
// 模块初始化就会走到。
//
// 这一层没有 cbrt（宿主交集里没有），用 `^` 带符号顶上 —— 末位可能差一两个 ulp，
// 但下面这些点上与 asy 逐字节一样。
void show(real[] t) { for(int i=0; i < t.length; ++i) write(t[i]); write("--"); }

path g1 = (0,0)..(1,2)..(2,-1)..(3,1)--cycle;
path g2 = (1,0)..(0,1)..(-1,0)..(0,-1)..cycle;   // unitcircle 的形状
path g3 = (0,0)--(2,2)--(4,0);

show(intersections(g1, (0,0.5), (3,0.5)));       // 水平线穿三次样条闭路
show(intersections(g1, (-1,-1), (4,4)));         // 斜线
show(intersections(g2, (0,0), (1,0)));           // 过圆心的水平线
show(intersections(g2, (0,0.5), (1,0.5)));       // 割线
show(intersections(g3, (0,1), (5,1)));           // 折线
show(intersections(g3, (0,0), (1,1)));           // 与折线的一条边重合
show(intersections(g2, (0,2), (1,2)));           // 不相交
show(intersections(g1, (1.5,-2), (1.5,3)));      // 竖直线

// cubicroots：一根/三根/重根/退化到二次/系数在数值零那一档
show(cubicroots(1,0,-1,0));
show(cubicroots(1,-6,11,-6));
show(cubicroots(1,0,0,-1));
show(cubicroots(1,0,0,1));
show(cubicroots(0,1,-3,2));
show(cubicroots(1,3,3,1));
show(cubicroots(2,-4,-22,24));
show(cubicroots(1,-2,1,0));
show(cubicroots(1e-18,1,-3,2));
show(cubicroots(1,0,-1e-20,0));
