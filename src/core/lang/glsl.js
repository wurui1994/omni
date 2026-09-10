// src/core/lang/glsl.js —— GLSL 片段着色器那条腿的插件外壳（ADR-0021 的 S4）
//
// 与另外几门同一条规矩：**不 import cli.js**。glsl 特别的地方是它注册的是**跑法**
// 而不是"怎么变成 OIR" —— `.frag` 的"执行"是渲一帧写一张 PNG，它没有 OIR 那一层
// （见 plugin.js 的 RUNNERS 那一段）。
//
// 名字带前缀的理由与另外几门一样：自举链要求模块作用域的名字整份程序里唯一。

import { OmniError } from '../source/diag.js';
import { join, basename } from '../host/path.js';
import { installDir, env, stdout } from '../host/native.js';
import { glslRenderToPng } from '../frontend-glsl/render.js';

/* 核心交过来的宿主服务：findCC（挑一个 C 编译器）是驱动的事，不是这一门语言的事。 */
let GLSL_API = null;

/**
 * `omni run x.frag -o out.png`（ADR-0019 决策九）。这一层只做**参数**：把 `--size`
 * 与那一串 `--set` 翻成 `render.js` 要的形状，别的都在那一份里。
 *
 * `-o` 是必给的：一帧一张图，没有「印到 stdout」这个说法（PNG 是二进制）。
 */
export function runGlslFrag(path, rest) {
  const oi = rest.indexOf('-o');
  if (oi < 0) throw new OmniError(`run ${basename(path)}: 要给 -o OUT.png（一帧一张图）`);
  const out = rest[oi + 1];
  const si = rest.indexOf('--size');
  const sz = si >= 0 ? rest[si + 1] : '256';
  const xy = sz.split('x');
  const w = Number(xy[0]);
  const h = xy.length > 1 ? Number(xy[1]) : w;
  if (!(w > 0) || !(h > 0)) throw new OmniError(`run: --size ${sz} 说不通（要 N 或 NxM）`);
  /* `--set` 可重复，所以扫一遍而不是 `indexOf`。 */
  const set = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== '--set') continue;
    const kv = rest[i + 1] === undefined ? '' : rest[i + 1];
    const eq = kv.indexOf('=');
    if (eq <= 0) throw new OmniError(`run: --set 要 NAME=v[,v…]，给的是 '${kv}'`);
    set[kv.slice(0, eq)] = kv.slice(eq + 1).split(',').map((s) => Number(s));
  }
  /* `--tex NAME=W,H,r,g,b,a,…` —— 采样器的值。与 `--set` 分开一个开关，因为它的形状
   * 不一样：前两个数是宽高，后面是 W×H×4 个纹素分量（RGBA、行优先）。1D 的高给 1。 */
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== '--tex') continue;
    const kv = rest[i + 1] === undefined ? '' : rest[i + 1];
    const eq = kv.indexOf('=');
    if (eq <= 0) throw new OmniError(`run: --tex 要 NAME=W,H,v…，给的是 '${kv}'`);
    const nums = kv.slice(eq + 1).split(',').map((s) => Number(s));
    if (nums.length < 3) throw new OmniError(`run: --tex ${kv.slice(0, eq)} 至少要 W,H 加一个纹素`);
    set[kv.slice(0, eq)] = { w: nums[0], h: nums[1], data: nums.slice(2) };
  }
  const root = join(installDir(), '..', '..', '..');
  /* `env` 是宿主函数，**不能当值传** —— 封闭 ABI 里它只有"被调用"这一种用法。
     包一层箭头函数：递过去的是普通闭包，里面那一句才是那次调用。 */
  const r = glslRenderToPng(root, path, out, w, h, set, GLSL_API.findCC(), (n) => env(n));
  stdout(`${r.out}  ${w}x${h}  uniform ${r.uniforms.length} 个  ir ${r.irLines} 行\n`);
  return 0;
}

/** 登记：内建时核心调一次，做成动态库之后由 `omni_plugin_init` 调同一个。 */
export function registerGlslLang(api) {
  GLSL_API = api;
  api.registerRunner(['.frag', '.glsl'], 'glsl', (path, argv) => runGlslFrag(path, argv));
}
