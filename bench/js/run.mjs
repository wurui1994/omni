#!/usr/bin/env node
// bench/js/run.mjs —— **JS 引擎那一轴的尺子**（ADR-0047）
//
// 一句话：同一份 `.js`，**node（V8）**、**我们 + clang -O2**、**我们 + 自带后端**各跑一趟，报比值。
//
// 为什么非得有它：在这之前这一轴唯一的尺子是"重建整个编译器（1m13）再跑一份 asy"——
// 那量得动"总时间变没变"，量不动"属性查找这一层值多少"。要在形状/IC 这种结构改动上迭代，
// 尺子必须是**秒级**的。
//
// 四条自己定的规矩（都踩过才写下来的）：
//
//   1. **量二进制，不量 `omni run`**：后者含前端 + cc，而 node 空跑本身就 0.42s；
//      所以先 `omni build` 出二进制，再单独计时。构建时间另报一栏（它是"启动"那一轴的事）。
//   2. **我们自己有两栏，不是一栏**（2026-09-28 当场纠过一次）：
//      `clang -O2` 那一栏是"**我们发的码**有多好"，`self` 那一栏是"**我们的后端**有多好"。
//      第一趟只量了后者，把 int-loop 报成 72x —— 换 clang 是 **8.9x**。两件事混成一格，
//      改发射层与改后端的收益就分不开了（memory：性能的尺子必须是真优化编译器）。
//   3. **`OMNI_OPT=2`**：`-O0` 那张榜会把"没被内联的 static inline"顶到前排（ADR-0047 §10.2）。
//   4. **交错跑 + 各取最小值**：这台机器单次墙上时间抖 ±5%，比一刀优化的收益还大
//      （与 `bench/lua/ab.js` 同一条口径）。别用 bash 循环 + date 量 —— 那套白加 ~34ms。
//
// 每份程序自己印一个校验和：**答案不同的那一栏不许上榜**（"快了 9.25 倍"因为算错了，
// 那种事发生过）。
//
// 用法：
//   node bench/js/run.mjs                 # 全部
//   node bench/js/run.mjs prop-mono       # 只跑名字里含这串的
//   N=5 node bench/js/run.mjs             # 每栏跑几趟（默认 3）
//   SELF=0 node bench/js/run.mjs          # 只要 clang 那一栏（自带后端那一栏慢，赶时间时关掉）

import { spawnSync } from 'node:child_process';
import { readdirSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const WORK = join(ROOT, '.omni-cache', 'work', 'benchjs');
const N = Number(process.env.N || 3);
const WANT_SELF = process.env.SELF !== '0';
const filter = process.argv[2] ?? '';

const progs = readdirSync(join(HERE, 'progs')).filter((f) => f.endsWith('.js'))
  .map((f) => f.slice(0, -3)).filter((p) => p.includes(filter)).sort();
if (progs.length === 0) { console.log('没有匹配的程序'); process.exit(1); }
mkdirSync(WORK, { recursive: true });

/** 跑一趟，回 `{ ms, out }`。**stdout 收下来** —— 校验和要对。 */
function once(cmd, args) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 600000 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, out: (r.stdout ?? '').trim(), code: r.status };
}

/** 建一份二进制。回 `{ bin, ms }` 或 `{ err }`。 */
function build(src, bin, env) {
  const t0 = process.hrtime.bigint();
  const b = spawnSync('node', [join(ROOT, 'src/cli.js'), 'build', src, '-o', bin],
    { encoding: 'utf8', env: { ...process.env, OMNI_OPT: '2', ...env }, timeout: 600000 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (b.status !== 0 || !existsSync(bin)) {
    return { err: (b.stderr ?? '').trim().split('\n').slice(-2).join(' ').slice(0, 160) };
  }
  return { bin, ms };
}

const rows = [];
for (const p of progs) {
  const src = join(HERE, 'progs', `${p}.js`);
  const bc = build(src, join(WORK, `${p}-clang`), { OMNI_CC: 'clang' });
  if (bc.err !== undefined) { rows.push({ p, err: bc.err }); continue; }
  const bs = WANT_SELF ? build(src, join(WORK, `${p}-self`), {}) : { bin: null, ms: undefined };
  if (bs.err !== undefined) { rows.push({ p, err: bs.err }); continue; }
  /* 交错：node 一趟、clang 一趟、self 一趟、node 一趟…… 各取最小。 */
  const best = { v: Infinity, c: Infinity, s: Infinity };
  const out = {};
  for (let i = 0; i < N; i++) {
    const v = once('node', [src]);
    if (v.ms < best.v) best.v = v.ms;
    out.v = v.out;
    const c = once(bc.bin, []);
    if (c.ms < best.c) best.c = c.ms;
    out.c = c.out;
    if (bs.bin !== null) {
      const s = once(bs.bin, []);
      if (s.ms < best.s) best.s = s.ms;
      out.s = s.out;
    }
  }
  rows.push({
    p, ...best, buildC: bc.ms, buildS: bs.ms, out,
    same: out.c === out.v && (bs.bin === null || out.s === out.v),
  });
}

const f = (x) => (x === undefined || x === Infinity ? '     —' : x.toFixed(0).padStart(6));
const r2 = (a, b) => (b === Infinity || a === Infinity ? '    —' : (a / b).toFixed(1).padStart(5));
console.log(`\nJS 引擎那一轴（同一份 .js，min of ${N}）\n`);
console.log('  程序           node(V8)   clang-O2   自带后端   vs V8   自带/clang   答案');
let bad = 0;
for (const r of rows) {
  if (r.err !== undefined) { bad++; console.log(`  ${r.p.padEnd(14)} 建不出来：${r.err}`); continue; }
  if (!r.same) bad++;
  const ok = r.same ? '一样' : `**不一样**（想要 ${r.out.v}，clang ${r.out.c}，self ${r.out.s}）`;
  console.log(`  ${r.p.padEnd(14)}${f(r.v)}ms ${f(r.c)}ms ${f(r.s)}ms  ${r2(r.c, r.v)}x  `
    + `${r2(r.s, r.c)}x   ${ok}`);
}
console.log('\n  「vs V8」= clang-O2 那一栏 / node。**这一栏是这一轴的判据**（目标靠近 1）——'
  + '\n  它量的是"我们发的码有多好"：哈希查属性、每次一条 list、装箱、放弃已知类型。'
  + '\n  「自带/clang」量的是另一件事：我们自带的那台后端离一个真优化编译器有多远'
  + '\n  （那一栏是 ADR-0045 那条腿的账，别与上一栏混）。');
process.exit(bad === 0 ? 0 : 1);

