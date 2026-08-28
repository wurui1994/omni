// 笔 / 路径 / 变换 / 二维数组的**文字**输出（pen.h:869、path.cc:1098、
// transform.h 的 operator<<、runarray.in 的 write）。`write(file f, …)` 这一支的
// 默认后缀是 none（量过 `write(stdout,"a")` 不带换行），所以每一行都显式给 endl。
file f = output();
write(f, currentpen, endl);
write(f, black, endl);
write(f, red + linewidth(2), endl);
write(f, fontsize(9) + black, endl);
write(f, "p=", red, endl);

path p = (0,0)--(1,1);
write(f, p, endl);
path s = (0,0)--(1,0)--(1,1)--cycle;
write(f, s, endl);
path e;
write(f, e, endl);
write(f, (5,5), endl);
write(f, "g=", p, endl);
path c = (0,0)..(1,1)..(3,-1);
write(f, c, endl);

write(f, identity(), endl);
write(f, shift(1,2), endl);
write(f, "T=", rotate(30) * scale(2), endl);

real[][] m = {{1,2},{3,4}};
write(f, m);
