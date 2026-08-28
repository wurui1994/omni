// 一批"名字与调用"的形状，原型都在 base 里。
// (1) 调用一个**任意表达式**：`(c ? f : g)(x)`（plain_filldraw.asy:247）。
//     两支都是**重载集**时按交集定案 —— 两边都有的**那一个**签名（多于一个不猜）。
int twice(int x) { return 2 * x; }
string twice(string s) { return s + s; }
int thrice(int x) { return 3 * x; }
real thrice(real x) { return 3.5 * x; }
bool b = true;
write((b ? twice : thrice)(5));
write((b ? thrice : twice)(5));

// (2) 同名的**模块级那一格**：里面那一格没有这个字段时往外找
//     （graph.asy:1007 的 `axisT axis;` 与 xaxisAt 的形参 `axis axis`）。
struct axisT { real value = 7; int[] div; }
axisT axis;
typedef void axisfn(int);
real look(axisfn axis) { return axis.value; }
void bump(axisfn axis) { axis.div.push(3); }
write(look(new void(int i) {}));
bump(new void(int i) {});
write(axis.div[0]);

// (3) 形参那一格与模块级那一格同名不同型：被调是形参、实参是模块级那一格
void feed(axisfn axis) { axis(axis.value == 7 ? 1 : 0); }
feed(new void(int i) { write(i); });

// (4) for 的条件里的 `? :`：条件每轮都得重算
int n = 0;
for (int i = 0; b ? i < 3 : false; ++i) n += i;
write(n);
