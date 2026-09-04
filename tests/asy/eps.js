#!/usr/bin/env node
// Omni — asymptote 的**第十六条测试轴**：画出来的东西与真 asy 一样吗（ADR-0014 第八十刀）
//
// 前十五条轴管的是"读得进"（tests/glr）与"跑得对"（tests/asy/run.js 的五方一致）。
// 这一条管的是**主线的验收**：examples 里的每一个例子，我们出的 EPS 与
// `asy -noV -f eps` 出的那份画的是同一张图。
//
// 参考（oracle）落在 `.omni-cache/epsref/<名>.eps`，**一次生成、之后只读** ——
// 它只由例子本身决定。从前这一份放在 /tmp 里，`/tmp` 被系统清掉之后 192 份全没了，
// 所以现在放在仓库的缓存目录里（.gitignore 已经挡了 /.omni-cache/）。
//
// 判据不是逐字节：两边的注释头、字体前言、日期都不同。比的是**画的东西** ——
// 去掉注释与空白、切成"数 + 运算符"的流，运算符逐个相等、数按 1e-3 比。
// BoundingBox 那两行例外：它是画布的尺寸，参与比较。
//
// 用法：
//   node tests/asy/eps.js <examples 目录> [名字…]
//   OMNI_EPS_WHY=1   顺带把"没出图"的那些按**第一条错**归类排一遍（改哪儿最值钱看这个）
//   OMNI_EPS_GEN=1   缺参考的那些现场用真 asy 补一份（很慢，量过 5 分多钟，平时别开）
//   OMNI_EPS_FRESH=1 不认结果缓存，全部重跑
//
// **可续跑**：每个例子的结论逐个落在 `.omni-cache/epsres/<名>.json` 里，键是
// 「编译器的印记 + 这个例子的改动时间/字节数」。被 Ctrl-C 打断不丢已经跑完的那些，
// 下一趟只跑"没跑过的"与"编译器变了之后没重跑的"。一趟全量要好几分钟，而这一轴
// 会被反复问，所以这一格是必须的。
import { readFileSync, existsSync, readdirSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const REF = join(ROOT, '.omni-cache', 'epsref');
const RES = join(ROOT, '.omni-cache', 'epsres');
const WORK = join(ROOT, '.omni-cache', 'epsrun');
const ASY = '/opt/homebrew/bin/asy';
const ASYBASE = '/opt/homebrew/share/asymptote';
const TOL = 1e-3;
// 一个例子最多跑多久（毫秒）。默认 3s —— 全量 194 个，卡住几个整轴就没法反复问了。
// 超时的归成"慢"排在最后，单独用 `OMNI_EPS_T=60000 node tests/asy/eps.js <目录> <名字…>` 追。
const LIMIT = Number(process.env.OMNI_EPS_T === undefined ? 3000 : process.env.OMNI_EPS_T);

// **摇骰子的那几个，永远比不出来**：真 asy 的随机数（random.cc:10）用
// `std::random_device` 播种 `std::mt19937_64`，连它自己两趟都不一样 —— 量过：
// 同一份 polardatagraph.asy 连跑两趟，%%BoundingBox 就从 259 345 352 446 变成
// 256 345 355 446。这六个不是我们做错了，是这条对照本身不成立，所以不计分。
// 判据是量出来的（每个都连跑两趟真 asy 对比），不是看源码猜的。
const DICE = new Set([
  'delu', 'Gouraudcontour', 'imagehistogram',
  'pathintersectsurface', 'polardatagraph', 'randompath3', 'floatingdisk',
]);

const exDir = process.argv[2];
if (exDir === undefined) {
  console.error('用法：node tests/asy/eps.js <examples 目录> [名字…]');
  process.exit(2);
}
// 模块搜索路径：例子引的是真的 base/*.asy（与 sweep.js 同一条规矩），**再加上 examples
// 目录本身**。后半句不是给自己开后门，是把 oracle 那一侧的路径原样照过来 ——
// 量过（`asy -noV -v -v` 印的那一行）：
//   Loading lowupint from /opt/homebrew/.../share/doc/asymptote/examples/lowupint.asy
// 也就是真 asy 的默认搜索路径里**本来就有它自己装的 examples 目录**，所以
// lowint / upint / spring0 / spring2 那几份 `import lowupint;` 在 oracle 那边是找得到的。
// 我们这一层的路径只到 base，于是同一句就报"找不到" —— 差的是路径，不是实现。
// 顺带量清了另一件事：asy **不**把主文件所在的目录加进搜索路径（`cd /tmp/msub &&
// asy sub/user.asy` 里的 `import mm;` 找不到 sub/mm.asy，绝对路径也一样），
// 所以 cli.js 那条"按 CWD 找"的规矩是对的，不要去改它。
// **这一轴要用 oracle 自己那份 base，不是参考源码树里的那份。** 量出来的：
// `/opt/homebrew/share/asymptote` 与 `/Users/…/reference/asymptote/base` 有 5 个文件不一样
// （graph3 / graph_splinetype / plain_shipout / slide / three）—— 装着的 asy 比那份源码树新。
// 参考只能读、不能改，而 `.omni-cache/epsref` 里的图是 `asy -noV` 出的，吃的是**装着的**那份。
// 拿源码树那份跑我们这边，等于两侧库版本不同，比出来的差不是我们的：
//   spline.asy 的 `Hermite(monotonic)` —— 源码树 `d[n-1]=(…-h[n-2]*del[n-2])/…`，
//   装着的那份是 `del[n-3]`（MATLAB pchip 的正形），最后一段控制点于是
//   143.375779（oracle）对 156.540136（我们跑源码树）。换成同一份库，这一行就对上了。
// 这里只改这一轴（它是唯一与 oracle 逐字节对照的）；sweep/run 那两轴问的是"库能不能编过"，
// 两份都该编得过，先不动。
const base = existsSync(ASYBASE) ? ASYBASE : join(exDir, '..', 'base');
const env = {
  ...process.env,
  OMNI_ASY_MODS: '1',
  ASYMPTOTE_DIR: `${process.env.ASYMPTOTE_DIR === undefined || process.env.ASYMPTOTE_DIR === ''
    ? base : process.env.ASYMPTOTE_DIR}:${exDir}`,
};

/** 一串字符 -> 16 位十六进制（够当缓存键；这一格不做密码学用途） */
function h16(s) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    a = ((a ^ s.charCodeAt(i)) * 16777619) >>> 0;
    b = ((b + s.charCodeAt(i) * (i + 1)) * 2654435761) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

/**
 * 编译器自己那一份的印记：src/core 与 src/lib 底下每个文件的「名字 + 改动时间 + 字节数」。
 * 结果缓存的键里带它 —— 改了前端或后端，这一轴的结论全部作废。
 */
let stampMemo = '';
function srcStamp() {
  if (stampMemo !== '') return stampMemo;
  const parts = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = statSync(p);
        parts.push(`${p}:${st.mtimeMs}:${st.size}`);
      }
    }
  };
  walk(join(ROOT, 'src', 'core'));
  walk(join(ROOT, 'src', 'lib'));
  stampMemo = h16(parts.join('|'));
  return stampMemo;
}

/** 一份 EPS -> "数 + 运算符"的流。第三格只用来打诊断（原样那一串）。 */
function toks(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const ln = raw.trim();
    if (ln === '') continue;
    if (ln.startsWith('%%BoundingBox') || ln.startsWith('%%HiResBoundingBox')) {
      const ws = ln.split(/\s+/);
      for (const w of ws.slice(1)) out.push(['n', Number(w), `${ws[0]}${w}`]);
      continue;
    }
    if (ln.startsWith('%')) continue;      // 别的注释都不比（Creator / 日期 / 前言标记）
    for (const w of ln.split(/\s+/)) {
      if (w === '') continue;
      if (/^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$/.test(w)) out.push(['n', Number(w), w]);
      else out.push(['o', w, w]);
    }
  }
  return out;
}

function cmp(a, b) {
  const n = Math.min(a.length, b.length);
  let bad = 0;
  let first = null;
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    let same;
    if (x[0] !== y[0]) same = false;
    else if (x[0] === 'n') same = Math.abs(x[1] - y[1]) <= TOL * Math.max(1, Math.abs(x[1]));
    else same = x[1] === y[1];
    if (!same) {
      bad++;
      if (first === null) first = `#${i} 参考 ${x[2]} vs 我们 ${y[2]}`;
    }
  }
  return { bad: bad + Math.abs(a.length - b.length), len: [a.length, b.length], first };
}

/**
 * oracle 那一份。已经有就直接用 —— 它只由例子决定，跑一次就够。
 *
 * **默认不生成**（`OMNI_EPS_GEN=1` 才生成）：生成那一趟要跑 192 次真 asy，量过 5 分多钟，
 * 而这一轴平时问的是"我们画得对不对"，参考早就躺在 `.omni-cache/epsref` 里了。
 * 回 null 表示这一份没有参考（没生成过，或者真 asy 自己也出不了图 —— NURBS/PRC/三维
 * 那一族要外部工具），那种不计分。
 */
function oracle(n, p) {
  const out = join(REF, `${n}.eps`);
  if (existsSync(out) && statSync(out).size > 0) return out;
  if (process.env.OMNI_EPS_GEN !== '1' || !existsSync(ASY)) return null;
  mkdirSync(WORK, { recursive: true });
  const r = spawnSync(ASY, ['-noV', '-f', 'eps', '-o', n, p],
    { cwd: WORK, encoding: 'utf8', timeout: 60000 });
  const made = join(WORK, `${n}.eps`);
  if (r.status !== 0 || !existsSync(made) || statSync(made).size === 0) return null;
  renameSync(made, out);
  return out;
}

/** 我们那一份：`omni run <例子>`，图在 stdout 上。 */
function mine(p) {
  const r = spawnSync('node', [join(ROOT, 'src', 'core', 'cli.js'), 'run', p],
    { cwd: ROOT, env, encoding: 'utf8', timeout: LIMIT, maxBuffer: 1 << 28 });
  // 超时被打死的那种：`signal` 是 SIGTERM。这一格要与"跑完了但没出图"分开 ——
  // 一趟全量 194 个例子，只要有几个卡住整轴就没法反复问，所以默认一个例子最多 LIMIT 毫秒，
  // 超时的归成"慢"、排在最后单独跑（`OMNI_EPS_T=60000 node tests/asy/eps.js <目录> <名字…>`）。
  const slow = r.signal === 'SIGTERM' || (r.error !== undefined && r.error !== null);
  // **孙子要一起收**：`omni run` 自己会再 spawn 一个 node 去跑那份 ESM 启动器
  // （cli.js 的 `spawn('node', [mainPath], 'i')`），而 spawnSync 的 timeout 只 SIGTERM
  // 直接的那个孩子 —— 不收的话每个超时的例子都留一个满载的 node 在后台啃 CPU，
  // 后面的例子于是越跑越慢（这一轴本身就变成了噪声源）。
  if (slow) {
    spawnSync('pkill', ['-f', `${join(ROOT, '.omni-cache', 'asy-mods')}/main-`],
      { encoding: 'utf8' });
  }
  return { out: onlyEps(r.stdout ?? ''), err: r.stderr ?? '', status: r.status, slow };
}

/**
 * 例子**自己**印的东西要从图里剥掉。真 asy 是 `-f eps -o <名>`：图写进文件，程序自己
 * `write(...)` 印的那些走 stdout，两者天然分开；我们这一层图也从 stdout 出去，于是
 * 例子印的行落在图**前面**。量出来的：xstitch 的 `histogram:`、lmfit1 的 `P_0 = …`
 * 就是这么变成"首处结构差"的。规矩：第一行 `%!PS-Adobe` 之前的全扔掉，之后一个字不动
 * （图里再有脏东西照旧算差 —— 这一格只补"两边的 stdout 不是同一个口子"这一处不对等）。
 */
function onlyEps(s) {
  const i = s.indexOf('%!PS-Adobe');
  return i <= 0 ? s : s.slice(i);
}

/**
 * 「为什么没出图」归一化成一类。取的是 `abort:` 那一行 —— abort 之后我们还会再抛一条
 * `array index out of range: 0`（abort 那条路上有一格读空数组），按第一行统计会被那条
 * 噪声全遮住：量过一次，107 份"越界"里绝大多数其实是各式各样的 `abort: … 还没做`。
 */
function why(r) {
  // `abort:` 那一行落在 **stdout** 上（asy 的 abort 走的是 write 那条路），而运行期那条
  // `array index out of range` 在 stderr 上 —— 两边都要看。
  const ls = `${r.out}\n${r.err}`.split('\n').filter((l) => l.trim() !== '');
  const ab = ls.filter((l) => l.trim().startsWith('abort:'));
  // **warning 不算错因**（这一刀）：`warning: using possibly incompatible version of plain.asy`
  // 是每个例子都印的一句，它排在 stderr 第一行，于是把真正的错遮住了 —— 量出来的样子是
  // Gouraud 与 sinxlex 记成"没出图 —— warning …"，而真错是 `RangeError: Maximum call
  // stack size exceeded`（guide/path 塌成一份那一格，见 ADR-0014）。一条 warning 都不剩时
  // 才退回去用它（那说明确实只有 warning）。
  const raw = r.err.split('\n').filter((l) => l.trim() !== '');
  const hard = raw.filter((l) => !l.trim().startsWith('warning:'));
  const es = hard.length > 0 ? hard : raw;
  const one = ab.length > 0 ? ab[0].trim()
    : (es.length === 0 ? `没有错误输出（退出 ${r.status}）` : es[0].trim());
  return one
    .replace(/\/[^\s:]+\.asy/g, '<文件>')
    .replace(/^[^:]*:\d+:\d+:\s*/, '')
    .replace(/'[^']*'/g, "'…'")
    .replace(/\d+/g, 'N')
    .slice(0, 150);
}

mkdirSync(REF, { recursive: true });
mkdirSync(RES, { recursive: true });
const names = process.argv.length > 3 ? process.argv.slice(3)
  : readdirSync(exDir).filter((f) => f.endsWith('.asy')).map((f) => f.slice(0, -4)).sort();

// **全量重跑先把产物缓存清掉**（ADR-0014 那一格"记录名依赖这一趟谁先被降"）。
// 为什么必须：库里两个同名的 struct（contour.asy 与 geometry.asy 都有 `segment`）现在
// 谁先被降谁拿裸名字，而名字会被写进接口索引与共用的 weak 那一份 —— 于是**上一个例子留下的
// 产物会让下一个例子编不过**。量出来的样子：先跑 Pythagoras（geometry）再跑 impact
// （contour），后者报 `类 segment 没有字段 'A'`；一趟全量里这么冤枉掉了 7 个例子
// （"结构不同"变"没出图"）。根因还没改（试过两种改法都退回来了，见 ADR-0014），
// 所以这一轴自己先把这个噪声源掐掉：报出来的数只能是干净缓存上跑出来的。
// 只在"全量 + 不认缓存"这一档清 —— 单独追几个例子时不清（那时要的是快）。
if (process.env.OMNI_EPS_FRESH === '1' && process.argv.length <= 3) {
  rmSync(join(ROOT, '.omni-cache', 'asy-mods'), { recursive: true, force: true });
}

/** 这个例子上一趟的结论还作数吗（编译器没变、例子没变） */
function cached(n, p) {
  if (process.env.OMNI_EPS_FRESH === '1') return null;
  const q = join(RES, `${n}.json`);
  if (!existsSync(q)) return null;
  const st = statSync(p);
  const want = `${srcStamp()}|${st.mtimeMs}|${st.size}`;
  try {
    const o = JSON.parse(readFileSync(q, 'utf8'));
    return o.stamp === want ? o : null;
  } catch { return null; }
}

function remember(n, p, o) {
  const st = statSync(p);
  writeFileSync(join(RES, `${n}.json`),
    `${JSON.stringify({ ...o, stamp: `${srcStamp()}|${st.mtimeMs}|${st.size}` })}\n`);
}

let same = 0;
let numdiff = 0;
let structdiff = 0;
let nogo = 0;
let noref = 0;
let dice = 0;
let fresh = 0;
let slow = 0;
const bad = [];
const slows = [];
const hist = new Map();
const who = new Map();
for (const n of names) {
  const p = join(exDir, `${n}.asy`);
  if (!existsSync(p)) { console.log(`  ?    ${n}：没有这个例子`); continue; }
  if (existsSync(p) && DICE.has(n)) { dice++; continue; } // 真 asy 自己都不重复，不计分
  const rp = oracle(n, p);
  if (rp === null) { noref++; continue; }            // 没有参考，不计分
  let o = cached(n, p);
  if (o === null) {
    fresh++;
    const r = mine(p);
    if (r.slow) o = { kind: 'slow', note: `超过 ${LIMIT}ms` };
    else if (r.out.indexOf('%%EOF') < 0) o = { kind: 'nogo', note: why(r) };
    else {
      const c = cmp(toks(readFileSync(rp, 'utf8')), toks(r.out));
      if (c.bad === 0) o = { kind: 'same', note: '' };
      else if (c.len[0] !== c.len[1]) {
        o = { kind: 'struct', note: `长度 ${c.len[0]} vs ${c.len[1]}，首处 ${c.first}` };
      } else o = { kind: 'num', note: `${c.bad} 处数值不同，首处 ${c.first}` };
    }
    remember(n, p, o);
  }
  if (o.kind === 'same') { same++; continue; }
  if (o.kind === 'slow') { slow++; slows.push(n); continue; }
  if (o.kind === 'nogo') {
    nogo++;
    hist.set(o.note, (hist.get(o.note) ?? 0) + 1);
    if (!who.has(o.note)) who.set(o.note, []);
    if (who.get(o.note).length < 5) who.get(o.note).push(n);
    bad.push(`${n}: 没出图 —— ${o.note}`);
    continue;
  }
  if (o.kind === 'struct') { structdiff++; bad.push(`${n}: 结构不同（${o.note}）`); continue; }
  numdiff++;
  bad.push(`${n}: ${o.note}`);
}
rmSync(WORK, { recursive: true, force: true });
console.log(`EPS 那一轴：一样 ${same}、只有数值差 ${numdiff}、结构不同 ${structdiff}、`
  + `没出图 ${nogo}、超过 ${LIMIT}ms 的 ${slow}`
  + `（没有参考、不计分的 ${noref} 份；摇骰子、比不出来的 ${dice} 份；`
  + `这一趟真跑了 ${fresh} 个，其余用的是缓存）`);
for (const b of bad) console.log(`  ${b}`);
if (slows.length > 0) {
  console.log(`--- 超时排在最后的 ${slows.length} 个（单独追：`
    + `OMNI_EPS_T=60000 node tests/asy/eps.js <目录> ${slows.slice(0, 3).join(' ')} …）：`);
  console.log(`  ${slows.join(' ')}`);
}
if (process.env.OMNI_EPS_WHY === '1') {
  console.log('--- 没出图的按第一条错归类：');
  for (const [k, c] of [...hist.entries()].sort((a, b2) => b2[1] - a[1])) {
    console.log(`${String(c).padStart(4)}  ${k}\n        例：${who.get(k).join(' ')}`);
  }
}
process.exit(numdiff + structdiff + nogo + slow === 0 ? 0 : 1);
