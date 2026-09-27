/* 第一百五十二片：`_Complex` **当布局**收下（ADR-0047）。
 *
 * 逼出这一格的是 R 的 `R_ext/Complex.h`：
 *
 *     typedef union { struct { double r; double i; }; double _Complex private_data_c; } Rcomplex;
 *
 * 那一行从前把 R 运行时 111 份 `.c` 里的 107 份挡在门外（`identifier expected`），
 * 而它们要的只有"这个类型有多大" —— R 自己的 C 用的是 `.r` / `.i`，从不算它。
 * 所以这一格判的是**大小、对齐、别名**三件事，而不是复数算术（那是另一刀：
 * `a * b` 落在这个类型上时报的是"struct 当值用还没到"，响的，不是静默错）。
 *
 * 判据与这一组的别人一样：与 cc 编出来的**退出码逐字节相同**。 */
/* 别名：与 R 那个 union 一模一样的形状 —— 写 `.r` / `.i`，那一格只是占位 */
typedef union { struct { double r; double i; }; double _Complex z; } Rcomplex;

int main(void) {
  int s = 0;

  /* 大小与对齐：两格同类型的浮点摆在一起 */
  s += (int)sizeof(float _Complex);            /*  8 */
  s += (int)sizeof(double _Complex);           /* 16 -> 24 */
  s += (int)sizeof(long double _Complex);      /* 16（这个目标上 long double 就是 double）-> 40 */
  s += (int)__alignof__(double _Complex);      /*  8 -> 48 */
  s += (int)sizeof(double _Complex[3]);        /* 48 -> 96 */

  /* `_Complex` 单独出现 = `double _Complex`（gcc 收这一种） */
  s += (int)sizeof(_Complex);                  /* 16 -> 112 */

  Rcomplex c;
  s += (int)sizeof(c);                         /* 16 -> 128 */
  c.r = 1.5;
  c.i = -2.25;
  s += (int)(c.r * 2);                         /*  3 -> 131 */
  s += (int)(c.i * -4);                        /*  9 -> 140 */

  /* 按值拷贝（struct 的那条路）：两格都得跟着走 */
  Rcomplex d = c;
  s += (int)(d.r * 2) + (int)(d.i * -4);       /* 12 -> 152 */

  /* 指针与取址：`_Complex` 的两格就是内存里前后两个 double */
  double _Complex *p = &c.z;
  double *q = (double *)p;
  s += (int)(q[0] * 2) + (int)(q[1] * -4);     /* 12 -> 164 */

  /* 放进别的 struct 里，偏移照 8 对齐 */
  struct S { char tag; double _Complex z; } t;
  s += (int)sizeof(struct S);                  /* 24 -> 188 */
  s += (int)((char *)&t.z - (char *)&t);       /*  8 -> 196 */

  return s & 255;                              /* 196 */
}
