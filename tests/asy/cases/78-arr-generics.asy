// 第四十四刀：泛型的那几个数组内建（copy / sequence）、int[] 当下标、.append、
// min/max 那一族（有序基本类型的两元与数组），以及 `(string) x`。
// 这些在 C++ 那边是 runarray.in / builtin.cc 里对 T 泛型的一批，这一层按元素类型现生。

// copy：深拷（元素本身是数组也拷一层新的）
real[][] m = {{1, 2}, {3, 4}};
real[][] c = copy(m);
c[0][0] = 99;
write(m[0][0]);
write(c[0][0]);

// sequence(f, n)：{f(0), …, f(n-1)}，元素类型是 f 的返回类型
string[] ss = sequence(new string(int i) { return "s" + string(i); }, 3);
write(ss[0] + ss[1] + ss[2]);
pair[] zs = sequence(new pair(int i) { return (i, -i); }, 2);
write(zs[1]);

// a[ix]：ix 是 int[] 时挑出来一份新数组
int[] a = {10, 20, 30, 40};
int[] ix = {3, 1, 0};
int[] picked = a[ix];
write(picked[0]);
write(picked[2]);

// append：把另一份数组的元素接到后面
int[] b = {1};
b.append(a);
write(b.length);
write(b[1]);

// min / max：两元与整份数组
write(min(3, 7));
write(max(2.5, 1.5));
write(min(a));
write(max(new string[] {"b", "a", "c"}));

// (string) x：显式转换，和 string(x) 同一份格式
write((string) 2.5 + "|" + (string) 7);

// unit / identity(n)
write(unit((3, 4)));
write(identity(2)[1][1]);
