/* 把 struct 按值传进变参的可变部分还没到（`printf("%d", s)` 那种拼法也在这一格）。
 *
 * 与 `vararg-struct` 是同一件事的另一半：变参区一格 8 字节，struct 要按大小占好几格。
 * 固定形参上的 struct 传值早就通了（第十一片），只有 `...` 后面这一段没到。 */
int printf(const char *fmt, ...);

struct P { int a, b, c; };

static int take(int n, ...) { return n; }

int main(void) {
  struct P p;
  p.a = 1; p.b = 2; p.c = 3;
  return take(1, p);
}
