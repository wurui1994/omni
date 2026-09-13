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
import { chainOf, allInChain } from './declare.js';

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

/**
 * 一格**体**（`compound` 的那一串声明）读成成员表。完整属性声明用它：
 * `property m_p { int m_v; int get() {…} }` 里那格 `m_v` 是属性自己的存储
 * （旧降级把它发成 `<东家>$<属性名>$<字段名>`，151-propfield.jnc）。
 */
export function readBodyMembers(compound, access = ACCESS_DEFAULT) {
  const nm = named(compound);
  if (nm === null || nm.kind !== 'compound') return [];
  const out = [];
  let acc = access;
  for (const it of bodyItems(nm.body)) {
    if (headOf(it) === 'access') { acc = wordOf(it) ?? acc; continue; }
    for (const m of memberOf(it, acc)) out.push(m);
  }
  return out;
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
    for (const d of allInChain(nm.dcls, 'dcls-add', 'dcls')) {
      const dcl = unwrap(d);
      if (headOf(dcl) !== 'dcl') continue;
      out.push(one(readDeclType(nm.specs, dcl), nm.specs, access, h === 'typedef' ? 'typedef' : 'data', it));
    }
    return out;
  }
  if (h === 'type-decl') {
    /* 嵌套类型自己不是一格数据成员，但**匿名 union** 的成员要摊进外面这个结构体
       （第一百一十刀）。所以把里头读出来的那一格带上（`nested`），摊不摊由发的那一层定。 */
    const inner = nm.agg;
    const ih = headOf(inner);
    const nested = ih === 'agg' ? readAgg(inner) : (ih === 'enum' ? readEnum(inner) : null);
    return [{
      name: null, type: null, shape: 'nested-type', access, storage: [], at: it, nested,
    }];
  }
  if (h === 'friend') return [{ name: null, type: null, shape: 'friend', access, storage: [], at: it }];
  return [];                                                       // 别的（空语句那类）不算成员
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

/**
 * 读一个 `enum`（`enum` / `bitflag enum`）：项名 + 有没有写死的值。
 * 与 `readAgg` 同一条路子 —— 项那一串是 `enums` / `enums-add` 左递归链，
 * 项自己可能裹着属性块（`[ displayName = … ] Item = 1`，io_Df1.jnc:63）。
 */
export function readEnum(node) {
  const nm = named(node);
  if (nm === null || nm.kind !== 'enum') return null;
  const items = [];
  /* 走**整条链**：`enums-add` 那几格 + 基例 `(enums 第一项)` 那一格。
     先前写成 `chainOf(...).concat(enumFirst(body))` —— 链在的时候 `enumFirst` 拿到的是
     `enums-add` 而不是基例，于是**第一项永远丢**。尺子上是 584 个枚举差 1 项，
     一次就抓出来了（与 `allDcls` 那儿同一个坑）。 */
  for (const it of allInChain(nm.body, 'enums-add', 'enums')) {
    const item = unwrapAttrs(it);
    const im = named(item);
    if (im === null || im.kind !== 'enum-item') continue;
    items.push({ name: wordOf(im.name), value: im.value ?? null, at: item });
  }
  return {
    word: wordOf(nm.word), name: nm.name, base: nm.base ?? null, items, raw: node,
  };
}

/** `attributed` 是壳（枚举项也能带属性块）。 */
function unwrapAttrs(it) {
  return headOf(it) === 'attributed' ? (named(it)?.decl ?? it) : it;
}
