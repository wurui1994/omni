// ext/lua/values.js —— 值：**元数契约**。Lua 最需要"自动组合"的那一摊
//
// 四条规则（DESIGN.md 第 5 节），写下来只用一张三行的表 + 两条**普适**规则：
//
//   1. 产生多值的只有三种节点：`call` / `method-call` / `vararg`      ← 表（三行）
//   2. 表达式**列表**里，只有最后一格展开                              ← 普适：所有 `exp` 类的列表洞
//   3. `paren` 强行截成一格                                          ← 表（一行，`truncates`）
//   4. 要固定元数的洞（非列表的 `exp` 洞）一律截成一格                   ← 普适：洞的形状说的
//
// 规则 2 与 4 **一格数据都不用写**：洞是不是列表、洞的类别是什么，`syn` 里已经有了。
// 于是 `f(g(), h())`、`{g(), h()}`、`return g(), h()`、`local a,b = g()` 这些"看着不同的
// 组合"落在同一条规则上 —— 这正是"组合的结果不该手写"的意思。

import { holesOf } from './lang.js';

/** 元数表。三行说"谁产生多值"，一行说"谁把多值掐断"。 */
export const YIELDS = {
  call: 'multi',
  'method-call': 'multi',
  vararg: 'multi',
  paren: 1,          // `(f())` 只有一格 —— Lua 里唯一"括号有语义"的地方
  lambda: 1,         // gsl-shell 的 `|x| e`：它是个函数值，一格
};

/** 一个表达式节点产出几格：`'multi'` 或 `1`。 */
export function yieldsOf(node) {
  return YIELDS[node.kind] ?? 1;
}

/**
 * 一串表达式的形状：`{fixed, spread}` ——
 *   fixed  确定有几格（最后一格若是多值，它不计入 fixed）
 *   spread 最后一格是不是多值（会展开）
 */
export function listShape(items) {
  const xs = items ?? [];
  if (xs.length === 0) return { fixed: 0, spread: false };
  const last = yieldsOf(xs[xs.length - 1]);
  return { fixed: last === 'multi' ? xs.length - 1 : xs.length, spread: last === 'multi' };
}

/**
 * 走一遍，把**每一处元数调整**记下来（第三问"值有几格"要对的就是这张表）：
 *
 *   {at: 节点, hole: 洞名, kind: 'trunc' | 'spread', of: 被调整的那个节点的 kind}
 *
 * `trunc`  一个多值节点落在固定元数的洞里，被截成一格
 * `spread` 一个多值节点落在列表洞的最后一格，会展开
 *
 * 这张表是**算出来的**：谁产生多值看 YIELDS，洞是不是列表看 `syn`。两边都不是手写的清单。
 */
export function arity(ast, lang) {
  const adjust = [];
  const walk = (node) => {
    if (node === undefined || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) walk(x); return; }
    const n = lang.NODE.get(node.kind);
    if (n === undefined) return;
    for (const h of holesOf(n)) {
      const v = node[h.name];
      if (v === undefined || v === null) continue;
      if (h.list === true) {
        const xs = h.rep === true ? (v ?? []).flat() : v;
        for (const [i, x] of (xs ?? []).entries()) {
          if (typeof x !== 'object' || x === null || x.kind === undefined) continue;
          if (yieldsOf(x) !== 'multi') continue;
          const last = i === xs.length - 1;
          // 洞的类别不是 `exp` 的列表（赋值左边那串 `var`）不展开 —— 那儿没有"多值"这回事。
          const kind = last && h.cls === 'exp' ? 'spread' : 'trunc';
          adjust.push({ at: node.kind, hole: h.name, kind, of: x.kind });
        }
      } else if (h.cls === 'exp' || h.cls === 'prefixexp' || h.cls === 'var') {
        if (typeof v === 'object' && v !== null && yieldsOf(v) === 'multi') {
          adjust.push({ at: node.kind, hole: h.name, kind: 'trunc', of: v.kind });
        }
      }
      walk(v);
    }
    // `block` 的语句串（`{b:'stats'}`）不在 holesOf 里 —— 它不是"洞"，是容器。
    if (Array.isArray(node.stats)) walk(node.stats);
  };
  walk(ast.stats === undefined ? ast : ast.stats);
  return adjust;
}

/**
 * 一段源码里"某个表达式列表能看见几格"的**预测**：给 `select('#', …)` 那种探针用。
 * `fn(n)` 说一个多值节点实际产出几格（探针里我们自己造的函数，个数是已知的）。
 */
export function predict(items, fn) {
  const { fixed, spread } = listShape(items);
  if (!spread) return fixed;
  const last = items[items.length - 1];
  return fixed + fn(last);
}
