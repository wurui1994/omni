#!/usr/bin/env node
// tests/asy/triage.js —— examples 的**分类清单与计时**（ADR-0014 第十六条轴的前置工序）
//
// 为什么要单独一份：EPS 那一轴（`eps.js`）是逐个例子串行 spawn 的，一趟全量在这台机器上
// 好几分钟，而其中绝大部分时间花在**少数几个重例子**上。要把总时间压到 120s 以内，先得
// 知道钱花在哪儿 —— 所以这一份只做两件事：
//
//   1. `static`（默认）—— **不跑任何进程**，按源码里的特征给每个例子分类、估算复杂度与
//      超时概率。这一步是零成本的，可以在动手之前先看。
//   2. `time`  —— 并行量真 asy 与我们各自要多久，每个例子有硬上限。
//      并行是这一份存在的第二个理由：串行 220 个 × 平均 1.7s ≈ 6 分钟，而这台机器有
//      多个核 —— 同样的活并行开出去就是几十秒。
//
// 用法：
//   node tests/asy/triage.js static [目录]
//   node tests/asy/triage.js time asy   [目录]   # 量真 asy
//   node tests/asy/triage.js time mine  [目录]   # 量我们
//   OMNI_TRI_T=5000  一个例子的上限（毫秒，默认 5000）
//   OMNI_TRI_J=8     并行度（默认 CPU 数 - 2）
//
// 计时结果落在 `.omni-cache/tritime/<who>.json`，可续跑。

import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, rmSync, statSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const EXDIR = join(HERE, 'examples');
const TIMEDIR = join(ROOT, '.omni-cache', 'tritime');
const WORK = join(ROOT, '.omni-cache', 'triwork');
const ASY = '/opt/homebrew/bin/asy';
const ASYBASE = '/opt/homebrew/share/asymptote';

const LIMIT = Number(process.env.OMNI_TRI_T === undefined ? 5000 : process.env.OMNI_TRI_T);
/**
 * 并行度。**默认 4，不是「核数 - 2」** —— 这是量出来的：
 *
 * 这台机器 8 个逻辑核，但只有 4 个是性能核（`hw.perflevel0.logicalcpu` = 4），
 * 另外 4 个是能效核。开到 6 路时活会落到能效核上，单个例子的墙上时间被推高 2～3 倍：
 *
 *   例子              6 路并行    单跑
 *   BezierSaddle       >5049ms   1902ms
 *   SierpinskiGasket   >5046ms   4231ms
 *   gamma              >5042ms   2323ms
 *   label3zoom         >5023ms   3844ms
 *
 * 也就是说「一个例子 5s 以内」这条判据在 6 路下会**冤枉四个**本来合格的例子。
 * 判超时要按单例的真实成本判，所以并行度压到性能核数：吞吐少一点，结论是对的。
 */
const JOBS = Number(process.env.OMNI_TRI_J === undefined ? 4 : process.env.OMNI_TRI_J);

/* ---------------------------------------------------------------- 静态特征
 *
 * 这些判据是**看着源码定的、然后由 `time` 那一模式量出来的数去校准**，不是拍脑袋：
 * 每一条后面写的是"为什么它贵"。
 */

/** 一个整数字面量最大到多少（网格规模的粗代理）。只看**独立的**数，不看小数。 */
function maxInt(src) {
  let m = 0;
  for (const w of src.match(/(?<![\w.])\d+(?![\w.])/g) ?? []) {
    const v = Number(w);
    if (v > m && v <= 100000) m = v;      // 100000 以上多半是坐标/尺寸常量，不是循环上界
  }
  return m;
}

/** `for(...;i<N;...)` 里那些上界的**乘积**：嵌套循环的规模。找不到就回 0。 */
function loopWork(src) {
  const bounds = [];
  for (const m of src.matchAll(/for\s*\([^;]*;[^<>;]*[<>]=?\s*(\d+)/g)) bounds.push(Number(m[1]));
  if (bounds.length === 0) return 0;
  /* 不知道谁套谁，取"最大的两个相乘"当上界估计 —— 比求和保守、比全乘现实。 */
  bounds.sort((a, b) => b - a);
  return bounds.length === 1 ? bounds[0] : bounds[0] * bounds[1];
}

const FEATS = [
  // 三维那一族：surface 要铺网格、每块再切 Bezier 补片，是最贵的一档
  ['3d', /\b(?:import|access)\s+(?:three|graph3|solids|tube|obj|smoothcontour3|bsp)\b|\bsize3\s*\(/, 30],
  ['surface', /\bsurface\b/, 25],
  ['revolution', /\brevolution\b/, 20],
  // 等值线与位图：都是"在网格上逐点求值"
  ['contour', /\bcontour\b/, 18],
  ['image', /\bimage\s*\(/, 12],
  // 动画：一份例子里跑 N 帧，还要外部工具拼起来
  ['anim', /\bimport\s+animation\b|\bmovie\s*\(/, 40],
  // 幻灯与 TeX：每一页一次 latex，固定开销极大
  ['slide', /\bimport\s+(?:slide|beamer)\b/, 35],
  ['tex', /\busepackage\s*\(|\\documentclass|texpreamble\s*\(|\blatex\s*\(/, 15],
  // 外部工具（PRC/NURBS/渲染器）：真 asy 自己也未必出得了图
  ['extern', /\bimport\s+embed\b|\bsettings\.render\b|\bsettings\.prc\b|\bprc\s*\(/, 25],
  // 求解与拟合：迭代到收敛，次数不在源码里
  ['solve', /\bnewton\s*\(|\bfit\s*\(|\bsimplex\b|\blmfit\b/, 10],
];

function features(name, src) {
  const f = { name, bytes: src.length, lines: src.split('\n').length };
  let score = 0;
  for (const [k, re, w] of FEATS) {
    f[k] = re.test(src);
    if (f[k]) score += w;
  }
  f.maxInt = maxInt(src);
  f.loop = loopWork(src);
  /* 规模那一项取对数：网格从 10 涨到 100 是一档，从 100 到 1000 又是一档。 */
  if (f.loop > 0) score += Math.min(30, Math.round(Math.log10(f.loop) * 8));
  if (f.maxInt >= 1000) score += 6;
  score += Math.min(10, Math.round(f.lines / 20));
  f.score = score;
  /* 四档。界是按"这一档里最贵的那个大概要多久"定的，`time` 那一模式会把真数打出来对。 */
  f.cls = score >= 60 ? 'D' : score >= 35 ? 'C' : score >= 15 ? 'B' : 'A';
  /* 超时概率：D 档几乎必超，C 档一半，B 档少数，A 档基本不超。 */
  f.risk = score >= 60 ? 0.9 : score >= 35 ? 0.5 : score >= 15 ? 0.15 : 0.03;
  return f;
}

function allNames(dir) {
  return readdirSync(dir).filter((x) => x.endsWith('.asy'))
    .map((x) => x.slice(0, -4)).sort();
}

/* ---------------------------------------------------------------- 并行计时 */

/** 一个例子跑一趟，回 `{ms, ok, killed}`。硬上限 LIMIT，超了 SIGKILL。 */
function runOne(name, who, dir) {
  return new Promise((resolve) => {
    const p = join(dir, `${name}.asy`);
    const t0 = Date.now();
    const base = existsSync(ASYBASE) ? ASYBASE : join(dir, '..', 'base');
    const env = {
      ...process.env,
      OMNI_ASY_MODS: '1',
      ASYMPTOTE_DIR: `${base}:${dir}`,
    };
    let ch;
    if (who === 'asy') {
      /* 每个例子一个自己的工作目录：真 asy 要往 cwd 写 `<名>.eps`，并行时会撞。 */
      const w = join(WORK, name);
      mkdirSync(w, { recursive: true });
      ch = spawn(ASY, ['-noV', '-f', 'eps', '-o', name, p], { cwd: w, env, detached: true });
    } else {
      ch = spawn('node', [join(ROOT, 'src', 'core', 'cli.js'), 'run', p],
        { cwd: ROOT, env, detached: true });
    }
    let outLen = 0;
    let eps = false;
    ch.stdout.on('data', (b) => {
      outLen += b.length;
      if (!eps && b.indexOf('%!PS-Adobe') >= 0) eps = true;
    });
    ch.stderr.on('data', () => {});
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      /* **必须 `detached: true` + 杀进程组**：`omni run` 会再 spawn 一个 node 去跑
       * ESM 启动器，只杀直接的孩子会留一个满载的 node 在后台啃 CPU，后面的例子于是
       * 越跑越慢。而 `detached` 是前提 —— 没有它，孩子在**我们自己**的进程组里，
       * `kill(-pid)` 要么打不着、要么把量它的这个进程一起打死（量到过：跑到 141/220
       * 时整个 node 收到 SIGPIPE 退了）。 */
      try { process.kill(-ch.pid, 'SIGKILL'); } catch { /* 组已经空了 */ }
    }, LIMIT);
    ch.on('close', (code) => {
      clearTimeout(timer);
      resolve({ name, ms: Date.now() - t0, ok: !killed && code === 0, killed, outLen, eps });
    });
    ch.on('error', () => {
      clearTimeout(timer);
      resolve({ name, ms: Date.now() - t0, ok: false, killed: false, outLen: 0, eps: false });
    });
  });
}

/** 一个 JOBS 大小的池子，谁空谁取下一个。每跑完一个就落盘 —— 被打断不丢已经量到的。 */
async function timeAll(names, who, dir, save) {
  const out = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      next++;
      if (i >= names.length) return;
      const r = await runOne(names[i], who, dir);
      out.push(r);
      save(r);
      const tag = r.killed ? `>${LIMIT}` : String(r.ms);
      process.stderr.write(`  ${String(out.length).padStart(3)}/${names.length} `
        + `${r.name.padEnd(24)} ${tag.padStart(6)}ms ${r.eps ? 'eps' : (r.ok ? 'ok ' : '--')}\n`);
    }
  };
  const ws = [];
  for (let i = 0; i < Math.min(JOBS, names.length); i++) ws.push(worker());
  await Promise.all(ws);
  return out;
}

/* ---------------------------------------------------------------- 主 */

const mode = process.argv[2] === undefined ? 'static' : process.argv[2];

if (mode === 'static') {
  const dir = process.argv[3] === undefined ? EXDIR : process.argv[3];
  const rows = allNames(dir).map((n) => features(n, readFileSync(join(dir, `${n}.asy`), 'utf8')));
  rows.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
  const by = { A: [], B: [], C: [], D: [] };
  for (const r of rows) by[r.cls].push(r);
  const why = (r) => FEATS.filter(([k]) => r[k]).map(([k]) => k).join(',');
  console.log(`examples 静态分类（${rows.length} 份，目录 ${dir}）`);
  console.log('  档  个数  预计超时概率  特征');
  for (const c of ['D', 'C', 'B', 'A']) {
    console.log(`   ${c}  ${String(by[c].length).padStart(4)}  `
      + `${by[c].length > 0 ? by[c][0].risk : 0}`);
  }
  console.log('');
  for (const c of ['D', 'C', 'B']) {
    console.log(`---- ${c} 档（${by[c].length} 份）`);
    for (const r of by[c]) {
      console.log(`  ${String(r.score).padStart(3)}  ${r.name.padEnd(26)}`
        + ` 行${String(r.lines).padStart(4)} 循环${String(r.loop).padStart(7)} ${why(r)}`);
    }
  }
  console.log(`---- A 档（${by.A.length} 份，预计都在 1s 内）`);
  console.log(`  ${by.A.map((r) => r.name).join(' ')}`);
} else if (mode === 'time') {
  const who = process.argv[3] === undefined ? 'mine' : process.argv[3];
  const dir = process.argv[4] === undefined ? EXDIR : process.argv[4];
  const only = process.argv.slice(5);
  mkdirSync(TIMEDIR, { recursive: true });
  const q = join(TIMEDIR, `${who}.json`);
  const seen = existsSync(q) ? JSON.parse(readFileSync(q, 'utf8')) : {};
  const all = only.length > 0 ? only : allNames(dir);
  /* 可续跑：量过的不再量（`OMNI_TRI_FRESH=1` 全部重量）。一趟要几十秒，而这一格
     会被反复问 —— 上一趟被打断（或者只想补几个）时不该从头开始。 */
  const names = process.env.OMNI_TRI_FRESH === '1' ? all : all.filter((n) => seen[n] === undefined);
  const save = (r) => {
    seen[r.name] = { ms: r.ms, ok: r.ok, killed: r.killed, eps: r.eps };
    writeFileSync(q, `${JSON.stringify(seen, null, 1)}\n`);
  };
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const t0 = Date.now();
  const rows = await timeAll(names, who, dir, save);
  const wall = Date.now() - t0;
  rows.sort((a, b) => b.ms - a.ms);
  rmSync(WORK, { recursive: true, force: true });
  const kill = rows.filter((r) => r.killed);
  const sum = rows.reduce((a, r) => a + r.ms, 0);
  console.log(`\n${who}：这一趟量了 ${rows.length} 个（共 ${all.length}，缓存里已有 `
    + `${all.length - names.length}），墙上 ${(wall / 1000).toFixed(1)}s`
    + `（并行 ${JOBS}，CPU 时间之和 ${(sum / 1000).toFixed(1)}s）`
    + `，超过 ${LIMIT}ms 被打死的 ${kill.length} 个`);
  console.log(`  最慢十个：${rows.slice(0, 10).map((r) => `${r.name} ${r.killed ? '>' : ''}${r.ms}`).join('  ')}`);
  if (kill.length > 0) console.log(`  被打死的：${kill.map((r) => r.name).join(' ')}`);
} else if (mode === 'report') {
  /* 把两侧量到的数与静态分类拼成一张表。零成本，随时可看。 */
  const dir = process.argv[3] === undefined ? EXDIR : process.argv[3];
  const load = (w) => {
    const q = join(TIMEDIR, `${w}.json`);
    return existsSync(q) ? JSON.parse(readFileSync(q, 'utf8')) : {};
  };
  const A = load('asy');
  const M = load('mine');
  const rows = allNames(dir).map((n) => {
    const f = features(n, readFileSync(join(dir, `${n}.asy`), 'utf8'));
    return { ...f, asy: A[n], mine: M[n] };
  });
  const num = (x) => (x === undefined ? '?' : (x.killed ? `>${x.ms}` : String(x.ms)));
  const kinds = new Map();
  for (const r of rows) {
    /* 五类，按"这个例子在这条轴上能不能算分"排：
         oracle-no   真 asy 自己出不了图 -> 这条对照不成立
         slow-both   两边都超时
         slow-mine   只有我们超时 -> 这才是要修的
         ok          两边都在限内
         unknown     还没量 */
    let k = 'unknown';
    if (r.asy !== undefined && (r.asy.killed || !r.asy.ok)) k = 'oracle-no';
    else if (r.asy !== undefined && r.mine !== undefined) {
      k = r.mine.killed ? 'slow-mine' : (r.mine.eps ? 'ok' : 'nogo-mine');
    }
    r.kind = k;
    if (!kinds.has(k)) kinds.set(k, []);
    kinds.get(k).push(r);
  }
  console.log(`examples 对照清单（${rows.length} 份，上限 ${LIMIT}ms）`);
  for (const [k, v] of [...kinds.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${k.padEnd(10)} ${String(v.length).padStart(4)}`);
  }
  for (const k of ['slow-mine', 'nogo-mine', 'oracle-no']) {
    const v = kinds.get(k) ?? [];
    if (v.length === 0) continue;
    v.sort((a, b) => (b.mine === undefined ? 0 : b.mine.ms) - (a.mine === undefined ? 0 : a.mine.ms));
    console.log(`---- ${k}（${v.length} 份）  名字 / 档 / 真asy / 我们`);
    for (const r of v) {
      console.log(`  ${r.name.padEnd(26)} ${r.cls} ${num(r.asy).padStart(7)} ${num(r.mine).padStart(7)}`);
    }
  }
  const okr = (kinds.get('ok') ?? []).slice().sort((a, b) => b.mine.ms - a.mine.ms);
  if (okr.length > 0) {
    console.log(`---- ok（${okr.length} 份）最慢十个：`
      + okr.slice(0, 10).map((r) => `${r.name} ${r.mine.ms}`).join('  '));
  }
} else if (mode === 'gen') {
  /* 生成 oracle：把真 asy 出的 EPS 落进 `.omni-cache/epsref/`（`eps.js` 只读那儿）。
   *
   * 为什么不用 `eps.js` 的 `OMNI_EPS_GEN=1`：那一份是**串行**的，量过 5 分多钟。
   * 这一份并行跑，而且**先看 `time asy` 量到的结果**，真 asy 自己出不了图的直接跳过 ——
   * 那些例子在 5s 预算下本来就不进对照，何必再等它一遍超时。 */
  const dir = process.argv[3] === undefined ? EXDIR : process.argv[3];
  const REF = join(ROOT, '.omni-cache', 'epsref');
  mkdirSync(REF, { recursive: true });
  const q = join(TIMEDIR, 'asy.json');
  const A = existsSync(q) ? JSON.parse(readFileSync(q, 'utf8')) : {};
  const all = allNames(dir);
  const todo = all.filter((n) => {
    if (existsSync(join(REF, `${n}.eps`)) && statSync(join(REF, `${n}.eps`)).size > 0) return false;
    const a = A[n];
    return a === undefined || (a.ok && !a.killed);
  });
  console.log(`oracle：要生成 ${todo.length} 个（共 ${all.length}，`
    + `已有 ${all.filter((n) => existsSync(join(REF, `${n}.eps`))).length}，`
    + `真 asy 自己出不了图、跳过的 ${all.length - todo.length
      - all.filter((n) => existsSync(join(REF, `${n}.eps`))).length}）`);
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const t0 = Date.now();
  let made = 0;
  let miss = 0;
  await timeAll(todo, 'asy', dir, (r) => {
    const src = join(WORK, r.name, `${r.name}.eps`);
    if (existsSync(src) && statSync(src).size > 0) {
      renameSync(src, join(REF, `${r.name}.eps`));
      made++;
    } else miss++;
  });
  rmSync(WORK, { recursive: true, force: true });
  console.log(`\noracle：生成 ${made} 份、没出图 ${miss} 份，墙上 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} else {
  console.error('用法：node tests/asy/triage.js static|time|report|gen [asy|mine] [目录]');
  process.exit(2);
}
