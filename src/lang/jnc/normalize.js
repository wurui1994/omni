// src/lang/jnc/normalize.js —— 把 GLR 的树**按节点表规整**成引擎那一族驱动器认的形状
//
// `adapt.js` 的 `named()` 只回一层的洞名（`{kind, name, suffixes, …, raw}`）。这一份往下走到底：
// 整棵树变成引擎那边的节点形状（`{kind, 洞名: 子节点, line}`），于是
// `frontend-engine/bind.js`（作用域配方）、`arity.js`（出几个值）那几份**通用驱动器**
// 不用改一行就能跑 jancy —— 那正是 ADR-0030 第 5 节说的"名字就是桥"落到实处。
//
// 两处刻意的规整（都记在下面的表里）：
//   1. **左递归的列表拉平成数组**：`(unit-add (unit-add (unit) A) B)` 变 `[A, B]`。
//      GLR 那种嵌套形状是语法的产物，不是这门语言的意思。
//   2. **`name` 变引擎的名字叶子**（`{kind:'name', value}`）：查名那一步靠的就是它。
//
// 别的记号（关键字、字面量、算符）规整成 `{kind:'tok', …}`，`tok` 这一格在节点表里也有 ——
// 驱动器碰到它按"没有洞的节点"走，不会当特例。

import { headOf, named } from './adapt.js';
import { jncLang } from './nodes.js';

/**
 * 左递归列表：`基例头 -> 递归头`。基例是空的（`(unit)`），递归两格（`list` / `one`）。
 * 键是**基例**的头名 —— 拉平之后那一格是数组，节点自己没了。
 */
export const JNC_LISTS = {
  unit: 'unit-add', mods: 'mods-add', ptrs: 'ptrs-add', suffixes: 'suffixes-add',
  dcls: 'dcls-add', formals: 'formals-add', args: 'args-add', exprs: 'exprs-add',
  items: 'items-add', enums: 'enums-add', attrs: 'attrs-add', targs: 'targs-add',
  qnames: 'qnames-add',
};

/** 递归头 -> 基例头（反查用）。 */
const ADD_TO_BASE = new Map(Object.entries(JNC_LISTS).map(([b, a]) => [a, b]));

/** 这一格是记号（没有 `items`）么。 */
const isTok = (n) => n !== null && n !== undefined && typeof n === 'object'
  && !Array.isArray(n.items);

/** 记号的行号（有就带上 —— 报错要它）。 */
const lineOf = (t) => (t !== null && typeof t === 'object' && t.line !== undefined ? t.line : undefined);

/**
 * 规整一棵（子）树。答的是引擎认的节点、数组（拉平的列表）、或者 `null`（这一格空着）。
 * 表里没有的头名会**当场炸** —— 覆盖率是量过的（660 份语料 148 个名字 100%），
 * 静悄悄跳过只会把窟窿藏到下游。
 */
export function normalize(n, lang = jncLang) {
  if (n === null || n === undefined) return null;
  if (isTok(n)) return { kind: 'tok', value: n.value, line: lineOf(n) };
  const head = headOf(n);
  if (head === null) throw new Error('normalize：这一格既不是记号也不是带头名的节点');

  // 列表：拉平成数组（基例是空数组，递归把 one 一个个塞进去）
  if (JNC_LISTS[head] !== undefined || ADD_TO_BASE.has(head)) {
    return flatten(n, lang);
  }

  // 名字叶子：引擎查名认的就是 `{kind:'name', value}`
  if (head === 'name') {
    const nm = named(n, lang);
    const t = nm === null ? null : nm.text;
    return { kind: 'name', value: t === null || t === undefined ? null : t.value, line: lineOf(t) };
  }

  const nm = named(n, lang);
  if (nm === null) {
    throw new Error(`normalize：节点 ${head} 的形状与表对不上（子项 ${n.items.length - 1} 格）`);
  }
  const out = { kind: head };
  const ln = lineOfNode(n);
  if (ln !== undefined) out.line = ln;
  for (const k of Object.keys(nm)) {
    if (k === 'kind' || k === 'raw') continue;
    out[k] = normalize(nm[k], lang);
  }
  return out;
}

/** 左递归链拉平：无论从基例还是从 `-add` 进来，都答一个数组。 */
function flatten(n, lang) {
  const out = [];
  let cur = n;
  for (;;) {
    const h = headOf(cur);
    const base = ADD_TO_BASE.get(h);
    if (base === undefined) break;                    // 到基例了
    const nm = named(cur, lang);
    if (nm === null) throw new Error(`normalize：列表节点 ${h} 的形状与表对不上`);
    out.unshift(normalize(nm.one, lang));             // 左递归：后来的在右边
    cur = nm.list;
    if (cur === null || cur === undefined) break;
  }
  /* 基例那一格自己也可能带一项：`(args E)` / `(enums X)` —— 那种"第一项"的形状
     （表里写成可缺的 `first`）。空基例（`(unit)` / `(mods)`）没有洞，什么都不加。 */
  const nm = cur === null || cur === undefined ? null : named(cur, lang);
  if (nm !== null && nm.first !== undefined) out.unshift(normalize(nm.first, lang));
  return out;
}

/** 节点的行号（往下找第一个带行号的记号）。 */
function lineOfNode(n) {
  for (let i = 1; i < n.items.length; i += 1) {
    const it = n.items[i];
    if (isTok(it)) { const l = lineOf(it); if (l !== undefined) return l; }
    else if (it !== null && it !== undefined && Array.isArray(it.items)) {
      const l = lineOfNode(it);
      if (l !== undefined) return l;
    }
  }
  return lineOf(n.items[0]);
}
