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

/* ---- 三、第二档那些：**接上了的要算对，没接的要明着骂**。 */

/** 一段片元着色器，取一个像素的四格（原始 real），回四个数。 */
function shade(body, uni = '', x = 1.5, y = 2.5) {
  const src = `#version 330 core\n${uni}out vec4 fragColor;\n${body}`;
  const libx = lower(src, 'frag');
  const p = join(OUT, `probe${Math.abs(hashOf(body))}.sx`);
  writeFileSync(p, `${libx.trimEnd().slice(0, -1)}\n  (main\n`
    + `    (let q glsl_v4 (call glsl_frag (real ${x}) (real ${y})))\n`
    + '    (print (fld (var q) c0))\n    (print (fld (var q) c1))\n'
    + '    (print (fld (var q) c2))\n    (print (fld (var q) c3)))\n)\n');
  const r = spawnSync(process.execPath, [CLI, 'run', p], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) return { err: (r.stderr ?? '').trim().split('\n').slice(0, 4).join('\n    ') };
  return { v: r.stdout.trim().split('\n').map(Number) };
}
function hashOf(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/* 第二档那几件事，每一条给一个能手算的答案。挑的数都让答案有区分度
 * （比如 `mix` 那条：0.25 与 0.75 混出来是 0.375，写错成 `x+(y-x)*a` 也会得同一个数，
 * 所以另加一条 `a=1` —— 那一条能分开两种写法：规范那个形状精确回 y）。 */
const T2 = [
  ['mat2 * vec2（列优先，写成转置会往反方向转）',
    'mat2 rot(float a) { return mat2(0.0, 1.0, -1.0, 0.0); }\n'
    + 'void main() { vec2 p = rot(0.0) * vec2(1.0, 0.0); fragColor = vec4(p, 0.0, 1.0); }\n',
    /* 列优先：第 0 列 (0,1)、第 1 列 (-1,0)。m * (1,0) = 第 0 列 = (0,1)。
     * 记成行优先会得 (0,-1) —— 差一个符号，正是「转过来」。 */
    [0, 1, 0, 1]],
  ['vec2 * mat2',
    'void main() { vec2 p = vec2(1.0, 0.0) * mat2(0.0, 1.0, -1.0, 0.0); fragColor = vec4(p, 0.0, 1.0); }\n',
    /* 行向量乘：第 col 格 = dot(v, 第 col 列) = (0, -1)。 */
    [0, -1, 0, 1]],
  ['mat2 * mat2 与 mat2(scalar) 是对角',
    'void main() { mat2 m = mat2(2.0) * mat2(3.0, 0.0, 0.0, 4.0); fragColor = vec4(m[0], 0.0, 1.0); }\n',
    null],
  ['mix 照规范的形状（a=1 时精确回 y）',
    'void main() { float a = mix(0.25, 0.75, 0.5); float b = mix(1.0, 3.0, 1.0);'
    + ' fragColor = vec4(a, b, 0.0, 1.0); }\n',
    /* 0.25*(1-0.5) + 0.75*0.5 = 0.5；第二格是 a=1 那一格（规范那个形状精确回 y）。 */
    [0.5, 3, 0, 1]],
  ['clamp / step / sign',
    'void main() { fragColor = vec4(clamp(2.0, 0.0, 1.0), step(1.0, 0.5), sign(-3.0), 1.0); }\n',
    [1, 0, -1, 1]],
  ['fract / dot / normalize',
    'void main() { float f = fract(2.75); float d = dot(vec2(1.0, 2.0), vec2(3.0, 4.0));'
    + ' vec2 n = normalize(vec2(3.0, 4.0)); fragColor = vec4(f, d, n.x, 1.0); }\n',
    [0.75, 11, 0.6, 1]],
  ['三元只算一支（不该走的那支里是除零）',
    'void main() { float z = 0.0; float v = z > 0.0 ? 1.0 / z : 7.0;'
    + ' fragColor = vec4(v, 0.0, 0.0, 1.0); }\n',
    [7, 0, 0, 1]],
  ['if / else',
    'void main() { float v = 0.0; if (2.0 > 1.0) { v = 5.0; } else { v = 9.0; }'
    + ' fragColor = vec4(v, 0.0, 0.0, 1.0); }\n',
    [5, 0, 0, 1]],
  ['pow / sqrt / exp / log',
    'void main() { fragColor = vec4(pow(2.0, 10.0), sqrt(9.0), exp(0.0), 1.0); }\n',
    [1024, 3, 1, 1]],
];
for (const [name, body, want] of T2) {
  if (want === null) continue;   // 下标那条在下面单列（这一刀不收 `m[0]`）
  const r = shade(body);
  if (r.err !== undefined) bad(`第二档：${name}`, `    ${r.err}`);
  else {
    const off = [];
    for (let i = 0; i < 4; i++) {
      if (Math.abs(r.v[i] - want[i]) > Math.max(1e-6, Math.abs(want[i]) * 1e-5)) {
        off.push(`第 ${i} 格：要 ${want[i]}，得 ${r.v[i]}`);
      }
    }
    if (off.length > 0) bad(`第二档：${name}`, `    ${off.join('\n    ')}`);
    else ok(`第二档：${name}`);
  }
}

/* varying 与顶点着色器**已经接上了**（第七片），它们的门在 `tests/glsl/interp.js`。
 * 这儿只留还没接的那两条。 */
const NYI = [
  ['矩阵下标 m[0]', 'out vec4 c;\nvoid main() { mat2 m = mat2(1.0); c = vec4(m[0], 0.0, 1.0); }\n', '下标'],
  ['continue', 'out vec4 c;\nvoid main() { float d = 0.0;'
    + ' for (int i = 0; i < 3; i++) { continue; } c = vec4(d); }\n', 'continue'],
];
for (const [name, body, want] of NYI) {
  let msg = null;
  try { lower(`#version 330 core\n${body}`, 'frag'); } catch (e) { msg = e.message; }
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
