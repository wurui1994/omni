// 重载解析 —— 第十一刀。核心方言没有重载，所以第 2 个及以后的候选在降级时改名，
// 挑哪一个是这一层按"同型优先、转换算代价"决定的。规则全是量出来的（见 lower.js）。

// 按元数
int f(int x) { return x; }
int f(int x, int y) { return x + y; }
write(f(1));
write(f(1, 2));

// 按类型：同型优先
string g(int x) { return "g-int"; }
string g(real x) { return "g-real"; }
string g(string s) { return "g-string"; }
write(g(1));
write(g(1.0));
write(g("s"));
write(g(1 + 1));
write(g(1.5 * 2));

// 只有 real 那份时 int 走隐式提升
real h(real x) { return x * 2; }
write(h(3));

// 重载 + 默认实参：候选是 (int) 与 (int,int)，后者第二个有默认值
int k(int a) { return a; }
int k(int a, int b = 10) { return a * b; }
write(k(2, 3));
write(k(2, b=4));

// 重载 + pair：int 到 pair 是一次转换，所以 (int) 那份赢
string p(int x) { return "p-int"; }
string p(pair z) { return "p-pair"; }
write(p(1));
write(p((1,2)));
write(p(1.5));

// 同签名写两次是替换，后一份赢（量过 asy 也是这样）
int s(int x) { return x; }
real s(int x) { return 2.5; }
write(s(5));

// 重载的两份互相调用。asy 的名字解析是**顺序的** —— 后面那份重载在前面那份的体里
// 看不见（量过：先写 rec(int) 再在它体里调 rec(n-1,2)，asy 报
// "cannot call 'int rec(int n)' with parameters 'int, int'"），所以两个元数的那份要先写。
// 自己看得见自己：rec(int) 体里的 rec(n-1) 就是它自身。
int rec(int n, int step) { return n + step; }
int rec(int n) { return n <= 0 ? 0 : rec(n - 1) + rec(n, 2); }
write(rec(1));
write(rec(3));
