#!/usr/bin/env node
// bench/paths.js —— **执行路径**的对照：同一个算法，六条路各跑一遍
// （ADR-0013：「解释器该多快」这个问题得先有两条基线）
//
// 与 `bench/compare.js` 的分工：那一份比的是**语言**（omni / luajit / python），
// 这一份比的是**路**（同一份源码怎么被执行）。
//
// 两条基线（用户给的口径）：
//   - **手写 JS**（`bench/fib.js`）—— 上限。同一台 V8、同一个算法，人写的能多快。
//   - **编成 JS**（`omni run`，OIR -> JS -> `new Function`）—— 我们的编译路能多快。
// 解释器落在这两条之下多远，就是「底限」离「上限」有多远 —— 那正是要往上推的那一段。
//
// 一致性先于耗时：**所有路的 stdout 必须逐字节相同**，不同就红（对照测试的本体）。
// 耗时是**整趟 wall**（含编译/装载），因为那才是用户等的那个数；每条路后面注了它含什么。
//
//   node bench/paths.js
//   node bench/paths.js --reps 3      # 每条路跑 N 趟取最小
//
// 为什么不切出「纯执行」那一段：切了就得每条路各插一次计时，而那要改六处产品代码。
// 现在这份程序（fib 27 + sumTo 2e6）在最快的路上都要几百毫秒，编译那几十到几百毫秒
// 是可读的噪声，量级结论不受它影响。真要分开量，看 `--verbose` 里的分段。

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const NODE = process.execPath;

const ri = process.argv.indexOf('--reps');
const REPS = ri >= 0 ? Number(process.argv[ri + 1]) : 1;
const OUT = mkdtempSync(join(tmpdir(), 'omni-bench-paths-'));

/** 一条路：`name` 印出来的名字，`argv` 怎么跑，`has` 有没有这个工具，`note` 含什么。 */
const paths = [
  {
    name: '手写 JS（上限）',
    argv: [NODE, [join('bench', 'fib.js')]],
    note: 'V8，无编译',
  },
  {
    name: 'omni -> JS（编成 JS）',
    argv: [NODE, [CLI, 'run', join('bench', 'fib.omni')]],
    note: '含前端 + OIR + 发 JS + new Function',
  },
  {
    name: 'omni -> OIR 解释器',
    argv: [NODE, [CLI, 'run', join('bench', 'fib.omni'), '--backend', 'interp']],
    note: '含前端 + OIR',
  },
  {
    name: 'omni -> C -> 本机',
    argv: [NODE, [CLI, 'run', join('bench', 'fib.omni'), '--backend', 'c']],
    note: '含前端 + 发 C + cc',
  },
  {
    name: 'C -> 本机（自带前端 + 自带链接器）',
    argv: [NODE, [CLI, 'run', join('bench', 'fib.c')]],
    note: '含 C 前端 + 代码生成 + 链接',
  },
  {
    name: 'C -> JS（MIR 编成 JS）',
    argv: [NODE, [CLI, 'run', join('bench', 'fib.c'), '--backend', 'js']],
    note: '含 C 前端 + MIR + 发 JS + new Function',
  },
  {
    name: 'C -> MIR 解释器',
    argv: [NODE, [CLI, 'run', join('bench', 'fib.c'), '--backend', 'interp']],
    note: '含 C 前端 + MIR',
  },
];

/**
 * 第二组：**只有 C 的三条腿**（内存密集那一形状，`bench/sieve.c`）。
 *
 * 为什么这一组没有「手写 JS」与 omni：这份程序的本体是**线性内存**（筛表、字符串缓冲、
 * 数组），照抄成 JS 就得先决定「那块内存在 JS 里是什么」—— 那是另一个问题。
 * 这一组要答的是「同一份 C，三条腿差多少」，分母取本机那条。
 */
const cPaths = [
  {
    name: 'C -> 本机（自带前端 + 自带链接器）',
    argv: [NODE, [CLI, 'run', join('bench', 'sieve.c')]],
    note: '含 C 前端 + 代码生成 + 链接',
  },
  {
    name: 'C -> JS（MIR 编成 JS）',
    argv: [NODE, [CLI, 'run', join('bench', 'sieve.c'), '--backend', 'js']],
    note: '含 C 前端 + MIR + 发 JS + new Function',
  },
  {
    name: 'C -> MIR 解释器',
    argv: [NODE, [CLI, 'run', join('bench', 'sieve.c'), '--backend', 'interp']],
    note: '含 C 前端 + MIR',
  },
];

/** clang 那两条（有就加上）：`-O0` 是「不优化的本机」，`-O2` 是「优化过的本机」。 */
function withClang(list, cfile, tag) {
  if (spawnSync('which', ['clang'], { encoding: 'utf8' }).status !== 0) return list;
  const out = list.slice();
  for (const opt of ['-O0', '-O2']) {
    const exe = join(OUT, `${tag}${opt}`);
    const c = spawnSync('clang', [opt, join(root, cfile), '-o', exe], { encoding: 'utf8' });
    if (c.status !== 0) continue;
    out.push({ name: `clang ${opt}`, argv: [exe, []], note: '纯执行（编译不算在内）' });
  }
  return out;
}

/** node 的空转（只启动、不做事）。每条 node 路都白付这一笔，得从耗时里减掉才看得见比例。 */
function nodeIdle() {
  let best = Infinity;
  for (let k = 0; k < Math.max(3, REPS); k++) {
    const t0 = process.hrtime.bigint();
    spawnSync(NODE, ['-e', ''], { encoding: 'utf8' });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms < best) best = ms;
  }
  return best;
}
const IDLE = nodeIdle();

let bad = 0;

/**
 * 一组：同一个程序的若干条路。**先断言答案逐字节相同**（第一条路是基准，也是比例的分母），
 * 再报耗时。比例用**净**耗时算：node 空转那一笔是每条 node 路都白付的固定成本，
 * 留在分子分母里会把差距压平（上限那条几乎全是空转）。
 */
function group(title, list) {
  let want = null;
  const rows = [];
  for (const p of list) {
    const [cmd, args] = p.argv;
    if (cmd !== NODE && !existsSync(cmd) && spawnSync('which', [cmd], { encoding: 'utf8' }).status !== 0) {
      process.stdout.write(`  skip ${p.name}\n`);
      continue;
    }
    let best = Infinity;
    let out = null;
    let err = null;
    for (let k = 0; k < REPS; k++) {
      const t0 = process.hrtime.bigint();
      const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: root, maxBuffer: 1 << 28 });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (r.status !== 0) { err = (r.stderr ?? '').trim().split('\n')[0]; break; }
      out = r.stdout;
      if (ms < best) best = ms;
    }
    if (err !== null) {
      process.stdout.write(`  FAIL ${p.name}: ${err}\n`);
      bad++;
      continue;
    }
    if (want === null) want = out;
    else if (out !== want) {
      process.stdout.write(`  FAIL ${p.name}: 答案与第一条路不同\n    要 ${JSON.stringify(want)}\n    给 ${JSON.stringify(out)}\n`);
      bad++;
      continue;
    }
    rows.push({ name: p.name, ms: best, net: cmd === NODE ? Math.max(0, best - IDLE) : best, note: p.note });
  }
  const base = rows.length > 0 ? rows[0].net : 1;
  process.stdout.write(`\n== ${title}（每条路取 ${REPS} 趟里最快的一趟）\n`);
  process.stdout.write(`答案（每条路逐字节相同）：${JSON.stringify(want)}\n\n`);
  const w = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) {
    process.stdout.write(`${r.name.padEnd(w)}  ${r.ms.toFixed(0).padStart(7)} ms  净 ${r.net.toFixed(0).padStart(7)} ms  `
      + `${(r.net / base).toFixed(1).padStart(6)}x ${rows[0].name}   ${r.note}\n`);
  }
  return rows.length;
}

process.stdout.write(`node 空转 ${IDLE.toFixed(0)} ms —— 「净」列已减掉它（clang 那几条不经过 node，净=整趟）\n`);
let n = group('fib(27) + sumTo(2e6)：算术与调用', withClang(paths, 'bench/fib.c', 'fib'));
n += group('sieve(2e6) + 20 万次字符串 + 插排：内存密集', withClang(cPaths, 'bench/sieve.c', 'sieve'));

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${n} 条路，${bad} 条红\n`);
process.exit(bad > 0 ? 1 : 0);
