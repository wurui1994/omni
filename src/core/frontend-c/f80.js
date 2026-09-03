// src/core/frontend-c/f80.js —— x87 的 80 位扩展精度：位模式与 double 的来回
// （ADR-0017 第九刀第一百〇九片）
//
// # 为什么这一格单独一个文件
//
// `long double` 在 x86_64 上是 **x87 的 80 位**（`x86_64-gen.c:102-103`：LDOUBLE_SIZE 与
// LDOUBLE_ALIGN 都是 16 —— 十个字节的值，占十六个字节的格子，后六个字节是填充）。
// arm64-macho 与 PE 上它**就是 double**（`tcc.h:239-242` 的 `TCC_USING_DOUBLE_FOR_LDOUBLE`），
// 所以这一格只在 x86_64 那条腿上用得着。把它单独放一个文件，是因为它同时被两头要：
// 前端（静态初始化式要写出那十六个字节）与后端（x87 的加载/存储要认这个形状）。
//
// # 形状（Intel 的 extended double）
//
//   小端 10 个字节：低 8 个是**尾数**，高 2 个是 15 位指数 + 1 位符号。
//   与 IEEE double 最大的不同：**整数位是显式的** —— 规格化的数尾数最高位是 1，
//   不像 double 那样藏着。于是 1.5 的尾数是 `0xC000000000000000`，不是 `0x8000…`。
//
// 量过尺子（`x86_64-osx-tcc -c`，`long double a = 1.5L;` 的 `.data`）：
//
//   1.5L   -> 00 00 00 00 00 00 00 c0  ff 3f  (+6 字节零填充)
//   2.5L   -> 00 00 00 00 00 00 00 a0  00 40
//   -3.75L -> 00 00 00 00 00 00 00 f0  00 c0
//   0.0L   -> 十六个零
//
// # 精度：只有 double 那么多，这是**尺子自己的样子**
//
// `0.1L` 那一条量出来是 `00 d0 cc cc cc cc cc cc fb 3f` —— 尾数
// `0xCCCCCCCCCCCCD000`，低 11 位是零。也就是说**尺子写出来的也只有 53 位有效位**：
// 交叉编译的那份 tcc 跑在 arm64 上，它自己的 `long double` 就是 double，
// `1.5L` 这种字面量先落进一个 64 位的 double 才写出去。我们照抄这件事 ——
// 值从 double 来、按 80 位写出去，字节与尺子逐个相同。
// （真正的 80 位字面量解析（`strtold` 的 64 位尾数）是另一格账，那要一台自己的
// 十进制->80 位转换器；等哪天尺子换成在 x86_64 上跑的 tcc 才需要。）

/** 指数偏置：80 位是 16383，double 是 1023。 */
const BIAS80 = 16383;
const BIAS64 = 1023;

/**
 * 一个 double 的 80 位位模式。回 `{ mant, expSign }` —— 尾数（64 位）与
 * 「指数 + 符号」那两个字节，都是 BigInt。
 *
 * 四支，一支都不能少：
 *   - 零（含 -0）：指数与尾数全零，符号照留。
 *   - Inf / NaN：指数全一。**整数位照样置** —— x87 的 Inf 是 `0x8000000000000000`，
 *     QNaN 是 `0xC000000000000000`（安静位就是尾数次高位，从 double 的 frac 挪上来）。
 *   - double 的非规格化数：80 位的指数范围宽得多，所以它们在这儿是**规格化的** ——
 *     把尾数左移到最高位是 1，指数跟着减。
 *   - 规格化数：指数换偏置，尾数补上那个显式的整数位。
 */
export function f80Parts(x) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x, true);
  const bits = dv.getBigUint64(0, true);
  const sign = (bits >> 63n) & 1n;
  const exp = Number((bits >> 52n) & 0x7ffn);
  let frac = bits & 0xfffffffffffffn;

  if (exp === 0 && frac === 0n) return { mant: 0n, expSign: sign << 15n };
  if (exp === 0x7ff) {
    /* frac 非零 = NaN：把 52 位的 payload 挪到 63..12，再补整数位。
     * 于是 double 的安静位（frac 最高位）落在 80 位的次高位上 —— 与 `fld` 一致。 */
    const mant = 0x8000000000000000n | (frac << 11n);
    return { mant, expSign: (sign << 15n) | 0x7fffn };
  }
  let e80;
  if (exp === 0) {
    /* 非规格化：真实指数是 -1022，尾数 0.frac。左移到最高位为 1。 */
    let shift = 0;
    while ((frac & 0x10000000000000n) === 0n) { frac <<= 1n; shift++; }
    e80 = BIAS80 - 1022 - shift;
    frac &= 0xfffffffffffffn;
  } else {
    e80 = exp - BIAS64 + BIAS80;
  }
  const mant = 0x8000000000000000n | (frac << 11n);
  return { mant, expSign: (sign << 15n) | BigInt(e80) };
}

/**
 * 一个 double 写成 80 位的那 10 个字节（小端）。`slot` 给了就补零到那么宽 ——
 * x86_64 上格子是 16 个字节（LDOUBLE_SIZE），后 6 个字节尺子写零。
 */
export function f80Bytes(x, slot = 10) {
  const out = new Uint8Array(slot);
  const { mant, expSign } = f80Parts(x);
  for (let i = 0; i < 8; i++) out[i] = Number((mant >> BigInt(i * 8)) & 0xffn);
  out[8] = Number(expSign & 0xffn);
  out[9] = Number((expSign >> 8n) & 0xffn);
  return out;
}

/**
 * 反过来：80 位的 10 个字节读成 double。多出来的那 11 位尾数按**就近偶数**舍入
 * （硬件 `fstpl` 的默认舍入模式），溢出成 Inf、下溢按 double 的非规格化走 ——
 * 这三件事交给 `setFloat64` 之前的手工凑数太容易错，所以走一条稳的：
 * 先把 80 位的值拆成「尾数（整数）× 2^k」，再用 `Number()` 让宿主的 double
 * 舍入一次（IEEE 754 的 `BigInt -> Number` 就是就近偶数），最后乘回去。
 */
export function f80ToDouble(bytes, off = 0) {
  let mant = 0n;
  for (let i = 7; i >= 0; i--) mant = (mant << 8n) | BigInt(bytes[off + i]);
  const expSign = (BigInt(bytes[off + 9]) << 8n) | BigInt(bytes[off + 8]);
  const sign = (expSign >> 15n) & 1n ? -1 : 1;
  const e = Number(expSign & 0x7fffn);
  if (e === 0x7fff) {
    /* 整数位之外还有 payload = NaN，否则 Inf。 */
    return (mant & 0x7fffffffffffffffn) === 0n ? sign * Infinity : NaN;
  }
  if (e === 0 && mant === 0n) return sign * 0;
  /* 值 = mant × 2^(e - 16383 - 63)。`Number(mant)` 只舍入一次，再乘 2 的幂 ——
   * 2 的幂是精确的，所以总共只有那一次舍入（`2 ** k` 在 k 太小的时候会是 0，
   * 于是分两步乘，让非规格化那一路也走对）。 */
  const k = e - BIAS80 - 63;
  let v = Number(mant);
  if (k >= -1022) return sign * v * 2 ** k;
  v *= 2 ** -1022;
  return sign * v * 2 ** (k + 1022);
}
