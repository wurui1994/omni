// tests/glsl/fast.js —— 快路的**对账门**（ADR-0019 决策六，开工单第 4 步的前一半）
//
// 「对账门先立、下限门后立」—— 顺序反了就会为了数字牺牲正确性。所以这一门只查一件事：
//
//   **快路（8 道 f32 -> LLVM IR -> clang）与参照实现（标量摊分量 -> 核心方言 -> JS 腿）
//   在同样的取样点上算出同样的四个通道。**
//
// 容差：相对 `1e-5`。两边的算术**本来就不同精度**（f32 对 f64），所以逐字节相同是错的
// 期望；`1e-5` 是 f32 的有效位数（约 7 位十进制）留一位余量。
//
// 顺带印一行 MPix/s（1024²）—— 这是数，不是断言。下限门等第 3 步（框架那一半）做完再立。
//
//   node tests/glsl/fast.js

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { readSexpr } from '../../src/core/sexpr/read.js';
import { readGrammar } from '../../src/core/glr/grammar.js';
import { buildTable } from '../../src/core/glr/table.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { glslCheck } from '../../src/core/frontend-glsl/check.js';
import { glslLower } from '../../src/core/frontend-glsl/lower.js';
import { glslEmitLlvm } from '../../src/core/frontend-glsl/emit_llvm.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const GRAMMAR = join(root, 'src', 'core', 'frontend-glsl', 'glsl.grammar');
const CASES = join(here, 'cases');
const DRIVER = join(here, 'fast_driver.c');
const OUT = join(tmpdir(), 'omni-glsl-fast');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

/** 与 `fast_driver.c` 里那两行**一字不差**的取样点。 */
const SX = [0.5, 511.5, 0.5, 511.5, 100.5, 1023.5, 37.5, 700.5];
const SY = [0.5, 0.5, 511.5, 511.5, 200.5, 1023.5, 900.5, 13.5];
const RES = 1024;

const gdiags = new Diagnostics();
const g = readGrammar(readSexpr(new SourceFile(GRAMMAR, readFileSync(GRAMMAR, 'utf8')), gdiags), gdiags);
gdiags.throwIfErrors();
const tb = buildTable(g);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

function checked(path) {
  const src = readFileSync(path, 'utf8');
  const diags = new Diagnostics();
  const toks = lexText(g.lex, new SourceFile(path, src), diags);
  diags.throwIfErrors();
  const tree = glrParse(tb, toks, diags);
  diags.throwIfErrors();
  return glslCheck(tree, 'frag');
}

const mod = checked(join(CASES, 'bench-simple.frag'));

/* ---- 一、参照实现（标量 -> 核心方言 -> JS 腿）在取样点上的值 ---------------- */

const lib = glslLower(mod).trimEnd();
const driver = SX.map((x, i) => `    (let p${i} glsl_v4 (call glsl_frag (real ${x}) (real ${SY[i]}) (real ${RES}.0) (real ${RES}.0)))\n`
  + `    (print (fld (var p${i}) c0))\n    (print (fld (var p${i}) c1))\n`
  + `    (print (fld (var p${i}) c2))\n    (print (fld (var p${i}) c3))`).join('\n');
const sxPath = join(OUT, 'ref.sx');
writeFileSync(sxPath, `${lib.slice(0, -1)}\n  (main\n${driver})\n)\n`);
const refRun = spawnSync(process.execPath, [CLI, 'run', sxPath], { encoding: 'utf8', maxBuffer: 1 << 26 });
if (refRun.status !== 0) {
  bad('参照实现跑不动', `    ${(refRun.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
} else {
  ok('参照实现（标量 -> 方言 -> JS 腿）跑起来了');
}
const ref = (refRun.stdout ?? '').trim().split('\n').map(Number);

/* ---- 二、快路（8 道 f32 -> LLVM IR -> clang） ------------------------------- */

const llPath = join(OUT, 'frag.ll');
writeFileSync(llPath, glslEmitLlvm(mod));
const exe = join(OUT, 'fast');
const cc = process.env.OMNI_CLANG ?? 'clang';
/* 没有 clang 就**跳过整门**（`OMNI_CLANG` 可指一个）。快路本来就是 LLVM 那条路，
 * 没有 clang 谈不上 —— 但那不该让别的门连带红。 */
if (spawnSync(cc, ['--version'], { encoding: 'utf8' }).status !== 0) {
  process.stdout.write(`  skip 没有 ${cc}（快路要它；OMNI_CLANG 可指一个）\n\n0 passed, 0 failed\n`);
  process.exit(0);
}
const build = spawnSync(cc, ['-O2', '-w', DRIVER, llPath, '-lm', '-o', exe], { encoding: 'utf8' });
if (build.status !== 0) {
  bad('快路编不过', `    ${(build.stderr ?? '').trim().split('\n').slice(0, 6).join('\n    ')}`);
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(1);
}
ok('快路编出来了（emit_llvm -> clang -O2）');

const sam = spawnSync(exe, ['samples', String(RES)], { encoding: 'utf8' });
if (sam.status !== 0) {
  bad('快路跑不动', `    ${(sam.stderr ?? '').trim().slice(0, 200)}`);
} else {
  const got = sam.stdout.trim().split('\n').flatMap((l) => l.trim().split(/\s+/).map(Number));
  if (ref.length !== got.length) {
    bad('两边的数不一样多', `    参照 ${ref.length} 个、快路 ${got.length} 个`);
  } else {
    const bads = [];
    for (let i = 0; i < ref.length; i++) {
      const a = ref[i];
      const b = got[i];
      const rel = Math.abs(a - b) / Math.max(1e-6, Math.abs(a));
      if (!(rel <= 1e-5)) bads.push(`第 ${i} 个（像素 ${Math.floor(i / 4)} 通道 ${i % 4}）：参照 ${a}、快路 ${b}（相对差 ${rel.toExponential(2)}）`);
    }
    if (bads.length > 0) bad('逐取样点对账', bads.slice(0, 6).map((s) => `    ${s}`).join('\n'));
    else ok(`逐取样点对账：8 个像素 × 4 通道，相对差都 ≤ 1e-5`);
  }
}

/* ---- 三、下限门（决策六：没有下限的性能表只是记录，不是验收） ------------------
 *
 * `100` 是这么来的：同一类算术、同一台机、`clang -O2` 手写 8 道 f32 量到的天花板是
 * 178 MPix/s（`soa_ceiling.c`），留 40% 余量。llvmpipe 单核 Simple 是 160～315，
 * 所以这一档只是「进了同一个量级」，不是终点。
 *
 * **这道门是在对账门绿了之后才立的**（开工单第 4 步那句话）：反过来的话，
 * 输出全 0 那一版会以 277 MPix/s 通过 —— 那一版 clang 把大半计算删了。 */
const FLOOR = Number(process.env.OMNI_GLSL_FLOOR ?? 100);
const bench = spawnSync(exe, ['bench', String(RES), '3'], { encoding: 'utf8' });
if (bench.status === 0) {
  const mp = /MPix\/s (\S+)/.exec(bench.stdout);
  const ms = /ms (\S+)/.exec(bench.stdout);
  const got = mp === null ? 0 : Number(mp[1]);
  const line = `快路 ${RES}²：${ms === null ? '?' : ms[1]} ms、${got} MPix/s`;
  if (got >= FLOOR) ok(`${line} ≥ 下限 ${FLOOR}（天花板 178；参照实现那条路的框架上限是 32.77）`);
  else {
    bad(`${line} < 下限 ${FLOOR}`,
      '    快路的意义就是这个数。低于下限说明形状还不对 —— 别调下限，去查形状\n'
      + '    （ADR-0019 决策六：着色器那一半 SoA、框架那一半每 quad 一个掩码）。');
  }
} else {
  bad('快路的 bench 跑不动', `    ${(bench.stderr ?? '').trim().slice(0, 200)}`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
