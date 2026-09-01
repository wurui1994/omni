/* <float.h> —— 自带的那一份（ADR-0017 第八刀第二片）。
 *
 * 定义的**这一组**与 tcc 的 `include/float.h` 一样，一个不多一个不少：
 * `FLT_/DBL_/LDBL_` 各九条（MANT_DIG / DIG / MIN_EXP / MIN_10_EXP / MAX_EXP /
 * MAX_10_EXP / MAX / EPSILON / MIN），加 `DECIMAL_DIG` / `FLT_RADIX` / `FLT_ROUNDS`。
 * C99 还有 `FLT_EVAL_METHOD` / `*_TRUE_MIN` / `*_HAS_SUBNORM` / `*_DECIMAL_DIG` ——
 * **tcc 没有，我们也不加**：多给一条就是在「与 tcc 逐字节相同」这条轴上开个洞。
 *
 * # 这里有一处 tcc 自己的矛盾，我们照抄，并且记在这儿
 *
 * `LDBL_*` 这一段写的是 **binary128**（113 位有效位、指数到 16384）。可这个目标上
 * `long double` **就是 double**（`tcc.h:237-241` 的 `TCC_USING_DOUBLE_FOR_LDOUBLE`，
 * 见第六刀第二十片，`sizeof(long double) == 8`）。于是：
 *
 *   - `LDBL_MAX` 那个字面量溢出成 **inf**，
 *   - `LDBL_MIN` 那个字面量下溢成 **0**，
 *   - `LDBL_MANT_DIG` 说 113，而真的只有 53。
 *
 * 量过（`tcc -run`）：`113 33 -16381 16384 -4931 4932` / `DECIMAL_DIG 36` /
 * `LDBL_MAX` 印出来是 `inf`、`LDBL_MIN` 是 `0`、`LDBL_EPSILON` 是 `1.9259299443872359e-34`。
 *
 * 也就是说 tcc 的头文件与 tcc 的编译器在这一格上不一致。**oracle 是 tcc 的二进制**，
 * 所以我们跟它 —— 「我们比它对」那种例外一开，复刻就烂了。将来长出 `-std=` 的宽严档
 * 时，这是第二条要记的分歧（第一条是指定初始化器串起来之后落在哪，见第二十三片）。
 */
#ifndef _FLOAT_H
#define _FLOAT_H

#define FLT_RADIX 2
/* 四舍五入到最近、进位到偶数（FE_TONEAREST）；这个目标上是编译期常量 */
#define FLT_ROUNDS 1
/* 「最宽的浮点类型要几位十进制才能往返」—— 照 tcc，按 binary128 给（见文件头那一节） */
#define DECIMAL_DIG 36

/* ---- float（binary32） */
#define FLT_MANT_DIG 24
#define FLT_DIG 6
#define FLT_MIN_EXP (-125)
#define FLT_MIN_10_EXP (-37)
#define FLT_MAX_EXP 128
#define FLT_MAX_10_EXP 38
#define FLT_MAX 3.40282346638528859812e+38F
#define FLT_EPSILON 1.19209289550781250000e-7F
#define FLT_MIN 1.17549435082228750797e-38F

/* ---- double（binary64） */
#define DBL_MANT_DIG 53
#define DBL_DIG 15
#define DBL_MIN_EXP (-1021)
#define DBL_MIN_10_EXP (-307)
#define DBL_MAX_EXP 1024
#define DBL_MAX_10_EXP 308
#define DBL_MAX 1.79769313486231570815e+308
#define DBL_EPSILON 2.22044604925031308085e-16
#define DBL_MIN 2.22507385850720138309e-308

/* ---- long double：**照 tcc 按 binary128 给**，而这个目标上它其实是 double。
 *      MAX 会成 inf、MIN 会成 0 —— 见文件头那一节，那是量出来的，不是笔误。 */
#define LDBL_MANT_DIG 113
#define LDBL_DIG 33
#define LDBL_MIN_EXP (-16381)
#define LDBL_MIN_10_EXP (-4931)
#define LDBL_MAX_EXP 16384
#define LDBL_MAX_10_EXP 4932
#define LDBL_MAX 1.18973149535723176508575932662800702e+4932L
#define LDBL_EPSILON 1.92592994438723585305597794258492732e-34L
#define LDBL_MIN 3.36210314311209350626267781732175260e-4932L

#endif /* _FLOAT_H */
