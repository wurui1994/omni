// src/core/frontend-engine/language.js —— **一门语言 = 一张表 + 一串增量**
//
// 驱动器（parse-driver / render / bind / arity）都不认识任何具体语言：它们只读这儿派生出来的
// 索引。加一门语言 = 写几张表；加一门方言 = `extend(base, delta)`（ADR-0030 第 2 节）。
//
// 组合的规矩照 `feature.js`（jancy 那边验过的三条）：
//   1. 增量可以**加**节点/记号/洞类；
//   2. 要**改**基语言的某个节点，必须写 `replaces: true`（不写就当冲突，当场炸）；
//   3. 洞的上位关系（`subclass`）冲突也当场炸。

import { holesOf } from './syntax.js';

function derive(lang) {
  lang.NODE = new Map(lang.nodes.map((n) => [n.name, n]));
  lang.OP = new Map(lang.ops.map((o) => [o.name, o]));
  lang.opNames = new Set(lang.ops.map((o) => o.name));
  lang.keywordSet = new Set(lang.keywords);
  /* 语句串到哪儿收：Lua 是 `end`/`else`/`elseif`/`until`，C 系是 `}` —— 一格数据，
     不是驱动器里写死的一张表（先前就是写死的，于是别的语言的块压根收不住）。 */
  lang.blockEndSet = new Set(lang.blockEnd);
  // 标点与符号算符按长度倒排 —— 最长匹配靠这一格，不靠扫描器里的分支。
  lang.symbols = [...new Set([...lang.punct, ...lang.ops.filter((o) => o.word !== true).map((o) => o.name)])]
    .sort((a, b) => b.length - a.length);

  lang.chain = (cls) => {
    const out = [cls];
    let c = cls;
    while (lang.subclass[c] !== undefined) { c = lang.subclass[c]; out.push(c); }
    return out;
  };
  lang.fits = (nm, cls) => {
    const n = lang.NODE.get(nm);
    return n === undefined ? false : lang.chain(n.of).includes(cls);
  };
  lang.membersOf = (cls) => lang.nodes.filter((n) => lang.fits(n.name, cls)).map((n) => n.name);

  const stats = lang.nodes.filter((n) => n.of === 'stat');
  lang.LEAD = new Map();
  for (const n of stats) {
    if (typeof n.syn[0] !== 'string') continue;
    if (!lang.LEAD.has(n.syn[0])) lang.LEAD.set(n.syn[0], []);
    lang.LEAD.get(n.syn[0]).push(n);
  }
  lang.FALLBACK = stats.filter((n) => typeof n.syn[0] !== 'string');
  // 表达式里的"简单值"：`syn` 以字面记号或叶子起头的那些（`name`/`paren` 走后缀链，除外）。
  lang.SIMPLE = lang.membersOf('exp').filter((nm) => {
    const n = lang.NODE.get(nm);
    if (n.suffix === true || n.unary === true || n.binary === true) return false;
    return nm !== 'name' && nm !== 'paren';
  }).map((nm) => lang.NODE.get(nm));

  // 什么记号能起一个表达式 —— 由"简单值"节点的 `syn` 第一项派生。加个 `|x| e` 只要加节点，
  // 这一格自己跟着长（先前这串常量硬写在 parse.js 里）。
  lang.expLead = new Set(['(']);          // `(exp)` 与后缀链的起点
  lang.expLeadKinds = new Set(['name']);
  for (const n of lang.SIMPLE) {
    const f = n.syn[0];
    if (typeof f === 'string') lang.expLead.add(f);
    else if (f.t !== undefined) lang.expLeadKinds.add(f.t);
  }
  return lang;
}

function check(lang) {
  const cls = new Set(lang.classes);
  for (const n of lang.nodes) {
    if (!cls.has(n.of)) throw new Error(`${lang.name}：节点 ${n.name} 的 of='${n.of}' 不是已知洞类`);
    if (!Array.isArray(n.syn) || n.syn.length === 0) throw new Error(`${lang.name}：节点 ${n.name} 少 syn`);
    for (const h of holesOf(n)) {
      if (!cls.has(h.cls)) throw new Error(`${lang.name}：${n.name} 的洞 ${h.name} 类别 '${h.cls}' 不认得`);
      if (lang.membersOf(h.cls).length === 0) throw new Error(`${lang.name}：${n.name} 的洞 ${h.name}：'${h.cls}' 类没成员`);
      for (const o of h.only ?? []) {
        if (!lang.fits(o, h.cls)) throw new Error(`${lang.name}：${n.name} 的洞 ${h.name}：only 里 '${o}' 本来就填不进 ${h.cls}`);
      }
    }
  }
  for (const [a, b] of Object.entries(lang.subclass)) {
    if (!cls.has(a) || !cls.has(b)) throw new Error(`${lang.name}：subclass 里 '${a}→${b}' 有不认得的类`);
  }
  return lang;
}

/** 立一门语言。 */
export function defineLang({
  name, keywords = [], ops = [], punct = [], unaryPrec, classes = [], subclass = {},
  nodes = [], numSuffix, doc = '', tokens = null, start = 'block', str, ident,
  scope = {}, ctx = {}, yields = {}, blockEnd = [],
}) {
  /* 记号规则表**没有默认值**：那是语言自己的事（先前这儿默认成了 Lua 那张表 ——
     一份 SDK 不该知道有 Lua 这门语言）。 */
  if (tokens === null) throw new Error(`语言 ${name}：没给 tokens（记号规则表）`);
  return check(derive({
    name, doc, keywords: [...keywords], ops: [...ops], punct: [...punct], unaryPrec,
    classes: [...classes], subclass: { ...subclass }, nodes: [...nodes], numSuffix,
    tokens, start, str, ident,
    scope: { ...scope }, ctx: { ...ctx }, yields: { ...yields }, blockEnd: [...blockEnd],
  }));
}

/**
 * 在一门语言上加增量。`delta` 与 defineLang 同形，另加：
 *   nodes 里带 `replaces: true` 的替换同名节点；不带而重名 → 炸。
 */
export function extend(base, delta) {
  const nodes = [...base.nodes];
  for (const n of delta.nodes ?? []) {
    const at = nodes.findIndex((x) => x.name === n.name);
    if (at < 0) { nodes.push(n); continue; }
    if (n.replaces !== true) {
      throw new Error(`${delta.name ?? '增量'}：节点 '${n.name}' 与 ${base.name} 撞名，要改就写 replaces: true`);
    }
    nodes[at] = n;
  }
  const subclass = { ...base.subclass };
  for (const [a, b] of Object.entries(delta.subclass ?? {})) {
    if (subclass[a] !== undefined && subclass[a] !== b) {
      throw new Error(`${delta.name ?? '增量'}：洞类 '${a}' 的上位在 ${base.name} 里是 '${subclass[a]}'，改不得`);
    }
    subclass[a] = b;
  }
  const ops = [...base.ops];
  for (const o of delta.ops ?? []) {
    const at = ops.findIndex((x) => x.name === o.name);
    if (at < 0) ops.push(o);
    else if (o.replaces === true) ops[at] = o;
    else throw new Error(`${delta.name ?? '增量'}：算符 '${o.name}' 与 ${base.name} 撞名`);
  }
  return defineLang({
    name: delta.name ?? `${base.name}+`,
    doc: delta.doc ?? '',
    keywords: [...new Set([...base.keywords, ...(delta.keywords ?? [])])],
    ops,
    punct: [...new Set([...base.punct, ...(delta.punct ?? [])])],
    unaryPrec: delta.unaryPrec ?? base.unaryPrec,
    classes: [...new Set([...base.classes, ...(delta.classes ?? [])])],
    subclass,
    nodes,
    numSuffix: delta.numSuffix ?? base.numSuffix,
    tokens: delta.tokens ?? base.tokens,
    start: delta.start ?? base.start,
    str: delta.str ?? base.str,
    ident: delta.ident ?? base.ident,
    /* 语义那三张表按**格**合并：方言加一格就写一格（`lambda` 的配方就是这么加的）。 */
    scope: { ...base.scope, ...(delta.scope ?? {}) },
    ctx: { ...base.ctx, ...(delta.ctx ?? {}) },
    yields: { ...base.yields, ...(delta.yields ?? {}) },
    blockEnd: [...new Set([...base.blockEnd, ...(delta.blockEnd ?? [])])],
  });
}


export { holesOf };
