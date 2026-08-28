// 第四十七刀的另外三条：
//  1. **可变形参那一格接下来的候选不算同型** —— 内建算符压得住它。base 里
//     plain_strings.asy:125 就是 `string operator +(...string[] a)`，体里 `S += s` 走的是
//     内建的字符串接；不分开的话那一句会把两格打包再调回自己（栈溢出，量到 10 个例子）。
//  2. `operator @`（camp.l 的 EXTRAOPS）：geometry.asy 拿它写"点在线上"。
//  3. `settings` 是**内建模块**：不用 import，任何文件里都能读写。
string operator +(... string[] a) {
  string S = "[";
  for (string s : a) S = S + s;
  return S + "]";
}
// 两个操作数的 `+`：内建那一档赢（可变那份要打包，不算同型）
write("a" + "b");
// 三个及以上只有可变那份接得住 —— 那时它赢
write(operator +("x", "y", "z"));
// 数字上的 `+` 一点没变
write(2 + 3);
write(1.5 + 2);

struct pt { real x; real y; }
struct ln { real a; real b; real c; }   // a*x + b*y + c = 0
bool operator @(pt m, ln l) { return abs(l.a*m.x + l.b*m.y + l.c) < 1e-12; }
pt m; m.x = 1; m.y = 2;
ln l; l.a = 2; l.b = -1; l.c = 0;
write(m @ l);
l.c = 1;
write(m @ l);

settings.outformat = "pdf";
write(settings.outformat);
