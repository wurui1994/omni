/* 串起来的指定初始化器（C99 6.7.9 第 6 段允许 `.i.b = 3`）还没到：
 * 现在的 `initDesignator` 只挪**一层**的序号，串起来要让它自己下降。 */
struct in { int b, c; };
struct s { int a; struct in i; };

int main(void) {
  struct s x = { .i.b = 3 };
  return x.i.b;
}
