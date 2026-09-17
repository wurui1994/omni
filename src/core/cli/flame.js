/**
 * 折叠栈 -> 火焰图 SVG（第一百四十七片）。**纯字符串计算**：不碰宿主、不读盘 ——
 * 于是判据可以直接喂它一段折叠栈、比对出来的 SVG，不必先跑一趟程序。
 *
 * 输入格式是 Brendan Gregg 那一套（`a;b;c 计数`，一行一条栈，底在前）：那是这一带的
 * 通用格式，`flamegraph.pl`、speedscope、gprof2dot 都吃它。我们自己出一份 SVG 的理由
 * 只有一个：**不想让「看一眼火焰图」依赖装 perl 脚本**。要更花的图就把折叠栈喂给它们。
 *
 * 形状与那份 perl 脚本一致（同名的兄弟合并、按名字排、宽度按计数）——**故意一致**：
 * 于是两边的图能对着看，谁错了看得出来。差别只有配色与不带交互脚本这两处。
 */

/* 一个格子的高度与字号：与 flamegraph.pl 的默认值一样（16 / 12）。 */
const ROW_H = 16;
const FONT = 12;
const PAD_TOP = 32;      /* 标题那一行 */
const PAD_BOT = 8;
const WIDTH = 1200;

/** XML 转义：名字里可能有 `<`（C++ 的模板）与 `&`。 */
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 名字 -> 颜色。**确定性的**：同一个名字每次都是同一格颜色，于是两张图能对着看
 * （随机配色的火焰图没法比较，那是 flamegraph.pl 的一个已知麻烦）。
 * 暖色系（红 -> 黄），与那份脚本的默认 `hot` 调色板同一个路子。
 */
function colorOf(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  const r = 205 + (h % 50);
  const g = 30 + ((h >>> 8) % 190);
  const b = 30 + ((h >>> 16) % 60);
  return `rgb(${r},${g},${b})`;
}

/** 折叠栈 -> 一棵树。节点：`{ name, value, children: Map }`。 */
function buildTree(text) {
  const root = { name: 'all', value: 0, children: new Map() };
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const sp = line.lastIndexOf(' ');
    if (sp < 0) continue;
    const n = Number(line.slice(sp + 1));
    if (!Number.isFinite(n) || n <= 0) continue;
    const frames = line.slice(0, sp).split(';').filter((f) => f !== '');
    root.value += n;
    let cur = root;
    for (const f of frames) {
      let kid = cur.children.get(f);
      if (kid === undefined) {
        kid = { name: f, value: 0, children: new Map() };
        cur.children.set(f, kid);
      }
      kid.value += n;
      cur = kid;
    }
  }
  return root;
}

/** 树的高度（层数）—— SVG 要多高由它定。 */
function depthOf(node) {
  let d = 0;
  for (const kid of node.children.values()) {
    const k = depthOf(kid);
    if (k > d) d = k;
  }
  return d + 1;
}

/**
 * 一棵树摊成一张 SVG。
 *
 * `total` 是根的计数，宽度按它折算；`minW` 以下的格子**连矩形都不画**（一张几万条栈的
 * 图里那些格子只有零点几个像素宽 —— 画出来只是让文件大十倍）。
 */
function rects(node, depth, x0, unit, out, total, rows) {
  const w = node.value * unit;
  if (w < 0.1) return;
  const y = PAD_TOP + (rows - 1 - depth) * ROW_H;
  const pct = total > 0 ? (100 * node.value / total).toFixed(2) : '0.00';
  const label = `${node.name} (${node.value}，${pct}%)`;
  out.push(`<g><title>${esc(label)}</title>`
    + `<rect x="${x0.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${ROW_H - 1}"`
    + ` fill="${colorOf(node.name)}" rx="1"/>`);
  /* 字只在放得下的时候写（一个字约 0.6 个字号宽）。放不下就截，截了加省略号 ——
   * 悬停那一格 `<title>` 里始终是全名，所以截断不丢信息。 */
  const room = Math.floor((w - 4) / (FONT * 0.6));
  if (room >= 3) {
    const txt = node.name.length <= room ? node.name : `${node.name.slice(0, room - 2)}..`;
    out.push(`<text x="${(x0 + 2).toFixed(1)}" y="${y + ROW_H - 4}"`
      + ` font-family="monospace" font-size="${FONT}" fill="#000">${esc(txt)}</text>`);
  }
  out.push('</g>');
  /* 兄弟按名字排：**输出要确定**（同一份折叠栈两次出来逐字节相同），不然判据没法比。 */
  const kids = [...node.children.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  let x = x0;
  for (const kid of kids) {
    rects(kid, depth + 1, x, unit, out, total, rows);
    x += kid.value * unit;
  }
}

/**
 * 折叠栈文本 -> SVG 文本。`title` 印在顶上那一行（一般是「谁的 profile、多少帧」）。
 * 空输入回一张只有标题的图（而不是抛错）：那种场合是「程序太短，一帧都没采到」，
 * 图空着正是答案。
 */
export function foldedToSvg(text, title) {
  const root = buildTree(text);
  const rows = depthOf(root);
  const height = PAD_TOP + rows * ROW_H + PAD_BOT;
  const unit = root.value > 0 ? WIDTH / root.value : 0;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}"`
    + ` viewBox="0 0 ${WIDTH} ${height}">`);
  out.push(`<rect width="${WIDTH}" height="${height}" fill="#fff"/>`);
  out.push(`<text x="${WIDTH / 2}" y="20" text-anchor="middle" font-family="monospace"`
    + ` font-size="14" fill="#000">${esc(title)}</text>`);
  rects(root, 0, 0, unit, out, root.value, rows);
  out.push('</svg>');
  return `${out.join('\n')}\n`;
}

/**
 * **node 自己那台 V8 采样器的产物 -> 折叠栈**（第一百四十八片第三格）。
 *
 * `node --cpu-prof` 落一份 `.cpuprofile`（Chrome DevTools 那个格式）：
 *   nodes[]      每格一帧：`id` · `callFrame{functionName,url,lineNumber}` · `children[]`
 *   samples[]    每次采样命中的那格 `id`
 *   timeDeltas[] 与 samples 一一对应，**微秒**
 * 折叠栈（`a;b;c 计数`）是 C 腿那边已经在用的交换格式，所以这一格只做**格式转换**，
 * 不新造一种账：转完之后表怎么印、图怎么画，两条腿走同一段代码。
 *
 * 权重用 `timeDeltas`（微秒）而不是"采样次数"：node 的采样间隔不保证均匀（默认 1000µs，
 * 但 GC / 系统调用会拖长），按次数数会把长间隔那一帧数轻。C 腿那边的权重也是时间。
 *
 * 名字：`functionName` 空的那几格是匿名函数（V8 里就是空串），落成 `(匿名)`；
 * `(program)` / `(idle)` / `(garbage collector)` 是 V8 自己那几格，**照留** ——
 * 它们是真的在花时间，藏起来等于给自己一份好看的假账。
 */
export function cpuProfileToFolded(jsonText) {
  const p = JSON.parse(jsonText);
  const nodes = p.nodes ?? [];
  const byId = new Map();
  const parent = new Map();
  for (const n of nodes) byId.set(n.id, n);
  for (const n of nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const nameOf = (id) => {
    const n = byId.get(id);
    if (n === undefined) return '(未知)';
    const f = n.callFrame ?? {};
    return (f.functionName === undefined || f.functionName === '') ? '(匿名)' : f.functionName;
  };
  /* 一格 id 的整条栈（根在前）。同一格会被问很多次，记下来 —— 采样数很容易上万。 */
  const memo = new Map();
  const stackOf = (id) => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    const up = parent.get(id);
    const s = up === undefined ? nameOf(id) : `${stackOf(up)};${nameOf(id)}`;
    memo.set(id, s);
    return s;
  };
  const samples = p.samples ?? [];
  const deltas = p.timeDeltas ?? [];
  const acc = new Map();
  for (let i = 0; i < samples.length; i++) {
    /* 负的 delta 出现过（时钟回拨）：按 0 算，不让它把某一格减成负数。 */
    const w = Math.max(0, Math.round(deltas[i] ?? 0));
    if (w === 0) continue;
    const k = stackOf(samples[i]);
    acc.set(k, (acc.get(k) ?? 0) + w);
  }
  /* 落盘的次序按权重从大到小 —— 两次同样的输入出来的文本要逐字节相同（可 diff）。 */
  const rows = [...acc.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
  return rows.map(([k, v]) => `${k} ${v}`).join('\n') + (rows.length > 0 ? '\n' : '');
}

/**
 * 折叠栈 -> **按自用时间排的那张表**（与 C 腿印出来的读法一致：% · 权重 · 名字）。
 *
 * 「自用」= 这一格自己在栈顶的那些权重之和（折叠栈的每一行本来就是一条完整的栈，
 * 行尾那一格就是栈顶）—— 所以这张表不用再算一遍父子关系。
 */
export function foldedTable(text, title, top = 20) {
  const self = new Map();
  let total = 0;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const sp = line.lastIndexOf(' ');
    if (sp <= 0) continue;
    const w = Number(line.slice(sp + 1)) || 0;
    const frames = line.slice(0, sp).split(';');
    const leaf = frames[frames.length - 1];
    self.set(leaf, (self.get(leaf) ?? 0) + w);
    total += w;
  }
  const rows = [...self.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
  const out = [`\n${title}：按自用时间排前 ${top} 行`];
  out.push('        ms      占比  函数');
  for (const [name, w] of rows.slice(0, top)) {
    const ms = (w / 1000).toFixed(3);
    const pct = total > 0 ? ((w / total) * 100).toFixed(2) : '0.00';
    out.push(`  ${ms.padStart(10)}  ${`${pct}%`.padStart(7)}  ${name}`);
  }
  if (rows.length > top) out.push(`  …还有 ${rows.length - top} 格`);
  return `${out.join('\n')}\n`;
}
