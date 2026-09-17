/**
 * 构建统计与依赖图（`--stat`，第一百四十七片第二格）。**纯计算**：进来是模块图与产出
 * 分布，出去是文本 / DOT / JSON —— 不碰宿主，于是判据可以直接喂数据比对。
 *
 * 为什么把「依赖图」和「产出统计」摆在一处：这两件事只有**对在一起**才回答得了那个真问题
 * ——「这一份产物里的字节是谁带来的」。单看依赖图只知道谁 import 谁（形状），单看产出分布
 * 只知道谁大（体积）；合起来才看得见「一个 12K 的模块被 12 个模块依赖」这种该动手的地方。
 *
 * 三种出口，都是**同一份数据的不同印法**（与 `--explain` / `-v` 那一对同一个规矩）：
 *   table  给人看的一张表（stderr）
 *   dot    graphviz（`dot -Tsvg` 出图；节点标签带字节数）
 *   json   给别的工具吃
 */

/** 只留文件名那一段：全路径在图上占死了宽度，而同名冲突在这棵树里没有过。 */
function shortOf(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? p : p.slice(i + 1);
}

/**
 * 把 `modPath`（id -> 路径）、`imports`（id -> Set<id>）与 `stats`（源文件名 -> 产出）
 * 揉成一张表：每个模块一行，带它的产出与出入度。
 *
 * `stats` 的键是**显示名**（前端里 `display(real)` 的结果），而 `modPath` 是 realpath ——
 * 两边按「结尾对得上」配（`endsWith`）。配不上的模块产出记 0：那是诚实的答案
 * （摇树把它整份摇掉了，或者它只有类型没有函数）。
 */
export function statModel({ modPath, imports, stats, funcs }) {
  const ids = [...modPath.keys()].sort((a, b) => a - b);
  const rows = new Map();
  /* **摇树之后每个模块还剩几个函数**：OIR 的每个函数身上带着它是哪个模块的
   * （`hir/check.js` 那句 `mod: decl.mod ?? 0`）。这一格比字节数更靠得住 ——
   * 生成的 C 那侧目前只在自编译那条腿上按源文件归属，`.omni` 那条腿上 cgen 只报一格
   * `(unknown)`（量出来的），所以字节那一栏可能是 0，函数这一栏永远有。 */
  const fnOf = new Map();
  if (Array.isArray(funcs)) {
    for (const f of funcs) {
      const id = f.mod ?? 0;
      fnOf.set(id, (fnOf.get(id) ?? 0) + 1);
    }
  }
  for (const id of ids) {
    const path = modPath.get(id);
    let bytes = 0;
    let lines = 0;
    let funcN = fnOf.get(id) ?? 0;
    if (stats !== undefined && stats !== null) {
      for (const [k, v] of stats.entries()) {
        if (k === '(unknown)') continue;
        if (k === path || path.endsWith(k) || k.endsWith(shortOf(path))) {
          bytes += v.bytes ?? 0;
          lines += v.lines ?? 0;
        }
      }
    }
    rows.set(id, { id, path, short: shortOf(path), bytes, lines, funcs: funcN, out: [], in: 0 });
  }
  let edges = 0;
  for (const id of ids) {
    const kids = imports.get(id);
    if (kids === undefined) continue;
    for (const k of kids) {
      if (!rows.has(k)) continue;
      rows.get(id).out.push(k);
      rows.get(k).in += 1;
      edges += 1;
    }
  }
  /* 最长链：图是**无环的**（load.js 见到环就抛），所以一遍记忆化就够。
   * 报的是「层数」与那一条具体的链 —— 只报数字的话没法验证。 */
  const memo = new Map();
  const chainOf = (id) => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    let best = [id];
    for (const k of rows.get(id).out) {
      const c = chainOf(k);
      if (c.length + 1 > best.length) best = [id, ...c];
    }
    memo.set(id, best);
    return best;
  };
  let longest = [];
  for (const id of ids) {
    const c = chainOf(id);
    if (c.length > longest.length) longest = c;
  }
  return { rows, ids, edges, longest };
}

/** 一张给人看的表（stderr）。`top` 是每一栏印几行。 */
export function statTable(model, top = 5) {
  const { rows, ids, edges, longest } = model;
  const all = ids.map((i) => rows.get(i));
  const out = [];
  out.push(`omni: 构建统计  模块 ${ids.length} 个、依赖边 ${edges} 条、最长链 ${longest.length} 层`);
  if (longest.length > 0) {
    out.push(`  最长链  ${longest.map((i) => rows.get(i).short).join(' -> ')}`);
  }
  const byIn = [...all].sort((a, b) => b.in - a.in).filter((r) => r.in > 0).slice(0, top);
  if (byIn.length > 0) {
    out.push('  被依赖最多');
    for (const r of byIn) out.push(`    ${String(r.in).padStart(4)} 次  ${r.short}`);
  }
  const byOut = [...all].sort((a, b) => b.out.length - a.out.length)
    .filter((r) => r.out.length > 0).slice(0, top);
  if (byOut.length > 0) {
    out.push('  依赖别人最多');
    for (const r of byOut) out.push(`    ${String(r.out.length).padStart(4)} 个  ${r.short}`);
  }
  const byBytes = [...all].sort((a, b) => b.bytes - a.bytes).filter((r) => r.bytes > 0).slice(0, top);
  if (byBytes.length > 0) {
    out.push('  产出最大（生成的 C）');
    for (const r of byBytes) {
      out.push(`    ${String(r.bytes).padStart(8)} 字节  ${String(r.lines).padStart(6)} 行`
        + `  ${String(r.funcs).padStart(4)} fn  ${r.short}（被依赖 ${r.in} 次）`);
    }
  }
  /* 字节那一栏拿不到时（`.omni` 那条腿上 cgen 只报一格 `(unknown)`）退到**函数个数** ——
   * 那是摇树之后真正留下的量，比「没有数」有用，也比假装有字节数诚实。 */
  const byFn = [...all].sort((a, b) => b.funcs - a.funcs).filter((r) => r.funcs > 0).slice(0, top);
  if (byBytes.length === 0 && byFn.length > 0) {
    out.push('  函数最多（摇树之后留下的；这条腿上 cgen 还没按模块归属字节数）');
    for (const r of byFn) {
      out.push(`    ${String(r.funcs).padStart(4)} fn  ${r.short}（被依赖 ${r.in} 次）`);
    }
  }
  return `${out.join('\n')}\n`;
}

/** graphviz：`dot -Tsvg x.dot > x.svg`。节点标签带产出，于是图上直接看得见谁大。 */
export function statDot(model) {
  const { rows, ids } = model;
  const out = ['digraph deps {', '  rankdir=LR;', '  node [shape=box, fontname="monospace"];'];
  for (const id of ids) {
    const r = rows.get(id);
    const label = r.bytes > 0 ? `${r.short}\\n${r.bytes}B / ${r.funcs}fn` : r.short;
    out.push(`  n${id} [label="${label}"];`);
  }
  for (const id of ids) for (const k of rows.get(id).out) out.push(`  n${id} -> n${k};`);
  out.push('}');
  return `${out.join('\n')}\n`;
}

/** 给别的工具吃的那一份。次序按 id，于是同一份输入两次出来逐字节相同。 */
export function statJson(model) {
  const { rows, ids, edges, longest } = model;
  const mods = ids.map((i) => {
    const r = rows.get(i);
    return {
      id: r.id, path: r.path, bytes: r.bytes, lines: r.lines, funcs: r.funcs,
      imports: [...r.out].sort((a, b) => a - b), importedBy: r.in,
    };
  });
  return `${JSON.stringify({
    modules: mods.length, edges, longest: longest.map((i) => rows.get(i).path), mods,
  }, null, 2)}\n`;
}
