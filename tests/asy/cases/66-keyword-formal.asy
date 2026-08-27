// `T keyword x`（第三十四刀）：这个槽**只能按名字给**。量出来的三条都在这里 ——
// 默认值照旧每次调用求一次、给名字可以乱序、keyword 那一段只能在尾巴上
// （普通形参排在它后面 asy 那边直接是语法错，见 strict/kw-normal-after）。
// 最后一族是 collections/map.asy:104 的形状：keyword 的槽自己是**函数类型**、默认值是 null。
void q(int x, int keyword a = 7, int keyword b = 9) { write(x + a + b); }
q(1);
q(1, b = 2);
q(1, b = 2, a = 3);

int apply(int v, int keyword f(int) = null) {
  if (f == null) return v;
  return f(v);
}
write(apply(4));
write(apply(4, f = new int(int t) { return t * 10; }));
