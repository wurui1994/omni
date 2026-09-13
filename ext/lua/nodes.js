// ext/lua/nodes.js —— 语法：**节点表**。洞的类别是数据，成员关系与"怎么写出来"都是算出来的
//
// 每个节点写三样（DESIGN.md 第 3 节，实现时把第四样去掉了 —— 见下）：
//
//   of    它**属于**哪一类洞（一个名字；上位类由 SUBCLASS 自动推）
//   syn   它的**具体语法**：一串"字面记号 / 洞 / 名字表 / 可选组 / 重复组"
//   prec  只有算符要（档次在 tokens.js 的 OPS 里，这儿不抄第二遍）
//
// 设计稿里本来还有一栏 `text`（怎么写出来，例子生成器要用）。写到这儿发现那是**重复的**：
// `syn` 已经把次序与字面量说全了，`render()` 读同一张表就能写回源码。于是删掉 `text` ——
// 一份数据两个方向用（parse.js 读它认，render() 读它写），**这才是"规则化"该有的样子**；
// 两份手写的表迟早对不上（jancy 那边 38 条账号的措辞对不上就是这么来的，见 ADR-0029 10.14）。
//
// 关键的一句：**"哪儿能放什么"全在洞的类别里**。`f().x = 1` 合法、`f() = 1` 不合法，
// 不是两条检查，是"赋值左边是 `var` 类的洞、而 `call` 不属于 `var` 类"这一条规则的自动结论。

/**
 * 洞的类别的**上位关系**：`var` 是 `prefixexp` 的一种，`prefixexp` 是 `exp` 的一种。
 * 于是节点只申报自己**最窄**的那一类，宽的自动成立 —— 组合规则不用抄第二遍。
 */
export const LUA_SUBCLASS = { var: 'prefixexp', prefixexp: 'exp' };

/** 全部洞的类别。 */
export const LUA_CLASSES = ['exp', 'prefixexp', 'var', 'funcbody', 'block', 'field', 'stat'];

// ── `syn` 里的词汇（构造器，读起来短一点）────────────────────────────────────
/** 一个洞：`h('cond')` 默认 `exp` 类。 */
export const h = (name, cls = 'exp', extra = {}) => ({ h: name, cls, ...extra });
/** 一串同类的洞，逗号分隔（`min:0` 允许空）。 */
export const l = (name, cls = 'exp', extra = {}) => ({
  l: name, cls, sep: ',', min: 1, ...extra,
});
/** 一串**名字**（绑定用；`vararg:true` 时末尾可以是 `...`）。 */
export const nm = (name, extra = {}) => ({ n: name, sep: ',', min: 1, ...extra });
/** 一个**裸名字**（不是绑定，也不是表达式：`a.b` 的 `b`、`goto l` 的 `l`）。 */
export const w = (name) => ({ w: name });
/** 可选组：下一个记号对得上组里第一项就取。 */
export const opt = (...items) => ({ opt: items });
/** 重复组（0 次或多次）：组里的洞各自收成数组。 */
export const rep = (...items) => ({ rep: items });

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
