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

/* ─── 常用算术转换与"哪几个算子会溢出"（lower.js:753-775 / 14440-14459）───────────
   **回卷发生在算子那一处**，不是"落进一格"的时候 —— 尺子上一次量清楚的：
     `x / 2`（无符号）出来是 `(bin "&" (bin "/" …) (int 4294967295))`，而
     `f(x)` 里那个 `x` 一个字都不掩、`return x` 也不掩。
   先前这一层记成"落进一格才掩"（`wide`），于是 `/` 少掩一次、传参与返回多掩一次
   —— 十来格函数体全卡在这上面。三条规则各归各位：
     1. **提升**：窄于 32 位的先提到 i32（`arithType`）；
     2. **两边转到同一格**（`commonInt`）再算，转的那一步是 `intConvCode`；
     3. **`+ - * / <<` 算完就掩**（`OVERFLOWS`）；`% & | ^ >>` 与比较一个字都不发。 */

/** 整型提升：窄于 32 位的提到 i32（`arith`）。 */
export function arithType(t) {
  if (t === null || t === undefined || t.k !== 'int') return t;
  return (t.w ?? 32) < 32 ? { ...t, w: 32, u: false } : t;
}

/**
 * 两格整数一起算时结果是哪一格。jancy 取 **TypeKind 大的那个**再过一遍提升那张表
 * （`jnc_ct_UnOp_Arithmetic.h:38`），而 TypeKind 的次序正好是"先比位宽、同宽时无符号大"。
 */
export function commonInt(a, b) {
  const idx = (t) => (t.w ?? 32) * 2 + (t.u === true ? 1 : 0);
  return arithType(idx(a) >= idx(b) ? a : b);
}

/**
 * **一格整数转到另一格**（`intConv`）。四种情形只有最后一种发字：
 *   同宽同符号 → 原样；加宽到有符号 → 原样（规范形在更宽的格里是同一个数）；
 *   从无符号加宽 → 原样；**别的（变窄或换符号性）→ 掩到目标那一格**。
 */
export function intConvCode(code, from, to) {
  if (from === null || from === undefined || to === null || to === undefined) return code;
  const fw = from.w ?? 32;
  const tw = to.w ?? 32;
  if (fw === tw && (from.u === true) === (to.u === true)) return code;
  if (tw > fw && to.u !== true) return code;
  if (tw > fw && from.u === true) return code;
  return wrapTo(code, tw, to.u === true);
}

/** **会溢出的那几个**（算完就掩）。`%  & | ^ >>` 在规范形上天然还在范围里。 */
export const OVERFLOWS = new Set(['+', '-', '*', '/', '<<']);

/**
 * **两边都是整数的那一格二元**（lower.js:14440-14459）。三步：
 *   1. 结果那一格：移位**只看左边**（右边不参与常用算术转换，C 的规矩），别的取 `commonInt`；
 *   2. 两边**真的转**过去（`intConvCode`）—— 有了无符号之后"不转也对"不成立：
 *      `int i = -1; unsigned u = 1; i < u` 在 C 与 jancy 里都是**假**；
 *   3. 64 位无符号那一格换 u 版算子；`+ - * / <<` 算完掩一次，比较回 bool（不掩）。
 */
export function intBinary(op, a, b, cmp) {
  const shift = op === '<<' || op === '>>';
  const rt = shift ? arithType(a.type) : commonInt(a.type, b.type);
  const x = intConvCode(a.code, a.type, rt);
  const y = shift ? intConvCode(b.code, b.type, arithType(b.type)) : intConvCode(b.code, b.type, rt);
  const o = uOp(op, rt.w ?? 32, rt.u === true);
  const code = `(bin ${JSON.stringify(o)} ${x} ${y})`;
  if (cmp === true) return { code, type: null };
  return {
    code: OVERFLOWS.has(op) ? wrapTo(code, rt.w ?? 32, rt.u === true) : code,
    type: rt,
  };
}

/**
 * **一元算符上的整数规则**（lower.js:14505-14535）。`+` 是恒等（带提升，一个字不发）；
 * `-` 按**提升后**那一格回卷（`char c = -128; -c` 是 128，无符号上 `-x` 也是回卷出来的）；
 * `~` 借 `x ^ -1`（方言的 `un` 只有 `-` 与 `!`）—— 有符号不用掩、无符号要掩。
 * 认不出的答 null。
 */
export function intUnary(op, a) {
  const rt = arithType(a.type);
  if (op === '+') return { code: a.code, type: rt };
  if (op === '-') {
    return { code: wrapTo(`(un "-" ${a.code})`, rt.w ?? 32, rt.u === true), type: rt };
  }
  if (op === '~') {
    const code = `(bin "^" ${a.code} (int -1))`;
    return { code: rt.u === true ? wrapTo(code, rt.w ?? 32, true) : code, type: rt };
  }
  return null;
}

