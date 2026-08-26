// 数组的两件剩活：`write` 一整个数组，和切片 `a[i:j]`。期望值都是 `asy -noV` 印的。
//
// 要害的几条：
//   - `write(a)` 每行是「下标 : TAB 值」；字符串前缀**自己占一行**。
//   - 多个数组并排印，行数按最长那个，短的到头就不印了。
//   - 切片是**复制不是视图**：改了切出来的那份，原数组不动。
//   - 半开区间，右边界超长就截到末尾。

int[] a = {10,20,30,40,50};

// write 一整个数组
write(a);
write("P",a);
int[] short = {1,2};
write(a,short);
write(new int[0]);

real[] r = {1.5,2.5};
write(r);
string[] s = {"x","y"};
write(s);
bool[] b = {true,false};
write(b);

// 切片：四种形状
write(a[1:3]);
write(a[:2]);
write(a[3:]);
write(a[:]);
write(a[0:0].length);
write(a[2:100]);

// 复制，不是视图
int[] c = a[0:2];
c[0] = 99;
write(a[0]);
write(c[0]);

// 下标是表达式，元素是别的类型
int n = 1;
write(a[n:n+2]);
write(r[1:]);
write(s[:1]);
write(b[1:]);

// 切片出来的还是数组：能接着切、接着 push、接着当实参
int total(int[] xs) { int t = 0; for (int i = 0; i < xs.length; ++i) t += xs[i]; return t; }
write(total(a[1:4]));
int[] d = a[1:4];
d.push(7);
write(d);
write(d[1:].length);
