/* 边界：**外部**函数按值收 struct。
 *
 * 第十一片把自家函数之间的 struct 传值做通了（`gen/12-struct-abi.c`），办法是「传地址、
 * 被调方拷」。可这个约定只在自家人之间成立：桩要把实参原样转给宿主，而我们的 struct
 * 是自家线性内存里的一个偏移，宿主读不到 —— 与第五片「转手宿主 libc 不成立」同一个理由。
 * 要做得等真的后端（arm64/x64 的调用约定）落地。 */
struct Point { int x; int y; };

int elsewhere(struct Point p);

int main(void) {
  struct Point p;
  p.x = 1;
  p.y = 2;
  return elsewhere(p);
}
