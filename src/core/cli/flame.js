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
