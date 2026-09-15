// ext/mojo/tograph.js —— **Mojo 的树 -> 节点图**（第八个前端，Python 形状）
//
// 这一门与 nim 一样是**缩进即块**（词法层出 INDENT/DEDENT），可到了图这一层
// 那件事已经消失了 —— 缩进只是语法的形状，节点还是那 13 格。
//
// 两格要说的：
//   * `var x = 1` 与 `x = 1` 在树上是同一条 `assign`，差别在 targets 里有没有 `bind` ——
//     所以映射按它分 `bind` / `set`（**decl 就是 bind**，没有 decl 节点）。
//   * `fn` 与 `def` 落同一格 `func`（`ext/mojo/SPEC.md` §六第 3 条记着它们效应默认值
//     可能不同 —— 那是效应栏的事，不是节点的事）。

import {
  node, lit, program, bin, un,
} from '../../src/core/graph/graph.js';
import {
  isList, tag, kids, leaf, part, groupItems, unquote,
  ops, convs, convOf, binOf, retOf, branchOf, loopExit, listNew, indexGet, indexSet,
} from '../../src/core/graph/fromtree.js';


const OPS = ops({ '//': '/' });
/** mojo 的转换名是**大写开头**的类型名（`Int` / `Float64` / `String`）。 */
const CONV = convs({
  Int: 'int', Int8: 'int', Int32: 'int', Int64: 'int',
  Float32: 'float', Float64: 'float', String: 'str', Bool: 'bool',
});
const PRINTS = new Set(['print', 'println']);

const many = (xs) => xs.map(toNode).flat();
const nameOf = (x) => {
  if (tag(x) === 'bind') return nameOf(kids(x)[1]);   // `(bind "var" (n x))`
  if (tag(x) === 'n') return leaf(kids(x)[0]);
  if (tag(x) === 'targets') return nameOf(kids(x)[0]);
  return leaf(x);
};

function toNode(x) {
  if (isList(x) && x.items.length === 0) return [];
  switch (tag(x)) {
    case 'num': return node('const', {}, { value: Number(leaf(kids(x)[0])) });
    case 'str': return node('const', {}, { value: unquote(leaf(kids(x)[0])) });
    case 'n': {
      const n = leaf(kids(x)[0]);
      if (n === 'True') return node('const', {}, { value: true });
      if (n === 'False') return node('const', {}, { value: false });
      if (n === 'None') return node('const', {}, { value: null });
      return node('ref', {}, { name: n });
    }
    case 'paren': return toNode(kids(x)[0]);
    // `[10, 20, 30]` -> list-new；`xs[i]` -> index-get（下标装在一格 `(subs …)` 里）
    case 'list': return listNew(many(kids(x)));
    case 'index': return indexGet(toNode(kids(x)[0]), toNode(kids(kids(x)[1])[0]));
    case 'line': case 'body': return many(kids(x));
    case 'break': return loopExit('break');
    case 'continue': return loopExit('continue');
    case 'expr': return toNode(kids(x)[0]);

    // `bin` 与 `cmp` 是同一个形状（`(cmp "<=" a b)`）—— 比较在 mojo 的语法里单开一级
    // （Python 的链式比较），但**落到的是同一格 binop**：语法的级数不是节点的格数。
    case 'bin': case 'cmp': {
      const [op, a, b] = kids(x);
      return binOf(leaf(op), toNode(a), toNode(b), OPS, { lang: 'mojo', and: ['and'], or: ['or'] });
    }
    case 'un': {
      const [op, a] = kids(x);
      return un(leaf(op) === 'not' ? 'not' : leaf(op), toNode(a));
    }
    // `var x = 1`（targets 里带 bind）出 bind；`x = 1` 出 set；`xs[1] = 5` 出 index-set
    case 'assign': {
      const targets = part(x, 'targets');
      const value = kids(x).find((y) => tag(y) !== 'targets');
      const v = value === undefined ? lit(null) : toNode(value);
      const t0 = targets === undefined ? undefined : kids(targets)[0];
      if (tag(t0) === 'index') return indexSet(toNode(kids(t0)[0]), toNode(kids(kids(t0)[1])[0]), v);
      const isDecl = targets !== undefined && kids(targets).some((t) => tag(t) === 'bind');
      const name = nameOf(targets);
      return isDecl
        ? node('bind', { init: v }, { name })
        : node('set', { value: v }, { name });
    }
    case 'augassign': {
      const [op, target, value] = kids(x);
      const name = nameOf(target);
      const o = OPS.get(String(leaf(op)).replace('=', ''));
      if (o === undefined) throw new Error(`mojo->graph: 这个复合赋值还没接：${leaf(op)}`);
      return node('set', {
        value: bin(o, node('ref', {}, { name }), toNode(value)),
      }, { name });
    }
    case 'routine': {
      const nm = kids(x).find((y) => tag(y) === 'n');
      const name = nm === undefined ? null : leaf(kids(nm)[0]);
      const sig = part(x, 'sig');
      const ps = sig === undefined ? [] : kids(sig).filter((y) => tag(y) !== 'ret');
      // `(sig ((p (n n) (n Int)) (p …)) (ret …))` —— 形参装在一格**无名的表**里。
      // 无名表的孩子是**全部** items（不是 items.slice(1)）—— 少了这一条，
      // 每个函数的第一个形参会被当成"标签"吃掉，于是 `n` 未绑定。矩阵当场抓出来的。
      const params = ps.flatMap((g) => (tag(g) === 'p' ? [g] : groupItems(g)))
        .filter((p) => tag(p) === 'p')
        .map((p) => nameOf(kids(p)[0]));
      const body = part(x, 'body');
      return node('bind', {
        init: node('func', { body: body === undefined ? [] : many(kids(body)) }, { params, name }),
      }, { name });
    }
    case 'while': {
      const cond = kids(x).find((y) => tag(y) !== 'body');
      const body = part(x, 'body');
      return node('loop', {
        cond: cond === undefined ? lit(true) : toNode(cond),
        body: body === undefined ? [] : many(kids(body)),
      });
    }
    case 'if': {
      const cond = kids(x)[0];
      const body = part(x, 'body');
      const els = part(x, 'else') ?? part(x, 'orelse');
      return branchOf(
        toNode(cond),
        body === undefined ? [] : many(kids(body)),
        els === undefined ? undefined : many(kids(els)),
      );
    }
    case 'return': return retOf(many(kids(x)));
    case 'call': {
      const [fn, args] = kids(x);
      const argNodes = args === undefined ? [] : many(kids(args));
      const callee = tag(fn) === 'n' ? leaf(kids(fn)[0]) : null;
      if (callee !== null && PRINTS.has(callee)) return node('prim', { args: argNodes }, { name: 'print' });
      if (callee !== null && CONV.has(callee) && argNodes.length === 1) {
        return convOf(CONV.get(callee), argNodes[0]);   // `Int(x)` / `Float64(x)`
      }
      return node('call', { fn: toNode(fn), args: argNodes });
    }
    case 'import': case 'from-import': case 'struct': case 'trait': case 'alias': return [];
    default:
      throw new Error(`mojo->graph: 这一格还没接：${tag(x) ?? JSON.stringify(x).slice(0, 40)}`);
  }
}

/** 一棵 mojo 的 GLR 树（`(module 项…)`）-> 一张图。末尾补一格 `call main`。 */
export function mojoToGraph(tree) {
  if (tag(tree) !== 'module') throw new Error('mojo->graph: 这不是 (module …)');
  const body = kids(tree).map(toNode).flat();
  return program([...body, node('call', { fn: node('ref', {}, { name: 'main' }), args: [] })]);
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. 实参约定（默认 / `mut` / `var`+`^` / `out` / `ref`）与 origin 全丢掉 ——
//      它们是 `lifetime` 那一栏（`ext/mojo/SPEC.md` §五第 1-2 项），这一批只检查不使用。
//   2. `for x in …`（迭代器协议）不在这一批，所以例子用 `while`。
//   3. struct / trait / 编译期参数 `[…]` / `with` 都不在这一批。
