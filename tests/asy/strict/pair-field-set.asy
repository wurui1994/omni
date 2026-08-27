// asy 自己就不收：pair 的分量是**只读的虚字段** —— 量过 `z.x = 5` 与 `a.p.x = 5`
// 都报 "virtual field is read-only"（后者是 3.4）。第十五刀让 struct 收了 pair 字段，
// `s.p.x` 这条三层的点因此第一次能降，所以"能读不能写"这条边界要专门守。
struct S { pair p; }
S a;
a.p = (1,2);
a.p.x = 5;
write(a.p);
