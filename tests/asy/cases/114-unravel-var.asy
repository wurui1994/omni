// `unravel x;`：把一格记录的成员摊进当前作用域。摊出来的名字是**别名** ——
// 读、调用、赋值都落在 x 的那个字段上（collections/iter.asy:17、plain.asy:172 要的正是它）。
struct Box { int a; string s; }

void show() {
  Box b;
  b.a = 1;
  unravel b;
  a = 7;                       // 写进去的是 b.a
  s = "hi";
  write(a); write(s);
  write(b.a); write(b.s);
}
show();

// 没有体的方法声明就是一格函数类型的字段：摊出来照样能装、能调
struct Fn { int f(int); }
Fn mk() {
  Fn r;
  unravel r;
  f = new int(int x) { return x * 3; };
  write(f(2));                 // 调的是 r.f
  return r;
}
Fn q = mk();
write(q.f(5));

// 文件级也来一次
Box g;
unravel g;
a = 2;
s = "top";
write(a); write(g.a);
write(s); write(g.s);
