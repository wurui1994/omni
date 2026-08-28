// 数组上的比较是**逐元素**的，回 bool[]（runarray.in 的 Compare 那一族）。
// 两个数组、数组与标量、标量与数组三档都有；bool[] 的 `&` 与 `|` 也是逐元素的。
// graph.asy:527/842 与 math.asy:147 就是这几条的原型。
real[] a = {1, 5, 3};
real[] b = {2, 4, 3};
write(a > b);
write(a >= b);
write(a < 3);
write(2 <= a);
write((a > b) & (a < 4));
write((a > b) | (a < 2));
// all（runarray.in）：空数组是 true。asy 那边没有 `any`，所以这里也不试它。
write(all(a >= 1));
write(all(a > 4));
// sort（runarray.in）：real[] / int[] / string[] 三档
write(sort(a));
write(sort(new int[] {3, 1, 2}));
write(sort(new string[] {"b", "a", "c"}));
// pow10（runmath.in）：10^x
write(pow10(3));
write(pow10(0.5));
// 二维数组上的 `*` 是矩阵乘，不是逐元素（嵌套数组的 write 这一刀还没做，所以按行印）
real[][] m = {{1, 2}, {3, 4}};
real[][] i2 = {{1, 0}, {0, 1}};
real[][] mi = m * i2;
write(mi[0]); write(mi[1]);
write(new real[] {1, 1} * m);
write(m * new real[] {1, 1});
// AtA 与 pair 的 transpose
real[][] g = AtA(m);
write(g[0]); write(g[1]);
pair[][] t = transpose(new pair[][] {{(1, 2), (3, 4)}});
write(t[0]); write(t[1]);
