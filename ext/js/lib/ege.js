/**
 * **EasyX / BGI / EGE 那个形状的 2D 图形设备**（JS 这一侧）。
 *
 * 名字照 BGI（`graphics.h`）：`initgraph(640,480)` 开设备、`setcolor` 换笔、
 * `line` / `circle` / `bar` / `putpixel` 画、`closegraph()` 收。学过 C 的人第一次画图
 * 用的就是这套名字，所以例子里一行"新概念"都没有。
 *
 * ## 这是图形设备，不是一串字
 *
 * **像素落在内存里**：`initgraph` 要一块 `w*h*4` 的 RGBA 缓冲，所有图元都是往那块里写
 * 字节（Bresenham 画线、中点画圆、扫描线填多边形）。`putpixel` 调一百万次就是往数组里
 * 写一百万次 —— 一个字节都不过 stdout。
 *
 * 一趟只有**一帧图**跨边界（`closegraph` / `present`）：默认写成一份 **PNG**
 * （8 位 RGBA、filter 0、zlib stored —— `src/core/host/png.js`），落在
 * `OMNI_GFX_OUT`（没明说就是 CLI 摆的那格默认：`<缓存根>/gfx/<脚本名>.png`）。
 * 落点后缀换成 `.rgba` 就走备选出口，
 * 那一份是裸表面：
 *
 *     #rgba <宽> <高>\n<w*h*4 个字节>
 *
 * 走的是封闭 ABI 的 `writeBinary`（ADR-0011 决策 17），所以四条腿上都是同一句话：
 * node 写真文件、浏览器写进内存里那张表、原生产物写真文件。
 *
 * stdout 上只留**一行指针**：`#gfx <种类> <路径> <宽> <高>`。那不是图，是"图在哪儿" ——
 * Studio 见着它就去读那份文件贴到 canvas 上；本机那侧（`ext/jnc/examples/gfxview.jnc`）
 * 把同一帧 `glTexImage2D` 贴进 glfw 窗口。
 *
 * 为什么默认是 **PNG**：图最后总要有人看 —— 双击能开、`magick compare` 直接吃。
 * 裸表面留着当备选：程序对程序那一头（`putImageData` / `glTexImage2D`）直接吃裸字节，
 * 而且"逐字节相同"那条判据在它上头没有编码那一层要担心。
 *
 * 坐标与 EasyX 一致：左上角原点、y 往下、单位是像素。颜色是 `0xRRGGBB` 的整数
 * （`RGB(r,g,b)` 拼一格）。
 */
import { writeBinary, mkdirAll, env } from '../../../src/core/host/native.js';
import { pngFromRgba, surfaceKind } from '../../../src/core/host/png.js';

/* 设备状态。BGI 那套 API 本来就是"有一块当前设备"的形状 —— 所以这儿是模块级的几格。 */
let W = 0;
let H = 0;
let FB = null;                 /* Uint8Array(w*h*4)，RGBA，行优先 */
let PEN = 0x000000;            /* 描边色（`setcolor`） */
let BRUSH = 0xffffff;          /* 填充色（`setfillcolor`） */
let LW = 1;                    /* 线宽（`setlinewidth`） */

/** 三个分量拼成 `0xRRGGBB`。 */
export function RGB(r, g, b) {
  const c = (n) => Math.max(0, Math.min(255, Math.round(n)));
  return c(r) * 65536 + c(g) * 256 + c(b);
}

/* BGI 那十六格颜色里最常用的几个（名字照 `graphics.h`）。 */
export const BLACK = 0x000000;
export const WHITE = 0xffffff;
export const RED = 0xff0000;
export const GREEN = 0x00a000;
export const BLUE = 0x0050ff;
export const YELLOW = 0xffd000;
export const CYAN = 0x00c0c0;
export const MAGENTA = 0xff00ff;
export const DARKGRAY = 0x404040;
export const LIGHTGRAY = 0xc0c0c0;

/** 开设备：要一块 RGBA 缓冲，整块填成黑（EasyX 的默认背景）。 */
export function initgraph(w, h) {
  W = Math.max(1, Math.round(w));
  H = Math.max(1, Math.round(h));
  FB = new Uint8Array(W * H * 4);
  PEN = 0xffffff;
  BRUSH = 0xffffff;
  LW = 1;
  fillAll(0x000000);
  return undefined;
}

export function getwidth() { return W; }
export function getheight() { return H; }

function fillAll(c) {
  const r = Math.trunc(c / 65536) % 256;
  const g = Math.trunc(c / 256) % 256;
  const b = c % 256;
  for (let i = 0; i < FB.length; i += 4) {
    FB[i] = r;
    FB[i + 1] = g;
    FB[i + 2] = b;
    FB[i + 3] = 255;
  }
  return undefined;
}

let BK = 0x000000;
export function setbkcolor(c) { BK = c; return undefined; }
/** 用背景色清屏（EasyX：`setbkcolor` 之后 `cleardevice` 才真的清）。 */
export function cleardevice() { fillAll(BK); return undefined; }

export function setcolor(c) { PEN = c; return undefined; }
export function setfillcolor(c) { BRUSH = c; return undefined; }
export function setlinewidth(w) { LW = Math.max(1, Math.round(w)); return undefined; }

/** 往一格里写颜色。越界就丢掉 —— 裁剪在这一格做，上头的图元都不用再判。 */
function px(x, y, c) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= W || yi >= H) return undefined;
  const i = (yi * W + xi) * 4;
  FB[i] = Math.trunc(c / 65536) % 256;
  FB[i + 1] = Math.trunc(c / 256) % 256;
  FB[i + 2] = c % 256;
  FB[i + 3] = 255;
  return undefined;
}

/** 线宽 > 1 时画的是一块方点 —— 圆头笔要开根号，这一层不值得。 */
function dot(x, y, c) {
  if (LW <= 1) return px(x, y, c);
  const h0 = Math.trunc(LW / 2);
  for (let dy = -h0; dy <= LW - 1 - h0; dy++) {
    for (let dx = -h0; dx <= LW - 1 - h0; dx++) px(x + dx, y + dy, c);
  }
  return undefined;
}

/** `putpixel`：第三个实参不给就用当前笔（BGI 那边是必给，这儿宽一格）。 */
export function putpixel(x, y, c) {
  return px(x, y, c === undefined ? PEN : c);
}

export function getpixel(x, y) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= W || yi >= H) return 0;
  const i = (yi * W + xi) * 4;
  return FB[i] * 65536 + FB[i + 1] * 256 + FB[i + 2];
}

/** Bresenham。两头都画，与 BGI 的 `line` 一样是闭区间。 */
export function line(x1, y1, x2, y2) {
  let x0 = Math.round(x1);
  let y0 = Math.round(y1);
  const xe = Math.round(x2);
  const ye = Math.round(y2);
  const dx = Math.abs(xe - x0);
  const dy = Math.abs(ye - y0);
  const sx = x0 < xe ? 1 : -1;
  const sy = y0 < ye ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    dot(x0, y0, PEN);
    if (x0 === xe && y0 === ye) return undefined;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}

export function rectangle(x, y, w, h) {
  line(x, y, x + w, y);
  line(x + w, y, x + w, y + h);
  line(x + w, y + h, x, y + h);
  line(x, y + h, x, y);
  return undefined;
}

/** EasyX 的 `bar`：填充矩形（用填充色）。 */
export function bar(x, y, w, h) {
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  const x1 = Math.round(x + w);
  const y1 = Math.round(y + h);
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) px(xx, yy, BRUSH);
  }
  return undefined;
}

/** 中点画圆（八分对称）。 */
export function circle(cx, cy, r) {
  let x = Math.round(r);
  let y = 0;
  let err = 1 - x;
  while (x >= y) {
    dot(cx + x, cy + y, PEN);
    dot(cx + y, cy + x, PEN);
    dot(cx - y, cy + x, PEN);
    dot(cx - x, cy + y, PEN);
    dot(cx - x, cy - y, PEN);
    dot(cx - y, cy - x, PEN);
    dot(cx + y, cy - x, PEN);
    dot(cx + x, cy - y, PEN);
    y++;
    if (err < 0) err += 2 * y + 1;
    else { x--; err += 2 * (y - x) + 1; }
  }
  return undefined;
}

/** 填充圆：逐行算半弦长，一行一段。 */
export function fillcircle(cx, cy, r) {
  const rr = Math.round(r);
  for (let dy = -rr; dy <= rr; dy++) {
    const dx = Math.trunc(Math.sqrt(rr * rr - dy * dy));
    for (let x = -dx; x <= dx; x++) px(cx + x, cy + dy, BRUSH);
  }
  return undefined;
}

/** 椭圆（描边）：按参数走一圈连线段 —— 中点画椭圆省下的那点开销在这儿不值得。 */
export function ellipse(cx, cy, rx, ry) {
  const n = Math.max(24, Math.round((Math.abs(rx) + Math.abs(ry)) / 2));
  let px0 = cx + rx;
  let py0 = cy;
  for (let i = 1; i <= n; i++) {
    const t = (2 * Math.PI * i) / n;
    const x = cx + rx * Math.cos(t);
    const y = cy + ry * Math.sin(t);
    line(px0, py0, x, y);
    px0 = x;
    py0 = y;
  }
  return undefined;
}

export function fillellipse(cx, cy, rx, ry) {
  const ryi = Math.round(ry);
  for (let dy = -ryi; dy <= ryi; dy++) {
    const k = 1 - (dy * dy) / (ryi * ryi);
    if (k < 0) continue;
    const dx = Math.trunc(rx * Math.sqrt(k));
    for (let x = -dx; x <= dx; x++) px(cx + x, cy + dy, BRUSH);
  }
  return undefined;
}

/** 折线。`pts` 是 `[x1,y1,x2,y2,…]`（与 BGI 的 `drawpoly` 同一个摆法）。 */
export function polyline(pts) {
  for (let i = 0; i + 3 < pts.length; i += 2) line(pts[i], pts[i + 1], pts[i + 2], pts[i + 3]);
  return undefined;
}

/** 扫描线填多边形（奇偶规则），最后补一圈描边让边缘不豁口。 */
export function fillpoly(pts) {
  const n = Math.trunc(pts.length / 2);
  if (n < 3) return undefined;
  let ymin = pts[1];
  let ymax = pts[1];
  for (let i = 1; i < n; i++) {
    ymin = Math.min(ymin, pts[2 * i + 1]);
    ymax = Math.max(ymax, pts[2 * i + 1]);
  }
  for (let y = Math.round(ymin); y <= Math.round(ymax); y++) {
    const xs = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const y1 = pts[2 * i + 1];
      const y2 = pts[2 * j + 1];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        xs.push(pts[2 * i] + ((y - y1) / (y2 - y1)) * (pts[2 * j] - pts[2 * i]));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.round(xs[k]); x <= Math.round(xs[k + 1]); x++) px(x, y, BRUSH);
    }
  }
  return undefined;
}

/**
 * 把这一帧交给设备。`closegraph()` 就是它 —— 分两个名字是因为动画那一档要在循环里调
 * （`present()` 每帧一次），而 `closegraph()` 是 BGI 里"收工"那一句。
 *
 * 落点：`OMNI_GFX_OUT` > `OMNI_GFX_OUT_DEFAULT`（CLI 按脚本名 + 缓存根算的，
 * 见 `cli.js` 的 `setGfxDefaultOut`）> `.omni-cache/gfx/frame.png`（独立产物的兜底）。
 * 后缀换 `.rgba` 走裸表面那个备选。stdout 上只印一行指针 —— 图本身不走 stdout。
 */
export function present() {
  const path = env('OMNI_GFX_OUT') ?? env('OMNI_GFX_OUT_DEFAULT') ?? '.omni-cache/gfx/frame.png';
  const slash = path.lastIndexOf('/');
  if (slash > 0) mkdirAll(path.slice(0, slash));
  /* 字节口径：封闭 ABI 的 `writeBinary` 吃的是**一个字符一个字节**的串（latin1）。
     一格一格接会把串拼成天文数字次，所以按行收成数组再 join —— 一帧 640x480 是 480 段。 */
  const rows = [];
  const stride = W * 4;
  for (let y = 0; y < H; y++) {
    const out = [];
    for (let i = y * stride; i < (y + 1) * stride; i++) out.push(String.fromCharCode(FB[i]));
    rows.push(out.join(''));
  }
  const raw = rows.join('');
  const kind = surfaceKind(path);
  writeBinary(path, kind === 'rgba' ? `#rgba ${W} ${H}\n${raw}` : pngFromRgba(raw, W, H));
  console.log(`#gfx ${kind} ${path} ${W} ${H}`);
  return undefined;
}

export function closegraph() { return present(); }
