// ext/lua/nodes.js —— Lua 的**节点表**（`syn` 的词汇与驱动器都在 src/core/frontend-engine）
//
// 每个节点写三样：`of`（属于哪类洞）、`syn`（具体语法）、算符那两格（`prec` 在 tokens.js）。
// 洞的**类别**是这套设计的关键：它把"哪儿能放什么"变成数据 —— `f().x = 1` 合法、
// `f() = 1` 不合法，是"赋值左边要 `var` 类、而 `call` 不属于 `var` 类"这一条规则的自动结论。

import {
  h, l, nm, w, opt, rep,
} from '../../src/core/frontend-engine/syntax.js';

export {
  h, l, nm, w, opt, rep,
};

/**
 * 洞的类别的**上位关系**：`var` 是 `prefixexp` 的一种，`prefixexp` 是 `exp` 的一种。
 * 于是节点只申报自己**最窄**的那一类，宽的自动成立 —— 组合规则不用抄第二遍。
 */
export const LUA_SUBCLASS = { var: 'prefixexp', prefixexp: 'exp' };

/** 全部洞的类别。 */
export const LUA_CLASSES = ['exp', 'prefixexp', 'var', 'funcbody', 'block', 'field', 'stat'];

const S = (name, o) => ({ name, ...o });

/** 节点表。`syn` 的次序 = 源码里的次序 = 例子生成器枚举的次序。 */
export const LUA_NODES = [
  // ── 值（叶子）────────────────────────────────────────────────────────────
  S('nil', { of: 'exp', syn: ['nil'] }),
  S('true', { of: 'exp', syn: ['true'] }),
  S('false', { of: 'exp', syn: ['false'] }),
  S('number', { of: 'exp', syn: [{ t: 'number', as: 'value' }] }),
  S('string', { of: 'exp', syn: [{ t: 'string', as: 'value' }] }),
  S('vararg', { of: 'exp', syn: ['...'] }),
  S('name', { of: 'var', syn: [{ t: 'name', as: 'value' }] }),

  // ── 表达式（组合）────────────────────────────────────────────────────────
  // `a.b` 与 `a["b"]` 是**同一个节点**（`dot` 只是写法）—— 不开第二个节点。
  S('index', {
    of: 'var',
    suffix: true,
    syn: [h('obj', 'prefixexp'), '[', h('key'), ']'],
    synDot: [h('obj', 'prefixexp'), '.', w('key')],
  }),
  S('call', {
    of: 'prefixexp',
    suffix: true,
    syn: [h('fn', 'prefixexp'), '(', l('args', 'exp', { min: 0 }), ')'],
  }),
  S('method-call', {
    of: 'prefixexp',
    suffix: true,
    syn: [h('obj', 'prefixexp'), ':', w('method'), '(', l('args', 'exp', { min: 0 }), ')'],
  }),
  S('paren', { of: 'prefixexp', syn: ['(', h('inner'), ')'] }),
  S('prefix', { of: 'exp', unary: true, syn: [{ o: 'op' }, h('a')] }),
  S('binop', { of: 'exp', binary: true, syn: [h('a'), { o: 'op' }, h('b')] }),
  S('function-exp', { of: 'exp', syn: ['function', h('body', 'funcbody')] }),
  // 表构造的分隔符是 `,` **或** `;`，还允许尾随一个 —— 这三句是列表洞上的三格数据
  // （`sep` / `alt` / `trail`），不是解析器里的分支。出处：Lua 5.1 手册 §2.5.7。
  S('table', {
    of: 'exp',
    syn: ['{', l('fields', 'field', { min: 0, alt: [';'], trail: true }), '}'],
  }),

  // ── 表构造里的三种格（`field` 类）────────────────────────────────────────
  S('field-index', { of: 'field', syn: ['[', h('k'), ']', '=', h('v')] }),
  S('field-name', { of: 'field', syn: [w('key'), '=', h('v')] }),
  S('field-item', { of: 'field', syn: [h('v')] }),

  // ── 函数体与块（两个"容器"类）────────────────────────────────────────────
  S('funcbody', {
    of: 'funcbody',
    syn: ['(', nm('names', { min: 0, vararg: true }), ')', h('body', 'block'), 'end'],
  }),
  S('block', { of: 'block', syn: [{ b: 'stats' }] }),

  // ── 语句 ────────────────────────────────────────────────────────────────
  S('local-function', { of: 'stat', syn: ['local', 'function', nm('names', { max: 1 }), h('body', 'funcbody')] }),
  S('local', { of: 'stat', syn: ['local', nm('names'), opt('=', l('init'))] }),
  S('do', { of: 'stat', syn: ['do', h('body', 'block'), 'end'] }),
  S('while', { of: 'stat', syn: ['while', h('cond'), 'do', h('body', 'block'), 'end'] }),
  S('repeat', { of: 'stat', syn: ['repeat', h('body', 'block'), 'until', h('cond')] }),
  S('if', {
    of: 'stat',
    syn: ['if', h('cond'), 'then', h('then', 'block'),
      rep('elseif', h('elifCond'), 'then', h('elifBody', 'block')),
      opt('else', h('else', 'block')), 'end'],
  }),
  S('for-num', {
    of: 'stat',
    syn: ['for', nm('names', { max: 1 }), '=', h('from'), ',', h('to'),
      opt(',', h('step')), 'do', h('body', 'block'), 'end'],
  }),
  S('for-in', {
    of: 'stat',
    syn: ['for', nm('names'), 'in', l('exprs'), 'do', h('body', 'block'), 'end'],
  }),
  S('function', {
    of: 'stat',
    // `function a.b.c:m() … end`：Lua 里函数名**不是**任意 `var`（`function a[1]()` 不合法），
    // 它就是"名字用点连起来的一串"，末尾可选 `:方法`。写成一个带 `sep:'.'` 的名字表 ——
    // 于是不用为它新开一类洞，也不用在解析器里写特例。出处：Lua 5.1 手册 §8 的 `funcname`。
    syn: ['function', nm('path', { sep: '.' }), opt(':', w('method')), h('body', 'funcbody')],
  }),
  S('return', { of: 'stat', last: true, syn: ['return', opt(l('values'))] }),
  S('break', { of: 'stat', last: true, syn: ['break'] }),
  S('goto', { of: 'stat', syn: ['goto', w('label')] }),
  S('label', { of: 'stat', syn: ['::', w('label'), '::'] }),
  // 语句位置**只收 call / method-call**（不是任意 prefixexp）—— `x` 单独一行不是语句。
  S('call-stat', { of: 'stat', syn: [h('call', 'prefixexp', { only: ['call', 'method-call'] })] }),
  S('assign', { of: 'stat', syn: [l('targets', 'var'), '=', l('values')] }),
];
