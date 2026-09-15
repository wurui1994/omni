// src/lang/jnc/types.js —— 按洞名把"一格声明"读成**类型 + 形状**
//
// 这是 `declare.js`（声明符）与 `specs.js`（说明符）的合流：一条声明的类型是两边拼出来的 ——
// 说明符给基类型与修饰词，声明符给 `*` 的层数与后缀链（`(形参)` / `[n]` / `: 位数`）。
// jancy 那边这件事在 `jnc_ct_DeclTypeCalc.cpp` 里干（一串 calcXxxType），依据就是
// "后缀是什么形状 + 哪些修饰词落在它上面"。这一份把那个依据写成**表**。
//
// 只回结构，不回"方言里怎么写" —— 降级那一层才管发什么。规范写法（`text`）只用来对账。

import { readDcl, chainOf } from './declare.js';
import { readSpecs, wordOf } from './specs.js';
import { headOf } from './adapt.js';

/** 基类型那一格是什么（`typeHead` 到"种类"的表）。 */
export const BASE_KINDS = {
  name: 'named', qualified: 'named', 'qualified-special': 'named', tinst: 'generic',
  agg: 'agg', enum: 'enum', 'abstract-class': 'class', 'property-template': 'property',
  typeof: 'typeof', 'no-type': 'none', 'fn-type': 'fn-type',
};

/** 后缀链决定的形状（前面的后缀先算 —— `int f()[2]` 那种语料里没有，记在账上）。 */
export const SUFFIX_SHAPE = { 'fn-suffix': 'fn', 'array-suffix': 'array', bitfield: 'bitfield' };

/** 这几个修饰词把形状改掉（jancy 的 DeclTypeCalc 就按它们分派）。
 *  `multicast` 与 `event` **落地是同一件事** —— 差别只在"能不能从外面叫"
 *  （`MulticastMethodFlag_InaccessibleViaEventPtr`，jnc_ct_TypeMgr.cpp:940-975），
 *  而这一层没有可见性检查（与第五十二刀同一笔账）。不写 `multicast` 这一格，
 *  `multicast g_onPair(int a, int b);` 就定不出型（71-event.jnc 的 `jnc$mc_fire$int$int`
 *  是尺子上量出来的那一格）。 */
export const SHAPE_WORDS = {
  property: 'prop', event: 'event', multicast: 'event', reactor: 'fn', function: 'fnptr',
};

/**
 * **丢一个词就静默给错答案**的那几个修饰词（第二百五十七刀）。
 *
 * 这一层的规矩是"降不下来就说出来"，而修饰词这一族先前是**读到才算**：表里没有的词
 * 一句话不说地丢掉，于是 `threadlocal int n;` 降成一格普通局部量、`async int foo()`
 * 的返回类型从 `std.Promise*` 变成 `int`、`C1 weak* wc` 永远不为 null、
 * `disposable R r(1);` 的 `dispose` 一次也不调 —— 四条都**给了答案，而答案是错的**
 * （量出来的：tests/jnc/bad 那四份在规则那条路上原本"居然通过了"）。
 *
 * 所以这张表记的不是"还没接"，是"这个词不许悄悄丢"。话与旧降级那一侧逐字同一句
 * （`src/core/frontend-jnc/lower.js:7629` 那一段），因为墙是同一道。
 *
 * `disposable` 分两句：写在**局部量**上是"还没接那一套作用域出口的钩子"，
 * 写在别处（类声明 / 字段 / 模块级的量）是**位置就不对** —— 两句混着说会认错人
 * （旧降级那一侧同一条，lower.js:7691-7698）。
 */
export const MOD_NOPE = {
  threadlocal: { any: '`threadlocal`（要线程本地存储）' },
  async: {
    any: '`async` 函数 —— jancy 那儿它换掉返回类型（写出来的那个挪去 m_asyncReturnType，'
      + '函数真正回一格 `std.Promise*`，jnc_ct_TypeMgr.cpp:664-672），体还要拆成一台'
      + '能在 await 处停下再接着跑的状态机',
  },
  weak: {
    any: '`weak` 指针 —— jancy 那儿它是另一种指针（ClassPtrKind_Weak / FunctionPtrKind_Weak / '
      + 'PropertyPtrKind_Weak，jnc_ct_DeclTypeCalc.cpp:667/676/688），GC 收了对象之后它自己变 null；'
      + '这一层没有 GC，收下不看会让 `if (p)` 永远为真',
  },
  disposable: {
    local: '`disposable` 的局部量 —— jancy 那儿它给这一格开一个可弃作用域、出去的时候'
      + '（正常出去与抛出去都算）调它的 `dispose`（jnc_ct_Parser.cpp:2050-2068），'
      + '要作用域出口那一套钩子',
    other: '`disposable` 只能写在**局部量**上（jancy 那边这个词只在那一档收，'
      + 'jnc_ct_Parser.cpp:2050-2068 —— 类自己的"可弃"是靠有一格 `dispose` 方法，'
      + 'disposable.rst 那句 "usually aliased to close/disconnect/…"）',
  },
};

/** 一个修饰词在这一处该说哪一句；不该拦答 null。`local` 是"这一格在函数体里"。 */
export function modNope(word, local) {
  const e = MOD_NOPE[word];
  if (e === undefined) return null;
  return e.any ?? (local ? e.local : e.other);
}

/**
 * 读一格声明的类型。`specsNode` 与 `dclNode` 都是 GLR 的树（还没规整那一种）。
 * 读不了答 `null`（调用方照旧走老路）。
 */
export function readDeclType(specsNode, dclNode) {
  const sp = readSpecs(specsNode);
  const dc = readDcl(dclNode);
  if (sp === null || dc === null) return null;
  const head = sp.typeHead;
  const baseKind = head === null ? 'none' : (BASE_KINDS[head] ?? (isWord(head) ? 'word' : 'other'));
  const suffixes = dc.suffixes.map((s) => s.kind);
  let shape = 'data';
  for (const s of suffixes) {
    const sh = SUFFIX_SHAPE[s];
    if (sh !== undefined) { shape = sh; break; }
  }
  /* 形状还要看**跟在 `*` 后面**的那几个词（`Inner* property m_p;` 的 `property` 落在
     `ptr-group -> "*" mods` 里，不在说明符表里）—— 尺子逼出来的：不读它就把一格属性
     当了数据字段（108-propdot.jnc）。 */
  for (const w of [...sp.words, ...dc.ptrMods]) {
    const sh = SHAPE_WORDS[w];
    if (sh !== undefined) { shape = sh === 'fnptr' && shape === 'fn' ? 'fnptr' : sh; }
  }
  return {
    base: { kind: baseKind, text: baseText(sp.type, head) },
    mods: [...sp.words, ...dc.ptrMods],
    ptrs: dc.ptrs,
    suffixes,
    shape,
    name: dc.name,
    raw: { specs: specsNode, dcl: dclNode },
  };
}

/** 基类型那一格的字面（关键字直接是词；限定名 / 聚合体只取它的头名 —— 对账够用）。 */
function baseText(node, head) {
  if (node === undefined || node === null) return '';
  const w = wordOf(node);
  if (headOf(node) === null && w !== null) return w;      // 光一个记号（`int` / `void`）
  return head ?? '';
}

/** 这一格是不是"光一个关键字"（`int` / `void` / `char`…）。 */
function isWord(head) {
  return head === null || head === undefined ? false : !(head in BASE_KINDS);
}

/**
 * **没有声明符**的那一格类型：`void f(int, int b)` 里第一个形参（`formal-anon` 的洞是
 * 说明符 + `*`，压根没有 `dcl`），还有泛型合成实参那一条。读法与 `readDeclType` 同，
 * 只是名字与后缀都空着。
 */
export function readAnonType(specsNode, ptrsNode) {
  const sp = readSpecs(specsNode);
  if (sp === null) return null;
  const head = sp.typeHead;
  const baseKind = head === null ? 'none' : (BASE_KINDS[head] ?? (isWord(head) ? 'word' : 'other'));
  return {
    base: { kind: baseKind, text: baseText(sp.type, head) },
    mods: [...sp.words],
    ptrs: chainOf(ptrsNode, 'ptrs-add').length,
    suffixes: [],
    shape: 'data',
    name: null,
    raw: { specs: specsNode, dcl: null },
  };
}

/** 规范写法（只为对账：修饰词按出现次序、`*` 按层数、后缀按链的次序）。 */
export function typeText(t) {
  if (t === null) return '';
  const stars = '*'.repeat(t.ptrs);
  const sfx = t.suffixes.map((s) => (s === 'fn-suffix' ? '()' : (s === 'array-suffix' ? '[]' : `:${s}`))).join('');
  return `${[...t.mods, t.base.text].filter((x) => x !== '').join(' ')}${stars}${sfx}`;
}
