// ext/vlang/tograph.js —— **V 的树 -> 节点图**（第五个前端）
//
// 与 `ext/go/tograph.js` 对着看：两门语言的树几乎同形（`file` / `fn` / `define` /
// `for` / `inc` / `if` / `return` / `call`），差的只有三处小地方 ——
//   * 形参在 `(params (p 名字 (tname …)))` 里（go 是 `(sig (in (p (tname …) (name …))))`）；
//   * 左值可以带 `mut` 包一层（`mut acc := 0`）—— **不可变是默认的**，`mut` 是一格
//     不产生代码的检查（`ext/vlang/SPEC.md` §四第 2 条），这一批直接拆掉；
//   * `println` 是内建，不用走 `fmt.` 那一格选择器。
// 三处都不影响节点：**落到的还是那 13 格**。

import {
  node, lit, program, bin, un,
} from '../../src/core/graph/graph.js';
import {
  isList, tag, kids, leaf, part, partKids, groupItems, unquote,
  counted, threePart, incr, augset, lazyAnd, lazyOr, elseOf,
  ops, recordNew, fieldGet, fieldSet,
} from '../../src/core/graph/fromtree.js';


const OPS = ops();
const PRINTS = new Set(['println', 'print', 'eprintln', 'dump']);

const many = (xs) => xs.map(toNode).flat();

/** 左值：`(name x)` 或 `(mut (name x))`。`mut` 只是一格检查，拆掉。 */
function nameOf(x) {
  if (tag(x) === 'mut') return nameOf(kids(x)[0]);
  if (tag(x) === 'name') return leaf(kids(x)[0]);
  return leaf(x);
}

function funcOf(x, name) {
  const ps = part(x, 'params');
  const params = ps === undefined ? [] : kids(ps).map((p) => leaf(kids(p)[0]));
  const blk = kids(x).find((y) => tag(y) === 'block');
  return node('func', { body: blk === undefined ? [] : many(kids(blk)) }, { params, name });
}

function toNode(x) {
  switch (tag(x)) {
    case 'num': return node('const', {}, { value: Number(leaf(kids(x)[0])) });
    case 'str': return node('const', {}, { value: leaf(kids(x)[0]) });
    case 'name': {
      const n = leaf(kids(x)[0]);
      if (n === 'true') return node('const', {}, { value: true });
      if (n === 'false') return node('const', {}, { value: false });
      if (n === 'none' || n === 'nil') return node('const', {}, { value: null });
      return node('ref', {}, { name: n });
    }
    case 'paren': return toNode(kids(x)[0]);
    case 'mut': return toNode(kids(x)[0]);
    // `p.x` -> field-get；`Point{ x: 1 }` -> record-new（**类型名不进图**）。
    // V 的字段表标签是 `f`，go 的是 `kv`，lua 的是 `named` —— 三种记号一格节点。
    case 'sel': return fieldGet(toNode(kids(x)[0]), leaf(kids(x)[1]));
    case 'lit': return recordNew(kids(x).slice(1).map((e) => {
      if (tag(e) !== 'f') throw new Error('v->graph: 这一批只接带字段名的结构字面量');
      return [leaf(kids(e)[0]), toNode(kids(e)[1])];
    }));

    case 'bin': {
      const [op, a, b] = kids(x);
      if (leaf(op) === '&&') return lazyAnd(toNode(a), toNode(b));
      if (leaf(op) === '||') return lazyOr(toNode(a), toNode(b));
      const o = OPS.get(leaf(op));
      if (o === undefined) throw new Error(`v->graph: 这个算子还没接：${leaf(op)}`);
      return bin(o, toNode(a), toNode(b));
    }
    case 'un': {
      const [op, a] = kids(x);
      return un(leaf(op) === '!' ? 'not' : leaf(op), toNode(a));
    }

    case 'fn': {
      const name = leaf(kids(x)[0]);
      return node('bind', { init: funcOf(x, name) }, { name });
    }
    case 'block': return node('region', { body: many(kids(x)) });
    case 'define': case 'assign': {
      const isDef = tag(x) === 'define';
      const lhs = kids(x).filter((y) => tag(y) === 'lhs').flatMap(kids);
      const rhs = kids(x).filter((y) => tag(y) === 'rhs').flatMap(kids);
      return lhs.map((t, i) => {
        const v = rhs[i] === undefined ? lit(null) : toNode(rhs[i]);
        // 左边是一格字段（`p.y = 5`）⇒ field-set；`set` 只认名字
        if (tag(t) === 'sel') return fieldSet(toNode(kids(t)[0]), leaf(kids(t)[1]), v);
        return isDef
          ? node('bind', { init: v }, { name: nameOf(t) })
          : node('set', { value: v }, { name: nameOf(t) });
      });
    }
    case 'inc': case 'dec': return node('set', {
      value: bin(tag(x) === 'inc' ? '+' : '-', toNode(kids(x)[0]), lit(1)),
    }, { name: nameOf(kids(x)[0]) });
    case 'for': {
      const init = part(x, 'init');
      const cond = part(x, 'cond');
      const post = part(x, 'post');
      const blk = kids(x).find((y) => tag(y) === 'block');
      // 形状与 go / awk 一模一样 —— `threePart` 只写一遍（fromtree.js）
      return threePart({
        init: init === undefined ? [] : many(kids(init)),
        cond: cond === undefined ? undefined : toNode(kids(cond)[0]),
        post: post === undefined ? [] : many(kids(post)),
        body: blk === undefined ? [] : many(kids(blk)),
      });
    }
    case 'if': {
      const [cond, then, els] = kids(x);
      const e = elseOf(els);
      return node('branch', {
        cond: toNode(cond),
        then: toNode(then),
        ...(e === undefined ? {} : { else: toNode(e) }),
      });
    }
    case 'return': {
      const vals = kids(x);
      return node('ret', vals.length === 0 ? {} : { value: toNode(vals[0]) });
    }
    case 'expr': return toNode(kids(x)[0]);
    // `defer { … }` / `defer: …` -> scope-exit（与 go 的 defer、CL 的 unwind-protect
    // **同一格节点**：逆序、早退也跑，八家共用那一格）
    case 'defer': return node('scope-exit', { action: many(kids(x)) });
    case 'call': {
      const [fn, args] = kids(x);
      const argNodes = args === undefined ? [] : many(kids(args));
      const callee = tag(fn) === 'name' ? leaf(kids(fn)[0]) : null;
      if (callee !== null && PRINTS.has(callee)) return node('prim', { args: argNodes }, { name: 'print' });
      return node('call', { fn: toNode(fn), args: argNodes });
    }
    case 'module': case 'import': case 'struct': case 'enum': case 'type-decl': return [];
    default:
      throw new Error(`v->graph: 这一格还没接：${tag(x) ?? JSON.stringify(x).slice(0, 40)}`);
  }
}

/** 一棵 V 的 GLR 树（`(file 顶层项…)`）-> 一张图。末尾补一格 `call main`（同 go）。 */
export function vlangToGraph(tree) {
  if (tag(tree) !== 'file') throw new Error('v->graph: 这不是 (file …)');
  const body = kids(tree).map(toNode).flat();
  return program([...body, node('call', { fn: node('ref', {}, { name: 'main' }), args: [] })]);
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. option/result（`?T` / `!T` / `or {}` / `!` 传播）不在这一批 —— 它是
//      **错误出端口 + 切段**，排在 `multi-value` 那一步（`ext/vlang/SPEC.md` §五第 1 项）。
//   2. `mut` 只拆不检查（它是一格不产生代码的检查特性）。
//   3. struct **声明**丢掉（字段名从字面量那儿来 —— record-new 不要求类型存在）；
//      sumtype / match / spawn / chan 都不在这一批。
