// split 要回一个 string[]，而这一刀的 (arr T) 只收标量元素、函数返回数组也还没走通
// 这条路 —— 跟 pair[] 是同一道坎，一起过。
string[] a = split("a b", " ");
write(a[0]);
