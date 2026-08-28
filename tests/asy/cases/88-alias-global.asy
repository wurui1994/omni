// 第五十四刀：类型名是 typedef 别名的**模块级变量**。声明遍里那一步只认标量与记录名，
// 于是 `transform3 identity4 = ...`（plain_prethree.asy，transform3 是 real[][] 的别名）
// 在函数体里就成了"看不见的那一格"。别名在声明遍里解开就行 —— 二维数组这一格本来是收的。
typedef real[][] mat;
mat m = {{1, 2}, {3, 4}};
real trace() { return m[0][0] + m[1][1]; }
write(trace());

typedef int[] ivec;
ivec v = {1, 2, 3};
int total() {
  int s = 0;
  for (var x : v) s += x;
  return s;
}
write(total());

// 别名再加一层维度：`mat[] ms;`
mat[] ms;
ms.push(m);
int rows() { return ms[0].length; }
write(rows());
