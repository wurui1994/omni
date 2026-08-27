// 第四十刀：**struct 体里的算符重载**。plain_bounds.asy:111 的
// `private static pathpen operator *(transform t, pathpen pp)` 是墙上的最后一块砖之一。
//
// 量过（真 asy）：
//   - 体里认（下面 `2 * a` 与 `a + 4` 都走到它），**体外不认** ——
//     `V d = 3 * c;` 报 "no matching function 'operator *(int, V)'" 并退 1
//     （所以体外那一条进了 strict/struct-op-outside）；
//   - `static` 与不带 `static` 的都认；
//   - 不带 static 的那份体里还**读得着实例字段**（量过印 16）—— 那是绑住接收者，
//     还在门外（我们那句是 ASY_NOPE，见 bad/struct-op-inst-field）。
//
// 降法：候选按**算符那个名字**存（于是一元/二元那条解析路一字不改），函数没有接收者，
// 可见性另加一条"只在这个 struct 的体里、并且按成员顺序裁"。
struct V { int n = 3; }

struct S {
  static V operator *(int k, V v) { V r = new V; r.n = k * v.n; return r; }
  int operator +(V v, int k) { return v.n + k; }

  V a = new V;

  int use() { V b = 2 * a; return b.n; }
  int plus() { return a + 4; }
}

S s = new S;
write(s.use());
write(s.plus());
