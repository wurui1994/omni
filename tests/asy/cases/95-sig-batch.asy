// 第六十一刀：签名对不上的那一批（rgb(pen) / size(path[]) / rand(a,b) / tensorshade 的
// 可选 path[] / system / clear）。签名逐条照参考实现抄，能写的体写准。

// runtime.in:381 rgb(pen) → pen.h:639 torgb()
real[] c = colors(rgb(cmyk(0.1, 0.2, 0.3, 0.4)));
write(c[0]); write(c[1]); write(c[2]);
// GRAYSCALE 与 DEFCOLOR 两档都走 greytorgb，出来是三道
write(colors(rgb(gray(0.5))).length);
write(colors(rgb(currentpen)).length);

// runpath.in:281 size(path[])：一族路径的段数之和
path[] ps = {(0,0)--(1,1)--(2,0), (0,0)--(1,0)};
write(size(ps));
write(size(new path[]));

// runmath.in:206 rand(int a=0, int b=intMax)：回 [a,b] 里的一个数。
// 伪随机数发生器与 asy 的不是同一个，数列不同，所以这里只钉**范围**。
write(rand(5, 5));
int r = rand(0, 9);
write(r >= 0 && r <= 9);
