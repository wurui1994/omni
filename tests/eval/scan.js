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
// ## 怎么跑（**默认增量**：过了的不重跑、到几个红就收摊）
//
//   node tests/eval/scan.js                            增量：只跑"没跑过 / 上趟没过 / 源码变了"的
//   node tests/eval/scan.js --max-bad 3                到 3 个红就收摊（默认 5）
//   node tests/eval/scan.js --bad                      只重跑上趟没过的那几份
//   node tests/eval/scan.js --all                      全量（改了公共层想重新立账时才用）
//   node tests/eval/scan.js --only ken                 只扫名字里带 ken 的
//
// **为什么默认增量**：全量一趟是几百秒，而其中绝大多数是"上趟就过了、这趟一个字节都没变"
// 的份 —— 那段时间买不到任何信息。增量的判据是两格印记：
//   * 脚本自己的内容（`srcHash`）；
//   * **编译器与运行时那棵树**（`legStamp`：`src/` 与 `ext/` 下每份 `.js`/`.c` 的
//     大小 + mtime 哈希一遍）—— 改了降级器之后上趟的 ok 就不算数了。
// 两格都没变的 ok 直接**照抄上趟那一行**（报账里标出来"抄了几份"）。
//
// 结果落 `.omni-cache/evalscan/<腿>.json`（下一趟的基线），摘要印在 stdout 上。

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
const has = (n) => argv.includes(n);
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
  /* **到几个红就收摊**（0 = 不收）：查错是一格一格查的，攒一百个红没有用。 */
  maxBad: Number(val('--max-bad', '5')),
  all: has('--all'),                     /* 全量重跑（重新立账时才用） */
  badOnly: has('--bad'),                 /* 只重跑上趟没过的那几份 */
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

/* 账按"腿 + 设备"分文件：`--gfx null`（默认，量语言那一半）照旧是 `<腿>.json`，
   别的设备各自一份（`c-gl.json` / `c-host.json`）—— 不然量 GPU 那一趟会把上一趟的账盖掉，
   而"gl 比 host 多几份"正是判据本身。 */
const jsonPath = join(OUT, `${CFG.leg}${CFG.gfx === 'null' ? '' : `-${CFG.gfx}`}.json`);

/**
 * **这条腿的印记**：`src/` 与 `ext/` 底下每份 `.js`/`.c`/`.h` 的大小 + mtime 哈希一遍。
 *
 * 增量的前提是"没变过的东西不用再问"。脚本自己变了要重跑是显然的；**编译器与运行时变了
 * 也要重跑**（不然改完降级器照抄上趟的 ok，等于没判据）。范围取两棵树而不是只取 `src/core`：
 * 语言那一半在 `ext/<语言>/adapter.js` 与 `ext/polydraw/*-rt.js` 里 —— 只扫 `src/core`
 * 是踩过的坑（改 `ext/` 的适配器不算"变了"）。
 */
function legStamp() {
  const parts = [];
  const walkSrc = (dir, depth = 0) => {
    if (depth > 6) return;
    let names = [];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const nm of names) {
      if (nm.startsWith('.') || nm === 'node_modules') continue;
      const p = join(dir, nm);
      let st = null;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walkSrc(p, depth + 1); continue; }
      if (!/\.(js|mjs|c|h)$/.test(nm)) continue;
      parts.push(`${p}:${st.size}:${Math.trunc(st.mtimeMs)}`);
    }
  };
  walkSrc(join(ROOT, 'src'));
  walkSrc(join(ROOT, 'ext'));
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

const STAMP = legStamp();
const srcHash = (p) => {
  try {
    return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);
  } catch { return ''; }
};

/** 上一趟那份账：`路径 -> 那一行`（没有就空着 = 全都要跑）。 */
const base = new Map();
if (!CFG.all) {
  try {
    const j = JSON.parse(readFileSync(jsonPath, 'utf8'));
    for (const r of j.rows ?? []) base.set(r.f, r);
  } catch { /* 第一趟：没有基线 */ }
}

const legFlags = CFG.leg === 'js' ? [] : ['--backend', CFG.leg];
const rows = [];
const t0 = Date.now();
let over = 0;
let carried = 0;                          /* 照抄上趟那一行的份数 */
let ran = 0;                              /* 这一趟真跑了几份 */
let nbad = 0;                             /* 这一趟真跑出来的红 */
let stopped = false;                      /* 到 `--max-bad` 收摊了 */

for (const f of files) {
  const hash = srcHash(f);
  const prev = base.get(f);
  /* **照抄上趟**：上趟 ok、脚本没变、编译器与运行时也没变 —— 再跑一趟买不到信息。 */
  if (!CFG.all && prev !== undefined && prev.ok === true
      && prev.hash === hash && prev.stamp === STAMP) {
    rows.push(prev);
    carried += 1;
    continue;
  }
  /* `--bad`：只重跑上趟没过的那几份（新出现的份也跑 —— 那也是"还没有答案"）。 */
  if (CFG.badOnly && prev !== undefined && prev.ok === true) { rows.push(prev); carried += 1; continue; }
  if (stopped || Date.now() - t0 > CFG.budget) {
    over++;
    /* 没来得及的那几份：上趟有答案就把上趟那行留着（账不要因为收摊而丢历史）。 */
    if (prev !== undefined) rows.push({ ...prev, stale: true });
    continue;
  }
  const png = join(OUT, `${basename(f)}.png`);
  const r = spawnSync('node', [CLI, 'run', ...legFlags, f,
    '--gfx', CFG.gfx, '--frame', CFG.frame, '--w', CFG.w, '--h', CFG.h, '--perf', '-o', png], {
    cwd: ROOT, encoding: 'utf8', timeout: CFG.timeout,
    /**
     * **预算跟着这一扫的 `--timeout` 走，不能给 0**（2026-09-26 量出来的）。
     *
     * 从前这儿写的是 `OMNI_TIMEOUT: '0'`，本意是"超时由这一扫自己用 `spawnSync` 的
     * `timeout` 管"。可 `spawnSync` 的 `timeout` 只杀得到**直接的孩子**（那个 `node`），
     * 而真在画图的是**孙子**（`omni run` 编出来那个可执行文件）—— 孩子被杀之后孙子成了
     * 孤儿，而 `OMNI_TIMEOUT=0` 把它自己那三层时限（SIGALRM + 外部看门狗）也一起关了，
     * 于是谁都不管它。量出来的后果：`run-asteroids.sx/asteroids` 与 `run-box.sx/box`
     * 两个孤儿各吃 85% CPU 活了 46 分钟，只能手动 `kill -9`。
     *
     * 这与 `studio/pool.js` 那一格是**同一个毛病**（见 fix(deadline) 那一笔）：
     * 想说"别给我开枪"，写成了"一格预算都别留"。这儿连枪都不用关 —— 到点自己退 124，
     * 这一扫照旧按退出码分类。
     */
    env: { ...process.env, OMNI_TIMEOUT: String(Math.ceil(CFG.timeout / 1000)) },
  });
  const ms = Number(/ total=([\d.]+)ms/.exec(r.stderr ?? '')?.[1] ?? NaN);
  const fps = Number(/ fps=([\d.]+)/.exec(r.stderr ?? '')?.[1] ?? NaN);
  ran += 1;
  if (r.error !== undefined && r.error !== null && r.error.code === 'ETIMEDOUT') {
    rows.push({ f, ok: false, cls: 'timeout', key: `>${CFG.timeout / 1000}s`, hash, stamp: STAMP });
  } else if (r.status === 0) {
    rows.push({ f, ok: true, ms, fps, hash, stamp: STAMP });
    continue;
  } else {
    const { cls, key } = classify(`${r.stdout ?? ''}\n${r.stderr ?? ''}`);
    rows.push({ f, ok: false, cls, key, hash, stamp: STAMP });
  }
  nbad += 1;
  /* **到几个红就收摊**：下一刀是按"缺什么"改代码，不是把剩下的红也数出来。 */
  if (CFG.maxBad > 0 && nbad >= CFG.maxBad) stopped = true;
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
P(`\nEVAL 语料扫描（腿=${CFG.leg} 设备=${CFG.gfx} 帧=${CFG.frame} ${CFG.w}x${CFG.h}`
  + `${CFG.all ? ' 全量' : ` 增量 印记=${STAMP}`}）`
  + `：${rows.length} 份在账上，${okRows.length} 份 ok，${rows.length - okRows.length} 份没过`
  + `（这一趟真跑了 ${ran} 份，照抄上趟 ${carried} 份）`
  + `${stopped ? `，**到 ${CFG.maxBad} 个红就收摊了**（剩下的没问）` : ''}`
  + `${over > 0 ? `，${over} 份没来得及` : ''}\n\n`);

P('没过的按「缺什么 × 几份」排（这就是下一刀的顺序）：\n');
const sorted = [...bad.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [k, fs] of sorted) {
  const [cls, key] = k.split('|');
  P(`  ${String(fs.length).padStart(3)} 份  ${cls.padEnd(11)} ${key}\n`);
  P(`            ${fs.slice(0, 6).join(', ')}${fs.length > 6 ? ` …（共 ${fs.length}）` : ''}\n`);
}

if (okRows.length > 0 && !has('--quiet')) {
  P('\n跑通的那几份（每帧墙上时间，与 c_impl 的 fps 对照）：\n');
  for (const r of okRows.sort((a, b) => (b.ms || 0) - (a.ms || 0)).slice(0, 20)) {
    P(`  ${Number.isFinite(r.ms) ? `${r.ms.toFixed(1).padStart(8)}ms` : '        —'}`
      + `  ${Number.isFinite(r.fps) ? `${r.fps.toFixed(1).padStart(8)} fps` : '           —'}`
      + `  ${basename(r.f)}\n`);
  }
  if (okRows.length > 20) P(`  …（共 ${okRows.length} 份，只印最慢的 20）\n`);
}

/* **落账要与基线合并**：`--only` 只扫了一片，那一片之外的行照旧留着 ——
   不然"扫一片"会把整张账洗成一片（踩过：`--only ext/evaldraw` 一趟把 js.json 洗成 0 行）。 */
const merged = new Map(base);
for (const r of rows) merged.set(r.f, r);
writeFileSync(jsonPath, `${JSON.stringify({
  cfg: CFG, stamp: STAMP, rows: [...merged.values()],
}, null, 2)}\n`);
P(`\n账落在 ${jsonPath}（这一片 ${rows.length} 行，整张账 ${merged.size} 行）\n`);
