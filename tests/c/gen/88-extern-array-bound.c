/* 第一百五十二片：**`extern T x[];` 之后在同一个单元里定义它**（ADR-0047 第十五格）。
 *
 * 这一对在真代码里就是"头里声明、`.c` 里定义"：R 的 `g_extern.h` 写
 * `extern const struct plHersheyFontInfoStruct _hershey_font_info[];`，而定义在
 * `g_fontdb.c` 里。从前我们把不带长度的 `extern` 数组按**0 个元素**登记，于是那一对
 * 变成"长度 0 与长度 N 冲突"，报 `incompatible types for redefinition`（量出来 2 份）。
 *
 * 现在"不知道长度"就是不知道（`count < 0`），长度由后面那条定义补上 —— 而那时要**重划
 * 地方**（占位块是 0 字节，不重划就与后面那个全局量叠在同一个地址上，那是静默答错）。
 * 判据照这一组的规矩：与 cc 编出来的退出码逐字节相同。 */

extern int a[];                 /* 长度不知道 */
int a[3] = { 1, 2, 3 };         /* 这儿补上 */
extern int a[];                 /* 再声明一次也行 */

extern const char msg[];
const char msg[] = "hi";

/* 定义在后头、声明在前头的那一对中间还夹着别的全局量 —— 它们不许叠在一起 */
extern double d[];
int guard1 = 0x5a;
double d[2] = { 1.5, -2.5 };
int guard2 = 0x3c;

struct S { int n; };
extern const struct S tab[];
const struct S tab[] = { { 7 }, { 9 } };

int main(void) {
  int s = 0;

  s += a[0] + a[1] + a[2];        /*  6 */
  s += (int)sizeof(a);            /* 12 -> 18 */
  s += (int)msg[0] - 'h' + 3;     /*  3 -> 21 */
  s += (int)sizeof(msg);          /*  3 -> 24 */
  s += (int)(d[0] * 2) + (int)(d[1] * -2);  /* 3 + 5 = 8 -> 32 */
  s += (int)sizeof(d);            /* 16 -> 48 */
  s += tab[0].n + tab[1].n;       /* 16 -> 64 */
  s += (int)sizeof(tab);          /*  8 -> 72 */

  /* 中间那两个全局量没被踩坏 —— 重划地方那一句漏了的话它们会被 `d` 盖掉 */
  s += guard1 == 0x5a ? 10 : 0;   /* 10 -> 82 */
  s += guard2 == 0x3c ? 20 : 0;   /* 20 -> 102 */

  return s & 255;                 /* 102 */
}
