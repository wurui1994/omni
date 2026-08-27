// 数组的 .delete / .insert（math.asy:145/158 的 `.delete(0)`、:187 的 `.insert(i,x)`）。
// 量过的四条：delete(i) 删一格、delete(i,j) 删**闭区间**、delete() 清空、
// insert(i, …) 可变实参（`s.insert(1,q,r)` 出来是 x q r y）。
int[] a = {1,2,3,4,5};
a.delete(1);
write(a);
write(a.length);
a.insert(1, 9);
write(a);
int[] b = {1,2,3};
b.delete(0, 1);
write(b);
int[] c = {1,2,3};
c.delete();
write(c.length);
string[] s = {'x','y'};
s.insert(1, 'q', 'r');
write(s);

// 记录元素与数组元素也走同一个工厂（helper 是按元素类型生成的）
struct P { int v; }
P[] ps;
for (int i = 0; i < 4; ++i) { P p = new P; p.v = i; ps.push(p); }
ps.delete(1, 2);
write(ps.length);
write(ps[0].v);
write(ps[1].v);
P q = new P; q.v = 9;
ps.insert(1, q);
write(ps[1].v);

int[][] m = {{1},{2},{3}};
m.delete(1);
write(m.length);
write(m[1][0]);
