// src/lang/jnc/scope.js —— jancy 的**作用域配方 + 上下文规则**（语义那一摊的头一张表）
//
// 驱动器是通用的那一份（`frontend-engine/bind.js`）：它认四个词 ——
// `'open'` 开一层、`'bind:<洞名>'` 把那一格的名字绑进当前这层、`'<洞名>'` 走那一格、
// `'inline:<洞名>'` 走那一格的 block 但不让它自己开一层。没写配方的节点按洞的次序走
// （那是默认值，不是特例）。所以这一份**只有数据**，一行控制流都没有。
//
// 输入的树是规整过的（`normalize.js`）。三处值得先说清：
//   1. **声明符里的名字不是引用**。`dcl` 的配方刻意不走 `name` 那一格 —— 那是"这里定义了它"，
//      走进去会被驱动器当成一次查名，凭空多出几万次假引用。
//   2. **先走初始化式，再绑名字**。`var-decl` 的配方是 `specs → dcls → bind:dcls`：
//      `int x = x;` 里右边那个 x 该查外层（与 jancy 的 declareData 次序一致）。
//   3. **形参绑在函数那一层**。`fn-def` 先 `bind:dcl`（函数名进外层）再 `open`，
//      形参在 `dcl` 的后缀里，于是随着走 `dcl` 落进新开的那层。

import { extend } from '../../core/frontend-engine/language.js';
import { jncLang } from './nodes.js';

/**
 * **怎么从"绑名字那一格"里读出名字**（核心的 `namesOf` 钩子，见 bind.js）。
 * 这一格在 jancy 里是棵子树（声明符 / 名字叶子 / 带初始化的声明符），不是字符串数组。
 * 限定名（`void C.f() {}` 的 `C.f`）**不算新名字** —— 那是给别处已有的成员补个体。
 */
export function jncNamesOf(v) {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap((x) => jncNamesOf(x));
  if (typeof v === 'string') return [v];
  switch (v.kind) {
    case 'name': return v.value === null || v.value === undefined ? [] : [v.value];
    case 'dcl': return jncNamesOf(v.name);
    case 'init': case 'ref-init': return jncNamesOf(v.dcl);
    case 'dcls': return jncNamesOf(v.first);
    default: return [];                       // 限定名、特殊名（construct/算符）都不新增名字
  }
}

/** 作用域配方。键是节点名，`steps` 是上面那四个词。 */
export const JNC_SCOPE = {
  // 声明：名字进当前这层
  'var-decl': { steps: ['specs', 'dcls', 'bind:dcls'] },
  'var-decl-curly': { steps: ['specs', 'dcl', 'value', 'bind:dcl'] },
  typedef: { steps: ['specs', 'bind:dcls'] },
  'fn-proto': { steps: ['specs', 'bind:dcl'] },
  // 函数：名字在外层，形参与体在新开的那一层（形参长在 `dcl` 的后缀里）
  'fn-def': { steps: ['specs', 'bind:dcl', 'open', 'dcl', 'body'] },
  // 声明符：**不走名字那一格**（那是定义，不是引用）
  dcl: { steps: ['ptrs', 'suffixes', 'ctor'] },
  formal: { steps: ['specs', 'dcl', 'init', 'bind:dcl'] },
  'formal-anon': { steps: ['specs', 'ptrs'] },
  // 类型与命名空间：自己是一层
  agg: { steps: ['bind:name', 'bases', 'open', 'body'] },
  enum: { steps: ['bind:name', 'base', 'open', 'body'] },
  'enum-item': { steps: ['value', 'bind:name'] },
  namespace: { steps: ['bind:name', 'open', 'body'] },
  dylib: { steps: ['bind:name', 'open', 'body'] },
  extension: { steps: ['bases', 'open', 'body'] },
  'property-template': { steps: ['open', 'body'] },
  // 语句里开层的那几格
  compound: { steps: ['open', 'body'] },
  for: { steps: ['open', 'init', 'cond', 'step', 'body'] },
  switch: { steps: ['value', 'open', 'body'] },
  onevent: { steps: ['event', 'open', 'formals', 'body'] },
  dylayout: { steps: ['layout', 'open', 'body'] },
  dyfield: { steps: ['open', 'body'] },
  try: { steps: ['open', 'body'] },
  unsafe: { steps: ['open', 'body'] },
};

/**
 * 上下文规则（"这儿能不能 break"这一类**位置**约束）。
 *
 * 明账：这一层只分得清"能不能跳出去"，分不清 `break` 与 `continue` 的差别 ——
 * `switch` 里 `break` 合法而 `continue` 是接着**外面那个循环**跑（jancy 的 Scope 标记
 * ScopeFlag_Break / ScopeFlag_Continue 两格分开记）。所以这儿给的是两格上下文：
 * 循环提供 `loop` + `breakable`，`switch` 只提供 `breakable` 与 `case`。
 */
export const JNC_CTX = {
  for: { provides: ['loop', 'breakable'] },
  while: { provides: ['loop', 'breakable'] },
  do: { provides: ['loop', 'breakable'] },
  switch: { provides: ['breakable', 'case'] },
  break: { needs: 'breakable', say: '这儿没有可以 break 出去的循环或 switch' },
  continue: { needs: 'loop', say: '这儿没有可以 continue 的循环' },
  case: { needs: 'case', say: 'case 只能写在 switch 里' },
  default: { needs: 'case', say: 'default 只能写在 switch 里' },
};

/** 带语义那一摊的 jancy（形状表在 `nodes.js`，这儿只加 scope / ctx / namesOf）。 */
export const jncSemLang = extend(jncLang, {
  name: 'jnc',
  doc: 'jancy：形状 + 作用域配方 + 上下文规则（ADR-0030 第 3 节）',
  scope: JNC_SCOPE,
  ctx: JNC_CTX,
  namesOf: jncNamesOf,
});
