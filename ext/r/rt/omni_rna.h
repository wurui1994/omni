/* ext/r/rt/omni_rna.h —— R 的三格"非数"：`NA` / `NaN` / `Inf`（**这一份是我们自己的代码**）
 *
 * 为什么要自己写这几格，而不是从 R 那边拿：
 *
 *   `NA_real_` 的位模式在 `src/main/arithmetic.c` 里（`R_NaReal` 那格初始化），也就是
 *   **解释器那半边** —— standalone 的 nmath 里没有它（`nm -gU libomniRmath` 里只有
 *   `R_PosInf` / `R_NegInf` / `R_finite`）。所以这一格只能按 R 公开的表示自己实现：
 *   *R Internals* §1.3 写着 NA 是一个 NaN，低 32 位是 **1954**（R 的诞生年）。
 *   照那句话写出来的东西与 R 的位模式一样，但它是我们的实现，不是它的代码。
 *
 * 由此来的两条规矩（与 R 的文档一致）：
 *   * `is.na(x)` 对 `NA` **与** `NaN` 都真（R 的 `is.na(NaN)` 是 TRUE）——所以它就是 isnan；
 *   * `is.nan(x)` 只对"不带 1954 那格载荷的 NaN"真 —— 分开它们要看载荷。
 *
 * `Inf` / `-Inf` / `NaN` 本身不是 R 特有的东西（IEEE 754 就有），所以这几格直接算，
 * 不去找 R 要。
 */
#ifndef OMNI_RNA_H
#define OMNI_RNA_H

/** R 的 `NA_real_`：一个 NaN，低 32 位是 1954。 */
double omni_r_na(void);
/** R 的 `NaN`（就是 IEEE 的静默 NaN）。 */
double omni_r_nan(void);
/** `Inf` 与 `-Inf`。 */
double omni_r_posinf(void);
double omni_r_neginf(void);

/** `is.na(x)`：`NA` 与 `NaN` 都算（照 R 的文档）。 */
int omni_r_is_na(double x);
/** `is.nan(x)`：只有**不带 1954 载荷**的 NaN 算。 */
int omni_r_is_nan(double x);
/** `is.infinite(x)`。（`is.finite` 用 R 自己的 `R_finite`。） */
int omni_r_is_infinite(double x);

#endif /* OMNI_RNA_H */

/* ---- 按**指针**进出的那一套 --------------------------------------------------
 *
 * 为什么要它：`NA` 是"带 1954 载荷的 NaN"，而那个载荷**按值过 N-API 会被 V8 规范化掉**
 * （`napi_create_double` 那一步；量过：C 里 is_nan=0，过一趟 FFI 之后变 1）。
 * 按指针走就不经过那一步 —— 值留在线性内存里，两边都按位读写，载荷分毫不动。
 */

/** 往 `p[0]` 写一格 `NA_real_`。 */
void omni_r_na_into(double *p);
/** `is.na(p[0])` / `is.nan(p[0])`：按位读，不经过装箱。 */
int omni_r_is_na_p(const double *p);
int omni_r_is_nan_p(const double *p);

/* ---- 串 → 数（`as.numeric("3.5")`）-------------------------------------------
 *
 * R 的 `as.numeric` 走它自己的 `R_strtod5`（`src/main/util.c`）：**按位累加再乘/除
 * 10 的幂**（long double 累加），**不是正确舍入**。所以"照 C 的 `strtod` 办"与 R 在
 * 一部分输入上差最后一位 —— 量出来的（2026-09-26，每档随机输入，指数 10^±12 之内）：
 *
 *   有效数字 <= 11 位：R 与正确舍入**一个 bit 都不差**（1..11 位各 4000 个，全中）
 *   12 位起分叉：12 位 106/4000、13 位 98、14 位 184、15 位 232、16 位 366、17 位 1265
 *   （另一条量法：两万个随机 double 走 `as.numeric(sprintf("%.17g", x))`，4347 个回不去）
 *
 * 于是这一档的规矩是"**只在答得准的那一段答**"：<= 11 位走 `strtod`（正确舍入，
 * 与 R 逐 bit 相同），超过 11 位在运行期**停下来**（那是"报得晚"，不是静默差最后一位）。
 * 数位由 `omni_r_numdigits` 数，值由 `omni_r_str2d` 取 —— 两个都是纯函数，
 * 所以 JS 那条腿与 C 那条腿调的是同一份代码、答案同源。
 */

/**
 * 有效数字有几位。**回 -1 表示"这不是一个数"**（R 那边出 `NA` 并警告）：
 * 后面还挂着别的字（`"3.5abc"`）、一个数字都没有、`e` 后面没数字都算。
 * 前导零不算有效数字（`"0.00123"` 是 3 位）。十六进制（`"0x10"`，R 认）**当 -2**：
 * 那一档 R 走的是另一条路（按 16 累加），这儿没接。
 */
int omni_r_numdigits(const char *s);

/** 按 C 的 `strtod` 取值（正确舍入）。调用方负责先问一遍 `omni_r_numdigits`。 */
double omni_r_str2d(const char *s);
