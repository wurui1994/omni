// 真几何那几个（第四十七刀）：arclength / arctime / subpath / intersect /
// intersections / transpose。这一层的算法与 asy 的不是同一个（那边是 C++ 的自适应
// Simpson + 细分，这一层是 5 点 Gauss-Legendre + 二分，交点是细分圈出来再 Newton 收），
// 所以这里只钉**算得准的那些位**：直线段的弧长是闭式的、subpath 端点落在结上、
// 两条直线的交点时间是有理数。曲线上那几位末位会差，不往 .expected 里放。

// 1. 直线段的弧长与 arctime
path a = (0,0)--(3,4);
write(arclength(a));
write(arctime(a, 2.5));

// 2. 折线：三段等长，arctime 落在段界上
path b = (0,0)--(1,0)--(1,1)--(0,1);
write(arclength(b));
write(arctime(b, 2.0));

// 3. subpath(path,int,int)：结点照搬，端点的控制点收回结上
path c = subpath(b, 1, 3);
write(length(c));
write(point(c, 0));
write(point(c, 2));

// 4. subpath(path,real,real)：直线段上是线性的
path d = subpath(a, 0.25, 0.75);
write(point(d, 0));
write(point(d, 1));

// 5. 倒序的 a > b：整段反过来
path e = subpath(b, 2, 0);
write(point(e, 0));
write(point(e, 2));

// 6. 两条直线的交点
path p = (0,0)--(2,2);
path q = (0,2)--(2,0);
real[] t = intersect(p, q);
write(t.length);
write(t[0]);
write(t[1]);
write(point(p, t[0]));

// 7. 一条线穿过折线两次
path r = (-1,0.5)--(2,0.5);
write(intersections(b, r).length);

// 8. 不相交
write(intersect((0,0)--(1,0), (0,1)--(1,1)).length);

// 9. transpose
real[][] m = {{1,2,3},{4,5,6}};
real[][] n = transpose(m);
write(n.length);
write(n[0].length);
write(n[2][1]);
