// src/core/graph/shrink.js —— **第一个 pass**：常量折叠 + 死绑定删除（图这一层的第一笔减法）
//
// `docs/design/node-graph-shrink.md` 第四节的自评里，三格中空着的那一格是**变换**：
// 「`src/core/graph/` 下没有一个 pass，ADR-0033 那套效应声明是为了变换才写的，
// 而现在没有一个消费者在用它做减法」。这一份是那一栏的第一个消费者，也只做两件事 ——
// 第五节点的第 1 条判据（「常量折叠 + 死绑定删除：现有例子上报出删了几格，
// 且五个后端输出一字不变」）。
//
// ## 两条规则，各只用得着已经声明好的东西
//
//   **常量折叠**  一格 `prim`，内建自己是 pure（`prims.js` 那一栏），实参全是常量
//                （`const` 节点或内联 `lit`）—— 就地算出来，落成**一格 `const`**。
//                算的那一下**借的是解释器那同一个 kernel**（`primOf(name).kernel`）：
//                折叠与运行由同一份实现给答案，不然就是两套语义等着对不上。
//   **死绑定删除** 一格 `bind`，名字**整张图里没有一处 `ref` / `set`**，而且初值那棵子图
//                通体 pure —— 整格删掉。
//
// ## 三处刻意保守（保守是能证明的，聪明不是）
//
//   1. 折叠**落成 `const` 节点而不是内联 `lit`**：内联更小，可是 `prim` 可能站在语句位置
//      （`region` 的 body 里），那儿放一格字面量是另一件事。落成节点则**位置无关**，
//      节点数照样从「prim + 常量若干」减到 1。
//   2. 「名字没人用」是**整张图**的问答，不按作用域算：作用域里"看不见"的引用不存在，
//      于是全局没人 `ref` 就是真没人用。宁可少删，不许删错。
//   3. 只删 `bind`，不删 `set` / `field-set` / 空 `region` —— 那些各有自己的一条账，
//      混在一起就说不清「这一格是哪条规则删的」。
//
// ## 出来的账
//
// `shrink(g)` 回 `{ graph, folded, dropped, rounds }` —— **删了几格是回值的一部分**，
// 不是印出来的一句话（第三条要求的原话是「每个 pass 要能报出删了几格节点」）。
// 印法归 CLI（`--shrink` 那一路用 `stat.js` 的 `graphStatDiff` 出那张差表）。

import { node } from './graph.js';
import { isPure } from './nodes.js';
import { primOf } from './prims.js';
import { litType } from './types.js';
import { valTruthy, showValue } from './eval.js';

/** 是不是一格节点（与 `stat.js` 那格同一条判断 —— 字面量与数组都不是）。 */
function isNode(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
    && typeof x.op === 'string' && x.ins !== undefined;
}

/** 是不是一格常量：内联 `lit` 或 `const` 节点。回 `{v}`，不是常量回 `null`。 */
function constOf(x) {
  if (x !== null && x !== undefined && typeof x === 'object' && x.lit !== undefined) return { v: x.lit };
  if (isNode(x) && x.op === 'const') return { v: x.attrs.value };
  return null;
}

/** 折叠那一下要的 `io`：只有 `truthy` 与 `show` 两格，两格都是纯的（`not` / `concat` 要）。
 *  `print` 一族根本走不到这儿 —— 它不 pure，第一道门就拦住了。 */
const PURE_IO = { truthy: valTruthy, show: showValue };

/** 整棵子图通体 pure 吗（初值能不能跟着 bind 一起删，看的是这个）。 */
function pureTree(x, seen = new Set()) {
  if (Array.isArray(x)) return x.every((y) => pureTree(y, seen));
  if (!isNode(x)) return true;                      /* 字面量与"没有"都算纯 */
  if (seen.has(x.id)) return true;
  seen.add(x.id);
  if (!isPure(x)) return false;
  return Object.keys(x.ins).every((k) => pureTree(x.ins[k], seen));
}

/** 整张图里被 `ref` / `set` 用到的名字。**一次走遍，全局收**（保守的那一条）。 */
function usedNames(root) {
  const names = new Set();
  const seen = new Set();
  const walk = (x) => {
    if (Array.isArray(x)) { for (const y of x) walk(y); return; }
    if (!isNode(x) || seen.has(x.id)) return;
    seen.add(x.id);
    if ((x.op === 'ref' || x.op === 'set') && typeof x.attrs.name === 'string') names.add(x.attrs.name);
    /* `func` 的形参不进来：那是"给名字"，不是"用名字"。 */
    for (const k of Object.keys(x.ins)) walk(x.ins[k]);
  };
  walk(root);
  return names;
}

/** 造一格与原来同名同附属的新节点（附属照抄，`span` 跟着走 —— 诊断要它）。 */
function rebuild(x, ins) {
  return node(x.op, ins, { ...x.attrs, span: x.span });
}

/**
 * 走一遍并重建。**自底向上**：孩子先折，于是 `(1+2)*3` 一趟就折到底，不用等下一轮。
 * 按 id 记忆，所以**共享的那一格重建之后仍然是共享的一格**（图不许在变换里变成树）。
 */
function rewrite(x, ctx) {
  if (Array.isArray(x)) {
    const out = [];
    for (const y of x) {
      /* 死绑定：整格从这串 body 里去掉（`bind` 的 outs 是空的，没人拿它当值用）。 */
      if (isNode(y) && y.op === 'bind' && ctx.dead.has(y.attrs.name) && pureTree(y.ins.init)) {
        ctx.dropped += 1;
        continue;
      }
      out.push(rewrite(y, ctx));
    }
    return out;
  }
  if (!isNode(x)) return x;
  if (ctx.memo.has(x.id)) return ctx.memo.get(x.id);
  const ins = {};
  for (const k of Object.keys(x.ins)) ins[k] = rewrite(x.ins[k], ctx);
  let out = rebuild(x, ins);
  /* 常量折叠：内建自己 pure（`isPure` 对 `prim` 是查 `prims.js` 那一栏的）+ 实参全是常量。 */
  if (out.op === 'prim' && isPure(out)) {
    const args = Array.isArray(ins.args) ? ins.args : [];
    const cs = args.map(constOf);
    if (cs.length > 0 && cs.every((c) => c !== null)) {
      /* 算不出来（除零、类型对不上…）就**不折**：折叠不许把运行期的错搬到编译期。 */
      try {
        const v = primOf(out.attrs.name).kernel(cs.map((c) => c.v), PURE_IO);
        /* **折出来的必须是图上说得出的一格字面量**（int / real / bool / string）。
           `fill` / `slice` 那几格实参全是常量时算出来的是一格**聚合**（`new Array(2).fill('')`），
           而聚合不是字面量：落成 `(const …)` 之后 core 那条腿印出 `(int 0)`（null 那一档），
           方言当场骂"(slen …) 的第一个参数要是 string，这里是 int" —— `go+makelen × core`
           量出来的。还有一层：`memo` 让同一格 `const` 被**共享**，而 n 格元素指向同一格聚合
           正是 `fill` 的 kernel 自己拦着的那件事。所以这一格只折标量。 */
        if (litType(v) === null) throw new Error('折出来的不是一格标量字面量');
        out = node('const', {}, { value: v, span: x.span });
        ctx.folded += 1;
      } catch (err) { /* 保持原样 —— 这一格留给运行期去报 */ }
    }
  }
  ctx.memo.set(x.id, out);
  return out;
}

/**
 * 缩一张图。回 `{ graph, folded, dropped, rounds }`。
 *
 * 为什么要**转几轮**：折掉一格常量可能让某个 `bind` 的初值变成常量，删掉一格 `bind` 又会
 * 带走它初值里的那些 `ref` —— 于是另一格 `bind` 才显出"没人用"。转到不动为止（上限 8 轮，
 * 上限是防手抖，不是语义：两条规则都只减不增，本来就一定会停）。
 */
export function shrink(g) {
  const isProgram = g !== null && g !== undefined && g.kind === 'graph';
  let root = isProgram ? g.body : g;
  let folded = 0;
  let dropped = 0;
  let rounds = 0;
  for (let i = 0; i < 8; i++) {
    const used = usedNames(root);
    const ctx = { memo: new Map(), folded: 0, dropped: 0, dead: { has: (n) => !used.has(n) } };
    const next = rewrite(root, ctx);
    rounds = i + 1;
    folded += ctx.folded;
    dropped += ctx.dropped;
    root = next;
    if (ctx.folded === 0 && ctx.dropped === 0) break;
  }
  return { graph: isProgram ? { kind: 'graph', body: root } : root, folded, dropped, rounds };
}
