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

/** 这几个修饰词把形状改掉（jancy 的 DeclTypeCalc 就按它们分派）。 */
export const SHAPE_WORDS = { property: 'prop', event: 'event', reactor: 'fn', function: 'fnptr' };

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
