#!/usr/bin/env node
// bench/r/run.js —— R 这条腿的**性能尺子**：我们的两条腿 vs 本机的 `Rscript`。
//
// 为什么要它：正确性有 `tests/r/oracle.js`（逐字节对 Rscript），但"值对不对"与"跑多快"
// 是两件事，而后者只能量。参考是**本机装的 R**（同一台机器、同一份 `.R`）—— 它只当尺子，
// 运行时一格都不借（我们那条路上没有 libR，见 ext/r/SPEC.md 第二节）。
//
// 四列：
//   Rscript   R 自己（4.x 带字节码编译器，所以这不是"解释器裸跑"）
//   JS        我们 `--backend js` 出来的独立 `.js`，用 node 跑（`ccall` 走 N-API 扩展）
//   原生      我们 `build` 出来的二进制（自带后端，默认 -O0）
//   clang     **同一份发出来的 C** 交给 `clang -O2`
//
// 第四列把差分成两段（与 bench/go/run.js 同一条）：`clang → 原生` 那一段是**我们自己后端的
// 发码**，`Rscript → clang` 那一段是**我们发出来的 C 的形状**（前端 / 向量那一层 / 方言那一路）。
// 没有它就只能猜该改哪头 —— 量过一次就知道：`vec.R` 上 clang 160ms、原生 1022ms、R 221ms，
// 也就是形状已经比 R 快，欠的全在后端那一档。
//
// **编译时间不算在里头** —— 每列都只量"跑一趟"的墙上时间（R 那列含它自己的启动）。
// 编译一次的开销单独印一行，别混进来。
//
// 先比答案再比时间：一把不验答案的性能尺子会把"算错了所以快"报成进步
// （bench/go/run.js 上这条是量出来的）。
//
// 用法：node bench/r/run.js [次数]   —— 交错跑、各取最小（这台机器单次抖 ±40%）

import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(root, '.omni-cache', 'r-bench');
mkdirSync(out, { recursive: true });
const N = Number(process.argv[2] || 3);

const have = (cmd) => spawnSync('which', [cmd], { encoding: 'utf8' }).status === 0;
if (!have('Rscript')) {
  process.stdout.write('bench/r：本机没有 Rscript —— 这把尺子的参考列就没了，整趟跳过\n');
  process.exit(0);
}

const omni = (args, env) => execFileSync('node', [join(root, 'src', 'cli.js'), ...args],
  { cwd: root, stdio: 'pipe', timeout: 600000, env: { ...process.env, ...env } });

/**
 * `--backend js` 出来的独立 `.js` 里没有那份 N-API 扩展（ADR-0038 说的"编到文件"那一档），
 * 路径走 `OMNI_FFI_ADDON`。而那份扩展是**按模块里 `(cabi …)` 的那一组**做内容哈希的，
 * 缓存路径算不出来、也没有一条命令把它印出来。
 *
 * 所以这儿的办法是**试**：先 `OMNI_FFI=cc omni run` 一趟把它造出来，然后拿 `.omni-cache/ffi`
 * 下的每一份去跑，挑**答案对得上**的那一份。这不优雅，但它自带验证 —— 挑错了会被答案那一关挡住，
 * 而不是悄悄量了一份跑不动的东西。
 */
function pickAddon(src, js, want) {
  try {
    omni(['run', src], { OMNI_FFI: 'cc' });
  } catch { /* 这一格跑不过的话下面那圈也会空手而归，报法在调用处 */ }
  const dir = join(root, '.omni-cache', 'ffi');
  for (const d of readdirSync(dir)) {
    const p = join(dir, d, 'omni_ffi.node');
    try {
      statSync(p);
    } catch {
      continue;
    }
    const r = spawnSync(process.execPath, [js], { encoding: 'utf8', timeout: 600000, env: { ...process.env, OMNI_FFI_ADDON: p } });
    if ((r.status ?? 1) === 0 && (r.stdout ?? '') === want) return p;
  }
  return null;
}

/**
 * 量时间那一趟**不接管道**（`stdio: 'ignore'`）。
 *
 * 这条是量出来的，不是讲究：同一份二进制（`bench/r/one.R`，开一格 1M 的向量），
 * `spawnSync` 捕获 stdout 时 node 那侧看到 **1029ms**，`stdio: 'ignore'` 是 **87ms**，
 * 而把 `/usr/bin/time -p` 套在中间时子进程自己报的是 **0.06s**。
 * 也就是那 ~950ms 是**父进程读管道那一侧的开销**，不是被量的程序的时间。
 * 所以答案与时间分两趟拿（`bench/go/run.js` 里那两个函数分开也是这个道理）。
 */
const wall = (cmd, args, env) => {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 600000, env: { ...process.env, ...env } });
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, code: r.status ?? 1 };
};

/** 拿答案那一趟：接管道、不计时。 */
const say = (cmd, args, env) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 600000, env: { ...process.env, ...env } });
  return { out: (r.stdout ?? '') + (r.stderr ?? ''), code: r.status ?? 1 };
};

const files = readdirSync(here).filter((f) => f.endsWith('.R')).sort();
const rows = [];
for (const f of files) {
  const src = join(here, f);
  const stem = f.slice(0, -2);
  const js = join(out, `${stem}.js`);
  const bin = join(out, `${stem}.bin`);
  const cl = join(out, `${stem}.clang`);
  let cJs = 0;
  let cNat = 0;
  try {
    let t0 = process.hrtime.bigint();
    omni(['build', src, '--backend', 'js', '-o', js], { OMNI_FFI: 'cc' });
    cJs = Number(process.hrtime.bigint() - t0) / 1e6;
    t0 = process.hrtime.bigint();
    omni(['build', src, '-o', bin], { OMNI_MIR_OPT: '1' });
    cNat = Number(process.hrtime.bigint() - t0) / 1e6;
    omni(['build', src, '-o', cl, '--cc', 'clang'], { OMNI_OPT: '2' });
  } catch (e) {
    const all = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`;
    process.stdout.write(`${f.padEnd(10)} 编不出来：${String(all.split('\n').filter((x) => x.trim()).pop()).slice(0, 96)}\n`);
    continue;
  }
  /* 参考列先跑一趟：它给答案，也给下面挑扩展用的那把尺子。 */
  const ref = say('Rscript', ['--vanilla', src]);
  if (ref.code !== 0) {
    process.stdout.write(`${f.padEnd(10)} Rscript 自己就没跑过：${ref.out.split('\n')[0]}\n`);
    continue;
  }
  const addon = pickAddon(src, js, ref.out);
  if (addon === null) {
    process.stdout.write(`${f.padEnd(10)} JS 那条腿跑不起来（没挑到对得上的 N-API 扩展）—— 这一行只量另外几列\n`);
  }
  const env = { OMNI_FFI_ADDON: addon ?? '' };
  const legs = [
    { who: 'Rscript', cmd: 'Rscript', args: ['--vanilla', src], env: {} },
    { who: 'JS', cmd: process.execPath, args: [js], env },
    { who: '原生', cmd: bin, args: [], env: {} },
    { who: 'clang', cmd: cl, args: [], env: {} },
  ].filter((l) => !(l.who === 'JS' && addon === null));
  /* **先比答案**：每一列的 stdout 都要与 Rscript 一模一样，不一样就报出来、这一行不算时间。
     一把不验答案的性能尺子会把"算错了所以快"报成进步。 */
  let bad = null;
  for (const l of legs) {
    const r = say(l.cmd, l.args, l.env);
    if (r.code !== 0) bad = bad ?? `${l.who} 没跑过（退出码 ${r.code}）：${r.out.split('\n')[0]}`;
    else if (r.out !== ref.out) bad = bad ?? `${l.who} 答的不一样：想要 ${JSON.stringify(ref.out.trim())}，得到 ${JSON.stringify(r.out.trim())}`;
  }
  if (bad !== null) {
    process.stdout.write(`${f.padEnd(10)} ${bad}\n`);
    continue;
  }
  const best = legs.map(() => Infinity);
  for (let k = 0; k < N; k += 1) {
    legs.forEach((l, i) => {
      const r = wall(l.cmd, l.args, l.env);
      if (r.ms < best[i]) best[i] = r.ms;
    });
  }
  const by = {};
  legs.forEach((l, i) => { by[l.who] = best[i]; });
  rows.push({
    f, want: ref.out.trim(), rs: by.Rscript, js: by.JS ?? null, nat: by['原生'], cl: by.clang, cJs, cNat,
  });
}

const pad = (s, n) => String(s).padStart(n);
const fx = (x) => (x >= 10 ? x.toFixed(0) : x.toFixed(2));
process.stdout.write('\n');
process.stdout.write(`${'程序'.padEnd(11)}${pad('Rscript', 9)}${pad('JS', 9)}${pad('原生', 9)}${pad('clang', 9)}  `
  + `${pad('JS×', 7)}${pad('原生×', 8)}${pad('clang×', 9)}  答案\n`);
for (const r of rows) {
  process.stdout.write(`${r.f.padEnd(11)}${pad(fx(r.rs), 9)}${pad(r.js === null ? '—' : fx(r.js), 9)}`
    + `${pad(fx(r.nat), 9)}${pad(fx(r.cl), 9)}  `
    + `${pad(r.js === null ? '—' : `${(r.rs / r.js).toFixed(2)}x`, 7)}`
    + `${pad(`${(r.rs / r.nat).toFixed(2)}x`, 8)}${pad(`${(r.rs / r.cl).toFixed(2)}x`, 9)}  ${r.want}\n`);
}
process.stdout.write(`\n毫秒，各列取 ${N} 趟里的最小值；`
  + '`×` 那几列是"比 Rscript 快多少倍"（>1 是我们快）。每一列的 stdout 都验过与 Rscript 一模一样。\n');
process.stdout.write('编一次的开销（不算在上表里）：'
  + `${rows.map((r) => `${r.f} js ${r.cJs.toFixed(0)}ms / 原生 ${r.cNat.toFixed(0)}ms`).join('；')}\n`);
