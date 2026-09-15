// ext/sbcl/tograph.js —— **Common Lisp 的 datum 树 -> 节点图**（第四个前端）
//
// 与 `ext/chez/tograph.js` 只差一张词汇表（`defun` vs `define`、`setq` vs `set!`、
// `princ` vs `display`）—— 这正是"两门语言共用同一批节点"最便宜的一份证据：
// 树的形状一样、词汇不同，落到的节点完全相同。
//
// CL 独有的两格在这一批里怎么记：
//   * `(defun f (a b) …)` 的形参表可以带 `&optional` / `&rest` —— 元数分派是
//     `callable` 的一格**附属**（chez 那份规格 §3.2 第 2 条），这一批只收定长。
//   * 多值（`values`）、条件系统、CLOS 都不在这一批（`ext/sbcl/SPEC.md` §五那张顺序表）。

import { node, lit, program } from '../../src/core/graph/graph.js';

const isList = (x) => x !== null && x !== undefined && x.kind === 'list';
const head = (x) => (isList(x) && x.items[0]?.kind === 'atom' ? x.items[0].value : null);
const kids = (x) => (isList(x) ? x.items.slice(1) : []);
const leaf = (x) => (x === null || x === undefined || x.kind === 'list' ? null : x.value);
const text = (x) => (isList(x) && x.items.length > 1 ? leaf(x.items[1]) : null);
const symName = (x) => (head(x) === 'sym' ? text(x) : null);
const asList = (x) => (head(x) === 'list' ? kids(x) : null);

/** CL 的内建 -> `prim` 那一格。`princ` / `print` / `write` 都是打印。 */
const PRIM = new Map([
  ['princ', 'print'], ['print', 'print'], ['write', 'print'], ['write-line', 'print'],
  ['+', '+'], ['-', '-'], ['*', '*'], ['/', '/'],
  ['<', '<'], ['>', '>'], ['<=', '<='], ['>=', '>='], ['=', '='], ['eql', '='], ['equal', '='],
  ['not', 'not'], ['null', 'not'], ['concatenate', 'concat'], ['length', 'len'],
]);

const many = (xs) => xs.map(toNode);

function toNode(x) {
  switch (head(x)) {
    case 'num': return node('const', {}, { value: Number(text(x)) });
    case 'str': return node('const', {}, { value: text(x) });
    case 'sym': {
      const n = text(x);
      if (n === 't') return node('const', {}, { value: true });
      if (n === 'nil') return node('const', {}, { value: null });
      return node('ref', {}, { name: n });
    }
    case 'quote': return node('const', {}, { value: `'${text(kids(x)[0]) ?? '?'}'` });
    default: break;
  }

  const items = asList(x);
  if (items === null) throw new Error(`sbcl->graph: 这一格 datum 还没接：${head(x)}`);
  if (items.length === 0) return node('const', {}, { value: null });

  const op = symName(items[0]);
  const rest = items.slice(1);

  switch (op) {
    case 'defun': {
      const name = symName(rest[0]);
      const params = (asList(rest[1]) ?? []).map((p) => symName(p));
      return node('bind', { init: node('func', { body: many(rest.slice(2)) }, { params, name }) }, { name });
    }
    case 'lambda': {
      const params = (asList(rest[0]) ?? []).map((p) => symName(p));
      return node('func', { body: many(rest.slice(1)) }, { params });
    }
    case 'setq': case 'setf': return node('set', { value: toNode(rest[1]) }, { name: symName(rest[0]) });
    case 'defparameter': case 'defvar': case 'defconstant':
      return node('bind', { init: rest[1] === undefined ? lit(null) : toNode(rest[1]) }, { name: symName(rest[0]) });
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
    case 'progn': return node('region', { body: many(rest) });
    case 'let': case 'let*': {
      const binds = (asList(rest[0]) ?? []).map((b) => {
        const pair = asList(b) ?? [];
        return node('bind', { init: pair[1] === undefined ? lit(null) : toNode(pair[1]) }, { name: symName(pair[0]) });
      });
      return node('region', { body: [...binds, ...many(rest.slice(1))] });
    }
    // `(dotimes (i n) …)` —— CL 的计数循环。落成 region + loop + set（不给它开节点）
    case 'dotimes': {
      const spec = asList(rest[0]) ?? [];
      const i = symName(spec[0]);
      return node('region', {
        body: [
          node('bind', { init: lit(0) }, { name: i }),
          node('loop', {
            cond: node('binop', { a: node('ref', {}, { name: i }), b: toNode(spec[1]) }, { op: '<' }),
            body: [
              ...many(rest.slice(1)),
              node('set', {
                value: node('binop', { a: node('ref', {}, { name: i }), b: lit(1) }, { op: '+' }),
              }, { name: i }),
            ],
          }),
        ],
      });
    }
    case 'terpri': return node('prim', { args: [lit('')] }, { name: 'print' });
    default: break;
  }

  if (op !== null && PRIM.has(op)) return node('prim', { args: many(rest) }, { name: PRIM.get(op) });
  return node('call', { fn: toNode(items[0]), args: many(rest) });
}

/** 一棵 sbcl 的 GLR 树（`(program datum…)`）-> 一张图。 */
export function sbclToGraph(tree) {
  if (head(tree) !== 'program') throw new Error('sbcl->graph: 这不是 (program …)');
  return program(many(kids(tree)));
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. `&optional` / `&rest` / 关键字形参不收（元数分派是 callable 的附属）。
//   2. `format` 那一族没接（它是一格运行期解释的格式串 —— 与 printf 同一笔账）。
//   3. 多值、条件系统（`handler-bind` / restart）、CLOS 都不在这一批。
