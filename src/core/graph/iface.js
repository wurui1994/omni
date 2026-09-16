// src/core/graph/iface.js —— **一格子图的接口**（ADR-0033 的 G3）
//
// G3 那条判据的原话是：「子图替换前后，端口 / 效应签名 / region 逐格对上」。
// 它一直是这五条静态检查里**唯一没有可执行版本**的一条 —— 这一份把它变成能跑的东西。
//
// ## 为什么"接口"不是"长得一样"
//
// 换掉一块子图（把 `while` 写的求和换成闭式 `n*(n+1)/2`）之后，图上那两块**一个节点都对不上**。
// 能对上的只有它与外界之间那几条边，也就是这四栏：
//
//   reads   它读到的**自由名字**（在这块里没绑过就来自外面）
//   writes  它写到的自由名字（`set` 的目标在外面）
//   binds   它往**外层**添的名字（`bind` 在这一层生效 —— 换掉之后外面还得看得见）
//   effects 效应签名（声明那一栏的并集；`may-early-exit` 只在**跑得出这块**时才算）
//   shape   region 形状：`region` / `func` / `loop` 的 body 边嵌套成什么样
//
// ## 作用域按**调度器真的怎么做**算，不按直觉
//
// `eval.js` 里只有 `region` 与函数调用开新的 Env（`bind` 是 `env.define`），
// 所以 `loop` 的体、`branch` 的两支里 `bind` 出来的名字**是漏到外层的** ——
// 这一份就照这么算。照直觉写"块就是作用域"会让接口比实际宽，而 G3 要的是逐格对上。

import { declOf } from './nodes.js';
import { primEffects } from './prims.js';

const isNode = (x) => x !== null && typeof x === 'object' && x.op !== undefined;
const listOf = (x) => (x === null || x === undefined ? [] : (Array.isArray(x) ? x : [x]));

/** 这几格自己收住早退，所以里头的 `may-early-exit` **跑不出这块**。 */
const CATCHES = new Map([['func', ['ret', 'loop-exit']], ['loop', ['loop-exit']]]);

/**
 * 算一块子图的接口。`body` 是一格节点或一串节点（`program(...)` 的 body 也行）。
 *
 * `opts.shared`（默认 `false`）说的是**这块插在哪儿**：
 *   * `false` —— 它自己就是一层作用域（函数体、region 体）。顶层 `bind` 出来的名字
 *     外面看不见，所以**不进 binds 栏** —— 它是内部局部量，换掉整块时随之消失。
 *   * `true`  —— 它与外面共用一层作用域（直接插在宿主 body 里的一截）。这时顶层 `bind`
 *     是**漏给外面**的，后面没被替换的节点还要用它，所以那一栏要算进接口。
 * 换句话说：**接口是相对"插进哪儿"说的**，同一块子图两种读法不一样（判据里有一条量它）。
 *
 * @returns {{reads:string[], writes:string[], binds:string[], effects:string[], shape:string}}
 */
export function ifaceOf(body, opts = {}) {
  const st = { reads: new Set(), writes: new Set(), binds: new Set(), effects: new Set(), shared: opts.shared === true };
  const shape = walk(listOf(body.kind === 'graph' ? body.body : body), new Set(), st, null, true);
  return {
    reads: [...st.reads].sort(),
    writes: [...st.writes].sort(),
    binds: [...st.binds].sort(),
    effects: [...st.effects].sort(),
    shape,
  };
}

/**
 * 走一串节点。`bound` 是"这块里已经绑住的名字"（照 eval 的作用域：只有 func 的形参与
 * region 开新的一层）。`top` = 还在这块自己那一层作用域里（loop / branch 的体仍算，
 * 因为 `bind` 在 eval 里就是 `env.define`，那两格不开新 Env）。
 * 回这一截的 region 形状（一串括号）。
 */
function walk(nodes, bound, st, catches, top) {
  let shape = '';
  for (const n of nodes) {
    if (!isNode(n)) continue;
    shape += one(n, bound, st, catches, top);
  }
  return shape;
}

/** 走一格节点，回它的 region 形状（没有 body 边的节点回空串）。 */
function one(n, bound, st, catches, top) {
  const d = declOf(n.op);
  // 效应那一栏**只收跨得出这块边界的**。
  //
  // 头一版是"声明的并集"，量出来那是错的：`while` 求和那块有 `bind` / `set`（声明里带
  // `writes`），闭式那块没有，于是接口判它们不同 —— 可三条腿上两块的输出**逐行相同**
  // （`tests/graph/iface.js` 那两条正面 case 当场把这件事顶出来了）。
  // 原因是那几格 `writes` 写的是**内部局部量**：外面看不见，所以跨不出边界。
  //
  // 于是分两类：`ref` / `set` / `bind` 这三格的效应目标是**一个名字** —— 名字自由才算；
  // 别的节点（print 那格 prim、field-set 那一族、list-new 的 allocates、ret 的早退）
  // 照声明算，因为它们碰的东西本来就来自外面或落在堆上。
  const nameBased = n.op === 'ref' || n.op === 'set' || n.op === 'bind';
  if (!nameBased) {
    for (const e of (n.op === 'prim' ? primEffects(n.attrs.name) : d.effects)) {
      if (e === 'may-early-exit' && catches !== null && catches.includes(n.op)) continue;
      st.effects.add(e);
    }
  }
  // 名字那三栏。`ref` 读、`set` 写、`bind` 往这一层添
  if (n.op === 'ref' && !bound.has(n.attrs.name)) { st.reads.add(n.attrs.name); st.effects.add('reads'); }
  if (n.op === 'set' && !bound.has(n.attrs.name)) { st.writes.add(n.attrs.name); st.effects.add('writes'); }

  let shape = '';
  for (const p of d.ins) {
    const val = n.ins[p.name];
    if (val === undefined) continue;
    if (p.sem === 'body') {
      // region 与 func 各开一层：里头绑的名字不漏出来（照 eval.js）
      const own = n.op === 'region' || n.op === 'func';
      const inner = own ? new Set(bound) : bound;
      for (const prm of (n.op === 'func' ? (n.attrs.params ?? []) : [])) inner.add(prm);
      const sub = CATCHES.get(n.op) ?? catches;
      const got = walk(listOf(val), inner, st, sub, own ? false : top);
      // **形状那一栏只记开作用域的那几格**（`region` / `func`），`loop` / `branch` 的体不记。
      //
      // 头一版把 `loop` 也记进去了，量出来那是错的：`while` 求和换成闭式 `n*(n+1)/2`
      // 之后形状从 `loop()` 变成空，接口判它们不同 —— 可三条腿上两块输出**逐行相同**
      // （`tests/graph/iface.js` 那条正面 case）。循环是**里头**的事，外面看不见；
      // 而 `region` 与 `func` 会改作用域与出口表，那是**边界**上的事。
      // G3 那句"region 逐格对上"说的是后者。
      shape += own ? `${n.op}(${got})` : got;
      continue;
    }
    shape += walk(listOf(val), bound, st, catches, top);
  }
  // `bind` 是**先算初值再添名字**（`env.define(name, arg('init'))`）—— 顺序不能反：
  // `local x = x` 里右边那个 x 是外面的。
  if (n.op === 'bind') {
    if (top && st.shared) { st.binds.add(n.attrs.name); st.effects.add('writes'); }
    bound.add(n.attrs.name);
  }
  return shape;
}

/** 印成一行，好 diff（判据里报"哪一栏不同"用的就是它）。 */
export function ifaceText(i) {
  const col = (k) => `${k}=[${i[k].join(' ')}]`;
  return `${col('reads')} ${col('writes')} ${col('binds')} ${col('effects')} shape=${i.shape}`;
}

/**
 * 两块子图的接口逐格对上吗？对上回 `null`，对不上回**第一处**不同的那句话。
 * （G3 要的是"逐格"，所以这儿一栏一栏比，不是比一整串文本 —— 那样报不出是哪一栏。）
 */
export function sameIface(a, b) {
  for (const k of ['reads', 'writes', 'binds', 'effects']) {
    const x = a[k].join(' ');
    const y = b[k].join(' ');
    if (x !== y) return `${k} 那一栏不同：[${x}] ≠ [${y}]`;
  }
  if (a.shape !== b.shape) return `region 形状不同：${a.shape} ≠ ${b.shape}`;
  return null;
}
