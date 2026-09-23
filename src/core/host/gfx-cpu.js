// src/core/host/gfx-cpu.js —— **图形设备的 CPU 备选**（EVAL 两门语言的宿主面，JS 那一族共用）
//
// 这一份是 `docs/design/eval-realtime-gpu.md` 里那张表的第三行：**备选**。
// 默认那两档是真 GPU（浏览器 WebGL2、本机 OpenGL）；这一份只在
// `--gfx=cpu` / 没有 GL 的机器 / 判据要逐字节可比的那几格上跑。
//
// ## 为什么在宿主这一侧，而不是生成出来的 IR
//
// 第一版把光栅器写成"生成出来的标准 IR"（`ext/polydraw/gfx-rt.js`）——三条腿逐字节相同，
// 但它**默认就是模拟渲染**，而且着色器那一族永远没有落点。翻过来之后：语言那一侧只发
// `(gfxcall "名字" 实参…)`，宿主这一侧才是设备 —— 于是同一份脚本换个设备就是换个后端。
//
// ## 一格设备的状态与那张名字表
//
// 名字与语义照 `evaldraw_ref.md`（EvalDraw 的 2D 那一档）：坐标左上角原点、y 往下、
// 颜色分量 0..255。像素落在 `fb`（一格一个 `0xRRGGBB` 的数）；`refresh` 把这一帧写成
// `#rgba <w> <h>\n` + 裸 RGBA 的表面文件，stdout 上只留一行指针。
//
// **像素算法与 `ext/polydraw/gfx-rt.js` 逐句相同**（Bresenham、中点画圆、沿线铺圆）——
// 那是有意的：换路之后同一份例子的表面要**逐字节相同**，这条才是"搬家不改语义"的判据。

import { writeBinary, mkdirAll, stdout, env, nowMs } from './native.js';
import { pngFromRgba, surfaceKind } from './png.js';

/** 设备的那几格状态。**一格进程一格设备**（EVAL 的宿主本来就是这个形状）。 */
const D = {
  w: 0, h: 0, fb: null, col: 0xffffff, x: 0, y: 0, on: false,
  out: '.omni-cache/gfx/frame.png',
  /* 帧循环那三格：`fno` 是已经开始画的帧数（脚本里的 `numframes` = fno-1，第一帧是 0）、
     `frames` 是这一趟要画几帧（`OMNI_FRAMES`，默认 1）、`dirty` 是"这一帧动过没有"
     —— 没动过就不重复写表面（脚本自己调 `refresh()` 之后帧末那一次就免了）。 */
  fno: 0, frames: -1, dirty: false,
  /* 输入那几格（`mousx`/`mousy`/`bstatus`/`keystatus[256]`）。`keys` 是"还没开"的记号。 */
  mx: 0, my: 0, bst: 0, keys: null,
};

/**
 * **输入那一族的来源**：CPU 这一档没有窗口，所以从环境变量读一次 ——
 * `OMNI_MOUSE=x,y,按键位`、`OMNI_KEYS=0xc8,0x1d`（按住的扫描码，逗号分隔）。
 *
 * 这么定有两个好处：判据能真跑输入那一族（不是永远读到 0），而且**三条腿逐字节相同**
 * 的口径仍然成立（输入是这一趟的常量）。GL 那两档里来源是真事件（canvas / 窗口）。
 *
 * 脚本写回去也生效（`bstatus--`、`keystatus[k]=0`）—— PolyDraw 的说明书里
 * "消掉一次点击/一次按键"就是这么写的（`polydraw.txt:381`、`:388`）。
 */
function needInput() {
  if (D.keys !== null) return;
  const keys = [];
  for (let i = 0; i < 256; i++) keys.push(0);
  D.keys = keys;
  const m = env('OMNI_MOUSE');
  if (m !== undefined && m !== null && m !== '') {
    const p = String(m).split(',');
    const n0 = Number(p[0]);
    const n1 = Number(p[1]);
    const n2 = Number(p[2]);
    D.mx = Number.isFinite(n0) ? n0 : 0;
    D.my = Number.isFinite(n1) ? n1 : 0;
    D.bst = Number.isFinite(n2) ? Math.trunc(n2) : 0;
  }
  const k = env('OMNI_KEYS');
  if (k !== undefined && k !== null && k !== '') {
    for (const s of String(k).split(',')) {
      const c = Math.trunc(Number(s));
      if (Number.isFinite(c) && c >= 0 && c < 256) D.keys[c] = 1;
    }
  }
}

const rnd = (v) => Math.floor(v + 0.5);
const clamp255 = (v) => {
  const i = rnd(v);
  return i < 0 ? 0 : (i > 255 ? 255 : i);
};
const rgb = (r, g, b) => clamp255(r) * 65536 + clamp255(g) * 256 + clamp255(b);

/** 第一次画之前自动开一块（EVAL 的脚本里没有"开设备"那一句 —— 窗口是宿主给的）。 */
function need(w, h) {
  if (D.on) return;
  D.w = w;
  D.h = h;
  /* **普通数组**（不是 Int32Array）：这一份要能被我们自己那台 JS 前端降级，
     子集里还没有 TypedArray（`feedback_check_self_gate.md` 那条纪律：撞上就扩，
     但这一格用普通数组没有代价 —— 它不在热路径的最内层）。 */
  const n = w * h;
  const fb = [];
  for (let i = 0; i < n; i++) fb.push(0);
  D.fb = fb;
  D.on = true;
  D.col = 0xffffff;
  D.x = 0;
  D.y = 0;
}

function px(x, y, c) {
  const xi = rnd(x);
  const yi = rnd(y);
  if (xi < 0 || yi < 0 || xi >= D.w || yi >= D.h) return;
  D.fb[yi * D.w + xi] = c;
  D.dirty = true;
}

function cls(r, g, b) {
  const c = rgb(r, g, b);
  const n = D.w * D.h;
  for (let i = 0; i < n; i++) D.fb[i] = c;
  D.dirty = true;
}

/** Bresenham。两头都画（与 EvalDraw 的 `lineto` 一样是闭区间）。 */
function line(x0, y0, x1, y1, c) {
  let x = rnd(x0);
  let y = rnd(y0);
  const xe = rnd(x1);
  const ye = rnd(y1);
  const dx = Math.abs(xe - x);
  const dy = Math.abs(ye - y);
  const sx = x > xe ? -1 : 1;
  const sy = y > ye ? -1 : 1;
  let err = dx - dy;
  for (;;) {
    px(x, y, c);
    if (x === xe && y === ye) return;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

/** 填充圆：逐行算半弦长，一行一段。 */
function disc(cx, cy, r, c) {
  const ri = rnd(r);
  for (let dy = -ri; dy <= ri; dy++) {
    const dx = Math.floor(Math.sqrt(ri * ri - dy * dy));
    for (let x = -dx; x <= dx; x++) px(cx + x, cy + dy, c);
  }
}

/** 描边圆：中点画圆 + 八分对称。 */
function circ(cx, cy, r, c) {
  let x = rnd(r);
  let y = 0;
  let err = 1 - x;
  while (x >= y) {
    px(cx + x, cy + y, c);
    px(cx + y, cy + x, c);
    px(cx + x, cy - y, c);
    px(cx + y, cy - x, c);
    px(cx - x, cy + y, c);
    px(cx - y, cy + x, c);
    px(cx - x, cy - y, c);
    px(cx - y, cy - x, c);
    y += 1;
    if (err < 0) err += 2 * y + 1;
    else { x -= 1; err += 2 * (y - x) + 1; }
  }
}

/** `drawcone(x,y,r,x2,y2,r2)` 是**粗线**：沿线铺圆（形状对、边缘比真梯形略毛）。 */
function cone(x0, y0, r0, x1, y1, r1, c) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const n = Math.floor(Math.hypot(dx, dy) + 1);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    disc(x0 + t * dx, y0 + t * dy, r0 + t * (r1 - r0), c);
  }
}

/** 这一帧的**裸 RGBA**（一字符一字节、第 0 行在上、alpha 恒 255）—— 两个出口都从它来。 */
function rgbaBytes() {
  const rows = [];
  for (let y = 0; y < D.h; y++) {
    let row = '';
    for (let x = 0; x < D.w; x++) {
      const v = D.fb[y * D.w + x] & 0xffffff;
      row += String.fromCharCode((v - v % 65536) / 65536)
        + String.fromCharCode((v % 65536 - v % 256) / 256)
        + String.fromCharCode(v % 256) + String.fromCharCode(255);
    }
    rows.push(row);
  }
  return rows.join('');
}

/** 备选那个出口的字节（`#rgba <w> <h>\n` + 裸 RGBA）。 */
export function gfxSurfaceBytes() {
  return `#rgba ${D.w} ${D.h}\n${rgbaBytes()}`;
}

/** 设备现在多大（`xres` / `yres` 那两格量、与贴 canvas 那一侧都要问它）。 */
export function gfxSize() { return { w: D.w, h: D.h, on: D.on }; }
export function gfxOut() { return D.out; }
export function gfxSetOut(p) { D.out = p; }
/** 默认画布尺寸：EvalDraw 的窗口是宿主给的，这条腿上定 320×240（判据也按它）。 */
export function gfxOpen(w = 320, h = 240) { D.on = false; need(w, h); }

/**
 * **一格宿主调用**：名字 + 一串 double 实参，回一个 double（EVAL 的宿主面就是这个形状）。
 *
 * 认不出的名字**当场炸**，并把这一格设备有哪些名字说出来 —— 不许静默回 0
 * （那是"图不对但没人知道"的来源）。
 */
export function gfxCall(name, args) {
  const a = (i) => Number(args[i] ?? 0);
  switch (`${name}/${args.length}`) {
    case 'cls/3': need(320, 240); cls(a(0), a(1), a(2)); return 0;
    case 'setcol/3': need(320, 240); D.col = rgb(a(0), a(1), a(2)); return 0;
    case 'setcol/1': need(320, 240); D.col = Math.trunc(a(0)) & 0xffffff; return 0;
    case 'setpix/2': need(320, 240); px(a(0), a(1), D.col); return 0;
    case 'moveto/2': need(320, 240); D.x = a(0); D.y = a(1); return 0;
    case 'lineto/2':
      need(320, 240);
      line(D.x, D.y, a(0), a(1), D.col);
      D.x = a(0);
      D.y = a(1);
      return 0;
    /* `drawsph(x,y,r)`：**半径为负是描边**（`evaldraw_ref.md` 那句话）。 */
    case 'drawsph/3':
      need(320, 240);
      if (a(2) < 0) circ(a(0), a(1), -a(2), D.col);
      else disc(a(0), a(1), a(2), D.col);
      return 0;
    case 'drawcone/6':
      need(320, 240);
      cone(a(0), a(1), a(2), a(3), a(4), a(5), D.col);
      return 0;
    case 'rgb/3': return rgb(a(0), a(1), a(2));
    /* `refresh()`：**交出这一帧**。CPU 这一档就是写表面 + 印一行指针
       （GL 那两档在各自的设备里是交换缓冲）。 */
    case 'refresh/0': need(320, 240); present(); return 0;
    /**
     * **帧循环的那一格**（`(gfxcall "nextframe")`）：产物自己 `while` 着问它
     * "还画不画下一帧"，于是**循环在设备里**（design 文档第 3 节）：
     *
     * * CPU / 离屏这一档：画 `OMNI_FRAMES` 帧（默认 1），每帧末把动过的那一帧交出去；
     * * 本机 OpenGL 那一档（往后）：poll 事件 + 交换缓冲 + 窗口没关就回 1 —— 真实时循环；
     * * 浏览器那一档（往后）：页面驱动，这一格的形状还要再定（worker + OffscreenCanvas，
     *   或者把帧函数交出去）。
     *
     * `numframes` 与它配套：脚本里第一帧是 0（EVAL 的脚本靠 `if (numframes == 0)` 做初始化）。
     */
    case 'nextframe/0': {
      need(320, 240);
      if (D.frames < 0) {
        const f = env('OMNI_FRAMES');
        const k = f === undefined || f === null || f === '' ? 1 : Math.trunc(Number(f));
        D.frames = Number.isFinite(k) && k > 0 ? k : 1;
      }
      if (D.fno > 0 && D.dirty) present();
      if (D.fno >= D.frames) return 0;
      D.fno += 1;
      return 1;
    }
    case 'numframes/0': need(320, 240); return D.fno > 0 ? D.fno - 1 : 0;
    /* `klock()`：秒（EVAL 里它是"从开机起的秒数"，脚本拿它算帧间隔）。 */
    case 'klock/0': return nowMs() / 1000;
    case 'xres/0': need(320, 240); return D.w;
    case 'yres/0': need(320, 240); return D.h;
    /* ── 输入那一族（读四格、写两格）。写的两格照说明书：`bstatus` 与 `keystatus[k]`
       脚本改得动（"消掉一次点击"），`xres`/`mousx` 那几格只读 —— 赋值在 adapter 那层就报。 */
    case 'mousx/0': needInput(); return D.mx;
    case 'mousy/0': needInput(); return D.my;
    case 'bstatus/0': needInput(); return D.bst;
    case 'setbstatus/1': needInput(); D.bst = Math.trunc(a(0)); return 0;
    case 'keystatus/1': {
      needInput();
      const k = Math.trunc(a(0));
      return k >= 0 && k < 256 ? D.keys[k] : 0;
    }
    case 'setkeystatus/2': {
      needInput();
      const k = Math.trunc(a(0));
      if (k >= 0 && k < 256) D.keys[k] = a(1);
      return 0;
    }
    default:
      throw new Error(`这格设备（CPU 备选）上没有 '${name}'（${args.length} 个实参）——`
        + ' 有的是 cls/setcol/setpix/moveto/lineto/drawsph/drawcone/rgb/refresh/'
        + 'nextframe/numframes/klock/xres/yres/mousx/mousy/bstatus/keystatus；'
        + ' **GL 立即模式与可编程管线（着色器）只有 GPU 那两档设备有**'
        + '（浏览器 WebGL2 / 本机 OpenGL）—— 见 docs/design/eval-realtime-gpu.md');
  }
}

/* ---------------------------------------------------------------- 装成宿主那格设备
 *
 * 产物（发射出来的 JS）拿不到这份模块，所以约定一格**全局**：`globalThis.__OMNI_GFX`，
 * 形状是 `{ call(名字, 实参数组) -> number, present() -> void, kind }`。
 * 谁评估产物谁负责装上它 —— node 这边 import 这份模块就装上了（`lower/drive.js`），
 * 浏览器那边由页面装 **WebGL2 那一档**（默认，见 design 文档第 2.2 节）。
 * 没人装设备的独立产物**当场报**，不静默不画。
 */

/** 表面的落点：`OMNI_GFX_OUT` 能换（与 `ext/js/lib/ege.js` 同一格开关）。 */
function outPath() {
  const p = env('OMNI_GFX_OUT');
  return p === undefined || p === null || p === '' ? D.out : p;
}

/**
 * CPU 备选那一档的"交出一帧"：写图 + stdout 上印一行指针。
 *
 * **默认写 PNG**（`.omni-cache/gfx/frame.png`）—— 双击能开、`magick`/`compare` 直接吃；
 * 落点后缀是 `.rgba` 才走裸表面那个备选出口（它没有编码那一层，逐字节判据最直接）。
 * 指针那一行把种类也带上：`#gfx png <路径> <宽> <高>` / `#gfx rgba …`。
 */
function present() {
  if (!D.on) return;
  const p = outPath();
  const cut = p.lastIndexOf('/');
  if (cut > 0) mkdirAll(p.slice(0, cut));
  const kind = surfaceKind(p);
  writeBinary(p, kind === 'rgba' ? gfxSurfaceBytes() : pngFromRgba(rgbaBytes(), D.w, D.h));
  stdout(`#gfx ${kind} ${p} ${D.w} ${D.h}\n`);
  D.dirty = false;
}

export const GFX_CPU = { call: gfxCall, present, kind: 'cpu' };
