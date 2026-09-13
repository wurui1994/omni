// src/lang/jnc/nodes.js —— jancy 的**节点表**（全表：语料里的 148 个名字全在这儿）
//
// 走 GLR，所以这张表**只有形状**（名字 + 洞 + 洞的类别），拼法在 `frontend-jnc/jnc.grammar` 里
// —— 语法文件里每条产生式的动作头就是这儿的节点名（`(-> ("import" LITERAL) (import $2))`
// 里那个 `import`），**名字就是桥**（ADR-0030 第 5 节）。
//
// 顺序按量出来的清单推（`node tests/lib/jnc-heads.js`）—— 先声明的骨架（占一半以上节点），
// 再语句与表达式，最后一批把尾巴上那 70 多个低频名字一次填掉。
// 现在的数：**660 份语料、148 个名字、476786 个节点，覆盖 100%，形状分歧 0**。

import { extend } from '../../core/frontend-engine/language.js';
import { commonShapeLang } from '../../core/frontend-engine/common-nodes.js';

/** jancy 自己的洞类：声明那一摊（`dcl` 是"一个声明子"，`spec` 是"类型/修饰词那一串"）。 */
export const JNC_CLASSES = ['dcl', 'spec', 'suffix', 'formal', 'item'];

/**
 * 形状表。`holes` 的类别可带后缀（`*` 一串、`?` 可缺），与公共库同一套写法。
 * 注意这儿**不写拼法** —— 那在 `.grammar` 里，这张表管的是"节点长什么样、洞是哪几格"。
 */
export const JNC_SHAPES = [
  // 单元与声明的骨架
  // GLR 的列表是**左递归**：一个空基例（`unit`、`mods`、`ptrs`…）加一格 `-add` 递归。
  // 这一形状是量出来的（`node tests/lib/jnc-shape.js`）—— 先前我按"一格列表洞"写，全错。
  { name: 'unit', of: 'block', holes: {} },
  { name: 'unit-add', of: 'item', holes: { list: 'block', one: 'item' } },
  { name: 'var-decl', of: 'stat', holes: { specs: 'spec', dcls: 'dcl*' } },
  { name: 'fn-def', of: 'item', holes: { specs: 'spec', dcl: 'dcl', body: 'block?' } },
  { name: 'dcl', of: 'dcl', holes: { ptrs: 'spec', name: 'exp', suffixes: 'suffix', ctor: 'suffix?' } },
  { name: 'dcls', of: 'dcl', holes: { first: 'dcl' } },
  { name: 'dcls-add', of: 'dcl', holes: { list: 'dcl', one: 'dcl' } },
  { name: 'init', of: 'dcl', holes: { dcl: 'dcl', value: 'exp' } },
  // 修饰词与类型说明那一串
  { name: 'mods', of: 'spec', holes: {} },
  { name: 'mods-add', of: 'spec', holes: { list: 'spec', one: 'spec' } },
  // `specs` 有几条产生式（树里见过 0/2/3 格）：类型那一格 + 前后两串修饰词
  { name: 'specs', of: 'spec', holes: { type: 'spec?', pre: 'spec?', post: 'spec?' } },
  { name: 'ptrs', of: 'spec', holes: {} },
  { name: 'ptr', of: 'spec', holes: { mods: 'spec' } },
  { name: 'basetype', of: 'spec', holes: { type: 'spec' } },
  // 声明子的后缀（函数的形参表、数组的下标）
  { name: 'suffixes', of: 'suffix', holes: {} },
  { name: 'suffixes-add', of: 'suffix', holes: { list: 'suffix', one: 'suffix' } },
  { name: 'fn-suffix', of: 'suffix', holes: { formals: 'formal' } },
  { name: 'array-suffix', of: 'suffix', holes: { size: 'exp?' } },
  { name: 'no-ctor', of: 'suffix', holes: {} },
  { name: 'ctor', of: 'suffix', holes: { args: 'exp?' } },
  { name: 'formals', of: 'formal', holes: { first: 'formal?' } },
  { name: 'formals-add', of: 'formal', holes: { list: 'formal', one: 'formal' } },
  // 第三格是默认值那一格（`void f(int x = 1)`）—— 仓库自带语料里量到的，外面那份没有
  { name: 'formal', of: 'formal', holes: { specs: 'spec', dcl: 'dcl', init: 'exp?' } },
  { name: 'formal-anon', of: 'formal', holes: { specs: 'spec', ptrs: 'spec' } },
  // 语句与表达式里最常见的那几格（公共库已有 block/if/while/return/break/assign/call/index）
  { name: 'compound', of: 'stat', holes: { body: 'block' } },
  { name: 'expr-stmt', of: 'stat', holes: { expr: 'exp' } },
  { name: 'args', of: 'exp', holes: { first: 'exp?' } },
  { name: 'args-add', of: 'exp', holes: { list: 'exp', one: 'exp' } },
  { name: 'field', of: 'var', holes: { obj: 'prefixexp', name: 'exp' } },
  // 下一批（形状都是量出来的，`node tests/lib/jnc-shape.js` 那三栏说的）
  { name: 'name', of: 'var', holes: { text: 'exp' }, replaces: true },
  { name: 'ptrs-add', of: 'spec', holes: { list: 'spec', one: 'spec' } },
  // jancy 的赋值**带算符**（`+=` 那一族），所以比公共库那一格多一位 —— 记一笔 replaces
  { name: 'assign', of: 'stat', holes: { op: 'exp', a: 'exp', b: 'exp' }, replaces: true },
  { name: 'binary', of: 'exp', holes: { op: 'exp', a: 'exp', b: 'exp' } },
  { name: 'return', of: 'stat', holes: { value: 'exp?' }, replaces: true, last: true },
  // jancy 的 `break`/`continue` 带层数（`break 2`），所以比公共库那一格多一位
  { name: 'break', of: 'stat', holes: { level: 'exp' }, replaces: true, last: true },
  { name: 'continue', of: 'stat', holes: { level: 'exp' }, last: true },
  // 再下一批（形状同样是量出来的）
  { name: 'items', of: 'item', holes: { first: 'item?' } },
  { name: 'items-add', of: 'item', holes: { list: 'item', one: 'item' } },
  { name: 'type-decl', of: 'item', holes: { agg: 'item' } },
  /* 洞名不能叫 `kind` —— `named()` 用 `kind` 这一格存"这是哪个节点"，撞名会把节点种类盖掉。
     `bases` 可缺：`class C {}`（没基类）语料里就有，先前写成必填，于是那种 agg 命名不了、
     上下文跟着掉回 global —— 那 1 格 `global × override` 就是这么来的。 */
  { name: 'agg', of: 'item', holes: { word: 'exp', name: 'exp', bases: 'spec?', body: 'block' } },
  { name: 'special', of: 'exp', holes: { text: 'exp' } },
  { name: 'no-type', of: 'spec', holes: {} },
  { name: 'accessor', of: 'exp', holes: { text: 'exp' } },
  { name: 'exprs', of: 'exp', holes: { first: 'exp?' } },
  { name: 'exprs-add', of: 'exp', holes: { list: 'exp', one: 'exp' } },
  { name: 'case', of: 'stat', holes: { value: 'exp' } },
  // 第三批（形状照 `node tests/lib/jnc-shape.js` 量出来的填）
  { name: 'enum', of: 'item', holes: { word: 'exp', name: 'exp', base: 'spec?', body: 'item' } },
  { name: 'enums', of: 'item', holes: { first: 'item' } },
  { name: 'enums-add', of: 'item', holes: { list: 'item', one: 'item' } },
  { name: 'enum-item', of: 'item', holes: { name: 'exp', value: 'exp?' } },
  { name: 'qualified', of: 'var', holes: { left: 'exp', right: 'exp' } },
  { name: 'qualified-special', of: 'var', holes: { left: 'exp', right: 'exp' } },
  { name: 'concat', of: 'exp', holes: { a: 'exp', b: 'exp' } },
  { name: 'unary', of: 'exp', holes: { op: 'exp', a: 'exp' }, unary: true },
  { name: 'type-name', of: 'spec', holes: { specs: 'spec', ptrs: 'spec' } },
  { name: 'bases', of: 'spec', holes: {} },
  { name: 'fn-proto', of: 'item', holes: { specs: 'spec', dcl: 'dcl' } },
  { name: 'for', of: 'stat', holes: { init: 'stat', cond: 'exp', step: 'exp', body: 'block' } },
  /* `import "x.jnc"` 一格；`import "libfoo.dylib" with "foo.h"` 两格（第二格是那个头文件）。 */
  { name: 'import', of: 'item', holes: { path: 'exp', header: 'exp?' } },
  // ---- 第四批：清单尾巴上那 70 多个低频名字 -------------------------------------
  // 形状全是从 `.grammar` 的动作头**数出来**的（`(-> (qname "<" targs ">") (tinst $1 $3))`
  // 就是两格洞），填完再由形状尺子回量 —— 猜的部分交给尺子，不交给运气。
  // 泛型那一族（jnc.grammar:389-399，ADR-0025 的 S1）
  { name: 'tinst', of: 'spec', holes: { name: 'exp', targs: 'spec' } },
  { name: 'targs', of: 'spec', holes: { first: 'spec' } },
  { name: 'targs-add', of: 'spec', holes: { list: 'spec', one: 'spec' } },
  // 第二格是默认类型（`class RbTree<K, V, C = stdt.Lt<K> >`）
  { name: 'targ', of: 'spec', holes: { type: 'spec', deflt: 'spec?' } },
  // 限定名表（基类表就是它：`class C: A, B`）
  { name: 'qnames', of: 'spec', holes: { first: 'exp' } },
  { name: 'qnames-add', of: 'spec', holes: { list: 'spec', one: 'exp' } },
  { name: 'no-base', of: 'spec', holes: {} },
  // 声明那一摊剩下的几格
  { name: 'namespace', of: 'item', holes: { name: 'exp', body: 'block' } },
  { name: 'extension', of: 'item', holes: { name: 'exp', bases: 'spec', body: 'block' } },
  { name: 'dylib', of: 'item', holes: { name: 'exp', body: 'block' } },
  { name: 'using-namespace', of: 'item', holes: { name: 'exp' } },
  { name: 'using-extension', of: 'item', holes: { name: 'exp' } },
  { name: 'friend', of: 'item', holes: { name: 'exp' } },
  { name: 'access', of: 'item', holes: { word: 'exp' } },
  { name: 'typedef', of: 'item', holes: { specs: 'spec', dcls: 'dcl' } },
  { name: 'var-decl-curly', of: 'stat', holes: { specs: 'spec', dcl: 'dcl', value: 'exp' } },
  { name: 'ref-init', of: 'dcl', holes: { dcl: 'dcl', value: 'exp' } },
  { name: 'pragma', of: 'item', holes: { args: 'exp' } },
  { name: 'pragma-default', of: 'exp', holes: {} },
  // 属性块（`[ displayName = "Name" ]`）挂在后面那条声明上
  { name: 'attrs', of: 'item', holes: { first: 'item' } },
  { name: 'attrs-add', of: 'item', holes: { list: 'item', one: 'item' } },
  { name: 'attr', of: 'item', holes: { name: 'exp', value: 'exp?' } },
  { name: 'attr-ref', of: 'item', holes: { name: 'exp' } },
  { name: 'attributed', of: 'item', holes: { attrs: 'item', decl: 'item' } },
  // 类型说明那一摊
  { name: 'abstract-class', of: 'spec', holes: {} },
  { name: 'property-template', of: 'spec', holes: { body: 'block' } },
  { name: 'typeof', of: 'spec', holes: { arg: 'spec' } },
  { name: 'fn-type', of: 'spec', holes: { specs: 'spec', ptrs: 'spec', formals: 'formal' } },
  { name: 'anon', of: 'exp', holes: {} },
  // 声明符的后缀里还差两格
  { name: 'post-modifier', of: 'suffix', holes: { word: 'exp' } },
  { name: 'bitfield', of: 'suffix', holes: { bits: 'exp' } },
  { name: 'formals-varargs', of: 'formal', holes: { formals: 'formal' } },
  // 特殊名（`operator +`、`operator ()`、`operator int*`）
  { name: 'operator', of: 'exp', holes: { op: 'exp' } },
  { name: 'postfix-operator', of: 'exp', holes: { op: 'exp' } },
  { name: 'call-op', of: 'exp', holes: {} },
  { name: 'index-op', of: 'exp', holes: {} },
  { name: 'cast-op', of: 'exp', holes: { specs: 'spec', ptrs: 'spec' } },
  // 语句那一摊剩下的
  { name: 'empty-stmt', of: 'stat', holes: {} },
  { name: 'switch', of: 'stat', holes: { value: 'exp', body: 'block' } },
  { name: 'default', of: 'stat', holes: {} },
  // `catch:` / `finally:` / `nestedscope:` —— 三个都是"一格词的标签"（jnc.grammar:594-596）
  { name: 'label', of: 'stat', holes: { word: 'exp' } },
  { name: 'try', of: 'stat', holes: { body: 'block' } },
  { name: 'unsafe', of: 'stat', holes: { body: 'block' } },
  { name: 'once', of: 'stat', holes: { body: 'stat' } },
  { name: 'throw', of: 'stat', holes: { value: 'exp?' }, last: true },
  { name: 'do', of: 'stat', holes: { body: 'block', cond: 'exp' } },
  // 第二格是 `assert(x, "话")` 里那句话
  { name: 'assert', of: 'stat', holes: { cond: 'exp', msg: 'exp?' } },
  { name: 'none', of: 'exp', holes: {} },
  // 动态布局那一族（`dylayout (layout) { dyfield Hdr hdr; }`，jnc.grammar:605-609）
  { name: 'dylayout', of: 'stat', holes: { layout: 'exp', body: 'block' } },
  { name: 'dyfield', of: 'stat', holes: { name: 'exp', body: 'block' } },
  { name: 'onevent', of: 'item', holes: { event: 'exp', formals: 'formal', body: 'block' } },
  { name: 'events', of: 'exp', holes: { first: 'exp' } },
  { name: 'events-list', of: 'exp', holes: { list: 'exp' } },
  // 表达式那一摊剩下的
  { name: 'cond', of: 'exp', holes: { cond: 'exp', a: 'exp', b: 'exp' } },
  { name: 'addr', of: 'exp', holes: { a: 'exp' }, unary: true },
  { name: 'indirect', of: 'exp', holes: { a: 'exp' }, unary: true },
  { name: 'pre-inc', of: 'exp', holes: { a: 'exp' }, unary: true },
  { name: 'pre-dec', of: 'exp', holes: { a: 'exp' }, unary: true },
  { name: 'post-inc', of: 'exp', holes: { a: 'exp' }, suffix: true },
  { name: 'post-dec', of: 'exp', holes: { a: 'exp' }, suffix: true },
  { name: 'await', of: 'exp', holes: { a: 'exp' }, unary: true },
  { name: 'try-expr', of: 'exp', holes: { a: 'exp' }, unary: true },
  { name: 'new', of: 'exp', holes: { type: 'spec', args: 'exp?' } },
  { name: 'new-array', of: 'exp', holes: { type: 'spec', size: 'exp' } },
  { name: 'new-curly', of: 'exp', holes: { type: 'spec', init: 'exp' } },
  { name: 'cast', of: 'exp', holes: { type: 'spec', value: 'exp' } },
  { name: 'dynamic-cast', of: 'exp', holes: { type: 'spec', value: 'exp' } },
  { name: 'call-operator-new', of: 'exp', holes: { fn: 'exp', args: 'exp' } },
  { name: 'ptr-field', of: 'var', holes: { obj: 'prefixexp', name: 'exp' } },
  { name: 'this', of: 'exp', holes: {} },
  { name: 'true', of: 'exp', holes: {} },
  { name: 'false', of: 'exp', holes: {} },
  { name: 'null', of: 'exp', holes: {} },
  { name: 'char', of: 'exp', holes: { text: 'exp' } },
  { name: 'fmt', of: 'exp', holes: { text: 'exp' } },
  { name: 'capture', of: 'exp', holes: { text: 'exp' } },
  { name: 'unbound', of: 'exp', holes: {} },
  // `sizeof` 那一族：括号里既能是类型也能是表达式（`type-or-expr`），所以洞类写 `spec`
  { name: 'sizeof', of: 'exp', holes: { arg: 'spec' } },
  { name: 'countof', of: 'exp', holes: { arg: 'spec' } },
  { name: 'typeof-expr', of: 'exp', holes: { arg: 'spec' } },
  { name: 'declof', of: 'exp', holes: { arg: 'spec' } },
  { name: 'offsetof', of: 'exp', holes: { arg: 'exp' } },
  { name: 'bindingof', of: 'exp', holes: { arg: 'exp' } },
  { name: 'dynamic-sizeof', of: 'exp', holes: { arg: 'exp' } },
  { name: 'dynamic-countof', of: 'exp', holes: { arg: 'exp' } },
  { name: 'dynamic-typeof', of: 'exp', holes: { arg: 'exp' } },
  { name: 'dynamic-offsetof', of: 'exp', holes: { arg: 'exp' } },
  // 花括号初始化（`{ 1, 2, [3] = 4, m_y = 5 }`，空位是一格 `skip-item`）
  { name: 'curly', of: 'exp', holes: { items: 'item' } },
  { name: 'skip-item', of: 'item', holes: {} },
  { name: 'named-item', of: 'item', holes: { name: 'exp', value: 'exp' } },
  { name: 'indexed-item', of: 'item', holes: { index: 'exp', value: 'exp' } },
  /* 规整之后的**记号**那一格（`normalize.js`）：关键字、字面量、算符都归它。
     树里没有这个头名（GLR 那边记号就是记号），表里有它是为了让通用驱动器
     碰到叶子时按"没有洞的节点"走，而不是当特例。 */
  { name: 'tok', of: 'exp', holes: {} },
];

/**
 * **哪些节点开哪种声明上下文**（三格：global / member / local，见 syntax.js 的 CONTEXTS）。
 * 这是一张表，不是走树时的 if —— 谁开一层由数据说。
 * 体外成员（`void C.f() override {}`）在树上长在顶层，但语义上是**成员**：
 * 它的声明符名字是个限定名（`qualified`），所以那一格也在这张表里（`byName`）。
 */
/*
 * **洞级**，不是节点级（这一格是尺子逼出来的）：`agg` 那个节点里只有 `body` 那一格是成员位置，
 * `name` 与 `bases` 两格仍是外面那层。先前按"节点头名"一刀切，于是
 * `class C1: I1 { override void foo() {…} }` 里的 `override` 被算成了 global —— 差一格。
 * 键写成 `节点.洞`。
 */
export const JNC_CTX_OPENS = {
  'agg.body': 'member',
  'enum.body': 'member',
  'extension.body': 'member',
  'dylib.body': 'member',
  'property-template.body': 'member',
  'compound.body': 'local',
};

/** 声明符的名字是限定名（`a.b`）时，这条声明算**成员**（体外成员定义）。 */
export const JNC_MEMBER_BY_NAME = ['qualified', 'qualified-special'];

/** jancy 这门语言（第一族）。拼法在 `.grammar`，所以 `parser: 'glr'`。 */
export const jncLang = extend(commonShapeLang, {
  name: 'jnc',
  doc: 'jancy：GLR 认拼法，这张表只给形状（ADR-0030 第 3/5 节，第一族：声明的骨架）',
  classes: JNC_CLASSES,
  nodes: JNC_SHAPES.map((s) => {
    /* 形状表里那几格标记要**带过去**（`replaces` 尤其 —— 它是"我改了公共库这一格"的凭据，
       丢了它 `extend` 会当撞名炸掉）。 */
    const node = { name: s.name, of: s.of, holes: s.holes ?? {} };
    for (const k of ['replaces', 'last', 'unary', 'binary', 'suffix']) {
      if (s[k] !== undefined) node[k] = s[k];
    }
    return node;
  }),
  parser: 'glr',
});
