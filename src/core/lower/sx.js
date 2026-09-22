// src/core/lower/sx.js —— **公共降级器的算子契约**（ADR-0044，搬自 src/lang/common/sx.js）
//
// ADR-0031 轴 A。先前每门语言都在**拼字符串**：`(pfield ${base} ${name})`、`(expr ${v})`、
// `(call ${f}${args.map((x) => ' ' + x).join('')})`。后果不是"不好看"，是**错得很晚**：
// 少一个括号、忘了裹 `(expr …)`、`(pfield)` 与 `(pload (pfield))` 混了 —— 这些要等跑起来
// 印错数才看见（这一轮量出来的真错里有三处正是它）。
//
// 所以这一份把方言的形状**说一次**：一张表（名字 → 元数），加一格构造器。规矩三条：
//   1. 元数当场校验（`(sel c a b)` 少一格立刻炸，不发一段坏文本出去）；
//   2. 每一格操作数必须是**已经建好的一段代码**（非空字符串）—— 传 undefined 立刻炸；
//   3. 这一层**只管形状，不管语义**：类型对不对是各语言自己的表的事（`int-table.js` 那些）。
//
// 这不是最终形态。最终形态是"前端不发文本、发一棵 IR"（ADR-0031 轴 C 长完之后）；
// 在那之前，先把"这一层怎么说话"收成一处 —— 191 处裸模板收成一张表。

/**
 * 方言那几格的**元数**。`n` 是定数；`[min, max]` 是区间（`max` 为 `Infinity` 就是变长）。
 * 名字与形状的出处是核心那一侧的读法（`src/core/sexpr/lower.js`）与六条腿的真输出。
 */
export const SX_ARITY = {
  /* 值 */
  int: 1, real: 1, bool: 1, str: 1, var: 1, chr: 1,
  null: 1, pnull: 1, fnref: 1,
  /* 内存 */
  pnew: 2, pload: 1, pstore: 2, pfield: 2, padd: 2, psub: 2, pelem: 1,
  peq: 2, pisnull: 1, pthin: 1,
  /* 算子 */
  bin: 3, un: 2, sel: 3,
  /* 调用 */
  call: [1, Infinity], callfn: [1, Infinity], ccall: [1, Infinity],
  /* 语句 */
  set: 2, expr: 1, ret: [0, 1], let: 3, if: [2, 3], while: 2, do: [0, Infinity],
  brk: [0, 1], cont: [0, 1], print: 1, write: 1,
  /* 字符串那一族 */
  tostr: 1, slen: 1, sfind: 2, ssub: 3, srep: 2, supper: 1,
  sfix: 2, ssci: 2, sgen: 2, sgenk: 2, sbase: 2,
  /* 整数与实数之间（**无符号 64 位要走 `torealu`**：那一格的位当有符号读是负数） */
  toreal: 1, torealu: 1, toint: 1,
  /* 截到 N 位（ADR-0031 §8.2）：`(trunc N E)` = asUintN、`(sext N E)` = asIntN、
     `(zext N E)` 与 trunc 同值（分开写只为让读的人看出意图）。N 是 1..64 的字面量。 */
  trunc: 2, sext: 2, zext: 2,
  /* 类型 */
  ptr: 1, tptr: 1, blk: 2, arr: 1, fnty: 2,
};

/** 一格算子发出来的文字。元数不对、操作数不是一段代码，**当场炸** —— 那是这一层的全部价值。 */
export function op(name, ...args) {
  const a = SX_ARITY[name];
  if (a === undefined) throw new Error(`方言里没有这一格算子：'${name}'（要先在 SX_ARITY 里写下它）`);
  const [lo, hi] = Array.isArray(a) ? a : [a, a];
  if (args.length < lo || args.length > hi) {
    throw new Error(`'${name}' 要 ${lo === hi ? lo : `${lo}~${hi === Infinity ? '任意' : hi}`} 格操作数，给了 ${args.length}`);
  }
  for (const [i, x] of args.entries()) {
    if (typeof x !== 'string' || x === '') {
      throw new Error(`'${name}' 的第 ${i + 1} 格操作数不是一段代码：${String(x)}`);
    }
  }
  return args.length === 0 ? `(${name})` : `(${name} ${args.join(' ')})`;
}

/* ─── 值 ────────────────────────────────────────────────────────────────── */
/** 整数字面量。**收 BigInt**（`intLitKind` 那一层就是 BigInt —— 双精度会少最后几位）。 */
export const int = (v) => op('int', String(v));
export const real = (v) => op('real', String(v));
export const bool = (v) => op('bool', v === true || v === 'true' ? 'true' : 'false');
/** 字符串字面量：**收正文**，这一层负责编码（记号的 `value` 是解好转义的正文）。 */
export const str = (s) => op('str', JSON.stringify(String(s)));
export const varOf = (name) => op('var', String(name));
export const chr = (v) => op('chr', v);

/* ─── 内存（第九 / 十二 / 二十四刀那一摊） ─────────────────────────────── */
export const pnew = (ty, count) => op('pnew', ty, count);
export const pload = (p) => op('pload', p);
export const pstore = (p, v) => op('pstore', p, v);
export const pfield = (base, name) => op('pfield', base, String(name));
export const padd = (p, i) => op('padd', p, i);
export const pelem = (a) => op('pelem', a);
export const pnull = (ty) => op('pnull', ty);
export const nullFn = (ty) => op('null', ty);

/* ─── 算子 ──────────────────────────────────────────────────────────────── */
/** 二元：算子名要**带引号**发出去（方言那一侧收的是一格字符串）。 */
export const bin = (o, a, b) => op('bin', JSON.stringify(String(o)), a, b);
export const un = (o, a) => op('un', JSON.stringify(String(o)), a);
export const sel = (c, a, b) => op('sel', c, a, b);

/* ─── 调用 ──────────────────────────────────────────────────────────────── */
export const call = (name, args = []) => op('call', String(name), ...args);
export const callfn = (v, args = []) => op('callfn', v, ...args);
export const fnref = (name) => op('fnref', String(name));

/* ─── 语句 ──────────────────────────────────────────────────────────────── */
export const set = (name, v) => op('set', String(name), v);
export const exprStmt = (v) => op('expr', v);
export const ret = (v = null) => (v === null ? op('ret') : op('ret', v));

/* ─── 字符串那一族（格式化用它们拼） ──────────────────────────────────── */
export const tostr = (v) => op('tostr', v);
export const slen = (v) => op('slen', v);
export const sfind = (v, x) => op('sfind', v, x);
export const ssub = (v, a, b) => op('ssub', v, a, b);
export const srep = (v, n) => op('srep', v, n);
export const supper = (v) => op('supper', v);
export const sfix = (v, n) => op('sfix', v, n);
export const ssci = (v, n) => op('ssci', v, n);
export const sgen = (v, n, keep = false) => op(keep ? 'sgenk' : 'sgen', v, n);
export const sbase = (v, n) => op('sbase', v, n);

/* ─── 类型 ──────────────────────────────────────────────────────────────── */
export const ptr = (t) => op('ptr', t);
export const blk = (t, n) => op('blk', t, String(n));
