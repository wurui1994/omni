#!/usr/bin/env node
// Omni — jancy 语料的**尺子**（ADR-0016 每一刀开头那张榜）
//
// 从第五十几刀起，每一刀的选题都靠同一件事：拿 jancy 仓库里**全部** `.jnc`（662 份）过一遍
// `omni sx`（只降不跑），把「还不收」与普通错各自归一，数成 (文件, 拦路项) 对，看谁在榜首、
// 谁是某些文件的**唯一**拦路项。以前这把尺子是 `/tmp/m64r.sh` 那种一次性脚本：每量一次全量
// 重跑、跑完就扔、上一次的数字只留在 ADR 的正文里。三件事都要改：
//
//   1. **进仓库**（这一份）—— 方子不再随手重写，两刀之间的数才可比；
//   2. **走运行缓存**（ADR-0023 的 RunCache）—— 没改的文件不重跑，改了前端才全量；
//   3. **落报告**（`.omni-cache/test/log/jnc-sweep.log` + `jnc-sweep.json`）——
//      细节读文件，而且下一趟自动印出与上一趟的差（`2746 -> 2698（−48）` 那种）。
//
// 归一化的方子（与前几刀一字不改）：`路径:行:列: error: ` 掐掉；`jancy 前端第一刀还不收：`
// 那一段脱掉并记成 N，别的记成 E；理由里带引号的名字换成 `'…'`（"没有这个类型 'A'" 与
// "没有这个类型 'B'" 是同一格账，不是两格）。一份文件里同一条理由只算一次。
//
//   node tests/lib/jnc-sweep.js              全量，印前 25 名
//   node tests/lib/jnc-sweep.js --top 40     印前 40 名
//   node tests/lib/jnc-sweep.js --only ioninja   只扫路径里含这个词的
//   node tests/lib/jnc-sweep.js --group test/ioninja/api   那一批**当一个模块**编一次
//                                （这一格自己记一份基线，会印出与上一趟的差、以及**哪一行整行没了**）
//   JANCY=/path/to/jancy node tests/lib/jnc-sweep.js

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunCache } from './incr.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const cli = join(root, 'src', 'core', 'cli.js');

const JANCY = process.env.JANCY || '/Users/wurui/Documents/Lang/reference/jancy';
const NOPE = 'jancy 前端第一刀还不收：';
const argv = process.argv.slice(2);
const topN = (() => {
  const i = argv.indexOf('--top');
  return i < 0 ? 25 : Number(argv[i + 1]);
})();
const only = (() => {
  const i = argv.indexOf('--only');
  return i < 0 ? null : argv[i + 1];
})();
/* `--group <目录>`：把那个目录里的 `.jnc` **当一个模块**编一次（合成一份只有 import 的文件）。
   为什么要这一格：ioninja 那一支的 CMakeLists 就是把 api/ 整批一起编的，而默认那一遍是
   **逐份**编 —— 于是 `ui.StdColor` 这种"在同一批里、可这一份没写 import"的名字全落在
   `没有这个类型` / `没有这个函数` / `未声明的变量` 那三行上。那三行里有多少是**口径**、
   多少是真的缺，只有这一格量得出来。
   它**不动**默认那一遍的基线（json / log 各自一份），可它自己那一份基线要留 ——
   判一刀看的是"**哪一行不见了**"（ADR-0016 第一百一十八刀立的口径），而那件事只有
   上一趟的榜在手里才说得出来。先前这一格什么都不留，于是第一百三十二刀那一节里
   只能写"另一种落在榜印不出来的那一段里，说不出是哪一行"—— 这一格就是补它。 */
const group = (() => {
  const i = argv.indexOf('--group');
  return i < 0 ? null : argv[i + 1];
})();

if (!existsSync(JANCY)) {
  process.stdout.write(`语料不在（${JANCY}）—— 用 JANCY=… 指一份 jancy 源码树\n`);
  process.exit(0);
}

/** 语料 = 这棵树里全部 `.jnc`（662 份就是这么来的：整个仓库，不只 test/）。 */
function corpus(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) corpus(p, out);
    else if (name.endsWith('.jnc')) out.push(p);
  }
  return out;
}

/* ioninja 那一支自己带一层 API（它的 CMakeLists.txt:815 就是这么编的），不给 `-I` 的话
   每一份都卡在"没有这个类型"上，量出来的榜是假的。 */
const IONINJA_API = join(JANCY, 'test', 'ioninja', 'api');
const argsFor = (p) => (p.includes(`${'/test/ioninja/'}`) && existsSync(IONINJA_API)
  ? [cli, 'sx', p, '-I', IONINJA_API] : [cli, 'sx', p]);

/* `--group` 那一格（见上面那段注）：合成一份只有 import 的文件，一次编完整批。 */
if (group !== null) {
  const dir = group.startsWith('/') ? group : join(JANCY, group);
  if (!existsSync(dir)) {
    process.stdout.write(`没有这个目录：${dir}\n`);
    process.exit(0);
  }
  const names = readdirSync(dir).sort().filter((x) => x.endsWith('.jnc'));
  const gRoot = process.env.OMNI_CACHE_DIR || join(root, '.omni-cache');
  mkdirSync(join(gRoot, 'test'), { recursive: true });
  const modPath = join(gRoot, 'test', 'jnc-group.jnc');
  writeFileSync(modPath, `${names.map((x) => `import "${x}"`).join('\n')}\n`);
  let gErr = '';
  let gCode = 0;
  try {
    execFileSync(process.execPath, [cli, 'sx', modPath, '-I', dir],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    gCode = e.status ?? 1;
    gErr = e.stderr ?? '';
  }
  const gt = new Map();
  let gn = 0;
  for (const line of gErr.split('\n')) {
    const d = reasonOf(line);
    if (d === null) continue;
    gn += 1;
    const k = `${d.kind} ${d.why}`;
    gt.set(k, (gt.get(k) ?? 0) + 1);
  }
  // 这一格自己那一份基线（按目录记账，与默认那一遍的 json 分开放）
  const gRootC = process.env.OMNI_CACHE_DIR || join(root, '.omni-cache');
  const gJson = join(gRootC, 'test', 'jnc-sweep-group.json');
  const gPrevAll = (() => {
    try {
      return JSON.parse(readFileSync(gJson, 'utf8'));
    } catch {
      return {};
    }
  })();
  const gPrev = gPrevAll[dir] ?? null;
  const gd = (now, was) => (was === undefined || was === null ? ''
    : `（上一趟 ${was}${now === was ? '，没动' : `，${now > was ? '+' : '−'}${Math.abs(now - was)}`}）`);
  process.stdout.write(`一整批当一个模块编：${names.length} 份（${dir}）`
    + ` —— 退出码 ${gCode}、诊断 ${gn} 条${gd(gn, gPrev?.n)}`
    + `、理由 ${gt.size} 种${gd(gt.size, gPrev?.reasons)}\n\n`);
  const gPrevBoard = new Map(Object.entries(gPrev?.board ?? {}));
  for (const [k, v] of [...gt.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)) {
    const was = gPrevBoard.get(k);
    process.stdout.write(`  ${String(v).padStart(4)}  ${k}`
      + `${was === undefined ? '  ← 新' : (was === v ? '' : `  （上一趟 ${was}）`)}\n`);
  }
  /* **哪一行不见了** —— 判一刀就看这一栏（ADR-0016 第一百一十八刀）。它不受 --top 限制：
     一行整整消失是这把尺子上最要紧的一件事，不能因为它排在第 26 名就印不出来。 */
  const gone = [...gPrevBoard.entries()].filter(([k]) => !gt.has(k))
    .sort((a, b) => b[1] - a[1]);
  if (gone.length > 0) {
    process.stdout.write('\n整行没了（上一趟有、这一趟一处都不剩）\n');
    for (const [k, v] of gone) process.stdout.write(`  ${String(v).padStart(4)}  ${k}\n`);
  }
  mkdirSync(join(gRootC, 'test'), { recursive: true });
  gPrevAll[dir] = { n: gn, reasons: gt.size, board: Object.fromEntries(gt) };
  writeFileSync(gJson, `${JSON.stringify(gPrevAll, null, 1)}\n`);
  process.stdout.write('\n（这一格不写 log，json 也是自己那一份'
    + ' —— 默认那一遍的基线要保持可比）\n');
  process.exit(0);
}

const files = corpus(JANCY).filter((p) => only === null || p.includes(only));
process.stdout.write(`语料 ${files.length} 份（${JANCY}）\n`);

const cache = new RunCache('jnc-sweep');
const t0 = Date.now();
await cache.warm(files.map(argsFor), { cwd: root });
if ((cache.warmed ?? 0) > 0) {
  process.stdout.write(`  --   预热 ${cache.warmed} 次（并行）${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}

/** 一行诊断 -> 归一化的理由。`null` = 这一行不是诊断（是那两行代码摘录）。 */
function reasonOf(line) {
  const m = /^.*?:\d+:\d+: (?:error|warning): (.*)$/.exec(line);
  if (m === null) return null;
  const text = m[1];
  const nope = text.startsWith(NOPE);
  return { kind: nope ? 'N' : 'E', why: (nope ? text.slice(NOPE.length) : text).replace(/'[^']*'/g, "'…'") };
}

// ---------------------------------------------------------------- 扫一遍，记账
const rows = [];        // 每份文件一条：{ file, code, nopes: Set, errs: Set }
for (const p of files) {
  const r = cache.run(argsFor(p), { cwd: root });
  const nopes = new Set();
  const errs = new Set();
  for (const line of r.err.split('\n')) {
    const d = reasonOf(line);
    if (d === null) continue;
    (d.kind === 'N' ? nopes : errs).add(d.why);
  }
  rows.push({ file: p.slice(JANCY.length + 1), code: r.code, nopes, errs });
}

const lowered = rows.filter((x) => x.code === 0).length;
const clean = rows.filter((x) => x.nopes.size === 0).length;
/** (文件, 拦路项) 对 —— 一份文件里同一条理由只算一次，N 与 E 分开数。 */
const pairs = rows.reduce((n, x) => n + x.nopes.size + x.errs.size, 0);

/** 一条理由的账：碰上它的文件数，以及**它是唯一拦路项**的文件数（挑下一刀就看这一栏）。 */
const tally = new Map();
for (const x of rows) {
  const all = [...[...x.nopes].map((w) => `N ${w}`), ...[...x.errs].map((w) => `E ${w}`)];
  for (const k of all) {
    const had = tally.get(k) ?? { files: 0, sole: 0 };
    had.files += 1;
    if (all.length === 1) had.sole += 1;
    tally.set(k, had);
  }
}
const board = [...tally.entries()].sort((a, b) => (b[1].files - a[1].files)
  || (b[1].sole - a[1].sole) || (a[0] < b[0] ? -1 : 1));

// ---------------------------------------------------------------- 与上一趟比
const cacheRoot = process.env.OMNI_CACHE_DIR || join(root, '.omni-cache');
const jsonPath = join(cacheRoot, 'test', 'jnc-sweep.json');
const logPath = join(cacheRoot, 'test', 'log', 'jnc-sweep.log');
const prev = (() => {
  try {
    return JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch {
    return null;
  }
})();
const delta = (now, was) => (was === undefined || was === null ? ''
  : ` （上一趟 ${was}${now === was ? '，没动' : `，${now > was ? '+' : '−'}${Math.abs(now - was)}`}）`);

// ---------------------------------------------------------------- 印出来 + 落盘
process.stdout.write(`\n真降得下来（sx 退出码 0）：${lowered}${delta(lowered, prev?.lowered)}\n`);
process.stdout.write(`没有"还不收"的文件：${clean}${delta(clean, prev?.clean)}\n`);
process.stdout.write(`(文件, 拦路项) 对：${pairs}${delta(pairs, prev?.pairs)}\n`);
process.stdout.write(`\n榜（N=还不收 / E=普通错；sole = 它是那份文件的唯一拦路项）\n`);
const prevBoard = new Map(Object.entries(prev?.board ?? {}));
for (const [k, v] of board.slice(0, topN)) {
  const was = prevBoard.get(k);
  process.stdout.write(`  ${String(v.files).padStart(4)}  sole ${String(v.sole).padStart(3)}  ${k}`
    + `${was === undefined ? '  ← 新' : (was.files === v.files ? '' : `  （上一趟 ${was.files}）`)}\n`);
}

mkdirSync(join(cacheRoot, 'test', 'log'), { recursive: true });
const lines = [`; jancy 语料尺子 —— ${files.length} 份（${JANCY}）`,
  `; 降得下来 ${lowered}、没有还不收 ${clean}、(文件, 拦路项) 对 ${pairs}`, ''];
lines.push('; ---- 榜（全量） ----');
for (const [k, v] of board) lines.push(`${String(v.files).padStart(5)}  sole ${String(v.sole).padStart(3)}  ${k}`);
lines.push('', '; ---- 每份文件 ----');
for (const x of rows) {
  const all = [...[...x.nopes].map((w) => `N ${w}`), ...[...x.errs].map((w) => `E ${w}`)].sort();
  lines.push(`${x.code === 0 ? 'ok  ' : 'FAIL'} ${x.file}${all.length === 0 ? '' : `\n${all.map((w) => `        ${w}`).join('\n')}`}`);
}
writeFileSync(logPath, `${lines.join('\n')}\n`);
writeFileSync(jsonPath, `${JSON.stringify({
  files: files.length, lowered, clean, pairs, board: Object.fromEntries(board),
}, null, 1)}\n`);

const rep = cache.report();
process.stdout.write(`\n报告：${logPath}${rep === '' ? '' : `\n${rep}`}\n`);
