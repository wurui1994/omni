// src/core/lower/cfam.js —— **C 家族共用的那几格**（C / C++ / jancy / go 那一族）
//
// 这一份里**没有一条是某一门语言自己的规矩**。挑进来的判据只有一条：
// **两门以上在做同一件事，而且做法一字不差**。现在三格：
//
//   1. `C_INT_BITS` —— 定宽整数的位宽表（`int8_t` / `short` / `long` …）。
//      jancy 与 C++ 各有一份同样的表；位宽只在两处要用：位域怎么挤成一格、截断规则。
//   2. `foldIntConst` —— **无类型整数常量按任意精度折**。这一条是**答案的对错**，
//      不是好看：`1 << 63` 在 real 上是 9223372036854775808.0、在 int 上才是最小的 int64。
//      折错的症状是一格静默的错答案（go 的 `math/rand` 里 `Float64()` 全变负数，量出来的）。
//   3. `fitInt` —— 装得进双精度就用 number，否则留 BigInt（`.sx` 的 `(int …)` 两种都写得出）。
//
// 整型提升 / 常用算术转换 / "算完就掩" / 无符号换读法那四条在旁边的 `int.js` 里
// （那一份搬过来得更早）。这两份将来会并成一份 —— 等方言长出带宽度的整数（ADR-0031 §8.1）。

/**
 * 定宽整数的位宽。**jancy 与 C++ 那两张表的交集加各自的别名**：
 * 出处是 jancy 的 `setupStdTypedef`（`jnc_ct_TypeMgr.cpp:1759-1782`）与 C 的 `<stdint.h>`。
 *
 * 方言里它们一律是 `int`（64 位有符号），位宽只在"回卷"与"位域"两处要用。
 * `long` 这一格是 **64**：两门语言的目标都是 LP64（jancy 固定 64、我们这条腿也只有 64 位目标）。
 */
export const C_INT_BITS = {
  /* C / C++ / jancy 的关键字 */
  char: 8, short: 16, int: 32, long: 64, intptr: 64,
  /* `<stdint.h>` 那一族（两门语言写法相同） */
  int8_t: 8, uint8_t: 8, int16_t: 16, uint16_t: 16,
  int32_t: 32, uint32_t: 32, int64_t: 64, uint64_t: 64,
  intptr_t: 64, uintptr_t: 64, size_t: 64, ptrdiff_t: 64,
  /* jancy 自己那几个别名（`utf8_t` / `dword_t` …） */
  utf8_t: 8, uchar_t: 8, byte_t: 8,
  utf16_t: 16, ushort_t: 16, word_t: 16,
  utf32_t: 32, dword_t: 32, uint_t: 32,
  ulong_t: 64, qword_t: 64,
};

/** 双精度装得下的整数范围（`Number.MAX_SAFE_INTEGER`）。 */
const SAFE = 9007199254740991n;

/** 装得进双精度就用 number（`.sx` 里两种都写得出来，number 那一档好读）。 */
export const fitInt = (v) => ((v >= -SAFE && v <= SAFE) ? Number(v) : v);

/**
 * 两格**整数常量**按任意精度折。回 null = 折不了（不是两格常量、或者不是算术算子）。
 *
 * 折出来那一格同时记两个值：
 *   * `value` 是**截到 int64** 的 —— 整数上下文用它（go 的 `var x int64 = 1<<63` 是最小的 int64）；
 *   * `exact` 是**没截过**的 —— 落到 real 上时用它（`float64(x) / (1 << 63)` 的符号靠这一格）。
 * 没溢出的时候只有 `value`（那两格相等，不必记两份）。
 *
 * 收的与回的都是标准 IR 的 `{ kind: 'int', value }`（`value` 是 number 或 BigInt）。
 */
export function foldIntConst(op, a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (a.kind !== 'int' || b.kind !== 'int') return null;
  const x = BigInt(a.exact ?? a.value);
  const y = BigInt(b.exact ?? b.value);
  let v;
  switch (op) {
    case '+': v = x + y; break;
    case '-': v = x - y; break;
    case '*': v = x * y; break;
    /* 除以零不折：那是运行期的事（各门语言对它的说法不一样，这一层不替谁决定）。 */
    case '/': if (y === 0n) return null; v = x / y; break;
    case '%': if (y === 0n) return null; v = x % y; break;
    /* 移位的位数荒唐就不折（`1 << 1e9` 会当场把内存吃光）。 */
    case '<<': if (y < 0n || y > 512n) return null; v = x << y; break;
    case '>>': if (y < 0n || y > 512n) return null; v = x >> y; break;
    case '&': v = x & y; break;
    case '|': v = x | y; break;
    case '^': v = x ^ y; break;
    default: return null;
  }
  const wrapped = BigInt.asIntN(64, v);
  const one = { kind: 'int', value: fitInt(wrapped) };
  if (wrapped !== v) one.exact = v;
  return one;
}

/**
 * 一格整数字面量的正文 → 标准 IR 的 `{ kind: 'int', value }`。
 *
 * **大整数不许过双精度**：`6364136223846793005` 经 `Number` 之后少最后三位 ——
 * 那是一格静默的错答案（go 那个 PRNG 的乘数量出来的）。下划线分隔（`1_000`）、
 * 十六 / 八 / 二进制前缀、C 风格的前导零八进制四种写法都认。
 */
export function intLit(raw) {
  const t = String(raw).replace(/_/g, '');
  const b = /^[+-]?0[0-7]+$/.test(t)
    ? BigInt(`${t.startsWith('-') ? '-' : ''}0o${t.replace(/^[+-]?0/, '')}`)
    : BigInt(t);
  return { kind: 'int', value: fitInt(b) };
}
