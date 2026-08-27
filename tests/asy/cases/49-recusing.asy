// struct 体里的 `using`：别名只在体里可见，而且同名的字段可以并存 ——
// asy 的类型名与变量名是两个名字空间（plain_filldraw.asy:93 的 filltype 就这么写的）。
struct Box {
  using myint=int;
  myint n;
  using pt=pair;
  pt p;

  myint twice() { myint m = n*2; return m; }
  pt shift(pt d) { return p+d; }
}

Box b;
b.n = 21;
b.p = (1,2);
write(b.twice());
write(b.shift((10,20)));

// 体外同名的别名互不干扰：这个 myint 是 real 的别名，struct 里那个还是 int
typedef real myint;
myint r = 2.5;
write(r);

// 两个 struct 各自的别名互不干扰
struct Other {
  using myint=string;
  myint s;
}
Other o;
o.s = "ok";
write(o.s);
