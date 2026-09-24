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
