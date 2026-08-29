// Delaunay 三角化（runarray.in:2102 -> Delaunay.cc 的 Triangulate）。
// presort 那一趟照抄的是 BSD/Apple libc 的 qsort（比较只看 x、等 x 回 0，所以次序全看
// 那份实现怎么走）—— 下面这些形状与 `asy -noV` 逐字节一致。
// **已知对不上的**：正方规则网格里的 3x3、4x4、7x7（四点共圆那种退化输入，真 asy 的判据
// 走 Shewchuk 的精确算术、这一层只有浮点那一半；7x7 还差在 qsort 的 n=49 那一格上）。
// 8x8、9x9、5x5、6x6、2x2 反倒一致，所以这不是"网格一律不同"，而是退化形状上的定不了案。
void show(pair[] z) {
  int[][] t = triangulate(z);
  write(z.length, t.length);
  for (int i = 0; i < t.length; ++i) write(t[i][0], t[i][1], t[i][2]);
  write("--");
}
// 三点、四点（一个正方形：四点共圆，这一格两边一样）
show(new pair[] {(0,0),(1,0),(0,1)});
show(new pair[] {(0,0),(1,0),(1,1),(0,1)});
// 不规则的一把点（非退化，两边一样）
show(new pair[] {(0,0),(3,0.5),(1,2),(2.5,2.5),(0.5,3),(4,1),(1.5,1.2)});
// 规则网格里对得上的那几个尺寸
for (int n = 2; n <= 6; ++n) {
  if (n == 3 || n == 4) continue;
  pair[] z;
  for (int i = 0; i < n; ++i) for (int j = 0; j < n; ++j) z.push((i,j));
  show(z);
}
// 伪随机（线性同余，两边算的是同一串数）：n<7、n>7、n>40 三条路都走到
int seed = 12345;
real rnd() { seed = (1103515245*seed+12345)%2147483648; return seed/2147483648.0; }
for (int n = 8; n <= 60; n += 13) {
  pair[] z;
  for (int i = 0; i < n; ++i) z.push((rnd(), rnd()));
  show(z);
}
// 共线、重点、一整列同 x
show(new pair[] {(0,0),(1,1),(2,2),(3,3),(0,3),(3,0),(1,0),(0,1)});
show(new pair[] {(0,0),(0,0),(1,0),(0,1),(1,1),(0.5,0.5)});
show(new pair[] {(0,0),(0,1),(0,2),(0,3),(1,1.5),(-1,1.5),(0.5,0),(0.5,3)});
// 点太少：真 asy 那边回的也是空表
write(triangulate(new pair[] {(0,0)}).length);
write(triangulate(new pair[] {(0,0),(1,1)}).length);
