/* 从变参里取一个 struct 还没到（`va_arg(ap, struct P)`）。
 *
 * 变参区是一格 8 字节（`vaBlock`），而 struct 要按大小占好几格、还要按自己的对齐排 ——
 * 那是 arm64 与 SysV 各有一套的规则，得连着「把 struct 传进变参」一起做。
 * tinycc 自己的源码里没有这种用法（它的变参都是 int/指针/double）。 */
int printf(const char *fmt, ...);

struct P { int a, b, c; };

static int take(int n, ...) {
  __builtin_va_list ap;
  struct P p;
  __builtin_va_start(ap, n);
  p = __builtin_va_arg(ap, struct P);
  __builtin_va_end(ap);
  return p.a;
}

int main(void) {
  return take(1, 2);
}
