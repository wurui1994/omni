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
  isList, tag, kids, leaf, part, groupItems, unquote,
  ops, binOf, retOf, branchOf, recordNew, fieldGet, fieldSet, listNew, indexGet, indexSet,
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
    // `p.x` -> field-get（与 lua 的 `(dot …)`、go/V 的 `(sel …)` 同一格节点）
    case 'dot': return fieldGet(toNode(kids(x)[0]), leaf(kids(x)[1]));
    case 'line': case 'body': case 'impl': return many(kids(x));
    case 'expr': return toNode(kids(x)[0]);
    // `defer { … }` / `defer: …` -> scope-exit（与 go 的 defer、CL 的 unwind-protect
    // **同一格节点**：逆序、早退也跑，八家共用那一格）
    case 'defer': return node('scope-exit', { action: many(kids(x)) });

    case 'bin': {
      const [op, a, b] = kids(x);
      // `&` 是 nim 的串连接 —— 表里映到 `concat` 那格内建，与算符走同一条路
      return binOf(leaf(op), toNode(a), toNode(b), OPS, { lang: 'nim', and: ['and'], or: ['or'] });
    }
    case 'un': {
      const [op, a] = kids(x);
      // `@[1, 2, 3]`：`@` 是"数组字面量 -> seq"的算符，两格合起来就是一格 list-new
      if (leaf(op) === '@' && tag(a) === 'array-lit') return listNew(many(kids(a)));
      return un(leaf(op) === 'not' ? 'not' : leaf(op), toNode(a));
    }
    case 'array-lit': return listNew(many(kids(x)));
    // `xs[i]` -> index-get（nim 从 0 起，不用减）
    case 'bracket': return indexGet(toNode(kids(x)[0]), toNode(kids(part(x, 'args'))[0]));
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
      const o = leaf(op) === '=' ? null : OPS.get(String(leaf(op)).replace('=', ''));
      if (leaf(op) !== '=' && o === undefined) {
        throw new Error(`nim->graph: 这个复合赋值还没接：${leaf(op)}`);
      }
      // 左边是一格字段（`p.y = 5`）或一格下标（`xs[1] = 5`）⇒ field-set / index-set
      if (tag(lhs) === 'dot') {
        const obj = () => toNode(kids(lhs)[0]);
        const f = leaf(kids(lhs)[1]);
        const v = o === null ? toNode(rhs) : bin(o, fieldGet(obj(), f), toNode(rhs));
        return fieldSet(obj(), f, v);
      }
      if (tag(lhs) === 'bracket') {
        const obj = () => toNode(kids(lhs)[0]);
        const idx = () => toNode(kids(part(lhs, 'args'))[0]);
        const v = o === null ? toNode(rhs) : bin(o, indexGet(obj(), idx()), toNode(rhs));
        return indexSet(obj(), idx(), v);
      }
      const name = nameOf(lhs);
      if (o === null) return node('set', { value: toNode(rhs) }, { name });
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
      return branchOf(
        toNode(cond),
        body === undefined ? [] : many(kids(body)),
        els === undefined ? undefined : many(kids(els)),
      );
    }
    case 'return': return retOf(many(kids(x)));
    // 命令式调用与括号调用是**同一格节点**（语法两条产生式，图上一格）
    case 'call': case 'command': {
      const [fn, args] = kids(x);
      const argKids = args === undefined ? [] : kids(args);
      // `Point(x: 1, y: 2)` -> record-new。**判据是"实参全是 kv"** —— nim 的对象构造
      // 与命名实参在树上是同一格（`kv` 那两条产生式把 `:` 与 `=` 折成一格），
      // 分开它们要驱动器能回问一句"这个名字登记成类型了吗" —— 与 cpp 那笔账是同一笔
      // （`docs/design/node-graph-contract.md` 附录 A.5 第 3 笔）。这一批用形状判，记在账上。
      if (argKids.length > 0 && argKids.every((a) => tag(a) === 'kv')) {
        return recordNew(argKids.map((a) => [nameOf(kids(a)[0]), toNode(kids(a)[1])]));
      }
      const argNodes = many(argKids);
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
//   4. **对象构造与命名实参分不开**：`T(x: 1)` 与 `f(x = 1)` 在树上是同一格 `kv`，
//      这一批按"实参全是 kv"判成 record-new。要分开得驱动器能回问"这名字是类型吗" ——
//      与 cpp 那笔账同一笔（设计文档附录 A.5 第 3 笔）。
