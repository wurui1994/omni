// tests/glsl/render.js —— 把画布扫一遍（按 quad）（ADR-0019 第一刀第四片）
//
// 查五件事：
//
//   一、`w*h` 个像素**一个不少、一个不多**，每个正好印一次
//   二、印出来的**次序就是 quad 次序**（llvmpipe 的 `quad_offset_x/y`：左上 右上 左下 右下），
//      这是决策一第二条 —— 现在虽然一次只算一个片元，顺序也要定死
//   三、宽高不是 2 的倍数时边上那些多算的格子**不印**（6×5 是故意挑的奇数）
//   四、8 位的值与门自己独立算的一致（`round(clamp(v,0,1)*255)`）
//   五、C 腿与 LLVM 腿印出来的与 JS 腿逐字节相同
//
//   node tests/glsl/render.js

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

/* 表走带缓存的装载（ADR-0019 决策八第 1 步）：构表在这份语法上是 559 ms、
 * 命中缓存是 8 ms。十四支门各构一遍表，等于每跑一趟全套白花 14 × 559 ms。 */
const { g, tb } = loadGrammarTable(GRAMMAR);

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

/* 五、另外两条腿印出来的与 JS 腿**逐字节相同**。8 位那一步把最后一位的差抹掉了 ——
 * 于是「超越函数只到容差」这件事在**像素**这一层反而是逐字节的。这一条值得单列。
 *
 * LLVM 腿在这里与 C 腿同级（`tests/sexpr/run.js` 那五条腿里它就是 `run-llvm`）。
 * 它值得单查，因为它是唯一一条**向量是原生 `<N x T>`** 的腿 ——
 * 见 ADR-0019「量：向量在五条腿上分别落成什么」。以后 SoA 那一刀先在这条腿上兑现，
 * 这一条就是它的基线：换了表示，像素还得逐字节相同。 */
for (const [tag, extra] of [['C', ['--backend', 'c']], ['LLVM', ['--backend', 'llvm']]]) {
  const rc = spawnSync(process.execPath, [CLI, 'run', path, ...extra],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (rc.status !== 0) {
    bad(`${tag} 腿跑不动`, `    ${(rc.stderr ?? '').trim().split('\n').slice(0, 4).join('\n    ')}`);
  } else if (rc.stdout.trim() !== r.stdout.trim()) {
    const a = r.stdout.trim().split('\n');
    const b = rc.stdout.trim().split('\n');
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    bad(`${tag} 腿与 JS 腿的 8 位像素不一样`, `    第 ${i} 个数起：js ${a[i]} / ${tag} ${b[i]}`);
  } else {
    ok(`${tag} 腿与 JS 腿的 8 位像素逐字节相同（8 位那一步把最后一位的差抹掉了）`);
  }
}

/* 六、`discard`（ADR-0019 那一节）：**被杀的像素一个都不印**。
 *
 * 用的是 `cases/vispy-clip.frag`（视口 (32,32,64,64) + 圆心 (64,64) 半径 40，两处
 * discard，一处在用户函数里）。这一支盯三件事：
 *   - 活下来的像素集合与门自己算的**一模一样**（多印一个是"kill 没生效"、少印一个是
 *     "kill 粘住了" —— 后者正是那格模块级 `glsl_killed` 忘了每个像素清零的指纹）；
 *   - 剩下的像素颜色对（填充色量化成 38,140,242）；
 *   - C 腿与 LLVM 腿与 JS 腿逐字节相同。
 *
 * 128×128 是例子里那些常量定的（视口与半径都是绝对像素），所以这一支不缩小画布。 */
{
  const DW = 128;
  const DH = 128;
  const dsrc = readFileSync(join(CASES, 'vispy-clip.frag'), 'utf8');
  const dd = new Diagnostics();
  const dtoks = lexText(g.lex, new SourceFile('vispy-clip.frag', dsrc), dd);
  dd.throwIfErrors();
  const dmod = glslCheck(glrParse(tb, dtoks, dd), 'frag');
  const dpath = join(OUT, 'discard.sx');
  writeFileSync(dpath, glslProgram(dmod, DW, DH, {}));
  const dr = spawnSync(process.execPath, [CLI, 'run', dpath], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (dr.status !== 0) {
    bad('discard 那一支跑不动', `    ${(dr.stderr ?? '').trim().split('\n').slice(0, 6).join('\n    ')}`);
  } else {
    const dn = dr.stdout.trim() === '' ? [] : dr.stdout.trim().split('\n').map(Number);
    /* 门自己算一遍"谁活着"：与着色器里那两句同一份判据。 */
    const want = new Set();
    for (let y = 0; y < DH; y++) {
      for (let x = 0; x < DW; x++) {
        const fx = x + 0.5;
        const fy = y + 0.5;
        if (fx < 32 || fx > 96 || fy < 32 || fy > 96) continue;
        if (Math.hypot(fx - 64, fy - 64) > 40) continue;
        want.add(`${x},${y}`);
      }
    }
    const got = new Set();
    let wrongColor = null;
    for (let i = 0; i + 4 < dn.length; i += 5) {
      got.add(`${dn[i]},${dn[i + 1]}`);
      if (wrongColor === null && (dn[i + 2] !== 38 || dn[i + 3] !== 140 || dn[i + 4] !== 242)) {
        wrongColor = `(${dn[i]},${dn[i + 1]}) 是 ${dn[i + 2]},${dn[i + 3]},${dn[i + 4]}`;
      }
    }
    const extraPix = [...got].filter((k) => !want.has(k));
    const missPix = [...want].filter((k) => !got.has(k));
    if (dn.length % 5 !== 0) {
      bad('discard：印出来的数不是 5 的倍数', `    ${dn.length} 个`);
    } else if (extraPix.length > 0 || missPix.length > 0) {
      bad('discard 掉的像素集合不对', `    多印了 ${extraPix.length} 个（${extraPix.slice(0, 4).join(' ')}）、`
        + `少印了 ${missPix.length} 个（${missPix.slice(0, 4).join(' ')}）`);
    } else if (wrongColor !== null) {
      bad('discard：活下来的像素颜色不对', `    ${wrongColor}（要 38,140,242）`);
    } else {
      ok(`discard：${DW}×${DH} 里活下来 ${got.size} 个像素，与门自己算的一模一样`);
    }
    for (const [tag, extraArgs] of [['C', ['--backend', 'c']], ['LLVM', ['--backend', 'llvm']]]) {
      const rc = spawnSync(process.execPath, [CLI, 'run', dpath, ...extraArgs],
        { encoding: 'utf8', maxBuffer: 1 << 26 });
      if (rc.status !== 0) {
        bad(`discard：${tag} 腿跑不动`, `    ${(rc.stderr ?? '').trim().split('\n').slice(0, 4).join('\n    ')}`);
      } else if (rc.stdout.trim() !== dr.stdout.trim()) {
        bad(`discard：${tag} 腿与 JS 腿不一样`, '    活下来的像素或颜色对不上');
      } else {
        ok(`discard：${tag} 腿与 JS 腿逐字节相同`);
      }
    }
  }
}

/* 七、导数那三条（规范 8.9）：`dFdx` / `dFdy` / `fwidth`。
 *
 * 用的是 `cases/deriv-quad.frag`（r 与 g 是非线性的、b 是线性的 —— 见那份的头注）。
 * 这一支盯的是**按 quad 差分**这条：门自己按 quad 的左列 / 下行算一遍，与印出来的比。
 * 参考腿在这一格上的落法与快路完全不同（那边一次 shufflevector，这边"再跑一趟探邻居"），
 * 所以三条腿逐字节相同这件事在这儿格外值钱。 */
{
  const DW = 8;
  const DH = 8;
  const gsrc = readFileSync(join(CASES, 'deriv-quad.frag'), 'utf8');
  const gd = new Diagnostics();
  const gtoks = lexText(g.lex, new SourceFile('deriv-quad.frag', gsrc), gd);
  gd.throwIfErrors();
  const gmod = glslCheck(glrParse(tb, gtoks, gd), 'frag');
  const gpath = join(OUT, 'deriv.sx');
  writeFileSync(gpath, glslProgram(gmod, DW, DH, {}));
  const gr = spawnSync(process.execPath, [CLI, 'run', gpath], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (gr.status !== 0) {
    bad('导数那一支跑不动', `    ${(gr.stderr ?? '').trim().split('\n').slice(0, 6).join('\n    ')}`);
  } else {
    const to8 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
    const gn = gr.stdout.trim().split('\n').map(Number);
    const off = [];
    for (let i = 0; i + 4 < gn.length; i += 5) {
      const x = gn[i];
      const y = gn[i + 1];
      /* quad 的左列与下行（`gl_FragCoord` 的中心是 +0.5）。 */
      const qx = x - (x % 2);
      const qy = y - (y % 2);
      const wantR = to8((((qx + 1.5) * (qx + 1.5)) - ((qx + 0.5) * (qx + 0.5))) / 256);
      const wantG = to8((((qy + 1.5) * (qy + 1.5)) - ((qy + 0.5) * (qy + 0.5))) / 256);
      const wantB = to8(1 / 8);
      if (gn[i + 2] !== wantR || gn[i + 3] !== wantG || gn[i + 4] !== wantB) {
        off.push(`(${x},${y}) 要 ${wantR},${wantG},${wantB}，得 ${gn[i + 2]},${gn[i + 3]},${gn[i + 4]}`);
      }
    }
    if (gn.length !== DW * DH * 5) {
      bad('导数：印出来的数不对', `    要 ${DW * DH * 5} 个，得 ${gn.length}`);
    } else if (off.length > 0) {
      bad('导数按 quad 差分这一条不对', `    ${off.slice(0, 4).join('\n    ')}`);
    } else {
      ok(`导数：${DW}×${DH} 每个像素的 dFdx/dFdy/fwidth 都与门自己按 quad 算的相同`);
    }
    for (const [tag, extraArgs] of [['C', ['--backend', 'c']], ['LLVM', ['--backend', 'llvm']]]) {
      const rc = spawnSync(process.execPath, [CLI, 'run', gpath, ...extraArgs],
        { encoding: 'utf8', maxBuffer: 1 << 26 });
      if (rc.status !== 0) {
        bad(`导数：${tag} 腿跑不动`, `    ${(rc.stderr ?? '').trim().split('\n').slice(0, 4).join('\n    ')}`);
      } else if (rc.stdout.trim() !== gr.stdout.trim()) {
        bad(`导数：${tag} 腿与 JS 腿不一样`, '    8 位像素对不上');
      } else {
        ok(`导数：${tag} 腿与 JS 腿逐字节相同`);
      }
    }
  }
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
