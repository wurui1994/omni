// src/core/cli/layers.js —— **一趟编译里每一层多少东西**（第一百四十七片第五格）
//
// `docs/design/node-graph-shrink.md` 的账原来只在 graph 那台机器上量得出来（`graph/stat.js`
// 数的是**图那一层**那 27 格节点）。可胀不是图那条腿独有的：老那几条（js -> js、asy -> js、
// 前端 -> OIR -> C）胀得更厉害，而它们**还没有显式的图**。
//
// 这一份就是那件事的统一量法：**一趟编译落成一串「层」，每层报「多少格」与「多少字符」，
// 相邻两层之间的比就是那一步的胀。** 层是什么由调用方说（这一份不认识任何一层的形状）：
//   omni 腿   源码 -> AST -> OIR（函数 / 语句）-> 目标文本（C 或 JS）
//   graph 腿  源码 -> 图（节点 / 边）-> 目标文本（C / JS / WAT / sx）
//   .c 腿     源码 -> MIR（指令）-> 目标文本
// 于是「优化方法是统一的」这句话有了统一的**尺子**：哪一层胀、胀多少，两台机器同一张表。
//
// **不认识层的形状**这一条是刻意的：这一层只做算术与排版，所以它是纯的、能判据，
// 而各条腿只管把自己那几个数报上来（与 `statgraph.js` / `graph/stat.js` 同一条纪律）。

/** 一格数的读法：`n` 是「多少格」（节点 / 函数 / 指令…），`bytes` 是那一层的文本大小。 */
function num(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/**
 * 一趟编译的分层账。
 *
 * @param {{bytes:number, lines:number}} src 源码那一层（比例的分母）
 * @param {{name:string, n:number|null, unit:string, bytes:number|null}[]} layers 往后每一层
 */
export function layerModel(src, layers) {
  const s = { bytes: num(src.bytes) ?? 0, lines: num(src.lines) ?? 0 };
  const rows = [];
  for (const L of layers) {
    const n = num(L.n);
    const bytes = num(L.bytes);
    rows.push({
      name: L.name,
      n,
      unit: L.unit ?? '格',
      bytes,
      /* 比的分母**一律是源码**（不是上一层）：链上每一步各乘一个数，而人要看的是
       * 「最后比源码大了几倍」。相邻两层的比一眼能除出来，反过来不行。 */
      ratio: bytes === null || s.bytes === 0 ? null : bytes / s.bytes,
    });
  }
  return { src: s, rows };
}

/** 给人看的一张表。最后一列是**相对源码的字符比** —— 小于 1 才叫「没胀」。 */
export function layerTable(m) {
  const out = [`omni: 各层的账  源码 ${m.src.lines} 行 / ${m.src.bytes} 字符`];
  for (const r of m.rows) {
    const cnt = r.n === null ? '' : `${r.n} ${r.unit}`;
    const by = r.bytes === null ? '' : `${r.bytes} 字符`;
    const ra = r.ratio === null ? '' : `${r.ratio.toFixed(2)}x`;
    out.push(`  ${r.name.padEnd(12)}${cnt.padStart(16)}${by.padStart(14)}${ra.padStart(9)}`);
  }
  /* **胀在哪一步**：只说最后一层的比是不够的（那是乘出来的），要指着那一步说。 */
  const big = m.rows.filter((r) => r.ratio !== null);
  if (big.length > 0) {
    const worst = big.reduce((a, b) => (b.ratio > a.ratio ? b : a));
    out.push(`  最胀的一层：${worst.name}（${worst.ratio.toFixed(2)}x 源码字符）`);
  }
  return `${out.join('\n')}\n`;
}

/**
 * 一棵树上有多少格节点（AST / 别的带 `kind` 的树都能数）。
 *
 * **按 `kind` 认节点**：这棵树上到处是数组与普通对象（`{}` 的属性表、位置信息…），
 * 认 `kind` 才数得到「语法上的一格」。深度封顶 200 层 —— 数一棵树不该有栽在深度上的风险。
 */
export function countNodes(x, depth = 0) {
  if (x === null || x === undefined || depth > 200) return 0;
  if (Array.isArray(x)) {
    let n = 0;
    for (const y of x) n += countNodes(y, depth + 1);
    return n;
  }
  if (typeof x !== 'object') return 0;
  let n = typeof x.kind === 'string' ? 1 : 0;
  for (const k of Object.keys(x)) {
    if (k === 'span' || k === 'loc' || k === 'type' || k === 'parent') continue;
    n += countNodes(x[k], depth + 1);
  }
  return n;
}

/**
 * 时间去哪儿了（`--stat` 的另一半）：把 `vStep` 攒的那串步骤排成一张表。
 *
 * 印**执行顺序**而不是排序后的次序：这条流水线是一串因果，谁在谁后面本身就是信息；
 * 「谁最贵」另起一行说。低于 1ms 的那些合成一行 —— 一趟编译几十个步骤，全印就成噪声。
 */
export function stepTable(steps) {
  let total = 0;
  for (const [, ms] of steps) total += ms;
  const out = [`omni: 时间去哪儿了  ${steps.length} 步 / 合计 ${total}ms`];
  let small = 0;
  let smallN = 0;
  for (const [msg, ms] of steps) {
    if (ms < 1) { small += ms; smallN += 1; continue; }
    const pct = total > 0 ? (ms * 100) / total : 0;
    out.push(`  ${String(ms).padStart(7)}ms ${pct.toFixed(1).padStart(5)}%  ${msg}`);
  }
  if (smallN > 0) out.push(`  ${String(small).padStart(7)}ms        （另外 ${smallN} 步各不到 1ms）`);
  if (steps.length > 0) {
    const worst = steps.reduce((a, b) => (b[1] > a[1] ? b : a));
    out.push(`  最贵的一步：${worst[0]}（${worst[1]}ms）`);
  }
  return `${out.join('\n')}\n`;
}
