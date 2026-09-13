// src/lang/jnc/adapt.js —— 把 GLR 的树**按节点表命名**：`items[3]` 变 `.suffixes`
//
// 这是 jancy 规则化的**过桥件**（ADR-0030 第 3 节）。`frontend-jnc/lower.js` 现在到处是
// `n.items[3]` 这样的位置索引 —— 位置是隐式知识，改一条产生式就得全仓库找。有了节点表
// （形状已经对账到 0 分歧，`tests/lib/jnc-shape.js`），位置就能换成**洞的名字**：
//
//   named(tree, jncLang)  ->  { kind: 'dcl', ptrs: …, name: …, suffixes: …, ctor: … , raw }
//
// 一族一族换过去，每换一族都过现成的两把尺子（594 格位置矩阵 0 分歧、语料板 3426 对不许变差）
// —— 行为一格不动，只是把隐式的位置变成显式的名字。这样重写才不必大爆炸。

import { jncLang } from './nodes.js';

/** 树里这个节点的头名（`items[0]` 那个记号的值）。 */
export function headOf(n) {
  if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return null;
  const h = n.items[0];
  return h !== null && h !== undefined && typeof h.value === 'string' ? h.value : (n.rule ?? null);
}

/**
 * 按节点表给子项**起名字**。规矩两条：
 *   1. 必填的洞（不带 `?`）按顺序对上前几格；
 *   2. 可缺的洞（带 `?`）只在还有剩余子项时才占一格 —— 与形状尺子的区间判据同一套。
 * 表里没有这个头名时答 `null`（调用方照旧走位置索引，于是可以一族一族搬）。
 */
export function named(n, lang = jncLang) {
  const head = headOf(n);
  if (head === null) return null;
  const spec = lang.NODE.get(head);
  if (spec === undefined || spec.holes === undefined) return null;
  const names = Object.keys(spec.holes);
  const need = names.filter((k) => !String(spec.holes[k]).includes('?'));
  const kids = n.items.slice(1);
  if (kids.length < need.length || kids.length > names.length) return null;   // 形状对不上就不认
  /* 洞名不许叫 `kind` / `raw` —— 那两格是这一层自己用的（`kind` 存节点种类、`raw` 存原树）。
     撞了就当场炸：表里起错名字该在头一次跑到时就看见，不该悄悄把节点种类盖掉。 */
  for (const k of names) {
    if (k === 'kind' || k === 'raw') throw new Error(`节点 ${head} 的洞不能叫 '${k}'（这一层占着）`);
  }
  const out = { kind: head, raw: n };
  let at = 0;
  const extra = kids.length - need.length;                 // 可缺的洞里有几格真的在
  let given = 0;
  for (const k of names) {
    const optional = String(spec.holes[k]).includes('?');
    if (optional && given >= extra) { out[k] = undefined; continue; }
    if (optional) given += 1;
    out[k] = kids[at];
    at += 1;
  }
  return out;
}

/** 这一棵树里有多少节点能被命名（覆盖率 —— 搬迁的进度就看它）。 */
export function nameableRate(tree, lang = jncLang) {
  let all = 0;
  let ok = 0;
  const walk = (n) => {
    if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
    all += 1;
    if (named(n, lang) !== null) ok += 1;
    for (const it of n.items) walk(it);
  };
  walk(tree);
  return { all, ok };
}
