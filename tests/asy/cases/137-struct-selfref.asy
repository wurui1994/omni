// 记录里放自己那一格（自引用字段）：不预造，留 null —— 和 asy 量到的一样
struct N { int v; N next; }
N a; a.v=1;
N b; b.v=2;
a.next=b;
write(a.v);
write(a.next.v);
write(a.next.next == null);
// 自引用那一格排在前头也一样（原来 bad/struct-self 划的那条边界，这一刀挪了）
struct A { A next; int x; }
A z;
write(z.x);
write(z.next == null);
// 通过数组绕一圈也算自引用（数组是空的，不是 null）
struct T { real x; T[] kids; }
T t; t.x=1.5;
T c; c.x=2.5; t.kids.push(c);
write(t.kids.length);
write(t.kids[0].x);
write(t.kids[0].kids.length);
