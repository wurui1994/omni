// `new T[n][]`：外层 n 格，每格是**一条新的空数组**（不是空引用）。
// 量过 asy：`a[0].length` 是 0、`a[0][0]` 报的是 "reading array of length 0 with
// out-of-bounds index 0"、`a[0].push(…)` 照样能用；each row 是独立的一条。
// three_surface.asy:460 的 `S.P=new triple[s.P.length][]` 紧跟着 :463 读 `S.P[i]`，
// 先前铺空引用时 `import three;` 就死在那儿。
//
// 有两样**故意没往里放**，因为那是这一层与 asy 本来就不一样的地方（不是这一刀的事）：
//   `new real[2][3]` 两层都铺满之后读 `d[1][2]`：asy 报 "read uninitialized value
//     from array at index 2"，这一层给 0；
//   `new S[2]`（S 是记录）读 `f[0].x`：asy 同样报未初始化，这一层是空引用、报
//     null reference。
// 两条都记在 asyNewArray 的注释里。
real[][] a=new real[2][];
write(a.length);
write(a[0].length);
a[0][2]=3.5;
write(a[0].length);
write(a[0][2]);
write(a[1].length);      // 另一行没被带上
a[1].push(7.5);
write(a[1][0]);
write(a[0].length);      // 两行各自独立

// 三层：只给前两维
real[][][] c=new real[2][3][];
write(c.length);
write(c[1].length);
write(c[1][2].length);
c[1][2].push(1.5);
write(c[1][2][0]);
write(c[0][2].length);   // 这一格没被带上

// 两维都给：两层都铺满
real[][] d=new real[2][3];
write(d[1].length);

// 元素类型是数组的 typedef，尾巴上没有空 `[]` 也一样是空数组
typedef real[] rarr;
rarr[] e=new rarr[3];
write(e.length);
write(e[0].length);
e[0].push(2.5);
write(e[0][0]);
write(e[2].length);
