// 第五十三刀：`for (var x : a)` —— 元素类型从数组推。asy 的 `var` 不是类型，是"从初值推"，
// 这里的初值就是 `a[i]`。base 里 plain_bounds.asy 那七处 `for (var link : links)` 是这一种。
pair[] box = {(1,2), (3,4)};
for (var z : box) write(z);
int[] xs = {5, 6};
int t = 0;
for (var x : xs) t += x;
write(t);
string[] ss = {"a", "b"};
for (var s : ss) write(s);
// 推出来的是**元素**类型，不是数组类型：嵌套数组走一层。
int[][] g = {{1, 2}, {3}};
for (var row : g) write(row.length);
