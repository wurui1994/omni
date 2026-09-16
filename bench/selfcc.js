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
//   20 份运行时：.text 我们 551488 / tcc 310616 = 1.78x   （第一百四十二到一百四十五片
//     那四刀之前是 880624 / 2.85x）
//   进程内编那 20 份：冷 613ms、热 469ms   ——   tcc（20 个进程）217ms
//   一趟一个进程：我们 3.7s / tcc 217ms = 17x  ← **这一栏不是编译速度**
//
// 中间那一栏才是编译速度：**冷 2.8x、热 2.2x**。最后那一栏里 20 × ~180ms 是 node + CLI
// 的起步（占了七成），tcc 那侧起步 ~2ms —— 先前只量了它，于是把差距夸大了六七倍。
// `buildSelf` 是**在一个进程里**连着编的，所以中间那一栏才是它的口径。
//
// 压过三轮（第一百三十九片，每一步都用「进程内、反复取最快」判，改完 `tests/c` 297/0）：
//   572ms -> 376ms（**-34%**）。前五处在词法/预处理，第六处在 native 那一步：
//     - 标识符按段 `slice`，不再一个字符一次 `+=`（C 源码里绝大多数记号是标识符）
//     - `peekc()` 不再无条件叫 `splice()`：先看一眼是不是反斜杠
//     - `preprocessSkip` 行中那一跳换成正则（`/[\n"'/\\]/g` + `lastIndex`）——
//       `#` 不在行首就不是指令，所以行中连它都不用停；缩进单独一小段循环
//     - `host/path.js` 的 `join` 加快路：老路一次要走六趟数组操作，而 include 的搜索
//       每试一个目录就 join 一次（7220 组输入与老路逐字符比过，0 组不同）
//     - `lang/c.js` 读过的文件按路径记一份（按 mtime 复核）
//     - `lowerCNative` 的暂存区从 `Map<偏移, 字节>`（**一个字节一格**）换成两条
//       `Uint8Array` —— 摆一张 300KB 的静态表从前是 30 万次 `Map.set`，占前端 CPU 7.2%
//   试过没留的：照 tcc 的 `isidnum_table` 换 Uint8Array 查表 —— 462ms vs 441ms，没更快。
//
// 大档（整份编译器那一份 14.4M 的 C，一个翻译单元）`c obj` **5.56s -> 4.74s**，出 65M 的 `.o`。
// 那一档里预处理占得少、`tccgen` 占得多，所以这几刀在它身上只有一成半的效果。
//
// 也就是：**代码大 2.85 倍、编译慢 2 倍上下**。剩下的大头是 `tokAlloc`（3.6%）、GC（4.8%）、
// include 探测的 stat（4.2%）—— 每一格都只值两三个百分点，而它们都在最热的那几行上。

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
 * 我们这一侧**在一个进程里**编那 20 份 —— `buildSelf` 就是这么用的（`cObj` 在进程内叫）。
 *
 * 这一格是**对前一版量法的修正**：先前 `--rt` 每份文件起一个 `node src/cli.js c obj`，
 * 于是 20 趟里有 20 × ~180ms 是 node + CLI 的起步 —— 占了量出来的 5.0s 的**七成**，
 * 把「我们比 tcc 慢多少」夸大了四五倍。tcc 那一侧起步只有 ~2ms，摆在一起不可比。
 *
 * 冷 = 头一遍（真实的一次构建就是这个），热 = 反复取最快（改一处快没快看它，噪声小）。
 * 只到 MIR + 机器码为止，不写 `.o`（写盘那一步两边都是 memcpy 级）。
 */
async function rtInProcess(reps) {
  if (ARCH !== 'arm64') {
    process.stdout.write('  skip  进程内那一格只接了 arm64（x86_64 换 x64/from_mir 的 genModule）\n');
    return;
  }
  const RT = join(root, 'src', 'runtime');
  const files = readdirSync(RT).filter((x) => x.endsWith('.c')).sort();
  const { cMirNative, cSysInclude } = await import('../src/core/lang/c.js');
  const { genArm64Module } = await import('../src/core/arm64/from_mir.js');
  const { verifyMir } = await import('../src/core/mir/verify.js');
  const sys = cSysInclude();
  let cold = 0;
  let best = Infinity;
  for (let r = 0; r < reps; r++) {
    const t0 = process.hrtime.bigint();
    for (const f of files) {
      const { mod } = cMirNative(join(RT, f),
        { includeDirs: [RT], sysIncludeDirs: sys, arch: 'arm64', os: OS }, []);
      verifyMir(mod);
      genArm64Module(mod);
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (r === 0) cold = ms;
    if (ms < best) best = ms;
  }
  process.stdout.write(`  进程内 ${files.length} 份：冷 ${fmtMs(cold)}、热 ${fmtMs(best)}`
    + `（反复 ${reps} 遍取最快）\n`);
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
  process.stdout.write(`  一趟一个进程：我们 ${fmtMs(ta)} / tcc ${fmtMs(tb)}（${(ta / tb).toFixed(0)}x）`
    + `　—— 我们这一侧每趟含 node + CLI 起步 ~180ms，所以这一栏**不是**编译速度\n`);
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
  await rtInProcess(5);
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
