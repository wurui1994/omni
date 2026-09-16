#!/usr/bin/env node
// 同一份**生成的 C**，三台编译器：我们自己那台（`OMNI_CC=self`：`omni c obj` + `omni c link`）、
// 真编出来的 tcc（`.omni-cache/tcc-build/tcc`）、clang。
//
// 两个问题各有一格答案，都不许用印象答：
//
//   1. **一致吗** —— 两边的二进制逐字节比。答案是**不一致**，而且本来就不该一致：
//      我们与 tcc 只在**ABI**上对齐（AAPCS64 / SysV 那套是照 `arm64-gen.c` 抄的），
//      寄存器分配、栈帧、指令选择是各自的。arm64 上还要排除签名那一段（`LC_CODE_SIGNATURE`：
//      两边都不自己签，tcc 也是 `system("codesign -f -s -")`，所以**默认产物里根本没有那一段** ——
//      这一格 `stripSig` 留着是为了「签过之后再来比」时不至于把签名当差异）。
//      所以这条尺子量的是**差多少**：`.text` 各多大、第一处差在哪儿、产物差几倍。
//   2. **慢多少** —— 同一份 C，从 `.c` 到可执行文件各花多久。
//
// 三台都是「同一份 C」：C 是 `emit c` 出的，与 cc 无关（我们只换 `OMNI_CC`）。
// 所以 `gen` 那一栏三行相同，`cc` 那一栏才是被量的东西。
//
// **大档量到一件事，记在这儿**：整份编译器那份 C（14.4M / 272588 行），**真 tcc 编不过**：
//
//   omni-tcc.c:177955: error: memory full (vstack)
//
// 那一行是 `g_JS_ABI = omni_js_obj_setk(omni_js_obj_setk(…))`，89055 字节一句、
// 括号嵌 333 层、1466 次 setk —— tcc 的 `vstack` 是 256 格（`tcc.h` 的 `VSTACK_SIZE`），
// 一个表达式套这么深就满了。我们自己那台 C 前端没有这个上限，编得过。
// 值得记一笔的是 `findCC()` 把 tcc 排在**第一**：本机装了 tcc 的人跑 `build:native`
// 就撞这一格。要治得治在**发射的那一头**（对象字面量摊成语句而不是套成一句），
// 那是 backend-c 的一刀，不在这条尺子里。
//
//   node bench/selfcc.js            # 小档（bench/fib.omni）
//   node bench/selfcc.js --whole    # 大档（src/cli.js，14MB 的 C；分钟级）
//   node bench/selfcc.js --rt       # 运行时那 20 份 .c：只编 `.o`，比 `.text` 与耗时
//
// `--rt` 那一档是**同一份输入、同一种产物**（ELF 可重定位 `.o`）下最干净的一把尺子 ——
// 不掺链接、不掺 node 启动之外的东西。量到的（arm64 macOS）：
//
//   20 份运行时：.text 我们 880624 / tcc 308556 = 2.85x
//   编译耗时：我们 5.0s / tcc 257ms = 20x（其中我们每趟含 node + CLI 起步 ~180ms，
//             所以拿最大的那份单独量：omni_r3.c 我们 0.37s / tcc 0.01s，扣掉起步还是 ~19x）
//
// 也就是：**代码大 2.85 倍、编译慢 20 倍上下**。慢的那一头有确定的来源（JS、每函数一趟
// MIR、没有寄存器分配的启发式），要不要治是另一件事 —— 先把数摆在这儿。

import { spawnSync } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs';
import { readObject } from '../src/core/link/elf.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const TCC = join(root, '.omni-cache', 'tcc-build', 'tcc');
const WORK = join(root, '.omni-cache', 'selfcc');
const whole = process.argv.includes('--whole');
const rt = process.argv.includes('--rt');
const SRC = whole ? join(root, 'src', 'cli.js') : join(root, 'bench', 'fib.omni');
/** 这把尺子只在**本机**上量（`--rt` 那一档要两台编同一个目标）。 */
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x86_64';
const OS = process.platform === 'darwin' ? 'osx' : process.platform === 'win32' ? 'win32' : 'linux';

const fmtB = (n) => (n < 1024 ? `${n}B`
  : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)}K` : `${(n / 1048576).toFixed(1)}M`);
const fmtMs = (ms) => (ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(1)}s`);
const size = (p) => (existsSync(p) ? statSync(p).size : 0);

/** 一份 ELF `.o` 里 `.text` 有多少字节（两边的 `.o` 都是 ELF，这一栏可比）。 */
function textBytes(p) {
  const s = readObject(readFileSync(p), p).secs.find((x) => x.name === '.text');
  return s === undefined || s.bytes === undefined ? 0 : s.bytes.length;
}

/**
 * `--rt`：运行时那 20 份 `.c`，两台各编一遍 `.o`，比 `.text` 与耗时。
 * 只到 `.o` 为止 —— 链接是另一码事，掺进来这把尺子就不干净了。
 */
function rtBench() {
  const RT = join(root, 'src', 'runtime');
  mkdirSync(WORK, { recursive: true });
  let a = 0;
  let b = 0;
  let ta = 0;
  let tb = 0;
  let n = 0;
  for (const f of readdirSync(RT).filter((x) => x.endsWith('.c')).sort()) {
    const oa = join(WORK, `${f}-ours.o`);
    const ob = join(WORK, `${f}-tcc.o`);
    let t0 = process.hrtime.bigint();
    const r1 = spawnSync(process.execPath, [CLI, 'c', 'obj', join(RT, f), '-o', oa,
      '--arch', ARCH, '--os', OS, '-f', 'elf', '-I', RT], { encoding: 'utf8' });
    ta += Number(process.hrtime.bigint() - t0) / 1e6;
    t0 = process.hrtime.bigint();
    const r2 = spawnSync(TCC, ['-B', dirname(TCC), '-c', join(RT, f), '-o', ob, '-I', RT],
      { encoding: 'utf8' });
    tb += Number(process.hrtime.bigint() - t0) / 1e6;
    if (r1.status !== 0 || r2.status !== 0) {
      process.stdout.write(`  skip  ${f}（我们 ${r1.status} / tcc ${r2.status}）\n`);
      continue;
    }
    const x = textBytes(oa);
    const y = textBytes(ob);
    a += x;
    b += y;
    n += 1;
    if (y > 0 && x / y >= 4) {
      process.stdout.write(`  ${f.padEnd(18)} .text 我们 ${x} / tcc ${y}`
        + `  ${(x / y).toFixed(2)}x\n`);
    }
  }
  process.stdout.write(`  ${n} 份运行时：.text 我们 ${a} / tcc ${b}（${(a / b).toFixed(2)}x）\n`);
  process.stdout.write(`  编译耗时：我们 ${fmtMs(ta)} / tcc ${fmtMs(tb)}（${(ta / tb).toFixed(0)}x）`
    + `　—— 我们这一侧每趟含 node + CLI 起步 ~180ms\n`);
}

/**
 * Mach-O 的签名那一段（`LC_CODE_SIGNATURE`，cmd 0x1d）在文件末尾，`dataoff` 起。
 * 有就切到 `dataoff` 为止，没有就原样 —— 「排除签名部分」这句话的实现。
 */
function stripSig(bytes) {
  if (bytes.length < 32) return bytes;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (dv.getUint32(0, true) !== 0xfeedfacf) return bytes;
  const ncmds = dv.getUint32(16, true);
  let off = 32;
  for (let i = 0; i < ncmds && off + 8 <= bytes.length; i += 1) {
    const cmd = dv.getUint32(off, true);
    const sz = dv.getUint32(off + 4, true);
    if (cmd === 0x1d) return bytes.subarray(0, dv.getUint32(off + 8, true));
    if (sz === 0) break;
    off += sz;
  }
  return bytes;
}

/** 两份字节的第一处差异（`-1` 是相同）。 */
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

if (rt) {
  if (!existsSync(TCC)) {
    process.stdout.write(`  skip  --rt 要那份参考 tcc（${TCC} 不在）\n`);
    process.exit(0);
  }
  process.stdout.write('bench/selfcc --rt：运行时那 20 份 .c，我们与 tcc 各编一遍 .o\n');
  rtBench();
  process.exit(0);
}

const runs = [  { name: '我们（self）', cc: 'self' },
  { name: 'tcc（真的）', cc: TCC },
  { name: 'clang', cc: 'clang' },
];

if (!existsSync(TCC)) {
  process.stdout.write(`  skip  tcc  （${TCC} 不在 —— 先把参考 tcc 编出来）\n`);
  runs.splice(1, 1);
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

process.stdout.write(`bench/selfcc：${basename(SRC)}  同一份生成的 C，${runs.length} 台编译器\n`);

/** `omni: built … + cc  8.6s  via …` 里那一段 —— 只有 cc 那一步是被量的东西。 */
function ccMs(err) {
  const m = /\+ cc\s+([\d.]+)(ms|s)\b/.exec(err ?? '');
  if (m === null) return null;
  return m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1]);
}

const got = [];
for (const r of runs) {
  const out = join(WORK, `omni-${r.cc === 'self' ? 'self' : basename(r.cc)}`);
  const t0 = process.hrtime.bigint();
  const p = spawnSync(process.execPath, [CLI, 'build', SRC, '-o', out, '--work', `${out}.d`],
    { encoding: 'utf8', cwd: root, env: { ...process.env, OMNI_CC: r.cc } });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (p.status !== 0) {
    process.stdout.write(`  FAIL  ${r.name}  exit ${p.status}\n${(p.stderr ?? '').slice(-800)}\n`);
    continue;
  }
  /* 跑一下 —— 「一致」的第一层是**行为**一致（字节不一致不等于结果不一致）。 */
  const e = spawnSync(out, [], { encoding: 'utf8' });
  /* 名字不能叫 `cc` —— `...r` 里的 `cc` 是**那台编译器**，重名会把它盖成一个毫秒数
   * （踩过：下面 `g.cc === TCC` 于是永远不成立，两行对账整段不印，还没有任何报错）。 */
  const ccT = ccMs(p.stderr);
  got.push({ ...r, out, ms, ccT, exit: e.status, stdout: e.stdout ?? '' });
  process.stdout.write(`  ${r.name.padEnd(14)} 整趟 ${fmtMs(ms).padStart(7)}`
    + `  其中 cc ${(ccT === null ? '?' : fmtMs(ccT)).padStart(7)}`
    + `  产物 ${fmtB(size(out)).padStart(6)}  exit=${e.status}\n`);
}

let bad = false;
if (got.length > 1) {
  const ref = got[0];
  for (const g of got.slice(1)) {
    if (g.stdout !== ref.stdout || g.exit !== ref.exit) {
      process.stdout.write(`  FAIL  ${g.name} 的输出与 ${ref.name} 不同\n`);
      bad = true;
    }
  }
  process.stdout.write(`  输出一致：${bad ? '否' : '是'}（${got.length} 台，逐字节）\n`);

  const self = got.find((g) => g.cc === 'self');
  const tcc = got.find((g) => g.cc === TCC);
  if (self !== undefined && tcc !== undefined) {
    const a = stripSig(readFileSync(self.out));
    const b = stripSig(readFileSync(tcc.out));
    const d = firstDiff(a, b);
    process.stdout.write(`  字节一致（排签名）：${d < 0 ? '是' : `否 —— 第一处差在 0x${d.toString(16)}`}`
      + `，我们 ${fmtB(a.length)} / tcc ${fmtB(b.length)}`
      + `（${(a.length / b.length).toFixed(2)}x）\n`);
    process.stdout.write(`  慢多少：整趟 我们 ${fmtMs(self.ms)} / tcc ${fmtMs(tcc.ms)}`
      + `（${(self.ms / tcc.ms).toFixed(1)}x）`
      + `${self.ccT === null || tcc.ccT === null ? ''
        : `，只算 cc 那一步 ${fmtMs(self.ccT)} / ${fmtMs(tcc.ccT)}`
          + `（${(self.ccT / tcc.ccT).toFixed(1)}x）`}\n`);
  }
}

process.exit(bad ? 1 : 0);
