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
    // 附属的值不许是 `undefined`：**"没有这一格"要靠不给这个键来说**
    // （chez / sbcl 的匿名 lambda 一直是这么写的 —— `{ params }`，不带 name）。
    // 给 `undefined` 的代价量过：`toSx` 会把它印成字面的 `undefined`，那份文本读回来当场报
    // "这一格附属的值不是 JSON" —— 也就是"图的一种写法"破在一格看不见的地方。
    // 所以在建图这一步就拦住，而不是等序列化那条腿去红。
    if (attrs[k] === undefined) {
      throw new Error(`node ${op} attr "${k}" is undefined —— 没有这一格就别给这个键`);
    }
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
 *
 * **一格端口装的是"一个"还是"一串"要写出来**：`:k` 是一个，`:k*` 是一串（可以是空串）。
 * 头一版没有那颗星，于是 `:body` 后面跟着两格节点，读回来分不清"一串两格"与"一格节点
 * 后面又跟了一格"，空的一串更是连痕迹都没有 —— 那样的文本**读不回来**，
 * "图的一种写法"这句话就只有一半是真的。这颗星是让 `fromSx` 成立的最小代价。
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
    const many = Array.isArray(v);
    parts.push(`\n${pad}  :${k}${many ? '*' : ''}`);
    if (many && v.length === 0) continue;       // 空的一串：只留 `:k*`
    parts.push(`\n${toSx(v, depth + 2)}`);
  }
  parts.push(')');
  return parts.join('');
}

/**
 * `sx` 文本 -> 图。**判据不是"读得进来"，是"读回来还是同一张图"** ——
 * `toSx(fromSx(t)) === t` 逐字节相同（`tests/graph/run.js` 的 sx 那一格每份例子都验），
 * 而且读回来的图交给默认解释器跑，输出与别的腿逐行相同。
 *
 * 这一格刻意**不**走 `node()`：`node()` 要查五栏声明（那是建图时的判据），
 * 而这儿要能读进"删了一格节点之后的老文本"并当场报出哪一格不认得 —— 所以自己拼，
 * 拼完再让 `node()` 查一遍（下面 `mk` 那一句）。
 */
export function fromSx(text) {
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i += 1; };
  const fail = (msg) => { throw new Error(`sx: ${msg}（第 ${i} 个字符处）`); };
  /** 一格 JSON 值：从当前位置起按括号 / 引号配平地取一段，再交给 JSON.parse */
  const jsonAt = () => {
    ws();
    const start = i;
    if (text[i] === '"' || text[i] === '[' || text[i] === '{') {
      const open = text[i];
      const close = open === '"' ? '"' : (open === '[' ? ']' : '}');
      let depth = 0;
      let inStr = open === '"';
      i += 1;
      if (inStr) {
        while (i < text.length) {
          if (text[i] === '\\') { i += 2; continue; }
          if (text[i] === '"') { i += 1; break; }
          i += 1;
        }
      } else {
        depth = 1;
        while (i < text.length && depth > 0) {
          const c = text[i];
          if (c === '"') { i += 1; while (i < text.length && text[i] !== '"') i += (text[i] === '\\' ? 2 : 1); }
          else if (c === open) depth += 1;
          else if (c === close) depth -= 1;
          i += 1;
        }
      }
    } else {
      while (i < text.length && !/[\s)]/.test(text[i])) i += 1;
    }
    try {
      return JSON.parse(text.slice(start, i));
    } catch {
      return fail(`这一格附属的值不是 JSON：${text.slice(start, i).slice(0, 30)}`);
    }
  };
  const atom = () => {
    ws();
    const start = i;
    while (i < text.length && !/[\s()]/.test(text[i])) i += 1;
    if (i === start) fail('这儿应该有一个名字');
    return text.slice(start, i);
  };
  /** 一格形式：`(graph …)` / `(lit V)` / `(op :attr V … :port … :port* …)` */
  const form = () => {
    ws();
    if (text[i] !== '(') fail('这儿应该是一个 (');
    i += 1;
    const head = atom();
    if (head === 'graph') {
      const body = nodes();
      ws();
      if (text[i] !== ')') fail('(graph …) 没收口');
      i += 1;
      return { kind: 'graph', body };
    }
    if (head === 'lit') {
      const v = jsonAt();
      ws();
      if (text[i] !== ')') fail('(lit V) 没收口');
      i += 1;
      return { lit: v };
    }
    const ins = {};
    const attrs = {};
    for (;;) {
      ws();
      if (text[i] === ')') { i += 1; break; }
      if (text[i] !== ':') fail(`(${head} …) 里这一格既不是 : 也不是收口`);
      i += 1;
      const nm = atom();
      if (nm.endsWith('*')) { ins[nm.slice(0, -1)] = nodes(); continue; }
      ws();
      if (text[i] === '(') { ins[nm] = form(); continue; }
      attrs[nm] = jsonAt();
    }
    return node(head, ins, attrs);
  };
  /** 一串形式：读到 `)` 或下一格 `:` 为止 */
  const nodes = () => {
    const out = [];
    for (;;) {
      ws();
      if (i >= text.length || text[i] === ')' || text[i] === ':') return out;
      out.push(form());
    }
  };
  const g = form();
  ws();
  if (i < text.length) fail('这份 sx 后面还有多余的东西');
  return g;
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
