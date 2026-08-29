// `? :` 两支的类型定不下来时，用处那一侧给的目标类型定案。
// A 与 B 两个方向的 cast 都在 —— 求"公共类型"是歧义，而有了目标（返回类型）就没有歧义。
// asy 那边这是 conditionalExp::transToType（exp.cc:1280）那条路：两支各自转到目标去。
// plain 里的 bool/bool3 就是这一对（plain_constants.asy:118 与 :123），
// examples/oneoverx.asy:13 的 `return b ? true : default;` 靠它。
struct A { int v; }
struct B { int v; }

A operator cast(B b) { A a; a.v=b.v; return a; }
B operator cast(A a) { B b; b.v=a.v; return b; }

A pick(bool c, A x, B y) { return c ? x : y; }
B pickB(bool c, A x, B y) { return c ? x : y; }

A a; a.v=3;
B b; b.v=9;
write(pick(true,a,b).v);
write(pick(false,a,b).v);
write(pickB(true,a,b).v);
write(pickB(false,a,b).v);
