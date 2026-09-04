#!/usr/bin/env node
// Omni — vispy 那套绘图接口的**最小例子**门（ADR-0019）
//
// 三份例子在 `cases/vispy-*.frag`，各复刻 vispy 的一组接口（BSD 许可）：
//   vispy-disc      markers/disc.glsl + antialias/filled.glsl —— 距离场 + 单边抗锯齿
//   vispy-stroke    markers/ring.glsl + antialias/stroke.glsl —— 取绝对值 + 双边抗锯齿
//   vispy-colormap  colormaps/hot.glsl + colormaps/util.glsl —— **函数重载**那一刀的见证
//
// 为什么是复刻而不是 `#include` 真的那几份：门要在没装 vispy 的机器上也能跑。
// 「真的拿 vispy 那 102 份过一遍」是隔壁 `vispy.js` 的事，那一支没装就跳过。
//
// 查的是**语义像素**而不是快照：一张参考图会把「哪个版本的抗锯齿」也钉死，而这三份
// 例子要的是「画出来的东西对不对」——圆心在圆里、角在圆外、渐变两头是 under/over。
// 所以每份挑三个点，按 llvmpipe 那套 8 位量化（`round(clamp(v,0,1)*255)`）比。
//
//   node tests/glsl/vispy_draw.js

import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const CASES = join(here, 'cases');
const OUT = join(tmpdir(), 'omni-glsl-vispy-draw');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/** 8 位 RGBA 的 PNG -> {w, h, px}。只认我们自己写出来的那一种（无隔行、filter 0/1/2/3/4）。 */
function pngRead(path) {
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
  const px = Buffer.alloc(stride * h);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[pos];
    pos++;
    const cur = px.subarray(y * stride, (y + 1) * stride);
    raw.copy(cur, 0, pos, pos + stride);
    pos += stride;
    const prev = y === 0 ? Buffer.alloc(stride) : px.subarray((y - 1) * stride, y * stride);
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
      }
    }
  }
  return { w, h, px };
}

/** 渲一份。`omni run x.frag -o png --size N` 就是决策九那条路。 */
function render(name, size, extra) {
  const out = join(OUT, `${name}.png`);
  const r = spawnSync(process.execPath,
    [CLI, 'run', join(CASES, `${name}.frag`), '-o', out, '--size', String(size),
      ...(extra === undefined ? [] : extra)],
    { encoding: 'utf8' });
  if (r.status !== 0) throw new Error((r.stderr ?? '').trim().split('\n')[0]);
  return pngRead(out);
}

/** 一个点的四个通道。y 按图像坐标（上到下）—— PNG 的行序就是这个。 */
const at = (img, x, y) => {
  const o = (y * img.w + x) * 4;
  return [img.px[o], img.px[o + 1], img.px[o + 2], img.px[o + 3]];
};

const near = (got, want, tol) => got.every((v, i) => Math.abs(v - want[i]) <= tol);

/**
 * 一份例子：渲出来，再逐点比。
 * @param {string} name 例子名
 * @param {number} size 画布边长
 * @param {[number, number, number[], string][]} probes `[x, y, 期望 RGBA, 这个点是什么]`
 * @param {string[]} [extra] 额外的命令行参数（`--set` / `--tex` 那些）
 */
function draw(name, size, probes, extra) {
  let img = null;
  try { img = render(name, size, extra); } catch (e) { bad(name, `    ${e.message}`); return; }
  if (img.w !== size || img.h !== size) {
    bad(name, `    画布是 ${img.w}×${img.h}，要 ${size}×${size}`);
    return;
  }
  for (const [x, y, want, what] of probes) {
    const got = at(img, x, y);
    if (!near(got, want, 1)) {
      bad(`${name} 的 (${x},${y})：${what}`, `    要 ${want.join(',')}，给 ${got.join(',')}`);
      return;
    }
  }
  ok(`${name}：${probes.length} 个取样点都对（${size}×${size}）`);
}

/* ---- 一、圆点标记 + 填充 ------------------------------------------------------
 * 圆心在圆里（不透明的填充色）、角在圆外（alpha 掉到 0）。
 * 填充色 `vec4(0.15, 0.55, 0.95, 1.0)` 量化成 38,140,242,255。
 *
 * **图像的 y 与 `gl_FragCoord.y` 反向**：PNG 从上往下，`gl_FragCoord` 从下往上
 * （规范 7.1：原点在左下）。所以图像第 40 行对应 `gl_FragCoord.y = 87.5`，
 * 离中心 23.5 像素 —— 半径 40 的圆里。这一条钉住的正是那个方向。 */
draw('vispy-disc', 128, [
  [64, 64, [38, 140, 242, 255], '圆心：不透明的填充色'],
  [2, 2, [38, 140, 242, 0], '角：在圆外，alpha 为 0'],
  [64, 40, [38, 140, 242, 255], '正上方 24 像素处仍在圆里（半径 40）'],
]);

/* ---- 二、圆环 + 描边 ---------------------------------------------------------
 * 环线上不透明、圆心在环里侧（描边不填内部，所以 alpha 为 0）、角在外侧同样为 0。
 * 描边色 `vec4(0.95, 0.35, 0.15, 1.0)` -> 242,89,38,255。
 * 环：外径 96、内径 48，所以离中心 24 像素处正在环线上（内圈边界）。 */
draw('vispy-stroke', 128, [
  [64, 64, [242, 89, 38, 0], '圆心：描边不填内部'],
  [64, 40, [242, 89, 38, 255], '内圈边界上：描边'],
  [2, 2, [242, 89, 38, 0], '角：在外侧'],
]);

/* ---- 三、颜色表 + 区间外 ------------------------------------------------------
 * `t` 从 -0.2 走到 1.2：最左边落在 t<0（under = 0,0,0.4 -> 0,0,102），
 * 最右边落在 t>1（over = 0.4,1,1 -> 102,255,255），中间是 hot 的渐变。
 * 这一份同时钉住**函数重载**：三实参那一份挑对了才会出现 under/over。 */
draw('vispy-colormap', 128, [
  [0, 64, [0, 0, 102, 255], '最左：t < 0，走 under 那一支'],
  [127, 64, [102, 255, 255, 255], '最右：t > 1，走 over 那一支'],
  [64, 64, [255, 140, 0, 255], '中间：hot 的渐变（t ≈ 0.5055，smoothstep(0.33,0.66) = 0.548）'],
]);

/* ---- 四、裁剪 + `discard` ------------------------------------------------------
 * 复刻 vispy 的 `transforms/viewport-clipping.glsl` + `markers/disc.glsl`：视口是
 * (32,32,64,64)、圆心 (64,64) 半径 40。两处 `discard`，一处在**用户函数**里。
 *
 * 被 discard 掉的像素**四个通道全零**：驱动那一侧见覆盖度是 0 就一个字节都不写，
 * 而缓冲一开始是清零的。这与"填充色的 alpha 是 0"不是一回事 —— 那种情况 RGB 还是
 * 填充色（上面第一、二组正是那样：38,140,242,0）。这一格盯的就是这个差别。
 *
 * y 的方向照上面那条：图像第 y 行对应 `gl_FragCoord.y = 128 - y - 0.5`。 */
draw('vispy-clip', 128, [
  [64, 64, [38, 140, 242, 255], '圆心：视口里、圆里 —— 画'],
  [2, 2, [0, 0, 0, 0], '角：出了视口（用户函数里那一处 discard）'],
  [64, 20, [0, 0, 0, 0], '上边：fragY = 107.5 出了视口'],
  [33, 94, [0, 0, 0, 0], '视口的角上：在视口里但在圆外（main 里那一处 discard）'],
  [40, 64, [38, 140, 242, 255], '圆心左 23.5 像素：还在圆里'],
]);

/* ---- 五、导数那三条（规范 8.9）：快路那一侧 ------------------------------------
 * 用的是 `cases/deriv-quad.frag`（同一份用例的参考腿那一侧在 `render.js` 里）。
 * 放在这一支是因为**这里是唯一读 PNG 的门** —— 快路的像素只能从图里看。
 *
 * 快路的落法是一次 `shufflevector`（一批 8 道排成两个 2×2 quad），参考腿是"再跑一趟
 * 探邻居"。两边算出来的 8 位像素必须一样，而这一份用例的 r/g 是**非线性**的 ——
 * 所以它能分辨"按 quad 差分"与"按自己和右边一个差分"。
 *
 * 期望值手算（8×8，图像第 y 行是 `gl_FragCoord.y = 7.5 - y`）：
 *   r = ((qx+1.5)² - (qx+0.5)²)/256 -> 8 位，qx 是 quad 的左列（x 去掉最低位）
 *   g 同理换成 qy，b = fwidth(x/8) = 0.125 -> 32 */
draw('deriv-quad', 8, [
  [0, 7, [2, 2, 32, 255], '左下角：qx=0、qy=0'],
  [3, 7, [6, 2, 32, 255], 'x=3 与 x=2 同一个 quad：r 用 qx=2（右列不另算）'],
  [7, 0, [14, 14, 32, 255], '右上角：qx=6、qy=6'],
  [4, 4, [10, 6, 32, 255], '中间：qx=4、qy=2（图像第 4 行是像素 y=3）'],
]);

/* ---- 六、纹理取样（规范 8.7）：快路那一侧 --------------------------------------
 * 用的是 `cases/tex-bilinear.frag`（同一份用例的参考腿那一侧在 `render.js` 里，那边
 * 由门自己按公式算一遍逐像素对）。这一支盯的是快路那三件新东西真的接上了：
 *   - ABI 的**第三个指针** `%tex`（纹素从命令行经宿主的 `--tex` 一路递到函数指针）
 *   - 采样器在 `in` 里占的那三格（宽、高、这张图在纹素里的起点）
 *   - 逐道 gather：一批八道各读各的纹素
 *
 * 纹理 2×2：红 绿 / 蓝 白（行优先）。画布 4×4，坐标 `gl_FragCoord.xy / 4`。
 * 期望值手算（图像第 y 行是 `gl_FragCoord.y = 3.5 - y`，`bx = (x+0.5)/2 - 0.5`）：
 * x=0 与 x=3、以及 fragY=0.5 与 3.5 那两行都落在**边外** —— clamp-to-edge 夹住，
 * 所以四个角就是四个纹素本身（这是"夹住了、没绕回去"的判据）。 */
draw('tex-bilinear', 4, [
  [0, 3, [255, 0, 0, 255], '左下角：u/v 都在边外，夹到纹素 (0,0) = 红'],
  [3, 3, [0, 255, 0, 255], '右下角：夹到纹素 (1,0) = 绿'],
  [0, 0, [0, 0, 255, 255], '左上角：夹到纹素 (0,1) = 蓝'],
  [3, 0, [255, 255, 255, 255], '右上角：夹到纹素 (1,1) = 白'],
  [1, 3, [191, 64, 0, 255], '底行 x=1：横向权重 0.25，红→绿之间'],
  [1, 2, [159, 64, 64, 255], '四格之间：横 0.25、纵 0.25，四个纹素都参与'],
], ['--tex', 'u_tex=2,2,1,0,0,1,0,1,0,1,0,0,1,1,1,1,1,1']);

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
