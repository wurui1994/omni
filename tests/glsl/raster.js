// tests/glsl/raster.js —— 覆盖判定（ADR-0019 第一刀第八片）
//
// 前七片都是「一个三角形铺满画布」，覆盖判定是假的（每个像素都画）。这一门查它真了：
//
//   一、**半覆盖**的三角形只画该画的那一半，而且画的是**哪些**像素逐个比 ——
//      期望集合由这一门自己用叉积算（独立实现，不抄降级那一侧）。
//   二、**绕向反过来画的是同一片像素**。这一条测的是 `sgn` 那一格：少了它，
//      顺时针的三角形会被判成「全在外」，一个像素都不画。
//   三、全屏三角形照旧铺满（回归 —— 前七片的门靠的就是它）。
//   四、不覆盖的像素**连片元都不调**：把片元写成会除零的样子，只有真的跳过了才不出 inf。
//
//   node tests/glsl/raster.js

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
import { glslTriProgram } from '../../src/core/frontend-glsl/lower.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const GRAMMAR = join(root, 'src', 'core', 'frontend-glsl', 'glsl.grammar');
const OUT = join(tmpdir(), 'omni-glsl-raster');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

const gdiags = new Diagnostics();
const g = readGrammar(readSexpr(new SourceFile(GRAMMAR, readFileSync(GRAMMAR, 'utf8')), gdiags), gdiags);
gdiags.throwIfErrors();
const tb = buildTable(g);

function check(src, stage, name) {
  const diags = new Diagnostics();
  const toks = lexText(g.lex, new SourceFile(name, src), diags);
  diags.throwIfErrors();
  const tree = glrParse(tb, toks, diags);
  diags.throwIfErrors();
  return glslCheck(tree, stage);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let seq = 0;
function draw(vert, frag, w, h) {
  seq++;
  const p = join(OUT, `p${seq}.sx`);
  writeFileSync(p, glslTriProgram(check(vert, 'vert', 'v'), check(frag, 'frag', 'f'), w, h, {}));
  const r = spawnSync(process.execPath, [CLI, 'run', p], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) return { err: (r.stderr ?? '').trim().split('\n').slice(0, 5).join('\n    ') };
  const nums = r.stdout.trim() === '' ? [] : r.stdout.trim().split('\n').map(Number);
  const pix = [];
  for (let i = 0; i + 4 < nums.length; i += 5) {
    pix.push({ x: nums[i], y: nums[i + 1], r: nums[i + 2], g: nums[i + 3], b: nums[i + 4] });
  }
  return { pix, out: r.stdout.trim() };
}

const HEAD = '#version 330 core\n';
const FRAG_RED = `${HEAD}out vec4 fragColor;\nvoid main() { fragColor = vec4(1.0, 0.0, 0.0, 1.0); }\n`;

/** 三个 clip 空间顶点 -> 一份顶点着色器（`w` 全是 1）。 */
function vertOf(pts) {
  const sel = (k) => `(gl_VertexID == 0) ? ${pts[0][k].toFixed(1)} : `
    + `((gl_VertexID == 1) ? ${pts[1][k].toFixed(1)} : ${pts[2][k].toFixed(1)})`;
  return `${HEAD}void main() {\n`
    + `  float x = ${sel(0)};\n  float y = ${sel(1)};\n`
    + '  gl_Position = vec4(x, y, 0.0, 1.0);\n}\n';
}

/** 这一门**自己**算覆盖：clip -> 窗口，再逐像素三次叉积 + 同一套边上归属规则。
 *
 * 规则与降级那一侧**同一套**（`e > 0`，或者 `e == 0` 且那条边是 top-left），
 * 但实现是独立写的 —— 这一条查的是「实现符合设计」。「设计本身对不对」由下面
 * 那条方块用例查（不重不漏是填充规则的定义性性质，不用 GL 也验得了）。 */
function coverOf(pts, w, h) {
  const win = pts.map(([x, y]) => [(x * 0.5 + 0.5) * w, (y * 0.5 + 0.5) * h]);
  const cross = (ax, ay, bx, by) => ax * by - ay * bx;
  const area = cross(win[1][0] - win[0][0], win[1][1] - win[0][1],
    win[2][0] - win[0][0], win[2][1] - win[0][1]);
  const sgn = area < 0 ? -1 : 1;
  const set = new Set();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let inside = true;
      for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
        const e = sgn * cross(win[b][0] - win[a][0], win[b][1] - win[a][1],
          px - win[a][0], py - win[a][1]);
        const sdx = sgn * (win[b][0] - win[a][0]);
        const sdy = sgn * (win[b][1] - win[a][1]);
        const tl = sdy < 0 || (sdy === 0 && sdx > 0);
        if (!(e > 0 || (tl && e === 0))) inside = false;
      }
      if (inside) set.add(`${x},${y}`);
    }
  }
  return set;
}

const W = 8;
const H = 8;

/* ---- 一、半覆盖：clip (-1,-1) (1,-1) (-1,1) 只盖左下那一半。 */
const HALF = [[-1, -1], [1, -1], [-1, 1]];
{
  const r = draw(vertOf(HALF), FRAG_RED, W, H);
  if (r.err !== undefined) bad('半覆盖那一趟跑不动', `    ${r.err}`);
  else {
    const want = coverOf(HALF, W, H);
    const got = new Set(r.pix.map((p) => `${p.x},${p.y}`));
    const extra = [...got].filter((k) => !want.has(k));
    const missing = [...want].filter((k) => !got.has(k));
    if (want.size === 0 || want.size === W * H) {
      bad('这个探针没区分度', `    它盖了 ${want.size} 个像素（该是一半左右）`);
    } else if (extra.length > 0 || missing.length > 0) {
      bad('画的像素与门自己算的覆盖不一样',
        `    多画 ${extra.slice(0, 8).join(' ')}\n    少画 ${missing.slice(0, 8).join(' ')}`);
    } else {
      ok(`半覆盖：${want.size}/${W * H} 个像素，逐个与门自己算的叉积覆盖相同`);
    }
  }
}

/* ---- 二、绕向反过来是同一片像素。 */
{
  const flipped = [HALF[0], HALF[2], HALF[1]];
  const a = draw(vertOf(HALF), FRAG_RED, W, H);
  const b = draw(vertOf(flipped), FRAG_RED, W, H);
  if (a.err !== undefined || b.err !== undefined) bad('绕向那两趟跑不动', `    ${a.err ?? b.err}`);
  else {
    const ka = new Set(a.pix.map((p) => `${p.x},${p.y}`));
    const kb = new Set(b.pix.map((p) => `${p.x},${p.y}`));
    const diff = [...ka].filter((k) => !kb.has(k)).concat([...kb].filter((k) => !ka.has(k)));
    if (b.pix.length === 0) {
      bad('绕向反过来一个像素都没画', '    那说明 sgn 那一格没在做事（顺时针被判成全在外）');
    } else if (diff.length > 0) {
      bad('绕向反过来画的不是同一片', `    差 ${diff.slice(0, 8).join(' ')}`);
    } else {
      ok(`绕向反过来画的是同一片像素（${ka.size} 个）—— sgn 那一格在做事`);
    }
  }
}

/* ---- 三、全屏三角形照旧铺满。 */
{
  const FULL = [[-1, -1], [3, -1], [-1, 3]];
  const r = draw(vertOf(FULL), FRAG_RED, W, H);
  if (r.err !== undefined) bad('全屏那一趟跑不动', `    ${r.err}`);
  else if (r.pix.length !== W * H) {
    bad('全屏三角形没铺满', `    要 ${W * H} 个像素，画了 ${r.pix.length}`);
  } else ok(`全屏三角形照旧铺满（${W * H} 个像素）`);
}

/* ---- 四、不覆盖的像素连片元都不调。
 *
 * 片元里写一个「一定会出 inf」的算式（除以 0）。如果不覆盖的像素也被着色，
 * 那些 inf 会被 `glsl_to8` 夹到 255 —— 但它们**根本不该被印出来**。
 * 所以这一格查的是：印出来的像素数正好等于覆盖数（不多一个），
 * 而且这一趟不会因为在不该走的地方算除零而变慢/变形。 */
{
  const frag = `${HEAD}out vec4 fragColor;\nvoid main() {\n`
    + '  float z = 0.0;\n  float v = 1.0 / z;\n  fragColor = vec4(v, 0.0, 0.0, 1.0);\n}\n';
  const r = draw(vertOf(HALF), frag, W, H);
  if (r.err !== undefined) bad('除零那一趟跑不动', `    ${r.err}`);
  else {
    const want = coverOf(HALF, W, H);
    if (r.pix.length !== want.size) {
      bad('印出来的像素数与覆盖数不等', `    覆盖 ${want.size}，印了 ${r.pix.length}`);
    } else {
      ok(`不覆盖的像素连片元都不调（覆盖 ${want.size} 个，印 ${r.pix.length} 个）`);
    }
  }
}

/* ---- 五、两个三角形拼一个方块：每个像素**正好一次**（不重不漏）。
 *
 * 这是填充规则的**定义性性质**，而且不用 GL 就验得了 —— 第八片那时候边上是 `>= 0`，
 * 共享的那条斜边会被两个三角形各画一遍，这条门就是来压它的。
 *
 * 「哪一侧归谁与 GL 是否一致」这一门**验不了**（要一台有 GL 的机器）。所以这里查的是
 * 不重不漏，而 ADR-0019 里明写着「与 GL 差一个整体翻转的可能性还没排除」。 */
{
  const T1 = [[-1, -1], [1, -1], [-1, 1]];
  const T2 = [[1, -1], [1, 1], [-1, 1]];
  const a = draw(vertOf(T1), FRAG_RED, W, H);
  const b = draw(vertOf(T2), FRAG_RED, W, H);
  if (a.err !== undefined || b.err !== undefined) bad('方块那两趟跑不动', `    ${a.err ?? b.err}`);
  else {
    const ka = a.pix.map((p) => `${p.x},${p.y}`);
    const kb = b.pix.map((p) => `${p.x},${p.y}`);
    const both = ka.filter((k) => kb.includes(k));
    const all = new Set([...ka, ...kb]);
    const missing = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) if (!all.has(`${x},${y}`)) missing.push(`${x},${y}`);
    }
    if (both.length > 0) {
      bad('两个三角形把共享边上的像素画了两遍', `    重了 ${both.length} 个：${both.slice(0, 8).join(' ')}`);
    } else if (missing.length > 0) {
      bad('两个三角形拼起来漏了像素', `    漏 ${missing.length} 个：${missing.slice(0, 8).join(' ')}`);
    } else {
      ok(`方块拼接：${ka.length} + ${kb.length} = ${W * H}，不重不漏（边上的归属只算一次）`);
    }
  }
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
