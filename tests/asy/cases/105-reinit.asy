struct B {
  int a; int b; string tag;
  void operator init(int a, int b = a + 100, string tag = "d") { this.a = a; this.b = b; this.tag = tag; }
  void operator init(string s) { operator init(length(s)); }
  void operator init(bool q) { operator init(1, tag="q"); }
  void twice() { operator init(a * 2, b * 2, tag + "!"); }
}
B u = B("hello");
write(u.a); write(u.b); write(u.tag);
B v = B(true);
write(v.a); write(v.b); write(v.tag);
v.twice();
write(v.a); write(v.b); write(v.tag);
struct D {
  int n;
  void operator init(int k = 2 ... int[] xs) { n = k; for (int x : xs) n += x; }
  void operator init(string s) { operator init(5, 1, 2); }
}
D d = D("z");
write(d.n);
