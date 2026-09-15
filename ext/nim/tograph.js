// ext/nim/tograph.js —— **Nim 的树 -> 节点图**（第九个前端）
//
// Nim 与 mojo 一样缩进即块，可它多两样别的语言没有的形状，正好各压一格：
//   * **命令式调用**（`echo sumto(5)` —— 不带括号）：树上是 `(command (name echo) (args …))`，
//     与 `(call …)` 是两条产生式、**同一格节点**（语法的形状 ≠ 节点的格数）。
//   * **`var` 段**（`var a = 1` 一行能声明好几格）：`(var-section (item (names …) (init …)))`
//     → 一串 `bind`。这也是"decl 就是 bind"那句话。
//
// pragma（`{.inline.}`）在这一批直接丢掉 —— 它是**附属节点的总入口**
// （`ext/nim/SPEC.md` §3.3 第 2 条），骨架这一批不碰。

import {
  node, lit, program, bin, un,
} from '../../src/core/graph/graph.js';
import {
  isList, tag, kids, leaf, part, partKids, groupItems, unquote,
  counted, threePart, incr, augset, lazyAnd, lazyOr, elseOf,
  ops,
} from '../../src/core/graph/fromtree.js';

/** 无名表的孩子是**全部** items（形参装在这种表里 —— mojo 那边踩过同一处）。 */

const OPS = ops({ div: '/', mod: '%', '&': 'concat' });
const PRINTS = new Set(['echo', 'write', 'stdout']);

const many = (xs) => xs.map(toNode).flat();

function nameOf(x) {
  if (tag(x) === 'name' || tag(x) === 'n') return leaf(kids(x)[0]);
  if (tag(x) === 'names') return nameOf(kids(x)[0]);
  return leaf(x);
}

function toNode(x) {
  if (isList(x) && x.items.length === 0) return [];
  switch (tag(x)) {
    case 'num': return node('const', {}, { value: Number(leaf(kids(x)[0])) });
    case 'str': return node('const', {}, { value: unquote(leaf(kids(x)[0])) });
    case 'name': case 'n': {
      const n = leaf(kids(x)[0]);
      if (n === 'true') return node('const', {}, { value: true });
      if (n === 'false') return node('const', {}, { value: false });
      if (n === 'nil') return node('const', {}, { value: null });
      return node('ref', {}, { name: n });
    }
    case 'paren': return toNode(kids(x)[0]);
    case 'line': case 'body': case 'impl': return many(kids(x));
    case 'expr': return toNode(kids(x)[0]);

    case 'bin': {
      const [op, a, b] = kids(x);
      if (leaf(op) === 'and') return lazyAnd(toNode(a), toNode(b));
      if (leaf(op) === 'or') return lazyOr(toNode(a), toNode(b));
      const o = OPS.get(leaf(op));
      if (o === undefined) throw new Error(`nim->graph: 这个算子还没接：${leaf(op)}`);
      if (o === 'concat') return node('prim', { args: [toNode(a), toNode(b)] }, { name: 'concat' });
      return bin(o, toNode(a), toNode(b));
    }
    case 'un': {
      const [op, a] = kids(x);
      return un(leaf(op) === 'not' ? 'not' : leaf(op), toNode(a));
    }
    // `var a = 1` / `let a = 1` / `const a = 1` —— 一段能声明好几格
    case 'var-section': case 'let-section': case 'const-section': {
      return kids(x).filter((y) => tag(y) === 'item').map((it) => {
        const init = part(it, 'init');
        return node('bind', {
          init: init === undefined ? lit(null) : toNode(kids(init)[0]),
        }, { name: nameOf(part(it, 'names')) });
      });
    }
    case 'assign': {
      const [op, lhs, rhs] = kids(x);
      const name = nameOf(lhs);
      if (leaf(op) === '=') return node('set', { value: toNode(rhs) }, { name });
      const o = OPS.get(String(leaf(op)).replace('=', ''));
      if (o === undefined) throw new Error(`nim->graph: 这个复合赋值还没接：${leaf(op)}`);
      return node('set', {
        value: bin(o, node('ref', {}, { name }), toNode(rhs)),
      }, { name });
    }
    case 'routine': {
      const nm = kids(x).find((y) => tag(y) === 'n' || tag(y) === 'name');
      const name = nm === undefined ? null : leaf(kids(nm)[0]);
      const sig = part(x, 'sig');
      const groups = sig === undefined ? [] : kids(sig);
      const params = groups.flatMap((g) => (tag(g) === 'p' ? [g] : groupItems(g)))
        .filter((p) => tag(p) === 'p')
        .map((p) => nameOf(part(p, 'names') ?? kids(p)[0]));
      const impl = sig === undefined ? undefined : part(sig, 'impl');
      const body = impl === undefined ? part(x, 'impl') : impl;
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
      const els = part(x, 'else');
      return node('branch', {
        cond: toNode(cond),
        then: body === undefined ? [] : many(kids(body)),
        ...(els === undefined ? {} : { else: many(kids(els)) }),
      });
    }
    case 'return': {
      const vals = kids(x);
      return node('ret', vals.length === 0 ? {} : { value: toNode(vals[0]) });
    }
    // 命令式调用与括号调用是**同一格节点**（语法两条产生式，图上一格）
    case 'call': case 'command': {
      const [fn, args] = kids(x);
      const argNodes = args === undefined ? [] : many(kids(args));
      const callee = (tag(fn) === 'name' || tag(fn) === 'n') ? leaf(kids(fn)[0]) : null;
      if (callee !== null && PRINTS.has(callee)) return node('prim', { args: argNodes }, { name: 'print' });
      return node('call', { fn: toNode(fn), args: argNodes });
    }
    case 'import': case 'include': case 'type-section': case 'pragma': return [];
    default:
      throw new Error(`nim->graph: 这一格还没接：${tag(x) ?? JSON.stringify(x).slice(0, 40)}`);
  }
}

/** 一棵 nim 的 GLR 树（`(module 项…)`）-> 一张图。 */
export function nimToGraph(tree) {
  if (tag(tree) !== 'module') throw new Error('nim->graph: 这不是 (module …)');
  return program(kids(tree).map(toNode).flat());
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. pragma 全丢（`raises` / `tags` / `noSideEffect` 是**效应签名**，
//      `ext/nim/SPEC.md` §五第 1 项：效应六格的边界是那一门第一件要做的事）。
//   2. `result` 隐式变量、`discard`、模板/宏、迭代器都不在这一批。
//   3. `var` / `sink` / `lent` 形参丢掉 —— 它们是 `lifetime` 那一栏。
