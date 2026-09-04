// tests/glsl/examples.js —— GraphEq 的 31 个 preset 对着**真 GPU** 渲的参考图比像素
//
// 与别的 glsl 门不同的一点：这一门的尺子**在仓库外面**（`~/Downloads/GraphEq`），
// 拿不到就整门跳过（印一行说明，退 0）。`OMNI_GRAPHEQ` 可以指别处。
//
//   node tests/glsl/examples.js
//
// 一趟做的事：`gen_shader.mjs` 合成 `.frag` -> 我们的前端 -> 快路 -> PNG ->
// 与 `examples_256/<id>_glsl.png`（moderngl 在真 GPU 上渲的）逐像素比。
//
// **为什么不是全 0**：参考图那一侧的 GPU **把非规格数冲成 0**（GLSL ES 允许），
// 我们这一侧是 IEEE 的。着色器里的 `nextUp`/`nextDown` 在 0 上正是要造一个
// 非规格数（`intBitsToFloat(1)` / `intBitsToFloat(-2147483647)`），于是「像素边刚好
// 落在 0 上」的那一层像素上两边分类不同 —— 我们说 FRONTIER（区间宽了一点），
// GPU 说确定。差的那些像素**全在这一类**上，所以这儿钉的是**量出来的**每张预算，
// 不是一个拍出来的 ε。四张的差都在曲线/网格线上，见 ADR-0019。

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';

import { glslRenderToPng } from '../../src/core/frontend-glsl/render.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const GQ = process.env.OMNI_GRAPHEQ ?? join(process.env.HOME ?? '', 'Downloads', 'GraphEq');
const REF = join(GQ, 'examples_256');
const GEN = join(GQ, 'tools', 'gen_shader.mjs');
const MATH = join(GQ, 'html', 'grapheq-math.js');
const OUT = join(tmpdir(), 'omni-glsl-examples');
const SIZE = 256;

/* 参考图那一侧的颜色（`bench_cpu_vs_glsl.py` 的默认值）：黑 = 确定为真、白 = 确定为假、
 * `#d946ef` = 这个分辨率下判不了。 */
const COL = { inside: [0, 0, 0], outside: [1, 1, 1], frontier: [217 / 255, 70 / 255, 239 / 255] };

/**
 * 每张允许差多少个像素 —— **量出来的**，理由都是同一个（GPU 冲非规格数，见文件头）。
 * 没列的那些必须**逐字节相同**。
 */
const BUDGET = {
  lattice: 99,      // floor(x) = floor(y)：x 或 y 的像素边落在 0 上，floor 差 1
  'sin-roots': 510, // sin(x*y) > 0：x 的那一列区间过 0
  'sincos-gt': 250, // sin(x) * cos(y) > 0：同上
  'sincos-eq': 6,   // sin(x) + sin(y) = 0：和刚好为 0，i_add 造出非规格数
};

/**
 * 还没接进快路的内建 —— 明着列出来，比"跳过"诚实。
 *
 * **现在是空的**：`tan` 接上了（`llvm.tan`，LLVM 19 起有），`tan-sin` 于是也逐字节相同。
 * 这张表留着 —— 下一个缺口填进来就有地方放，而且填上之后这一门会红着提醒挪走。
 */
const NYI = {};

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

if (!existsSync(REF) || !existsSync(GEN) || !existsSync(MATH)) {
  process.stdout.write(`跳过：找不到 GraphEq（${GQ}）——`
    + ' 这一门的尺子在仓库外面，OMNI_GRAPHEQ 可以指别处\n');
  process.exit(0);
}

/** 解 PNG：8 位 RGBA，四种滤波都要会（参考图用了 Sub/Up/Paeth）。 */
function pngRgba(path) {
  const d = readFileSync(path);
  let i = 8;
  let w = 0;
  let h = 0;
  const parts = [];
  while (i < d.length) {
    const ln = d.readUInt32BE(i);
    const ty = d.subarray(i + 4, i + 8).toString('latin1');
    if (ty === 'IHDR') {
      w = d.readUInt32BE(i + 8);
      h = d.readUInt32BE(i + 12);
      if (d[i + 16] !== 8 || d[i + 17] !== 6) throw new Error(`${path}: 只认 8 位 RGBA`);
    }
    if (ty === 'IDAT') parts.push(d.subarray(i + 8, i + 8 + ln));
    i += 12 + ln;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = w * 4;
  const out = Buffer.alloc(stride * h);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[pos];
    pos++;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    raw.copy(cur, 0, pos, pos + stride);
    pos += stride;
    const prev = y === 0 ? Buffer.alloc(stride) : out.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? cur[x - 4] : 0;
      const b = prev[x];
      const c = x >= 4 ? prev[x - 4] : 0;
      if (f === 1) cur[x] = (cur[x] + a) & 255;
      else if (f === 2) cur[x] = (cur[x] + b) & 255;
      else if (f === 3) cur[x] = (cur[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        cur[x] = (cur[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      } else if (f !== 0) throw new Error(`${path}: 认不出滤波 ${f}`);
    }
  }
  return { w, h, px: out };
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/* PRESETS 那份是 CommonJS（`module.exports = …`），所以要走 `default`。 */
const mod = await import(MATH);
const presets = (mod.default ?? mod).PRESETS;
if (!Array.isArray(presets)) {
  bad('取 PRESETS', '    grapheq-math.js 没给出 PRESETS');
  process.exit(1);
}
ok(`取到 ${presets.length} 个 preset`);

let exact = 0;
let budgeted = 0;
for (const p of presets) {
  const frag = join(OUT, `${p.id}.frag`);
  const meta = join(OUT, `${p.id}.json`);
  const argv = ['--formula', p.formula, '--output', frag, '--json', meta];
  if (p.viewport) {
    argv.push('--viewport', [p.viewport.left, p.viewport.right, p.viewport.bottom, p.viewport.top].join(','));
  }
  const g = spawnSync('node', [GEN, ...argv], { encoding: 'utf8' });
  if (g.status !== 0) {
    bad(`${p.id}：合成着色器`, `    ${(g.stderr ?? '').trim().split('\n').slice(0, 2).join('\n    ')}`);
    continue;
  }
  const vp = JSON.parse(readFileSync(meta, 'utf8')).viewport;
  const png = join(OUT, `${p.id}.png`);
  const set = {
    u_resolution: [SIZE, SIZE],
    u_viewport: [vp.left, vp.right, vp.bottom, vp.top],
    u_colInside: COL.inside,
    u_colOutside: COL.outside,
    u_colFrontier: COL.frontier,
  };
  let err = null;
  try {
    glslRenderToPng(root, frag, png, SIZE, SIZE, set, process.env.OMNI_CC ?? 'cc',
      (k) => process.env[k]);
  } catch (e) {
    err = e.message.split('\n')[0];
  }
  /* 还没接的内建：门要的是**那句话没变**，而不是悄悄跳过。 */
  if (NYI[p.id] !== undefined) {
    if (err !== null && err.includes(NYI[p.id])) ok(`${p.id}：还没接 ${NYI[p.id]}（记着的缺口）`);
    else bad(`${p.id}：本该报「还没接 ${NYI[p.id]}」`, `    实际：${err ?? '编出来了'}`);
    continue;
  }
  if (err !== null) {
    bad(`${p.id}：渲不出来`, `    ${err}`);
    continue;
  }
  const ref = join(REF, `${p.id}_glsl.png`);
  if (!existsSync(ref)) {
    bad(`${p.id}：没有参考图`, `    ${ref}`);
    continue;
  }
  const a = pngRgba(png);
  const b = pngRgba(ref);
  if (a.w !== b.w || a.h !== b.h) {
    bad(`${p.id}：尺寸不一样`, `    ${a.w}x${a.h} vs ${b.w}x${b.h}`);
    continue;
  }
  let diff = 0;
  for (let i = 0; i < a.px.length; i += 4) {
    if (a.px[i] !== b.px[i] || a.px[i + 1] !== b.px[i + 1] || a.px[i + 2] !== b.px[i + 2]) diff++;
  }
  const budget = BUDGET[p.id] ?? 0;
  if (diff > budget) {
    bad(`${p.id}：差 ${diff} 个像素 > 预算 ${budget}`,
      `    ${p.formula}\n    我们的 ${png}\n    参考的 ${ref}`);
  } else if (budget === 0) {
    exact++;
    ok(`${p.id}：与真 GPU **逐字节相同**（${p.formula}）`);
  } else {
    budgeted++;
    ok(`${p.id}：差 ${diff} ≤ 预算 ${budget}（GPU 冲非规格数）（${p.formula}）`);
  }
}

process.stdout.write(`\n逐字节相同 ${exact} 张，带预算 ${budgeted} 张\n`);
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
