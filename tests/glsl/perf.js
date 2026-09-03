// tests/glsl/perf.js —— 性能对照（ADR-0019 第一刀第十三片）
//
// **这不是门**（不判快慢，写死毫秒数只会在别的机器上骗人）。它是一支**可重复的尺**：
// 印一张表，数进 ADR-0019。默认不进 `tests/glsl/run.js`（跑起来要几秒）。
//
// ## 怎么把「进程启动 + 编译」摊出去
//
// 我们这一侧一趟 `omni run` 包含 node 启动、方言降级、（C 腿还有 clang 编译）。
// 那些是**固定开销**，与画多少像素无关。办法是**两趟差值**：
//
//   t(2N 帧) - t(N 帧) = N 帧的净渲染时间
//
// 固定开销在两趟里一样，减掉就没了。这比「跑一趟然后猜编译占多少」诚实。
//
// GL 那一侧照 `benchmark.py` 的口径（warmup 一帧 + N 帧，**每帧含 `fbo.read()`**），
// 由 `gl_bench.py` 量。
//
//   node tests/glsl/perf.js            默认 128 与 256 两档
//   node tests/glsl/perf.js 128 256 512

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
import { glslBenchProgram } from '../../src/core/frontend-glsl/lower.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const GRAMMAR = join(root, 'src', 'core', 'frontend-glsl', 'glsl.grammar');
const CASES = join(here, 'cases');
const GLB = join(here, 'gl_bench.py');
const OUT = join(tmpdir(), 'omni-glsl-perf');

const SIZES = process.argv.slice(2).map(Number).filter((n) => n > 0);
const sizes = SIZES.length > 0 ? SIZES : [128, 256];

const gdiags = new Diagnostics();
const g = readGrammar(readSexpr(new SourceFile(GRAMMAR, readFileSync(GRAMMAR, 'utf8')), gdiags), gdiags);
gdiags.throwIfErrors();
const tb = buildTable(g);

function check(path, stage) {
  const diags = new Diagnostics();
  const toks = lexText(g.lex, new SourceFile(path, readFileSync(path, 'utf8')), diags);
  diags.throwIfErrors();
  const tree = glrParse(tb, toks, diags);
  diags.throwIfErrors();
  return glslCheck(tree, stage);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/** 跑 `reps` 趟取**最小**毫秒。
 *
 * 为什么取最小而不是平均：噪声是**单向**的（别的进程、GC、频率调节只会让某一趟变慢，
 * 不会让它变快），所以最小值最接近「没被打扰时的那一趟」。取平均会把噪声算进斜率 ——
 * 第十三片那处「超线性」就是这么来的（见 ADR-0019 第十四片）。 */
function runMs(path, args, reps = 3) {
  let best = null;
  let out = null;
  for (let i = 0; i < reps; i++) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [CLI, 'run', path, ...args],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (r.status !== 0) return null;
    const ms = Date.now() - t0;
    if (best === null || ms < best) best = ms;
    out = r.stdout.trim();
  }
  return { ms: best, out };
}

/** 两趟差值：回「一帧多少毫秒」。 */
function frameMs(mod, w, h, uni, backend, n) {
  const p1 = join(OUT, `b${n}.sx`);
  const p2 = join(OUT, `b${n * 2}.sx`);
  writeFileSync(p1, glslBenchProgram(mod, w, h, uni, n));
  writeFileSync(p2, glslBenchProgram(mod, w, h, uni, n * 2));
  const a = runMs(p1, backend);
  const b = runMs(p2, backend);
  if (a === null || b === null) return null;
  /* 校验和必须成倍数 —— 不然两趟画的不是同一件事，差值就没有意义。 */
  if (Number(b.out) !== Number(a.out) * 2) return null;
  return (b.ms - a.ms) / n;
}

/** 要量的那几份片元。`trivial` 那一份是**为了把框架开销单独量出来**：
 *
 * 它一行算术都没有，所以它的时间就是「扫画布 + 覆盖判定 + 插值 + 8 位量化 + 调用」——
 * 也就是**框架**。`bench-complex` 减掉它就是**着色器**那一半。
 * 这两个数决定下一步优化该投哪儿（分层加速省的是框架那一半，SoA 省的是两半）。 */
const FRAGS = ['trivial.frag', 'bench-complex.frag'];
const VERT = 'bench-vert.vert';

process.stdout.write('GLSL 性能对照\n');
process.stdout.write('口径：我们这一侧用「t(2N) - t(N)」把进程启动与编译摊掉、每趟取 3 次的最小值；'
  + 'GL 那一侧照 benchmark.py（每帧含 fbo.read()）\n\n');

for (const FRAG of FRAGS) {
  const fm = check(join(CASES, FRAG), 'frag');
  process.stdout.write(`  ${FRAG}\n`);
  process.stdout.write('  尺寸      我们(JS)                我们(C)                 真 GL\n');
  for (const s of sizes) {
    const uni = { u_resolution: [s, s] };
    const fixed = Number(process.env.OMNI_GLSL_N ?? '0');
    /* 帧数要让**净时间远大于固定开销的抖动**（进程启动几十毫秒，而 128² 一帧才十几毫秒）——
     * 第十三片那一版 128² 用 N=8 就不够，量出来的斜率是噪声（第十四片）。 */
    const n = fixed > 0 ? fixed : (s <= 128 ? 24 : s <= 256 ? 8 : 2);
    const js = frameMs(fm, s, s, uni, [], n);
    const c = frameMs(fm, s, s, uni, ['--backend', 'c'], n);

    const spec = join(OUT, 'spec.json');
    writeFileSync(spec, JSON.stringify({
      vert: join(CASES, VERT), frag: join(CASES, FRAG), w: s, h: s, iters: 20, uniforms: uni,
    }));
    const gl = spawnSync('python3', [GLB, spec], { encoding: 'utf8' });
    const glTxt = gl.status === 0 ? gl.stdout.trim().split(/\s+/) : null;

    const cell = (ms) => (ms === null ? '      ——           '
      : `${ms.toFixed(1).padStart(8)}ms (${((s * s) / (ms * 1000)).toFixed(2).padStart(5)} MPix/s)`);
    process.stdout.write(`  ${String(s).padStart(4)}²  ${cell(js)}  ${cell(c)}  `
      + `${glTxt === null ? '   ——' : `${Number(glTxt[0]).toFixed(3)}ms (${glTxt[1]} MPix/s)`}\n`);
  }
  process.stdout.write('\n');
}

process.stdout.write('\n注：我们这一侧是**标量、一次一个片元**（ADR-0019 决策一）。'
  + '真 GL 是 Apple M1 的硬件光栅化器。\n');
process.stdout.write('    差几个数量级是预期的 —— 这张表的用处是「以后每一步优化能不能量出来」。\n');

rmSync(OUT, { recursive: true, force: true });
