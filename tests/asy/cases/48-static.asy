// struct 体里的 `static`：**不是字段**，是一个名字挂在 struct 上的文件级变量。
//
// 量出来的理由：plain_filldraw.asy 的 filltype 里有五个 `static int Fill=1;`，
// three.asy 的 `static interaction defaultinteraction;` 也是同一条（那是 46 个 examples 的门）。
//
// 期望值都是 `asy -noV` 量的。注意测试里的 struct 别叫 `S` —— base 的 plain_constants.asy
// 里 `S` 是**南**那个方向常量，那样量到的是名字碰撞而不是语义。

struct Box {
  static int n = 1;
  int x = 5;
  int get() {return x + n;}
  void bump(int k) {n = n + k;}
}

// 用类型名取
write(Box.n);

Box a; Box b;

// 用实例取，取的是同一格
write(a.n);
write(b.n);

// 用实例写，写的也是那一格
a.n = 7;
write(Box.n);
write(b.n);

// 实例方法里裸的名字就是它（5 + 7）
write(a.get());

// 实例方法里给它赋值
b.bump(3);
write(Box.n);
write(a.get());

// 用类型名写
Box.n = 2;
write(a.n);

// 一个 struct 上可以有好几个（filltype 就是五个），类型也不止 int
struct Kind {
  static int Fill = 1;
  static int Draw = 3;
  static string tag = "k";
  static real eps = 0.5;
  int id = 0;
}
write(Kind.Fill);
write(Kind.Draw);
write(Kind.tag);
write(Kind.eps);

// 没写初值的 static 是零初始化的（与文件级变量同一条）。
// `id` 那个字段是凑数的：只有 static 成员的 struct 一个字段都没有，而"没有字段的 struct"
// 这一刀还不收（另一件事，与 static 无关）。
struct Zero {
  static int z;
  static bool flag;
  int id = 0;
}
write(Zero.z);
write(Zero.flag);
