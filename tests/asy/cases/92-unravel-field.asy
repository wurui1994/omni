// 第五十八刀：`from 字段 unravel 名字;` —— 把一个 struct 字段上的成员借到外层 struct 上。
// plain_picture.asy:556 的 `from bounds unravel addPath;`（那边的注释说理由是省一次函数调用）
// 与 collections/map.asy:198 的 `from map unravel *;` 就是这两种形状。

struct inner {
  string log = "";
  // 借来的名字这一边是**重载**的：两条有体的方法加一条无体声明（后者其实是函数类型的字段）
  void note(int k) { log += "i" + string(k) + ";"; }
  void note(string s) { log += "s" + s + ";"; }
  void note(int k, string s);
  int k = 4;
  int get() { return k; }
}

struct outer {
  inner in;
  from in unravel note;
}

outer o;
o.note(1);
o.note("a");
// 无体声明那一格：先塞一个函数值进去，再通过借来的名字调
o.in.note = new void(int k, string s) { o.in.log += "p" + string(k) + s + ";"; };
o.note(2, "b");
write(o.in.log);

// 通配的那一种：借全部
struct wrap {
  inner in;
  from in unravel *;
}
wrap w;
w.note("z");
write(w.get());
write(w.in.log);
