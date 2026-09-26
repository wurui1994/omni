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
  glob, anew, inum, letI, agetI, asetI,
} from './ir.js';

/** 设备那一面：一格宿主调用 / 一段顶点批。 */
const dev = (name, args = []) => bi('gfxcall', [str(name), ...args]);
const devBatch = (kind, cnt, arr) => bi('gfxbatch', [ix(num(kind)), ix(cnt), nm(arr)]);

/** 一格顶点占 16 个数（位置 4 / 颜色 4 / 纹理坐标 4 / 法向 4）—— 与 `(gfxbatch …)` 同契约。 */
const VS = 16;
/**
 * **一段 `glbegin`/`glend` 之间最多攒几个顶点。**
 *
 * 原版这儿是真 GL 的立即模式 —— 没有上限。我们要先攒成一块才交给设备，所以有一格数
 * （缓冲是一次开好的 `VMAX × 16` 个 double）。从前是 1024，而
 * `tigrou/ribbons invasion.pss` 的一条 `GL_TRIANGLE_STRIP` 就是 **4000 个顶点**
 * （`n = 2000`，每格发两个）：超出的**被静默丢掉**，而那一份脚本里有值的槽恰好在尾巴上
 * （`k = (j + nframes) % n`，写过的是 0..帧号），于是我们画出来**整张黑图** ——
 * 追这一格花了不少时间：批还在发（124 段）、颜色也对，只有顶点全是 0。
 * 判据上看得见的记号是"每段批 3066 个顶点"（1024 个 strip 顶点摊成 1022 个三角 = 3066）。
 *
 * 16384 之后那一份够用（4000）。**还是有上限**：再长的一段仍会截断 ——
 * 真正的修法是"攒满就按 mode 的规矩交一段再接着攒"（strip/fan 要把最后一两个顶点带过去、
 * quads/triangles 要对齐），那一格记在 docs/design/eval-realtime-gpu.md §28.8。
 */
const VMAX = 16384;
/** 一条批最多攒几个顶点（攒满就交出去）。 */
const OMAX = 3072;

/** `gl_vb` 的第 i 个顶点：**基址先算成一格 int**，十六格一格一格写（`vbset`）。 */
const vbase = (i) => letI('vb_b', ix(bin('*', i, num(VS))));
const vbset = (k, v) => asetI('gl_vb', bin('+', nm('vb_b'), inum(k)), v);

/** 一格顶点从 `gl_vb[i]` 抄到某条批的第 `c` 格（16 个数一格一格抄）。
 *
 * **两个基址各提成一格局部量**（`tag` 是调用点的记号，一个函数里可以抄好几格顶点）：
 * 从前十六句里每句都重算一遍 `i * 16` 与 `cnt * 16`，也就是一格顶点 32 次乘法 + 32 次
 * `int()`。`disco ball` 一帧 12 万个顶点，`gl_tri` 一个函数就占 35.6% 的栈顶样本
 * （2026-09-25，`--gfx null` + `OMNI_PROF`）。基址是同一个整数值算一次还是算十六次，
 * **答案逐位不变**。 */
const copyV = (dst, cnt, i, tag) => {
  const s = `cv_s_${tag}`;
  const d = `cv_d_${tag}`;
  const out = [letI(s, ix(bin('*', i, num(VS)))), letI(d, ix(bin('*', nm(cnt), num(VS))))];
  for (let k = 0; k < VS; k++) {
    out.push(asetI(dst, bin('+', nm(d), inum(k)), agetI('gl_vb', bin('+', nm(s), inum(k)))));
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
  'gl_prog', 'gl_ts', 'gl_tt', 'gl_tp', 'gl_tq', 'gl_qid',
  /* **当前法向**（`glnormal(x,y,z)` -> `polydraw.c:620` 的 `qglNormal3d`）——与
     `glColor` 同一个味道：设一次，之后每个 `glVertex` 都带着它走。默认 (0,0,1)。
     `clock.pss` 把它当**数据通道**用（`glnormal(shakeshift, shakecolor, xres/yres)`），
     所以原样送，不归一化。 */
  'gl_nx', 'gl_ny', 'gl_nz',
  /* 脚本那一格混合状态（`glAlphaEnable`/`Disable`）：**默认 1 = 关着**（`polydraw.c:2256`）。 */
  'gl_bl',
  /* **EvalDraw 那套纹理句柄**（`evaldraw.txt:1627-1637`）：那门语言的 `glsettex` 没有"槽"
     这个概念 —— 它**发一个句柄回来**、并且把它设成"当前纹理"。我们把句柄与设备的槽
     一对一映上：`ev_texn` 是下一个要发的句柄、`ev_cur` 是当前那一格。 */
  'ev_texn', 'ev_cur'];


export function glGlobalDecls() {
  return [
    ...GL_GLOBALS.map((n) => glob(n)),
    glob('gl_mv', ARR), glob('gl_pj', ARR), glob('gl_st', ARR),
    glob('gl_tm', ARR), glob('gl_vb', ARR),
    /* 交批时那格 MODELVIEW·PROJECTION（可编程管线那一档的 `u_mvp`）。 */
    glob('gl_mp', ARR),
    /* 三条顶点批：三角 / 线段 / 点（`(gfxbatch …)` 的三个类）。 */
    glob('gl_ob', ARR), glob('gl_lb', ARR), glob('gl_pb', ARR),
    /* EvalDraw `glsettex(标量,1,1)` 那一档的一格中转块（见 `ev_settexone`）。 */
    glob('ev_one', ARR),
  ];
}

/**
 * **宿主名字/元数 -> 生成出来的那格函数**（PolyDraw 的固定管线那一档）。
 *
 * 名字照 `polydraw.c:2070` 的 `myext[]`（那张表里是大写 + 形参个数，例如
 * `"GLVERTEX(,,)"` 就是三参那一版）—— 这门语言名字不分大小写，adapter 已经折成小写。
 */
/**
 * 一张"名字/元数 -> 生成出来的函数"的表，**同一个键来两次就当场报**。
 *
 * 为什么要这么一格：`new Map([...])` 对重复键是**后来者胜、一声不响**。这张表里
 * 从前同时有 `['glnormal/3','gl_normal3']`（真的那一格）与 `['glnormal/3','gl_nop3']`
 * （早年那条"收下不管"），于是**整格法向静默地成了空操作** —— 20 份脚本的法向全丢，
 * `ken/drawsph.pss` 那 1909 个球拿着默认法向 (0,0,1)，画出来是一个大球（查了很久）。
 * `rgb/3` 也这么被盖过一次。判据放在这一层：加错了就起不来。
 */
function uniqMap(pairs) {
  const m = new Map();
  for (const [k, v] of pairs) {
    if (m.has(k)) throw new Error(`gl-rt: 宿主表里 '${k}' 来了两次（'${m.get(k)}' 与 '${v}'）`);
    m.set(k, v);
  }
  return m;
}

export const POLYDRAW_GL = uniqMap([
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
  /* `gluLookAt(眼,看哪儿,上)`：纯矩阵，所以在语言这一侧（`polydraw.c:567` 自带一份）。 */
  ['glulookat/9', 'gl_lookat'],
  /* `rgb(r,g,b)` / `rgba(r,g,b,a)` -> 一格打包好的颜色（`polydraw.c:636`/`:637` 的
     `kmyrgb`/`kmyrgba`：各分量先夹到 0..255 再截成整数）。**纯算术**，所以也在语言这一侧 ——
     `ken/heightmap.pss` 用的是 `rgba`，从前整份跑不起来（"不认识的函数 rgba"）。 */
  ['rgb/3', 'gl_rgb'],
  ['rgba/4', 'gl_rgba'],
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
  /* `glquad()` **0 实参那一档**（`myext[]` 里登记的就是 `GLQUAD()`，语料里九份这么写）：
     照原版 `qglQuad(alpha)` —— alpha 没给就是 0，也就是**开 alpha 混合**那一档。 */
  ['glquad/0', 'gl_quad0'],
  ['glquad/1', 'gl_quad'],
  ['gltexcoord/2', 'gl_texcoord2'],
  ['gltexcoord/3', 'gl_texcoord3'],
  ['gltexcoord/4', 'gl_texcoord4'],
  /* 当前法向（`GLNORMAL(,,)`，`polydraw.c:2108`）。 */
  ['glnormal/3', 'gl_normal3'],
  ['glgetuniformloc/1', 'gl_uniloc'],
  ['gluniform/2', 'gl_uni1'],
  ['gluniform1f/2', 'gl_uni1'],
  ['gluniform2f/3', 'gl_uni2'],
  ['gluniform3f/4', 'gl_uni3'],
  ['gluniform4f/5', 'gl_uni4'],
  /* **带一整块数组的那两族**（§19.1）：`gluniform{1..4}{f,i}v(句柄,格数,&数组)` 与
     `glgettex(槽,&数组,宽,高,格)` —— 宿主面只收 double，所以走 `(gfxarr …)` 那格 op。 */
  ['gluniform1fv/3', 'gl_univ1f'],
  ['gluniform2fv/3', 'gl_univ2f'],
  ['gluniform3fv/3', 'gl_univ3f'],
  ['gluniform4fv/3', 'gl_univ4f'],
  ['gluniform1iv/3', 'gl_univ1i'],
  ['gluniform2iv/3', 'gl_univ2i'],
  ['gluniform3iv/3', 'gl_univ3i'],
  ['gluniform4iv/3', 'gl_univ4i'],
  ['glgettex/5', 'gl_gettex5'],
  /* **抓屏那一族**（§22）：`glcapture([边长])` / `glcaptureend([槽])`。
     没给槽那一档照原版是"那个实参根本没传"（`GLCAPTUREEND()` 在 `myext[]` 里是零参），
     我们按 0 号槽 —— `disco blur shader +blur.pss` 就是这么用的（它只有一张抓屏纹理）。 */
  ['glcapture/0', 'gl_capbegin0'],
  ['glcapture/1', 'gl_capbegin'],
  ['glcaptureend/0', 'gl_capend0'],
  ['glcaptureend/1', 'gl_capend'],
  ['glgetattribloc/1', 'gl_attrloc'],
  ['glvertexattrib1f/2', 'gl_attr1'],
  ['glvertexattrib2f/3', 'gl_attr2'],
  ['glvertexattrib3f/4', 'gl_attr3'],
  ['glvertexattrib4f/5', 'gl_attr4'],
  /* **纹理那一族**（第六刀，`docs/design/eval-realtime-gpu.md` 第 11 节）：数组那三档走
     `(gfxtex 槽 宽 高 层 格 数组)`。元数照 `myext[]:2168-2170` —— **最后一格总是 coltype**，
     4 个实参那一档是**一维**纹理（`kglsettexarray1`：ysiz=zsiz=1），不是 (宽,高)。 */
  ['glsettex/4', 'gl_settex4'],
  /* **文件纹理**（`glsettex(槽,"earth.jpg"[,colmode])`，§20）：串在这一步已经是名字表下标，
     设备按那个下标取文件名。一格串那一档的默认 colmode 是 `KGL_MIPMAP+KGL_REPEAT`
     = `(2<<4)+0` = 32（`polydraw.c:1346`）。 */
  ['glsettex/2', 'gl_settexf2'],
  ['glsettex/3', 'gl_settexf3'],
  ['glsettex/5', 'gl_settex5'],
  ['glsettex/6', 'gl_settex6'],
  ['glbindtexture/1', 'gl_bindtex'],
  ['glactivetexture/1', 'gl_activetex'],
  /* 收下但不管的那几格（这条腿上没有混合/剔除）。
     **`glnormal/3` 不在这儿**：它上头有一格真的（`gl_normal3`，§18）—— 这张表是
     `new Map([...])`，同一个键**后头那一条会盖住前头那一条**，从前这儿留着一条
     `['glnormal/3','gl_nop3']`，于是整格法向（20 份脚本用它）静默地成了空操作：
     `ken/drawsph.pss` 那 1909 个球全都拿默认法向 (0,0,1)，画出来是**一个**大球。 */
  ['glenable/1', 'gl_enable'],
  ['gldisable/1', 'gl_disable'],
  ['glcullface/1', 'gl_cullface'],
  ['gllinewidth/1', 'gl_nop1'],
  ['glswapinterval/1', 'gl_nop1'],
  ['glblendfunc/2', 'gl_nop2'],
  /* `glAlphaEnable` / `glAlphaDisable` 是**真的一对状态**（见 `gl_alphaon` 的头注）。 */
  ['glalphaenable/0', 'gl_alphaon'],
  ['glalphaenable/1', 'gl_alphaon1'],
  ['glalphadisable/0', 'gl_alphaoff'],
  ['glalphadisable/1', 'gl_alphaoff1'],
  /* `RGB(r,g,b)` / `RGBA(...)` 那两格在上头（`gl_rgb`/`gl_rgba`，夹到 0..255 再打包）——
     这儿**不许再来一条** `['rgb/3','gfx_rgb']`：同键后来者胜，那一条会把上头那格盖掉。 */
]);

/**
 * **EvalDraw 那套 `glsettex`**（`evaldraw.txt:1627-1637`）——与 PolyDraw 的**不是同一个函数**。
 *
 *     glsettex("wood.png");  // 按文件名设当前纹理，**回一个句柄**
 *     glsettex(myhand);      // 按句柄设当前纹理，回那个句柄（`-1` = 只问不改）
 *     glsettex(mybuf,x,y);   // 按静态数组设，回句柄（一格一个纹素、24 位 RGB，-1 透明）
 *     glremovetex(myhand);   // 放掉一个句柄
 *
 * PolyDraw 那边**第一个实参是槽号**（`glsettex(0,"earth.jpg")`），所以两门共用一张表时
 * `glsettex/3` 会撞：EvalDraw 的第 1 格是**数组**，撞上 PolyDraw 那格 `real` 形参 ——
 * 语料里 5 份 `.kc` 就是这么红的（`'gl_settexf3' 的第 1 个形参是 real，给的是 arr<real>`）。
 * 这张表挂在 EvalDraw 那张宿主表的**后头**（同键后来者胜），于是那门语言用这一份。
 *
 * 句柄怎么落：**与设备的槽一对一**（`ev_texn` 自增）。没有回收 —— `glremovetex` 只当
 * 收到了（槽不复用）。那门说明书说"不放就会很快用光句柄"，而我们这一侧的上限是设备的
 * 64 格；真要复用得有一张空闲表，记在 `docs/design/eval-realtime-gpu.md` §11。
 */
export const EVALDRAW_TEX = new Map([
  ['glsettex/1', 'ev_settexsel'],
  /* 串那一档：adapter 见到实参是**串字面量**时查的是带 `#str0` 的键（见 `callOf`）。 */
  ['glsettex/1#str0', 'ev_settexname'],
  /* 三参那一档有两种形状：第 0 格是**数组**（正常那一档）或者是**一格标量**
     （`demos/usflag.kc:4`：`static whitepix = 0xffffff; glsettex(whitepix,1,1);`
     —— 那门语言里一格标量的地址就是一格长度 1 的块）。adapter 按第 0 格是不是
     数组名挑 `#arr0` 那个键（见 `callOf`）。 */
  ['glsettex/3#arr0', 'ev_settexarr'],
  ['glsettex/3', 'ev_settexone'],
  ['glremovetex/1', 'ev_removetex'],
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
  /* **一整张矩阵一句**：`(gfxarr "batchmvp16" 0 0 0 0 gl_mp)`（列主序的 16 个数）。
     从前是四句 `(gfxcall "batchmvp" 列 m0..m3)` + 四句 `batchmv` —— 一段批八句宿主调用，
     每句还要在语言这一侧读四格数组。`disco ball` 一帧 3994 段批 ⇒ 31952 句矩阵，
     `gl_mvpsend` 一格就占 12.3% 的栈顶样本（2026-09-25，`--gfx null` + OMNI_PROF）。
     三档设备收到这一句照旧按列摆下去，语义与那八句**逐字相同**。 */
  const send = [ex(bi('gfxarr',
    [str('batchmvp16'), num(0), num(0), num(0), num(0), nm('gl_mp')]))];
  const sendIdent = [];
  for (let c = 0; c < 4; c++) {
    sendIdent.push(ex(dev('batchmvp', [num(c), num(c === 0 ? 1 : 0), num(c === 1 ? 1 : 0),
      num(c === 2 ? 1 : 0), num(c === 3 ? 1 : 0)])));
  }
  /* **模型视图那一格也要发**（`gl_ModelViewMatrix` / `gl_NormalMatrix` 用它，见 §18.4）：
     与 `batchmvp16` 逐字同形的一句，只是名字不同 —— 法向矩阵在 GLSL 里由它算出来，
     不另发一份状态。单位矩阵那一档（满屏四边形）走的是老路四句，那条路一帧只有几次。 */
  const sendMv = [ex(bi('gfxarr',
    [str('batchmv16'), num(0), num(0), num(0), num(0), nm('gl_mv')]))];
  const sendMvIdent = [];
  for (let c = 0; c < 4; c++) {
    sendMvIdent.push(ex(dev('batchmv', [num(c), num(c === 0 ? 1 : 0), num(c === 1 ? 1 : 0),
      num(c === 2 ? 1 : 0), num(c === 3 ? 1 : 0)])));
  }

  /* 满屏四边形那六个顶点（位置就是 NDC、纹理坐标 0..1，颜色是现在这一格）。 */
  const quadV = [[-1, -1, 0, 0], [1, -1, 1, 0], [-1, 1, 0, 1],
    [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]];
  const quad = [];
  for (const [x, y, s, t] of quadV) {
    const vals = [num(x), num(y), num(0), num(1),
      nm('gl_r'), nm('gl_g'), nm('gl_b'), num(1),
      num(s), num(t), num(0), num(1),
      num(0), num(0), num(1), num(0)];
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
      iff(bin('!=', nm('gl_qid'), num(0)), [...sendIdent, ...sendMvIdent, ret(num(0))]),
      ...mul,
      ...send,
      ...sendMv,
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
    /* `glnormal(x,y,z)` —— 照 `polydraw.c:620` 的 `qglNormal3d`：就是固定管线那格
       **当前法向**，与 `glColor` 同一个味道（不断批、不归一化）。 */
    fn('gl_normal3', ['x', 'y', 'z'], [
      ex(call('gl_need', [])),
      set('gl_nx', nm('x')), set('gl_ny', nm('y')), set('gl_nz', nm('z')),
      ret(num(0)),
    ]),
    stateFn('gl_uniloc', 'glgetuniformloc', ['a']),
    stateFn('gl_uni1', 'gluniform1f', ['h', 'x']),
    stateFn('gl_uni2', 'gluniform2f', ['h', 'x', 'y']),
    stateFn('gl_uni3', 'gluniform3f', ['h', 'x', 'y', 'z']),
    stateFn('gl_uni4', 'gluniform4f', ['h', 'x', 'y', 'z', 'w']),
    stateFn('gl_attrloc', 'glgetattribloc', ['a']),
    /* **带一整块数组的那两族**（§19.1）：`(gfxarr "名字" a0 a1 a2 a3 数组)`。
       与 `gluniform*f` 一样是"按 draw call 生效"的状态 ⇒ 先断批。
       `glgettex` 的最后那格 coltype **不看**（照 `kglgettexarray2`：一像素几个 double
       由那一槽自己的格说），所以原样递过去、设备自己判。 */
    ...[1, 2, 3, 4].flatMap((k) => ['f', 'i'].map((t) => fnT(`gl_univ${k}${t}`,
      [['h'], ['n'], ['v', ARR]], [
        ex(call('gl_need', [])),
        ex(call('gl_flush', [])),
        ret(bi('gfxarr', [str(`gluniform${k}${t}v`), nm('h'), nm('n'), num(0), num(0),
          nm('v')])),
      ]))),
    fnT('gl_gettex5', [['t'], ['p', ARR], ['xs'], ['ys'], ['ct']], [
      ex(call('gl_need', [])),
      ex(call('gl_flush', [])),
      ret(bi('gfxarr', [str('glgettex'), nm('t'), nm('xs'), nm('ys'), nm('ct'), nm('p')])),
    ]),
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
    /* 文件纹理那两档（§20）：`(gfxcall "glsettexfile" 槽 名字下标 colmode)`。 */
    fn('gl_settexf3', ['t', 'nm', 'cm'], [
      ex(call('gl_need', [])),
      ex(call('gl_flush', [])),
      ret(dev('glsettexfile', [nm('t'), nm('nm'), nm('cm')])),
    ]),
    fn('gl_settexf2', ['t', 'nm'], [
      ex(call('gl_settexf3', [nm('t'), nm('nm'), num(32)])),
      ret(num(0)),
    ]),
    /* ── EvalDraw 那三档 `glsettex`（见 `EVALDRAW_TEX` 的头注）──────────────────
       与 PolyDraw 的差别只有两件：**没有槽号**（句柄是我们发的）、**要回句柄**。
       上传那两步直接借 PolyDraw 那两格（文件走 `gl_settexf3`、数组走 `gl_settex6`），
       所以设备那一面一个字都不用改。 */
    fn('ev_settexname', ['n'], [
      letR('h', nm('ev_texn')),
      set('ev_texn', bin('+', nm('ev_texn'), num(1))),
      ex(call('gl_settexf3', [nm('h'), nm('n'), num(32)])),
      set('ev_cur', nm('h')),
      ex(call('gl_bindtex', [nm('h')])),
      ret(nm('h')),
    ]),
    /* `glsettex(句柄)`：设当前纹理并回它；**负数只问不改**（说明书那句
       `hand = glsettex(-1)`）。 */
    fn('ev_settexsel', ['a'], [
      iff(bin('>=', nm('a'), num(0)), [
        set('ev_cur', nm('a')),
        ex(call('gl_bindtex', [nm('a')])),
      ]),
      ret(nm('ev_cur')),
    ]),
    /* `glsettex(数组,x,y)`：一格一个纹素、24 位 RGB ⇒ 格是 `KGL_BGRA32`(0) +
       `KGL_LINEAR`(0) + `KGL_REPEAT`(0) = **0**（`polydraw.c:190-193` 那三段 enum）。
       `x` 是内层维度（说明书那句 "x being the inner-most dimension"）⇒ 宽。 */
    fnT('ev_settexarr', [['px', ARR], ['xs'], ['ys']], [
      letR('h', nm('ev_texn')),
      set('ev_texn', bin('+', nm('ev_texn'), num(1))),
      ex(call('gl_settex6', [nm('h'), nm('px'), nm('xs'), nm('ys'), num(1), num(0)])),
      set('ev_cur', nm('h')),
      ex(call('gl_bindtex', [nm('h')])),
      ret(nm('h')),
    ]),
    /* 句柄回收：这一版**只当收到了**（槽不复用，见 `EVALDRAW_TEX` 头注最后一段）。 */
    fn('ev_removetex', ['h'], [ret(num(0))]),
    /* 标量那一档（`glsettex(0xffffff,1,1)`）：抄进 `ev_one` 那格长度 1 的块再上传。
       **尺寸一律按 1×1 走**：标量后头没有第二格纹素，照 `xs,ys` 递会让设备当场说
       "像素不够"（那样反而把脚本判红）。语料里这么写的只有 `usflag.kc` 的 1×1 白点。 */
    fn('ev_settexone', ['v', 'xs', 'ys'], [
      aset('ev_one', num(0), nm('v')),
      ret(call('ev_settexarr', [nm('ev_one'), num(1), num(1)])),
    ]),
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
      /* 还回脚本那一格混合状态（原版是 `glPushAttrib`/`glPopAttrib`）。 */
      ex(dev('batchblend', [nm('gl_bl')])),
      ret(num(0)),
    ]),
    /* `glquad()`（0 实参）—— `myext[]` 里 `GLQUAD()` 就是这一档，语料里九份这么写。
       照原版 `qglQuad(alpha)`：alpha 没给就是 0，也就是**开 alpha 混合**那一档。 */
    fn('gl_quad0', [], [ex(call('gl_quad', [num(0)])), ret(num(0))]),
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
      set('gl_vb', anew(num(VMAX * VS))),
      set('gl_mp', anew(num(16))),
      set('gl_prog', num(0)),
      set('gl_qid', num(0)),
      set('gl_ts', num(0)), set('gl_tt', num(0)), set('gl_tp', num(0)), set('gl_tq', num(1)),
      /* 当前法向的初值照 GL 规范是 (0,0,1)。 */
      set('gl_nx', num(0)), set('gl_ny', num(0)), set('gl_nz', num(1)),
      set('gl_bl', num(1)),
      set('gl_ob', anew(num(OMAX * VS))),
      set('gl_lb', anew(num(OMAX * VS))),
      set('gl_pb', anew(num(OMAX * VS))),
      /* EvalDraw 的 `glsettex(标量,1,1)` 那一档要一格长度 1 的块。 */
      set('ev_one', anew(num(1))),
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
    /**
     * **`glCullFace(mode)`**（`polydraw.c:1598` 的 `kglCullFace`）——
     * `GL_NONE`(0) 关剔除，别的（`GL_FRONT`=0x0404 / `GL_BACK`=0x0405）开剔除并剔那一面。
     *
     * **正面是顺时针**：正本除了 `glEnable(GL_CULL_FACE)` + `glCullFace(mode)` 还发一句
     * `glFrontFace(GL_CW)`（`polydraw.c:1605`，参考 `c_impl` 也照抄了）—— 也就是说
     * 这门语言的正面约定与 GL 默认的 CCW **反过来**，那一句钉在设备那一层
     * （`runtime-gl/omni_ev_gl.c` 的 `omni_ev_gl_cull`、`studio/gfx-gl.js` 的 flush）。
     *
     * 剔除是**设备状态**：一变就断一段批，所以先 `gl_flush`（与 `gldepth` 那一格同一手）。
     * 语料里 4 份用它：`tigrou/disco ball`（`GL_FRONT`）、`ken/texture`（两趟交替）、
     * `ken/curvybuild`、`ken/heightmap`。
     */
    fn('gl_cullface', ['mode'], [
      ex(call('gl_need', [])),
      ex(call('gl_flush', [])),
      iff(bin('==', nm('mode'), num(0x0404)),
        [ex(dev('glcull', [num(2)]))],
        [iff(bin('==', nm('mode'), num(0)),
          [ex(dev('glcull', [num(0)]))],
          [ex(dev('glcull', [num(1)]))])]),
      ret(num(0)),
    ]),
    fn('gl_nop2', ['a', 'b'], [ret(num(0))]),
    fn('gl_nop3', ['a', 'b', 'c'], [ret(num(0))]),
    /**
     * **`glAlphaEnable()` / `glAlphaDisable()`**（`polydraw.c:962`/`:969`）——
     * 语料里 3 份用它（`texture3d` / `creepers_asm` / `particules sparks`）。
     *
     * 原版那两格就是一对 GL 状态：`AlphaEnable` = 关深度测试 + 开混合
     * （`SRC_ALPHA, ONE_MINUS_SRC_ALPHA`），`AlphaDisable` = 开深度测试 + 关混合；
     * **开机与每次重编都是 `AlphaDisable`**（`polydraw.c:2256`）⇒ 默认"混合关着"。
     * 参考也实现了这一对（`c_impl/.../pd_polyhost_render.c:112`）。
     *
     * 从前这儿是 no-op，于是 `ken/texture3d.pss` 那 362 层体素切片全是不透明的、
     * 一层盖一层，一盏灯画成一个渐变方块（那份图的 alpha 才是"实心没实心"）。
     *
     * 深度测试那一半**不动**（这一档默认就是关着的，与参考同） —— 见 §24。
     * `gl_bl` 记着脚本这一格状态：`glquad` 那一趟改完要还回来（原版是
     * `glPushAttrib`/`glPopAttrib`）。
     */
    fn('gl_alphaon', [], [
      ex(call('gl_need', [])),
      ex(call('gl_flush', [])),
      set('gl_bl', num(0)),
      ex(dev('batchblend', [num(0)])),
      ret(num(0)),
    ]),
    fn('gl_alphaoff', [], [
      ex(call('gl_need', [])),
      ex(call('gl_flush', [])),
      set('gl_bl', num(1)),
      ex(dev('batchblend', [num(1)])),
      ret(num(0)),
    ]),
    fn('gl_alphaon1', ['a'], [ex(call('gl_alphaon', [])), ret(num(0))]),
    fn('gl_alphaoff1', ['a'], [ex(call('gl_alphaoff', [])), ret(num(0))]),
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
  /* `gl_mv = gl_mv · gl_tm`。十六格**摊开写**（一格是四个乘积的和）——
     这一层没有循环反而更清楚，而且少两层下标算术。
     **十六格先落局部量再写回**（从前是落 `gl_ta` 那格全局数组再抄回来）：读写的次序与
     算术一个字没变（十六个乘加全在写第一格之前算完），只是省掉 16 次数组写 + 16 次数组读。
     `gl_mvmul` 在 `disco ball` 上占 23.9% 的栈顶样本（2026-09-25）。 */
  const mul = [];
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let acc = null;
      for (let k = 0; k < 4; k++) {
        const t = bin('*', aget('gl_mv', num(k * 4 + r)), aget('gl_tm', num(c * 4 + k)));
        acc = acc === null ? t : bin('+', acc, t);
      }
      mul.push(letR(`mm${c * 4 + r}`, acc));
    }
  }
  const back = [];
  for (let i = 0; i < 16; i++) back.push(aset('gl_mv', num(i), nm(`mm${i}`)));

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

  /* 栈那两格：基址（`gl_sp * 16`）也只算一次，而且存成 int —— 与 `copyV` 同一条理由。 */
  const push = [letI('psb', ix(bin('*', nm('gl_sp'), num(16))))];
  const pop = [letI('ppb', ix(bin('*', nm('gl_sp'), num(16))))];
  for (let i = 0; i < 16; i++) {
    push.push(asetI('gl_st', bin('+', nm('psb'), inum(i)), aget('gl_mv', num(i))));
    pop.push(aset('gl_mv', num(i), agetI('gl_st', bin('+', nm('ppb'), inum(i)))));
  }

  return [
    fn('gl_mvmul', [], [...mul, ...back, ret(num(0))]),
    fn('gl_xf', ['x', 'y', 'z', 'w'], [...xf, ret(num(0))]),
    /**
     * **矩阵要变了：先把攒着的批交出去**（只有脚本着色器那一档要）。
     *
     * 可编程管线那一档位置是**物体坐标**，变换随批走（`batchmvp`/`batchmv`）——
     * 所以"矩阵变了"才是断批的那条线。从前断在 `glEnd` 上（一组 `glBegin/glEnd`
     * 一个 draw call），量出来那是这一层最贵的一格：`tigrou/disco ball.pss` 一帧
     * **19970 段批 + 159760 句矩阵**（一段 8 句），光语言那一半（`--gfx null`）就 182ms。
     * 一片镜片是 `push/translate/rotate/rotate/scale` + 5 组 `glBegin/glEnd` + `pop`，
     * 五组之间矩阵一个字没变 —— 断在矩阵上，这五组就并成一段批、矩阵也只发一次。
     */
    fn('gl_mvdirty', [], [
      iff(bin('!=', nm('gl_prog'), num(0)), [ex(call('gl_flush', []))]),
      ret(num(0)),
    ]),
    fn('gl_push', [], [
      ex(call('gl_need', [])),
      ex(call('gl_mvdirty', [])),
      /* 栈满了就**不推**（GL 那边是 GL_STACK_OVERFLOW，画面照旧）。 */
      iff(bin('>=', nm('gl_sp'), num(31)), [ret(num(0))]),
      ...push,
      set('gl_sp', bin('+', nm('gl_sp'), num(1))),
      ret(num(0)),
    ]),
    fn('gl_pop', [], [
      ex(call('gl_need', [])),
      ex(call('gl_mvdirty', [])),
      iff(bin('<=', nm('gl_sp'), num(0)), [ret(num(0))]),
      set('gl_sp', bin('-', nm('gl_sp'), num(1))),
      ...pop,
      ret(num(0)),
    ]),
    /**
     * `gluLookAt(眼 3, 看哪儿 3, 上 3)` —— **照 `polydraw.c:567` 那一份自己的实现抄**
     * （原版没用 GLU 的，它自己写了一份）：算出一张矩阵之后 `glLoadMatrixd` ——
     * 注意是**替换**，不是乘上去。
     *
     * `f = 眼 - 看哪儿`（**倒着的**，GL 的相机看 -Z），`r = f × 上`、`d = f × r`，
     * 平移那一列是 `-(那一行 · 眼)`。索引与原版逐格相同（我们这格 `gl_mv` 也是列主序）。
     */
    fn('gl_lookat', ['px', 'py', 'pz', 'fx', 'fy', 'fz', 'ux', 'uy', 'uz'], [
      ex(call('gl_need', [])),
      ex(call('gl_mvdirty', [])),
      letR('f0', bin('-', nm('px'), nm('fx'))),
      letR('f1', bin('-', nm('py'), nm('fy'))),
      letR('f2', bin('-', nm('pz'), nm('fz'))),
      letR('fl', rm('sqrt', [bin('+', bin('+', bin('*', nm('f0'), nm('f0')),
        bin('*', nm('f1'), nm('f1'))), bin('*', nm('f2'), nm('f2')))])),
      iff(bin('<=', nm('fl'), num(0)), [ret(num(0))]),
      letR('g0', bin('/', nm('f0'), nm('fl'))),
      letR('g1', bin('/', nm('f1'), nm('fl'))),
      letR('g2', bin('/', nm('f2'), nm('fl'))),
      letR('r0', bin('-', bin('*', nm('g2'), nm('uy')), bin('*', nm('g1'), nm('uz')))),
      letR('r1', bin('-', bin('*', nm('g0'), nm('uz')), bin('*', nm('g2'), nm('ux')))),
      letR('r2', bin('-', bin('*', nm('g1'), nm('ux')), bin('*', nm('g0'), nm('uy')))),
      letR('rl', rm('sqrt', [bin('+', bin('+', bin('*', nm('r0'), nm('r0')),
        bin('*', nm('r1'), nm('r1'))), bin('*', nm('r2'), nm('r2')))])),
      iff(bin('<=', nm('rl'), num(0)), [ret(num(0))]),
      letR('s0', bin('/', nm('r0'), nm('rl'))),
      letR('s1', bin('/', nm('r1'), nm('rl'))),
      letR('s2', bin('/', nm('r2'), nm('rl'))),
      letR('d0', bin('-', bin('*', nm('g1'), nm('s2')), bin('*', nm('g2'), nm('s1')))),
      letR('d1', bin('-', bin('*', nm('g2'), nm('s0')), bin('*', nm('g0'), nm('s2')))),
      letR('d2', bin('-', bin('*', nm('g0'), nm('s1')), bin('*', nm('g1'), nm('s0')))),
      /* 索引与原版逐格相同：`gl_mv` 这一格是**列主序**（`gl_xf` 里是
         `e[r] = Σ_k gl_mv[k*4+r]*v[k]`，也就是"矩阵 × 列向量"），
         而 `mat[0],mat[4],mat[8]` 正是那张矩阵的第 0 行。 */
      aset('gl_mv', num(0), nm('s0')),
      aset('gl_mv', num(4), nm('s1')),
      aset('gl_mv', num(8), nm('s2')),
      aset('gl_mv', num(12), bin('-', num(0), bin('+', bin('+',
        bin('*', nm('s0'), nm('px')), bin('*', nm('s1'), nm('py'))),
        bin('*', nm('s2'), nm('pz'))))),
      aset('gl_mv', num(1), nm('d0')),
      aset('gl_mv', num(5), nm('d1')),
      aset('gl_mv', num(9), nm('d2')),
      aset('gl_mv', num(13), bin('-', num(0), bin('+', bin('+',
        bin('*', nm('d0'), nm('px')), bin('*', nm('d1'), nm('py'))),
        bin('*', nm('d2'), nm('pz'))))),
      aset('gl_mv', num(2), nm('g0')),
      aset('gl_mv', num(6), nm('g1')),
      aset('gl_mv', num(10), nm('g2')),
      aset('gl_mv', num(14), bin('-', num(0), bin('+', bin('+',
        bin('*', nm('g0'), nm('px')), bin('*', nm('g1'), nm('py'))),
        bin('*', nm('g2'), nm('pz'))))),
      aset('gl_mv', num(3), num(0)),
      aset('gl_mv', num(7), num(0)),
      aset('gl_mv', num(11), num(0)),
      aset('gl_mv', num(15), num(1)),
      ret(num(0)),
    ]),
    /* `rgb`/`rgba`：分量夹到 0..255、截成整数、打包（`polydraw.c:636`/`:637`）。
       原版是 `(int)` 截断；活下来的值都在 0..255 之间，那一段里 `floor` 与截断同值，
       所以用 `floor`（我们这套 rmath 里就这一格）。 */
    fn('gl_c255', ['v'], [
      letR('i', rm('floor', [nm('v')])),
      iff(bin('<', nm('i'), num(0)), [ret(num(0))]),
      iff(bin('>', nm('i'), num(255)), [ret(num(255))]),
      ret(nm('i')),
    ]),
    fn('gl_rgb', ['r', 'g', 'b'], [
      ret(bin('+', bin('+',
        bin('*', call('gl_c255', [nm('r')]), num(65536)),
        bin('*', call('gl_c255', [nm('g')]), num(256))),
      call('gl_c255', [nm('b')]))),
    ]),
    fn('gl_rgba', ['r', 'g', 'b', 'a'], [
      ret(bin('+', bin('*', call('gl_c255', [nm('a')]), num(16777216)),
        call('gl_rgb', [nm('r'), nm('g'), nm('b')]))),
    ]),
    fn('gl_translate', ['x', 'y', 'z'], [
      ex(call('gl_need', [])),
      ex(call('gl_mvdirty', [])),
      ...tmIdent(),
      aset('gl_tm', num(12), nm('x')),
      aset('gl_tm', num(13), nm('y')),
      aset('gl_tm', num(14), nm('z')),
      ex(call('gl_mvmul', [])),
      ret(num(0)),
    ]),
    fn('gl_scale', ['x', 'y', 'z'], [
      ex(call('gl_need', [])),
      ex(call('gl_mvdirty', [])),
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
      ex(call('gl_mvdirty', [])),
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
      /* **照 OpenGL 规范原样填**（列主序：第 (r,c) 格在 `c*4+r`）—— 这一格从前填的是
         那张 `R` 的**转置**（= 按 `-角度` 转），理由写的是"我们这一侧顶点是行向量"：
         那句话是错的，`gl_mvmul`（`gl_mv · gl_tm`）、`gl_xf`（`gl_mv · v`）、
         `gl_translate`（平移放 `m[12..14]`）整条路都是 GL 的列向量那一套，只有这一格反着。
         当时的"证据"是拿参考对的（`glRotate(60,1,0,0)` 差 2 像素），可**参考自己这一格
         就是转置的**：`c_impl/src/render/gl_renderer.c:98` 那张 `t[16]` 的字面量按行写、
         数组按列用（它的 `mat4_mul` / `mat4_translate` 与我们逐句相同，只有它错）。
         **正本是真 OpenGL**：原版 `glrotate` 就是 `glRotated`（`polydraw.c:2141` 的
         `qglRotated`），本机拿 CGL 问过固定管线 ——
         `glRotated(45,0,1,0); glTranslated(0,0,-10)` 之后 `(2,2,0)` 落在
         `(-5.6569, 2, -8.4853)`，与这一版逐位相同（转置那一版给 `(8.4853,2,5.4580)`）。
         把参考那一格照同样的改法补上再跑，`town textured` 从全黑变成铺满 80.5% 的城市。 */
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
      ex(call('gl_mvdirty', [])),
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
    /**
     * **抓屏那一族**（`glcapture([边长])` / `glcaptureend([槽])`，§22）。
     *
     * 这一侧只有两件事：**断批**（抓屏前后是两拨不同的东西，攒在一起就错了）与
     * 把那一句转给设备。矩阵一格都不动 —— 口径与那一格为什么这么定，见
     * `omni_ev_gl_capbegin` 的头注（两份参考在这一格不是一回事，跟的是 c_impl）。
     */
    fn('gl_capbegin', ['siz'], [
      ex(call('gl_need', [])),
      ex(call('gl_flush', [])),
      ret(dev('glcapture', [nm('siz')])),
    ]),
    fn('gl_capbegin0', [], [ex(call('gl_capbegin', [num(0)])), ret(num(0))]),
    fn('gl_capend', ['t'], [
      ex(call('gl_need', [])),
      ex(call('gl_flush', [])),
      ret(dev('glcaptureend', [nm('t')])),
    ]),
    fn('gl_capend0', [], [ex(call('gl_capend', [num(0)])), ret(num(0))]),
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
     *   * 内建那对着色器（`gl_prog == 0`）收**裁剪空间** —— 这儿乘两个矩阵，然后原样交出去：
     *     `w <= 0`（镜头背后 / 近平面外）**也照样交** —— 裁剪是 GPU 的事，它按整格图元
     *     沿近平面裁开（这一格从前是"整格顶点丢掉"，见 §27.4：丢一个顶点会把后面整串
     *     顶点错位，四边形变成三条边，跨近平面的楼于是整栋不见 —— `town no texture`
     *     我们 55274 格、参考 71495 格就是这么来的）；
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
      ]),
      vbase(nm('gl_n')),
      vbset(0, nm('gl_cx')),
      vbset(1, nm('gl_cy')),
      vbset(2, nm('gl_cz')),
      vbset(3, nm('gl_cw')),
      vbset(4, nm('gl_r')),
      vbset(5, nm('gl_g')),
      vbset(6, nm('gl_b')),
      vbset(7, num(1)),
      vbset(8, nm('gl_ts')),
      vbset(9, nm('gl_tt')),
      vbset(10, nm('gl_tp')),
      vbset(11, nm('gl_tq')),
      vbset(12, nm('gl_nx')),
      vbset(13, nm('gl_ny')),
      vbset(14, nm('gl_nz')),
      vbset(15, num(0)),
      set('gl_n', bin('+', nm('gl_n'), num(1))),
      ret(num(0)),
    ]),
    /* 一格点：抄进点那条批（设备画成一个像素 —— 像素多大是设备的事）。 */
    fn('gl_pt', ['i'], [
      iff(bin('>=', nm('gl_np'), num(OMAX)), [ex(call('gl_flush', []))]),
      ...copyV('gl_pb', 'gl_np', nm('i'), 'p'),
      ret(num(0)),
    ]),
    /* 线段：两个顶点抄进线段那条批。 */
    fn('gl_seg', ['i', 'j'], [
      iff(bin('>=', bin('+', nm('gl_nl'), num(2)), num(OMAX)), [ex(call('gl_flush', []))]),
      ...copyV('gl_lb', 'gl_nl', nm('i'), 'la'),
      ...copyV('gl_lb', 'gl_nl', nm('j'), 'lb'),
      ret(num(0)),
    ]),
    /**
     * 一格三角形：三个顶点抄进三角那条批。
     * 颜色按**重心插值**那件事交给设备 —— 三档设备各自实现（GPU 天然做、CPU 备选软件做）。
     */
    fn('gl_tri', ['i', 'j', 'k'], [
      iff(bin('>=', bin('+', nm('gl_no'), num(3)), num(OMAX)), [ex(call('gl_flush', []))]),
      ...copyV('gl_ob', 'gl_no', nm('i'), 'ta'),
      ...copyV('gl_ob', 'gl_no', nm('j'), 'tb'),
      ...copyV('gl_ob', 'gl_no', nm('k'), 'tc'),
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
      /**
       * `GL_TRIANGLE_STRIP`：第 k 个三角（k 从 0 起）是 `(k, k+1, k+2)`，
       * **k 为奇数时前两个换位**（`(k+1, k, k+2)`）—— GL 就是这么定的，为的是让整条带的
       * **绕向一致**（不换位每隔一个三角就是反的）。从前这儿一律 `(i-2, i-1, i)`：
       * 光栅化看不出来（三个点一样、颜色按重心插值也一样），可**面剔除一开就现形**
       * —— §28.11 那一趟 CCW 下剔掉的正是该留的一半，就是这一格。
       */
      iff(bin('==', nm('m'), num(5)),
        loop(num(2), 0, 1, [
          iff(bin('==', rm('fmod', [bin('-', nm('i'), num(2)), num(2)]), num(0)),
            [ex(call('gl_tri', [bin('-', nm('i'), num(2)),
              bin('-', nm('i'), num(1)), nm('i')]))],
            [ex(call('gl_tri', [bin('-', nm('i'), num(1)),
              bin('-', nm('i'), num(2)), nm('i')]))]),
        ])),
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
      /* **矩阵变了才断批**（见 `gl_mvdirty` 那段头注）—— 从前这儿无条件断，
         `disco ball` 一帧就断成 19970 段。 */
      ret(num(0)),
    ]),
  ];
}

