// src/core/frontend-engine/common-nodes.js —— **公共节点库**：大部分语言长一个样的那些
//
// 起因（ADR-0030 第 3 节）：`ext/lua` 与 `ext/gsl-shell` 各写了一遍 `number` / `name` /
// `binop` / `prefix` / `paren` / `call` / `index`…… 可这几格**大部分语言是一样的** ——
// 一样的洞、一样的洞类、一样的优先级爬升。该抽成一份默认表。
//
// 三条要说清的：
//
//   1. **公共不是"求交集"，是"给一份默认值"。** 拼法（`syn`）各语言会不一样
//      （Lua 的 `if … then … end` vs C 的 `if (…) {…}`），改就改 —— `extend` 里
//      写 `replaces: true`。改了几格，就是这门语言"离公共有多远"的一个可读数字。
//   2. **共享的是节点的名字与洞的结构**，不是那几个关键字。名字一样，语义那三张表
//      （`scope` 配方 / `yields` 元数 / 降级的小步）才跟着能共享 —— 这才是真正的省。
//   3. 公共库**不带词法**：关键字、算符档次、字符串怎么写，那是语言自己的事。
//      所以 `commonLang` 的 `tokens` 是空表，它只用来被 `extend`，不直接拿去解析。

import { defineLang } from './language.js';
import {
  h, l, w, opt,
} from './syntax.js';

/** 洞的类别与那条上位链：`var ⊂ prefixexp ⊂ exp`。绝大多数带赋值的语言都是这个形状。 */
export const COMMON_CLASSES = ['exp', 'prefixexp', 'var', 'block', 'stat'];
export const COMMON_SUBCLASS = { var: 'prefixexp', prefixexp: 'exp' };

/**
 * 表达式那七格 —— 这一层几乎不用改（拼法都一样）：
 *   number / string / name / paren / prefix / binop / call / index
 * `index` 带两张 `syn`：`a[k]`（规范）与 `a.k`（`synDot`，写法糖）。
 */
export const COMMON_EXP_NODES = [
  { name: 'number', of: 'exp', syn: [{ t: 'number', as: 'value' }] },
  { name: 'string', of: 'exp', syn: [{ t: 'string', as: 'value' }] },
  { name: 'name', of: 'var', syn: [{ t: 'name', as: 'value' }] },
  { name: 'paren', of: 'prefixexp', syn: ['(', h('inner'), ')'] },
  { name: 'prefix', of: 'exp', unary: true, syn: [{ o: 'op' }, h('a')] },
  { name: 'binop', of: 'exp', binary: true, syn: [h('a'), { o: 'op' }, h('b')] },
  {
    name: 'call',
    of: 'prefixexp',
    suffix: true,
    syn: [h('fn', 'prefixexp'), '(', l('args', 'exp', { min: 0 }), ')'],
  },
  {
    name: 'index',
    of: 'var',
    suffix: true,
    syn: [h('obj', 'prefixexp'), '[', h('key'), ']'],
    synDot: [h('obj', 'prefixexp'), '.', w('key')],
  },
];

/**
 * 语句那几格 —— 拼法给的是 **C 系的默认值**（`if (c) B else B`、`{ … }`）。
 * Lua 那样的 `if c then B end` 用 `replaces: true` 换掉 `syn` 就行，**名字与洞不变**，
 * 于是作用域配方与降级的小步照旧能用。
 */
export const COMMON_STAT_NODES = [
  { name: 'block', of: 'block', syn: ['{', { b: 'stats' }, '}'] },
  { name: 'call-stat', of: 'stat', syn: [h('call', 'prefixexp', { only: ['call'] }), ';'] },
  { name: 'assign', of: 'stat', syn: [l('targets', 'var'), '=', l('values'), ';'] },
  {
    name: 'if',
    of: 'stat',
    syn: ['if', '(', h('cond'), ')', h('then', 'block'), opt('else', h('else', 'block'))],
  },
  { name: 'while', of: 'stat', syn: ['while', '(', h('cond'), ')', h('body', 'block')] },
  { name: 'return', of: 'stat', last: true, syn: ['return', opt(l('values')), ';'] },
  { name: 'break', of: 'stat', last: true, syn: ['break', ';'] },
];

export const COMMON_NODES = [...COMMON_EXP_NODES, ...COMMON_STAT_NODES];

/** 公共的作用域配方：只有一条 —— 块开一层。别的语言各有各的绑定规矩。 */
export const COMMON_SCOPE = { block: { steps: ['open', 'stats'] } };

/**
 * 公共那门"半语言"：只有节点表与洞的类别，**没有词法**（`tokens` 是空表）。
 * 它不能直接拿去解析 —— 它是给 `extend(commonLang, delta)` 当底座的。
 */
export const commonLang = defineLang({
  name: 'common',
  doc: '公共节点库：表达式那七格 + 语句那几格（C 系默认拼法）',
  classes: COMMON_CLASSES,
  subclass: COMMON_SUBCLASS,
  nodes: COMMON_NODES,
  scope: COMMON_SCOPE,
  tokens: [],
  start: 'block',
});

/** 一门语言"离公共有多远"：改了几格、加了几格、原样用了几格。 */
export function distanceFrom(base, lang) {
  const baseNames = new Set(base.nodes.map((n) => n.name));
  let same = 0;
  let replaced = 0;
  for (const n of lang.nodes) {
    if (!baseNames.has(n.name)) continue;
    if (n.replaces === true) replaced += 1;
    else same += 1;
  }
  return { same, replaced, added: lang.nodes.length - same - replaced };
}
