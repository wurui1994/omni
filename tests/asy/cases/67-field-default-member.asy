// 字段的默认值看得见**前面**的成员（第三十五刀）。量出来的四条正好是 self 那套规矩：
//   - 前面的字段看得见（`int y = x + 1;` -> 2）；
//   - 前面的方法能调（`int f() {…} int y = f();` -> 7）；
//   - 后面的字段与后面的方法都报 "no matching variable"（asy 退 1，见 strict/field-def-later*）。
// 落地只有一处：隐式构造那份 `asy__new_T` 里的局部量改名叫 `this`，再按这一格的成员号
// 把 L.self 开着 —— 于是裸字段名走的就是方法体里那条老路。
struct S {
  int x = 1;
  int y = x + 1;
  int twice() { return y * 2; }
  int z = twice() + x;
  string tag = 'S' + string(z);
}

S s;
write(s.x);
write(s.y);
write(s.z);
write(s.tag);

// 每个实例各算一遍（不是把结果缓存在类型上）
S t = new S;
t.x = 9;
write(t.z);
write(s.z);
