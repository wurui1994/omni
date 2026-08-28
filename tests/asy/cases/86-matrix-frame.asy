// 第五十二刀：矩阵那三个乘法与 `transform * frame`。
// `real[][] * triple`（runarray.in:1462）是**齐次**的 —— 量过它除以第四行。
real[][] t = {{1,0,0,5},{0,2,0,6},{0,0,3,7},{0,0,0,2}};
triple v = (1,1,1);
write(t*v);
real[][] s = {{1,0,0,5},{0,2,0,6},{0,0,3,7},{0,0,0,1}};
write(s*v);
real[] b = {1,1,1,1};
write(t*b);
real[][] m = {{1,2},{3,4}};
real[][] n = {{5,6},{7,8}};
real[][] mn = m*n;
write(mn[0][0]);
write(mn[0][1]);
write(mn[1][0]);
write(mn[1][1]);

// `transform * frame`（runtime.in:1112）：frame 里每一笔都搬。看得见的是盒子。
frame f;
_draw(f, (0,0)--(1,2), currentpen);
write(min(f));
write(max(f));
frame g = shift(3,4)*f;
write(min(g));
write(max(g));
frame h = xscale(2)*f;
write(max(h));
