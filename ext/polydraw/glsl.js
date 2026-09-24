// ext/polydraw/glsl.js —— **旧式 GLSL -> 对齐后的主体**（两档 GPU 设备共用一份）
//
// 口径（2026-09-24 用户定的）：**必须与 WebGL 对齐，不允许存在两种模型**。
// PolyDraw 的脚本写的是旧式 GLSL（真 OpenGL 1.x/2.x 的那一套：`attribute` / `varying` /
// `gl_FragColor` / `ftransform()` / `texture2D`），而两档 GPU 设备要的都是新式：
//
//     浏览器（WebGL2）  GLSL ES 300      #version 300 es + precision highp float;
//     本机（core）      GLSL 410 core    #version 410 core
//
// 两者的**主体语法是同一套**（`in`/`out`、`texture()`、自己声明的输出变量）—— 差的只有
// 那一两行头。所以翻译只有**一份**，在这儿；`#version` 那一行由各档设备自己补。
//
// **在哪儿翻**：编译期（`adapter.js` 把 `(gfxdef vert 名字 原文)` 发出去之前）。
// 于是设备收到的就已经是对齐后的文本 —— 两档设备一个字都不用自己翻。
// 在设备里各翻一遍就是两份实现，那正是这条规矩要挡住的东西。
//
// 认不出的东西**照原样留着**，让驱动去报（报里带着原文与行号，比我们猜着改好）。

/**
 * 一段旧式 GLSL -> 对齐后的主体（**不含 `#version`**）。
 *
 * * `attribute` -> `in`；`varying` -> 顶点段 `out`、片元段 `in`；
 * * `gl_Vertex` -> `a_pos`（我们喂的顶点属性，vec4）、`gl_MultiTexCoord0` -> `a_tex`；
 * * `ftransform()` -> `(u_mvp * a_pos)`（固定管线那两个矩阵的积，由设备喂 uniform）；
 * * `gl_ModelViewProjectionMatrix` -> `u_mvp`；
 * * `gl_TexCoord[0]` -> 自己声明的 `v_tex0`（两段各自 out/in）；
 * * `gl_Color` -> 顶点段 `a_col`、片元段 `v_col0`（**片元里那一格是插值过的**）；
 * * `gl_FragColor` -> 自己声明的 `o_col`；`texture2D(` -> `texture(`。
 *
 * 已经是新式的（自带 `#version`）**原样回** —— 脚本自己写好了就不动它。
 */
/**
 * **`#ifdef GL_扩展名` 那一族就地判掉**（`#else` / `#endif`，不嵌套 —— 语料里只有一处）。
 *
 * 为什么不能靠编译器自己判：core profile 里那些扩展宏**不定义**（扩展早并进核心了），
 * 而 `#define GL_…` 又是 GLSL 明令禁止的（`#define of reserved name`，试过）。
 * 所以由这一层判：**我们真有的**（`textureLod`）算定义着、别的算没有。
 *
 * `ken/mipmap.pss` 是唯一一份这么写的：`#ifdef GL_ARB_shader_texture_lod` 里头用
 * `texture2DLod(tex0,t.xy,dep)` 自己挑 mip 层、`#else` 是普通 `texture2D`。走错哪条
 * 整张图都不一样（清清楚楚的棋盘地面 vs 糊成几条横带）。
 *
 * 切掉的行**换成空行**（行号不动 —— 编译器的诊断还要照着原文看）。
 */
const GLSL_HAVE = new Set(['GL_ARB_shader_texture_lod']);

/** `@g` 段首那两个图元名 -> GLSL 的 `layout` 名（`polydraw.txt:203-205`）。 */
const GEO_IN = new Map([
  ['GL_POINTS', 'points'], ['GL_LINES', 'lines'],
  ['GL_LINES_ADJACENCY_EXT', 'lines_adjacency'], ['GL_LINES_ADJACENCY', 'lines_adjacency'],
  ['GL_TRIANGLES', 'triangles'],
  ['GL_TRIANGLES_ADJACENCY_EXT', 'triangles_adjacency'],
  ['GL_TRIANGLES_ADJACENCY', 'triangles_adjacency'],
]);
const GEO_OUT = new Map([
  ['GL_POINTS', 'points'], ['GL_LINE_STRIP', 'line_strip'],
  ['GL_TRIANGLE_STRIP', 'triangle_strip'],
]);
/** 那两个图元名各自的"每段几个顶点"由 `layout` 定，`gl_in.length()` 自己会算。 */

/**
 * **几何段**（`@g`）：`EXT_geometry_shader4` 那一套 -> core / ES 的 `layout` + `gl_in[]`。
 *
 * 旧式（脚本写的）                     新式（两档设备要的）
 *   `#extension GL_EXT_geometry_shader4`  两句 `layout`（段首那三个参数）
 *   `gl_VerticesIn`                       `gl_in.length()`
 *   `gl_PositionIn[i]`                    `gl_in[i].gl_Position`
 *   `gl_FrontColorIn[i]` / `gl_TexCoordIn[i][0]`  顶点段那两格跨段量的**数组**形式
 *   `gl_FrontColor` / `gl_TexCoord[0]`（写）      这一段自己的 out
 *   `EmitVertex()` / `EndPrimitive()`     一个字不用动
 *
 * 跨段量的名字见 `glslAlign` 头上那段：进来是 `gv_*`、出去是 `v_*`（片元段照旧读 `v_*`）。
 * 段首那三个参数解在 `adapter.js` 的 `splitSections` 里（`geo`）；没有那一行就按
 * `triangles` / `triangle_strip` / 64 兜着（脚本不给参数本来就是错的，让驱动去报）。
 */
function glslGeom(src, geo) {
  const gi = GEO_IN.get(String(geo?.in ?? '').toUpperCase()) ?? 'triangles';
  const go = GEO_OUT.get(String(geo?.out ?? '').toUpperCase()) ?? 'triangle_strip';
  const mx = Number.isFinite(geo?.max) && geo.max > 0 ? Math.trunc(geo.max) : 64;
  /* `#version` / `#extension` 那两行切掉（换成空行 —— 行号不动，诊断还照着原文看）：
     旧式那两行在 core 里要么冲突（`#version 120`）要么是"扩展早并进核心了"。
     段里自带新式 `#version 3xx/4xx` 的**原样回**（脚本自己写好了就不动它）。 */
  if (/#\s*version\s+[3-9]\d\d/.test(src)) return src;
  let s = src.split('\n')
    .map((l) => (/^\s*#\s*(version|extension)\b/.test(l) ? '' : l)).join('\n');
  s = glslIfdef(s);
  s = s.replace(/\bgl_VerticesIn\b/g, 'gl_in.length()');
  s = s.replace(/\bgl_PositionIn\s*\[([^\]]*)\]/g, 'gl_in[$1].gl_Position');
  s = s.replace(/\bgl_TexCoordIn\s*\[([^\]]*)\]\s*\[\s*0\s*\]/g, 'gv_tex0[$1]');
  s = s.replace(/\bgl_FrontColorIn\s*\[([^\]]*)\]/g, 'gv_col0[$1]');
  s = s.replace(/\bgl_TexCoord\s*\[\s*0\s*\]/g, 'v_tex0');
  s = s.replace(/\bgl_FrontColor\b/g, 'v_col0');
  s = s.replace(/\bgl_ModelViewProjectionMatrix\b/g, 'u_mvp');
  s = s.replace(/\bgl_NormalMatrix\b/g, 'mat3(transpose(inverse(u_mv)))');
  s = s.replace(/\bgl_ModelViewMatrix\b/g, 'u_mv');
  s = s.replace(/\btexture(?:1D|2D|3D|Cube)Lod\s*\(/g, 'textureLod(');
  s = s.replace(/\btexture(?:1D|2D|3D|Cube)\s*\(/g, 'texture(');
  s = s.replace(/\bvarying\b/g, 'in');
  const head = [
    `layout(${gi}) in;`,
    `layout(${go}, max_vertices = ${mx}) out;`,
    'uniform mat4 u_mvp;', 'uniform mat4 u_mv;',
    'in vec4 gv_col0[];', 'in vec4 gv_tex0[];',
    'out vec4 v_col0;', 'out vec4 v_tex0;',
  ];
  return `${head.join('\n')}\n${s}`;
}

function glslIfdef(src) {
  if (!/^[ \t]*#[ \t]*ifdef/m.test(src)) return src;
  const out = [];
  let keep = true;
  let inIf = false;
  for (const line of src.split('\n')) {
    const m = /^[ \t]*#[ \t]*(ifdef|else|endif)[ \t]*([A-Za-z_0-9]*)/.exec(line);
    if (m !== null) {
      if (m[1] === 'ifdef') { inIf = true; keep = GLSL_HAVE.has(m[2]); }
      else if (m[1] === 'else' && inIf) keep = !keep;
      else if (m[1] === 'endif') { inIf = false; keep = true; }
      out.push('');
      continue;
    }
    out.push(keep ? line : '');
  }
  return out.join('\n');
}

export function glslAlign(kind, src, opt = {}) {
  /* **有几何段的脚本里，顶点段那两格跨段量要改名**（`gv_*`）：core 里同一段不能有同名的
     in 与 out，而片元段读的是 `v_col0`/`v_tex0` —— 于是链子是
     顶点 `gv_*` -> 几何 `in gv_*[]` / `out v_*` -> 片元 `in v_*`。
     `hasGeom` 是**整份脚本**的属性（段落都来自同一份文件，`glsetshader` 的配对是运行期的事，
     而翻译在编译期）：有 `@g` 的脚本里所有 v/f 都按这条链走。 */
  const gv = opt.hasGeom === true;
  const vCol = gv ? 'gv_col0' : 'v_col0';
  const vTex = gv ? 'gv_tex0' : 'v_tex0';
  if (kind === 'geom') return glslGeom(src, opt.geo ?? null);
  if (src.includes('#version')) return src;
  /* **ARB 汇编原样留着**（`!!ARBvp1.0` / `!!ARBfp1.0`，`ken/` 有 5 份）：它不是 GLSL，
     翻译这一层一个字都不该动它 —— 而且**不能在前头补声明**：补了之后设备那一侧就认不出
     "这是 ARB" 了（它认的是段首那个 `!!ARB`），于是把汇编喂给 GLSL 编译器，
     报 `'!' : syntax error`（踩过）。设备收到 ARB 就退回内建那对，见 §19.2。 */
  if (/^\s*!!ARB/.test(src)) return src;
  let s = glslIfdef(src);
  s = s.replace(/\bgl_TexCoord\s*\[\s*0\s*\]/g, kind === 'vert' ? vTex : 'v_tex0');
  s = s.replace(/\bgl_MultiTexCoord0\b/g, 'a_tex');
  s = s.replace(/\bftransform\s*\(\s*\)/g, '(u_mvp * a_pos)');
  s = s.replace(/\bgl_ModelViewProjectionMatrix\b/g, 'u_mvp');
  /* **法向那一格**（§18.5）：法向矩阵**不另发一份 uniform**，照定义由 `u_mv` 算
     （410 core 与 ES 300 都有 `inverse` / `transpose`）—— 少一条宿主面，
     也就不会有"与 `u_mv` 不一致"那种错。 */
  s = s.replace(/\bgl_NormalMatrix\b/g, 'mat3(transpose(inverse(u_mv)))');
  s = s.replace(/\bgl_ModelViewMatrix\b/g, 'u_mv');
  s = s.replace(/\bgl_Vertex\b/g, 'a_pos');
  /* **取样那一族**：旧式按维度分名字（`texture2D`/`texture3D`/`textureCube`/`…Lod`），
     新式一律 `texture` / `textureLod`（采样器类型自己带着维度）。语料里这四种都有
     （`texture2D` 29 次、`textureCube` 2、`texture3D` 1、`texture2DLod` 1）。 */
  s = s.replace(/\btexture(?:1D|2D|3D|Cube)Lod\s*\(/g, 'textureLod(');
  s = s.replace(/\btexture(?:1D|2D|3D|Cube)Proj\s*\(/g, 'textureProj(');
  s = s.replace(/\btexture(?:1D|2D|3D|Cube)\s*\(/g, 'texture(');
  s = s.replace(/\battribute\b/g, 'in');
  const head = [];
  if (kind === 'vert') {
    s = s.replace(/\bgl_Color\b/g, 'a_col');
    /* `gl_FrontColor` 是顶点段那格**输出**，片元段读到的就是 `gl_Color`（我们的 `v_col0`）。
       下面注入的 `v_col0 = a_col;` 在它**前面**跑，所以脚本写了就覆盖得掉 ——
       与真固定管线一致（不写就是顶点色）。 */
    s = s.replace(/\bgl_FrontColor\b/g, vCol);
    s = s.replace(/\bgl_Normal\b/g, 'a_nrm.xyz');
    s = s.replace(/\bvarying\b/g, 'out');
    /* **那两格跨段量两边都无条件声明**（`v_col0` 颜色、`v_tex0` 0 号纹理坐标）：
       一对着色器是**脚本随便配的**（`qglsetshader(0)` 拿的是"各类里第一份"，
       `tigrou/balls2k.pss` 那种一份脚本好几对的就会配出"顶点写了、片元不读"），
       而 Apple 的 GLSL 链接器把 "Output of vertex shader 'v_col0' not read by
       fragment shader" 当**链接失败**（只印 WARNING，`GL_LINK_STATUS` 却是假的 —— 踩过）。
       两边都声明就没有这一类错，而且与内建那对的形状一模一样。 */
    head.push('in vec4 a_pos;', 'in vec4 a_tex;', 'in vec4 a_col;', 'in vec4 a_nrm;',
      'uniform mat4 u_mvp;', 'uniform mat4 u_mv;', `out vec4 ${vCol};`, `out vec4 ${vTex};`);
    /* 顶点色与纹理坐标要跨段传：`gl_Color` / `gl_TexCoord[0]` 在片元里是**插值过的**那一格，
       所以顶点这边总是把 `a_col`/`a_tex` 抄过去（没人读也无害）。注入点是 main 的左花括号。 */
    s = s.replace(/void\s+main\s*\(\s*\)\s*\{/, `void main() { ${vCol} = a_col; ${vTex} = a_tex;`);
  } else {
    s = s.replace(/\bgl_Color\b/g, 'v_col0');
    s = s.replace(/\bvarying\b/g, 'in');
    s = s.replace(/\bgl_FragColor\b/g, 'o_col');
    head.push('out vec4 o_col;', 'uniform mat4 u_mvp;', 'in vec4 v_col0;', 'in vec4 v_tex0;');
  }
  return `${head.join('\n')}\n${s}`;
}

/** 这一段是不是已经对齐过了（设备那一侧用它决定要不要再翻 —— 现在两档都不必翻）。 */
export const glslAligned = (src) => /\bin vec4 a_pos;|#version/.test(src);
