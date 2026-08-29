// 一批：语句位置的任意表达式 / 名字叫 `operator --` 的那一格变量

int n = 0;
int f() { ++n; return 5; }

// 语句位置：asy 收任何表达式，值丢掉，副作用照发
f();
1 + 2;
f() + f();
string s = "a";
s + "b";
n;
write(n);

// 名字叫 `operator --` 的一格局部量（controlsystem.asy:20 的形状）
typedef int conn(int, int);
conn mk(int k) { return new int(int a, int b) { return a * 100 + b + k; }; }

// 同名的文件级算符，签名不同：两份一起在重载集里
int operator --(int a, string b) { return a + length(b); }

void g() {
  conn operator --= mk(7);
  int r = 1 -- 2;
  write(r);
  write(1 -- 2 -- 3);
  // 这一句的第 2 个操作数是 string：局部那一格接不住，走文件级那份
  write(4 -- "abc");
}
g();

// 出了那个作用域，局部那一格没了
write(9 -- "xy");
