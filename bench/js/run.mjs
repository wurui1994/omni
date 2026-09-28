#!/usr/bin/env node
// bench/js/run.mjs —— **JS 引擎那一轴的尺子**（ADR-0047）
//
// 一句话：同一份 `.js`，**node（V8）** 与 **我们这条 AOT 腿** 各跑一趟，报比值。
//
// 为什么非得有它：在这之前这一轴唯一的尺子是"重建整个编译器（1m13）再跑一份 asy"——
// 那量得动"总时间变没变"，量不动"属性查找这一层值多少"。要在形状/IC 这种结构改动上迭代，
// 尺子必须是**秒级**的。
//
// 三条自己定的规矩（都踩过才写下来的）：
//
//   1. **量二进制，不量 `omni run`**：后者含前端 + cc，而 node 空跑本身就 0.42s；
//      所以先 `omni build` 出二进制，再单独计时。构建时间另报一栏（它是"启动"那一轴的事）。
//   2. **`OMNI_OPT=2`**：`-O0` 那张榜会把"没被内联的 static inline"顶到前排
//      （ADR-0047 §10.2）。默认档是 `-O0`，所以这儿显式给。
//   3. **交错跑 + 各取最小值**：这台机器单次墙上时间抖 ±5%，比一刀优化的收益还大
//      （与 `bench/lua/ab.js` 同一条口径）。别用 bash 循环 + date 量 —— 那套白加 ~34ms。
//
// 每份程序自己印一个校验和：**答案不同的那一栏不许上榜**（"快了 9.25 倍"因为算错了，
// 那种事发生过）。
//
// 用法：
//   node bench/js/run.mjs                 # 全部
//   node bench/js/run.mjs prop-mono       # 只跑名字里含这串的
//   N=5 node bench/js/run.mjs             # 每栏跑几趟（默认 3）

import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const WORK = join(ROOT, '.omni-cache', 'work', 'benchjs');
const N = Number(process.env.N || 3);
const filter = process.argv[2] ?? '';

const progs = readdirSync(join(HERE, 'progs')).filter((f) => f.endsWith('.js'))
  .map((f) => f.slice(0, -3)).filter((p) => p.includes(filter)).sort();
if (progs.length === 0) { console.log('没有匹配的程序'); process.exit(1); }
mkdirSync(WORK, { recursive: true });

/** 跑一趟，回 `{ ms, out }`。**stdout 收下来** —— 校验和要对。 */
function once(cmd, args) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 300000 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, out: (r.stdout ?? '').trim(), code: r.status };
}

const rows = [];
for (const p of progs) {
  const src = join(HERE, 'progs', `${p}.js`);
  const bin = join(WORK, p);
  /* 构建那一趟也计时 —— 它就是 ADR-0045 §5 第三栏（启动 ms）的一半。 */
  const t0 = process.hrtime.bigint();
  const b = spawnSync('node', [join(ROOT, 'src/cli.js'), 'build', src, '-o', bin],
    { encoding: 'utf8', env: { ...process.env, OMNI_OPT: '2' }, timeout: 300000 });
  const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;
  if (b.status !== 0 || !existsSync(bin)) {
    rows.push({ p, err: (b.stderr ?? '').trim().split('\n').slice(-2).join(' ').slice(0, 160) });
    continue;
  }
  /* 交错：node 一趟、我们一趟、node 一趟…… 各取最小。 */
  let bv = Infinity;
  let bo = Infinity;
  let outV = null;
  let outO = null;
  for (let i = 0; i < N; i++) {
    const v = once('node', [src]);
    if (v.ms < bv) bv = v.ms;
    outV = v.out;
    const o = once(bin, []);
    if (o.ms < bo) bo = o.ms;
    outO = o.out;
  }
  rows.push({ p, v: bv, o: bo, buildMs, same: outV === outO, want: outV, got: outO });
}

const f = (x) => (x === undefined ? '—' : x.toFixed(0).padStart(6));
console.log('\nJS 引擎那一轴（同一份 .js，min of '
  + `${N}，我们这条腿是 AOT + OMNI_OPT=2 的二进制）\n`);
console.log('  程序            node(V8)     我们     倍数   构建   答案');
let bad = 0;
for (const r of rows) {
  if (r.err !== undefined) { bad++; console.log(`  ${r.p.padEnd(14)} 建不出来：${r.err}`); continue; }
  const ratio = (r.o / r.v).toFixed(1).padStart(6);
  const ok = r.same ? '一样' : `**不一样**（想要 ${r.want}，量到 ${r.got}）`;
  if (!r.same) bad++;
  console.log(`  ${r.p.padEnd(14)}${f(r.v)}ms ${f(r.o)}ms ${ratio}x ${f(r.buildMs)}ms  ${ok}`);
}
console.log('\n  「倍数」= 我们 / node。**这一栏是这一轴的判据** —— 目标是靠近 1，'
  + '\n  而它现在的大小说明的是结构问题（哈希查属性、每次一条 list、装箱），不是"发码方式"。');
process.exit(bad === 0 ? 0 : 1);
