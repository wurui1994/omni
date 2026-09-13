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
    /* 泛型的头（`class Array<T> {}`）：那一格是 `tinst`，名字在它里头。少这一条，`Array`
       压根没绑上，于是体外定义 `void Array<T>.clear()` 也认不回来 —— 尺子上是 41 处
       `m_count` 查不着（stdt_Array.jnc）。先前我只补了 `ownerOf` 那一头，**量出来一格没动**：
       东家查不着的原因在这一头。 */
    case 'tinst': return jncNamesOf(v.name);
    default: return [];                       // 限定名、特殊名（construct/算符）都不新增名字
  }
}

/**
 * **这条声明是给谁写的**（核心的 `ownerOf` 钩子）：`void C.f() {}` / `C1.construct() {}`
 * 那种体外定义的东家是限定名最左那一格。不是体外定义就答 `null`。
 * 量出来这一格值不少：`io_UartSignalDecoder.jnc` 那种"类体只放字段、方法全写在体外"的写法，
 * 里头 `m_state` / `State` 全靠它才查得着（否则那些名字在词法链上压根不在类那一层）。
 */
export function jncOwnerOf(v) {
  if (v === null || v === undefined || typeof v !== 'object') return null;
  if (v.kind === 'dcl') return jncOwnerOf(v.name);
  if (v.kind === 'init' || v.kind === 'ref-init') return jncOwnerOf(v.dcl);
  if (v.kind === 'dcls') return jncOwnerOf(v.first);
  if (v.kind === 'qualified' || v.kind === 'qualified-special') {
    let left = v.left;
    while (left !== null && left !== undefined && typeof left === 'object'
      && (left.kind === 'qualified' || left.kind === 'qualified-special')) left = left.left;
    /* 泛型的体外定义（`Array<T>.set(…) {}`，stdt_Array.jnc 那一族）：东家是那个**泛型的名字**
       ——`tinst` 裹着它。少这一格的时候尺子报出 41 处 `m_count` 查不着，全在 stdt_*.jnc。 */
    if (left !== null && left !== undefined && left.kind === 'tinst') left = left.name;
    return left !== null && left !== undefined && left.kind === 'name' ? left.value : null;
  }
  return null;
}

/**
 * **基类的名字读成一条路径**（核心的 `pathOf` 钩子）：`class S: doc.Session` 那一格是
 * `qualified`，得读成 `['doc', 'Session']` 才找得着那一层。
 * 量出来这一格很值：`m_pluginHost`（1012 处）那一族全是"基类在命名空间里"。
 * 泛型的头（`Iterator<T>`）取它的名字那一段；读不出来的那一格就空着（记账，不猜）。
 */
export function jncPathOf(v) {
  const one = (x) => {
    if (x === null || x === undefined || typeof x !== 'object') return null;
    if (x.kind === 'name') return x.value === null || x.value === undefined ? null : [x.value];
    if (x.kind === 'tinst') return one(x.name);
    if (x.kind === 'qualified' || x.kind === 'qualified-special') {
      const left = one(x.left);
      const right = x.right;
      const seg = right !== null && right !== undefined && typeof right.value === 'string'
        ? right.value : null;
      if (left === null || seg === null) return null;
      return [...left, seg];
    }
    return null;
  };
  if (v === null || v === undefined) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.map((x) => one(x)).filter((p) => p !== null);
}

/** 作用域配方。键是节点名，`steps` 是上面那四个词。 */export const JNC_SCOPE = {
  /* **文件顶层的名字不看先后**（`'@root'` 这一格是核心给的：洞就是 ast 自己那几格）。
     jancy 的编译是两趟 —— declare 一趟把名字全登记上，compile 一趟才看体
     （jnc_ct_Module 的 DeclarePass / CompilePass）。所以 `g_f()` 写在 `g_f` 声明之前是对的。 */
  '@root': { steps: ['hoist:stats', 'stats'] },
  // 声明：名字进当前这层
  'var-decl': { steps: ['specs', 'dcls', 'bind:dcls'] },
  'var-decl-curly': { steps: ['specs', 'dcl', 'value', 'bind:dcl'] },
  typedef: { steps: ['specs', 'bind:dcls'] },
  'fn-proto': { steps: ['specs', 'bind:dcl', 'in-owner:dcl'] },
  // 函数：名字在外层，形参与体在新开的那一层（形参长在 `dcl` 的后缀里）
  // 体外定义（`void C.f() {}`）先 `in-owner:dcl` 挪进那个类，`open` 于是挂在类那一层底下
  'fn-def': { steps: ['specs', 'bind:dcl', 'in-owner:dcl', 'open', 'dcl', 'body'] },
  // 声明符：**不走名字那一格**（那是定义，不是引用）
  dcl: { steps: ['ptrs', 'suffixes', 'ctor'] },
  formal: { steps: ['specs', 'dcl', 'init', 'bind:dcl'] },
  'formal-anon': { steps: ['specs', 'ptrs'] },
  // 类型与命名空间：自己是一层，**成员也不看先后**（同上：declare 一趟、compile 一趟）
  agg: { steps: ['bind:name', 'bases', 'open', 'inherit:bases', 'hoist:body', 'body'] },
  enum: { steps: ['bind:name', 'base', 'open', 'hoist:body', 'body'] },
  'enum-item': { steps: ['value', 'bind:name'] },
  /* 命名空间是**合并**的：同一个 `namespace io { … }` 在一份文件里写两遍、或者在同一个模块的
     两份文件里各写一段，都是同一层（jancy 的 NamespaceMgr 按名字找那一格，找不着才新建）。
     所以这儿用 `open-shared:`，不是 `open` —— 少这一格，`io_HostNameResolver.jnc` 里裸写的
     `SocketAddress`（声明在同命名空间的 io_SocketAddress.jnc 里）就查不着。 */
  namespace: { steps: ['bind:name', 'open-shared:name', 'hoist:body', 'body'] },
  dylib: { steps: ['bind:name', 'open', 'hoist:body', 'body'] },
  extension: { steps: ['bases', 'open', 'hoist:body', 'body'] },
  'property-template': { steps: ['open', 'hoist:body', 'body'] },
  /* 两格**透明壳**：收名字的时候得穿过去。`type-decl` 裹着 `agg`（`class C {}` 那一条声明），
     `attributed` 裹着一条声明（`[ displayName = … ] int m_x;`）—— 壳自己不带名字。 */
  'type-decl': { steps: ['agg'], through: ['agg'] },
  attributed: { steps: ['attrs', 'decl'], through: ['decl'] },
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
  ownerOf: jncOwnerOf,
  pathOf: jncPathOf,
});
