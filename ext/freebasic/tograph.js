// ext/freebasic/tograph.js —— **FreeBASIC 的树 -> 节点图**（第七个前端）
//
// 这一门在语法上离前六门最远（行导向、块靠关键字收尾、自带词序的语句一大批），
// 可它落到的还是那 13 格 —— `ext/freebasic/SPEC.md` §3.5 那句话的可跑版本：
// **"语法难 ≠ 节点多"**。
//
// 两格要单独说的：
//   * **`=` 既是赋值也是比较**（同一个记号）。语法层刻意不分（分了就 113 份文件两个解），
//     所以"到底是哪一种"在这一份里按**位置**判：语句位置上的 `(bin "=" …)` 是赋值。
//     这正是那句"留给语义层"真正该落的地方 —— 图这一层，不是语法层。
//   * 串字面量的引号**留在记号文本里**（`(str "\"ok\"")`），这儿剥掉。

import { node, lit, program } from '../../src/core/graph/graph.js';

const isList = (x) => x !== null && x !== undefined && x.kind === 'list';
const tag = (x) => (isList(x) && x.items[0]?.kind === 'atom' ? x.items[0].value : null);
const kids = (x) => (isList(x) ? x.items.slice(1) : []);
const leaf = (x) => (x === null || x === undefined || x.kind === 'list' ? null : x.value);
const part = (x, name) => kids(x).find((y) => tag(y) === name);
const unquote = (s) => (typeof s === 'string' && s.length >= 2 && s[0] === '"' ? s.slice(1, -1) : s);

const OPS = new Map([
  ['+', '+'], ['-', '-'], ['*', '*'], ['/', '/'], ['mod', '%'],
  ['<', '<'], ['>', '>'], ['<=', '<='], ['>=', '>='], ['=', '='], ['<>', '!='],
  ['&', 'concat'],
]);

const many = (xs) => xs.map(toNode).flat();
const nameOf = (x) => (tag(x) === 'n' ? leaf(kids(x)[0]) : leaf(x));

function toNode(x) {
  // 空表：空行、只有注释的行、`(mods)` 那种空部件 —— 图上什么都不占
  if (isList(x) && x.items.length === 0) return [];
  switch (tag(x)) {
    case 'num': return node('const', {}, { value: Number(leaf(kids(x)[0])) });
    case 'str': return node('const', {}, { value: unquote(leaf(kids(x)[0])) });
    case 'n': return node('ref', {}, { name: leaf(kids(x)[0]) });
    case 'paren': return toNode(kids(x)[0]);
    // 一行 = 一条或几条语句（`:` 隔开的那几条也在这一格里）
    case 'line': return many(kids(x));
    case 'body': return many(kids(x));

    case 'bin': {
      const [op, a, b] = kids(x);
      const o = OPS.get(String(leaf(op)).toLowerCase());
      if (leaf(op) === 'andalso' || leaf(op) === 'and') {
        return node('branch', { cond: toNode(a), then: toNode(b), else: lit(false) });
      }
      if (leaf(op) === 'orelse' || leaf(op) === 'or') {
        return node('branch', { cond: toNode(a), then: lit(true), else: toNode(b) });
      }
      if (o === undefined) throw new Error(`fb->graph: 这个算子还没接：${leaf(op)}`);
      if (o === 'concat') return node('prim', { args: [toNode(a), toNode(b)] }, { name: 'concat' });
      return node('binop', { a: toNode(a), b: toNode(b) }, { op: o });
    }
    case 'un': {
      const [op, a] = kids(x);
      return node('unop', { a: toNode(a) }, { op: leaf(op) === 'not' ? 'not' : leaf(op) });
    }
    // 语句位置上的表达式：**顶上是 `=` 就是赋值**（见文件头第一条）
    case 'expr': {
      const inner = kids(x)[0];
      if (tag(inner) === 'bin' && leaf(kids(inner)[0]) === '=') {
        const [, lhs, rhs] = kids(inner);
        return node('set', { value: toNode(rhs) }, { name: nameOf(lhs) });
      }
      return toNode(inner);
    }
    case 'augassign': {
      const [op, lhs, rhs] = kids(x);
      const o = OPS.get(String(leaf(op)).replace('=', '').trim().toLowerCase());
      const name = nameOf(lhs);
      if (o === undefined) throw new Error(`fb->graph: 这个复合赋值还没接：${leaf(op)}`);
      return node('set', {
        value: node('binop', { a: node('ref', {}, { name }), b: toNode(rhs) }, { op: o }),
      }, { name });
    }
    // `dim [mods] (v (n 名字) 类型 (init …))` —— **类型丢掉**（它是端口的 sort）
    case 'dim': case 'static': case 'const': case 'f': {
      const vs = kids(x).filter((y) => tag(y) === 'v');
      return vs.map((v) => {
        const init = part(v, 'init');
        return node('bind', {
          init: init === undefined ? lit(null) : toNode(kids(init)[0]),
        }, { name: nameOf(kids(v)[0]) });
      });
    }
    case 'routine': {
      const head = part(x, 'head');
      const nm = kids(head).find((y) => tag(y) === 'n');
      const name = nm === undefined ? null : leaf(kids(nm)[0]);
      const ps = kids(head).find((y) => tag(y) === 'params');
      const params = ps === undefined ? [] : kids(ps).map((p) => nameOf(kids(p)[0]));
      const body = part(x, 'body');
      return node('bind', {
        init: node('func', { body: body === undefined ? [] : many(kids(body)) }, { params, name }),
      }, { name });
    }
    // `for i as T = a to b … next` —— region + bind + loop + set（`for` 不给节点）
    case 'for': {
      const head = part(x, 'head');
      const body = part(x, 'body');
      const i = nameOf(kids(head)[0]);
      const from = part(head, 'from');
      const to = part(head, 'to');
      const step = part(head, 'step');
      return node('region', {
        body: [
          node('bind', { init: toNode(kids(from)[0]) }, { name: i }),
          node('loop', {
            cond: node('binop', {
              a: node('ref', {}, { name: i }),
              b: toNode(kids(to)[0]),
            }, { op: '<=' }),
            body: [
              ...(body === undefined ? [] : many(kids(body))),
              node('set', {
                value: node('binop', {
                  a: node('ref', {}, { name: i }),
                  b: step === undefined ? lit(1) : toNode(kids(step)[0]),
                }, { op: '+' }),
              }, { name: i }),
            ],
          }),
        ],
      });
    }
    case 'while': case 'do': {
      const cond = kids(x).find((y) => tag(y) !== 'body');
      const body = part(x, 'body');
      return node('loop', {
        cond: cond === undefined ? lit(true) : toNode(cond),
        body: body === undefined ? [] : many(kids(body)),
      });
    }
    case 'if': {
      const parts = kids(x);
      const cond = parts[0];
      const then = part(x, 'body');
      const els = part(x, 'else');
      return node('branch', {
        cond: toNode(cond),
        then: then === undefined ? [] : many(kids(then)),
        ...(els === undefined ? {} : { else: many(kids(els)) }),
      });
    }
    case 'return': {
      const vals = kids(x);
      return node('ret', vals.length === 0 ? {} : { value: toNode(vals[0]) });
    }
    case 'print': return node('prim', { args: many(kids(x)) }, { name: 'print' });
    case 'call': {
      const [fn, args] = kids(x);
      const argNodes = args === undefined ? [] : many(kids(args));
      return node('call', { fn: toNode(fn), args: argNodes });
    }
    // 命令式调用（`f a, b`）：这一批只在"名字 + 实参"这一种形状上接
    case 'command': {
      const [fn, args] = kids(x);
      return node('call', { fn: toNode(fn), args: args === undefined ? [] : many(kids(args)) });
    }
    case 'scope': return node('region', { body: many(kids(part(x, 'body') ?? { kind: 'list', items: [] })) });
    default:
      throw new Error(`fb->graph: 这一格还没接：${tag(x) ?? JSON.stringify(x).slice(0, 40)}`);
  }
}

/** 一棵 freebasic 的 GLR 树（`(module 项…)`）-> 一张图。 */
export function fbToGraph(tree) {
  if (tag(tree) !== 'module') throw new Error('fb->graph: 这不是 (module …)');
  return program(kids(tree).map(toNode).flat());
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. 自带词序的语句只接 `print`（`line` / `get` / `put` / `draw` 那一大批在图上是
//      `prim` + 外部 IO，量大不难 —— `ext/freebasic/SPEC.md` §3.5）。
//   2. `Type` / `Union` / 属性（`Property Get/Set`）/ `Gosub` 都不在这一批。
//   3. 定宽整数与四种字符串表示丢掉了 —— 它们是**方言必须有"按宽度读写"**那笔账
//      （SPEC §五第 1 项），要用起来是契约 `carry` 那一问的事。
