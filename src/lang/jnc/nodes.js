// src/lang/jnc/nodes.js —— jancy 的**节点表**（第一族：声明的骨架）
//
// 走 GLR，所以这张表**只有形状**（名字 + 洞 + 洞的类别），拼法在 `frontend-jnc/jnc.grammar` 里
// —— 语法文件里每条产生式的动作头就是这儿的节点名（`(-> ("import" LITERAL) (import $2))`
// 里那个 `import`），**名字就是桥**（ADR-0030 第 5 节）。
//
// 顺序按量出来的清单推（`node tests/lib/jnc-heads.js`：40 份语料 112 个名字 / 10141 个节点）。
// 这一刀收头一族 —— 声明的骨架，占了一半以上的节点数。

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
  { name: 'agg', of: 'item', holes: { kind: 'exp', name: 'exp', bases: 'spec', body: 'block' } },
  { name: 'special', of: 'exp', holes: { text: 'exp' } },
  { name: 'no-type', of: 'spec', holes: {} },
  { name: 'accessor', of: 'exp', holes: { text: 'exp' } },
  { name: 'exprs', of: 'exp', holes: { first: 'exp?' } },
  { name: 'exprs-add', of: 'exp', holes: { list: 'exp', one: 'exp' } },
  { name: 'case', of: 'stat', holes: { value: 'exp' } },
  // 第三批（形状照 `node tests/lib/jnc-shape.js` 量出来的填）
  { name: 'enum', of: 'item', holes: { kind: 'exp', name: 'exp', base: 'spec', body: 'item' } },
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
  { name: 'import', of: 'item', holes: { path: 'exp' } },
];

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
