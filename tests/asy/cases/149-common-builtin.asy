// 两边**各自**转到同一个内建型才接得住的那一格（geometry.asy:1588 的 `unit(M) * l.A`）。
// 形状照那边搭：V 只有 `pair operator cast(explicit V)`、P 有 `pair operator cast(P)`，
// 而 `P operator *(explicit P, explicit P)` 因为两个形参都是 explicit 接不住 (V, P) ——
// 于是赢的是**内建**的 `pair operator *(pair, pair)`（复数乘法）。
struct V { pair v; }
struct P { pair p; }
pair operator cast(explicit V u) { return u.v; }
pair operator cast(P M) { return M.p; }
P operator *(explicit P a, explicit P b) { P r; r.p = (17,17); return r; }
V u; u.v = (0.6,0.8);
P M; M.p = (1,2);
write(u*M);            // (0.6+0.8i)(1+2i) = (-1,2)
write(M*u);
write(u+M);
write(M-u);
// explicit 那一格真的挡得住：两边都是 P 时走的是用户那条
write((M*M).p);
// gsave/grestore（runpicture.in:276/281）：这一层是空的，只看它降得下来、跑得过
frame f;
gsave(f);
grestore(f);
write("ok");
