// 第二十八刀：struct 体里的 `autounravel` —— 那个成员其实是**文件级**声明。
// 每一行的期望输出都是 `asy -noV` 印出来的。
struct R {
  int p;
  void operator init(int p) { this.p = p; }
  // 文件级的转换：`R r = 4;` 与 `real x = r;` 都走它
  autounravel R operator cast(int n) { return R(n); }
  autounravel real operator cast(R r) { return r.p * 1.5; }
  // 文件级的算符
  autounravel R operator +(R a, R b) { return R(a.p + b.p); }
  // 文件级的普通函数：调用形态是**裸名字**，不是方法
  autounravel int size(R r) { return r.p; }
  // 带默认实参也照旧（默认值在被调方的作用域里求）
  autounravel int bump(R r, int by = 10) { return r.p + by; }
  // 真的方法（不带 autounravel）还是方法
  int half() { return p # 2; }
}

R a = 4;
write(a.p);

real x = a;
write(x);

R s = a + 3;
write(s.p);

write(size(s));
write(bump(s));
write(bump(s, 1));
write(s.half());

// 重载：文件级再写一份 size，两份在同一张候选表里
int size(int n) { return n * 100; }
write(size(9));
write(size(a));
