// src/lang/jnc/agg.js —— 按洞名读一个**聚合体**（class / struct / union / opaque class）
//
// 这是三张表的合流：节点表给形状（`agg` 的四格洞）、`types.js` 给每格成员的类型与形状、
// 词汇表给访问与存储那几个词。读出来的是降级真正要的那份东西：
//
//   { word, name, bases, members: [{ name, type, shape, access, storage, at }] }
//
// 两条规矩写成数据，不写成 if：
//   1. **访问标签是有状态的**（`public:` 之后的成员都是 public，直到下一个标签）——
//      jancy 的 `AccessKind` 就是这么在命名空间上滚的（jnc_ct_Namespace 的 m_accessKind）。
//      默认值按 `agg` 的种类分：class 默认 public、struct/union 默认 public
//      （jancy 里 class 的字段默认也是 public —— 与 C++ 不同，这一格是抄的，不是猜的：
//      DeclarationSpecifier.llk 没有 private，AccessKind 只有 public / protected 两格）。
//   2. **存储词就是说明符里的那几个词**（static / virtual / override / abstract…）——
//      `types.js` 已经把它们读出来了，这儿只挑出属于"存储"那一族的。

import { headOf, named } from './adapt.js';
import { readDeclType } from './types.js';
import { readSpecs, wordOf } from './specs.js';
import { STORAGE } from './syntax.js';
import { chainOf } from './declare.js';

/** 访问标签（`public:` / `protected:`）。默认 public —— jancy 只有这两格。 */
const ACCESS_DEFAULT = 'public';

/** 一格成员声明里的存储词（挑出说明符里属于存储那一族的）。 */
function storageOf(words) {
  return words.filter((w) => STORAGE[w] !== undefined);
}

/** `unit` / `unit-add` 那一串（体里的每一条声明），按位置走。 */
function bodyItems(body) {
  return chainOf(body, 'unit-add');
}

/**
 * 读一个 `agg`。读不了答 `null`。
 * 成员里读不出类型的那几条（`friend` / `access` / 嵌套类型声明）**照样收**，只是 `type` 为 null
 * —— 那是"这一格是什么"的事实，不该被读取器吞掉。
 */
export function readAgg(node) {
  const nm = named(node);
  if (nm === null || nm.kind !== 'agg') return null;
  const members = [];
  let access = ACCESS_DEFAULT;
  for (const it of bodyItems(nm.body)) {
    const h = headOf(it);
    if (h === 'access') { access = wordOf(it) ?? access; continue; }
    for (const m of memberOf(it, access)) members.push(m);
  }
  return {
    word: wordOf(nm.word),
    name: nm.name,
    bases: nm.bases,
    members,
    raw: node,
  };
}

/** 一条体内声明读成零到多格成员。 */
function memberOf(it, access) {
  const h = headOf(it);
  const nm = named(it);
  if (nm === null) return [];
  if (h === 'attributed') return memberOf(nm.decl, access);        // 属性块是壳
  if (h === 'fn-def' || h === 'fn-proto') {
    const t = readDeclType(nm.specs, nm.dcl);
    return [one(t, nm.specs, access, h === 'fn-def' ? 'body' : 'proto', it)];
  }
  if (h === 'var-decl' || h === 'typedef') {
    const out = [];
    for (const d of allDcls(nm.dcls)) {
      const dcl = unwrap(d);
      if (headOf(dcl) !== 'dcl') continue;
      out.push(one(readDeclType(nm.specs, dcl), nm.specs, access, h === 'typedef' ? 'typedef' : 'data', it));
    }
    return out;
  }
  if (h === 'type-decl') return [{ name: null, type: null, shape: 'nested-type', access, storage: [], at: it }];
  if (h === 'friend') return [{ name: null, type: null, shape: 'friend', access, storage: [], at: it }];
  return [];                                                       // 别的（空语句那类）不算成员
}

/** `dcls` / `dcls-add` 那一串里的**全部**声明符（`int a, b, c;` 三格都要）。 */
function allDcls(node) {
  const out = [];
  let cur = node;
  while (cur !== null && cur !== undefined) {
    const h = headOf(cur);
    if (h === 'dcls-add') {
      const n = named(cur);
      if (n === null) break;
      out.unshift(n.one);
      cur = n.list;
      continue;
    }
    if (h === 'dcls') {
      const n = named(cur);
      if (n !== null && n.first !== undefined) out.unshift(n.first);
      break;
    }
    out.unshift(cur);                                              // 光一个 dcl / init
    break;
  }
  return out;
}

/** `init` / `ref-init` 裹着的声明符。 */
function unwrap(d) {
  const h = headOf(d);
  return (h === 'init' || h === 'ref-init') ? named(d)?.dcl : d;
}

function one(t, specs, access, kindHint, at) {
  const sp = readSpecs(specs);
  return {
    name: t === null ? null : t.name,
    type: t,
    shape: t === null ? kindHint : (kindHint === 'typedef' ? 'typedef' : t.shape),
    access,
    storage: sp === null ? [] : storageOf(sp.words),
    at,
  };
}
