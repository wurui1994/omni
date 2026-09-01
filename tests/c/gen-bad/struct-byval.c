/* struct 传值还没做到（第 6 片只做了成员访问与整块赋值）。传值要 ABI 的那一套：
 * arm64 上 ≤16 字节走两个寄存器，再大就是调用方分配一块、把地址传进去。
 * 传指针（`sum(&p)`）在第 6 片就能用 —— 少的只是「按值」这一格。 */
struct Point { int x; int y; };

static int sum(struct Point p) {
  return p.x + p.y;
}

int main(void) {
  struct Point p;
  p.x = 1;
  p.y = 2;
  return sum(p);
}
