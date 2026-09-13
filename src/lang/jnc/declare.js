// src/lang/jnc/declare.js —— 按节点表读一个**声明符**（`dcl`）：名字、指针层数、后缀链、构造实参
//
// 这一份是"新读取器"：只靠节点表 + `named()` 的洞名，不碰位置索引，也不碰
// `frontend-jnc/lower.js` 里那段带着历史账的 `declarator`。两边并跑、逐格对账
// （`tests/lib/jnc-declare.js`），对得上才谈替换 —— 这样重写不必大爆炸（ADR-0030 第 3 节）。
//
// 读出来的是**结构化**的东西，不是字符串：
//   { name, ptrs, suffixes: [{kind, node}], ctor }

import { named, headOf } from './adapt.js';

/** 左递归的列表：`X`（空基例）与 `X-add`（两格：list / one）走成一串。 */
export function chainOf(node, addHead) {
  const out = [];
  let cur = node;
  while (cur !== null && cur !== undefined) {
    const h = headOf(cur);
    if (h === addHead) {
      const nm = named(cur);
      if (nm === null) break;
      out.unshift(nm.one);                      // 左递归：后来的在右边，倒着塞
      cur = nm.list;
      continue;
    }
    break;                                       // 到了空基例（`ptrs` / `suffixes`）
  }
  return out;
}

/** 一个 `name` 节点的字面文本（`name` 裹着一格记号）。 */
export function nameText(node) {
  if (headOf(node) !== 'name') return null;
  const nm = named(node);
  const t = nm === null ? undefined : nm.text;
  return t !== null && t !== undefined && t.value !== undefined ? String(t.value) : null;
}

/**
 * 读一个 `dcl`。读不了（形状不认得）答 `null` —— 调用方照旧走老路，于是能一族一族搬。
 */
export function readDcl(node) {
  const nm = named(node);
  if (nm === null || nm.kind !== 'dcl') return null;
  return {
    name: nameText(nm.name),
    nameNode: nm.name,
    ptrs: chainOf(nm.ptrs, 'ptrs-add').length,
    suffixes: chainOf(nm.suffixes, 'suffixes-add').map((s) => ({ kind: headOf(s), node: s })),
    ctor: headOf(nm.ctor) === 'ctor',
    raw: node,
  };
}
