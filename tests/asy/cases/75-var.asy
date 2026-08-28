// `var`（第四十一刀）：不是类型，是"从初值推"。每个名字**各推各的** ——
// 量过 asy：`var a=1, b=2.5;` 出来是 int 与 real（印 1 与 2.5，不是 1.0）。
// 三处都要：文件级、struct 字段、函数体里的局部量。
// 文件级那一份的类型是**声明遍**里推的 —— 函数体比文件级语句先降级，
// 等到降那一句才定类型的话，h() 里那个 a 就没有类型可查。
var a=1, b=2.5;
write(a); write(b);
struct S { var n = 5; }
S s; write(s.n);
void f() { var q = 7; write(q); }
f();
var c = a + b;
write(c);
int g() { return a + 10; }
var d = g();
write(d);
var t = "hi";
write(t + "!");
int h() { return a + 1; }
write(h());
