// src/core/frontend-engine/common-nodes.js —— 公共规则：**形状**一层，**拼法**另一层
//
// 起因两条（ADR-0030 第 2/5 节）：
//
//   1. `ext/lua` 与 `ext/gsl-shell` 各写了一遍 `number` / `name` / `binop` / `prefix` /
//      `paren` / `call` / `index`…… 这几格大部分语言是一样的，该有一份默认。
//   2. 第一版把默认拼法写成了 C 系（`if (c) {…}`、分号收尾），那是**偏心**。
//      公共规则要能承载各种语言 —— Lua 的 `if c then … end`、Pascal 的 `begin … end`、
//      甚至**根本不写 `syn`**：拼法在 `.grammar` 里，由 GLR 认。
//
// 所以切成两层：
//
//   **形状**（`COMMON_SHAPES`）：名字 + 洞 + 洞的类别 + 几格标记（`unary`/`binary`/`suffix`/`last`）。
//     这一层才是真跨语言的 —— 语义那三张表（作用域配方 / 元数契约 / 降级的小步）
//     都是**按节点名字**挂的，名字与洞一样，它们就能共享。
//   **拼法**（`SPELL_*`）：一个形状怎么写出来。C 系一张、词语系（Lua/Pascal/Ruby）一张，
//     语言可以自己写一张，也可以**不写**（`defineLang({parser:'glr'})`，节点表只留形状）。
//
// 一句要记住的：**公共不是求交集，是给一份默认值。** 改了几格就是这门语言"离公共有多远"。

import { defineLang } from './language.js';
import {
  h, l, w, opt,
} from './syntax.js';

/** 洞的类别与那条上位链：`var ⊂ prefixexp ⊂ exp`（带赋值的语言大都是这形状）。 */
export const COMMON_CLASSES = ['exp', 'prefixexp', 'var', 'block', 'stat'];
export const COMMON_SUBCLASS = { var: 'prefixexp', prefixexp: 'exp' };

/**
 * **形状**。`holes` 的类别可带后缀：`*` 一串、`?` 可缺；`leaf` 说它是哪种叶子记号。
 * 15 格 —— 这是"绝大多数命令式语言都有"的那一层，不含任何关键字。
 */
export const COMMON_SHAPES = [
  { name: 'number', of: 'exp', leaf: 'number' },
  { name: 'string', of: 'exp', leaf: 'string' },
  { name: 'name', of: 'var', leaf: 'name' },
  { name: 'paren', of: 'prefixexp', holes: { inner: 'exp' } },
  { name: 'prefix', of: 'exp', unary: true, holes: { a: 'exp' } },
  { name: 'binop', of: 'exp', binary: true, holes: { a: 'exp', b: 'exp' } },
  {
    name: 'call', of: 'prefixexp', suffix: true, holes: { fn: 'prefixexp', args: 'exp*?' },
  },
  {
    name: 'index', of: 'var', suffix: true, holes: { obj: 'prefixexp', key: 'exp' },
  },
  { name: 'block', of: 'block', body: 'stats' },
  {
    name: 'call-stat', of: 'stat', only: ['call'], holes: { call: 'prefixexp' },
  },
  { name: 'assign', of: 'stat', holes: { targets: 'var*', values: 'exp*' } },
  {
    name: 'if', of: 'stat', holes: { cond: 'exp', then: 'block', else: 'block?' },
  },
  { name: 'while', of: 'stat', holes: { cond: 'exp', body: 'block' } },
  { name: 'return', of: 'stat', last: true, holes: { values: 'exp*?' } },
  { name: 'break', of: 'stat', last: true, holes: {} },
];

/**
 * 有几种形状的拼法**所有语言都一样**（叶子、括号、前缀/中缀算符、后缀调用与下标、裸块），
 * 放这儿当兜底；拼法表只需要写"各语言不一样"的那几格（语句那一族）。
 */
function defaultSyn(s) {
  if (s.leaf !== undefined) return [{ t: s.leaf, as: 'value' }];
  if (s.name === 'paren') return ['(', h('inner'), ')'];
  if (s.unary === true) return [{ o: 'op' }, h('a')];
  if (s.binary === true) return [h('a'), { o: 'op' }, h('b')];
  if (s.name === 'call') return [h('fn', 'prefixexp'), '(', l('args', 'exp', { min: 0 }), ')'];
  if (s.name === 'index') return [h('obj', 'prefixexp'), '[', h('key'), ']'];
  if (s.body !== undefined) return [{ b: s.body }];
  return null;
}

/** C 系：花括号 + 圆括号 + 分号。 */
export const SPELL_C = {
  name: 'c',
  blockEnd: ['}'],
  syn: {
    block: () => ['{', { b: 'stats' }, '}'],
    'call-stat': () => [h('call', 'prefixexp', { only: ['call'] }), ';'],
    assign: () => [l('targets', 'var'), '=', l('values'), ';'],
    if: () => ['if', '(', h('cond'), ')', h('then', 'block'), opt('else', h('else', 'block'))],
    while: () => ['while', '(', h('cond'), ')', h('body', 'block')],
    return: () => ['return', opt(l('values')), ';'],
    break: () => ['break', ';'],
  },
};

/** 词语系：`then` / `do` / `end`，不用分号（Lua、Pascal、Ruby 那一路）。 */
export const SPELL_WORDY = {
  name: 'wordy',
  blockEnd: ['end', 'else', 'elseif', 'until'],
  syn: {
    block: () => [{ b: 'stats' }],
    'call-stat': () => [h('call', 'prefixexp', { only: ['call'] })],
    assign: () => [l('targets', 'var'), '=', l('values')],
    if: () => ['if', h('cond'), 'then', h('then', 'block'), opt('else', h('else', 'block')), 'end'],
    while: () => ['while', h('cond'), 'do', h('body', 'block'), 'end'],
    return: () => ['return', opt(l('values'))],
    break: () => ['break'],
  },
};

const shapeOnly = (s) => {
  const node = {
    name: s.name, of: s.of, unary: s.unary, binary: s.binary, suffix: s.suffix, last: s.last,
  };
  for (const k of ['unary', 'binary', 'suffix', 'last']) if (node[k] === undefined) delete node[k];
  return node;
};

/**
 * 形状 + 一张拼法表 -> 节点表。拼法表没写、兜底也给不出的形状，**留着不带 `syn`**
 * —— 那正是 GLR 那条腿要的样子（拼法在语法文件里）。
 */
export function spellShapes(shapes, pack) {
  return shapes.map((s) => {
    const mk = pack === undefined ? undefined : (pack.syn ?? {})[s.name];
    const syn = mk !== undefined ? mk(s) : defaultSyn(s);
    const node = shapeOnly(s);
    if (syn !== null) node.syn = syn;
    if (s.name === 'index' && syn !== null) node.synDot = [h('obj', 'prefixexp'), '.', w('key')];
    return node;
  });
}

/** 只有形状、没有拼法（给 GLR 那条腿）。 */
export const COMMON_SHAPE_NODES = COMMON_SHAPES.map(shapeOnly);
/** C 系拼法的公共节点表（`ext/tiny` 用的就是它）。 */
export const COMMON_NODES = spellShapes(COMMON_SHAPES, SPELL_C);
/** 词语系拼法的公共节点表（Lua 那一路从它起步）。 */
export const COMMON_NODES_WORDY = spellShapes(COMMON_SHAPES, SPELL_WORDY);

/** 公共的作用域配方：只有一条 —— 块开一层。别的绑定规矩各语言自己写。 */
export const COMMON_SCOPE = { block: { steps: ['open', 'stats'] } };

const shared = {
  classes: COMMON_CLASSES,
  subclass: COMMON_SUBCLASS,
  scope: COMMON_SCOPE,
  tokens: [],
  start: 'block',
};

/** 公共底座（C 系拼法）：给 `extend(commonLang, delta)` 用，不直接拿去解析。 */
export const commonLang = defineLang({
  ...shared,
  name: 'common',
  doc: '公共节点库：形状 15 格 + C 系拼法',
  nodes: COMMON_NODES,
  blockEnd: SPELL_C.blockEnd,
});

/** 公共底座（词语系拼法）。 */
export const commonWordyLang = defineLang({
  ...shared,
  name: 'common-wordy',
  doc: '公共节点库：形状 15 格 + 词语系拼法（then/do/end）',
  nodes: COMMON_NODES_WORDY,
  blockEnd: SPELL_WORDY.blockEnd,
});

/**
 * 公共底座（**只有形状**）：拼法交给 GLR 的语法文件。
 * 语义那三张表照样按节点名字挂 —— 这一格就是"GLR 与规则化相容"的落点。
 */
export const commonShapeLang = defineLang({
  ...shared,
  name: 'common-shape',
  doc: '公共节点库：只有形状（拼法在 .grammar 里，由 GLR 认）',
  nodes: COMMON_SHAPE_NODES,
  parser: 'glr',
});

/** 一门语言"离公共有多远"：原样用了几格、改了几格、加了几格。 */
export function distanceFrom(baseLang, lang) {
  const names = new Set(baseLang.nodes.map((n) => n.name));
  let same = 0;
  let replaced = 0;
  for (const n of lang.nodes) {
    if (!names.has(n.name)) continue;
    if (n.replaces === true) replaced += 1;
    else same += 1;
  }
  return { same, replaced, added: lang.nodes.length - same - replaced };
}
