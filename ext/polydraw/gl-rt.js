// ext/polydraw/gl-rt.js —— **PolyDraw 的 GL 立即模式，落在同一块帧缓冲上**
//
// PolyDraw 的宿主是**真 OpenGL 1.x 的薄包装**（`polydraw.c:619` 起那一排 `qgl*`：
// `qglVertex2d` 就是 `glVertex2d`）。所以这一层的口径不是"猜 PolyDraw 怎么画"，
// 而是**照固定管线的定义算**：顶点过 MODELVIEW 再过 PROJECTION、除以 w、映到视口，
// 三角形按重心坐标插值顶点色。
//
// ## 这条腿接到哪儿、不接哪儿（明写，不装作全都有）
//
// **接**：`glClear` / `glBegin`+`glEnd` / `glVertex`(2,3,4) / `glColor`(3,4) /
// `glTranslate` / `glRotate` / `glScale` / `glPushMatrix` / `glPopMatrix` /
// `gluPerspective` / `setfov`，外加 `glEnable`/`glDisable`/`glCullFace`/`glBlendFunc`/
// `glLineWidth`/`glNormal` 这几格**收下但不管**（这条腿上没有光照与混合）。
//
// **不接**（当场报，不静默画错）：着色器那一族（`glSetShader`/`glUniform*`/`glGetUniformLoc`）、
// 纹理那一族（`glSetTex`/`glGetTex`/`glBindTexture`/`glTexCoord`）、`glMultMatrix`
// （要一格数组形参）、`glCapture`。PolyDraw 里最漂亮的那些例子（`ken/gspiral.pss` 之类）
// 正是**可编程管线 + 纹理**那一路 —— 它们在这条腿上跑不了，这一点不该含糊。
//
// ## 三个约定
//
// 1. **矩阵是列主序**（与 GL 一样）：`m[col*4+row]`，`gl_mv` / `gl_pj` 各 16 格。
//    `glTranslate`/`Rotate`/`Scale` 一律**右乘** MODELVIEW（`M = M · T`），与 GL 同。
// 2. 顶点先攒着（`gl_vb`，一格顶点 6 个数：屏幕 x、屏幕 y、深度、r、g、b），
//    `glEnd` 那一刻按 `mode` 拆成点/线段/三角形。**上限 1024 个顶点**，超了丢掉。
// 3. `w <= 0` 的顶点**整格丢掉**（近平面裁剪这一版没做插值）—— 透视图里跨近平面的
//    三角形会缺一块，记在这儿。
import {
  ARR, num, nm, bin, call, rm, set, letR, ret, iff, whil, ex, aset, aget, fn, glob, anew, tern,
} from './ir.js';

/** 一格顶点占 6 个数。 */
const VS = 6;
const VMAX = 1024;

/** `gl_vb` 的第 i 个顶点的第 k 格。 */
const vb = (i, k) => aget('gl_vb', bin('+', bin('*', i, num(VS)), num(k)));
const vbset = (i, k, v) => aset('gl_vb', bin('+', bin('*', i, num(VS)), num(k)), v);

/** 设备那几格模块级的量（名字都带 `gl_` 前缀）。 */
export const GL_GLOBALS = ['gl_on', 'gl_mode', 'gl_n', 'gl_r', 'gl_g', 'gl_b',
  'gl_sp', 'gl_fov', 'gl_fovt', 'gl_cx', 'gl_cy', 'gl_cz', 'gl_cw'];

export function glGlobalDecls() {
  return [
    ...GL_GLOBALS.map((n) => glob(n)),
    glob('gl_mv', ARR), glob('gl_pj', ARR), glob('gl_st', ARR),
    glob('gl_tm', ARR), glob('gl_ta', ARR), glob('gl_vb', ARR),
  ];
}

/**
 * **宿主名字/元数 -> 生成出来的那格函数**（PolyDraw 的固定管线那一档）。
 *
 * 名字照 `polydraw.c:2070` 的 `myext[]`（那张表里是大写 + 形参个数，例如
 * `"GLVERTEX(,,)"` 就是三参那一版）—— 这门语言名字不分大小写，adapter 已经折成小写。
 */
export const POLYDRAW_GL = new Map([
  ['glclear/1', 'gl_clear'],
  ['glbegin/1', 'gl_begin'],
  ['glend/0', 'gl_end'],
  ['glvertex/2', 'gl_vertex2'],
  ['glvertex/3', 'gl_vertex3'],
  ['glvertex/4', 'gl_vertex4'],
  ['glcolor/3', 'gl_color3'],
  ['glcolor/4', 'gl_color4'],
  ['gltranslate/3', 'gl_translate'],
  ['glrotate/4', 'gl_rotate'],
  ['glscale/3', 'gl_scale'],
  ['glpushmatrix/0', 'gl_push'],
  ['glpopmatrix/0', 'gl_pop'],
  ['gluperspective/4', 'gl_perspective'],
  ['setfov/1', 'gl_setfov'],
  /* **每帧的 GL 初态**（照 `polydraw.c:3572-3579`）：adapter 在每帧开头发这一格。 */
  ['framebegin/0', 'gl_framebegin'],
  /* 收下但不管的那几格（这条腿上没有光照/混合/剔除）。 */
  ['glnormal/3', 'gl_nop3'],
  ['glenable/1', 'gl_nop1'],
  ['gldisable/1', 'gl_nop1'],
  ['glcullface/1', 'gl_nop1'],
  ['gllinewidth/1', 'gl_nop1'],
  ['glswapinterval/1', 'gl_nop1'],
  ['glblendfunc/2', 'gl_nop2'],
  ['glalphaenable/1', 'gl_nop1'],
  ['glalphadisable/1', 'gl_nop1'],
  /* `RGB(r,g,b)` 把三个分量打成一个 24 位的数 —— 设备里已经有那一格。 */
  ['rgb/3', 'gfx_rgb'],
]);

/**
 * **GL 的那批常量**（宿主表里它们是"名字 -> 一格 double"）。值照 `GL/gl.h`，
 * 不是我们自己编的号 —— 脚本里写 `glBegin(GL_TRIANGLE_FAN)` 时那个数必须是 6。
 */
export const GL_CONSTS = new Map([
  ['gl_points', 0], ['gl_lines', 1], ['gl_line_loop', 2], ['gl_line_strip', 3],
  ['gl_triangles', 4], ['gl_triangle_strip', 5], ['gl_triangle_fan', 6],
  ['gl_quads', 7], ['gl_quad_strip', 8], ['gl_polygon', 9],
  ['gl_color_buffer_bit', 0x4000], ['gl_depth_buffer_bit', 0x100],
  ['gl_stencil_buffer_bit', 0x400],
  ['gl_depth_test', 0x0b71], ['gl_none', 0],
  ['gl_front', 0x0404], ['gl_back', 0x0405], ['gl_front_and_back', 0x0408],
  ['gl_zero', 0], ['gl_one', 1],
  ['gl_src_color', 0x0300], ['gl_one_minus_src_color', 0x0301],
  ['gl_src_alpha', 0x0302], ['gl_one_minus_src_alpha', 0x0303],
  ['gl_dst_alpha', 0x0304], ['gl_one_minus_dst_alpha', 0x0305],
  ['gl_dst_color', 0x0306], ['gl_one_minus_dst_color', 0x0307],
  ['gl_src_alpha_saturate', 0x0308],
]);

/* ─── 生成出来的那一摊函数 ──────────────────────────────────────────── */

/** `gl_tm` 置成单位矩阵（列主序，`m[c*4+r]`）。 */
function tmIdent() {
  const out = [];
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) out.push(aset('gl_tm', num(c * 4 + r), num(c === r ? 1 : 0)));
  }
  return out;
}

/** `dst` 置成单位矩阵（`gl_mv` / `gl_pj` 用）。 */
function matIdent(dst) {
  const out = [];
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) out.push(aset(dst, num(c * 4 + r), num(c === r ? 1 : 0)));
  }
  return out;
}

export function glFnDecls() {
  return [
    ...glSetupDecls(),
    ...glMatrixDecls(),
    ...glDrawDecls(),
  ];
}

/** 开门那几格 + 收下不管的那几格。 */
function glSetupDecls() {
  return [
    fn('gl_need', [], [
      /* 设备（帧缓冲）先开着 —— GL 这一层只往它上头画。 */
      ex(call('gfx_need', [])),
      iff(bin('!=', nm('gl_on'), num(0)), [ret(num(0))]),
      set('gl_on', num(1)),
      set('gl_mv', anew(num(16))),
      set('gl_pj', anew(num(16))),
      set('gl_st', anew(num(16 * 32))),
      set('gl_tm', anew(num(16))),
      set('gl_ta', anew(num(16))),
      set('gl_vb', anew(num(VMAX * VS))),
      ...matIdent('gl_mv'),
      ...matIdent('gl_pj'),
      set('gl_r', num(1)), set('gl_g', num(1)), set('gl_b', num(1)),
      set('gl_sp', num(0)), set('gl_n', num(0)), set('gl_mode', num(-1)),
      /* `setfov(90)` 是 PolyDraw 开机时那一句（`polydraw.c:2455`）—— 记下的是 `ksetfov`
         **算出来的那个数**（fovy，度），不是 90：`tan(45°)=1`，所以就是 atan(高/宽) 那一项。
         `gl_fovt` 是它的 `tan(fovy/2)`：默认这一档**正好是高/宽**（一格除法，不碰 libm ——
         那是三条腿逐字节相同的前提，见 `gl_perspt` 的头注）。 */
      set('gl_fov', bin('*', rm('atan', [bin('/', nm('gfx_h'), nm('gfx_w'))]),
        num(360 / Math.PI))),
      set('gl_fovt', bin('/', nm('gfx_h'), nm('gfx_w'))),
      ret(num(0)),
    ]),
    fn('gl_nop1', ['a'], [ret(num(0))]),
    fn('gl_nop2', ['a', 'b'], [ret(num(0))]),
    fn('gl_nop3', ['a', 'b', 'c'], [ret(num(0))]),
    /* `SETFOV(fov)`：照 `ksetfov`（`polydraw.c:1484`）—— 它只算一格 `gfov` 并回它，
       **不碰 GL 的矩阵**。视口比例用设备的宽高。 */
    fn('gl_setfov', ['fov'], [
      ex(call('gl_need', [])),
      set('gl_fov', bin('*', bin('*', rm('tan', [bin('/', bin('*', nm('fov'), num(Math.PI)), num(360))]),
        rm('atan', [bin('/', nm('gfx_h'), nm('gfx_w'))])), bin('/', num(360), num(Math.PI)))),
      /* 下一帧的初态要拿它当 `tan(fovy/2)`（见 `gl_perspt`）。 */
      set('gl_fovt', rm('tan', [bin('/', bin('*', nm('gl_fov'), num(Math.PI)), num(360))])),
      ret(nm('gl_fov')),
    ]),
    /* `glClear(mask)`：GL 的清屏色从没被设过（`myext[]` 里没有 GLCLEARCOLOR），
       所以是**黑**。mask 给 0 时 `qglClear` 清全部（`polydraw.c:622`）—— 对我们一样。 */
    fn('gl_clear', ['mask'], [
      ex(call('gl_need', [])),
      ex(call('gfx_cls', [num(0), num(0), num(0)])),
      ret(num(0)),
    ]),
    /**
     * **每帧的 GL 初态**（照 `polydraw.c:3572-3579`）：清屏、PROJECTION =
     * `gluPerspective(gfov, 宽/高, 0.1, 1000)`、MODELVIEW = 单位、矩阵栈清空。
     *
     * 深度测试那一格这条腿上**没有**（这份光栅器没有 z 缓冲，见头注）—— 所以
     * 3D 那一族在这一档只对"没有互相遮挡"的图成立，真 3D 要 GPU 那两档设备。
     */
    fn('gl_framebegin', [], [
      ex(call('gl_need', [])),
      ...matIdent('gl_mv'),
      set('gl_sp', num(0)),
      ex(call('gl_perspt', [nm('gl_fovt'), bin('/', nm('gfx_w'), nm('gfx_h')),
        num(0.1), num(1000)])),
      ex(call('gfx_cls', [num(0), num(0), num(0)])),
      ret(num(0)),
    ]),
  ];
}

/** 矩阵那一摊（**右乘** MODELVIEW，与 GL 同）。 */
function glMatrixDecls() {
  /* gl_ta = gl_mv · gl_tm，再抄回 gl_mv。十六格**摊开写**（一格是四个乘积的和）——
     这一层没有循环反而更清楚，而且少两层下标算术。 */
  const mul = [];
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let acc = null;
      for (let k = 0; k < 4; k++) {
        const t = bin('*', aget('gl_mv', num(k * 4 + r)), aget('gl_tm', num(c * 4 + k)));
        acc = acc === null ? t : bin('+', acc, t);
      }
      mul.push(aset('gl_ta', num(c * 4 + r), acc));
    }
  }
  const back = [];
  for (let i = 0; i < 16; i++) back.push(aset('gl_mv', num(i), aget('gl_ta', num(i))));

  /* 顶点：clip = PROJECTION · (MODELVIEW · v)。 */
  const xf = [];
  for (let r = 0; r < 4; r++) {
    let acc = null;
    for (const [k, v] of [[0, 'x'], [1, 'y'], [2, 'z'], [3, 'w']]) {
      const t = bin('*', aget('gl_mv', num(k * 4 + r)), nm(v));
      acc = acc === null ? t : bin('+', acc, t);
    }
    xf.push(letR(`e${r}`, acc));
  }
  for (const [r, g] of [[0, 'gl_cx'], [1, 'gl_cy'], [2, 'gl_cz'], [3, 'gl_cw']]) {
    let acc = null;
    for (let k = 0; k < 4; k++) {
      const t = bin('*', aget('gl_pj', num(k * 4 + r)), nm(`e${k}`));
      acc = acc === null ? t : bin('+', acc, t);
    }
    xf.push(set(g, acc));
  }

  const push = [];
  const pop = [];
  for (let i = 0; i < 16; i++) {
    push.push(aset('gl_st', bin('+', bin('*', nm('gl_sp'), num(16)), num(i)), aget('gl_mv', num(i))));
    pop.push(aset('gl_mv', num(i), aget('gl_st', bin('+', bin('*', nm('gl_sp'), num(16)), num(i)))));
  }

  return [
    fn('gl_mvmul', [], [...mul, ...back, ret(num(0))]),
    fn('gl_xf', ['x', 'y', 'z', 'w'], [...xf, ret(num(0))]),
    fn('gl_push', [], [
      ex(call('gl_need', [])),
      /* 栈满了就**不推**（GL 那边是 GL_STACK_OVERFLOW，画面照旧）。 */
      iff(bin('>=', nm('gl_sp'), num(31)), [ret(num(0))]),
      ...push,
      set('gl_sp', bin('+', nm('gl_sp'), num(1))),
      ret(num(0)),
    ]),
    fn('gl_pop', [], [
      ex(call('gl_need', [])),
      iff(bin('<=', nm('gl_sp'), num(0)), [ret(num(0))]),
      set('gl_sp', bin('-', nm('gl_sp'), num(1))),
      ...pop,
      ret(num(0)),
    ]),
    fn('gl_translate', ['x', 'y', 'z'], [
      ex(call('gl_need', [])),
      ...tmIdent(),
      aset('gl_tm', num(12), nm('x')),
      aset('gl_tm', num(13), nm('y')),
      aset('gl_tm', num(14), nm('z')),
      ex(call('gl_mvmul', [])),
      ret(num(0)),
    ]),
    fn('gl_scale', ['x', 'y', 'z'], [
      ex(call('gl_need', [])),
      ...tmIdent(),
      aset('gl_tm', num(0), nm('x')),
      aset('gl_tm', num(5), nm('y')),
      aset('gl_tm', num(10), nm('z')),
      ex(call('gl_mvmul', [])),
      ret(num(0)),
    ]),
    /* `glRotate(角度, x, y, z)`：角度是**度**，轴要先归一化（GL 的规矩）。
       轴长为 0 就当单位矩阵（GL 那边是未定义，画面上等于什么都没转）。 */
    fn('gl_rotate', ['a', 'ax', 'ay', 'az'], [
      ex(call('gl_need', [])),
      ...tmIdent(),
      letR('len', rm('sqrt', [bin('+', bin('+', bin('*', nm('ax'), nm('ax')),
        bin('*', nm('ay'), nm('ay'))), bin('*', nm('az'), nm('az')))])),
      iff(bin('<=', nm('len'), num(0)), [ex(call('gl_mvmul', [])), ret(num(0))]),
      letR('x', bin('/', nm('ax'), nm('len'))),
      letR('y', bin('/', nm('ay'), nm('len'))),
      letR('z', bin('/', nm('az'), nm('len'))),
      letR('t', bin('/', bin('*', nm('a'), num(Math.PI)), num(180))),
      letR('c', rm('cos', [nm('t')])),
      letR('s', rm('sin', [nm('t')])),
      letR('d', bin('-', num(1), nm('c'))),
      aset('gl_tm', num(0), bin('+', bin('*', bin('*', nm('x'), nm('x')), nm('d')), nm('c'))),
      aset('gl_tm', num(1), bin('+', bin('*', bin('*', nm('y'), nm('x')), nm('d')), bin('*', nm('z'), nm('s')))),
      aset('gl_tm', num(2), bin('-', bin('*', bin('*', nm('x'), nm('z')), nm('d')), bin('*', nm('y'), nm('s')))),
      aset('gl_tm', num(4), bin('-', bin('*', bin('*', nm('x'), nm('y')), nm('d')), bin('*', nm('z'), nm('s')))),
      aset('gl_tm', num(5), bin('+', bin('*', bin('*', nm('y'), nm('y')), nm('d')), nm('c'))),
      aset('gl_tm', num(6), bin('+', bin('*', bin('*', nm('y'), nm('z')), nm('d')), bin('*', nm('x'), nm('s')))),
      aset('gl_tm', num(8), bin('+', bin('*', bin('*', nm('x'), nm('z')), nm('d')), bin('*', nm('y'), nm('s')))),
      aset('gl_tm', num(9), bin('-', bin('*', bin('*', nm('y'), nm('z')), nm('d')), bin('*', nm('x'), nm('s')))),
      aset('gl_tm', num(10), bin('+', bin('*', bin('*', nm('z'), nm('z')), nm('d')), nm('c'))),
      ex(call('gl_mvmul', [])),
      ret(num(0)),
    ]),
    /* `gluPerspective(fovy, aspect, zn, zf)`：**直接设** PROJECTION（`kgluPerspective`
       就是 `glLoadIdentity` + `gluPerspective`，见 `polydraw.c:1477`）。 */
    /**
     * `gl_perspt(ft, aspect, zn, zf)`：**收 `tan(fovy/2)` 而不是角度**的那一版
     * （`gl_perspective` 与每帧的初态都落到它这儿）。
     *
     * 为什么要这一格：默认那一档的 fovy 是 `ksetfov(90)` 算出来的
     * （`atan(高/宽)*360/π` 度），于是 `tan(fovy/2) = tan(atan(高/宽))` = **高/宽** ——
     * 一格除法就够，不碰 `tan`/`atan`。碰了的话 JS 的 Math 与 C 的 libm 差 1 ulp，
     * 三条腿的表面就不再逐字节相同（量过：02-gl.pss 差 96 字节、一条边上 24 格像素）。
     */
    fn('gl_perspt', ['ft', 'aspect', 'zn', 'zf'], [
      ex(call('gl_need', [])),
      ...matIdent('gl_pj'),
      letR('f', bin('/', num(1), nm('ft'))),
      aset('gl_pj', num(0), bin('/', nm('f'), nm('aspect'))),
      aset('gl_pj', num(5), nm('f')),
      aset('gl_pj', num(10), bin('/', bin('+', nm('zf'), nm('zn')), bin('-', nm('zn'), nm('zf')))),
      aset('gl_pj', num(11), num(-1)),
      aset('gl_pj', num(14), bin('/', bin('*', bin('*', num(2), nm('zf')), nm('zn')),
        bin('-', nm('zn'), nm('zf')))),
      aset('gl_pj', num(15), num(0)),
      ret(num(0)),
    ]),
    fn('gl_perspective', ['fovy', 'aspect', 'zn', 'zf'], [
      ex(call('gl_perspt', [
        rm('tan', [bin('/', bin('*', nm('fovy'), num(Math.PI)), num(360))]),
        nm('aspect'), nm('zn'), nm('zf')])),
      ret(num(0)),
    ]),
  ];
}

/** 画的那一摊：攒顶点、`glEnd` 那一刻按 mode 拆成点 / 线段 / 三角形。 */
function glDrawDecls() {
  const min3 = (a, b, c) => tern(bin('<', a, b), tern(bin('<', a, c), a, c), tern(bin('<', b, c), b, c));
  const max3 = (a, b, c) => tern(bin('>', a, b), tern(bin('>', a, c), a, c), tern(bin('>', b, c), b, c));
  const col = (i) => call('gfx_rgb', [vb(i, 3), vb(i, 4), vb(i, 5)]);
  /* 一档 mode 的展开：`i` 从 `from` 起、每轮 `step`、条件是 `i + ahead < n`。 */
  const loop = (from, ahead, step, body) => [
    letR('i', from),
    whil(bin('<', bin('+', nm('i'), num(ahead)), nm('n')), [
      ...body,
      set('i', bin('+', nm('i'), num(step))),
    ]),
  ];

  return [
    fn('gl_begin', ['mode'], [
      ex(call('gl_need', [])),
      set('gl_mode', nm('mode')),
      set('gl_n', num(0)),
      ret(num(0)),
    ]),
    fn('gl_color3', ['r', 'g', 'b'], [
      ex(call('gl_need', [])),
      set('gl_r', nm('r')), set('gl_g', nm('g')), set('gl_b', nm('b')),
      ret(num(0)),
    ]),
    /* alpha 收下不管（这条腿上没有混合）。 */
    fn('gl_color4', ['r', 'g', 'b', 'a'], [
      ex(call('gl_color3', [nm('r'), nm('g'), nm('b')])),
      ret(num(0)),
    ]),
    fn('gl_vertex2', ['x', 'y'], [
      ex(call('gl_vertex4', [nm('x'), nm('y'), num(0), num(1)])), ret(num(0))]),
    fn('gl_vertex3', ['x', 'y', 'z'], [
      ex(call('gl_vertex4', [nm('x'), nm('y'), nm('z'), num(1)])), ret(num(0))]),
    /**
     * 一格顶点：变换 -> 透视除法 -> 视口。GL 的 y 朝上、我们的帧缓冲 y 朝下，所以 y 翻过来。
     * `w <= 0`（在眼睛后头/近平面外）**整格丢掉** —— 这一版没有近平面插值。
     */
    fn('gl_vertex4', ['x', 'y', 'z', 'w'], [
      ex(call('gl_need', [])),
      iff(bin('>=', nm('gl_n'), num(VMAX)), [ret(num(0))]),
      ex(call('gl_xf', [nm('x'), nm('y'), nm('z'), nm('w')])),
      iff(bin('<=', nm('gl_cw'), num(0)), [ret(num(0))]),
      letR('iw', bin('/', num(1), nm('gl_cw'))),
      vbset(nm('gl_n'), 0, bin('*', bin('+', bin('*', bin('*', nm('gl_cx'), nm('iw')), num(0.5)),
        num(0.5)), nm('gfx_w'))),
      vbset(nm('gl_n'), 1, bin('*', bin('-', num(0.5), bin('*', bin('*', nm('gl_cy'), nm('iw')),
        num(0.5))), nm('gfx_h'))),
      vbset(nm('gl_n'), 2, bin('*', nm('gl_cz'), nm('iw'))),
      vbset(nm('gl_n'), 3, call('gfx_clamp255', [bin('*', nm('gl_r'), num(255))])),
      vbset(nm('gl_n'), 4, call('gfx_clamp255', [bin('*', nm('gl_g'), num(255))])),
      vbset(nm('gl_n'), 5, call('gfx_clamp255', [bin('*', nm('gl_b'), num(255))])),
      set('gl_n', bin('+', nm('gl_n'), num(1))),
      ret(num(0)),
    ]),
    fn('gl_pt', ['i'], [
      ex(call('gfx_px', [vb(nm('i'), 0), vb(nm('i'), 1), col(nm('i'))])),
      ret(num(0)),
    ]),
    /* 线段的颜色取**头一个**顶点的（GL 会插值，这条腿先不插 —— 记在头注的边界里）。 */
    fn('gl_seg', ['i', 'j'], [
      set('gfx_col', col(nm('i'))),
      ex(call('gfx_line', [vb(nm('i'), 0), vb(nm('i'), 1), vb(nm('j'), 0), vb(nm('j'), 1)])),
      ret(num(0)),
    ]),
    /**
     * 一格三角形：包围盒 + **重心坐标**（顶点色按重心插值 —— GL 的 Gouraud）。
     * 没有深度缓冲：后画的盖前画的（2D 那一档够用；3D 要 z-buffer，记在头注里）。
     */
    fn('gl_tri', ['i', 'j', 'k'], [
      letR('x0', vb(nm('i'), 0)), letR('y0', vb(nm('i'), 1)),
      letR('x1', vb(nm('j'), 0)), letR('y1', vb(nm('j'), 1)),
      letR('x2', vb(nm('k'), 0)), letR('y2', vb(nm('k'), 1)),
      letR('ar', bin('-', bin('*', bin('-', nm('x1'), nm('x0')), bin('-', nm('y2'), nm('y0'))),
        bin('*', bin('-', nm('x2'), nm('x0')), bin('-', nm('y1'), nm('y0'))))),
      iff(bin('<', rm('fabs', [nm('ar')]), num(1e-12)), [ret(num(0))]),
      letR('ia', bin('/', num(1), nm('ar'))),
      letR('xa', rm('floor', [min3(nm('x0'), nm('x1'), nm('x2'))])),
      letR('xb', rm('ceil', [max3(nm('x0'), nm('x1'), nm('x2'))])),
      letR('ya', rm('floor', [min3(nm('y0'), nm('y1'), nm('y2'))])),
      letR('yb', rm('ceil', [max3(nm('y0'), nm('y1'), nm('y2'))])),
      iff(bin('<', nm('xa'), num(0)), [set('xa', num(0))]),
      iff(bin('<', nm('ya'), num(0)), [set('ya', num(0))]),
      iff(bin('>', nm('xb'), bin('-', nm('gfx_w'), num(1))), [set('xb', bin('-', nm('gfx_w'), num(1)))]),
      iff(bin('>', nm('yb'), bin('-', nm('gfx_h'), num(1))), [set('yb', bin('-', nm('gfx_h'), num(1)))]),
      letR('r0', vb(nm('i'), 3)), letR('g0', vb(nm('i'), 4)), letR('b0', vb(nm('i'), 5)),
      letR('r1', vb(nm('j'), 3)), letR('g1', vb(nm('j'), 4)), letR('b1', vb(nm('j'), 5)),
      letR('r2', vb(nm('k'), 3)), letR('g2', vb(nm('k'), 4)), letR('b2', vb(nm('k'), 5)),
      letR('py', nm('ya')),
      whil(bin('<=', nm('py'), nm('yb')), [
        letR('px', nm('xa')),
        whil(bin('<=', nm('px'), nm('xb')), [
          letR('cx', bin('+', nm('px'), num(0.5))),
          letR('cy', bin('+', nm('py'), num(0.5))),
          letR('w0', bin('*', bin('-',
            bin('*', bin('-', nm('x1'), nm('cx')), bin('-', nm('y2'), nm('cy'))),
            bin('*', bin('-', nm('x2'), nm('cx')), bin('-', nm('y1'), nm('cy')))), nm('ia'))),
          letR('w1', bin('*', bin('-',
            bin('*', bin('-', nm('x2'), nm('cx')), bin('-', nm('y0'), nm('cy'))),
            bin('*', bin('-', nm('x0'), nm('cx')), bin('-', nm('y2'), nm('cy')))), nm('ia'))),
          letR('w2', bin('-', bin('-', num(1), nm('w0')), nm('w1'))),
          iff(bin('&&', bin('&&', bin('>=', nm('w0'), num(0)), bin('>=', nm('w1'), num(0))),
            bin('>=', nm('w2'), num(0))), [
            ex(call('gfx_px', [nm('px'), nm('py'), call('gfx_rgb', [
              bin('+', bin('+', bin('*', nm('w0'), nm('r0')), bin('*', nm('w1'), nm('r1'))),
                bin('*', nm('w2'), nm('r2'))),
              bin('+', bin('+', bin('*', nm('w0'), nm('g0')), bin('*', nm('w1'), nm('g1'))),
                bin('*', nm('w2'), nm('g2'))),
              bin('+', bin('+', bin('*', nm('w0'), nm('b0')), bin('*', nm('w1'), nm('b1'))),
                bin('*', nm('w2'), nm('b2'))),
            ])])),
          ]),
          set('px', bin('+', nm('px'), num(1))),
        ]),
        set('py', bin('+', nm('py'), num(1))),
      ]),
      ret(num(0)),
    ]),
    /**
     * `glEnd()`：按 `mode` 把攒下的顶点拆开。十格 mode 的号是 GL 的（见 `GL_CONSTS`）。
     * **`QUAD_STRIP` 与 `QUADS` 都拆成两个三角形**，次序照 GL 的定义。
     */
    fn('gl_end', [], [
      ex(call('gl_need', [])),
      letR('m', nm('gl_mode')),
      letR('n', nm('gl_n')),
      set('gl_mode', num(-1)),
      set('gl_n', num(0)),
      iff(bin('==', nm('m'), num(0)),
        loop(num(0), 0, 1, [ex(call('gl_pt', [nm('i')]))])),
      iff(bin('==', nm('m'), num(1)),
        loop(num(0), 1, 2, [ex(call('gl_seg', [nm('i'), bin('+', nm('i'), num(1))]))])),
      iff(bin('==', nm('m'), num(3)),
        loop(num(0), 1, 1, [ex(call('gl_seg', [nm('i'), bin('+', nm('i'), num(1))]))])),
      iff(bin('==', nm('m'), num(2)), [
        ...loop(num(0), 1, 1, [ex(call('gl_seg', [nm('i'), bin('+', nm('i'), num(1))]))]),
        iff(bin('>', nm('n'), num(2)),
          [ex(call('gl_seg', [bin('-', nm('n'), num(1)), num(0)]))]),
      ]),
      iff(bin('==', nm('m'), num(4)),
        loop(num(0), 2, 3, [ex(call('gl_tri', [nm('i'),
          bin('+', nm('i'), num(1)), bin('+', nm('i'), num(2))]))])),
      iff(bin('==', nm('m'), num(5)),
        loop(num(2), 0, 1, [ex(call('gl_tri', [bin('-', nm('i'), num(2)),
          bin('-', nm('i'), num(1)), nm('i')]))])),
      iff(bin('||', bin('==', nm('m'), num(6)), bin('==', nm('m'), num(9))),
        loop(num(2), 0, 1, [ex(call('gl_tri', [num(0), bin('-', nm('i'), num(1)), nm('i')]))])),
      iff(bin('==', nm('m'), num(7)),
        loop(num(0), 3, 4, [
          ex(call('gl_tri', [nm('i'), bin('+', nm('i'), num(1)), bin('+', nm('i'), num(2))])),
          ex(call('gl_tri', [nm('i'), bin('+', nm('i'), num(2)), bin('+', nm('i'), num(3))])),
        ])),
      iff(bin('==', nm('m'), num(8)),
        loop(num(2), 1, 2, [
          ex(call('gl_tri', [bin('-', nm('i'), num(2)), bin('-', nm('i'), num(1)), nm('i')])),
          ex(call('gl_tri', [bin('-', nm('i'), num(1)), bin('+', nm('i'), num(1)), nm('i')])),
        ])),
      ret(num(0)),
    ]),
  ];
}

