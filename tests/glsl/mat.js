// tests/glsl/mat.js —— 非方阵 `matCxR`（ADR-0019 第二十一片）
//
// `matCxR` 是 **C 列 R 行**（规范 5.6），摊平永远是列优先：第 c 列占 `c*R` 起那 R 格。
// 这一门查的就是「列与行没有弄反」—— 弄反了在方阵上看不出来（转置也是方阵），
// 所以非方阵才是能称出这一格的秤。
//
// 三条腿都跑，期望值由门自己按列优先算一遍。
//
//   node tests/glsl/mat.js

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
const OUT = join(tmpdir(), 'omni-glsl-mat');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

const gdiags = new Diagnostics();
const g = readGrammar(readSexpr(new SourceFile(GRAMMAR, readFileSync(GRAMMAR, 'utf8')), gdiags), gdiags);
gdiags.throwIfErrors();
const tb = buildTable(g);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

function lower(src) {
  const diags = new Diagnostics();
  const file = new SourceFile('probe.frag', src);
  const toks = lexText(g.lex, file, diags);
  diags.throwIfErrors();
  const tree = glrParse(tb, toks, diags);
  diags.throwIfErrors();
  return glslLower(glslCheck(tree, 'frag'));
}

const SHELL = (body) => `#version 330 core
out vec4 fragColor;
${body}
void main() { fragColor = vec4(probe(0), 0.0, 0.0, 1.0); }
`;

function runLeg(name, glsl, ks, extra) {
  const lib = lower(SHELL(glsl)).trimEnd();
  const driver = ks.map((k) => `    (print (call glsl_probe (int ${k})))`).join('\n');
  const sx = `${lib.slice(0, -1)}\n  (main\n${driver})\n)\n`;
  const p = join(OUT, `${name}.sx`);
  writeFileSync(p, sx);
  const r = spawnSync(process.execPath, [CLI, 'run', p, ...extra], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) return { err: (r.stderr ?? '').trim().split('\n').slice(0, 4).join('\n    ') };
  return { lines: r.stdout.trim().split('\n') };
}

function probe(name, glsl, ks, ref) {
  const want = ks.map((k) => String(ref(k)));
  for (const [tag, extra] of [['JS', []], ['C', ['--backend', 'c']], ['LLVM', ['--backend', 'llvm']]]) {
    const r = runLeg(`${name.replace(/[^\w]/g, '_')}-${tag}`, glsl, ks, extra);
    if (r.err !== undefined) { bad(`${name}［${tag} 腿］跑不动`, `    ${r.err}`); continue; }
    const diff = [];
    for (let i = 0; i < want.length; i++) {
      if (r.lines[i] !== want[i]) diff.push(`k=${ks[i]}：要 ${want[i]}，得 ${r.lines[i]}`);
    }
    if (diff.length > 0) bad(`${name}［${tag} 腿］`, diff.map((d) => `    ${d}`).join('\n'));
    else ok(`${name}［${tag} 腿］${want.length} 个数逐字节相同`);
  }
}

/* ---- 一、`mat2x3` 取列：长度是**行数**，不是列数 ------------------------------ */

probe('mat2x3[c] 是 vec3（列优先摊平）', `
float probe(int k) {
  mat2x3 m = mat2x3(1.0, 2.0, 3.0,   4.0, 5.0, 6.0);
  vec3 c0 = m[0];
  vec3 c1 = m[1];
  return c0.x * 1.0 + c0.y * 10.0 + c0.z * 100.0
    + c1.x * 1000.0 + c1.y * 10000.0 + c1.z * 100000.0;
}`, [0], () => 1 + 20 + 300 + 4000 + 50000 + 600000);

/* ---- 二、`matCxR * vecC` 出 `vecR` ------------------------------------------- */

probe('mat2x3 * vec2 = vec3', `
float probe(int k) {
  mat2x3 m = mat2x3(1.0, 2.0, 3.0,   4.0, 5.0, 6.0);
  vec2 v = vec2(2.0, 3.0);
  vec3 r = m * v;
  return r.x + r.y * 10.0 + r.z * 100.0;
}`, [0], () => {
  /* 列优先：第 0 列 (1,2,3)、第 1 列 (4,5,6)。r[row] = Σ_col m[col][row]*v[col] */
  const r = [1 * 2 + 4 * 3, 2 * 2 + 5 * 3, 3 * 2 + 6 * 3];
  return r[0] + r[1] * 10 + r[2] * 100;
});

/* ---- 三、`vecR * matCxR` 出 `vecC` ------------------------------------------- */

probe('vec3 * mat2x3 = vec2', `
float probe(int k) {
  mat2x3 m = mat2x3(1.0, 2.0, 3.0,   4.0, 5.0, 6.0);
  vec3 v = vec3(1.0, 2.0, 3.0);
  vec2 r = v * m;
  return r.x + r.y * 100.0;
}`, [0], () => {
  const r = [1 * 1 + 2 * 2 + 3 * 3, 1 * 4 + 2 * 5 + 3 * 6];
  return r[0] + r[1] * 100;
});

/* ---- 四、`matAxB * matCxD`（A == D）出 `matCxB` ------------------------------ */

probe('mat2x3 * mat3x2 = mat3x3', `
float probe(int k) {
  mat2x3 a = mat2x3(1.0, 2.0, 3.0,   4.0, 5.0, 6.0);
  mat3x2 b = mat3x2(1.0, 0.0,   0.0, 1.0,   2.0, 3.0);
  mat3 c = a * b;
  vec3 c0 = c[0];
  vec3 c1 = c[1];
  vec3 c2 = c[2];
  return c0.x + c0.y * 2.0 + c0.z * 4.0
    + c1.x * 8.0 + c1.y * 16.0 + c1.z * 32.0
    + c2.x * 64.0 + c2.y * 128.0 + c2.z * 256.0;
}`, [0], () => {
  /* a 是 2 列 3 行、b 是 3 列 2 行 -> c 是 3 列 3 行。
   * c[col][row] = Σ_i a[i][row] * b[col][i]
   * 下标一律写字面量：动态下标是施工图 B15，还没做（写成 `c[k]` 当场就被骂）。 */
  const a = [[1, 2, 3], [4, 5, 6]];        // a[col][row]
  const b = [[1, 0], [0, 1], [2, 3]];      // b[col][row]
  const w = [1, 2, 4, 8, 16, 32, 64, 128, 256];
  let s = 0;
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      s += (a[0][row] * b[col][0] + a[1][row] * b[col][1]) * w[col * 3 + row];
    }
  }
  return s;
});

/* ---- 五、`matCxR(x)` 的对角线（非方阵也只填 i == j 那几格） ------------------- */

probe('mat3x2(2.0) 只在对角线上填', `
float probe(int k) {
  mat3x2 m = mat3x2(2.0);
  vec2 c0 = m[0];
  vec2 c1 = m[1];
  vec2 c2 = m[2];
  return c0.x + c0.y * 2.0 + c1.x * 4.0 + c1.y * 8.0 + c2.x * 16.0 + c2.y * 32.0;
}`, [0], () => {
  const w = [1, 2, 4, 8, 16, 32];
  let s = 0;
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 2; row++) s += (col === row ? 2 : 0) * w[col * 2 + row];
  }
  return s;
});

/* ---- 六、`mat2x2` 与 `mat2` 是同一个类型 ------------------------------------- */

probe('mat2x2 就是 mat2', `
float probe(int k) {
  mat2x2 a = mat2(1.0, 2.0, 3.0, 4.0);
  mat2 b = a;
  vec2 c = b * vec2(1.0, 1.0);
  return c.x + c.y * 10.0;
}`, [0], () => (1 + 3) + (2 + 4) * 10);

/* ---- 七、该骂的明着骂 -------------------------------------------------------- */

function rejects(name, glsl, want) {
  let msg = null;
  try {
    lower(SHELL(glsl));
  } catch (e) {
    msg = String(e.message ?? e);
  }
  if (msg === null) bad(name, '    一声没骂就收下了');
  else if (!msg.includes(want)) bad(name, `    骂的是别的：${msg.split('\n')[0]}`);
  else ok(`${name}［${want}］`);
}

rejects('矩阵乘的内维对不上', `
float probe(int k) {
  mat2x3 a = mat2x3(1.0);
  mat2x3 b = mat2x3(1.0);
  mat3 c = a * b;
  return c[0].x;
}`, '尺寸不对');

rejects('mat2x3 * vec3 内维对不上', `
float probe(int k) {
  mat2x3 m = mat2x3(1.0);
  vec3 r = m * vec3(1.0, 2.0, 3.0);
  return r.x;
}`, '尺寸不对');

rejects('取列越界', `
float probe(int k) {
  mat2x3 m = mat2x3(1.0);
  return m[2].x;
}`, '只有 2 列');

rejects('构造格数不对', `
float probe(int k) {
  mat2x3 m = mat2x3(1.0, 2.0, 3.0, 4.0);
  return m[0].x;
}`, '要 6 格');

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
