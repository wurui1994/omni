// tests/glsl/lower.js —— GLSL -> 核心方言，两条腿都跑起来（ADR-0019 第一刀第三片）
//
// 这一门查三件事：
//
//   一、`FRAG_SIMPLE` 降出来的方言**跑得动**，JS 腿与 C 腿的数**一致到容差**。
//      为什么是容差不是逐字节：`cos` 是超越函数，libm 与 V8 在最后一位分叉 —— 量过的，
//      见 src/runtime/omni_math.c 的头注（20 万输入上 51.1 万个结果位不同）。
//      口径照 tests/asy/tol/ 那一节：最后一位十进制差不超过 1。
//
//   二、算出来的像素与**这份门自己独立算的同一个公式**一致。这**不是** oracle
//      （真尺子是 llvmpipe，见 ADR-0019 决策二）—— 它查的是「降级没有把公式改掉」：
//      降级里少一次乘、swizzle 取错一格、uniform 接错一格，这一条都会红。
//
//   三、第二档那些还没接的东西**明着骂**，不悄悄绕（矩阵、三元、mix、varying…）。
//
//   node tests/glsl/lower.js

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

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const GRAMMAR = join(root, 'src', 'core', 'frontend-glsl', 'glsl.grammar');
const CASES = join(here, 'cases');
const OUT = join(tmpdir(), 'omni-glsl-lower');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

const gdiags = new Diagnostics();
const g = readGrammar(readSexpr(new SourceFile(GRAMMAR, readFileSync(GRAMMAR, 'utf8')), gdiags), gdiags);
gdiags.throwIfErrors();
const tb = buildTable(g);

/** 一段 GLSL -> 方言文本。 */
function lower(src, stage, name = 'probe') {
  const diags = new Diagnostics();
  const file = new SourceFile(name, src);
  const toks = lexText(g.lex, file, diags);
  diags.throwIfErrors();
  const tree = glrParse(tb, toks, diags);
  diags.throwIfErrors();
  return glslLower(glslCheck(tree, stage));
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/* ---- 一、`FRAG_SIMPLE` 两条腿。 */

/** 取样的那几个像素（画布 4×3，取像素中心 —— 与 GL 的 `gl_FragCoord` 同一个口径）。 */
const W = 4;
const H = 3;
const PIX = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) PIX.push([x + 0.5, y + 0.5]);

const lib = lower(readFileSync(join(CASES, 'bench-simple.frag'), 'utf8'), 'frag', 'bench-simple.frag');
/* 驱动那一段：把每个取样点的四格印出来。印的是**原始 real**，不是 8 位 ——
 * 8 位会把「差最后一位」这件事藏起来，而这一门想看的正是它。 */
const driver = PIX.map(([x, y], k) => `    (let p${k} glsl_v4 (call glsl_frag (real ${x}) (real ${y}) (real ${W}.0) (real ${H}.0)))\n`
  + `    (print (fld (var p${k}) c0))\n`
  + `    (print (fld (var p${k}) c1))\n`
  + `    (print (fld (var p${k}) c2))\n`
  + `    (print (fld (var p${k}) c3))`).join('\n');
const sx = `${lib.trimEnd().slice(0, -1)}\n  (main\n${driver})\n)\n`;
const sxPath = join(OUT, 'simple.sx');
writeFileSync(sxPath, sx);

function runLeg(args) {
  const r = spawnSync(process.execPath, [CLI, 'run', sxPath, ...args],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) return { err: (r.stderr ?? '').trim().split('\n').slice(0, 4).join('\n    ') };
  return { lines: r.stdout.trim().split('\n') };
}

const js = runLeg([]);
if (js.err !== undefined) bad('JS 腿跑不动', `    ${js.err}`);
else ok(`JS 腿跑起来了（${js.lines.length} 个数）`);

const cLeg = runLeg(['--backend', 'c']);
if (cLeg.err !== undefined) bad('C 腿跑不动', `    ${cLeg.err}`);
else ok(`C 腿跑起来了（${cLeg.lines.length} 个数）`);

/** 两个十进制数「最后一位差不超过 1」——口径照 tests/asy/tol/。 */
function closeEnough(a, b) {
  if (a === b) return true;
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const digits = Math.max(a.replace(/^-?\d*\.?/, '').length, b.replace(/^-?\d*\.?/, '').length);
  const unit = 10 ** -digits;
  return Math.abs(x - y) <= unit * 1.5;
}

if (js.lines !== undefined && cLeg.lines !== undefined) {
  if (js.lines.length !== cLeg.lines.length) {
    bad('两条腿的行数不一样', `    js ${js.lines.length} / c ${cLeg.lines.length}`);
  } else {
    const off = [];
    for (let i = 0; i < js.lines.length; i++) {
      if (!closeEnough(js.lines[i], cLeg.lines[i])) off.push(`${i}: js ${js.lines[i]} / c ${cLeg.lines[i]}`);
    }
    if (off.length > 0) bad('两条腿的数差得超过容差', `    ${off.slice(0, 6).join('\n    ')}`);
    else ok(`JS 腿与 C 腿 ${js.lines.length} 个数一致到容差（cos 是超越函数，逐字节不成立）`);
  }
}

/* ---- 二、与门自己独立算的同一个公式对。**这不是 oracle** —— 见文件头。 */
if (js.lines !== undefined) {
  const want = [];
  for (const [x, y] of PIX) {
    const uvx = x / W;
    const uvy = y / H;
    const c = [uvx, uvy, uvx].map((v, k) => 0.5 + 0.5 * Math.cos(v * 3.0 + [0, 2, 4][k]));
    want.push(c[0], c[1], c[2], 1);
  }
  const off = [];
  for (let i = 0; i < want.length; i++) {
    const got = Number(js.lines[i]);
    /* `print` 印的是**六位有效数字**（方言那一层的格式），所以这儿的容差只能到那个位数 ——
     * 拿 1e-12 比是在比印出来之前的东西，那种红是假的。 */
    const tol = Math.max(1e-6, Math.abs(want[i]) * 1e-5);
    if (!(Math.abs(got - want[i]) <= tol)) off.push(`${i}: 要 ${want[i]}，得 ${got}`);
  }
  if (off.length > 0) bad('算出来的不是源码写的那个公式', `    ${off.slice(0, 6).join('\n    ')}`);
  else ok(`${want.length} 个数与门自己算的同一个公式相同（降级没有把公式改掉）`);
}

/* ---- 三、第二档那些要明着骂。 */
const NYI = [
  ['矩阵', 'uniform float u_t;\nout vec4 c;\nmat2 rot(float a) { return mat2(cos(a), -sin(a), sin(a), cos(a)); }\nvoid main() { vec2 p = vec2(1.0); p *= rot(u_t); c = vec4(p, 0.0, 1.0); }\n', '矩阵'],
  ['三元', 'uniform float u_t;\nout vec4 c;\nvoid main() { float f = u_t < 1.0 ? 2.0 : 3.0; c = vec4(f); }\n', '三元'],
  ['varying', 'in vec2 v_uv;\nout vec4 c;\nvoid main() { c = vec4(v_uv, 0.0, 1.0); }\n', 'varying'],
  ['mix', 'uniform float u_t;\nout vec4 c;\nvoid main() { c = vec4(mix(0.0, 1.0, u_t)); }\n', '内建 mix'],
  ['if', 'uniform float u_t;\nout vec4 c;\nvoid main() { float f = 0.0; if (u_t < 1.0) { f = 1.0; } c = vec4(f); }\n', 'if'],
  ['顶点着色器', 'void main() { gl_Position = vec4(float(gl_VertexID)); }\n', '顶点着色器'],
];
for (const [name, body, want] of NYI) {
  const stage = name === '顶点着色器' ? 'vert' : 'frag';
  let msg = null;
  try { lower(`#version 330 core\n${body}`, stage); } catch (e) { msg = e.message; }
  if (msg === null) bad(`该骂却降了：${name}`, '    一声没响');
  else if (!msg.includes(want)) bad(`骂得不对：${name}`, `    要含「${want}」\n    实际：${msg.split('\n')[0]}`);
  else ok(`还没接的明着骂：${name}`);
}

/* ---- 四、`FRAG_COMPLEX`（第一档的第二份）也降得出来、也跑得动。 */
{
  const lib2 = lower(readFileSync(join(CASES, 'bench-complex.frag'), 'utf8'), 'frag', 'bench-complex.frag');
  const p2 = join(OUT, 'complex.sx');
  writeFileSync(p2, `${lib2.trimEnd().slice(0, -1)}\n  (main\n`
    + '    (let q glsl_v4 (call glsl_frag (real 0.5) (real 0.5) (real 4.0) (real 3.0)))\n'
    + '    (print (fld (var q) c0))\n    (print (fld (var q) c3)))\n)\n');
  const r = spawnSync(process.execPath, [CLI, 'run', p2], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    bad('FRAG_COMPLEX 跑不动', `    ${(r.stderr ?? '').trim().split('\n').slice(0, 4).join('\n    ')}`);
  } else {
    const out = r.stdout.trim().split('\n');
    /* 第四格是 `1.0`（`vec4(col, 1.0)`），第一格该在 [0, 数] 之间 —— 这一格只查
     * 「跑得动而且不是 NaN」，像素对不对由第一档那份 SDF 图在第四片里比。 */
    const a = Number(out[0]);
    if (out.length === 2 && Number(out[1]) === 1 && Number.isFinite(a)) {
      ok(`FRAG_COMPLEX 跑起来了（第一格 ${out[0]}、alpha ${out[1]}）`);
    } else {
      bad('FRAG_COMPLEX 的输出不成形', `    ${out.join(' / ')}`);
    }
  }
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
