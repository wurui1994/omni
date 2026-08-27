// `&&` / `||` 的重载：**asy 自己就不收**。量过这个文件在 `asy -noV` 下的输出是
//   bool operator &&(V p, V q) { return p.x + q.x > 3; }
//                  ^
//   ol.asy: 8.16: syntax error:
// 并 exit 1 —— camp.y 的 operator 产生式里没有 `&&`/`||` 这两个 token。
// 所以这是 strict/ 而不是 bad/：不是"我们还没做"，是这个程序本来就不合法，
// 诊断因此不带 ASY_NOPE。别的算符 asy 都收：`[] & | ** :: .. cast` 全量过是收的，
// 那些还没做的落在 bad/（见 bad/op-cast.asy）；通了的见 cases/25-opover.asy。
struct V { int x; }
V mk(int n) { V v = new V; v.x = n; return v; }
bool operator &&(V p, V q) { return p.x + q.x > 3; }
write(mk(2) && mk(2));
write(mk(1) && mk(1));
