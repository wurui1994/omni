// 数学那一族的标量那一份当函数值用；跨单元的文件级 `operator init`

real g(real f(real), real a) { return f(a); }
int h(int f(real), real a) { return f(a); }
real k(real f(real,real), real a, real b) { return f(a,b); }

write(g(exp, 1.0));
write(g(sin, 0.0));
write(g(sqrt, 2.0));
write(h(floor, 2.5));
write(h(round, 2.5));
write(k(atan2, 1.0, 2.0));
write(k(fmod, 7.0, 3.0));
// abs 的标量那几格摆在内建面里（真函数），这里不该再补一份
write(g(abs, -3.5));
// 目标类型是初值那一格时也定得下来
real f2(real) = log;
write(f2(1.0));

// 另一个单元里的 struct：`P p;` 该造什么由**那个单元整份**说（那份 operator init
// 写在 struct 后面，按 struct 声明处问就看不见它）
import mod_oi;
P p;
write(p.v);
write(p.tag(3.0));
Q q;
write(q.n);
