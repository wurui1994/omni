// 数组上的 `==` / `!=` 是**逐格**的（builtin.cc:485 的 addBooleanOps）：回 bool[]，
// 不是一个 bool。three_light.asy:67 的 `all(m.p == n.p)` 就是这一格。
real[] a={1,2,3};
real[] b={1,5,3};
write(a==b);
write(a!=b);
write(all(a==b));

int[] i1={1,2};
int[] i2={1,2};
write(all(i1==i2));

string[] s1={"x","y"};
string[] s2={"x","z"};
write(s1==s2);

bool[] b1={true,false};
bool[] b2={true,true};
write(b1==b2);

pair[] p1={(1,2),(3,4)};
pair[] p2={(1,2),(3,5)};
write(p1==p2);

triple[] t1={(1,2,3)};
triple[] t2={(1,2,3)};
write(all(t1==t2));

// 空数组：逐格算完是空的，all 空数组是 true（量过）。asy 没有 any —— 量过它报
// "no matching variable ʼanyʼ"，我们也不收。
real[] e1;
real[] e2;
write(all(e1==e2));
