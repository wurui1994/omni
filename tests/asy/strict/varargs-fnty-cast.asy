// 可变形参**进类型身份**：`int(... int[])` 与 `int(int[])` 是两个类型。
// 量过 asy 也拒 —— `asy -noV` 报 "cannot cast 'int(... int[] xs)' to 'int(int[])'" 并退 1。
// 我们的拼法把 `... ` 留在形参的类型文本里，所以这一条是白捡的：类型相等还是一次字符串比较。
// 这一条**不带** ASY_NOPE：不是还没做，是这个程序本来就不对。
int total(... int[] xs) { int s=0; for (int x : xs) s += x; return s; }
using afn = int(int[]);
afn g = total;
write(g(new int[] {4,5}));
