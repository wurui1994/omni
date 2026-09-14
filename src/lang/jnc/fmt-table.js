// src/lang/jnc/fmt-table.js —— **格式串**那一族（`printf` 与 `$"…"` 共用一张表）
//
// 从旧降级 `fmtRun`（`frontend-jnc/lower.js:11847-11930`）读出来。分出来的理由是
// **"算法只该有一处家"**：`printf("%08.3f", x)` 与 `$"%08.3f"(x)` 该长什么样必须一个字不差
// （第六十一刀那次 `q /= three` 的教训就是同一个形状 —— 两处各写一遍，其中一处写错）。
//
// 两种口径：
//   - `'stmt'`：按 `\n` 把格式串**切成若干段**，带换行的段发 `(print …)`（它自带换行），
//     末段没有换行时发 `(write …)`。`printf` 走这条，回的是**几行语句**；
//   - `'str'` ：一个都不切（换行就是串里的一个字符），整条拼成**一格字符串的代码**。
//     格式化字面量 `$"…"` 走这条 —— 它产出的是一格值（literals.rst:62），不是一次输出。

import { intConvCode } from './int-table.js';

/** 段里那几块（字符串常量与 `(tostr …)`）拼起来：**左结合**的 `(bin "+" …)`。 */
export function joinPieces(pieces) {
  if (pieces.length === 0) return null;
  let code = pieces[0];
  for (let k = 1; k < pieces.length; k += 1) code = `(bin "+" ${code} ${pieces[k]})`;
  return code;
}

/**
 * **一格转换说明**：`%` [标志] [宽度] [`.` 精度] 转换字符。
 * 五个标志都收（第二十九刀）：`-` 左对齐、`0` 补零、`+` 与空格给符号、`#` 另一种形式；
 * 宽度与精度收十进制常量，也收 `*` / `.*`（**从实参来**，第二十七刀）。
 * 读不动答 `null`（那时那个 `%` 就是字面的一个百分号）。
 */
export function readSpec(fmt, at) {
  let j = at + 1;
  const flags = {
    left: false, zero: false, plus: false, space: false, alt: false,
  };
  for (;; j += 1) {
    if (fmt[j] === '-') { flags.left = true; continue; }
    if (fmt[j] === '0') { flags.zero = true; continue; }
    if (fmt[j] === '+') { flags.plus = true; continue; }
    if (fmt[j] === ' ') { flags.space = true; continue; }
    if (fmt[j] === '#') { flags.alt = true; continue; }
    break;
  }
  let width = null;
  if (fmt[j] === '*') { width = '*'; j += 1; } else {
    let w = '';
    while (/[0-9]/.test(fmt[j] ?? '')) { w += fmt[j]; j += 1; }
    if (w !== '') width = Number(w);
  }
  let prec = null;
  if (fmt[j] === '.') {
    j += 1;
    if (fmt[j] === '*') { prec = '*'; j += 1; } else {
      let p = '';
      while (/[0-9]/.test(fmt[j] ?? '')) { p += fmt[j]; j += 1; }
      prec = p === '' ? 0 : Number(p);
    }
  }
  const conv = fmt[j];
  if (conv === undefined) return null;
  return {
    flags, width, prec, conv, end: j,
  };
}

/**
 * **一格转换说明发出来的那一块**（lower.js:11975-12080 那张表）。`v` 是 `{ code, type }`，
 * `c` 给谓词与整数转换（`isInt` / `isBool` / `isReal` / `intConv(code, from, to)`）。
 * 认不出的答 `null` —— 调用方记账。**宽度与精度那一层不在这儿**（padTo 是另一张表）。
 *
 * 几处不是"随手选的写法"：
 *   - `%c` 是一个码位 → 一个字符（`(chr E)`）；
 *   - `%d` 碰上 bool 要 `sel` 成 1 / 0，**不能** `(tostr b)`（那印 true / false）；
 *   - `%d` 碰上**无符号**那一格是"按有符号读"（第三十三刀）：`printf("%d", (unsigned)…)`
 *     在 C 里印负数，所以先转到同宽的有符号格；
 *   - `%x/%X/%o/%u` 把实参当 **unsigned** 读，位数是**默认实参提升之后**那一格 ——
 *     `printf("%x", (char)-56)` 印 `ffffffc8` 而不是 `c8`；
 *   - `%f` 是 C 的 `%.6f`（默认精度 6，第八刀）—— `(tostr …)` 是 `%.6g`，两者不一样；
 *   - `%s` 碰上**字符串本来就是一格字符串**，不套 `tostr`（第一百四十六刀那一族）。
 */
export function specPiece(spec, v, c) {
  const promo = (w) => ((w ?? 32) < 32 ? 32 : (w ?? 32));
  const t = v.type;
  const conv = spec.conv;
  if (conv === 'c') return c.isInt(t) ? `(chr ${v.code})` : null;
  if (conv === 'd' || conv === 'i') {
    if (c.isBool(t)) return `(tostr (sel ${v.code} (int 1) (int 0)))`;
    if (!c.isInt(t)) return null;
    return `(tostr ${intConvCode(v.code, t, { k: 'int', w: promo(t.w), u: false })})`;
  }
  if (conv === 'x' || conv === 'X' || conv === 'o' || conv === 'u') {
    let code = null;
    let w = 32;
    if (c.isBool(t)) code = `(sel ${v.code} (int 1) (int 0))`;
    else if (c.isInt(t)) { code = v.code; w = promo(t.w); } else return null;
    if (w < 64) code = `(bin "&" ${code} (int ${(1n << BigInt(w)) - 1n}))`;
    const base = conv === 'o' ? 8 : (conv === 'u' ? 10 : 16);
    const piece = `(sbase ${code} (int ${base}))`;
    return conv === 'X' ? `(supper ${piece})` : piece;
  }
  if (conv === 'f') return c.isReal(t) ? `(sfix ${v.code} (int 6))` : null;
  if (conv === 's') return t !== null && t !== undefined && t.k === 'string' ? v.code : `(tostr ${v.code})`;
  return null;
}

/**
 * 把一个格式串切成**要发的那几行/那一格**。`emitValue(spec, index)` 由调用方给
 * （它答 `(tostr …)` 那一段 —— 宽度与精度怎么摆是另一张表）。
 *
 * `mode === 'stmt'` 答 `{ lines }`；`mode === 'str'` 答 `{ code }`。
 * 空段又带换行时发 `(print (str ""))` —— 那正是 `printf("\n")`。
 */
export function fmtRun(fmt, mode, emitValue, pad = '') {
  const lines = [];
  let pieces = [];
  let lit = '';
  let ai = 0;
  const flushLit = () => {
    if (lit !== '') { pieces.push(`(str ${JSON.stringify(lit)})`); lit = ''; }
  };
  const flush = (nl) => {
    flushLit();
    if (pieces.length === 0) {
      if (nl) lines.push(`${pad}(print (str ""))`);
      pieces = [];
      return;
    }
    lines.push(`${pad}(${nl ? 'print' : 'write'} ${joinPieces(pieces)})`);
    pieces = [];
  };
  for (let i = 0; i < fmt.length; i += 1) {
    const c = fmt[i];
    if (c === '\n' && mode === 'stmt') { flush(true); continue; }
    if (c !== '%') { lit += c; continue; }
    if (fmt[i + 1] === '%') { lit += '%'; i += 1; continue; }
    const spec = readSpec(fmt, i);
    if (spec === null) { lit += c; continue; }
    flushLit();
    const one = emitValue(spec, ai);
    if (one === null) return null;                                   // 调用方记账
    pieces.push(one);
    ai += 1;
    i = spec.end;
  }
  if (mode === 'str') {
    flushLit();
    return { code: joinPieces(pieces) ?? '(str "")' };
  }
  flush(false);
  return { lines };
}
