// 格式串：**几格转换挤一行**（走公共层那一份 —— 与 jancy 的 `printf` 同一张转换表）。
//
// 从前这一门只接"一格转换 + 末尾换行"，所以 `printf("a=%d b=%d\n", a, b)` 当场报。
// 现在格式那一层交给 `src/core/lower/fmt.js` 的 `fmtToIR`：切成字面量与转换，
// 每格转换落成一格现成的串内建（`tostr` / `sfix` / `ssci` / `sbase`），再用 `+` 串起来。
//
// 钉住七件事：两格转换、浮点的三种写法（`%.2f` / `%.3e` / `%g`）、`%s` 与 `%%`、
// 十六进制与八进制、纯文本一格转换都没有、转换挨着排（`%d%d%d`）、以及转换后面还有文字。
#include <stdio.h>

int main() {
  int a = 1;
  int b = 22;
  printf("a=%d b=%d\n", a, b);
  double x = 3.14159;
  printf("%.2f | %.3e | %g\n", x, x, x);
  printf("%s=%d%%\n", "pct", 100);
  printf("hex %x oct %o\n", 255, 8);
  printf("no args\n");
  printf("%d%d%d\n", 1, 2, 3);
  printf("%d then text\n", 5);
  return 0;
}
