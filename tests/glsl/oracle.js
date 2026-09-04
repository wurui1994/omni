// tests/glsl/oracle.js —— 与**真 GL** 比像素（ADR-0019 第一刀第十片）
//
// 前九片都是自证：门自己算期望值。这一门第一次有**外部 oracle** ——
// 本机的真 OpenGL（量过：Apple M1、GL 4.1 Metal，见 `gl_ref.py` 的头注）。
//
// 为什么硬件也算尺子：覆盖判定、填充规则、插值、`gl_FragCoord` 的原点、缓冲行序
// 都是**规范规定**的，硬件与 llvmpipe 都得照办。只有 `sin`/`cos`/`smoothstep` 那种
// 实现自由度上两者才可能不同 —— 而那正是「容差」要量的东西（ADR-0019 决策二）。
//
// **容差不是拍的**：这一门印出每份用例的最大逐通道差，判据是 `<= TOL`，
// 而 `TOL` 的来历写在 ADR-0019 第十片里（量出来的最大差 + 说明）。
//
// python3 / moderngl 不在就**跳过整组**（不假过）。
//
//   node tests/glsl/oracle.js

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { loadGrammarTable } from '../../src/core/glr/load.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { glslCheck } from '../../src/core/frontend-glsl/check.js';
import { glslTriProgram } from '../../src/core/frontend-glsl/lower.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const GRAMMAR = join(root, 'src', 'core', 'frontend-glsl', 'glsl.grammar');
const CASES = join(here, 'cases');
const REF = join(here, 'gl_ref.py');
const OUT = join(tmpdir(), 'omni-glsl-oracle');

/** 容差：**量出来的**，不是拍的。来历见 ADR-0019 第十片。 */
const TOL = 1;

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

/* python3 + moderngl 在不在。不在就跳过整组 —— 悄悄变成 0 passed 是最坏的结局。 */
const probe = spawnSync('python3', ['-c', 'import moderngl'], { encoding: 'utf8' });
if (probe.status !== 0) {
  process.stdout.write('  skip 整组：这台机器上没有 python3 + moderngl（真 GL 尺子取不到）\n');
  process.exit(0);
}

/* 表走带缓存的装载（ADR-0019 决策八第 1 步）：构表在这份语法上是 559 ms、
 * 命中缓存是 8 ms。十四支门各构一遍表，等于每跑一趟全套白花 14 × 559 ms。 */
const { g, tb } = loadGrammarTable(GRAMMAR);

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

/** 尺子那一侧：一行五个数（`gl_ref.py` 印的形状）。 */
function refMap(text) {
  const m = new Map();
  for (const line of text.trim().split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const p = line.trim().split(/\s+/).map(Number);
    m.set(`${p[0]},${p[1]}`, [p[2], p[3], p[4]]);
  }
  return m;
}

/** 我们那一侧：**一个数一行**（方言的 `print` 一次一个值 —— 见第四片那段注释）。 */
function oursMap(text) {
  const nums = text.trim() === '' ? [] : text.trim().split('\n').map(Number);
  const m = new Map();
  for (let i = 0; i + 4 < nums.length; i += 5) {
    m.set(`${nums[i]},${nums[i + 1]}`, [nums[i + 2], nums[i + 3], nums[i + 4]]);
  }
  return m;
}

const CASES_LIST = [
  { name: 'bench-simple（第一档）', vert: 'bench-vert.vert', frag: 'bench-simple.frag', uni: { u_resolution: null } },
  { name: 'bench-complex（第一档，SDF 30 个）', vert: 'bench-vert.vert', frag: 'bench-complex.frag', uni: { u_resolution: null } },
  { name: 'pretty（第二档，varying + mat2）', vert: 'pretty-vert.vert', frag: 'pretty.frag', uni: { u_res: null, u_time: [0.5] } },
  /* **斜边穿过画布**的三角形（ADR-0019 待办第 12 条）：前三份都是全屏三角形，斜边在画布外，
   * 所以「填充规则与 GL 同侧」只是弱证据。这一份把斜边摆进画布中间 —— GL 那边没覆盖的像素
   * 是 clear 色（纯黑），而这份片元在覆盖处最小是 0.25（不会是纯黑），于是
   * **覆盖集合**与**像素值**能一起验。 */
  {
    name: 'half（斜边穿过画布 —— 填充规则与 GL 同侧的强证据）',
    vert: 'half-vert.vert',
    frag: 'half.frag',
    uni: { u_resolution: null },
    half: true,
  },
];

/* 64×64 = 4096 个像素、12288 个通道。比 16×16 宽得多（SDF 的边界、hex 网格的格线
 * 这些「只在某些像素上不同」的东西要够大的画布才踩得到），而我们这一侧一个像素五个
 * `print`，再大就是在量 `print` 而不是量像素了。128×128 那一档在下面单独跑一份。 */
const W = 64;
const H = 64;

for (const c of CASES_LIST) {
  const uni = {};
  for (const [k, v] of Object.entries(c.uni)) uni[k] = v === null ? [W, H] : v;
  const vp = join(CASES, c.vert);
  const fp = join(CASES, c.frag);

  /* 尺子那一侧。 */
  const spec = join(OUT, 'spec.json');
  writeFileSync(spec, JSON.stringify({ vert: vp, frag: fp, w: W, h: H, uniforms: uni }));
  const ref = spawnSync('python3', [REF, spec], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (ref.status !== 0) {
    bad(`${c.name}：尺子那一侧跑不动`, `    ${(ref.stderr ?? '').trim().split('\n').slice(-3).join('\n    ')}`);
    continue;
  }

  /* 我们那一侧。 */
  const prog = join(OUT, 'ours.sx');
  writeFileSync(prog, glslTriProgram(check(vp, 'vert'), check(fp, 'frag'), W, H, uni));
  const mine = spawnSync(process.execPath, [CLI, 'run', prog], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (mine.status !== 0) {
    bad(`${c.name}：我们这一侧跑不动`, `    ${(mine.stderr ?? '').trim().split('\n').slice(0, 4).join('\n    ')}`);
    continue;
  }

  const want = refMap(ref.stdout);
  const got = oursMap(mine.stdout);
  if (want.size !== W * H) {
    bad(`${c.name}：尺子那一侧的像素个数不对`, `    ${want.size}（该是 ${W * H}）`);
    continue;
  }
  if (c.half !== true && got.size !== W * H) {
    bad(`${c.name}：我们这一侧的像素个数不对`, `    ${got.size}（该是 ${W * H}）`);
    continue;
  }
  if (c.half === true && (got.size === 0 || got.size === W * H)) {
    bad(`${c.name}：这个探针没区分度`, `    我们画了 ${got.size} 个（该是一半左右）`);
    continue;
  }
  let worst = 0;
  let worstAt = '';
  let over = 0;
  let atTol = 0;
  for (const [k, b] of got) {
    const a = want.get(k);
    if (a === undefined) {
      bad(`${c.name}：我们画了尺子那边没有的像素`, `    ${k}`);
      over = -1;
      break;
    }
    for (let i = 0; i < 3; i++) {
      const d = Math.abs(a[i] - b[i]);
      if (d > worst) { worst = d; worstAt = `${k} 通道${i}：尺子 ${a[i]} / 我们 ${b[i]}`; }
      if (d > TOL) over++;
      else if (d > 0) atTol++;
    }
  }
  if (over < 0) continue;
  /* 半覆盖那一份还要查**我们没画的那些**在尺子那边是 clear 色（纯黑）——
   * 这一条把「覆盖集合一致」也验了，而不只是「画出来的那些值对」。 */
  let leaked = 0;
  if (c.half === true) {
    for (const [k, a] of want) {
      if (got.has(k)) continue;
      if (a[0] !== 0 || a[1] !== 0 || a[2] !== 0) leaked++;
    }
  }
  if (leaked > 0) {
    bad(`${c.name}：尺子画了而我们没画的像素有 ${leaked} 个`,
      '    （那说明覆盖集合与 GL 不一样 —— 填充规则或边函数差一格）');
  } else if (over > 0) {
    bad(`${c.name}：与真 GL 差得超过容差 ${TOL}`,
      `    超差 ${over} 个通道（共 ${got.size * 3} 个），最大差 ${worst}\n    最坏那一处 ${worstAt}`);
  } else {
    ok(`${c.name}：${got.size} 个像素与真 GL 对上（最大差 ${worst}、差 1 的通道 ${atTol} 个，容差 ${TOL}）`);
  }
}

/* ---- 大画布那一档：128×128 只跑第一份（一个像素五个 `print`，再往上就是在量 print）。
 * 挑 `bench-complex` 是因为它有 30 个 SDF 与 `smoothstep`，边界上最容易出「差 1」。 */
{
  const W2 = 128;
  const uni = { u_resolution: [W2, W2] };
  const vp = join(CASES, 'bench-vert.vert');
  const fp = join(CASES, 'bench-complex.frag');
  const spec = join(OUT, 'spec-big.json');
  writeFileSync(spec, JSON.stringify({ vert: vp, frag: fp, w: W2, h: W2, uniforms: uni }));
  const ref = spawnSync('python3', [REF, spec], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const prog = join(OUT, 'ours-big.sx');
  writeFileSync(prog, glslTriProgram(check(vp, 'vert'), check(fp, 'frag'), W2, W2, uni));
  const mine = spawnSync(process.execPath, [CLI, 'run', prog], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (ref.status !== 0 || mine.status !== 0) {
    bad('128×128 那一档跑不动',
      `    ${(ref.stderr ?? '').trim().split('\n').slice(-2).join(' ')} | `
      + `${(mine.stderr ?? '').trim().split('\n').slice(0, 2).join(' ')}`);
  } else {
    const want = refMap(ref.stdout);
    const got = oursMap(mine.stdout);
    let worst = 0;
    let over = 0;
    let atTol = 0;
    for (const [k, b] of got) {
      const a = want.get(k);
      for (let i = 0; i < 3; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (d > worst) worst = d;
        if (d > TOL) over++;
        else if (d > 0) atTol++;
      }
    }
    if (got.size !== W2 * W2) bad('128×128：像素个数不对', `    ${got.size}`);
    else if (over > 0) bad(`128×128：超差 ${over} 个通道`, `    最大差 ${worst}`);
    else {
      ok(`128×128 bench-complex：${got.size} 个像素与真 GL 对上`
        + `（最大差 ${worst}、差 1 的通道 ${atTol}/${got.size * 3}）`);
    }
  }
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
