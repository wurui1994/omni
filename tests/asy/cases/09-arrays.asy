// 数组。返回类型与长度语义都是量出来的（`asy -noV`）：
//   - `new T[n]` 给 n 个格子；`{…}` 与 `new T[] {…}` 按项数定长
//   - `a.push(v)` **返回压进去的那个值**（下面 `int x = c.push(8)` 是证据）
//   - `a.pop()` 摘掉并返回最后一个
//   - **写下标会把长度顶到 下标+1**（`int[] e; e[2]=5;` 之后 e.length 是 3）
int[] a = new int[3];
write(a.length);
a[0] = 1;
a[1] = 2;
a[2] = a[0] + a[1];
write(a[2]);
a[1] += 10;      // 复合赋值：读一次写一次，下标只算一次
write(a[1]);
++a[0];          // 前缀自增。后缀 `a[0]++` asy 自己就不收（bad/postfix.asy 钉着）
write(a[0]);

int[] c = {5,6,7};
write(c.length);
write(c[1]);
int x = c.push(8);
write(x);
write(c.length);
write(c.pop());
write(c.length);

real[] r = new real[] {1.5, 2.5};
write(r[0] + r[1]);
r[0] /= 2;
write(r[0]);

string[] s = {"hi","there"};
write(s[0], s[1]);   // 第一个串是前缀，所以中间没有制表符
s[0] += "!";
write(s[0]);

bool[] q = {true,false};
write(q[0]);
write(q[1]);

// 自动扩长：中间那个格子在 asy 那边是"未初始化"（读会报错），我们填零 —— 差别写在
// frontend-asy/lower.js 的文件头。这里只印**被写过**的那个，两边都成立。
int[] e;
write(e.length);
e[2] = 5;
write(e.length);
write(e[2]);

// 数组穿过函数：引用语义，函数里改了外面也看得见
int total(int[] v) {
  int s = 0;
  for (int i = 0; i < v.length; ++i) s += v[i];
  return s;
}
void bump(int[] v) {
  for (int i = 0; i < v.length; ++i) v[i] += 1;
}
write(total(c));
bump(c);
write(total(c));
write(c[0]);

// 别名：赋值传的是同一段存储
int[] b = c;
b[0] = 100;
write(c[0]);

// 数组当返回值
int[] ramp(int n) {
  int[] out;
  for (int i = 0; i < n; ++i) out.push(i * i);
  return out;
}
int[] sq = ramp(4);
write(sq.length);
write(sq[3]);
write(total(sq));
