// ext/gsl-shell/formula.js —— 公式子语言：**另一门语言，同一套驱动器**
//
// gsl-shell 的公式（`gdt.lm(data, "y ~ x1 + x2")`）不在 Lua 的语法里，它写在字符串里，
// 由 `expr-parse.lua` 自己解析。所以**不能**把它的节点塞进 `gslLang` —— 那会让
// `~` `|` `%` 在 Lua 侧凭空多出含义。正确的做法是另立一门语言：
//
//   词法表不同（`'…'` 是字面量、`[…]` 是标识符、名字里能有 `.` 和 `$`、没有注释）
//   算符表不同（`=` 是**比较**，`^` 是**左结合**，`and`/`or` 同档）
//   节点表不同（8 个节点，一类洞）
//
// 而 `parse.js` 的五台机器、`render.js`、`lang.js` 的派生索引 —— **一个字都不用改**。
// 这是"驱动器与语言无关"这句话最硬的一次检验（比方言增量硬：那儿还共用 Lua 的表）。
//
// 出处（行号是 gsl-shell 那两份文件里的）：
//   expr-parse.lua:131-140  schema          ::= expr '~' expr_list [enums] [conds] EOF
//   expr-parse.lua:141-150  schema_multivar ::= expr_list '~' …（y 那边是一串）
//   expr-parse.lua:118-130  enums ::= '|' ident_list　conds ::= ':' expr_list
//   expr-parse.lua:20-52    factor ::= ident | ident '(' expr ')' | literal | number
//                                    | '(' expr ')' | '%' ident
//   expr-parse.lua:68-96    expr：优先级爬升，一元 `-` **只在最外层**（`prio == 0`）
//   expr-lexer.lua:11,16    算符档次表，`max_oper_prio = 4`
//   expr-lexer.lua:96-128   词法：`'…'` 字面量、`%b[]` 标识符、名字含 `.`/`$`、数字

import { defineLang } from '../../src/core/frontend-engine/language.js';
import {
  h, l, nm, w, opt,
} from '../../src/core/frontend-engine/syntax.js';
import {
  reRule, nameRule, numberRule, symbolRule, LexError,
} from '../../src/core/frontend-engine/lexrules.js';

// ── 词法表 ──────────────────────────────────────────────────────────────────
const F_NAME = /[A-Za-z_][A-Za-z0-9_.$]*/y;            // 名字里有 `.` 和 `$`（:118）
const F_NUM = /\d+\.?\d*(?:[Ee][-+]?\d+)?/y;           // 照 :122-127

/** `'…'`：字面量，不认转义，也不许空（`'[^']+'`，:100-103）。 */
const literalRule = {
  name: 'literal',
  kind: 'string',
  take: (src, i, ctx) => {
    if (src[i] !== "'") return null;
    const end = src.indexOf("'", i + 1);
    if (end < 0) throw new LexError('字面量没关上', ctx.line);
    if (end === i + 1) throw new LexError('字面量不能为空', ctx.line);
    return { value: src.slice(i + 1, end), end: end + 1 };
  },
};

/** `[…]`：**标识符**（列名里有空格时这么写；`%b[]` 平衡括号，:104-107）。 */
const bracketNameRule = {
  name: 'bracket-name',
  kind: 'name',
  take: (src, i, ctx) => {
    if (src[i] !== '[') return null;
    let depth = 0;
    let k = i;
    for (; k < src.length; k += 1) {
      if (src[k] === '[') depth += 1;
      else if (src[k] === ']') { depth -= 1; if (depth === 0) break; }
    }
    if (depth !== 0) throw new LexError('[…] 没关上', ctx.line);
    return { value: src.slice(i + 1, k), end: k + 1 };
  },
};

export const FORMULA_TOKENS = [
  reRule('space', /[ \t\r\n]+/y, { skip: true }),
  literalRule,
  bracketNameRule,
  numberRule(F_NUM),
  nameRule(F_NAME),
  symbolRule(),
];

// ── 算符表 ──────────────────────────────────────────────────────────────────
// 他们的档次是 0..4（`expr-lexer.lua:11`）；我这儿 `exp(0)` 起步、比较用 `>`，所以整体 +1。
// 三处与 Lua 不同，值得写下来：
//   1. `=` 是**比较**（不是赋值）；`!=` 是不等（Lua 是 `~=`）
//   2. `^` 是**左结合**（他们右操作数一律按 `prio+1` 解析，:89）—— Lua 的 `^` 右结合
//   3. `and` 与 `or` **同档**（都是 0）—— Lua 里 `and` 高于 `or`
//   4. `%` 不进算符表：它只是 enum 的前缀记号（他们给它 -1 档来保证它永远走不到二元那条路）
export const FORMULA_OPS = [
  { name: 'and', word: true, prec: 1, assoc: 'left' },
  { name: 'or', word: true, prec: 1, assoc: 'left' },
  { name: '=', prec: 2, assoc: 'left' },
  { name: '!=', prec: 2, assoc: 'left' },
  { name: '>', prec: 2, assoc: 'left' },
  { name: '>=', prec: 2, assoc: 'left' },
  { name: '<', prec: 2, assoc: 'left' },
  { name: '<=', prec: 2, assoc: 'left' },
  { name: '+', prec: 3, assoc: 'left' },
  // 一元 `-` 只在最外层（`prio == 0` ⇒ 我这儿 `limit === 0`），操作数按"比较档及以下"解析
  { name: '-', prec: 3, assoc: 'left', unary: true, onlyAt: 0 },
  { name: '*', prec: 4, assoc: 'left' },
  { name: '/', prec: 4, assoc: 'left' },
  { name: '^', prec: 5, assoc: 'left' },
];

// ── 节点表（8 个，一类洞 `exp` + 顶层 `top`）────────────────────────────────
export const FORMULA_NODES = [
  // 顶层两种：单变量（`y ~ …`）与多变量（`y, z ~ …`）。调用点决定用哪一个 ——
  // `gdt-lm.lua:207` 用 schema，`gdt-plot.lua:379` 用 schema_multivar。
  {
    name: 'schema',
    of: 'top',
    syn: [h('y'), '~', l('x'), opt('|', nm('enums')), opt(':', l('conds'))],
  },
  {
    name: 'schema-multi',
    of: 'top',
    syn: [l('y'), '~', l('x'), opt('|', nm('enums')), opt(':', l('conds'))],
  },
  // `f(x)` 要排在 `ident` 前面：两者都以一个裸名字起头，靠有序选择 + 回溯分开
  { name: 'func-eval', of: 'exp', syn: [w('func'), '(', h('arg'), ')'] },
  { name: 'ident', of: 'exp', syn: [{ t: 'name', as: 'value' }] },
  { name: 'number', of: 'exp', syn: [{ t: 'number', as: 'value' }] },
  { name: 'literal', of: 'exp', syn: [{ t: 'string', as: 'value' }] },
  { name: 'enum-ref', of: 'exp', syn: ['%', w('name')] },
  { name: 'paren', of: 'exp', syn: ['(', h('inner'), ')'] },
  { name: 'prefix', of: 'exp', unary: true, syn: [{ o: 'op' }, h('a')] },
  { name: 'binop', of: 'exp', binary: true, syn: [h('a'), { o: 'op' }, h('b')] },
];

/** 公式里的字符串写回去用单引号（他们的词法只认这一种，也不认转义）。 */
const formulaStr = (s) => `'${s}'`;

/** 名字里有空格/点号之类就得写成 `[…]`（照 `expr-print.lua:11` 的 `is_ident_simple`）。 */
const formulaIdent = (s) => (/^[A-Za-z_][A-Za-z0-9_.$]*$/.test(s) ? s : `[${s}]`);

export const formulaLang = defineLang({
  name: 'gsl-formula',
  doc: 'gsl-shell 的公式子语言（写在 Lua 字符串里，出处 expr-parse.lua）',
  keywords: [],
  ops: FORMULA_OPS,
  punct: ['(', ')', '~', ',', '|', ':', '%'],
  unaryPrec: 1,                    // 一元的操作数按"比较档及以下"解析（= 他们的 expr(1)）
  classes: ['top', 'exp'],
  subclass: {},
  nodes: FORMULA_NODES,
  tokens: FORMULA_TOKENS,
  start: 'schema',
  str: formulaStr,
  ident: formulaIdent,
});

/**
 * **嵌套语言表**：哪个函数的第几个实参是公式，用哪个起点解析。
 * 出处是 gsl-shell 自己的调用点（行号在案）。这张表是数据 —— 于是"字符串里嵌 DSL"
 * 也是一条规则，不是一段特判。
 */
export const EMBEDDED = [
  { fn: 'gdt.lm', arg: 2, lang: 'gsl-formula', start: 'schema', src: 'gdt-lm.lua:207' },
  { fn: 'gdt.plot', arg: 2, lang: 'gsl-formula', start: 'schema-multi', src: 'gdt-plot.lua:379' },
  { fn: 'gdt.xyplot', arg: 2, lang: 'gsl-formula', start: 'schema-multi', src: 'gdt-plot.lua:430' },
  { fn: 'gdt.barplot', arg: 2, lang: 'gsl-formula', start: 'schema', src: 'gdt-plot.lua:397' },
  { fn: 'gdt.hist', arg: 2, lang: 'gsl-formula', start: 'exp', src: 'gdt-hist.lua:14' },
];
