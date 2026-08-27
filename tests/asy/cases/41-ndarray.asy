// 多维数组（asy 的 real[][]）。这一条量的是 asy 的行为，不是我们猜的：
// 期望文件是 `asy -noV 41-ndarray.asy` 印出来的。
real[][] a = new real[2][3];
a[0][0] = 1; a[0][2] = 3; a[1][1] = 5;
write(a.length);
write(a[0].length);
write(a[0][0] + a[0][2] + a[1][1]);

// 行是引用：拿出来改，原数组跟着变。
real[] row = a[1];
row[0] = 7;
write(a[1][0]);

// 长度写在名字后面的那种写法
int b[][] = new int[3][2];
b[2][1] = 9;
write(b.length + b[0].length + b[2][1]);

// 空的外层 + 逐行 push
real[][] c;
write(c.length);
c.push(new real[]{1,2,3});
c.push(new real[]{4,5});
write(c.length);
write(c[0].length + c[1].length);
write(c[0][2] + c[1][1]);

// 只给外层长度：每一行都还没构造（asy 那边读它报 dereference of null array）
real[][] d = new real[2][];
write(d.length);
d[0] = new real[]{8};
write(d[0][0]);

// 三维
int[][][] e = new int[2][2][2];
e[1][1][1] = 4;
write(e.length + e[0].length + e[0][0].length + e[1][1][1]);

// 数组当形参/返回值。注意求和只能碰**赋过值**的格子：asy 那边没赋过的格子是
// "未初始化"、读就报错（我们填零值，这条差别在 lower.js 的文件头写着），
// 所以这里的矩阵是逐格填满的。
real total(real[][] m) {
  real s = 0;
  for (int i = 0; i < m.length; ++i)
    for (int j = 0; j < m[i].length; ++j)
      s += m[i][j];
  return s;
}

real[][] mk(int n) {
  real[][] r = new real[n][n];
  for (int i = 0; i < n; ++i)
    for (int j = 0; j < n; ++j)
      r[i][j] = i * n + j;
  return r;
}
write(total(mk(3)));
write(mk(4)[2][3]);

// 切片：复制的是外层，行还是同一批
real[][] f = mk(2);
real[][] part = f[0:1];
write(part.length);
part[0][0] = 99;
write(f[0][0]);

// 花括号初值套花括号初值。里面那一层各摊一个临时量，所以两行不共用同一条。
real[][] m = new real[][] {{1,2},{3,4,5}};
write(m.length); write(m[1].length); write(m[1][2]);
int[][] z = {{7},{8,9}};
write(z[1][1]);
m[0].push(6);
write(m[0].length + m[1].length);

// 文件级的多维数组（模块级单件那条路）
real[][] g;
void fill() { g = new real[1][1]; g[0][0] = 6; }
fill(); write(g[0][0]);

// string 的二维
string[][] s = new string[2][2];
s[1][0] = "ok";
write(s[1][0]);
