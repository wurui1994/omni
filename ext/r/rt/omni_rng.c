/* ext/r/rt/omni_rng.c —— 见 omni_rng.h 的账：R 的 Mersenne-Twister + R 的播种法。
 *
 * 这一份顶掉 `src/nmath/standalone/sunif.c`（那格是 Marsaglia-MultiCarry），所以
 * 它必须把那份文件对外的四个名字都给出来：`unif_rand` / `set_seed` / `get_seed` /
 * `R_unif_index` —— nmath 里那一族 `r*` 与我们的 `sample()` 都从这儿取数。
 */
#include <math.h>
#include <stdint.h>
#include "omni_rng.h"

typedef uint32_t Int32;

/* MT19937 的周期参数（Matsumoto & Nishimura 1998） */
#define MT_N 624
#define MT_M 397
#define MATRIX_A 0x9908b0dfU
#define UPPER_MASK 0x80000000U
#define LOWER_MASK 0x7fffffffU

/* R 的状态就是这 625 格：第 0 格是 mti，后面 624 格是 mt[]（`mt = dummy + 1`）。
   摆成同一条数组是 R 的做法 —— `.Random.seed` 就是照这个布局存的。 */
static Int32 dummy[MT_N + 1];
static Int32 *mt = dummy + 1;
static int mti = MT_N + 1;      /* == N+1 表示还没播种过 */

static const double i2_32m1 = 2.328306437080797e-10;   /* 1 / (2^32 - 1) */

/* R 的 `fixup`：把 0 与 1 挡掉（`unif_rand` 保证的是开区间）。 */
static double fixup(double x)
{
    if (x <= 0.0) return 0.5 * i2_32m1;
    if ((1.0 - x) <= 0.0) return 1.0 - 0.5 * i2_32m1;
    return x;
}

static void MT_sgenrand(Int32 seed)
{
    for (int i = 0; i < MT_N; i++) {
        mt[i] = seed & 0xffff0000U;
        seed = 69069U * seed + 1U;
        mt[i] |= (seed & 0xffff0000U) >> 16;
        seed = 69069U * seed + 1U;
    }
    mti = MT_N;
}

static double MT_genrand(void)
{
    Int32 y;
    static Int32 mag01[2] = { 0x0U, MATRIX_A };

    mti = (int) dummy[0];

    if (mti >= MT_N) {                 /* 一次算出一整批 N 个字 */
        int kk;
        if (mti == MT_N + 1) MT_sgenrand(4357U);   /* 没播种过时 R 用的默认种子 */

        for (kk = 0; kk < MT_N - MT_M; kk++) {
            y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
            mt[kk] = mt[kk + MT_M] ^ (y >> 1) ^ mag01[y & 0x1U];
        }
        for (; kk < MT_N - 1; kk++) {
            y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
            mt[kk] = mt[kk + (MT_M - MT_N)] ^ (y >> 1) ^ mag01[y & 0x1U];
        }
        y = (mt[MT_N - 1] & UPPER_MASK) | (mt[0] & LOWER_MASK);
        mt[MT_N - 1] = mt[MT_M - 1] ^ (y >> 1) ^ mag01[y & 0x1U];

        mti = 0;
    }

    y = mt[mti++];
    y ^= (y >> 11);
    y ^= (y << 7) & 0x9d2c5680U;
    y ^= (y << 15) & 0xefc60000U;
    y ^= (y >> 18);
    dummy[0] = (Int32) mti;

    return (double) y * 2.3283064365386963e-10;    /* [0, 1) */
}

double unif_rand(void)
{
    return fixup(MT_genrand());
}

/* R 的 `RNG_Init(MERSENNE_TWISTER, seed)`：先搅 50 遍，再用同一个 LCG 填满 625 格，
   最后把第 0 格（mti）摆成 624 —— 于是下一次取数会先重算一整批。 */
void omni_r_set_seed(int seed)
{
    Int32 s = (Int32) seed;
    for (int j = 0; j < 50; j++) s = 69069U * s + 1U;
    for (int j = 0; j < MT_N + 1; j++) {
        s = 69069U * s + 1U;
        dummy[j] = s;
    }
    dummy[0] = MT_N;      /* FixupSeeds(initial = TRUE) */
    mti = MT_N;
}

/* standalone 的 nmath 对外那两格（`Rmath.h` 里声明着）—— 摆成"两个 32 位种子"
   那个形状是那份 API 的事，这儿照 R 的播种法把它们并成一个种子用。 */
void set_seed(unsigned int i1, unsigned int i2)
{
    omni_r_set_seed((int) (i1 ^ (i2 << 16)));
}

void get_seed(unsigned int *i1, unsigned int *i2)
{
    *i1 = dummy[0];
    *i2 = dummy[1];
}

/* R >= 3.6 的 `sample()`：按位取一个随机数、超出范围就重抽（拒绝采样）。
   这一段与 `sunif.c` 里那一份逐行相同 —— 它自己也是从 `src/main/RNG.c` 抄的。 */
static double rbits(int bits)
{
    int_least64_t v = 0;
    for (int n = 0; n <= bits; n += 16) {
        int v1 = (int) floor(unif_rand() * 65536);
        v = 65536 * v + v1;
    }
    return (double) (v & ((1L << bits) - 1));
}

double R_unif_index(double dn)
{
    if (dn <= 0) return 0.0;
    int bits = (int) ceil(log2(dn));
    double dv;
    do { dv = rbits(bits); } while (dn <= dv);
    return dv;
}

double omni_r_unif_index(double dn)
{
    return R_unif_index(dn);
}
