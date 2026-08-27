// 没有初值的**函数值变量**（第三十六刀）：它的零值是空引用。
//
// 这一条原先是一条 nope，理由写的是"那个空函数值的字面量方言里还没有" ——
// 第三十三刀补上 `(null TYPE)` 之后那个理由就不成立了，所以这一刀只是把它发出来。
//
// 量出来的四条（`asy -noV`）：`F f;` 之后 `f == null` 是 true、`f != null` 是 false；
// 赋一个闭包之后反过来；赋一个普通函数的名字也一样。

typedef int F(int);

void go() {
  F f;
  write(f == null);
  write(f != null);
  f = new int(int x){return x * 2;};
  write(f == null);
  write(f(4));
  // 赋回 null：函数值也能被清掉
  f = null;
  write(f == null);
}
go();

// 普通函数的名字赋进去
int thrice(int x) {return x * 3;}
void go2() {
  F g;
  write(g == null);
  g = thrice;
  write(g == null);
  write(g(4));
}
go2();

// 文件级也一样（它落在入口里，与 `real f(real) = twice;` 那个拼法同一档）
F h;
write(h == null);
h = thrice;
write(h(5));

// 多个声明项混在一句里：有初值的和没初值的
void go3() {
  F a = thrice, b;
  write(a(2));
  write(b == null);
}
go3();

// struct 的字段本来就是空引用（这一条是对照，不是新的）
struct Holder { F fn; int n; }
Holder q = new Holder;
write(q.fn == null);
