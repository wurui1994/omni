// 第五十刀：实参往形参上落的规矩照参考实现来（application.cc:205 matchArgument
// 加 :154 matchDefault）—— 这一格接不住、而它**有默认值**，就把默认值填上、换下一格
// 再试。所以中间那些带默认值的形参可以整格跳过去。
int f(int a, int b=7, string c, string d) { return a + b + length(c) + length(d); }
write(f(1, "xy", "z"));
write(f(1, 2, "xy", "z"));
write(f(b=2, a=1, c="xy", d="z"));

// 成员那一层"声明在后面"**不该整片挡住**外层的同名函数：base 里 plain_bounds.asy:226
// 的 `min(a,b)` 就是这一种 —— struct 里 `pair min()` 声明在后面，那一行接的是外层的 min。
int hi(int a, int b) { return a + b; }
struct S {
  int v = hi(2, 3);              // 成员 hi() 还看不见，这里是外层那个
  int hi() { return 100; }
  int both() { return hi() + hi(1, 1); }   // 前一个是成员，后一个是外层
}
S s;
write(s.v);
write(s.both());
