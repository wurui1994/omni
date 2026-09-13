// src/core/frontend-engine/casts.js —— 类型之间那点关系当**一张表**（ADR-0029 的 L4）
//
// "这一格装不装得进那一格"与"重载决议里这一条排第几"是**同一个关系的两个分辨率**：
// 前者要一个是/否，后者要一档分。先前它们是两串 `if`（`assignOk` 与 `argCost`），
// 于是两边悄悄不一样也没人看得见 —— 比如 `int8 -> int32`：`assignOk` 说不行，
// 重载决议却给 3 分（jancy 那边也正是这样：整数间的隐式转换在**调用**那一处才允许）。
// 差异本身没错，错的是它**只存在于两段控制流的差里**，读不出来、也没法与 C++ 的那张表对照。
//
// 所以摊成一张**有序**的表：每一行说"什么样的 from 到什么样的 to"，带两列结论 ——
//
//   assign   隐式装得进吗（`assignOk`）
//   cost     重载决议里的那一档（`argCost`；也可以是个按"是不是字面量"给分的函数）
//
// **第一行命中的赢**：次序就是那个偏序（更具体的排前面）。加一门语言 = 加一张表，
// 不是再写两段 `if`。

/**
 * 在表里找 `from -> to` 那一行。
 * @param rows 每行 `{ when(from, to, ctx), assign, cost, why? }`
 * @returns 命中的那一行，或 `null`（= 一行都不match，按"不行 / 0 分"办）
 */
export function castRow(rows, from, to, ctx) {
  for (const r of rows) {
    if (r.when(from, to, ctx)) return r;
  }
  return null;
}

/** 那一行的 `cost` 列：可以是个数，也可以是"按字面量给分"的函数。 */
export function costOf(row, lit) {
  if (row === null) return 0;
  return typeof row.cost === 'function' ? row.cost(lit) : row.cost;
}
