// src/core/frontend-engine/overload.js —— 一族候选里挑一条（ADR-0029 的 L4）
//
// 这个算法在 `lower.js` 里抄了四遍（调用点的同元重载、属性的多格存值器、`operator :=` 那一族、
// 宿主面同元原型）—— 四处的**打分**不一样（各自的实参与形参怎么对），可"怎么挑"是同一句话：
//
//   每个候选取各实参里**最差**的那一档当它的分；0 分 = 合不上；取最高分；并列 = 分不出来。
//
// 与 jancy 的 `FunctionTypeOverload::chooseOverload` 同一个算法
// （jnc_ct_FunctionTypeOverload.cpp:44-91）。抄四遍的坏处不是行数，是**四份会各自漂**：
// 其中一份把"并列"当成了"取第一条"，那就是悄悄猜了一条，而另三份会报"分不出来"。
//
// 所以这一份只做"怎么挑"，打分留给语言（`scoreOf`）—— C++ 的转换偏序与 jancy 的不同，
// 但"最差那一档 / 最高分 / 并列即歧义"这三条是共用的。

/** 一档也合不上就是这个分。语言那边的 `scoreOf` 回 0 表示"这一条根本合不上"。 */
export const NO_FIT = 0;

/**
 * 挑一条。
 * @param {Iterable<T>} cands 候选
 * @param {(c: T) => number} scoreOf 这一条的分（0 = 合不上）
 * @returns {{best: T|null, score: number, tie: boolean}}
 *   `best === null` = 一条都合不上；`tie === true` = 最高分并列（**别猜**，照实说分不出来）。
 */
export function pick(cands, scoreOf) {
  let best = null;
  let score = NO_FIT;
  let tie = false;
  for (const c of cands) {
    const s = scoreOf(c);
    if (s === NO_FIT) continue;
    if (s === score) tie = true;
    if (s > score) { score = s; best = c; tie = false; }
  }
  return { best, score, tie };
}

/**
 * 一条候选的分 = 各实参里**最差**的那一档（没有实参可对就是满分 `top`）。
 * `costOf(i)` 回第 i 个实参对这一条的那一档。
 */
export function worst(n, costOf, top = 5) {
  let score = top;
  for (let i = 0; i < n; i++) {
    const one = costOf(i);
    if (one < score) score = one;
  }
  return score;
}
