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
// **可编程管线那一族也在这儿**（第四刀）：`glSetShader` / `glGetUniformLoc` /
// `glUniform*` / `glGetAttribLoc` / `glVertexAttrib*` / `glTexCoord` / `glQuad` ——
// 顶点与批留在这一层（`gl_prog != 0` 时存**物体坐标**），program 与 uniform 转给设备。
//
// **不接**（当场报，不静默画错）：纹理那一族（`glSetTex`/`glGetTex`/`glBindTexture`）、
// `glMultMatrix`（要一格数组形参）、`glCapture`。
//
// ## 三个约定
//
// 1. **矩阵是列主序**（与 GL 一样）：`m[col*4+row]`，`gl_mv` / `gl_pj` 各 16 格。
//    `glTranslate`/`Rotate`/`Scale` 一律**右乘** MODELVIEW（`M = M · T`），与 GL 同。
// 2. 顶点先攒着（`gl_vb`，一格顶点 **12 个数**：位置 x,y,z,w（**裁剪空间**）、颜色 r,g,b,a
//    （0..1）、纹理坐标 s,t,p,q），`glEnd` 那一刻按 `mode` 拆成点/线段/三角形**抄进批里**。
//    **上限 1024 个顶点**，超了丢掉。
// 3. `w <= 0` 的顶点**整格丢掉**（近平面裁剪这一版没做插值）—— 透视图里跨近平面的
//    三角形会缺一块，记在这儿。
//
// ## 只有一个模型（2026-09-24 用户定的口径）
//
// 这一层**不自己光栅化**：拆开的点/线/三角抄进三条顶点批（`gl_pb`/`gl_lb`/`gl_ob`），
// 攒够一段就交给设备一格 `(gfxbatch 类 数 顶点)` —— 设备那一侧（WebGL2 / 本机 OpenGL /
// CPU 备选）只管"上传 + 一次 draw"。变换、拆 mode、丢顶点、合批都在这儿，**四条腿共用
// 这一份**。批跨 `glBegin`/`glEnd` 合并（顶点已经在裁剪空间里，后头改矩阵影响不到它们），
// 只在"设备状态变了 / 攒满了 / 一帧完了"这三种时候交出去。
// 详见 `docs/design/eval-realtime-gpu.md` 第 9 节。
import {
  ARR, num, str, nm, bin, bi, call, rm, set, letR, ret, iff, whil, ex, aset, aget, ix, fn, fnT,
  glob, anew,
} from './ir.js';

/** 设备那一面：一格宿主调用 / 一段顶点批。 */
const dev = (name, args = []) => bi('gfxcall', [str(name), ...args]);
const devBatch = (kind, cnt, arr) => bi('gfxbatch', [ix(num(kind)), ix(cnt), nm(arr)]);

/** 一格顶点占 12 个数（位置 4 / 颜色 4 / 纹理坐标 4）—— 与 `(gfxbatch …)` 的契约同一格。 */
const VS = 12;
const VMAX = 1024;
/** 一条批最多攒几个顶点（攒满就交出去）。 */
const OMAX = 3072;

/** `gl_vb` 的第 i 个顶点的第 k 格。 */
const vb = (i, k) => aget('gl_vb', bin('+', bin('*', i, num(VS)), num(k)));
const vbset = (i, k, v) => aset('gl_vb', bin('+', bin('*', i, num(VS)), num(k)), v);

/** 一格顶点从 `gl_vb[i]` 抄到某条批的第 `c` 格（12 个数一格一格抄）。 */
const copyV = (dst, cnt, i) => {
  const out = [];
  for (let k = 0; k < VS; k++) {
    out.push(aset(dst, bin('+', bin('*', nm(cnt), num(VS)), num(k)), vb(i, k)));
  }
  out.push(set(cnt, bin('+', nm(cnt), num(1))));
  return out;
};

/** 设备那几格模块级的量（名字都带 `gl_` 前缀）。 */
export const GL_GLOBALS = ['gl_on', 'gl_mode', 'gl_n', 'gl_r', 'gl_g', 'gl_b',
  'gl_sp', 'gl_fov', 'gl_fovt', 'gl_cx', 'gl_cy', 'gl_cz', 'gl_cw',
  'gl_w', 'gl_h', 'gl_no', 'gl_nl', 'gl_np',
  /* 可编程管线那一档（第四刀）：`gl_prog` 是"脚本自己那格 program 在用着没有"
     （0 = 内建那对着色器），`gl_ts…gl_tq` 是现在的纹理坐标（`glTexCoord`），
     `gl_qid` 是"这一趟交批用单位矩阵"（满屏四边形那一格，见 `gl_quad`）。 */
  'gl_prog', 'gl_ts', 'gl_tt', 'gl_tp', 'gl_tq', 'gl_qid'];

export function glGlobalDecls() {
  return [
    ...GL_GLOBALS.map((n) => glob(n)),
    glob('gl_mv', ARR), glob('gl_pj', ARR), glob('gl_st', ARR),
    glob('gl_tm', ARR), glob('gl_ta', ARR), glob('gl_vb', ARR),
    /* 交批时那格 MODELVIEW·PROJECTION（可编程管线那一档的 `u_mvp`）。 */
    glob('gl_mp', ARR),
    /* 三条顶点批：三角 / 线段 / 点（`(gfxbatch …)` 的三个类）。 */
    glob('gl_ob', ARR), glob('gl_lb', ARR), glob('gl_pb', ARR),
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
  /* **可编程管线那一族**（第四刀）：也走这一份 —— 挑 program 与设 uniform 是设备状态，
     所以这几格只做两件事：把攒着的批交出去（状态一变就得断批），再把那句原样转给设备。
     顶点那一半留在这儿：`gl_prog != 0` 时 `gl_vertex4` 存**物体坐标**、`gl_flush`
     先发四句 `batchmvp`（见 `docs/design/eval-realtime-gpu.md` 第 9.4 节）。 */
  ['glsetshader/1', 'gl_setshader1'],
  ['glsetshader/2', 'gl_setshader2'],
  ['glsetshader/3', 'gl_setshader3'],
  ['glquad/1', 'gl_quad'],
  ['gltexcoord/2', 'gl_texcoord2'],
  ['gltexcoord/3', 'gl_texcoord3'],
  ['gltexcoord/4', 'gl_texcoord4'],
  ['glgetuniformloc/1', 'gl_uniloc'],
  ['gluniform/2', 'gl_uni1'],
  ['gluniform1f/2', 'gl_uni1'],
  ['gluniform2f/3', 'gl_uni2'],
  ['gluniform3f/4', 'gl_uni3'],
  ['gluniform4f/5', 'gl_uni4'],
  ['glgetattribloc/1', 'gl_attrloc'],
  ['glvertexattrib1f/2', 'gl_attr1'],
  ['glvertexattrib2f/3', 'gl_attr2'],
  ['glvertexattrib3f/4', 'gl_attr3'],
  ['glvertexattrib4f/5', 'gl_attr4'],
  /* **纹理那一族**（第六刀，`docs/design/eval-realtime-gpu.md` 第 11 节）：数组那三档走
     `(gfxtex 槽 宽 高 层 格 数组)`。元数照 `myext[]:2168-2170` —— **最后一格总是 coltype**，
     4 个实参那一档是**一维**纹理（`kglsettexarray1`：ysiz=zsiz=1），不是 (宽,高)。 */
  ['glsettex/4', 'gl_settex4'],
  ['glsettex/5', 'gl_settex5'],
  ['glsettex/6', 'gl_settex6'],
  ['glbindtexture/1', 'gl_bindtex'],
  ['glactivetexture/1', 'gl_activetex'],
  /* 收下但不管的那几格（这条腿上没有光照/混合/剔除）。 */
  ['glnormal/3', 'gl_nop3'],
  ['glenable/1', 'gl_enable'],
  ['gldisable/1', 'gl_disable'],
  ['glcullface/1', 'gl_nop1'],
  ['gllinewidth/1', 'gl_nop1'],
  ['glswapinterval/1', 'gl_nop1'],
  ['glblendfunc/2', 'gl_nop2'],
  ['glalphaenable/1', 'gl_nop1'],
  ['glalphaenable/0', 'gl_nop0'],
  ['glalphadisable/0', 'gl_nop0'],
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
  /* **`GL_COMPLEX` 是 EvalDraw 自己的 mode**（`glbegin(GL_COMPLEX)`，带自相交填充的
     复杂多边形；标准 GL 里没有这个名字）—— 我们当 `GL_POLYGON`（9）拆成三角扇。
     **明写偏差**：自相交那一档的填充规则与原版不同（原版是 tessellate）。 */
  ['gl_complex', 9],
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
  /* 纹理单元（`glactivetexture(GL_TEXTURE0)`）与那几格开关 —— 语料里 `.kc` 的 GL 子集
     用到的（`demos/sprite2d.kc`、`treemake.kc`）。值照 GL 的头文件，不是我们编的号。 */
  ['gl_texture0', 0x84c0], ['gl_texture1', 0x84c1], ['gl_texture2', 0x84c2],
  ['gl_texture3', 0x84c3],
  ['gl_texture_1d', 0x0de0], ['gl_texture_2d', 0x0de1],
  ['gl_blend', 0x0be2], ['gl_cull_face', 0x0b44], ['gl_alpha_test', 0x0bc0],
  ['gl_lighting', 0x0b50], ['gl_fog', 0x0b60],
  ['gl_modelview', 0x1700], ['gl_projection', 0x1701],
  ['gl_cw', 0x0900], ['gl_ccw', 0x0901],
  /* **纹理那一族的 `KGL_*`**（`polydraw.c:190-193` 那三段 enum，照抄不自己编号）：
     低 4 位是像素格式、`0xf0` 是过滤、`0xf00` 是环绕。脚本里写的是
     `KGL_BGRA32+KGL_NEAREST+KGL_CLAMP_TO_EDGE` 这种和，所以三段必须与原版同一个值。 */
  ['kgl_bgra32', 0], ['kgl_char', 1], ['kgl_short', 2], ['kgl_int', 3],
  ['kgl_float', 4], ['kgl_vec4', 5],
  ['kgl_linear', 0x00], ['kgl_nearest', 0x10],
  /* `KGL_MIPMAP` 与 `KGL_MIPMAP3` 是**同一格**（原版那行 enum 里两个名字一个值）。 */
  ['kgl_mipmap', 0x20], ['kgl_mipmap3', 0x20], ['kgl_mipmap2', 0x30],
  ['kgl_mipmap1', 0x40], ['kgl_mipmap0', 0x50],
  ['kgl_repeat', 0x000], ['kgl_mirrored_repeat', 0x100],
  ['kgl_clamp', 0x200], ['kgl_clamp_to_edge', 0x300],
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
    ...glShaderDecls(),
  ];
}

/**
 * **可编程管线那一族**（第 9.4 节"批带上状态"）。
 *
 * 分工只有一条线：**顶点与批在这儿，program 与 uniform 在设备**。
 *   * `glsetshader` / `gluniform*` / `glvertexattrib*` 都是**按 draw call 生效**的状态，
 *     所以每一格先 `gl_flush()`（把攒着的批交出去），再把那句原样转给设备；
 *   * `gl_prog != 0` 之后 `gl_vertex4` 存的是**物体坐标**（不乘矩阵、也不丢 `w<=0` ——
 *     变换与裁剪都是脚本那格顶点着色器与 GPU 的事），`gl_flush` 先发四句 `batchmvp`。
 *   * `glquad(mode)` 也是**顶点**（满屏两个三角形，位置就是 NDC）—— 不是设备自己造一份
 *     几何：那就是第二个模型了。它那一趟的 `u_mvp` 是单位矩阵，用 `gl_qid` 说。
 */
function glShaderDecls() {
  /* `gl_mp = gl_pj · gl_mv`（列主序）：mp[c*4+r] = Σ_k pj[k*4+r] * mv[c*4+k]。 */
  const mul = [];
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let acc = null;
      for (let k = 0; k < 4; k++) {
        const t = bin('*', aget('gl_pj', num(k * 4 + r)), aget('gl_mv', num(c * 4 + k)));
        acc = acc === null ? t : bin('+', acc, t);
      }
      mul.push(aset('gl_mp', num(c * 4 + r), acc));
    }
  }
  /* 四句 `(gfxcall "batchmvp" 列 m0 m1 m2 m3)`（列主序，一句一列）。 */
  const send = [];
  for (let c = 0; c < 4; c++) {
    send.push(ex(dev('batchmvp', [num(c), aget('gl_mp', num(c * 4)),
      aget('gl_mp', num(c * 4 + 1)), aget('gl_mp', num(c * 4 + 2)),
      aget('gl_mp', num(c * 4 + 3))])));
  }
  const sendIdent = [];
  for (let c = 0; c < 4; c++) {
    sendIdent.push(ex(dev('batchmvp', [num(c), num(c === 0 ? 1 : 0), num(c === 1 ? 1 : 0),
      num(c === 2 ? 1 : 0), num(c === 3 ? 1 : 0)])));
  }

  /* 满屏四边形那六个顶点（位置就是 NDC、纹理坐标 0..1，颜色是现在这一格）。 */
  const quadV = [[-1, -1, 0, 0], [1, -1, 1, 0], [-1, 1, 0, 1],
    [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]];
  const quad = [];
  for (const [x, y, s, t] of quadV) {
    const vals = [num(x), num(y), num(0), num(1),
      nm('gl_r'), nm('gl_g'), nm('gl_b'), num(1),
      num(s), num(t), num(0), num(1)];
    vals.forEach((v, k) => {
      quad.push(aset('gl_ob', bin('+', bin('*', nm('gl_no'), num(VS)), num(k)), v));
    });
    quad.push(set('gl_no', bin('+', nm('gl_no'), num(1))));
  }

  /** 挑 program 那一格：断批 + 转给设备 + 记下"脚本那格在用着"。 */
  const setShader = (args) => [
    ex(call('gl_need', [])),
    ex(call('gl_flush', [])),
    ex(dev('glsetshader', args.map((a) => nm(a)))),
    set('gl_prog', num(1)),
    ex(dev('batchprog', [num(1)])),
    ret(num(0)),
  ];
  /** 一格"按 draw call 生效"的状态：断批 + 原样转给设备。 */
  const stateFn = (name, hostName, args) => fn(name, args, [
    ex(call('gl_need', [])),
    ex(call('gl_flush', [])),
    ret(dev(hostName, args.map((a) => nm(a)))),
  ]);

  return [
    fn('gl_mvpsend', [], [
      iff(bin('!=', nm('gl_qid'), num(0)), [...sendIdent, ret(num(0))]),
      ...mul,
      ...send,
      ret(num(0)),
    ]),
    fn('gl_setshader1', ['a'], setShader(['a'])),
    fn('gl_setshader2', ['a', 'b'], setShader(['a', 'b'])),
    fn('gl_setshader3', ['a', 'b', 'c'], setShader(['a', 'b', 'c'])),
    fn('gl_texcoord4', ['s', 't', 'p', 'q'], [
      ex(call('gl_need', [])),
      set('gl_ts', nm('s')), set('gl_tt', nm('t')),
      set('gl_tp', nm('p')), set('gl_tq', nm('q')),
      ret(num(0)),
    ]),
    fn('gl_texcoord2', ['s', 't'], [
      ex(call('gl_texcoord4', [nm('s'), nm('t'), num(0), num(1)])), ret(num(0))]),
    fn('gl_texcoord3', ['s', 't', 'p'], [
      ex(call('gl_texcoord4', [nm('s'), nm('t'), nm('p'), num(1)])), ret(num(0))]),
    stateFn('gl_uniloc', 'glgetuniformloc', ['a']),
    stateFn('gl_uni1', 'gluniform1f', ['h', 'x']),
    stateFn('gl_uni2', 'gluniform2f', ['h', 'x', 'y']),
    stateFn('gl_uni3', 'gluniform3f', ['h', 'x', 'y', 'z']),
    stateFn('gl_uni4', 'gluniform4f', ['h', 'x', 'y', 'z', 'w']),
    stateFn('gl_attrloc', 'glgetattribloc', ['a']),
    stateFn('gl_attr1', 'glvertexattrib1f', ['h', 'x']),
    stateFn('gl_attr2', 'glvertexattrib2f', ['h', 'x', 'y']),
    stateFn('gl_attr3', 'glvertexattrib3f', ['h', 'x', 'y', 'z']),
    stateFn('gl_attr4', 'glvertexattrib4f', ['h', 'x', 'y', 'z', 'w']),
    /* **纹理那一族**（第 11 节）：一整块像素走 `(gfxtex 槽 宽 高 层 格 数组)` ——
       宿主面只收 double，所以数组有自己那一格 op（与 `(gfxbatch …)` 同一条先例）。
       元数照 `myext[]:2168-2170`：**最后一格总是 coltype**，4 个实参那一档是一维纹理。
       挑槽/挑单元是设备状态，所以两格都先 `gl_flush()`。 */
    fnT('gl_settex6', [['t'], ['px', ARR], ['xs'], ['ys'], ['zs'], ['ct']], [
      ex(call('gl_need', [])),
      ex(call('gl_flush', [])),
      ex(bi('gfxtex', [ix(nm('t')), ix(nm('xs')), ix(nm('ys')), ix(nm('zs')), ix(nm('ct')),
        nm('px')])),
      ret(num(0)),
    ]),
    fnT('gl_settex5', [['t'], ['px', ARR], ['xs'], ['ys'], ['ct']], [
      ex(call('gl_settex6', [nm('t'), nm('px'), nm('xs'), nm('ys'), num(1), nm('ct')])),
      ret(num(0)),
    ]),
    fnT('gl_settex4', [['t'], ['px', ARR], ['xs'], ['ct']], [
      ex(call('gl_settex6', [nm('t'), nm('px'), nm('xs'), num(1), num(1), nm('ct')])),
      ret(num(0)),
    ]),
    stateFn('gl_bindtex', 'glbindtexture', ['t']),
    stateFn('gl_activetex', 'glactivetexture', ['u']),
    /**
     * `glquad(mode)`：满屏四边形。`0` 走 alpha 混合、`1` 不透明（说明书那一行）。
     * 六个顶点在这儿造（**一个模型**），设备只收那一段批 —— 它那一趟的 `u_mvp`
     * 是单位矩阵（`gl_qid`），因为位置已经是 NDC 了。
     */
    fn('gl_quad', ['mode'], [
      ex(call('gl_need', [])),
      ex(call('gl_flush', [])),
      /* 没挑过 program 的脚本（只有 `@v`/`@f` 两段）：让设备拿第一对。 */
      iff(bin('==', nm('gl_prog'), num(0)), [
        ex(dev('glsetshader', [num(-1)])),
        set('gl_prog', num(1)),
        ex(dev('batchprog', [num(1)])),
      ]),
      ex(dev('batchblend', [nm('mode')])),
      ...quad,
      set('gl_qid', num(1)),
      ex(call('gl_flush', [])),
      set('gl_qid', num(0)),
      ex(dev('batchblend', [num(1)])),
      ret(num(0)),
    ]),
  ];
}

/** 开门那几格 + 收下不管的那几格。 */
function glSetupDecls() {
  return [
    fn('gl_need', [], [
      iff(bin('!=', nm('gl_on'), num(0)), [ret(num(0))]),
      set('gl_on', num(1)),
      set('gl_mv', anew(num(16))),
      set('gl_pj', anew(num(16))),
      set('gl_st', anew(num(16 * 32))),
      set('gl_tm', anew(num(16))),
      set('gl_ta', anew(num(16))),
      set('gl_vb', anew(num(VMAX * VS))),
      set('gl_mp', anew(num(16))),
      set('gl_prog', num(0)),
      set('gl_qid', num(0)),
      set('gl_ts', num(0)), set('gl_tt', num(0)), set('gl_tp', num(0)), set('gl_tq', num(1)),
      set('gl_ob', anew(num(OMAX * VS))),
      set('gl_lb', anew(num(OMAX * VS))),
      set('gl_pb', anew(num(OMAX * VS))),
      set('gl_no', num(0)), set('gl_nl', num(0)), set('gl_np', num(0)),
      /* 画布尺寸问设备一句（它才知道 —— 窗口/离屏表面是它的）。 */
      set('gl_w', dev('xres')),
      set('gl_h', dev('yres')),
      ...matIdent('gl_mv'),
      ...matIdent('gl_pj'),
      set('gl_r', num(1)), set('gl_g', num(1)), set('gl_b', num(1)),
      set('gl_sp', num(0)), set('gl_n', num(0)), set('gl_mode', num(-1)),
      /* `setfov(90)` 是 PolyDraw 开机时那一句（`polydraw.c:2455`）—— 记下的是 `ksetfov`
         **算出来的那个数**（fovy，度），不是 90：`tan(45°)=1`，所以就是 atan(高/宽) 那一项。
         `gl_fovt` 是它的 `tan(fovy/2)`：默认这一档**正好是高/宽**（一格除法，不碰 libm ——
         那是三条腿逐字节相同的前提，见 `gl_perspt` 的头注）。 */
      set('gl_fov', bin('*', rm('atan', [bin('/', nm('gl_h'), nm('gl_w'))]),
        num(360 / Math.PI))),
      set('gl_fovt', bin('/', nm('gl_h'), nm('gl_w'))),
      ret(num(0)),
    ]),
    /**
     * **把攒着的三条批交出去**（`(gfxbatch 类 数 顶点)`）：设备只管上传 + 一次 draw。
     * 交出去的时机只有三种：设备状态要变（清屏 / 每帧初态）、攒满了、一帧完了 ——
     * 顶点已经在裁剪空间里，所以后头改矩阵影响不到已经攒下的那些（批可以跨
     * `glBegin`/`glEnd` 合并，这正是"少几个 draw call"那件事）。
     */
    fn('gl_flush', [], [
      /* 可编程管线那一档：位置是**物体坐标**，所以变换要随批一起过去（`u_mvp`）。
         空批不必发（那趟白花四句宿主调用）。 */
      iff(bin('!=', nm('gl_prog'), num(0)), [
        iff(bin('>', bin('+', bin('+', nm('gl_np'), nm('gl_nl')), nm('gl_no')), num(0)),
          [ex(call('gl_mvpsend', []))]),
      ]),
      iff(bin('>', nm('gl_np'), num(0)), [
        ex(devBatch(2, nm('gl_np'), 'gl_pb')),
        set('gl_np', num(0)),
      ]),
      iff(bin('>', nm('gl_nl'), num(0)), [
        ex(devBatch(0, nm('gl_nl'), 'gl_lb')),
        set('gl_nl', num(0)),
      ]),
      iff(bin('>', nm('gl_no'), num(0)), [
        ex(devBatch(1, nm('gl_no'), 'gl_ob')),
        set('gl_no', num(0)),
      ]),
      ret(num(0)),
    ]),
    fn('gl_nop0', [], [ret(num(0))]),
    fn('gl_nop1', ['a'], [ret(num(0))]),
    /**
     * `glEnable(cap)` / `glDisable(cap)`：**深度测试那一格是设备状态**，要转给设备
     * （`(gfxcall "gldepth" 0|1)`）—— 它一变就断一段批，所以先 `gl_flush`。
     * 别的 cap（混合、剔除、光照、雾）这一版收下不管，与从前一样。
     * `GL_DEPTH_TEST` = 0x0b71（`GL_CONSTS` 里那一格）。
     */
    fn('gl_enable', ['cap'], [
      ex(call('gl_need', [])),
      iff(bin('==', nm('cap'), num(0x0b71)), [
        ex(call('gl_flush', [])),
        ex(dev('gldepth', [num(1)])),
      ]),
      ret(num(0)),
    ]),
    fn('gl_disable', ['cap'], [
      ex(call('gl_need', [])),
      iff(bin('==', nm('cap'), num(0x0b71)), [
        ex(call('gl_flush', [])),
        ex(dev('gldepth', [num(0)])),
      ]),
      ret(num(0)),
    ]),
    fn('gl_nop2', ['a', 'b'], [ret(num(0))]),
    fn('gl_nop3', ['a', 'b', 'c'], [ret(num(0))]),
    /* `SETFOV(fov)`：照 `ksetfov`（`polydraw.c:1484`）—— 它只算一格 `gfov` 并回它，
       **不碰 GL 的矩阵**。视口比例用设备的宽高。 */
    fn('gl_setfov', ['fov'], [
      ex(call('gl_need', [])),
      set('gl_fov', bin('*', bin('*', rm('tan', [bin('/', bin('*', nm('fov'), num(Math.PI)), num(360))]),
        rm('atan', [bin('/', nm('gl_h'), nm('gl_w'))])), bin('/', num(360), num(Math.PI)))),
      /* 下一帧的初态要拿它当 `tan(fovy/2)`（见 `gl_perspt`）。 */
      set('gl_fovt', rm('tan', [bin('/', bin('*', nm('gl_fov'), num(Math.PI)), num(360))])),
      ret(nm('gl_fov')),
    ]),
    /* `glClear(mask)`：GL 的清屏色从没被设过（`myext[]` 里没有 GLCLEARCOLOR），
       所以是**黑**。mask 给 0 时 `qglClear` 清全部（`polydraw.c:622`）—— 对我们一样。
       清屏是**设备状态**：先把攒着的批交出去（不然清屏会把它们抹掉），再让设备清。 */
    fn('gl_clear', ['mask'], [
      ex(call('gl_need', [])),
      ex(call('gl_flush', [])),
      ex(dev('cls', [num(0)])),
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
      ex(call('gl_flush', [])),
      ...matIdent('gl_mv'),
      set('gl_sp', num(0)),
      ex(call('gl_perspt', [nm('gl_fovt'), bin('/', nm('gl_w'), nm('gl_h')),
        num(0.1), num(1000)])),
      ex(dev('cls', [num(0)])),
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
      /* **这一格的符号是"行向量 × 矩阵"那套约定的**（我们这一侧顶点是行向量、矩阵按
         `m[12..14]` 放平移 —— `gl_translate` 与 `gl_vertex4` 都按这一套），所以填的是
         GL 那张 `R` 的**转置**：sin 那几项符号与 OpenGL 规范里的相反。
         量出来的证据：填 GL 原样的 `R` 时 `glRotate(60,1,0,0)` 与参考差 2 像素、
         而我们 `glRotate(-60)` 与参考 `glRotate(+60)` **逐像素相同**（转向反了）。 */
      aset('gl_tm', num(0), bin('+', bin('*', bin('*', nm('x'), nm('x')), nm('d')), nm('c'))),
      aset('gl_tm', num(1), bin('-', bin('*', bin('*', nm('y'), nm('x')), nm('d')), bin('*', nm('z'), nm('s')))),
      aset('gl_tm', num(2), bin('+', bin('*', bin('*', nm('x'), nm('z')), nm('d')), bin('*', nm('y'), nm('s')))),
      aset('gl_tm', num(4), bin('+', bin('*', bin('*', nm('x'), nm('y')), nm('d')), bin('*', nm('z'), nm('s')))),
      aset('gl_tm', num(5), bin('+', bin('*', bin('*', nm('y'), nm('y')), nm('d')), nm('c'))),
      aset('gl_tm', num(6), bin('-', bin('*', bin('*', nm('y'), nm('z')), nm('d')), bin('*', nm('x'), nm('s')))),
      aset('gl_tm', num(8), bin('-', bin('*', bin('*', nm('x'), nm('z')), nm('d')), bin('*', nm('y'), nm('s')))),
      aset('gl_tm', num(9), bin('+', bin('*', bin('*', nm('y'), nm('z')), nm('d')), bin('*', nm('x'), nm('s')))),
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

/** 画的那一摊：攒顶点、`glEnd` 那一刻按 mode 拆成点 / 线段 / 三角形**抄进批里**。 */
function glDrawDecls() {
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
     * 一格顶点。**两种顶点空间，看 `gl_prog`**：
     *   * 内建那对着色器（`gl_prog == 0`）收**裁剪空间** —— 这儿乘两个矩阵，
     *     `w <= 0`（在眼睛后头/近平面外）**整格丢掉**（这一版没有近平面插值）；
     *   * 脚本自己那格顶点着色器（`gl_prog != 0`）收**物体坐标** —— 原样存下，
     *     变换（`ftransform()` / `u_mvp`）与裁剪都是它与 GPU 的事。
     * 颜色存 0..1、纹理坐标存现在这一格（与 `(gfxbatch …)` 的契约同一格）。
     */
    fn('gl_vertex4', ['x', 'y', 'z', 'w'], [
      ex(call('gl_need', [])),
      iff(bin('>=', nm('gl_n'), num(VMAX)), [ret(num(0))]),
      iff(bin('!=', nm('gl_prog'), num(0)), [
        set('gl_cx', nm('x')), set('gl_cy', nm('y')),
        set('gl_cz', nm('z')), set('gl_cw', nm('w')),
      ], [
        ex(call('gl_xf', [nm('x'), nm('y'), nm('z'), nm('w')])),
        iff(bin('<=', nm('gl_cw'), num(0)), [ret(num(0))]),
      ]),
      vbset(nm('gl_n'), 0, nm('gl_cx')),
      vbset(nm('gl_n'), 1, nm('gl_cy')),
      vbset(nm('gl_n'), 2, nm('gl_cz')),
      vbset(nm('gl_n'), 3, nm('gl_cw')),
      vbset(nm('gl_n'), 4, nm('gl_r')),
      vbset(nm('gl_n'), 5, nm('gl_g')),
      vbset(nm('gl_n'), 6, nm('gl_b')),
      vbset(nm('gl_n'), 7, num(1)),
      vbset(nm('gl_n'), 8, nm('gl_ts')),
      vbset(nm('gl_n'), 9, nm('gl_tt')),
      vbset(nm('gl_n'), 10, nm('gl_tp')),
      vbset(nm('gl_n'), 11, nm('gl_tq')),
      set('gl_n', bin('+', nm('gl_n'), num(1))),
      ret(num(0)),
    ]),
    /* 一格点：抄进点那条批（设备画成一个像素 —— 像素多大是设备的事）。 */
    fn('gl_pt', ['i'], [
      iff(bin('>=', nm('gl_np'), num(OMAX)), [ex(call('gl_flush', []))]),
      ...copyV('gl_pb', 'gl_np', nm('i')),
      ret(num(0)),
    ]),
    /* 线段：两个顶点抄进线段那条批。 */
    fn('gl_seg', ['i', 'j'], [
      iff(bin('>=', bin('+', nm('gl_nl'), num(2)), num(OMAX)), [ex(call('gl_flush', []))]),
      ...copyV('gl_lb', 'gl_nl', nm('i')),
      ...copyV('gl_lb', 'gl_nl', nm('j')),
      ret(num(0)),
    ]),
    /**
     * 一格三角形：三个顶点抄进三角那条批。
     * 颜色按**重心插值**那件事交给设备 —— 三档设备各自实现（GPU 天然做、CPU 备选软件做）。
     */
    fn('gl_tri', ['i', 'j', 'k'], [
      iff(bin('>=', bin('+', nm('gl_no'), num(3)), num(OMAX)), [ex(call('gl_flush', []))]),
      ...copyV('gl_ob', 'gl_no', nm('i')),
      ...copyV('gl_ob', 'gl_no', nm('j')),
      ...copyV('gl_ob', 'gl_no', nm('k')),
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
      /* **可编程管线那一档：这一组顶点当场交出去**。理由是那张 `u_mvp` ——
         位置是物体坐标，变换随批一起过去（`batchmvp`），而矩阵是**这一刻**的：
         脚本一出 `glEnd` 常常就 `glPopMatrix`，攒到帧末再算就成了单位矩阵
         （踩过一次：整帧全黑）。于是这一档是"一组 glBegin/glEnd 一个 draw call"。 */
      iff(bin('!=', nm('gl_prog'), num(0)), [ex(call('gl_flush', []))]),
      ret(num(0)),
    ]),
  ];
}

