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
  { name: 'unit', of: 'block', holes: { items: 'item*?' } },
  { name: 'unit-add', of: 'item', holes: { unit: 'block', decl: 'item' } },
  { name: 'var-decl', of: 'stat', holes: { specs: 'spec', dcls: 'dcl*' } },
  { name: 'fn-def', of: 'item', holes: { specs: 'spec', dcl: 'dcl', body: 'block?' } },
  { name: 'dcl', of: 'dcl', holes: { ptrs: 'spec?', name: 'exp', suffixes: 'suffix*?' } },
  { name: 'dcls', of: 'dcl', holes: { items: 'dcl*' } },
  { name: 'dcls-add', of: 'dcl', holes: { list: 'dcl', one: 'dcl' } },
  { name: 'init', of: 'dcl', holes: { dcl: 'dcl', value: 'exp' } },
  // 修饰词与类型说明那一串
  { name: 'mods', of: 'spec', holes: { items: 'spec*?' } },
  { name: 'mods-add', of: 'spec', holes: { list: 'spec', one: 'spec' } },
  { name: 'specs', of: 'spec', holes: { mods: 'spec?', type: 'spec?' } },
  { name: 'ptrs', of: 'spec', holes: { items: 'spec*?' } },
  { name: 'ptr', of: 'spec', holes: {} },
  { name: 'basetype', of: 'spec', holes: {} },
  // 声明子的后缀（函数的形参表、数组的下标）
  { name: 'suffixes', of: 'suffix', holes: { items: 'suffix*?' } },
  { name: 'suffixes-add', of: 'suffix', holes: { list: 'suffix', one: 'suffix' } },
  { name: 'fn-suffix', of: 'suffix', holes: { formals: 'formal*?' } },
  { name: 'array-suffix', of: 'suffix', holes: { size: 'exp?' } },
  { name: 'no-ctor', of: 'suffix', holes: {} },
  { name: 'ctor', of: 'suffix', holes: { args: 'exp*?' } },
  { name: 'formals', of: 'formal', holes: { items: 'formal*?' } },
  { name: 'formals-add', of: 'formal', holes: { list: 'formal', one: 'formal' } },
  { name: 'formal', of: 'formal', holes: { specs: 'spec', dcl: 'dcl' } },
  { name: 'formal-anon', of: 'formal', holes: { specs: 'spec' } },
  // 语句与表达式里最常见的那几格（公共库已有 block/if/while/return/break/assign/call/index）
  { name: 'compound', of: 'stat', holes: { body: 'block' } },
  { name: 'expr-stmt', of: 'stat', holes: { expr: 'exp' } },
  { name: 'args', of: 'exp', holes: { items: 'exp*?' } },
  { name: 'args-add', of: 'exp', holes: { list: 'exp', one: 'exp' } },
  { name: 'field', of: 'var', holes: { obj: 'prefixexp', name: 'exp' } },
];

/** jancy 这门语言（第一族）。拼法在 `.grammar`，所以 `parser: 'glr'`。 */
export const jncLang = extend(commonShapeLang, {
  name: 'jnc',
  doc: 'jancy：GLR 认拼法，这张表只给形状（ADR-0030 第 3/5 节，第一族：声明的骨架）',
  classes: JNC_CLASSES,
  nodes: JNC_SHAPES.map((s) => {
    const node = { name: s.name, of: s.of };
    if (s.holes !== undefined) node.holes = s.holes;
    return node;
  }),
  parser: 'glr',
});
