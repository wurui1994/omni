/**
 * 图的形状与结构（`--engine graph --stat`，第一百四十七片第三格）。**纯计算**：
 * 进来一张图，出去一组数与几种印法 —— 不碰宿主，于是判据直接喂图、比数。
 *
 * 为什么要这一格：`docs/design/node-graph-shrink.md` 钉的第三条要求是「**变换是减法**：
 * 每个 pass 要能报出删了几格节点，加不回去」。而那句话要成立，先得有「一张图有多少格、
 * 都是些什么格」这个量 —— 没有它，「缩了没有」只能靠感觉。
 *
 * 量的四样，都是**图这一层问得出来**的（MIR 上已经问不出来了）：
 *   - 节点数与**按 op 的分布**：形状。`record-new` 变成一串 store 之前，它还是一格。
 *   - 边数与字面量数：结构。装箱一个字面量在这儿看得见（shrink 文档第二节那三行账）。
 *   - 深度：嵌套。
 *   - **纯 / 有效应**：`prims.js` 那一栏声明的效应（pure 的可重排、可共享、可删）——
 *     这一栏正是变换的本钱，所以它要能被数出来。
 *
 * 三种印法（同一份数据）：表（给人看）、json（给工具）、dot（看结构）。
 * 外加一格 `statDiff`：两张图**按 op 逐格相减** —— 那就是「这个 pass 删了几格」的答案。
 *
 * 两处要说清的读法（不然数会被误读）：
 *   - 「字面量」只数**内联的那种**（`graph.js` 的 `lit(v)` = `{lit:v}`，连边都不占）。
 *     装成一格节点的那种叫 `const`，它在 op 那张表里 —— 两者的差正是「装箱了没有」。
 *   - 「深度」是**头一次走到那一格时的深度**：图是 DAG，一格被两处引用时不重复往下走
 *     （不然共享一多就成指数）。所以它是下界，不是最长路。
 */

import { isPure, declOf } from './nodes.js';

/** 是不是一格节点（字面量 `{lit}` 与数组都不是）。 */
function isNode(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
    && typeof x.op === 'string' && x.ins !== undefined;
}

/**
 * 走一遍图。**按 id 记数、不重复走同一格**（图是 DAG：一格节点可以被多处引用，
 * 那正是「可共享」那一栏的意思 —— 数节点要按身份数，不然共享的节点会被数两遍）。
 */
export function graphStat(g) {
  const root = g !== null && g !== undefined && g.kind === 'graph' ? g.body : g;
  const ops = new Map();
  const seen = new Set();
  let nodes = 0;
  let edges = 0;
  let lits = 0;
  let pure = 0;
  let effect = 0;
  const effects = new Map();
  let depth = 0;

  const walk = (x, d) => {
    if (Array.isArray(x)) {
      for (const y of x) walk(y, d);
      return;
    }
    if (x !== null && typeof x === 'object' && x.lit !== undefined) { lits += 1; return; }
    if (!isNode(x)) return;
    if (d > depth) depth = d;
    if (seen.has(x.id)) return;                 /* 共享的那一格只算一次 */
    seen.add(x.id);
    nodes += 1;
    const key = x.op === 'prim' && typeof x.attrs?.name === 'string' ? `prim:${x.attrs.name}` : x.op;
    ops.set(key, (ops.get(key) ?? 0) + 1);
    if (isPure(x)) pure += 1;
    else {
      effect += 1;
      /* 效应分格：`prim` 那一族的效应看内建名字（见 nodes.js 的 isPure），别的看声明。 */
      let list = [];
      try {
        list = x.op === 'prim' ? ['prim'] : declOf(x.op).effects;
      } catch (e) {
        list = [];
      }
      for (const ef of list) effects.set(ef, (effects.get(ef) ?? 0) + 1);
    }
    for (const k of Object.keys(x.ins)) {
      const v = x.ins[k];
      if (Array.isArray(v)) {
        for (const y of v) {
          if (isNode(y)) edges += 1;
          walk(y, d + 1);
        }
      } else {
        if (isNode(v)) edges += 1;
        walk(v, d + 1);
      }
    }
  };
  walk(root, 1);
  return { nodes, edges, lits, pure, effect, depth, ops, effects };
}

/** 排好序的 op 分布（数量降序、同数按名字）——**输出要确定**，不然两张表没法比。 */
function sortedOps(ops) {
  return [...ops.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
}

/** 给人看的一张表。`top` 是 op 分布印几行（0 = 全印）。 */
export function graphStatTable(s, top = 12) {
  const out = [];
  out.push(`omni: 图的形状  节点 ${s.nodes} 格、边 ${s.edges} 条、字面量（内联）${s.lits} 个、`
    + `深度 ${s.depth}；纯 ${s.pure} / 有效应 ${s.effect}`);
  const rows = sortedOps(s.ops);
  const lim = top > 0 && rows.length > top ? top : rows.length;
  out.push(`  按 op 的分布（${rows.length} 种，印前 ${lim}）`);
  for (let i = 0; i < lim; i++) {
    out.push(`    ${String(rows[i][1]).padStart(5)}  ${rows[i][0]}`);
  }
  const efs = [...s.effects.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
  if (efs.length > 0) {
    out.push('  效应（这一栏是变换的本钱：pure 的可重排 / 可共享 / 可删）');
    for (const [k, v] of efs) out.push(`    ${String(v).padStart(5)}  ${k}`);
  }
  return `${out.join('\n')}\n`;
}

/** 给工具吃的那一份。次序按名字，于是同一张图两次出来逐字节相同。 */
export function graphStatJson(s) {
  const ops = {};
  for (const [k, v] of [...s.ops.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) ops[k] = v;
  const effects = {};
  for (const [k, v] of [...s.effects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) effects[k] = v;
  return `${JSON.stringify({
    nodes: s.nodes, edges: s.edges, lits: s.lits, depth: s.depth,
    pure: s.pure, effect: s.effect, ops, effects,
  }, null, 2)}\n`;
}

/**
 * 图的**结构**印成 graphviz：一格节点一个方框（`prim` 带上内建名字），边按入端口标名字。
 * 大图上这一份会很大 —— 它是「看一眼形状」用的，不是给几万格的图用的。
 */
export function graphStatDot(g, limit = 400) {
  const root = g !== null && g !== undefined && g.kind === 'graph' ? g.body : g;
  const out = ['digraph graph_shape {', '  rankdir=TB;',
    '  node [shape=box, fontname="monospace", fontsize=10];'];
  const seen = new Set();
  let n = 0;
  const walk = (x) => {
    if (Array.isArray(x)) { for (const y of x) walk(y); return; }
    if (!isNode(x) || seen.has(x.id) || n >= limit) return;
    seen.add(x.id);
    n += 1;
    const nm = x.op === 'prim' && typeof x.attrs?.name === 'string' ? `prim ${x.attrs.name}` : x.op;
    const tag = isPure(x) ? '' : ' *';               /* 星号 = 有效应 */
    out.push(`  g${x.id} [label="${nm}${tag}"];`);
    for (const k of Object.keys(x.ins)) {
      const v = x.ins[k];
      const kids = Array.isArray(v) ? v : [v];
      for (const y of kids) {
        if (!isNode(y)) continue;
        out.push(`  g${x.id} -> g${y.id} [label="${k}"];`);
      }
      for (const y of kids) walk(y);
    }
  };
  walk(root);
  if (n >= limit) out.push(`  more [label="… 还有更多（印到 ${limit} 格为止）", shape=plaintext];`);
  out.push('}');
  return `${out.join('\n')}\n`;
}

/**
 * 两张图**逐格相减**（`docs/design/node-graph-shrink.md` 第三条：变换是减法）。
 *
 * 回的是「总数的差 + 按 op 的差」，正负都留着 —— 一个 pass 常常是「删掉 3 格 record-new、
 * 加上 5 格 store」，那时候「净减 -2」这个数才是真话。
 */
export function graphStatDiff(a, b) {
  const keys = new Set([...a.ops.keys(), ...b.ops.keys()]);
  const ops = [];
  for (const k of [...keys].sort((x, y) => (x < y ? -1 : 1))) {
    const d = (b.ops.get(k) ?? 0) - (a.ops.get(k) ?? 0);
    if (d !== 0) ops.push([k, d]);
  }
  return {
    nodes: b.nodes - a.nodes, edges: b.edges - a.edges, lits: b.lits - a.lits,
    depth: b.depth - a.depth, pure: b.pure - a.pure, effect: b.effect - a.effect, ops,
  };
}

/** 差印成给人看的一段。`+` 是胀、`-` 是缩 —— 缩是目标（shrink 文档第一节）。 */
export function graphStatDiffTable(d) {
  const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
  const out = [`omni: 图的差  节点 ${sign(d.nodes)}、边 ${sign(d.edges)}、`
    + `字面量 ${sign(d.lits)}、深度 ${sign(d.depth)}；纯 ${sign(d.pure)} / 有效应 ${sign(d.effect)}`];
  if (d.ops.length === 0) out.push('  按 op：一格都没变');
  else {
    out.push('  按 op 的差（+ 是胀，- 是缩）');
    for (const [k, n] of d.ops) out.push(`    ${sign(n).padStart(6)}  ${k}`);
  }
  return `${out.join('\n')}\n`;
}
