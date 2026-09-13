// ext/lua/lang.js —— **一门语言 = 一张表 + 一串增量**；驱动器读它，不认识任何具体语言
//
// 这一份把 tokens.js / nodes.js 那些**数据**装成一个 `lang` 对象，并派生出驱动器要用的索引
// （节点表、引导记号表、洞的成员表…）。为什么要这一层：
//
//   `ext/gsl-shell` 要在 Lua 上加 `|x| e`（短 lambda）与 `1i`（虚数）两样东西。如果索引是
//   模块级常量（先前就是），加方言就得改 ext/lua 的文件 —— 那就不是"增量"，是分叉。
//   有了 `extend(luaLang, delta)`，方言只写自己那几行，**ext/lua 一个字不改，驱动器也不改**。
//   这一条就是设计稿第 9 节的判据 2。
//
// 组合的规矩照 `src/core/frontend-engine/feature.js`（jancy 那边验过的三条）：
//   1. 增量可以**加**节点/记号/洞类；
//   2. 要**改**基语言的某个节点，必须写 `replaces: true`（不写就当冲突，当场炸）；
//   3. 洞的上位关系（`subclass`）冲突也当场炸。

import {
  LUA_KEYWORDS, LUA_OPS, LUA_PUNCT, LUA_UNARY_PREC, LUA_TOKENS,
} from './tokens.js';
import { LUA_NODES, LUA_CLASSES, LUA_SUBCLASS } from './nodes.js';

/** 扁平地看一个节点的洞（含可选组/重复组里的）。 */
export function holesOf(node) {
  const out = [];
  const walk = (items, inOpt, inRep) => {
    for (const it of items) {
      if (typeof it === 'string') continue;
      if (it.opt !== undefined) { walk(it.opt, true, inRep); continue; }
      if (it.rep !== undefined) { walk(it.rep, inOpt, true); continue; }
      if (it.h !== undefined) out.push({ name: it.h, cls: it.cls, list: false, opt: inOpt, rep: inRep, only: it.only });
      else if (it.l !== undefined) out.push({ name: it.l, cls: it.cls, list: true, min: it.min, opt: inOpt, rep: inRep });
    }
  };
  walk(node.syn, false, false);
  return out;
}

function derive(lang) {
  lang.NODE = new Map(lang.nodes.map((n) => [n.name, n]));
  lang.OP = new Map(lang.ops.map((o) => [o.name, o]));
  lang.opNames = new Set(lang.ops.map((o) => o.name));
  lang.keywordSet = new Set(lang.keywords);
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
  nodes = [], numSuffix, doc = '', tokens = LUA_TOKENS, start = 'block', str, ident,
}) {
  return check(derive({
    name, doc, keywords: [...keywords], ops: [...ops], punct: [...punct], unaryPrec,
    classes: [...classes], subclass: { ...subclass }, nodes: [...nodes], numSuffix,
    tokens, start, str, ident,
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
  });
}

/** Lua 本身。 */
export const luaLang = defineLang({
  name: 'lua',
  doc: 'Lua 5.1 / LuaJIT 2（含 goto/label）',
  keywords: LUA_KEYWORDS,
  ops: LUA_OPS,
  punct: LUA_PUNCT,
  unaryPrec: LUA_UNARY_PREC,
  classes: LUA_CLASSES,
  subclass: LUA_SUBCLASS,
  nodes: LUA_NODES,
  // LuaJIT 的数字后缀。`1i`（虚数）先前被我当成了 gsl-shell 的扩展 —— 读了源码才知道**不是**：
  // 它在 `luajit2/src/lj_strscan.c:421-425`（`STRSCAN_IMAG`）与 `lj_lex.c:106,121`，
  // 是 LuaJIT 带 FFI 时的数字文法。于是这一格属于基语言，不属于方言增量。
  // 同一处注释列的其余后缀：`U`(u32) `LL`(i64) `ULL/LLU`(u64) `L` `UL/LU`。
  numSuffix: /^(?:i|[uU][lL][lL]|[lL][lL][uU]|[lL][lL]|[uU][lL]|[lL][uU]|[uU]|[lL])/,
});
