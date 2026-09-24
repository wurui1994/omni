#!/usr/bin/env node
// tests/eval/scan.js —— **EVAL 两门语言的整套语料扫一遍**（.pss 与 .kc，外部语料）
//
// 这不是判据（语料在仓库外、机器上有没有不一定），是**一张工作清单 + 一把性能尺子**：
//
//   1. 每一份脚本走一趟 `omni run`，记下 **ok / 哪一类没接住 / 超时**；
//   2. 没接住的按**类别与名字**聚合 —— "哪个宿主函数缺、缺在几份脚本里"就是下一刀的顺序；
//   3. ok 的记下**每帧墙上时间**（`--perf` 那行 `#perf gfx …`），与 c_impl 的数对照。
//
// 为什么按"缺什么 × 几份"排序：语料里 `clz`（三维那一族）缺一格就带走几十份脚本，
// 而 `glsettex` 缺一格带走另外一摊 —— 逐个例子试是把同一件事查几十遍。
//
// ## 语料在哪儿
//
//   .pss  `$OMNI_PSS_DIR`（默认 `/Users/wurui/Documents/polydraw`，只扫 examples/ken/tigrou）
//   .kc   `$OMNI_KC_DIR`（默认 `/Users/wurui/Downloads/evaldraw`，整棵树）
//
// 参考实现（c_impl，"相对正确"那一份）出的图在
// `$OMNI_PSS_DIR/c_impl/tools/_scan_tmp/*.png` —— 正确性的初始对照与性能对照都用它。
//
// ## 怎么跑（**别让它一趟跑过两分钟**：按 `--only` 切片，或者丢后台）
//
//   node tests/eval/scan.js --only ken                 只扫名字里带 ken 的
//   node tests/eval/scan.js --leg c --frame 0 --w 96 --h 72
//   node tests/eval/scan.js --budget 100               总预算 100 秒，到点就收摊报账
//
// 结果落 `.omni-cache/evalscan/<腿>.json`（下一趟能拿来比），摘要印在 stdout 上。

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(ROOT, 'src/core/cli.js');
const OUT = join(ROOT, '.omni-cache', 'evalscan');

const argv = process.argv.slice(2);
const val = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const CFG = {
  leg: val('--leg', 'js'),
  /* 哪一档设备（`--gfx`）：默认 `null` = **只记账不画** —— 这一档量的是"语言这一半通没通"，
     与设备缺哪几格 API 分开算（缺的名字会记在 `#perf calls` 那行里，不再当失败）。
     要量设备那一半就 `--gfx host`。 */
  gfx: val('--gfx', 'null'),
  frame: val('--frame', '0'),
  w: val('--w', '96'),
  h: val('--h', '72'),
  timeout: Number(val('--timeout', '20')) * 1000,
  budget: Number(val('--budget', '110')) * 1000,
  only: val('--only', ''),
  pssDir: process.env.OMNI_PSS_DIR ?? '/Users/wurui/Documents/polydraw',
  kcDir: process.env.OMNI_KC_DIR ?? '/Users/wurui/Downloads/evaldraw',
};

/** 一棵树底下所有某后缀的文件（跳过 `c_impl`/`js_impl` 那两棵实现树与隐藏目录）。 */
function walk(dir, ext, out = [], depth = 0) {
  if (depth > 4) return out;
  let names = [];
  try { names = readdirSync(dir).sort(); } catch { return out; }
  for (const nm of names) {
    if (nm.startsWith('.') || nm === 'c_impl' || nm === 'js_impl' || nm === 'build') continue;
    const p = join(dir, nm);
    let st = null;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, ext, out, depth + 1);
    else if (nm.endsWith(ext)) out.push(p);
  }
  return out;
}

const files = [
  ...['examples', 'ken', 'tigrou'].flatMap((d) => walk(join(CFG.pssDir, d), '.pss')),
  ...walk(CFG.kcDir, '.kc'),
].filter((f) => CFG.only === '' || f.includes(CFG.only));

/**
 * 一条错误消息 -> `{ cls, key }`。
 *
 * `cls` 是**类别**（下一刀按它分组）、`key` 是那一格具体的名字（宿主函数名、语法形状…）。
 * 认不出的一律 `other` 并把消息头 120 字留着 —— 不许静默归成"别的"。
 */
function classify(err) {
  const s = err.replace(/\s+/g, ' ').trim();
  /* **设备上没有那个名字**（语言这一半接住了、设备那一半没有）：CPU 备选只有 2D 那一族，
     GL 立即模式与着色器在 GPU 那两档设备上 —— 这一类是"设备要补的名字"，与下面
     `host-fn`（adapter 那一层就没接）是两件事，分开记。 */
  let m = /这格设备（[^）]*）上没有 '(\w+)'/.exec(s);
  if (m !== null) return { cls: 'device-fn', key: m[1] };
  m = /`(\w+)` 这一格宿主函数这条腿上没有落点/.exec(s);
  if (m !== null) return { cls: 'host-fn', key: m[1] };
  m = /`static (\w+)\[…\]` 的长度要是/.exec(s);
  if (m !== null) return { cls: 'static-len', key: '常量折叠' };
  m = /未声明的变量 '(\w+)'/.exec(s);
  if (m !== null) return { cls: 'undeclared', key: m[1] };
  m = /unexpected character "(.)"/.exec(s);
  if (m !== null) return { cls: 'lex', key: `词法上没有 ${m[1]}` };
  m = /这一格还没接住 —— (?:polydraw|evaldraw|eval)->IR: ([^（(]{0,60})/.exec(s);
  if (m !== null) return { cls: 'to-ir', key: m[1].trim().slice(0, 48) };
  m = /(error: [^\n]{0,60})/.exec(s);
  if (m !== null) return { cls: 'parse', key: m[1].slice(0, 48) };
  return { cls: 'other', key: s.slice(0, 120) };
}

mkdirSync(OUT, { recursive: true });
const legFlags = CFG.leg === 'js' ? [] : ['--backend', CFG.leg];
const rows = [];
const t0 = Date.now();
let over = 0;

for (const f of files) {
  if (Date.now() - t0 > CFG.budget) { over++; continue; }
  const png = join(OUT, `${basename(f)}.png`);
  const r = spawnSync('node', [CLI, 'run', ...legFlags, f,
    '--gfx', CFG.gfx, '--frame', CFG.frame, '--w', CFG.w, '--h', CFG.h, '--perf', '-o', png], {
    cwd: ROOT, encoding: 'utf8', timeout: CFG.timeout,
    env: { ...process.env, OMNI_TIMEOUT: '0' },
  });
  const ms = Number(/ total=([\d.]+)ms/.exec(r.stderr ?? '')?.[1] ?? NaN);
  const fps = Number(/ fps=([\d.]+)/.exec(r.stderr ?? '')?.[1] ?? NaN);
  if (r.error !== undefined && r.error !== null && r.error.code === 'ETIMEDOUT') {
    rows.push({ f, ok: false, cls: 'timeout', key: `>${CFG.timeout / 1000}s` });
    continue;
  }
  if (r.status === 0) {
    rows.push({ f, ok: true, ms, fps });
    continue;
  }
  const { cls, key } = classify(`${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  rows.push({ f, ok: false, cls, key });
}

/* ---------------------------------------------------------------- 报账 */

const okRows = rows.filter((r) => r.ok);
const bad = new Map();                     /* `cls|key` -> [文件…] */
for (const r of rows.filter((x) => !x.ok)) {
  const k = `${r.cls}|${r.key}`;
  if (!bad.has(k)) bad.set(k, []);
  bad.get(k).push(basename(r.f));
}

const P = (s) => process.stdout.write(s);
P(`\nEVAL 语料扫描（腿=${CFG.leg} 设备=${CFG.gfx} 帧=${CFG.frame} ${CFG.w}x${CFG.h}）`
  + `：${rows.length} 份跑过，${okRows.length} 份 ok，${rows.length - okRows.length} 份没过`
  + `${over > 0 ? `，${over} 份没来得及（预算 ${CFG.budget / 1000}s 到点）` : ''}\n\n`);

P('没过的按「缺什么 × 几份」排（这就是下一刀的顺序）：\n');
const sorted = [...bad.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [k, fs] of sorted) {
  const [cls, key] = k.split('|');
  P(`  ${String(fs.length).padStart(3)} 份  ${cls.padEnd(11)} ${key}\n`);
  P(`            ${fs.slice(0, 6).join(', ')}${fs.length > 6 ? ` …（共 ${fs.length}）` : ''}\n`);
}

if (okRows.length > 0) {
  P('\n跑通的那几份（每帧墙上时间，与 c_impl 的 fps 对照）：\n');
  for (const r of okRows.sort((a, b) => (b.ms || 0) - (a.ms || 0))) {
    P(`  ${Number.isFinite(r.ms) ? `${r.ms.toFixed(1).padStart(8)}ms` : '        —'}`
      + `  ${Number.isFinite(r.fps) ? `${r.fps.toFixed(1).padStart(8)} fps` : '           —'}`
      + `  ${basename(r.f)}\n`);
  }
}

/* 账按"腿 + 设备"分文件：`--gfx null`（默认，量语言那一半）照旧是 `<腿>.json`，
   别的设备各自一份（`c-gl.json` / `c-host.json`）—— 不然量 GPU 那一趟会把上一趟的账盖掉，
   而"gl 比 host 多几份"正是判据本身。 */
const jsonPath = join(OUT, `${CFG.leg}${CFG.gfx === 'null' ? '' : `-${CFG.gfx}`}.json`);
writeFileSync(jsonPath, `${JSON.stringify({ cfg: CFG, rows }, null, 2)}\n`);
P(`\n账落在 ${jsonPath}\n`);
