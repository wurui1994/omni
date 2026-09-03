// tests/glsl/interp.js —— 顶点着色器与插值（ADR-0019 第一刀第七片）
//
// 五件事：
//
//   一、varying 插得对。探针挑的是**能手算**的那一种：全屏三角形上
//      `v_uv = p*0.5+0.5` 在三个顶点是 (0,0)/(2,0)/(0,2)，而它们的窗口坐标是
//      (0,0)/(2W,0)/(0,2H) —— 于是插出来精确等于 `gl_FragCoord.xy / 分辨率`。
//      期望值因此可以逐像素手算，不必抄实现的输出。
//   二、`flat` 取**第三个**顶点（GL 4.x 默认 provoking vertex 是 last）。
//   三、透视校正**真的接上了**：`w` 全是 1 时 `smooth` 与 `noperspective` 逐字节相同，
//      `w` 不全是 1 时两者**必须不同**。后一条是关键 —— 少了它，「透视校正」可以是摆设。
//   四、两条腿（JS / C）的 8 位像素相同。
//   五、第二档那份完整的 `pretty.frag` + `pretty-vert.vert` 跑得动。
//
//   node tests/glsl/interp.js

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
const CASES = join(here, 'cases');
const OUT = join(tmpdir(), 'omni-glsl-interp');

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
/** 顶点 + 片元 -> 跑出来的那一串数。 */
function draw(vert, frag, w, h, uni = {}, backend = []) {
  seq++;
  const vm = check(vert, 'vert', 'probe.vert');
  const fm = check(frag, 'frag', 'probe.frag');
  const p = join(OUT, `p${seq}.sx`);
  writeFileSync(p, glslTriProgram(vm, fm, w, h, uni));
  const r = spawnSync(process.execPath, [CLI, 'run', p, ...backend],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) return { err: (r.stderr ?? '').trim().split('\n').slice(0, 5).join('\n    ') };
  return { out: r.stdout.trim(), nums: r.stdout.trim().split('\n').map(Number) };
}

const HEAD = '#version 330 core\n';
/** 全屏三角形 —— 与两份尺子里那一份逐字相同的形状。 */
const TRI = 'vec2 p = vec2(\n'
  + '    (gl_VertexID == 1) ? 3.0 : -1.0,\n'
  + '    (gl_VertexID == 2) ? 3.0 : -1.0\n'
  + '  );\n';

const W = 6;
const H = 4;

/* ---- 一、varying 插得对（逐像素手算）。 */
{
  const vert = `${HEAD}out vec2 v_uv;\nvoid main() {\n  ${TRI}`
    + '  v_uv = p * 0.5 + 0.5;\n  gl_Position = vec4(p, 0.0, 1.0);\n}\n';
  const frag = `${HEAD}in vec2 v_uv;\nout vec4 fragColor;\n`
    + 'void main() { fragColor = vec4(v_uv, 0.0, 1.0); }\n';
  const r = draw(vert, frag, W, H);
  if (r.err !== undefined) bad('varying 那一趟跑不动', `    ${r.err}`);
  else {
    const to8 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
    const off = [];
    for (let i = 0; i + 4 < r.nums.length; i += 5) {
      const x = r.nums[i];
      const y = r.nums[i + 1];
      const want = [to8((x + 0.5) / W), to8((y + 0.5) / H), 0];
      const got = [r.nums[i + 2], r.nums[i + 3], r.nums[i + 4]];
      if (want.join() !== got.join()) off.push(`(${x},${y}) 要 ${want.join()}，得 ${got.join()}`);
    }
    if (r.nums.length !== W * H * 5) {
      bad('varying：像素个数不对', `    要 ${W * H * 5} 个数，得 ${r.nums.length}`);
    } else if (off.length > 0) {
      bad('varying 插出来的值不对', `    ${off.slice(0, 5).join('\n    ')}`);
    } else {
      ok(`varying：${W * H} 个像素插出来精确等于 gl_FragCoord.xy / 分辨率（手算的）`);
    }
  }
}

/* ---- 二、`flat` 取第三个顶点。 */
{
  const vert = `${HEAD}flat out float k;\nvoid main() {\n  ${TRI}`
    + '  k = float(gl_VertexID);\n  gl_Position = vec4(p, 0.0, 1.0);\n}\n';
  const frag = `${HEAD}flat in float k;\nout vec4 fragColor;\n`
    + 'void main() { fragColor = vec4(k / 4.0, 0.0, 0.0, 1.0); }\n';
  const r = draw(vert, frag, 4, 4);
  if (r.err !== undefined) bad('flat 那一趟跑不动', `    ${r.err}`);
  else {
    /* k = 2（第三个顶点），2/4 = 0.5 -> round(0.5*255) = 128。 */
    const rs = [];
    for (let i = 0; i + 4 < r.nums.length; i += 5) rs.push(r.nums[i + 2]);
    const wrong = rs.filter((v) => v !== 128);
    if (wrong.length > 0) {
      bad('flat 取的不是第三个顶点', `    该全是 128（k=2），实际有 ${wrong.length} 个不是：`
        + `${[...new Set(rs)].join(' ')}`);
    } else ok(`flat：${rs.length} 个像素全取第三个顶点的值（GL 的 provoking vertex 是 last）`);
  }
}

/* ---- 三、透视校正真的接上了。 */
{
  /* 顶点的窗口位置**不变**（clip.xy 跟着乘 w），只有 w 不同 —— 于是线性与透视校正
   * 只在「除不除 oow」上分岔。 */
  const vertW = (persp) => `${HEAD}${persp ? '' : 'noperspective '}out vec2 v_uv;\n`
    + `void main() {\n  ${TRI}`
    + '  float w = (gl_VertexID == 2) ? 2.0 : 1.0;\n'
    + '  v_uv = p * 0.5 + 0.5;\n  gl_Position = vec4(p * w, 0.0, w);\n}\n';
  const fragW = (persp) => `${HEAD}${persp ? '' : 'noperspective '}in vec2 v_uv;\n`
    + 'out vec4 fragColor;\nvoid main() { fragColor = vec4(v_uv, 0.0, 1.0); }\n';
  const sm = draw(vertW(true), fragW(true), 8, 8);
  const li = draw(vertW(false), fragW(false), 8, 8);
  if (sm.err !== undefined || li.err !== undefined) {
    bad('透视那两趟跑不动', `    ${sm.err ?? li.err}`);
  } else if (sm.out === li.out) {
    bad('w 不全是 1 时 smooth 与 noperspective 竟然一样',
      '    那说明透视校正是摆设（该除的那一下没除）');
  } else {
    ok('w 不全是 1 时 smooth 与 noperspective 不同（透视校正真的在做事）');
  }
  /* w 全是 1 时两者必须**逐字节相同** —— 透视公式退化成线性，这是它的定义。 */
  const vert1 = (persp) => `${HEAD}${persp ? '' : 'noperspective '}out vec2 v_uv;\n`
    + `void main() {\n  ${TRI}  v_uv = p * 0.5 + 0.5;\n  gl_Position = vec4(p, 0.0, 1.0);\n}\n`;
  const a = draw(vert1(true), fragW(true), 8, 8);
  const b = draw(vert1(false), fragW(false), 8, 8);
  if (a.err !== undefined || b.err !== undefined) {
    bad('w=1 那两趟跑不动', `    ${a.err ?? b.err}`);
  } else if (a.out !== b.out) {
    const x = a.out.split('\n');
    const y = b.out.split('\n');
    let i = 0;
    while (i < x.length && x[i] === y[i]) i++;
    bad('w 全是 1 时两者竟然不同', `    第 ${i} 个数：smooth ${x[i]} / linear ${y[i]}`);
  } else {
    ok('w 全是 1 时 smooth 与 noperspective 逐字节相同（透视公式退化成线性）');
  }
}

/* ---- 四、两条腿。 */
{
  const vert = `${HEAD}out vec2 v_uv;\nvoid main() {\n  ${TRI}`
    + '  v_uv = p * 0.5 + 0.5;\n  gl_Position = vec4(p, 0.0, 1.0);\n}\n';
  const frag = `${HEAD}in vec2 v_uv;\nout vec4 fragColor;\n`
    + 'void main() { fragColor = vec4(sin(v_uv.x * 3.0), v_uv.y, 0.0, 1.0); }\n';
  const js = draw(vert, frag, 8, 8);
  const c = draw(vert, frag, 8, 8, {}, ['--backend', 'c']);
  if (js.err !== undefined || c.err !== undefined) bad('两条腿那一趟跑不动', `    ${js.err ?? c.err}`);
  else if (js.out !== c.out) bad('两条腿的 8 位像素不一样', '    （8 位那一层本该把最后一位的差抹掉）');
  else ok('C 腿与 JS 腿的 8 位像素相同（含 sin 与插值）');
}

/* ---- 五、第二档那份完整的着色器。 */
{
  const vert = readFileSync(join(CASES, 'pretty-vert.vert'), 'utf8');
  const frag = readFileSync(join(CASES, 'pretty.frag'), 'utf8');
  const r = draw(vert, frag, 8, 8, { u_res: [8, 8], u_time: [0.5] });
  if (r.err !== undefined) bad('pretty（第二档完整那份）跑不动', `    ${r.err}`);
  else if (r.nums.length !== 8 * 8 * 5) {
    bad('pretty 的像素个数不对', `    要 ${8 * 8 * 5} 个数，得 ${r.nums.length}`);
  } else {
    const bads = r.nums.filter((v) => !Number.isFinite(v) || v < 0 || v > 255);
    if (bads.length > 0) bad('pretty 有不成形的 8 位值', `    ${bads.slice(0, 5).join(' ')}`);
    else {
      /* 这一格只查「跑得动、值在范围里、而且不是一片死黑」——像素对不对要与
       * llvmpipe 比，而那台机器还没有（ADR-0019 待办第 9 条）。 */
      let sum = 0;
      for (let i = 0; i + 4 < r.nums.length; i += 5) sum += r.nums[i + 2] + r.nums[i + 3] + r.nums[i + 4];
      if (sum === 0) bad('pretty 画出来一片全黑', '    那八成是插值或 uniform 接错了');
      else ok(`pretty（hex 网格 + 发光圆 + hsv2rgb + 色调曲线）8×8 跑通，像素和 ${sum}`);
    }
  }
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
