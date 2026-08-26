// for-each（`for (T x : a)`）。期望值都是 `asy -noV` 印的。
//
// 要害的两条：
//   - 循环变量是**复制**：体里改它不动数组。
//   - 迭代是**活的**：体里 push 进去的元素会被走到（所以下面那段走 6 轮而不是 2 轮）。
//     这一条排除了"先拷一份快照再走"的实现。

int[] a = {1,2,3};
for (int x : a) write(x);

// continue 与 break
int s = 0;
for (int x : a) { s += x; if (x == 2) continue; s += 10; }
write(s);
for (int x : a) { if (x == 2) break; write(x); }

// 循环变量是复制
for (int x : a) { x = 99; }
write(a);

// 别的元素类型
real[] r = {1.5,2.5};
for (real v : r) write(v);
string[] ss = {"x","y"};
for (string t : ss) write(t);
bool[] bb = {true,false};
for (bool b : bb) write(b);

// 空数组：一轮都不走
int[] none = new int[0];
for (int x : none) write(999);
write("empty done");

// 走一个切片（切片是复制，所以这里走的是那份复制）
for (int x : a[1:]) write(x);

// 嵌套
int[] p = {1,2};
for (int i : p) for (int j : p) write(i*10+j);

// 活的迭代：体里 push 会被走到
int[] g = {1,2};
int n = 0;
for (int x : g) { ++n; if (n < 5) g.push(9); }
write(n);
write(g.length);

// 在函数里，且累加进外面的局部量
int sum(int[] xs) { int t = 0; for (int x : xs) t += x; return t; }
write(sum(a));
write(sum(new int[]{4,5,6}));
