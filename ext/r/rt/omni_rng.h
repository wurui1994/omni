/* ext/r/rt/omni_rng.h —— R 的随机数发生器：Mersenne-Twister + R 的播种法
 * （**这一份是我们自己的代码**，照 R 公开的算法写）
 *
 * 为什么不用 standalone 那一份：`src/nmath/standalone/sunif.c` 给的是
 * **Marsaglia-MultiCarry**，而 R 自己默认是 **Mersenne-Twister**（`RNGkind()` 的第一项），
 * 而且播种法也不同。于是 `set.seed(42); runif(1)` 两边的数根本不是一条流 ——
 * 那种"看着像随机、每个数都不一样"是最难发现的错，所以这一格必须换成 R 的那一条。
 *
 * 算法来源（都是 R 公开在 `src/main/RNG.c` 里的，不是猜的）：
 *   * 播种：`RNG_Init` —— 先把种子过 50 遍 LCG（`69069 * s + 1`）"搅一搅"，
 *     再用同一个 LCG 填满 625 格状态（第 0 格是 `mti`，R 的注释写着"为了历史一致性"
 *     也一起填），最后 `FixupSeeds` 把第 0 格摆成 624（下一次取数就重算一整批）。
 *   * 取数：`MT_genrand`（Matsumoto & Nishimura 1998 的 MT19937，带 tempering），
 *     回 `y / 2^32`，再过一层 `fixup` 把 0 与 1 挡掉（R 的 `unif_rand` 保证开区间）。
 *   * `R_unif_index`：R ≥ 3.6 的 `sample()` 用的**拒绝采样**（按位取、超了就重抽），
 *     这一段 `sunif.c` 自己就是从 `RNG.c` 抄过去的。
 *
 * 换掉 `sunif.c` 之后，nmath 里那一族 `r*`（`rnorm` / `rexp` / `rbinom` / `rpois` …）
 * 都是**R 自己的代码**在**R 自己的流**上跑 —— 于是它们的数与 R 逐位相同。
 * `norm_rand` 的算法由 nmath 的 `snorm.c` 决定，那格默认是 `INVERSION`，与 R 一致。
 */
#ifndef OMNI_RNG_H
#define OMNI_RNG_H

/** `set.seed(n)`：照 R 的 `RNG_Init` 播种（Mersenne-Twister）。 */
void omni_r_set_seed(int seed);
/** `sample()` 那一格：`[0, dn)` 上的均匀整数（拒绝采样，R >= 3.6 的口径）。 */
double omni_r_unif_index(double dn);

#endif /* OMNI_RNG_H */
