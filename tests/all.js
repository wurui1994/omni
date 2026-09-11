#!/usr/bin/env node
// Omni — 把所有测试套件跑一遍，**一条红了也继续往下跑**。
//
// 为什么要有这个文件：`test:all` 原来是十七个 `node tests/xxx/run.js` 用 `&&` 串起来的，
// 于是第一条红的套件之后全部不跑 —— 这件事在两刀里各掩住了一次真实的红
// （js-roundtrip 那次掩了 14 个套件、incr 那次掩了 7 个），而两次都是「看起来全绿」。
// 顺序执行没问题，短路有问题。
//
// 三件事是 ADR-0023 加的（增量、依赖图、日志）：
//   1. **轴级跳过**：先算这条轴的指纹（轴目录的内容 + 这条轴上一趟装载过的那些模块的内容），
//      与"上一趟绿"的指纹一样就不跑。红的轴不入册，所以跳过只会跳已经绿过的。
//   2. **日志**：每条轴的完整输出落 `.omni-cache/test/log/<轴>.log`（上一趟挪成 `.prev.log`）。
//      要看细节读文件，不再"为了看清楚而重跑一遍"。
//   3. `FORCE=1` 全部重跑；某条轴没接子进程缓存时，指纹按整棵 `src/` 算（保守，不说谎）。
//
// 读结果只看最后那张表：`FAIL` 那一列是套件级的，`N passed, M failed` 是套件自己印的。
//
//   node tests/all.js            全部
//   node tests/all.js mir sexpr  只跑名字里含这些词的
//   FORCE=1 node tests/all.js    不看指纹，全跑

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { axisFingerprint, axisState } from './lib/incr.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const force = process.env.FORCE === '1';

// 顺序照旧（快的在前、自举在最后）—— 有些套件会用到前面套件落下的缓存目录。
// `bootstrap/link.js` 排在 `bootstrap/run.js` 前面：它是那条链的**快检**（半秒，只走
// `emit-js`），而 `run.js` 是整条自举门（四分钟）。链断了这半秒就能说清断在哪一类上。
const SUITES = [
  'run.js', 'cli/tree.js', 'glsl/run.js', 'oracle/run.js', 'js-roundtrip/run.js', 'oir/run.js', 'js-exec/run.js',
  'cabi/run.js', 'wat/run.js', 'glr/run.js', 'mir/run.js', 'incr/run.js',
  'c/run.js',
  'llvm/run.js', 'sexpr/run.js', 'asy/run.js', 'jnc/run.js', 'jit/run.js',
  'gpu/run.js', 'bootstrap/link.js', 'bootstrap/run.js',
];

const logDir = join(process.env.OMNI_CACHE_DIR || join(root, '.omni-cache'), 'test', 'log');
mkdirSync(logDir, { recursive: true });
const state = axisState();

/** 把子进程的输出同时写进终端与日志（顺序执行，所以一条一条来就够）。 */
function runSuite(script, logPath) {
  return new Promise((resolve) => {
    const log = createWriteStream(logPath);
    const p = spawn('node', [join(here, script)], { stdio: ['ignore', 'pipe', 'pipe'] });
    const tee = (chunk) => { process.stdout.write(chunk); log.write(chunk); };
    p.stdout.on('data', tee);
    p.stderr.on('data', tee);
    p.on('close', (code) => log.end(() => resolve(code === null ? 1 : code)));
  });
}

const results = [];
for (const s of SUITES) {
  /* 名字取目录（`run.js` 是 core）。同一个目录里两支门的话，把文件名也带上 ——
   * 不然汇总里会出现两行同名的 `bootstrap`，一行 ok 一行 FAIL，看不出哪个是哪个。 */
  const dir = s.slice(0, s.indexOf('/'));
  const base = s.slice(s.indexOf('/') + 1, s.length - 3);
  const name = s === 'run.js' ? 'core'
    : SUITES.filter((x) => x.startsWith(`${dir}/`)).length > 1 ? `${dir}/${base}` : dir;
  if (filters.length > 0 && !filters.some((f) => name.includes(f))) continue;

  /* 指纹按**轴目录**算：`run.js` 那条轴的目录是 tests/cases + tests/run.js，所以退回整棵
   * tests/（它自己的固件在 cases/ 里）。别的轴就是 tests/<目录>。 */
  const axisDir = s === 'run.js' ? join(here, 'cases') : join(here, dir);
  const key = name.replace('/', '-');
  const logPath = join(logDir, `${key}.log`);
  const fp = axisFingerprint(key, axisDir);
  const had = state.get(key);
  if (!force && had !== null && had.code === 0 && had.fingerprint === fp) {
    process.stdout.write(`\n=== ${name} ===\n  skip 输入没变、上一趟绿（日志：${logPath}）\n`);
    results.push({ name, code: 0, ms: 0, skipped: true });
    continue;
  }

  process.stdout.write(`\n=== ${name} ===\n`);
  if (existsSync(logPath)) renameSync(logPath, join(logDir, `${key}.prev.log`));
  const t0 = Date.now();
  // eslint-disable-next-line no-await-in-loop -- 套件是顺序跑的（有的会用前一条落下的缓存）
  const code = await runSuite(s, logPath);
  const ms = Date.now() - t0;
  results.push({ name, code, ms, skipped: false });
  /* 只有绿的那一趟入册。红的不记 —— 下一趟照旧重跑，不会"跳过一条红的轴"。
   * 指纹在**跑之后**重算一次：轴自己可能落下新的依赖记录（第一趟那种）。 */
  if (code === 0) state.put(key, { fingerprint: axisFingerprint(key, axisDir), code, ms });
}

process.stdout.write('\n---- 套件汇总 ----\n');
let bad = 0;
let skipped = 0;
for (const r of results) {
  if (r.code !== 0) bad++;
  if (r.skipped) skipped++;
  const tag = r.code === 0 ? (r.skipped ? 'skip' : 'ok  ') : 'FAIL';
  const t = r.skipped ? '' : `  (${(r.ms / 1000).toFixed(1)}s)`;
  process.stdout.write(`  ${tag} ${r.name}${t}\n`);
}
process.stdout.write(`\n${results.length - bad}/${results.length} 个套件通过`
  + `${skipped > 0 ? `（其中 ${skipped} 条跳过：输入没变）` : ''}\n`);
process.stdout.write(`日志：${logDir}\n`);
process.exit(bad === 0 ? 0 : 1);
