// tests/glsl/bench.js —— 量性能那一段（ADR-0019 第一刀第五片）
//
// 这一门**不判快慢**（那是机器的事，写死一个毫秒数只会在别的机器上骗人）。它判两件事：
//
//   一、量性能那条路与印像素那条路**算的是同一件事**：同一尺寸下，校验和正好等于
//      印出来那些 8 位值的和。一个量错东西的 benchmark 比没有 benchmark 更坏。
//   二、两条腿的校验和相同（8 位那一层是逐字节的，第四片量过）。
//
// 顺带把两条腿的耗时印出来当**参考**（不进判据）—— 这条线要的性能对照最终是与 llvmpipe 比，
// 而那要一台有 mesa 的机器（ADR-0019 里那条还没解决的）。
//
//   node tests/glsl/bench.js

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
import { glslProgram, glslBenchProgram } from '../../src/core/frontend-glsl/lower.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const GRAMMAR = join(root, 'src', 'core', 'frontend-glsl', 'glsl.grammar');
const CASES = join(here, 'cases');
const OUT = join(tmpdir(), 'omni-glsl-bench');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

const gdiags = new Diagnostics();
const g = readGrammar(readSexpr(new SourceFile(GRAMMAR, readFileSync(GRAMMAR, 'utf8')), gdiags), gdiags);
gdiags.throwIfErrors();
const tb = buildTable(g);

function modOf(file) {
  const diags = new Diagnostics();
  const toks = lexText(g.lex, new SourceFile(file, readFileSync(join(CASES, file), 'utf8')), diags);
  diags.throwIfErrors();
  return glslCheck(glrParse(tb, toks, diags), 'frag');
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const W = 16;
const H = 16;
const mod = modOf('bench-simple.frag');
const uni = { u_resolution: [W, H] };

/** 跑一份方言程序，回 `{ms, out}`。 */
function run(path, args) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CLI, 'run', path, ...args],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  const ms = Date.now() - t0;
  if (r.status !== 0) return { err: (r.stderr ?? '').trim().split('\n').slice(0, 4).join('\n    ') };
  return { ms, out: r.stdout.trim() };
}

/* 一、校验和 == 印出来那些数的和。 */
const rp = join(OUT, 'render.sx');
writeFileSync(rp, glslProgram(mod, W, H, uni));
const bp = join(OUT, 'bench.sx');
writeFileSync(bp, glslBenchProgram(mod, W, H, uni, 1));

const rr = run(rp, []);
const rb = run(bp, []);
if (rr.err !== undefined) bad('印像素那条路跑不动', `    ${rr.err}`);
else if (rb.err !== undefined) bad('量性能那条路跑不动', `    ${rb.err}`);
else {
  const nums = rr.out.split('\n').map(Number);
  let sum = 0;
  for (let i = 0; i + 4 < nums.length; i += 5) sum += nums[i + 2] + nums[i + 3] + nums[i + 4];
  const acc = Number(rb.out);
  if (acc !== sum) bad('两条路算的不是同一件事', `    印出来的和 ${sum}，校验和 ${acc}`);
  else ok(`校验和 ${acc} == 印出来那 ${nums.length / 5} 个像素的 8 位值之和`);
}

/* 二、两条腿的校验和相同。 */
const rbc = run(bp, ['--backend', 'c']);
if (rbc.err !== undefined) bad('C 腿跑不动', `    ${rbc.err}`);
else if (rb.err === undefined && rbc.out !== rb.out) {
  bad('两条腿的校验和不一样', `    js ${rb.out} / c ${rbc.out}`);
} else if (rb.err === undefined) {
  ok(`两条腿的校验和相同（${rb.out}）`);
}

/* 三、迭代多遍也是同一个校验和的整数倍 —— 循环没被折叠掉的证据。 */
{
  const p3 = join(OUT, 'bench3.sx');
  writeFileSync(p3, glslBenchProgram(mod, W, H, uni, 3));
  const r3 = run(p3, []);
  if (r3.err !== undefined) bad('迭代 3 遍跑不动', `    ${r3.err}`);
  else if (rb.err === undefined && Number(r3.out) !== Number(rb.out) * 3) {
    bad('迭代 3 遍的校验和不是 3 倍', `    1 遍 ${rb.out}、3 遍 ${r3.out}`);
  } else ok('迭代 3 遍的校验和正好是 3 倍（循环没被折叠掉）');
}

/* 四、耗时印出来当参考，不进判据。128×128 一遍，两条腿各一次。 */
{
  const BW = 128;
  const BH = 128;
  const m2 = modOf('bench-simple.frag');
  const p = join(OUT, 'big.sx');
  writeFileSync(p, glslBenchProgram(m2, BW, BH, { u_resolution: [BW, BH] }, 1));
  const a = run(p, []);
  const b = run(p, ['--backend', 'c']);
  if (a.err !== undefined || b.err !== undefined) {
    process.stdout.write('  note 128×128 那一趟没跑成，耗时不印（不进判据）\n');
  } else {
    const px = BW * BH;
    process.stdout.write(`  note ${BW}×${BH}（${px} 个片元，含进程启动与编译）：`
      + `js ${a.ms}ms、c ${b.ms}ms —— 只当参考，不是判据\n`);
    if (a.out !== b.out) bad('128×128 两条腿的校验和不一样', `    js ${a.out} / c ${b.out}`);
    else ok(`128×128 两条腿的校验和也相同（${a.out}）`);
  }
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
