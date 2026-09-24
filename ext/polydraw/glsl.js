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
export function glslAlign(kind, src) {
  if (src.includes('#version')) return src;
  let s = src;
  const usesTex0 = /gl_TexCoord\s*\[\s*0\s*\]/.test(s);
  s = s.replace(/\bgl_TexCoord\s*\[\s*0\s*\]/g, 'v_tex0');
  s = s.replace(/\bgl_MultiTexCoord0\b/g, 'a_tex');
  s = s.replace(/\bftransform\s*\(\s*\)/g, '(u_mvp * a_pos)');
  s = s.replace(/\bgl_ModelViewProjectionMatrix\b/g, 'u_mvp');
  s = s.replace(/\bgl_Vertex\b/g, 'a_pos');
  s = s.replace(/\btexture2D\s*\(/g, 'texture(');
  s = s.replace(/\battribute\b/g, 'in');
  const head = [];
  if (kind === 'vert') {
    s = s.replace(/\bgl_Color\b/g, 'a_col');
    s = s.replace(/\bvarying\b/g, 'out');
    head.push('in vec4 a_pos;', 'in vec4 a_tex;', 'in vec4 a_col;', 'uniform mat4 u_mvp;',
      'out vec4 v_col0;');
    if (usesTex0) head.push('out vec4 v_tex0;');
    /* 顶点色要跨段传：`gl_Color` 在片元里是**插值过的**那一格，所以顶点这边总是把
       `a_col` 抄进 `v_col0`（没人读也无害）。注入点是 main 的那个左花括号。 */
    s = s.replace(/void\s+main\s*\(\s*\)\s*\{/, 'void main() { v_col0 = a_col;');
  } else {
    s = s.replace(/\bgl_Color\b/g, 'v_col0');
    s = s.replace(/\bvarying\b/g, 'in');
    s = s.replace(/\bgl_FragColor\b/g, 'o_col');
    head.push('out vec4 o_col;', 'uniform mat4 u_mvp;');
    if (usesTex0) head.push('in vec4 v_tex0;');
    if (/\bv_col0\b/.test(s)) head.push('in vec4 v_col0;');
  }
  return `${head.join('\n')}\n${s}`;
}

/** 这一段是不是已经对齐过了（设备那一侧用它决定要不要再翻 —— 现在两档都不必翻）。 */
export const glslAligned = (src) => /\bin vec4 a_pos;|#version/.test(src);
