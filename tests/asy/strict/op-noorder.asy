// 记录上没有内建的大小比较：量过 `asy -noV` 报 "no matching function 'operator <=(V, V)'"。
// 只定义了 `operator <` 不会顺带给出 `<=`（asy 不派生，每个算符各是各的）。
// 我们先前**收下了**这种式子（promote 回记录名就直接发 `(bin "<=" …)`）—— 这一条是
// 第二十三刀顺手补的漏，不带 ASY_NOPE：不是还没做，是这个程序本来就不对。
// `==`/`!=` 是内建的（比身份，引用语义），自己定义 `operator <=` 也是通的，
// 见 cases/25-opover.asy。
struct V { int x; }
V mk(int n) { V v = new V; v.x = n; return v; }
bool operator <(V p, V q) { return p.x < q.x; }
write(mk(1) < mk(2));
write(mk(2) <= mk(2));
