// ext/tiny/lang.js —— **一门语言只写增量**：C 系的 tiny，靠公共节点库拼出来
//
// 这一格是给"公共规则到底省不省"当证据的（ADR-0030 第 2/3 节）：tiny 的整门语言
// = 一张 6 行的记号表 + 一张 12 行的算符表 + **两个**自己的节点（`let` / `print`）。
// 表达式那七格、`block`/`assign`/`call-stat`/`if`/`while`/`return`/`break` 全是公共库
// 原样拿来的 —— 一格 `replaces` 都不用写，因为公共库给的默认拼法本来就是 C 系的。

import { extend } from '../../src/core/frontend-engine/language.js';
import { commonLang } from '../../src/core/frontend-engine/common-nodes.js';
import {
  reRule, nameRule, numberRule, symbolRule, quoted,
} from '../../src/core/frontend-engine/lexrules.js';
import { h, nm } from '../../src/core/frontend-engine/syntax.js';

const TINY_NAME = /[A-Za-z_]\w*/y;
const TINY_NUM = /\d+\.?\d*(?:[eE][-+]?\d+)?/y;

/** 记号表六行：空白、行注释、字符串、数、名字、符号。 */
export const TINY_TOKENS = [
  reRule('space', /[ \t\r\n]+/y, { skip: true }),
  reRule('comment', /\/\/[^\n]*/y, { skip: true }),
  {
    name: 'string',
    kind: 'string',
    take: (src, i, ctx) => {
      const q = quoted(src, i, ctx.line);
      return q === null ? null : { value: q.text, end: q.end };
    },
  },
  numberRule(TINY_NUM),
  nameRule(TINY_NAME),
  symbolRule(),
];

/** 算符表：档次照 C（`||` 最低、一元最高）。 */
export const TINY_OPS = [
  { name: '||', prec: 1, assoc: 'left' },
  { name: '&&', prec: 2, assoc: 'left' },
  { name: '==', prec: 3, assoc: 'left' },
  { name: '!=', prec: 3, assoc: 'left' },
  { name: '<', prec: 4, assoc: 'left' },
  { name: '>', prec: 4, assoc: 'left' },
  { name: '<=', prec: 4, assoc: 'left' },
  { name: '>=', prec: 4, assoc: 'left' },
  { name: '+', prec: 5, assoc: 'left' },
  { name: '-', prec: 5, assoc: 'left', unary: true },
  { name: '*', prec: 6, assoc: 'left' },
  { name: '/', prec: 6, assoc: 'left' },
  { name: '!', unary: true },
];

export const tinyLang = extend(commonLang, {
  name: 'mini',
  doc: 'C 系的小语言：let / print / if / while / 赋值 / 算术（公共节点库的第一个消费方）',
  keywords: ['let', 'print', 'if', 'else', 'while', 'return', 'break', 'true', 'false'],
  ops: TINY_OPS,
  punct: ['{', '}', '(', ')', '[', ']', ';', ',', '=', '.', '<=', '>=', '==', '!=', '&&', '||'],
  unaryPrec: 7,
  tokens: TINY_TOKENS,
  blockEnd: ['}'],
  nodes: [
    { name: 'let', of: 'stat', syn: ['let', nm('names', { max: 1 }), '=', h('init'), ';'] },
    { name: 'print', of: 'stat', syn: ['print', h('v'), ';'] },
  ],
  /* 作用域：`let` 的右边先算再绑（与 Lua 的 `local` 同一条配方）。块那条在公共库里。 */
  scope: { let: { steps: ['init', 'bind:names'] } },
});
