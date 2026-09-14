// src/lang/jnc/int-table.js —— **整数那一族**：回卷与无符号算子
//
// 从旧降级 `wrapTo` / `wrapVal` / `realOf`（`frontend-jnc/lower.js:780-811`）读出来。
// 这一族是"每次算术之后要不要掩回去"那件事 —— 尺子上量出来 46 格函数体全卡在它上面
// （`(ret (bin "+" (var x) (var y)))` 对 `(ret (bin "-" (bin "^" (bin "&" … ) …) …))`）。
//
// 方言只有**一格** int（就是 64 位那一格），所以 jancy 的四种位宽靠"算完回卷"来体现：
//   - **有符号**：`(x & M) ^ S - S` —— 掩到 w 位，再把最高位当符号位摊开；
//   - **无符号**：只有掩那一步（第三十三刀记下的"回卷变成 `x & M`，不摊符号位"）；
//   - **64 位**：一个字都不发。有符号那一格就是方言的 int 本身；**无符号**也是那一格 ——
//     位一模一样，只是**读法**不同（第六十一刀），读法由算子承担（`u/` `u%` `u>>` 与四个
//     无符号比较，见 `U_OPS`）。
//
// 两条腿上都成立：JS 那侧 int 是 BigInt（`-1n & 255n === 255n`），C 那侧是补码的 `int64_t`
// （`(-1LL) & 255 == 255`）—— 同一串算符给同一个数。

/** 回卷到 w 位（`u` 是无符号）。64 位及以上原样答回。 */
export function wrapTo(code, w, u = false) {
  if (w >= 64) return code;
  const s = 1n << BigInt(w - 1);
  const m = s * 2n - 1n;
  if (u === true) return `(bin "&" ${code} (int ${m}))`;
  return `(bin "-" (bin "^" (bin "&" ${code} (int ${m})) (int ${s})) (int ${s}))`;
}

/**
 * **编译期的回卷**（第三十九刀）：拿一个 BigInt 落到某一格整数的规范形里 —— 与 `wrapTo`
 * 是同一条算法，只是那个发代码、这个当场算（枚举成员的值在编译期就定下来了）。
 */
export function wrapVal(v, w, u = false) {
  if (w >= 64) return BigInt.asIntN(64, v);
  return u === true ? BigInt.asUintN(w, v) : BigInt.asIntN(w, v);
}

/**
 * **无符号那一格挑 u 版算子**（第六十一刀）：64 位上"位一样、读法不同"，所以差别全落在算子上。
 * 窄的那几格里存的值本来就是规范形（非负），所以不用换。
 */
export const U_OPS = new Map([
  ['/', 'u/'], ['%', 'u%'], ['>>', 'u>>'],
  ['<', 'u<'], ['<=', 'u<='], ['>', 'u>'], ['>=', 'u>='],
]);

/** 这一格算子在无符号（且 64 位）上要不要换成 u 版。 */
export function uOp(op, w, u) {
  if (u !== true || w < 64) return op;
  return U_OPS.get(op) ?? op;
}

/**
 * 整数 → 实数（`toreal`）。**64 位无符号**要走 `torealu`：那一格的位当有符号读是负数，
 * 直接 `toreal` 会给错答案。窄的那几格不用 —— 它们的规范形已经是非负数了。
 */
export function realOf(code, w, u) {
  return `(${u === true && w >= 64 ? 'torealu' : 'toreal'} ${code})`;
}
