// tests/glsl/render.js —— 把画布扫一遍（按 quad）（ADR-0019 第一刀第四片）
//
// 查四件事：
//
//   一、`w*h` 个像素**一个不少、一个不多**，每个正好印一次
//   二、印出来的**次序就是 quad 次序**（llvmpipe 的 `quad_offset_x/y`：左上 右上 左下 右下），
//      这是决策一第二条 —— 现在虽然一次只算一个片元，顺序也要定死
//   三、宽高不是 2 的倍数时边上那些多算的格子**不印**（6×5 是故意挑的奇数）
//   四、8 位的值与门自己独立算的一致（`round(clamp(v,0,1)*255)`）
//
//   node tests/glsl/render.js

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
import { glslProgram } from '../../src/core/frontend-glsl/lower.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const GRAMMAR = join(root, 'src', 'core', 'frontend-glsl', 'glsl.grammar');
const CASES = join(here, 'cases');
const OUT = join(tmpdir(), 'omni-glsl-render');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

const gdiags = new Diagnostics();
const g = readGrammar(readSexpr(new SourceFile(GRAMMAR, readFileSync(GRAMMAR, 'utf8')), gdiags), gdiags);
gdiags.throwIfErrors();
const tb = buildTable(g);

const W = 6;
const H = 5;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const src = readFileSync(join(CASES, 'bench-simple.frag'), 'utf8');
const diags = new Diagnostics();
const toks = lexText(g.lex, new SourceFile('bench-simple.frag', src), diags);
diags.throwIfErrors();
const mod = glslCheck(glrParse(tb, toks, diags), 'frag');
const prog = glslProgram(mod, W, H, { u_resolution: [W, H] });
const path = join(OUT, 'render.sx');
writeFileSync(path, prog);

const r = spawnSync(process.execPath, [CLI, 'run', path], { encoding: 'utf8', maxBuffer: 1 << 26 });
if (r.status !== 0) {
  bad('跑不动', `    ${(r.stderr ?? '').trim().split('\n').slice(0, 6).join('\n    ')}`);
  process.stdout.write(`\n${pass} passed, ${fail + 1} failed\n`);
  process.exit(1);
}
const nums = r.stdout.trim().split('\n').map((s) => Number(s));

/* 一、行数：一个像素五个数。 */
if (nums.length !== W * H * 5) {
  bad('印出来的数不是 w*h*5', `    要 ${W * H * 5}，得 ${nums.length}`);
} else {
  ok(`${W}×${H} 印出 ${nums.length} 个数（一个像素五个）`);
}

const pix = [];
for (let i = 0; i + 4 < nums.length; i += 5) {
  pix.push({ x: nums[i], y: nums[i + 1], r: nums[i + 2], g: nums[i + 3], b: nums[i + 4] });
}

/* 二、每个像素正好一次。 */
{
  const seen = new Map();
  for (const p of pix) {
    const k = `${p.x},${p.y}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const dup = [...seen].filter(([, n]) => n !== 1);
  const missing = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!seen.has(`${x},${y}`)) missing.push(`${x},${y}`);
  const outside = pix.filter((p) => p.x < 0 || p.x >= W || p.y < 0 || p.y >= H);
  if (dup.length > 0 || missing.length > 0 || outside.length > 0) {
    bad('像素不是一个不少一个不多', `    重复 ${dup.length}、少 ${missing.join(' ')}、`
      + `出界 ${outside.map((p) => `${p.x},${p.y}`).join(' ')}`);
  } else {
    ok(`${W * H} 个像素每个正好印一次，没有出界的（6×5 是奇数，边上的 quad 多算但不印）`);
  }
}

/* 三、次序就是 quad 次序。 */
{
  const want = [];
  for (let qy = 0; qy < Math.ceil(H / 2) * 2; qy += 2) {
    for (let qx = 0; qx < Math.ceil(W / 2) * 2; qx += 2) {
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const x = qx + dx;
        const y = qy + dy;
        if (x < W && y < H) want.push(`${x},${y}`);
      }
    }
  }
  const got = pix.map((p) => `${p.x},${p.y}`);
  if (got.join(' ') !== want.join(' ')) {
    let i = 0;
    while (i < got.length && got[i] === want[i]) i++;
    bad('次序不是 quad 次序', `    第 ${i} 个起不一样\n    want ${want.slice(i, i + 8).join(' ')}\n`
      + `    got  ${got.slice(i, i + 8).join(' ')}`);
  } else {
    ok('次序就是 quad 次序（左上 右上 左下 右下，quad 之间按行）');
  }
}

/* 四、8 位的值。 */
{
  const to8 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  const off = [];
  for (const p of pix) {
    const uvx = (p.x + 0.5) / W;
    const uvy = (p.y + 0.5) / H;
    const c = [uvx, uvy, uvx].map((v, k) => 0.5 + 0.5 * Math.cos(v * 3.0 + [0, 2, 4][k]));
    const want = [to8(c[0]), to8(c[1]), to8(c[2])];
    if (p.r !== want[0] || p.g !== want[1] || p.b !== want[2]) {
      off.push(`(${p.x},${p.y}) 要 ${want.join(',')}，得 ${p.r},${p.g},${p.b}`);
    }
  }
  if (off.length > 0) bad('8 位的值不对', `    ${off.slice(0, 5).join('\n    ')}`);
  else ok(`${pix.length} 个像素的 8 位值与门自己算的相同（round(clamp(v,0,1)*255)）`);
}

/* 五、C 腿印出来的与 JS 腿**逐字节相同**。8 位那一步把最后一位的差抹掉了 ——
 * 于是「超越函数只到容差」这件事在**像素**这一层反而是逐字节的。这一条值得单列。 */
{
  const rc = spawnSync(process.execPath, [CLI, 'run', path, '--backend', 'c'],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (rc.status !== 0) {
    bad('C 腿跑不动', `    ${(rc.stderr ?? '').trim().split('\n').slice(0, 4).join('\n    ')}`);
  } else if (rc.stdout.trim() !== r.stdout.trim()) {
    const a = r.stdout.trim().split('\n');
    const b = rc.stdout.trim().split('\n');
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    bad('两条腿的 8 位像素不一样', `    第 ${i} 个数起：js ${a[i]} / c ${b[i]}`);
  } else {
    ok('C 腿与 JS 腿的 8 位像素逐字节相同（8 位那一步把最后一位的差抹掉了）');
  }
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
