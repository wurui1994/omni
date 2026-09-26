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
//     (x,y,z,&r,&g,&b)    3D 体素：**单位立方体里的网格**，每格调一次
//     (x,y,z,t,&r,&g,&b)  3D 体素 + 时间
//
// ## 这一份接的是 2D 那四档 + 3D 体素那两档
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
  ARR, num, str, nm, bin, call, bi, rm, set, letR, letI, inum, agetI, asetI, ret, iff, whil, ex,
  aset, aget, fn, glob, anew, tern,
} from './ir.js';

/** 一格宿主调用（与 `gl-rt.js` 的 `dev` 同一格）。 */
const dev = (name, args = []) => bi('gfxcall', [str(name), ...args]);

/** 这一档的模块级那几格（`ev_` 前缀 —— 脚本里的名字不会撞）。 */
export const GRAPH_GLOBALS = ['ev_fi', 'ev_gx0', 'ev_gy0', 'ev_gx1', 'ev_gy1', 'ev_rown',
  /* 3D 体素那两档：网格边长（开出来那一趟记在这儿）。 */
  'ev_vn'];

export function graphGlobalDecls() {
  return [...GRAPH_GLOBALS.map((n) => glob(n)),
    glob('ev_row', ARR), glob('ev_cr', ARR), glob('ev_cg', ARR), glob('ev_cb', ARR),
    glob('ev_vox', ARR)];
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

/* ============================================================ 3D 体素那两档
 *
 * 口径（`evaldraw.txt:1311`）：函数在**单位立方体 (-1,-1,-1)..(1,1,1) 里的网格**上
 * 每格调一次，回值 `> 0` 是实心、`<= 0` 是空气，颜色从 `&r,&g,&b` 拿（0..255）。
 *
 * 落法：**评估 + 抽面 + 画立方体**三步，全在语言这一侧（设备只收顶点批）——
 *
 *   1. N³ 次调主体，一格一格存进 `ev_vox`（实心存打包好的颜色，空气存 -1）；
 *   2. 只画**表面**那些面：六个方向上邻居是空气（或出了网格）才发那一面；
 *   3. 每面一个 `GL_QUADS` 的四边形，走 `gl-rt.js` 那台立即模式的状态机
 *      （`gl_begin(7)` / `gl_vertex3` / `gl_color3` / `gl_end`）。
 *
 * **三处明写偏差**（evaldraw 没有源码，说明书只钉住"网格 + 回值 + 颜色"这三件事）：
 *
 *   * 网格边长固定 `VOXRES`（说明书里那是菜单项 `voxres`，语料里没人读它）；
 *   * **镜头固定**（说明书里是鼠标拖的）—— 在 `(2.2,-2.6,1.9)` 看原点、上是 +z；
 *   * 面的明暗按**法向**给一格常数因子（没有光照那一摊）：顶最亮、底最暗。
 */

/** 体素网格的边长。32³ = 32768 次调用一帧 —— 判据那条线（一份 ≤ 10s）下够用。 */
const VOXRES = 32;

/** 六个面：`[名字, 轴, 正负, 明暗, 四个角(用 x0/x1/y0/y1/z0/z1 拼)]`。 */
const FACES = [
  ['nx', 'ix', -1, 0.65, [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
  ['px', 'ix', +1, 0.80, [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]],
  ['ny', 'iy', -1, 0.55, [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
  ['py', 'iy', +1, 0.90, [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]]],
  ['nz', 'iz', -1, 0.45, [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]],
  ['pz', 'iz', +1, 1.00, [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
];

/** 一批攒多少个四边形就断一次（`gl-rt.js` 的顶点上限是 16384 格）。 */
const QMAX = 3000;

/** 网格坐标：第 `i` 格（0..N-1）的**边**落在 -1 + i*2/N 上。 */
const edge = (i) => bin('+', num(-1), bin('*', i, num(2 / VOXRES)));

/**
 * 一格四边形：颜色（按面的明暗因子）+ 四个角 + 攒够就断批。
 * `c` 是那一格打包好的颜色（0xRRGGBB），拆成三格 0..1 再乘明暗。
 */
function quadStmts(shade, corners) {
  const chan = (e) => bin('*', bin('/', e, num(255)), num(shade));
  const co = (k) => nm(['ev_x0', 'ev_y0', 'ev_z0'][k]);
  const c1 = (k) => nm(['ev_x1', 'ev_y1', 'ev_z1'][k]);
  return [
    ex(call('gl_color3', [chan(nm('ev_vr')), chan(nm('ev_vg')), chan(nm('ev_vb'))])),
    ...corners.map(([a, b, c]) => ex(call('gl_vertex3',
      [(a ? c1 : co)(0), (b ? c1 : co)(1), (c ? c1 : co)(2)]))),
    set('ev_q', bin('+', nm('ev_q'), inum(1))),
    iff(bin('>=', nm('ev_q'), inum(QMAX)), [
      ex(call('gl_end', [])),
      ex(call('gl_begin', [num(7)])),
      set('ev_q', inum(0)),
    ]),
  ];
}

/**
 * 一个面：**邻居是空气才画**。先把"邻居是不是空气"算进一格局部量 ——
 * `||` 在这一层不保证短路，而出了网格那一头下标会越界，所以分两句写。
 */
function faceStmts([name, axis, sgn, shade, corners]) {
  const off = axis === 'ix' ? 1 : axis === 'iy' ? VOXRES : VOXRES * VOXRES;
  const at = sgn < 0 ? bin('-', nm('ev_k'), inum(off)) : bin('+', nm('ev_k'), inum(off));
  /* 出了网格那一头（-1 那侧 i == 0、+1 那侧 i == N-1）：外头就是空气。 */
  const inside = sgn < 0
    ? bin('>', nm(`ev_${axis}`), num(0.5))
    : bin('<', nm(`ev_${axis}`), num(VOXRES - 1.5));
  const air = `ev_a${name}`;
  return [
    letR(air, num(1)),
    iff(inside, [iff(bin('>=', agetI('ev_vox', at), num(0)), [set(air, num(0))])]),
    iff(bin('>', nm(air), num(0.5)), quadStmts(shade, corners)),
  ];
}

/**
 * 一帧的 3D 体素那两档：`frameinit` 一趟 + N³ 次评估 + 抽面画立方体。
 * `shape` 只用 `t` 那一格（颜色永远从 `&r,&g,&b` 来）。
 */
export function graph3dFrameStmts(pix, shape) {
  const N = VOXRES;
  const args = (x, y, z) => [x, y, z, ...(shape.t ? [nm('ev_tv')] : []),
    nm('ev_cr'), num(0), nm('ev_cg'), num(0), nm('ev_cb'), num(0)];
  const ctr = (i) => bin('+', num(-1 + 1 / N), bin('*', i, num(2 / N)));
  return [
    letR('ev_tv', dev('klock')),
    /* 网格那一块：一次开好（边长是编译期常数，所以只有第一帧走这儿）。 */
    iff(bin('!=', nm('ev_vn'), num(N)), [
      set('ev_vox', anew(num(N * N * N))),
      set('ev_vn', num(N)),
    ]),
    /* `frameinit` 那一趟（与 2D 同一条口径，`evaldraw.txt:1428`）。 */
    set('ev_fi', num(1)),
    ex(call(pix, args(num(0), num(0), num(0)))),
    set('ev_fi', num(0)),
    /* ── 一、评估：一格一格存颜色，空气存 -1 ── */
    letI('ev_k', inum(0)),
    letR('ev_iz', num(0)),
    whil(bin('<', nm('ev_iz'), num(N)), [
      letR('ev_z', ctr(nm('ev_iz'))),
      letR('ev_iy', num(0)),
      whil(bin('<', nm('ev_iy'), num(N)), [
        letR('ev_y', ctr(nm('ev_iy'))),
        letR('ev_ix', num(0)),
        whil(bin('<', nm('ev_ix'), num(N)), [
          letR('ev_x', ctr(nm('ev_ix'))),
          letR('ev_s', call(pix, args(nm('ev_x'), nm('ev_y'), nm('ev_z')))),
          asetI('ev_vox', nm('ev_k'), tern(bin('>', nm('ev_s'), num(0)),
            call('ev_rgb', [aget('ev_cr', num(0)), aget('ev_cg', num(0)),
              aget('ev_cb', num(0))]), num(-1))),
          set('ev_k', bin('+', nm('ev_k'), inum(1))),
          set('ev_ix', bin('+', nm('ev_ix'), num(1))),
        ]),
        set('ev_iy', bin('+', nm('ev_iy'), num(1))),
      ]),
      set('ev_iz', bin('+', nm('ev_iz'), num(1))),
    ]),
    /* ── 二、镜头（固定，明写偏差）+ 深度测试 ── */
    ex(call('gl_framebegin', [])),
    ex(call('gl_enable', [num(0x0b71)])),
    ex(call('gl_lookat', [num(1.5), num(-1.75), num(1.25),
      num(0), num(0), num(0), num(0), num(0), num(1)])),
    /* ── 三、抽面 + 画：一格实心体素最多六面，邻居是空气的才发 ── */
    ex(call('gl_begin', [num(7)])),
    letI('ev_q', inum(0)),
    set('ev_k', inum(0)),
    set('ev_iz', num(0)),
    whil(bin('<', nm('ev_iz'), num(N)), [
      letR('ev_z0', edge(nm('ev_iz'))),
      letR('ev_z1', bin('+', nm('ev_z0'), num(2 / N))),
      letR('ev_iy', num(0)),
      whil(bin('<', nm('ev_iy'), num(N)), [
        letR('ev_y0', edge(nm('ev_iy'))),
        letR('ev_y1', bin('+', nm('ev_y0'), num(2 / N))),
        letR('ev_ix', num(0)),
        whil(bin('<', nm('ev_ix'), num(N)), [
          letR('ev_c', agetI('ev_vox', nm('ev_k'))),
          iff(bin('>=', nm('ev_c'), num(0)), [
            letR('ev_x0', edge(nm('ev_ix'))),
            letR('ev_x1', bin('+', nm('ev_x0'), num(2 / N))),
            letR('ev_vr', rm('floor', [bin('/', nm('ev_c'), num(65536))])),
            letR('ev_vg', rm('floor', [bin('/', bin('-', nm('ev_c'),
              bin('*', nm('ev_vr'), num(65536))), num(256))])),
            letR('ev_vb', bin('-', nm('ev_c'), bin('+', bin('*', nm('ev_vr'), num(65536)),
              bin('*', nm('ev_vg'), num(256))))),
            ...FACES.flatMap((f) => faceStmts(f)),
          ]),
          set('ev_k', bin('+', nm('ev_k'), inum(1))),
          set('ev_ix', bin('+', nm('ev_ix'), num(1))),
        ]),
        set('ev_iy', bin('+', nm('ev_iy'), num(1))),
      ]),
      set('ev_iz', bin('+', nm('ev_iz'), num(1))),
    ]),
    ex(call('gl_end', [])),
  ];
}
