// ext/chez/tograph.js —— **Scheme 的 datum 树 -> 节点图**
//
// 这一格是"加一门语言"真正要写的东西：一张对照表，左边是 GLR 出来的树的形状，
// 右边是 `src/core/graph/nodes.js` 那 13 格节点。**一行降级代码都不写** ——
// 降级（消去规则）是往后的事，这一步只做"树的形状 -> 图的节点"。
//
// Scheme 在这一格上最省：它的语法只有 datum 一层（`ext/chez/chez.grammar` 12 条产生式），
// 所以"哪个 datum 是 `if`、哪个是调用"这件事在**这一份**里说，不在语法里说 ——
// 与真 Scheme 一样（`if` / `lambda` / `define` 是特殊形式，属于求值那一层）。

import { node, lit, program } from '../../src/core/graph/graph.js';

const isList = (x) => x !== null && x !== undefined && x.kind === 'list';
const head = (x) => (isList(x) && x.items.length > 0 && x.items[0].kind === 'atom' ? x.items[0].value : null);
/** 一格 datum 的孩子（去掉头上那个标签）。 */
const kids = (x) => (isList(x) ? x.items.slice(1) : []);
/**
 * `(sym x)` / `(num 1)` / `(str "ok")` 那种"标签 + 一格叶子"的取值。
 * 叶子有两种 kind：`atom`（记号文本）与 `string`（已经解过转义的串值）——
 * 这一条踩过一次：只认 `atom` 的话 `(str …)` 全成了 null。
 */
const leaf = (x) => (x === null || x === undefined || x.kind === 'list' ? null : x.value);
const text = (x) => (isList(x) && x.items.length > 1 ? leaf(x.items[1]) : null);

const symName = (x) => (head(x) === 'sym' ? text(x) : null);
/** 一格 datum 是不是"表"（`(list …)`）。 */
const asList = (x) => (head(x) === 'list' ? kids(x) : null);

/** 数：`1` / `-2` / `1.5`。这一批只收十进制（`#x1f` 那一族记账，见文件尾）。 */
function numOf(t) {
  const v = Number(t);
  if (Number.isNaN(v)) throw new Error(`chez->graph: 这一批还收不了这个数：${t}`);
  return v;
}

/** 内建名字：Scheme 写法 -> `prim` 那一格的名字（`display` 就是 print）。 */
const PRIM = new Map([
  ['display', 'print'], ['write', 'print'],
  ['+', '+'], ['-', '-'], ['*', '*'], ['/', '/'],
  ['<', '<'], ['>', '>'], ['<=', '<='], ['>=', '>='], ['=', '='],
  ['not', 'not'], ['string-append', 'concat'], ['string-length', 'len'],
]);

/** 一串 datum -> 一串节点（`region` 的 body 端口收的就是它）。 */
const many = (xs) => xs.map(toNode);

function toNode(x) {
  // ---- 叶子 ----------------------------------------------------------------
  switch (head(x)) {
    case 'num': return node('const', {}, { value: numOf(text(x)) });
    case 'str': return node('const', {}, { value: text(x) });
    case 'bool': return node('const', {}, { value: text(x) === '#t' || text(x) === '#true' });
    case 'sym': return node('ref', {}, { name: text(x) });
    case 'quote': return node('const', {}, { value: `'${text(kids(x)[0]) ?? '?'}'` });
    default: break;
  }

  const items = asList(x);
  if (items === null) throw new Error(`chez->graph: 这一格 datum 还没接：${head(x)}`);
  if (items.length === 0) return node('const', {}, { value: null });

  const op = symName(items[0]);
  const rest = items.slice(1);

  switch (op) {
    // `(define (f a b) body…)` 与 `(define x e)` —— **decl 就是 bind**（没有 decl 节点）
    case 'define': {
      const target = rest[0];
      const inner = asList(target);
      if (inner !== null) {
        const name = symName(inner[0]);
        const params = inner.slice(1).map((p) => symName(p));
        const body = node('func', { body: many(rest.slice(1)) }, { params, name });
        return node('bind', { init: body }, { name });
      }
      return node('bind', { init: rest[1] === undefined ? lit(null) : toNode(rest[1]) }, { name: symName(target) });
    }
    case 'lambda': {
      const params = (asList(rest[0]) ?? []).map((p) => symName(p));
      return node('func', { body: many(rest.slice(1)) }, { params });
    }
    case 'set!': return node('set', { value: toNode(rest[1]) }, { name: symName(rest[0]) });
    // `if` 的两支是 `lazy` 端口 —— 只算一支，那一栏求值语义就是为它准备的
    case 'if': return node('branch', {
      cond: toNode(rest[0]),
      then: toNode(rest[1]),
      ...(rest[2] === undefined ? {} : { else: toNode(rest[2]) }),
    });
    case 'when': return node('branch', { cond: toNode(rest[0]), then: many(rest.slice(1)) });
    case 'unless': return node('branch', {
      cond: node('prim', { args: [toNode(rest[0])] }, { name: 'not' }),
      then: many(rest.slice(1)),
    });
    case 'begin': return node('region', { body: many(rest) });
    // `(let ((x 1) (y 2)) body…)` —— 一格 region + 一串 bind
    case 'let': {
      const binds = (asList(rest[0]) ?? []).map((b) => {
        const pair = asList(b) ?? [];
        return node('bind', { init: pair[1] === undefined ? lit(null) : toNode(pair[1]) }, { name: symName(pair[0]) });
      });
      return node('region', { body: [...binds, ...many(rest.slice(1))] });
    }
    // 没有 `while`：Scheme 的循环是递归。`loop` 那一格留给 lua / go / freebasic 用。
    case 'newline': return node('prim', { args: [lit('')] }, { name: 'print' });
    default: break;
  }

  // 内建（`display` / `+` / …）；别的都是普通调用
  if (op !== null && PRIM.has(op)) {
    return node('prim', { args: many(rest) }, { name: PRIM.get(op) });
  }
  return node('call', { fn: toNode(items[0]), args: many(rest) });
}

/**
 * 一棵 chez 的 GLR 树（`(program datum…)`）-> 一张图。
 * 收不下的形状**当场报**（不猜、不静默）—— 与语法那一侧同一条纪律。
 */
export function chezToGraph(tree) {
  if (head(tree) !== 'program') throw new Error('chez->graph: 这不是 (program …)');
  return program(many(kids(tree)));
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. 只收十进制的数：`#x1f` / `1/2` / `+inf.0` 那一族记号切得对，但**值**这一层
//      要 `number-tower` 那格能力的提供者（`ext/chez/SPEC.md` §六第 5 条）。
//   2. `quote` 只当一格常量文本收（真的 datum 值要 `graph-literal` 那一格）。
//   3. 宏（`syntax-rules`）没接 —— 它是 `stage`，排在这一批之后（SPEC §五第 7 项）。
//   4. `call/cc` 没接：它落在 `suspends` 那台续延机器上，与 go 的 channel 一起做。
