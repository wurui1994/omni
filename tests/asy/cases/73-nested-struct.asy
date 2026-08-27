// 第三十九刀：**struct 体里的 struct 声明**。
//
// asy 的 struct 体就是个 block，里面能再声明一个 struct；那个名字**只在这个体里可见**。
// 量过（真 asy）：体里当字段、当数组元素、方法里 `new Inner` 全通；体外裸写 `Inner`
// 报 "no type of name 'Inner'"；不 private 的写 `new Outer.Inner` 报 "allocation of
// struct 'Inner' is not in a valid scope"，private 的写 `Outer.Inner` 报 "accessing
// private field outside of structure"（三条都退 1，所以体外那一族仍然是拒）。
//
// 落地：当一条普通的记录声明降（真名撞了就按第三十八刀打散），名字进外层那张**体内**
// 别名表 —— 与 `using` 同一张表、同一条"按体里项号排"的规矩。外层体里先起的名字在
// 嵌套的体里也认（下面 `cb` 那一条），plain_picture.asy:207 的 `drawerBound3` 就是它。
//
// `import plain;` 那面墙上这一刀拆掉两块砖：plain_bounds.asy:88 的
// `private static struct transformedBounds` 与 plain_picture.asy:210 的 `struct node3`。
struct Outer {
  using cb = int(int);

  struct Inner {
    int n = 2;
    cb f;
    int twice() { return 2 * n; }
  }

  Inner a = new Inner;
  Inner[] more;

  int sum() {
    Inner b = new Inner;
    b.n = 5;
    more.push(b);
    return a.twice() + more[0].n;
  }
}

Outer o = new Outer;
write(o.a.n);
write(o.sum());
o.a.f = new int(int x) { return x + 1; };
write(o.a.f(41));
