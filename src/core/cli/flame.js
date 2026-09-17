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
 * 折叠栈解析成一行行 `{frames, w}` + 总权重。**只在这一处解析**——底下那几张表
 * （函数 · 热路径 · 调用树 · 调用边）都从它出发，于是"怎么读一行折叠栈"只有一份定义。
 */
export function foldedRows(text) {
  const rows = [];
  let total = 0;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const sp = line.lastIndexOf(' ');
    if (sp <= 0) continue;
    const w = Number(line.slice(sp + 1)) || 0;
    if (w <= 0) continue;
    rows.push({ frames: line.slice(0, sp).split(';'), w });
    total += w;
  }
  return { rows, total };
}

const ms = (w) => (w / 1000).toFixed(3);
const pct = (w, total) => (total > 0 ? ((w / total) * 100).toFixed(2) : '0.00');
/** 表头上的前缀：`title` 给了就带上，空的时候表自己的名字已经够了（`profViews` 那一路）。 */
const cap = (title) => (title === undefined || title === '' ? '' : `${title} · `);
/**
 * **折叠栈里那个权重是什么单位**：折叠栈这个格式自己**不声明单位**（`a;b;c 数`），
 * 而两条腿落下来的不是同一种东西 ——
 *   `us`     微秒（node 的 V8 采样器按 timeDeltas 落，js 腿发射期插桩也是微秒）
 *   `frames` 采样帧数（`omni_prof.c` 落的是"命中了几次"）
 * 混着读就会差三个数量级：量到过 143 帧被印成 `0.143 ms`（997Hz 上其实是 ~143ms）。
 * 所以单位由**调用方**说，这一层只按它换算与起表头。百分比与单位无关，两种都一样。
 */
const unitOf = (unit) => (unit === 'frames'
  ? { head: '      帧数', of: (v) => `${v}` }
  : { head: '        ms', of: ms });

/**
 * **一行摘要**：这一趟总共量到多少、栈有多深、有没有递归。
 *
 * 为什么要有它：底下几张表都是**相对**的（百分比），而"这些百分比是从多少绝对时间里
 * 分出来的"决定了它们值不值得信 —— 总共 3ms 的账上"某格占 40%"没有意义。
 * 递归那一格单列：同一帧在一条栈里出现多次时，「含子」那一栏会重复计（见 `foldedTable`），
 * 这句话是提醒读表的人那一栏该怎么读。
 */
export function foldedSummary(text, unit) {
  const { rows, total } = foldedRows(text);
  const u = unitOf(unit);
  let deep = 0;
  let sum = 0;
  let rec = 0;
  for (const r of rows) {
    if (r.frames.length > deep) deep = r.frames.length;
    sum += r.frames.length;
    if (new Set(r.frames).size !== r.frames.length) rec += 1;
  }
  const avg = rows.length > 0 ? (sum / rows.length).toFixed(1) : '0.0';
  return `  合计 ${u.of(total)} ${unit === 'frames' ? '帧' : 'ms'} / ${rows.length} 条栈`
    + ` · 栈深 最深 ${deep} · 平均 ${avg}`
    + `${rec > 0 ? ` · 递归栈 ${rec} 条（「含子」那一栏在递归上会重复计）` : ''}\n`;
}

/**
 * 折叠栈 -> **函数表**：自用 + 含子两栏（gprof 那两栏的读法）。
 *
 *   自用  这一格自己在**栈顶**的权重之和 —— 时间真花在它自己的指令上
 *   含子  这一格**出现在栈里任意一层**的权重之和 —— 它这一支总共花了多少
 * 两栏一起看才说得清"是它慢还是它叫的人慢"：只有自用那一栏时，一格纯转发的函数
 * （`$js_arith` 那种）看着无辜，而它引出去的时间全记在别人头上。
 *
 * 递归：同一条栈里同名帧只算**一次**（`new Set`）—— 不然 `fib` 那种自递归的含子
 * 会按栈深倍数膨胀，印出来是 300%。
 */
export function foldedTable(text, title, top = 20, unit) {
  const { rows, total } = foldedRows(text);
  const u = unitOf(unit);
  const self = new Map();
  const incl = new Map();
  for (const { frames, w } of rows) {
    const leaf = frames[frames.length - 1];
    self.set(leaf, (self.get(leaf) ?? 0) + w);
    for (const f of new Set(frames)) incl.set(f, (incl.get(f) ?? 0) + w);
  }
  const names = [...new Set([...self.keys(), ...incl.keys()])];
  names.sort((a, b) => ((self.get(b) ?? 0) - (self.get(a) ?? 0)) || (a < b ? -1 : 1));
  const out = [`\n${cap(title)}函数表（按自用排，前 ${top}）`];
  out.push(`  自用${u.head}    占比  含子${u.head}    占比  函数`);
  for (const n of names.slice(0, top)) {
    const s = self.get(n) ?? 0;
    const i = incl.get(n) ?? 0;
    out.push(`  ${u.of(s).padStart(10)}  ${`${pct(s, total)}%`.padStart(7)}`
      + `  ${u.of(i).padStart(10)}  ${`${pct(i, total)}%`.padStart(7)}  ${n}`);
  }
  if (names.length > top) out.push(`  …还有 ${names.length - top} 格`);
  return `${out.join('\n')}\n`;
}

/**
 * **热路径榜**（这一片要的那格）：按权重排的**整条栈**前 N 条。
 *
 * 与函数表是两个问题：函数表答"时间花在谁身上"，热路径答"**从哪儿走过来的**"。
 * 一格函数被十处调用时，函数表只能告诉你它热，热路径能指出热的是哪一处调用。
 * 这也正是聚合回溯（aggregated backtrace）本来的用途 —— 火焰图是它的画法之一，
 * 而在终端上一张排好序的表比图更好读、能 diff、能贴进提交信息里。
 *
 * 印法：`a;b;c` 那条链印成 `a > b > c`，深栈从中间省略（两头才是有信息的那两端）。
 */
export function foldedPaths(text, title, top = 10, unit, width = 96) {
  const { rows, total } = foldedRows(text);
  const u = unitOf(unit);
  const acc = new Map();
  for (const { frames, w } of rows) {
    const k = frames.join(';');
    acc.set(k, (acc.get(k) ?? 0) + w);
  }
  const ord = [...acc.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
  const out = [`\n${cap(title)}热路径前 ${top} 条（整条栈，根 > … > 栈顶）`];
  out.push(`  ${u.head}    占比  深度  路径`);
  for (const [k, w] of ord.slice(0, top)) {
    const fr = k.split(';');
    let path = fr.join(' > ');
    if (path.length > width) {
      /* 省中间那一段：两头（入口与栈顶）才是判断"这条路是什么"的两个端点。 */
      const head = fr.slice(0, 2).join(' > ');
      const tail = fr.slice(-3).join(' > ');
      path = `${head} > … > ${tail}`;
    }
    out.push(`  ${u.of(w).padStart(10)}  ${`${pct(w, total)}%`.padStart(6)}`
      + `  ${`${fr.length}`.padStart(4)}  ${path}`);
  }
  if (ord.length > top) out.push(`  …还有 ${ord.length - top} 条`);
  return `${out.join('\n')}\n`;
}

/**
 * **调用树**（left-heavy：每一层按权重从大到小）——聚合回溯的另一种读法。
 *
 * 热路径榜给的是"最热的几条完整栈"，树给的是"时间在每个分叉上怎么分的"：
 * 一格函数的时间被两条子路对半分时，热路径榜上它俩各占一半、看着都不显眼，
 * 树上却能一眼看到那个分叉。
 *
 * 两个止步条件（不然一棵深树印出来没人看）：`maxDepth` 层数上限、`minPct` 阈值 ——
 * 低于阈值的兄弟合成一行 `(其余 N 格 x%)`，**不悄悄丢**。
 */
export function foldedTree(text, title, maxDepth = 8, minPct = 1.0, unit) {
  const { rows, total } = foldedRows(text);
  const root = { w: 0, kids: new Map() };
  for (const { frames, w } of rows) {
    let cur = root;
    cur.w += w;
    for (const f of frames) {
      let k = cur.kids.get(f);
      if (k === undefined) { k = { w: 0, kids: new Map() }; cur.kids.set(f, k); }
      k.w += w;
      cur = k;
    }
  }
  const out = [`\n${cap(title)}调用树（每层按权重排，深度 ${maxDepth} 层、阈值 ${minPct}%）`];
  const u = unitOf(unit);
  const walk = (node, depth, pad) => {
    if (depth > maxDepth) return;
    const kids = [...node.kids.entries()].sort((a, b) => (b[1].w - a[1].w) || (a[0] < b[0] ? -1 : 1));
    let hidden = 0;
    let hiddenW = 0;
    for (const [name, k] of kids) {
      if (total > 0 && (k.w / total) * 100 < minPct) { hidden += 1; hiddenW += k.w; continue; }
      /* 自用 = 这一格的权重减掉所有子节点的（子节点是"它在栈里的下一层"）。 */
      let kidsW = 0;
      for (const [, kk] of k.kids) kidsW += kk.w;
      const selfPart = k.w - kidsW;
      out.push(`  ${`${pct(k.w, total)}%`.padStart(7)}  ${u.of(k.w).padStart(10)}`
        + `  ${`自用 ${pct(selfPart, total)}%`.padStart(12)}  ${pad}${name}`);
      walk(k, depth + 1, `${pad}  `);
    }
    if (hidden > 0) {
      out.push(`  ${`${pct(hiddenW, total)}%`.padStart(7)}  ${u.of(hiddenW).padStart(10)}`
        + `  ${''.padStart(12)}  ${pad}(其余 ${hidden} 格，都在阈值以下)`);
    }
  };
  walk(root, 1, '');
  return `${out.join('\n')}\n`;
}

/**
 * **两份 profile 的对照**（优化循环里最有用的那一张）：`基线 -> 新` 每格函数的自用变化。
 *
 * 为什么绝对值与占比两栏都要：两趟的总时间一般不一样（机器忙、输入不同、这一刀就是要让
 * 总时间变小），绝对差回答"省了多少"，占比差（**百分点**）回答"这一刀有没有把这格
 * 从热路径上挪走"。只看一栏都会得出错的结论 —— 总时间掉一半时每格的绝对值都在降，
 * 而占比会告诉你**谁**其实变得更热了。
 *
 * 排序按 |Δ占比| —— 那才是"形状变了没有"。新出现 / 消失的函数照样进表（基线或新那一栏是 0）。
 */
export function foldedDiff(aText, bText, title, top = 20, unit) {
  const u = unitOf(unit);
  const selfOf = (text) => {
    const { rows, total } = foldedRows(text);
    const self = new Map();
    for (const { frames, w } of rows) {
      const leaf = frames[frames.length - 1];
      self.set(leaf, (self.get(leaf) ?? 0) + w);
    }
    return { self, total };
  };
  const A = selfOf(aText);
  const B = selfOf(bText);
  const names = [...new Set([...A.self.keys(), ...B.self.keys()])];
  const row = (n) => {
    const a = A.self.get(n) ?? 0;
    const b = B.self.get(n) ?? 0;
    const pa = A.total > 0 ? (a / A.total) * 100 : 0;
    const pb = B.total > 0 ? (b / B.total) * 100 : 0;
    return { n, a, b, d: b - a, dp: pb - pa, pa, pb };
  };
  const rows = names.map(row).sort((x, y) => Math.abs(y.dp) - Math.abs(x.dp)
    || Math.abs(y.d) - Math.abs(x.d) || (x.n < y.n ? -1 : 1));
  const sign = (v, f) => `${v > 0 ? '+' : ''}${f(v)}`;
  const out = [`\n${cap(title)}对照（基线 -> 新，按 |Δ占比| 排前 ${top}）`];
  out.push(`  合计 ${u.of(A.total)} -> ${u.of(B.total)}`
    + `（${sign(B.total - A.total, u.of)}，${A.total > 0 ? sign(((B.total - A.total) / A.total) * 100, (v) => v.toFixed(1)) : '—'}%）`);
  out.push('     Δ自用     Δ占比      基线%       新%  函数');
  for (const r of rows.slice(0, top)) {
    out.push(`  ${sign(r.d, u.of).padStart(9)}  ${`${sign(r.dp, (v) => v.toFixed(2))}pp`.padStart(9)}`
      + `  ${`${r.pa.toFixed(2)}%`.padStart(8)}  ${`${r.pb.toFixed(2)}%`.padStart(8)}  ${r.n}`);
  }
  if (rows.length > top) out.push(`  …还有 ${rows.length - top} 格`);
  return `${out.join('\n')}\n`;
}

/**
 * **最热的调用边**（`调用者 > 被调者`）：一格热函数是被谁引热的。
 *
 * 与热路径榜互补：路径榜给整条链（信息全但每条权重被摊薄），边榜把同一条边在**所有**
 * 路径上的权重加起来 —— 「`$js_arith` 的 78% 是 `u_sumTo` 引来的」这种话只有它答得出。
 */
export function foldedEdges(text, title, top = 10, unit) {
  const { rows, total } = foldedRows(text);
  const u = unitOf(unit);
  const acc = new Map();
  for (const { frames, w } of rows) {
    /* **同一条栈里同一条边只算一次**：递归（`fib > fib` 在一条 21 层深的栈里出现 16 次）
     * 不去重的话那条边能量到 90.99% —— 比它所在的整条栈还大，是一句假话。
     * 与函数表「含子」那一栏同一条规矩。 */
    const seen = new Set();
    for (let i = 1; i < frames.length; i++) {
      const k = `${frames[i - 1]} > ${frames[i]}`;
      if (seen.has(k)) continue;
      seen.add(k);
      acc.set(k, (acc.get(k) ?? 0) + w);
    }
  }
  const ord = [...acc.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
  const out = [`\n${cap(title)}最热的调用边前 ${top}（谁把时间引过去的）`];
  out.push(`  ${u.head}    占比  调用者 > 被调者`);
  for (const [k, w] of ord.slice(0, top)) {
    out.push(`  ${u.of(w).padStart(10)}  ${`${pct(w, total)}%`.padStart(6)}  ${k}`);
  }
  if (ord.length > top) out.push(`  …还有 ${ord.length - top} 条`);
  return `${out.join('\n')}\n`;
}
