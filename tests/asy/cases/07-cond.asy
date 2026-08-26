// `? :` 的短路：核心方言里它不是表达式，摊成临时量 + if/else 之后，**只有中选那一支
// 会跑**这件事必须还成立。所以两支都带副作用（write），谁被印出来就是证据。
int f() { write("f"); return 1; }
int g() { write("g"); return 2; }
bool c = true;
int z = c ? f() : g();
write(z);
// 嵌套：内层那一支的临时量赋值要落在外层 if 的那一支里，不能被提到外面去
int w = c ? (c ? 10 : 20) : g();
write(w);
write(!c ? f() : g());
// 循环体里的 `? :`：前置语句要留在循环体内，每轮各算一次
for (int i = 0; i < 3; ++i) write(i == 1 ? f() : g());
// 串上的 `? :`
for (int i = 0; i < 3; ++i) write(i % 2 == 0 ? "even" : "odd");
// 两支类型不同但可提升：int 与 real
real r = c ? 1 : 2.5;
write(r);
