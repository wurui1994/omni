// ext/polydraw/graph-rt.js —— **EVAL 的 graphing modes（画函数那几档）写成生成出来的 IR**
//
// 口径：`evaldraw.txt:1237` 那张表。主函数的**形参表**就是模式：
//
//     ()                  每帧调一次 —— 脚本自己画（我们从前只接这一档）
//     (x)  (x,t)          1D：画一条曲线                       ← 还没接
//     (x,t,te) (a[16])    1D 声音：乐器（没有音频设备）        ← 语言这一半通、不出图
//     (x,y)               2D：**每个像素调一次**，回值过调色板
//     (x,y,t)             2D + 时间（秒）
//     (x,y,&r,&g,&b)      2D：脚本自己给颜色（0..255），回值不管
//     (x,y,t,&r,&g,&b)    上面两档合起来
//     (x,y,z,&r,&g,&b)    3D 体素                              ← 还没接
//     (x,y,z,t,&r,&g,&b)  3D 体素 + 时间                       ← 还没接
//
// ## 这一份接的是 2D 那四档
//
// **循环在语言这一侧**（与 `gl-rt.js` 同一条规矩：设备只收批/行，不收"每像素一句"）：
// 每帧先按 `frameinit` 调一次主体（脚本在那一趟里预算与时间有关的 static），
// 然后逐行逐像素调主体，一行攒进 `ev_row` 再**整行**交给设备
// （`(gfxarr "setrow" y x0 n 0 行)`）—— 320×240 那是 240 次宿主调用，不是 76800 次。
//
// ## 两处定下来的口径
//
// 1. **网格**：`setgrid(x0,y0,x1,y1)` 的默认是 `setgrid(-4,3,4,-3)`（`evaldraw.txt:1620`
//    原话，y 是负的因为作者按屏幕坐标想）。像素中心取样（`+.5`）。
// 2. **调色板**（`(x,y)` / `(x,y,t)` 那两档的回值 -> 颜色）：`evaldraw.txt:1298` 只钉住
//    三件事 —— `<= 0` 蓝、`>= 1` 红、中间是"平滑的光谱"，而那条光谱曲线写在
//    `EVALDRAW.INI` 里（**语料里没有那份 INI**，evaldraw 也没有源码）。所以这一格是
//    **明写偏差**：按 HSV 的色相从 240°（蓝）线性转到 0°（红），饱和度与明度都是满的
//    —— 也就是蓝→青→绿→黄→红那条常见的彩虹带，端点与说明书对得上。

import {
  ARR, num, str, nm, bin, call, bi, rm, set, letR, ret, iff, whil, ex, aset, aget, ix, fn, glob,
  anew,
} from './ir.js';

/** 一格宿主调用（与 `gl-rt.js` 的 `dev` 同一格）。 */
const dev = (name, args = []) => bi('gfxcall', [str(name), ...args]);

/** 这一档的模块级那几格（`ev_` 前缀 —— 脚本里的名字不会撞）。 */
export const GRAPH_GLOBALS = ['ev_fi', 'ev_gx0', 'ev_gy0', 'ev_gx1', 'ev_gy1', 'ev_rown'];

export function graphGlobalDecls() {
  return [...GRAPH_GLOBALS.map((n) => glob(n)),
    glob('ev_row', ARR), glob('ev_cr', ARR), glob('ev_cg', ARR), glob('ev_cb', ARR)];
}

/** 网格的默认（`evaldraw.txt:1620`：`setgrid(-4,3,4,-3)`）。 */
export const GRAPH_GRID = [-4, 3, 4, -3];

/** 入口里做一次：网格摆成默认值（`setgrid` 那一格会改它们）+ 颜色那三格箱子开出来。 */
export function graphInitStmts(col) {
  return [
    set('ev_gx0', num(GRAPH_GRID[0])),
    set('ev_gy0', num(GRAPH_GRID[1])),
    set('ev_gx1', num(GRAPH_GRID[2])),
    set('ev_gy1', num(GRAPH_GRID[3])),
    ...(col ? [set('ev_cr', anew(num(1))), set('ev_cg', anew(num(1))),
      set('ev_cb', anew(num(1)))] : []),
  ];
}

/**
 * `setgrid(x0,y0,x1,y1)`（`evaldraw.txt:1619`）—— 1D 与 2D 那几档的网格标尺。
 * 落成四句赋值，回 0（EVAL 里这一族都回 0）。
 */
export const GRAPH_FNS = new Map([['setgrid/4', 'ev_setgrid']]);

/**
 * 调色板 + `setgrid`。调色板那一格的曲线见头注第 2 条（明写偏差）：
 *
 *     v <= 0        蓝 0x0000ff
 *     v >= 1        红 0xff0000
 *     0 < v < 1     色相 (1-v)*240°，分四段线性（红-黄-绿-青-蓝 反着来）
 */
export function graphFnDecls() {
  const seg = nm('s');
  const f = nm('f');
  /* 色相那四段：`s` 是 0..4（0 = 红、4 = 蓝），`f` 是段内那一份小数。 */
  const band = (i, r, g, b) => iff(bin('<', seg, num(i + 1)), [
    ret(bin('+', bin('+', bin('*', r, num(65536)), bin('*', g, num(256))), b)),
  ]);
  const up = rm('floor', [bin('*', f, num(255))]);
  const dn = rm('floor', [bin('*', bin('-', num(1), f), num(255))]);
  return [
    fn('ev_clamp255', ['v'], [
      letR('i', rm('floor', [bin('+', nm('v'), num(0.5))])),
      iff(bin('<', nm('i'), num(0)), [ret(num(0))]),
      iff(bin('>', nm('i'), num(255)), [ret(num(255))]),
      ret(nm('i')),
    ]),
    fn('ev_col', ['v'], [
      iff(bin('<=', nm('v'), num(0)), [ret(num(255))]),
      iff(bin('>=', nm('v'), num(1)), [ret(num(16711680))]),
      letR('s', bin('*', bin('-', num(1), nm('v')), num(4))),
      /* `s` 在 (0,4) 之间、非负 ⇒ `floor` 就是那一段的序号。 */
      letR('f', bin('-', seg, rm('floor', [seg]))),
      band(0, num(255), up, num(0)),          /* 红 -> 黄 */
      band(1, dn, num(255), num(0)),          /* 黄 -> 绿 */
      band(2, num(0), num(255), up),          /* 绿 -> 青 */
      band(3, num(0), dn, num(255)),          /* 青 -> 蓝 */
      ret(num(255)),
    ]),
    /* `&r,&g,&b` 那两档：分量 0..255（`evaldraw.txt:1066` 那句 "now range from
       [0 to 256)"），夹一下再打包成 0xRRGGBB。 */
    fn('ev_rgb', ['r', 'g', 'b'], [
      ret(bin('+', bin('+',
        bin('*', call('ev_clamp255', [nm('r')]), num(65536)),
        bin('*', call('ev_clamp255', [nm('g')]), num(256))),
      call('ev_clamp255', [nm('b')]))),
    ]),
    fn('ev_setgrid', ['x0', 'y0', 'x1', 'y1'], [
      set('ev_gx0', nm('x0')),
      set('ev_gy0', nm('y0')),
      set('ev_gx1', nm('x1')),
      set('ev_gy1', nm('y1')),
      ret(num(0)),
    ]),
  ];
}

/**
 * 一帧：`frameinit` 那一趟 + 逐像素那两层循环。回**若干句 IR**（放进 `eval$frame`）。
 *
 * `pix` 是那格per-pixel 函数的名字（主体原样落成的那一份），`shape` 说它的形参表：
 *
 *     { t: 有没有 t 那一格, col: 有没有 &r,&g,&b 那三格 }
 *
 * 颜色那三格是**长度 1 的块**（`&x` 形参在这门语言里就是那样，见 `paramOne`）——
 * 每格后面还要跟一格偏移实参（`paramInfos` 补的那一格），所以调用点是
 * `pix(x, y[, t], r, 0, g, 0, b, 0)`。
 */
export function graphFrameStmts(pix, shape) {
  const args = (x, y) => [x, y, ...(shape.t ? [nm('ev_tv')] : []),
    ...(shape.col ? [nm('ev_cr'), num(0), nm('ev_cg'), num(0), nm('ev_cb'), num(0)] : [])];
  const px = shape.col
    ? [
      ex(call(pix, args(nm('ev_x'), nm('ev_y')))),
      aset('ev_row', nm('ev_px'), call('ev_rgb', [aget('ev_cr', num(0)),
        aget('ev_cg', num(0)), aget('ev_cb', num(0))])),
    ]
    : [aset('ev_row', nm('ev_px'), call('ev_col', [call(pix, args(nm('ev_x'), nm('ev_y')))]))];
  return [
    letR('ev_tv', dev('klock')),
    letR('ev_w', dev('xres')),
    letR('ev_h', dev('yres')),
    /* 一行那一块：宽变了才重开（省掉每帧一次 `anew`）。 */
    iff(bin('!=', nm('ev_rown'), nm('ev_w')), [
      set('ev_row', anew(nm('ev_w'))),
      set('ev_rown', nm('ev_w')),
    ]),
    /* `frameinit` 那一趟：每帧**多调一次**主体、`ev_fi` 置 1（`evaldraw.txt:1428`）。 */
    set('ev_fi', num(1)),
    ex(call(pix, args(num(0), num(0)))),
    set('ev_fi', num(0)),
    letR('ev_py', num(0)),
    whil(bin('<', nm('ev_py'), nm('ev_h')), [
      letR('ev_y', bin('+', nm('ev_gy0'), bin('*', bin('/', bin('+', nm('ev_py'), num(0.5)),
        nm('ev_h')), bin('-', nm('ev_gy1'), nm('ev_gy0'))))),
      letR('ev_px', num(0)),
      whil(bin('<', nm('ev_px'), nm('ev_w')), [
        letR('ev_x', bin('+', nm('ev_gx0'), bin('*', bin('/', bin('+', nm('ev_px'), num(0.5)),
          nm('ev_w')), bin('-', nm('ev_gx1'), nm('ev_gx0'))))),
        ...px,
        set('ev_px', bin('+', nm('ev_px'), num(1))),
      ]),
      /* `(gfxarr …)` 那四格实参要是 real（方言那一格的规矩）—— 所以别在这儿 `toint`。 */
      ex(bi('gfxarr', [str('setrow'), nm('ev_py'), num(0), nm('ev_w'), num(0), nm('ev_row')])),
      set('ev_py', bin('+', nm('ev_py'), num(1))),
    ]),
  ];
}
