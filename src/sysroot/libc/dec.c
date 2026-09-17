/* dec.c — 基 10^9 的大整数（第一百四十片第十格）。
 *
 * 为什么摆成公用的一份：浮点的两头都要它，而且**要的是同一件东西**——
 *
 *   打印（`stdio.c`）：double 是 `m × 2^e`，十进制展开有限 ——
 *                      e ≥ 0 时算 `m·2^e`、e < 0 时算 `m·5^k` 再退小数点。
 *   解析（`strtox.c`）：一串十进制文字是 `N / D`（都是大整数），
 *                      要的是「离它最近的 double」—— 一次长除法就够，不用浮点。
 *
 * 基取 10^9 而不是 2^32：这样「摊成数字串」是逐节印九位，一次除法都不用，而两头都要
 * 数字串。代价是乘 2 / 除 2 得走进位（在十进制里 2 不是基的因子）—— 那两条本来就要写。
 *
 * 节数 200 × 9 = 1800 位数字。上界是量出来的：解析那一头最坏是「800 位有效数字 ×
 * 10^±350」再乘 2^1075（+324 位）—— 1474 位，留了余量。一个 `__libc_dec` 是 808 字节，
 * 都在栈上，一个 `malloc` 都不发（printf 里发 malloc 会绕回自己）。
 */
#include "libc.h"

#define DEC_BASE 1000000000u

static const unsigned int DEC_P10[9] = {
  1u, 10u, 100u, 1000u, 10000u, 100000u, 1000000u, 10000000u, 100000000u
};

void __libc_dec_set(__libc_dec *d, unsigned long long v) {
  d->n = 0;
  while (v > 0 && d->n < LIBC_DEC_LIMBS) {
    d->w[d->n++] = (unsigned int)(v % DEC_BASE);
    v /= DEC_BASE;
  }
  if (d->n == 0) { d->w[0] = 0; d->n = 1; }
}

int __libc_dec_zero(const __libc_dec *d) {
  for (int i = 0; i < d->n; i++) if (d->w[i] != 0) return 0;
  return 1;
}

/* × 一个小数（要求 `m` 乘一节还在 u64 里：m ≤ 1.8e10 都安全）。 */
void __libc_dec_mul(__libc_dec *d, unsigned int m) {
  unsigned long long carry = 0;
  for (int i = 0; i < d->n; i++) {
    unsigned long long t = (unsigned long long)d->w[i] * m + carry;
    d->w[i] = (unsigned int)(t % DEC_BASE);
    carry = t / DEC_BASE;
  }
  while (carry > 0 && d->n < LIBC_DEC_LIMBS) {
    d->w[d->n++] = (unsigned int)(carry % DEC_BASE);
    carry /= DEC_BASE;
  }
}

/* ÷ 一个小数，回余数。 */
unsigned int __libc_dec_div(__libc_dec *d, unsigned int m) {
  unsigned long long rem = 0;
  for (int i = d->n - 1; i >= 0; i--) {
    unsigned long long cur = rem * DEC_BASE + d->w[i];
    d->w[i] = (unsigned int)(cur / m);
    rem = cur % m;
  }
  while (d->n > 1 && d->w[d->n - 1] == 0) d->n--;
  return (unsigned int)rem;
}
/* += 一个小数（< 基）。解析那一头九位一节地攒数字要它。 */
void __libc_dec_add(__libc_dec *d, unsigned int v) {
  unsigned long long carry = v;
  for (int i = 0; i < d->n && carry > 0; i++) {
    unsigned long long t = (unsigned long long)d->w[i] + carry;
    d->w[i] = (unsigned int)(t % DEC_BASE);
    carry = t / DEC_BASE;
  }
  while (carry > 0 && d->n < LIBC_DEC_LIMBS) {
    d->w[d->n++] = (unsigned int)(carry % DEC_BASE);
    carry /= DEC_BASE;
  }
}

/* 抄一份（结构体赋值也行，写成函数是为了不依赖那一条）。 */
void __libc_dec_copy(__libc_dec *dst, const __libc_dec *src) {
  dst->n = src->n;
  for (int i = 0; i < src->n; i++) dst->w[i] = src->w[i];
}

/* a += b。 */
void __libc_dec_addbig(__libc_dec *a, const __libc_dec *b) {
  int n = a->n > b->n ? a->n : b->n;
  unsigned long long carry = 0;
  for (int i = 0; i < n || carry > 0; i++) {
    if (i >= LIBC_DEC_LIMBS) break;
    unsigned long long t = carry
      + (i < a->n ? (unsigned long long)a->w[i] : 0ULL)
      + (i < b->n ? (unsigned long long)b->w[i] : 0ULL);
    a->w[i] = (unsigned int)(t % DEC_BASE);
    carry = t / DEC_BASE;
    if (i >= a->n) a->n = i + 1;
  }
}

/* a 与 b 比大小：-1 / 0 / 1。 */int __libc_dec_cmp(const __libc_dec *a, const __libc_dec *b) {
  int an = a->n;
  int bn = b->n;
  while (an > 1 && a->w[an - 1] == 0) an--;
  while (bn > 1 && b->w[bn - 1] == 0) bn--;
  if (an != bn) return an < bn ? -1 : 1;
  for (int i = an - 1; i >= 0; i--) {
    if (a->w[i] != b->w[i]) return a->w[i] < b->w[i] ? -1 : 1;
  }
  return 0;
}

/* a -= b（要 a ≥ b —— 调用方先比过）。 */
void __libc_dec_sub(__libc_dec *a, const __libc_dec *b) {
  long long borrow = 0;
  for (int i = 0; i < a->n; i++) {
    long long t = (long long)a->w[i] - borrow - (i < b->n ? (long long)b->w[i] : 0);
    if (t < 0) { t += DEC_BASE; borrow = 1; } else borrow = 0;
    a->w[i] = (unsigned int)t;
  }
  while (a->n > 1 && a->w[a->n - 1] == 0) a->n--;
}

/* × 2^e、× 5^k、× 10^k。都成块吃：一节乘 2^29 或 5^12 还在 u64 里
 * （1e9 × 5.4e8 < 1.8e19），于是 2^1075 只要 37 次乘法而不是 1075 次。 */
void __libc_dec_pow2(__libc_dec *d, int e) {
  while (e >= 29) { __libc_dec_mul(d, 1u << 29); e -= 29; }
  if (e > 0) __libc_dec_mul(d, 1u << e);
}

void __libc_dec_pow5(__libc_dec *d, int k) {
  while (k >= 12) { __libc_dec_mul(d, 244140625u); k -= 12; }   /* 5^12 */
  while (k-- > 0) __libc_dec_mul(d, 5u);
}

void __libc_dec_pow10(__libc_dec *d, int k) {
  while (k >= 9) { __libc_dec_mul(d, DEC_BASE); k -= 9; }
  if (k > 0) __libc_dec_mul(d, DEC_P10[k]);
}

/* 摊成数字串（不带前导零）。回位数；`cap` 满了就截断（调用方给够）。 */
int __libc_dec_digits(const __libc_dec *d, char *out, int cap) {
  int n = d->n;
  while (n > 1 && d->w[n - 1] == 0) n--;
  int L = 0;
  char t[12];
  int tn = 0;
  unsigned int hi = d->w[n - 1];
  if (hi == 0) t[tn++] = '0';
  while (hi > 0) { t[tn++] = (char)('0' + (hi % 10)); hi /= 10; }
  while (tn > 0 && L < cap) out[L++] = t[--tn];
  for (int i = n - 2; i >= 0; i--) {
    unsigned int x = d->w[i];
    for (int p = 8; p >= 0 && L < cap; p--) out[L++] = (char)('0' + ((x / DEC_P10[p]) % 10));
  }
  return L;
}

/* `m × 2^e` 的**精确**十进制展开（打印那一头要它）。数字串不带前导零，
 * `*frac` 是小数点右边的位数。回位数。 */
int __libc_dec_of_me(unsigned long long m, int e, char *out, int cap, int *frac) {
  __libc_dec d;
  __libc_dec_set(&d, m);
  if (e >= 0) {
    __libc_dec_pow2(&d, e);
    *frac = 0;
  } else {
    /* m / 2^k = m·5^k / 10^k —— 乘 5^k，小数点往左退 k 位。 */
    *frac = -e;
    __libc_dec_pow5(&d, -e);
  }
  return __libc_dec_digits(&d, out, cap);
}
