// struct 体里的 `autounravel T n = …`（第三十四刀）：与 `static` **只差一条** ——
// 那个名字在 struct 之后的**文件级**也裸着可见。
//
// 量出来的理由：`collections/iter.asy:42` 的
// `autounravel Iterable_T operator cast(T[] items) = Iterable_T;` 与 :44 的 Iterable ——
// `import plain;` 现在就卡在这一行上。
//
// struct 别叫 `S` —— base 的 plain_constants.asy 里 `S` 是**南**那个方向常量，
// 那样 `S.b` 量到的是 pair 上没有 b（48-static.asy 那条注释里的同一个坑，这次真踩了一次）。

struct Box {
  static int a = 1;
  autounravel int b = 2;
  int x = 5;
  // 方法体里裸的名字也是它（static 那条路，与 autounravel 无关）
  int get() {return x + b;}
  void bump(int k) {b = b + k;}
}

// 类型名限定、裸名字、实例限定，三条都通，而且是同一格
write(Box.a);
write(Box.b);
write(b);
Box q;
write(q.a);
write(q.b);

// 三个名字里随便哪个写，另外两个都看得见
Box.b = 5;
write(b);
b = 6;
write(Box.b);
write(q.b);

// 方法里读写
write(q.get());
q.bump(3);
write(b);
write(q.get());

// 不止 int：string / real / 数组 / 记录都行（全局量那一档收的就是这些）
struct P { int v; }
struct Kind {
  autounravel string tag = "k";
  autounravel real eps = 0.5;
  autounravel int[] xs;
  autounravel P p;
  int id = 0;
}
write(tag);
write(eps);
xs.push(1);
xs.push(2);
write(xs.length);
p.v = 4;
write(p.v);

// 没写初值的是零初始化的（与文件级变量同一条）
struct Zero {
  autounravel int z;
  autounravel bool flag;
  int id = 0;
}
write(z);
write(flag);

// 变量与函数的 autounravel 混在同一个 struct 里（这一段是从 bad/au-var 提上来的 ——
// 那条 nope 就是这一刀要拆的墙）
struct R {
  int p;
  autounravel int k = 9;
  autounravel int twice(R r) { return r.p * 2; }
}
write(k);
R zz = new R;
zz.p = 5;
write(twice(zz));
