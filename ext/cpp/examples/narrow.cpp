// **窄整数会回卷** + **`i++` / `++i` 当值用** —— C 的算术那一族上两个补漏。
//
// 1. 窄整数（`unsigned char` 8 位、`short` 16 位、`unsigned` 32 位…）在 C++ 里存进去要
//    **回卷**，而方言里整数只有一格宽度：从前 `unsigned char c = 200; c = c + 100;`
//    答成 300（`c++` 给 44）—— **答案静默地错**。现在类型上带一格 `bits`/`uns` 记号，
//    每次**存进去**（声明的初值、赋值、`++`/`--`、转换）都补一次回卷：无符号一次与掩码、
//    有符号再把符号位摊回来。`int` / `long` 那几格**有意不带** —— C++ 里有符号溢出是 UB，
//    没有义务把 UB 学像。
//    树上要小心：`unsigned char` 是**一格 `btype` 里两个词**（语法那条 `builtin-seq`），
//    只读第一个词的话按 32 位回卷，还是错的。
//
// 2. **形参与返回值**那两头也要回卷（`show(300)` 里那格 `unsigned char c` 是 44）。
//    落在**被调方进门第一句**（与记录的值语义同一手）—— 调用点有八九处，进门只有一处。
//    交出去那一下按**写着的**返回类型回卷（`C.retType`）；lambda 上只有写了 `-> T`
//    那一档算"写着的"，从体里推出来的那一档不回卷。
//
// 3. `i++` / `++i` **当值用**那一档（语句位置早就有了）：落公共层现成的 `block-expr`
//    （先跑几句、再交一格值）——`++i` 交的是那格量自己，`i++` 先把旧值存进一格临时量。
//
// 钉住十一件事：无符号 8 位回卷、有符号 8 位回卷成负数、16 位、32 位、转换时回卷、
// **窄形参**、**窄返回值**、**lambda 写着的窄返回类型**、**借出去的窄形参**、
// `i++` 与 `++i` 当值用。
#include <stdio.h>

void show(unsigned char c) { printf("%d\n", (int)c); }

unsigned char clamp8(int x) { return x; }

short shrink(int x) { return x; }

/* **借出去的窄形参**（`unsigned char& c`）：盒子里那格字段照旧带着位宽记号，所以回卷
   穿过盒子也成立。要当心的是 `&` 与 `*` 在树上是**同一格 `ptr`** —— 把这一格也当成
   `char*`（串）的话它会落成 `__ref_string`，方言当场报。 */
void bump8(unsigned char& c, int d) {
  c = c + d;
}

int main() {
  unsigned char a = 200;
  a = a + 100;
  printf("%d\n", (int)a);
  char b = 120;
  b = b + 10;
  printf("%d\n", (int)b);
  unsigned short c = 65000;
  c = c + 1000;
  printf("%d\n", (int)c);
  unsigned d = 4294967290;
  d = d + 10;
  printf("%d\n", (int)d);
  printf("%d\n", (int)(unsigned char)300);
  int i = 0;
  int x = i++;
  int y = ++i;
  printf("%d %d %d\n", x, y, i);
  show(300);
  printf("%d\n", (int)clamp8(300));
  printf("%d\n", (int)shrink(70000));
  auto lo = [](int v) -> unsigned char { return v; };
  printf("%d\n", (int)lo(300));
  unsigned char e = 200;
  bump8(e, 100);
  printf("%d\n", (int)e);
  return 0;
}
