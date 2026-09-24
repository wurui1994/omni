// ext/polydraw/gfx3-rt.js —— **EvalDraw 的 3D 那一族：在语言这一侧投影成 2D**
//
// 语料里 `.kc` 的主力就是这一族：`drawcone` 357 次、`drawsph` 195 次、`setcam` 47 次、
// `clz` 48 次。它们**不是设备的一格**：投影是纯算术，按"只有一个模型"
// （`docs/design/eval-realtime-gpu.md` 第 9 节）放在语言这一侧 —— 设备只收 2D 图元。
//
// ## 口径（`evaldraw.txt:1543-1590`，照抄不猜）
//
//     clz(d)                      清软件 z 缓冲（**这一版没有 z 缓冲** —— 收下记着不用）
//     setcam(x,y,z,hang,vang)     相机位置 + 朝向（hang/vang 是**弧度**）
//     setcam(x,y,z, rx,ry,rz, dx,dy,dz, fx,fy,fz)   直接给 3×3（右/下/前三个向量）
//     setview(x0,y0,x1,y1[,hx,hy,hz])   视口 + 投影的那三个数
//     投影公式（说明书原文）：screen_x = x/z*hz + hx;  screen_y = y/z*hz + hy;
//     默认：hx = xres/2; hy = yres/2; hz = hx;   （水平 FOV 90°）
//     drawsph(x,y,z,rad)          带透视的球（**我们画的是投影后的圆**，见下）
//     drawcone(x0,y0,z0,r0, x1,y1,z1,r1[,flags])    锥/胶囊（两端投影成 2D 粗线）
//     moveto/lineto 的三参版      3D 走笔
//
// ## 三处**明写的偏差**（照不到的地方不装作照到）
//
// 1. **没有着色**：原版的 `drawsph` 是带光照与 z 缓冲的实心球，我们画的是投影后的
//    **平色圆**（半径 `rad/z*hz`）；`drawcone` 同理落成 2D 粗线。形状与位置是对的，
//    明暗与遮挡不是 —— 真 3D 要 GPU 那两档设备 + z 缓冲。
// 2. **没有 z 缓冲**：`clz` 收下不用；画的次序就是遮挡次序（后画的盖前画的）。
// 3. **`setcam` 五参那一档的三个向量是我们定的**（原版只给了"hang 水平、vang 垂直"）：
//        前 = (sin h·cos v,  sin v,  cos h·cos v)
//        右 = (cos h,        0,     -sin h)
//        下 = 前 × 右（右手系，y 往下为正 —— 与 2D 画布同向）
//    十二参那一档是脚本自己给的矩阵，没有猜的余地。
//
// z 在相机后头（`z <= 近`）的图元**整格丢掉**（近平面裁剪这一版没做）。

import {
  REAL, ARR, num, str, nm, bin, call, bi, rm, set, letR, ret, iff, whil, ex, aset, aget, ix,
  fn, fnT, glob,
} from './ir.js';

/** 相机与视口那几格（名字都带 `g3_` 前缀）。 */
export const GFX3_GLOBALS = [
  'g3_on', 'g3_cx', 'g3_cy', 'g3_cz',
  'g3_rx', 'g3_ry', 'g3_rz', 'g3_dx', 'g3_dy', 'g3_dz', 'g3_fx', 'g3_fy', 'g3_fz',
  'g3_hx', 'g3_hy', 'g3_hz',
  /* 投影出来的那三个数（`g3_xf` 算完摆在这儿：屏幕 x/y + 相机空间的 z）。 */
  'g3_sx', 'g3_sy', 'g3_sz',
];

export function gfx3GlobalDecls() {
  return GFX3_GLOBALS.map((n) => glob(n));
}

/**
 * **宿主名字/元数 -> 生成出来的那格函数**（EvalDraw 的 3D 那一档 + 声音那几格）。
 *
 * 声音那一族（`playsound`/`playtext`/`playsong`/`playnote`，语料里 500 多次）**收下不响**：
 * 这条腿上没有音频出口，但它们从来不是画面的一部分 —— 报了反而让整份脚本出不了图。
 */
export const EVALDRAW_3D = new Map([
  ['clz/1', 'g3_clz'],
  ['setcam/5', 'g3_setcam5'],
  ['setcam/12', 'g3_setcam12'],
  ['setview/4', 'g3_setview4'],
  ['setview/7', 'g3_setview7'],
  ['drawsph/4', 'g3_sph'],
  ['drawcone/8', 'g3_cone'],
  ['drawcone/9', 'g3_cone9'],
  ['drawcone/7', 'g3_cone2d7'],
  ['moveto/3', 'g3_moveto'],
  ['lineto/3', 'g3_lineto'],
  /* **横线那一族**（`evaldraw.txt:1491`）：`gethlin(x0,y,buf,dx)` 读一行、
     `sethlin(x0,y,buf,dx[,flags])` 写一行 —— 一整块像素，所以形参里有数组
     （调用点按 `BLOCK_ARGS` 那张白名单配对着发：块 + 偏移）。 */
  ['sethlin/4', 'g3_sethlin4'],
  ['sethlin/5', 'g3_sethlin5'],
  ['gethlin/4', 'g3_gethlin4'],
  /* `getpicsiz(&x,&y)` / `getpicsiz("a.png",&x,&y)`（`evaldraw.txt:1348`）：这条腿上没有
     图片（解码器那一层还没有，见 11.3）⇒ **写回 0×0**，脚本自己判得出来。 */
  ['getpicsiz/2', 'g3_getpicsiz2'],
  ['getpicsiz/3', 'g3_getpicsiz3'],
  /* 声音那一族：收下不响（见头注）。 */
  ['playsound/1', 'g3_nop1'], ['playsound/2', 'g3_nop2'], ['playsound/3', 'g3_nop3'],
  ['playsound/4', 'g3_nop4'], ['playsound/5', 'g3_nop5'],
  ['playtext/1', 'g3_nop1'], ['playtext/2', 'g3_nop2'], ['playtext/3', 'g3_nop3'],
  ['playtext/4', 'g3_nop4'],
  ['playsong/1', 'g3_nop1'], ['playsong/2', 'g3_nop2'],
  ['playnote/1', 'g3_nop1'], ['playnote/2', 'g3_nop2'], ['playnote/3', 'g3_nop3'],
  ['playnote/4', 'g3_nop4'],
]);

/* ─── 生成出来的那一摊 ────────────────────────────────────────────────── */

/**
 * 2D 那几格的落点**按产物形状选一次**：宿主设备那条路发 `(gfxcall "名字" …)`，
 * 生成出来那条 CPU 路调 `gfx_*`（`gfx-rt.js` 那一份）。两条路**只有落点不同**，
 * 投影那段算术只有一份 —— 这正是"只有一个模型"。
 */
function d2(host) {
  const dev = (name, args) => bi('gfxcall', [str(name), ...args]);
  return {
    sph: (x, y, r) => (host ? dev('drawsph', [x, y, r]) : call('gfx_sph', [x, y, r])),
    cone: (a, b, c, d, e, f) => (host
      ? dev('drawcone', [a, b, c, d, e, f])
      : call('gfx_cone', [a, b, c, d, e, f])),
    moveto: (x, y) => (host ? dev('moveto', [x, y]) : call('gfx_moveto', [x, y])),
    lineto: (x, y) => (host ? dev('lineto', [x, y]) : call('gfx_lineto', [x, y])),
    xres: () => (host ? dev('xres', []) : nm('gfx_w')),
    yres: () => (host ? dev('yres', []) : nm('gfx_h')),
    setcol1: (c) => (host ? dev('setcol', [c]) : call('gfx_setcol1', [c])),
    setpix: (x, y) => (host ? dev('setpix', [x, y]) : call('gfx_setpix', [x, y])),
    /* `getpix` 只有宿主设备那一档有（生成出来那一份没做读回）—— 那一档回 0。 */
    getpix: (x, y) => (host ? dev('getpix', [x, y]) : num(0)),
  };
}

/** 近平面：`z` 比它还小的点整格丢掉（这一版没有插值裁剪）。 */
const ZNEAR = 1e-6;

export function gfx3FnDecls(host = false) {
  const D = d2(host);
  return [
    /** 第一次用 3D 那一族时把相机摆成"在原点、朝 +z"、视口按画布中心。 */
    fn('g3_need', [], [
      iff(bin('!=', nm('g3_on'), num(0)), [ret(num(0))]),
      set('g3_on', num(1)),
      set('g3_cx', num(0)), set('g3_cy', num(0)), set('g3_cz', num(0)),
      set('g3_rx', num(1)), set('g3_ry', num(0)), set('g3_rz', num(0)),
      set('g3_dx', num(0)), set('g3_dy', num(1)), set('g3_dz', num(0)),
      set('g3_fx', num(0)), set('g3_fy', num(0)), set('g3_fz', num(1)),
      set('g3_hx', bin('*', D.xres(), num(0.5))),
      set('g3_hy', bin('*', D.yres(), num(0.5))),
      set('g3_hz', bin('*', D.xres(), num(0.5))),
      ret(num(0)),
    ]),
    /* `clz(d)`：这一档没有 z 缓冲（见头注第 2 条）—— 收下记着不用。 */
    fn('g3_clz', ['d'], [ex(call('g3_need', [])), ret(num(0))]),
    fn('g3_nop1', ['a'], [ret(num(0))]),
    fn('g3_nop2', ['a', 'b'], [ret(num(0))]),
    fn('g3_nop3', ['a', 'b', 'c'], [ret(num(0))]),
    fn('g3_nop4', ['a', 'b', 'c', 'd'], [ret(num(0))]),
    fn('g3_nop5', ['a', 'b', 'c', 'd', 'e'], [ret(num(0))]),
    /**
     * `setcam(x,y,z,hang,vang)`：三个向量照头注第 3 条那一套算。
     * `下 = 前 × 右` 用的是"y 往下为正"那一手（与 2D 画布同向）。
     */
    fn('g3_setcam5', ['x', 'y', 'z', 'ha', 'va'], [
      ex(call('g3_need', [])),
      set('g3_cx', nm('x')), set('g3_cy', nm('y')), set('g3_cz', nm('z')),
      letR('ch', rm('cos', [nm('ha')])), letR('sh', rm('sin', [nm('ha')])),
      letR('cv', rm('cos', [nm('va')])), letR('sv', rm('sin', [nm('va')])),
      set('g3_fx', bin('*', nm('sh'), nm('cv'))),
      set('g3_fy', nm('sv')),
      set('g3_fz', bin('*', nm('ch'), nm('cv'))),
      set('g3_rx', nm('ch')), set('g3_ry', num(0)),
      set('g3_rz', bin('-', num(0), nm('sh'))),
      /* 下 = 前 × 右。 */
      set('g3_dx', bin('-', bin('*', nm('g3_fy'), nm('g3_rz')), bin('*', nm('g3_fz'), nm('g3_ry')))),
      set('g3_dy', bin('-', bin('*', nm('g3_fz'), nm('g3_rx')), bin('*', nm('g3_fx'), nm('g3_rz')))),
      set('g3_dz', bin('-', bin('*', nm('g3_fx'), nm('g3_ry')), bin('*', nm('g3_fy'), nm('g3_rx')))),
      ret(num(0)),
    ]),
    fn('g3_setcam12', ['x', 'y', 'z', 'rx', 'ry', 'rz', 'dx', 'dy', 'dz', 'fx', 'fy', 'fz'], [
      ex(call('g3_need', [])),
      set('g3_cx', nm('x')), set('g3_cy', nm('y')), set('g3_cz', nm('z')),
      set('g3_rx', nm('rx')), set('g3_ry', nm('ry')), set('g3_rz', nm('rz')),
      set('g3_dx', nm('dx')), set('g3_dy', nm('dy')), set('g3_dz', nm('dz')),
      set('g3_fx', nm('fx')), set('g3_fy', nm('fy')), set('g3_fz', nm('fz')),
      ret(num(0)),
    ]),
    /* `setview(x0,y0,x1,y1)`：视口那一档这一版**只记不用**（我们画的是整块画布），
       投影那三个数按这一块的中心重摆（说明书里短形式就是这么补默认的）。 */
    fn('g3_setview4', ['x0', 'y0', 'x1', 'y1'], [
      ex(call('g3_need', [])),
      set('g3_hx', bin('*', bin('+', nm('x0'), nm('x1')), num(0.5))),
      set('g3_hy', bin('*', bin('+', nm('y0'), nm('y1')), num(0.5))),
      set('g3_hz', bin('*', bin('-', nm('x1'), nm('x0')), num(0.5))),
      ret(num(0)),
    ]),
    fn('g3_setview7', ['x0', 'y0', 'x1', 'y1', 'hx', 'hy', 'hz'], [
      ex(call('g3_need', [])),
      set('g3_hx', nm('hx')), set('g3_hy', nm('hy')), set('g3_hz', nm('hz')),
      ret(num(0)),
    ]),
    /**
     * 一格点：世界 -> 相机 -> 屏幕。结果摆在 `g3_sx/g3_sy/g3_sz` 上
     * （`g3_sz` 是相机空间的 z —— 调用方靠它判"在不在前头"、算半径）。
     */
    fn('g3_xf', ['x', 'y', 'z'], [
      ex(call('g3_need', [])),
      letR('ox', bin('-', nm('x'), nm('g3_cx'))),
      letR('oy', bin('-', nm('y'), nm('g3_cy'))),
      letR('oz', bin('-', nm('z'), nm('g3_cz'))),
      set('g3_sz', bin('+', bin('+', bin('*', nm('ox'), nm('g3_fx')),
        bin('*', nm('oy'), nm('g3_fy'))), bin('*', nm('oz'), nm('g3_fz')))),
      iff(bin('<=', nm('g3_sz'), num(ZNEAR)), [ret(num(0))]),
      letR('vx', bin('+', bin('+', bin('*', nm('ox'), nm('g3_rx')),
        bin('*', nm('oy'), nm('g3_ry'))), bin('*', nm('oz'), nm('g3_rz')))),
      letR('vy', bin('+', bin('+', bin('*', nm('ox'), nm('g3_dx')),
        bin('*', nm('oy'), nm('g3_dy'))), bin('*', nm('oz'), nm('g3_dz')))),
      set('g3_sx', bin('+', bin('*', bin('/', nm('vx'), nm('g3_sz')), nm('g3_hz')), nm('g3_hx'))),
      set('g3_sy', bin('+', bin('*', bin('/', nm('vy'), nm('g3_sz')), nm('g3_hz')), nm('g3_hy'))),
      ret(num(1)),
    ]),
    /* `drawsph(x,y,z,rad)`：投影成一格圆（半径 `rad/z*hz`）。见头注第 1 条。 */
    fn('g3_sph', ['x', 'y', 'z', 'r'], [
      iff(bin('==', call('g3_xf', [nm('x'), nm('y'), nm('z')]), num(0)), [ret(num(0))]),
      letR('sr', bin('*', bin('/', rm('fabs', [nm('r')]), nm('g3_sz')), nm('g3_hz'))),
      iff(bin('<', nm('sr'), num(0.5)), [set('sr', num(0.5))]),
      ex(D.sph(nm('g3_sx'), nm('g3_sy'), nm('sr'))),
      ret(num(0)),
    ]),
    /* `drawcone(x0,y0,z0,r0,x1,y1,z1,r1)`：两端各投影，落成一格 2D 粗线。 */
    fn('g3_cone', ['x0', 'y0', 'z0', 'r0', 'x1', 'y1', 'z1', 'r1'], [
      iff(bin('==', call('g3_xf', [nm('x0'), nm('y0'), nm('z0')]), num(0)), [ret(num(0))]),
      letR('ax', nm('g3_sx')), letR('ay', nm('g3_sy')),
      letR('ar', bin('*', bin('/', rm('fabs', [nm('r0')]), nm('g3_sz')), nm('g3_hz'))),
      iff(bin('==', call('g3_xf', [nm('x1'), nm('y1'), nm('z1')]), num(0)), [ret(num(0))]),
      letR('br', bin('*', bin('/', rm('fabs', [nm('r1')]), nm('g3_sz')), nm('g3_hz'))),
      iff(bin('<', nm('ar'), num(0.5)), [set('ar', num(0.5))]),
      iff(bin('<', nm('br'), num(0.5)), [set('br', num(0.5))]),
      ex(D.cone(nm('ax'), nm('ay'), nm('ar'), nm('g3_sx'), nm('g3_sy'), nm('br'))),
      ret(num(0)),
    ]),
    /* 带 flags 的两档（`DRAWCONE_*`）：这一版**旗子收下不用**（没有着色与剔除）。 */
    fn('g3_cone9', ['x0', 'y0', 'z0', 'r0', 'x1', 'y1', 'z1', 'r1', 'fl'], [
      ex(call('g3_cone', [nm('x0'), nm('y0'), nm('z0'), nm('r0'),
        nm('x1'), nm('y1'), nm('z1'), nm('r1')])),
      ret(num(0)),
    ]),
    /* `drawcone(x0,y0,r0,x1,y1,r1,flags)`：**2D** 那一档带旗子的写法。 */
    fn('g3_cone2d7', ['x0', 'y0', 'r0', 'x1', 'y1', 'r1', 'fl'], [
      ex(D.cone(nm('x0'), nm('y0'), nm('r0'), nm('x1'), nm('y1'), nm('r1'))),
      ret(num(0)),
    ]),
    fn('g3_moveto', ['x', 'y', 'z'], [
      iff(bin('==', call('g3_xf', [nm('x'), nm('y'), nm('z')]), num(0)), [ret(num(0))]),
      ex(D.moveto(nm('g3_sx'), nm('g3_sy'))),
      ret(num(0)),
    ]),
    fn('g3_lineto', ['x', 'y', 'z'], [
      iff(bin('==', call('g3_xf', [nm('x'), nm('y'), nm('z')]), num(0)), [ret(num(0))]),
      ex(D.lineto(nm('g3_sx'), nm('g3_sy'))),
      ret(num(0)),
    ]),
    /**
     * `sethlin(x0,y,buf,dx)`：从 `buf` 往 `(x0,y)` 起的横线写 `dx` 格像素
     * （`evaldraw.txt:1492`：它就是"省掉 dx 次 setcol+setpix"的快路）。
     * 像素是**打包好的颜色**（`0xRRGGBB`，与 `rgb()` 回的那种数同一形）。
     * `buf` 后头那格 `bo` 是它的偏移（`&buf[i]` 那一族 —— 见第 8.6 节）。
     */
    fnT('g3_sethlin4', [['x0'], ['y'], ['buf', ARR], ['bo'], ['dx']], [
      letR('i', num(0)),
      whil(bin('<', nm('i'), nm('dx')), [
        ex(D.setcol1(aget('buf', bin('+', nm('bo'), nm('i'))))),
        ex(D.setpix(bin('+', nm('x0'), nm('i')), nm('y'))),
        set('i', bin('+', nm('i'), num(1))),
      ]),
      ret(num(0)),
    ]),
    /* 带 flags 的那一档（mask/blend/add，`evaldraw.txt:83`）：**旗子收下不用**。 */
    fnT('g3_sethlin5', [['x0'], ['y'], ['buf', ARR], ['bo'], ['dx'], ['fl']], [
      ex(call('g3_sethlin4', [nm('x0'), nm('y'), nm('buf'), nm('bo'), nm('dx')])),
      ret(num(0)),
    ]),
    /* `gethlin(x0,y,buf,dx)`：反过来 —— 读一行像素进 `buf`。 */
    fnT('g3_gethlin4', [['x0'], ['y'], ['buf', ARR], ['bo'], ['dx']], [
      letR('i', num(0)),
      whil(bin('<', nm('i'), nm('dx')), [
        aset('buf', bin('+', nm('bo'), nm('i')), D.getpix(bin('+', nm('x0'), nm('i')), nm('y'))),
        set('i', bin('+', nm('i'), num(1))),
      ]),
      ret(num(0)),
    ]),
    /* `getpicsiz(&x,&y)`：没有图片 ⇒ 写回 0×0（见那张表里的注）。 */
    fnT('g3_getpicsiz2', [['px', ARR], ['po'], ['py', ARR], ['qo']], [
      aset('px', nm('po'), num(0)),
      aset('py', nm('qo'), num(0)),
      ret(num(0)),
    ]),
    fnT('g3_getpicsiz3', [['nam'], ['px', ARR], ['po'], ['py', ARR], ['qo']], [
      ex(call('g3_getpicsiz2', [nm('px'), nm('po'), nm('py'), nm('qo')])),
      ret(num(0)),
    ]),
  ];
}
