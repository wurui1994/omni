// src/core/graph/graph.js —— 图：节点 + 四种边（value / effect / bind / region）
//
// 与 AST 的差别只有一句话，但它是整份设计的支点：**"我要用它"只能写成一条边**（I4）。
// 所以这一份不提供"随便挂个字段"的口子 —— 建节点时每一格入端口都要对上声明（G1），
// 对不上当场炸，不留"以后再接"的模糊地带。
//
// 表示上刻意省事：`value` 边写成入端口里那个引用（`{node}` 或 `{lit}`），
// `effect` 边由**声明 + 源序**算出来（不 pure 的节点按源序连），不落成数据；
// `bind` 边就是名字（求值时按 region 链查，与 ADR-0029 的作用域图同一件事）；
// `region` 边是 `region` / `func` / `loop` 的 body 端口本身。
// 这三条"算出来的边"不许被手写 —— 判据在 eval 里（次序只有一处实现）。

import { declOf } from './nodes.js';

let seq = 0;

/**
 * 造一格节点。
 *
 * @param {string} op 节点名（必须在 NODES 里）
 * @param {Record<string, any>} ins 入端口：名字 -> 引用（节点 / 字面量 / 数组）
 * @param {Record<string, any>} attrs 附属那一栏（名字、算子、形参表 …）
 */
export function node(op, ins = {}, attrs = {}) {
  const d = declOf(op);
  const n = { id: ++seq, op, ins: {}, attrs: {}, span: attrs.span ?? null };
  // G1 边完整：引用的每一格都要能在入端口里找到
  for (const k of Object.keys(ins)) {
    if (!d.ins.some((p) => p.name === k)) {
      throw new Error(`node ${op} has no in-port "${k}" (ports: ${d.ins.map((p) => p.name).join(', ')})`);
    }
    n.ins[k] = ins[k];
  }
  for (const p of d.ins) {
    if (p.optional || p.rest || n.ins[p.name] !== undefined) continue;
    if (n.ins[p.name] === undefined) throw new Error(`node ${op} misses in-port "${p.name}"`);
  }
  for (const k of Object.keys(attrs)) {
    if (k === 'span') continue;
    if (!d.attrs.includes(k)) throw new Error(`node ${op} has no attr "${k}" (attrs: ${d.attrs.join(', ')})`);
    n.attrs[k] = attrs[k];
  }
  return n;
}

/** 一格字面量（不是节点 —— 它连边都不占）。 */
export const lit = (value) => ({ lit: value });

/** 一份程序 = 一块顶层子图。接口 = 跨边界的端口 + 效应签名（这一批还只有一个出口）。 */
export function program(body) {
  return { kind: 'graph', body };
}

/**
 * `sx` 序列化 —— **图的一种写法，不是中间语言的文本形式**
 * （`docs/design/node-graph-contract.md` §5.2：sx 退成序列化，人看的、diff 用的）。
 * 后端不许读它（后端读的是图 + 契约五问）。
 */
export function toSx(x, depth = 0) {
  const pad = '  '.repeat(depth);
  if (x === null || x === undefined) return `${pad}()`;
  if (Array.isArray(x)) return x.map((y) => toSx(y, depth)).join('\n');
  if (x.kind === 'graph') return `${pad}(graph\n${toSx(x.body, depth + 1)})`;
  if (x.lit !== undefined) return `${pad}(lit ${JSON.stringify(x.lit)})`;
  if (x.op === undefined) return `${pad}${JSON.stringify(x)}`;
  const head = [`${pad}(${x.op}`];
  for (const [k, v] of Object.entries(x.attrs)) head.push(` :${k} ${JSON.stringify(v)}`);
  const parts = [head.join('')];
  for (const [k, v] of Object.entries(x.ins)) {
    parts.push(`\n${pad}  :${k}`);
    parts.push(`\n${toSx(v, depth + 2)}`);
  }
  parts.push(')');
  return parts.join('');
}

/**
 * **算符的糖**：`a + b`（lua / go / …）与 `(+ a b)`（chez / sbcl）落的是同一格 `prim` ——
 * 算符没有自己的节点（原来的 `binop` / `unop` 已经并进去了，见 `prims.js` 文件头）。
 *
 * 这两个不是新节点，是**九门语言映射里那句重复的话只写一遍**：原来每份 tograph.js 都要
 * 拼一遍 `node('binop', { a, b }, { op })`。
 */
export const bin = (op, a, b) => node('prim', { args: [a, b] }, { name: op });
export const un = (op, a) => node('prim', { args: [a] }, { name: op });
