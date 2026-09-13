// src/lang/jnc/specs.js —— 按节点表读**说明符那一串**（`specs`）：类型 + 前后两串修饰词
//
// 与 `declare.js` 同一条路子：只认洞的名字，不碰位置索引，也不碰 `lower.js` 里那段
// 带历史账的 `specs()`。新旧并跑、逐格对账（`tests/lib/jnc-specs.js`）。
//
// jancy 的说明符是"修饰词 + 类型 + 修饰词"（`.llk` 里 `type_specifier_modifier*` 那一层），
// 所以树里 `specs` 有三格洞：`type` / `pre` / `post`（形状是量出来的，见 jnc-shape）。

import { named, headOf } from './adapt.js';
import { chainOf } from './declare.js';

/** 一格修饰词记号的字面（`const`、`static`、`property`…）。 */
export function wordOf(node) {
  if (node === null || node === undefined) return null;
  if (Array.isArray(node.items)) {
    /* 有些修饰词自己是一格节点（`access` / `post-modifier`），取它里头那个记号。 */
    for (const it of node.items.slice(1)) {
      const w = wordOf(it);
      if (w !== null) return w;
    }
    return null;
  }
  return node.value === undefined ? null : String(node.value);
}

/** 一串 `mods` / `mods-add`（左递归）读成词的数组。 */
export function modWords(node) {
  return chainOf(node, 'mods-add').map(wordOf).filter((w) => w !== null);
}

/**
 * 读一个 `specs`。答 `{ type, typeHead, pre, post, words }`；读不了答 null。
 * `words` 是前后两串合起来 —— 位置矩阵关心的"这一格写了哪些词"就是它。
 */
export function readSpecs(node) {
  const nm = named(node);
  if (nm === null || nm.kind !== 'specs') return null;
  const pre = modWords(nm.pre);
  const post = modWords(nm.post);
  return {
    type: nm.type,
    typeHead: nm.type === undefined ? null : (headOf(nm.type) ?? wordOf(nm.type)),
    pre,
    post,
    words: [...pre, ...post],
    raw: node,
  };
}
