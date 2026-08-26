// 默认实参与命名实参 —— 第十刀。
// 「默认值是每次调用求一次、且只在没给时才求」这条是用文件级计数器量出来的
// （d(); d(); d(99); 之后 bump 只被调 2 次），而这一层还没有文件级变量，
// 所以那份程序留在 lower.js 的头注里，这里钉的是能在两边都跑的部分。

void h(int a, int b, int c) { write(a); write(b); write(c); }
h(1, c=3, b=2);
h(c=30, a=10, b=20);

void k(int a, int b = 5, int c = 7) { write(a); write(b); write(c); }
k(1);
k(1, 2);
k(1, c=9);

// 默认值能引用前面的形参 —— 它是在被调方的作用域里求的
void q(int a, int b = a + 10) { write(b); }
q(1);
q(1, 2);

// 默认值可以是一个调用；int 默认值填进 real 形参走的还是那条隐式提升
real area(real w, real h = 2.5) { return w * h; }
write(area(3));
write(area(3, 4));
write(area(h=10, w=2));

int twice(int x) { return 2 * x; }
int f(int a, int b = twice(a)) { return a + b; }
write(f(3));
write(f(3, 1));

string tag(string s, string pre = "[", string post = "]") { return pre + s + post; }
write(tag("x"));
write(tag("x", "<", ">"));
write(tag("x", post="!"));

pair mk(real x, pair off = (1,1)) { return (x, 0) + off; }
write(mk(2));
write(mk(2, (0,5)));

// 乱序的命名实参：求值顺序还是源码顺序，所以 write 的先后能看出来
int show(int v) { write(v); return v; }
void two(int a, int b) { write(a + b); }
two(b=show(1), a=show(2));
