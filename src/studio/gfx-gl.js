// src/studio/gfx-gl.js —— **EVAL 两门语言的 WebGL2 设备**（浏览器这一档是默认）
//
// `docs/design/eval-realtime-gpu.md` 第 2.2 节那张表的第一行：**默认直通 WebGL**。
// CPU 光栅器（`core/host/gfx-cpu.js`）只是备选。
//
// ## 与语言那一侧的接法
//
// 语言那一侧只发 `(gfxcall "名字" 实参…)`（方言里就一格 op）；这份文件把它装成
// `globalThis.__OMNI_GFX = { call(名字, 实参数组), present(), kind: 'webgl2', … }`。
// 于是"换设备"就是换这一格全局 —— 产物一行不改。
//
// ## 一帧是怎么画的
//
// 2D 那一族（EvalDraw：`cls`/`setcol`/`setpix`/`moveto`/`lineto`/`drawsph`/`drawcone`）
// 落成**顶点**，按脚本的次序攒成几段（连着同一类的并进一段），`refresh` / 帧末**一次性**
// 上传并画 —— 一趟几个 draw call，而不是每个图元一个。这是"直通"的意思：图元变顶点，
// 光栅化交给 GPU。**分段不按类型**：2D 这一档没有深度，次序就是全部。
//
// 坐标：脚本用像素（左上角原点、y 往下），这儿换成 clip space（x/w*2-1、1-y/h*2）。
// 颜色：脚本给 0..255，这儿换成 0..1 的 float。
//
// ## 边界（明写）
//
// * GL 那一族（`glbegin`/`glvertex`/`glcolor`/矩阵栈/拆 mode/合批）**不在这一层** ——
//   它在语言那一侧（`ext/polydraw/gl-rt.js`，两门语言共用一份），交到这儿的只有顶点批
//   与几格状态（`batchprog`/`batchmvp`/`batchblend`/`gldepth`）。**只有一个模型**。
//   这一档比 CPU 备选多两样：GPU 的 z 缓冲（`gldepth`）与**可编程管线**（脚本自己那对
//   着色器：编 program、喂 uniform、常量属性）。纹理那一族还没接 —— 认不出的名字当场报。
// * 帧循环**在页面这边**（`setFrame` + `requestAnimationFrame`）：`nextframe` 在这一档
//   直接回 0，产物那条 while 一轮都不转 —— 见下面"帧循环（rAF）"那一段。
// * 输入（`mousx`/`mousy`/`bstatus`/`keystatus[256]`）接的是**真事件**（canvas 的鼠标、
//   window 的键盘）；CPU 那一档没有窗口，来源是环境变量。

/** 一格设备的状态。**一格页面一格设备**（WebGL 上下文有个位数的上限，不能一份文件一格）。 */
const D = {
  canvas: null, gl: null, prog: null, buf: null,
  w: 320, h: 240,
  col: [1, 1, 1], x: 0, y: 0,
  /* 攒着的顶点，**按脚本的次序分段**：`[{ kind:'line'|'tri', v:[x,y,r,g,b …] }, …]`。
     一段一个 draw call，连着同一类的图元并进同一段（脚本一般是"一串线、再一串圆"，
     所以段数很少）。**不许按类型分两批**：那样后画的线会被先画的三角形盖反过来 ——
     2D 这一档没有深度，次序就是全部（判据里踩过一次：十字被圆盖住了）。 */
  batches: [],
  fno: 0, t0: 0,
  frameFn: null, raf: 0,          /* 每帧那一格函数 + rAF 的句柄（帧循环在页面这边） */
  /* **性能那几格**（实时那一档的核心指标，`perf()` 交出去给状态栏显示）：
     `pn`/`psum` 是这一段里的帧数与耗时和（量的是"帧函数 + flush"那一截，
     不含浏览器等下一次 vsync 的空档 —— 那一截不是我们的开销）；
     `pms`/`pfps` 是上一次结算出来的两个数（每 ~0.5 秒结算一次，照 c_impl 的 view）。 */
  pn: 0, psum: 0, pms: 0, pfps: 0, pt0: 0,
  mx: 0, my: 0, bst: 0,           /* 鼠标：canvas 左上角起的像素位置 + 按键位（bit0 左/1 右/2 中） */
  keys: null,                     /* `keystatus[256]`：扫描码 -> 0/1（下面那张表把 code 换成扫描码） */
};

/**
 * **浏览器的键名 -> DOS 扫描码**（EVAL 的 `keystatus[]` 是按扫描码索引的，
 * 说明书里直接写 `keystatus[0xc8]` 那种数：`polydraw.txt:392`）。
 *
 * 只列常用那几族（方向/修饰键/字母/数字/空格回车 Esc Tab 退格）—— 表里没有的键
 * **就不记**（不瞎编号：编错了脚本会读到一格别的键，那比读不到更难查）。
 */
const SCAN = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
  Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b,
  Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15,
  KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23,
  KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29,
  ShiftLeft: 0x2a, Backslash: 0x2b,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32,
  Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36, AltLeft: 0x38, Space: 0x39,
  ArrowUp: 0xc8, ArrowLeft: 0xcb, ArrowRight: 0xcd, ArrowDown: 0xd0,
  ControlRight: 0x9d, AltRight: 0xb8,
};

const VS = `#version 300 es
in vec4 a_pos;
in vec4 a_col;
uniform vec2 u_size;
out vec3 v_col;
void main() {
  vec2 p = vec2(a_pos.x / u_size.x * 2.0 - 1.0, 1.0 - a_pos.y / u_size.y * 2.0);
  gl_Position = vec4(p, clamp(a_pos.z, -1.0, 1.0), 1.0);
  v_col = a_col.rgb;
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_col;
out vec4 o_col;
void main() { o_col = vec4(v_col, 1.0); }`;

function compile(gl, kind, src) {
  const s = gl.createShader(kind);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(`WebGL2 设备的着色器编不过：${gl.getShaderInfoLog(s)}`);
  }
  return s;
}

/** 开设备：一格 canvas + 一格 WebGL2 上下文 + 那对最简着色器。 */
function open(canvas, w, h) {
  const gl = canvas.getContext('webgl2', {
    antialias: false, preserveDrawingBuffer: true, depth: true,
  });
  if (gl === null) throw new Error('这个浏览器没有 WebGL2 —— 换 --gfx=cpu 那一档');
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`WebGL2 设备的 program 链不上：${gl.getProgramInfoLog(prog)}`);
  }
  D.canvas = canvas;
  D.gl = gl;
  D.prog = prog;
  D.buf = gl.createBuffer();
  D.w = w;
  D.h = h;
  canvas.width = w;
  canvas.height = h;
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  D.t0 = performance.now();
  installInput(canvas);
  return D;
}

/* ---------------------------------------------------------------- 输入（真事件）
 *
 * 鼠标位置按**canvas 像素**算（`getBoundingClientRect` + 缩放比），不是 client 坐标 ——
 * 预览区会被 CSS 缩放，用 client 坐标的话脚本里的点会跟手指差一截。
 *
 * 键盘挂在 `window` 上（canvas 默认拿不到焦点）；`keystatus` 那一格与说明书一致：
 * 按下写 1、松开写 0，**脚本可以自己写回 0** 去"消掉这一次按键"。
 */
function installInput(canvas) {
  const keys = [];
  for (let i = 0; i < 256; i++) keys.push(0);
  D.keys = keys;
  const at = (ev) => {
    const r = canvas.getBoundingClientRect();
    D.mx = (ev.clientX - r.left) * (D.w / (r.width || D.w));
    D.my = (ev.clientY - r.top) * (D.h / (r.height || D.h));
  };
  canvas.addEventListener('mousemove', (ev) => { at(ev); });
  canvas.addEventListener('mousedown', (ev) => {
    at(ev);
    /* `button`：0 左、1 中、2 右；`bstatus` 的位是 0 左、1 右、2 中（说明书那三行）。 */
    D.bst |= ev.button === 0 ? 1 : (ev.button === 2 ? 2 : 4);
  });
  canvas.addEventListener('mouseup', (ev) => {
    at(ev);
    D.bst &= ~(ev.button === 0 ? 1 : (ev.button === 2 ? 2 : 4));
  });
  canvas.addEventListener('contextmenu', (ev) => { ev.preventDefault(); });
  window.addEventListener('keydown', (ev) => {
    const c = SCAN[ev.code];
    if (c !== undefined) D.keys[c] = 1;
  });
  window.addEventListener('keyup', (ev) => {
    const c = SCAN[ev.code];
    if (c !== undefined) D.keys[c] = 0;
  });
}

/* ---------------------------------------------------------------- 图元 -> 顶点 */

const clamp01 = (v) => (v < 0 ? 0 : (v > 255 ? 1 : v / 255));

/**
 * **批上带的那点状态**（第四刀，`docs/design/eval-realtime-gpu.md` 9.4）。
 *
 * 语言那一侧在交批之前用三句宿主调用把它摆好：
 *   * `(gfxcall "batchprog" p)` —— `0` 内建那对（顶点是**裁剪空间**）、`≠0` 脚本挑的那格
 *     （顶点是**物体坐标**，变换交给它的顶点着色器）；
 *   * `(gfxcall "batchmvp" 列 m0 m1 m2 m3)` —— 四句一张 `u_mvp`（列主序）；
 *   * `(gfxcall "batchblend" mode)` —— `0` 走 alpha 混合、别的不透明（`glquad(mode)`）。
 *
 * `mvpVer` 是 `u_mvp` 的版本号：变了就把顶点断成另一段（uniform 是**按 draw call** 摆的）。
 */
const B = { prog: 0, mvp: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  mv: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], mvpVer: 0, blend: 1 };

/**
 * 现在该往哪一段里攒。**几样都一致才接着上一段**：图元类、深度测试、用哪格 program、
 * 那批常量属性的版本、那格 `u_mvp` 的版本、混合开着没有 —— 换了任一样就新开一段
 * （于是脚本的次序与状态都保住了）。
 *
 * `prog` 是 `null` 表示走内建那对着色器（2D 那一族）；不是 null 就是脚本自己
 * `glsetshader` 挑的那格 —— 那时顶点位置递的是**物体坐标**，变换交给它的顶点着色器
 * （`u_mvp` 由语言那一侧发的四句 `batchmvp` 给，见 `docs/design/eval-realtime-gpu.md` 9.4）。
 */
function batch(kind, prog = null, mvp = null) {
  const last = D.batches[D.batches.length - 1];
  if (last !== undefined && last.kind === kind && last.depth === G.depth
    && last.prog === prog && last.attrVer === G.attrVer
    && last.mvpVer === B.mvpVer && last.blend === B.blend
    && last.cull === G.cull) return last;
  const b = {
    kind, depth: G.depth, prog, mvp, attrVer: G.attrVer, mvpVer: B.mvpVer, blend: B.blend,
    cull: G.cull, v: [],
  };
  D.batches.push(b);
  return b;
}

/**
 * 一格顶点**十二个数**：位置 4（内建那档是屏幕 x,y,深度,1；着色器那档是物体坐标）、
 * 颜色 4、纹理坐标 4。一种布局管两条路 —— 两种布局就是两份 `flush`。
 */
const push = (b, x, y) => {
  b.v.push(x, y, 0, 1, D.col[0], D.col[1], D.col[2], 1, 0, 0, 0, 1);
};

/** 一段线（两个顶点）。 */
function seg(x0, y0, x1, y1) {
  const b = batch('line');
  push(b, x0, y0);
  push(b, x1, y1);
}

/** 一格三角形。 */
function tri(x0, y0, x1, y1, x2, y2) {
  const b = batch('tri');
  push(b, x0, y0);
  push(b, x1, y1);
  push(b, x2, y2);
}

/** 圆的段数：半径越大分得越细（32 段在 320×240 上已经看不出棱）。 */
const segsOf = (r) => Math.max(8, Math.min(64, Math.ceil(Math.abs(r) * 1.2)));

/** 填充圆：三角扇（GPU 上就是几十个三角形，不是逐像素算半弦长）。 */
function disc(cx, cy, r) {
  const n = segsOf(r);
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    tri(cx, cy, cx + Math.cos(a0) * r, cy + Math.sin(a0) * r,
      cx + Math.cos(a1) * r, cy + Math.sin(a1) * r);
  }
}

/** 描边圆：线环。 */
function ring(cx, cy, r) {
  const n = segsOf(r);
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    seg(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r,
      cx + Math.cos(a1) * r, cy + Math.sin(a1) * r);
  }
}

/**
 * `drawcone(x,y,r,x2,y2,r2)`：粗线 —— 两端的圆 + 中间那条公切的四边形（两个三角形）。
 * 这比 CPU 那一档"沿线铺圆"省得多（几十个三角形 vs 每像素一次判断），形状也更干净。
 */
function cone(x0, y0, r0, x1, y1, r1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) { disc(x0, y0, Math.max(r0, r1)); return; }
  const nx = -dy / len;
  const ny = dx / len;
  tri(x0 + nx * r0, y0 + ny * r0, x0 - nx * r0, y0 - ny * r0, x1 + nx * r1, y1 + ny * r1);
  tri(x1 + nx * r1, y1 + ny * r1, x0 - nx * r0, y0 - ny * r0, x1 - nx * r1, y1 - ny * r1);
  disc(x0, y0, r0);
  disc(x1, y1, r1);
}

/**
 * 把攒着的顶点画出去（**按脚本的次序**，一段一个 draw call）。
 *
 * 一段用哪格 program 由这一段自己说（`b.prog`）：`null` 是内建那对（2D 与固定管线，
 * 顶点是屏幕坐标、`u_size` 换 clip space），不是 null 就是脚本挑的那格
 * （顶点是物体坐标、`u_mvp` 是那一刻的两个矩阵的积）。
 */
function flush() {
  const gl = D.gl;
  if (gl === null) return;
  const ST = 64;                    /* 一格顶点 16 个 float（位置/颜色/纹理坐标/法向） */
  for (const b of D.batches) {
    if (b.v.length === 0) continue;
    const prog = b.prog === null ? D.prog : b.prog;
    gl.useProgram(prog);
    if (b.prog === null) {
      gl.uniform2f(gl.getUniformLocation(prog, 'u_size'), D.w, D.h);
    } else {
      const mvp = gl.getUniformLocation(prog, 'u_mvp');
      if (mvp !== null) gl.uniformMatrix4fv(mvp, false, new Float32Array(b.mvp));
      /* `u_mv` 是模型视图那一格（`gl_ModelViewMatrix` / `gl_NormalMatrix` 用它）。 */
      const mvloc = gl.getUniformLocation(prog, 'u_mv');
      if (mvloc !== null) gl.uniformMatrix4fv(mvloc, false, new Float32Array(b.mv));
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, D.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(b.v), gl.STREAM_DRAW);
    for (const [nm2, size, off] of [['a_pos', 4, 0], ['a_col', 4, 16], ['a_tex', 4, 32],
      ['a_nrm', 4, 48]]) {
      const loc = gl.getAttribLocation(prog, nm2);
      if (loc < 0) continue;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, ST, off);
    }
    /* `glVertexAttrib*` 设的那几格是**常量属性**（数组关着时 GL 用的就是当前值）——
       所以在这儿一次性摆上。值变过就已经断成另一段了（见 `batch`）。 */
    for (const [loc, val] of G.attrs) {
      if (loc >= 0) { gl.disableVertexAttribArray(loc); gl.vertexAttrib4f(loc, ...val); }
    }
    if (b.depth) gl.enable(gl.DEPTH_TEST);
    else gl.disable(gl.DEPTH_TEST);
    /* 面剔除（语言那一侧的 `glcull`）：**正面是 CW** —— 照正本
       `polydraw_src/polydraw.c:1605` 的 `kglCullFace`（不是 GL 默认的 CCW）。 */
    if (b.cull === 1 || b.cull === 2) {
      gl.enable(gl.CULL_FACE);
      gl.frontFace(gl.CW);
      gl.cullFace(b.cull === 2 ? gl.FRONT : gl.BACK);
    } else {
      gl.disable(gl.CULL_FACE);
    }
    /* 混合：`glquad(0)` 那一档要 alpha 混合（语言那一侧发的 `batchblend`）。 */
    if (b.blend === 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.disable(gl.BLEND);
    }
    gl.drawArrays(b.kind === 'tri' ? gl.TRIANGLES : gl.LINES, 0, b.v.length / 16);
  }
  gl.disable(gl.BLEND);
  D.batches.length = 0;
}

/* ------------------------------------------------- GL 那一族在这一层剩下的东西
 *
 * **只有一个模型**（`docs/design/eval-realtime-gpu.md` 第 9 节）：`glBegin`/`glVertex`/
 * `glColor`/矩阵栈/拆 mode/合批**全在语言那一侧**（`ext/polydraw/gl-rt.js`，两门语言
 * 共用一份），交到设备手里的只有顶点批（`(gfxbatch …)`）与几格状态。
 *
 * 所以这一层只留三样 GL 的东西：**深度测试**（GPU 的 z 缓冲，只有设备做得到）、
 * **常量属性**（`glVertexAttrib*` 是按 draw call 摆的）、**program 与 uniform**（下一节）。
 * 从前那两百来行（`glVertex`/`glEnd`/`glXf`/`mvMul`/`mvpNow`/`frameBegin`/矩阵栈）
 * 是第二份模型，2026-09-24 第四刀连着 EvalDraw 那张表一起切过去之后整段删掉了。
 */
const G = {
  depth: false,                   /* 深度测试开着没有（语言那一侧的 `gldepth` 转过来的） */
  cull: 0,                        /* 面剔除：0 关 / 1 剔背面 / 2 剔正面（`glcull`） */
  /* `glVertexAttrib*` 设的那几格**常量属性**：位置 -> 四个数。`attrVer` 是它的版本号 ——
     值一变就把顶点断成另一段（常量属性是**按 draw call** 摆的，段里不能变）。 */
  attrs: new Map(), attrVer: 0,
};

const ident = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/* ---------------------------------------------------------------- 可编程管线
 *
 * `.pss` 的后半是 `@v` / `@f` / `@g` 区段（GLSL 原文）。语言那一侧把它们**原样**交到
 * 这儿（方言的 `(gfxdef 种类 名字 内容)`），运行期的 `glsetshader(名字下标…)` 再按名字挑。
 *
 * ## 原文在**编译期**就翻好了
 *
 * PolyDraw 跑的是真 OpenGL 1.x/2.x，脚本里的着色器是**旧式 GLSL**（`ftransform()`、
 * `gl_FragColor`、`attribute`/`varying`）。翻成对齐后的 GLSL 那一步在
 * `ext/polydraw/glsl.js`（adapter 在 `(gfxdef …)` 发出去之前调它）—— 于是这一档与本机
 * OpenGL 那一档收到的是**同一份文本**，各自只补一行 `#version`（见 `toEs300`）。
 * 口径：`docs/design/eval-realtime-gpu.md` 13.2（**必须与 WebGL 对齐，不许两种模型**）。
 */
const SH = {
  /**
   * `"种类|名字"` -> `{ kind: 'vert'|'frag'|'geom', text }`（`(gfxdef …)` 登记进来的）。
   *
   * **键里必须带种类**：`.pss` 里 `@v:drawsph` 与 `@f:drawsph` **同名是常态**
   * （`tigrou/balls2k.pss` 就是 `glsetshader("drawsph","drawsph")`）—— 只按名字存的话
   * 后登记的那份把前一份覆盖掉，顶点与片元拿到同一份，编出来是
   * `gl_Position 未声明` 那种错（本机那一档踩过，见 §17.5）。
   */
  src: new Map(),
  /** 下标 -> 串（`glsetshader("vert",…)` 那种名字在方言里是下标 —— 见 `gfxdef` 的头注）。 */
  names: new Map(),
  /** `"顶点名|片元名"` -> 已经链好的 program（编一次，之后每帧复用）。 */
  progs: new Map(),
  cur: null,                      /* 现在挑着的那格 program（`glsetshader` 设、批带着用） */
};

/** 登记一格有名字的串（着色器原文 / 名字表）。 */
function def(kind, name, text) {
  if (kind === 'name') { SH.names.set(String(name), text); return 0; }
  if (kind === 'vert' || kind === 'frag' || kind === 'geom') {
    SH.src.set(`${kind}|${name}`, { kind, text });
    return 0;
  }
  throw new Error(`(gfxdef …) 不认识的种类 '${kind}'（要 vert/frag/geom/name）`);
}

/** 第一份某一类的着色器（脚本没调 `glsetshader` 时的默认那一对）。 */
function firstOf(kind) {
  for (const s of SH.src.values()) if (s.kind === kind) return s;
  return null;
}

/** 某一类里**第 n 份**（旧式 `glsetshader(0)` 那一档的口径 —— 不是全表下标）。 */
function nthOf(kind, n) {
  let k = 0;
  for (const s of SH.src.values()) {
    if (s.kind !== kind) continue;
    if (k === n) return s;
    k++;
  }
  return null;
}

/** 这一类里叫这个名字的那份（没有回 null）。 */
const shOf = (kind, name) => SH.src.get(`${kind}|${name}`) ?? null;

/**
 * **只补那一两行头**（`#version 300 es` + precision）。
 *
 * 翻译**不在这儿**：旧式 GLSL 在**编译期**就翻成对齐后的主体了（`ext/polydraw/glsl.js`
 * 的 `glslAlign`，adapter 在 `(gfxdef …)` 发出去之前调它）—— 于是这一档与本机那一档
 * 收到的是**同一份文本**，差的只有这一两行头（本机那一档补 `#version 410 core`）。
 * 口径：`docs/design/eval-realtime-gpu.md` 13.2（**必须与 WebGL 对齐，不许两种模型**）。
 *
 * 脚本自带 `#version` 的就原样递下去（它自己写好了新式的，不动它）。
 */
function toEs300(kind, src) {
  if (src.includes('#version')) return src;
  return `#version 300 es\nprecision highp float;\n${src}`;
}

/** 这一段原文是**ARB 汇编**（`!!ARBvp1.0` / `!!ARBfp1.0`）不是 GLSL 吗？见 §19.2。 */
const isArb = (s) => /^\s*!!ARB/.test(s);

/**
 * **ARB 汇编那一档退回的那一对**（固定管线那点事：`u_mvp * a_pos` + 顶点色）。
 * 与本机那一档 `omni_ev_gl.c` 的 `VS_SRC`/`FS_SRC` 逐句对应（差 `#version` 那一行）——
 * 不能拿这一层的 `VS`/`FS`：那一对收的是**屏幕坐标**，而挑过 program 的批是**物体坐标**。
 */
const ARB_FALLBACK = {
  vert: {
    kind: 'vert',
    text: 'in vec4 a_pos;\nin vec4 a_col;\nin vec4 a_tex;\nuniform mat4 u_mvp;\n'
      + 'out vec4 v_col0;\nout vec4 v_tex0;\n'
      + 'void main() { v_col0 = a_col; v_tex0 = a_tex; gl_Position = u_mvp * a_pos; }',
  },
  frag: {
    kind: 'frag',
    text: 'in vec4 v_col0;\nin vec4 v_tex0;\nout vec4 o_col;\n'
      + 'void main() { o_col = v_col0; }',
  },
};

/**
 * 挑一对着色器、编好链好（编一次）。两个实参是 `SH.src` 里那两份**记录**。
 *
 * **ARB 汇编那一档退回内建那对**（`ken/*_asm.pss` 那 5 份）：WebGL 没有 ARB 汇编，
 * 参考实现（`c_impl/src/render/gl_renderer.c:1131`）编不过时也是留着内建那格 ——
 * 只认 `!!ARB` 这一个特征，不做"编不过就悄悄退"（那会把我们自己的 GLSL bug 藏起来）。
 */
function useProgram(v, f) {
  const gl = D.gl;
  if (v === null || f === null) {
    throw new Error('glsetshader：没有这一对着色器 ——'
      + ` 登记进来的是 ${[...SH.src.keys()].map((k) => JSON.stringify(k)).join(' ')}`
      + '（`.pss` 里要有 @v / @f 区段）');
  }
  if (isArb(v.text) || isArb(f.text)) return useProgram(ARB_FALLBACK.vert, ARB_FALLBACK.frag);
  const key = `${v.kind}|${v.text.length}|${f.kind}|${f.text.length}|${v.text}|${f.text}`;
  const had = SH.progs.get(key);
  if (had !== undefined) { SH.cur = had; return had; }
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, toEs300('vert', v.text)));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, toEs300('frag', f.text)));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`glsetshader：program 链不上：${gl.getProgramInfoLog(p)}`);
  }
  SH.progs.set(key, p);
  SH.cur = p;
  /* **采样器按名字约定接单元**：`tex0..tex7` 那几个 uniform 设成 0..7 号纹理单元。
     PolyDraw 的脚本就是 `glactivetexture(GL_TEXTURE0+i); glbindtexture(i)` 加片元里
     `uniform sampler2D tex0, tex1, tex2` —— 除了这个名字约定没有别的绑定办法
     （`docs/design/eval-realtime-gpu.md` 第 11.2 节）。 */
  gl.useProgram(p);
  for (let i = 0; i < 8; i++) {
    const loc = gl.getUniformLocation(p, `tex${i}`);
    if (loc !== null) gl.uniform1i(loc, i);
  }
  return p;
}

/** `glsetshader(…)`：实参是**名字表的下标**（见 `gfxdef`）；旧式的数字那一档按序号取。 */
function setShader(args) {
  /* **负下标 = "第一对"**（语言那一侧的 `gl_quad` 在脚本没挑过 program 时发的那句 ——
     `glquad` 在 PolyDraw 里本来就默认拿 `@v`/`@f` 那一对）。 */
  if (args.length === 1 && Math.trunc(Number(args[0])) < 0) {
    const v = firstOf('vert');
    const f = firstOf('frag');
    if (v === null || f === null) {
      throw new Error('glquad：还没有着色器 —— `.pss` 里要有 @v 与 @f 区段'
        + '（或者先 glsetshader(…) 挑一对）');
    }
    useProgram(v, f);
    return 0;
  }
  /* 一格实参 -> 那一类里的哪一份：名字表里有就按名字找，没有就按**这一类里第几份**
     （旧式 `glsetshader(0)` 的口径 —— **不是全表下标**：那样会把片元指到 `@v` 那份上去，
     本机那一档踩过，见 §17.5）。越界夹成第 0 份。 */
  const shAt = (i, kind) => {
    const k = String(Math.trunc(Number(args[i])));
    const nm = SH.names.get(k);
    if (nm !== undefined) {
      const byName = shOf(kind, nm);
      if (byName !== null) return byName;
    }
    return nthOf(kind, Math.trunc(Number(args[i]))) ?? firstOf(kind);
  };
  if (args.length === 1) {
    /* **一格实参那一档不查名字表**：原版那儿是个整数（`GLSETSHADER()`），而方言把串换成了
       名字表下标 —— 两者的数字空间是重的，查名字表会撞上"第 0 个内部到的串"，
       于是配出不相干的一对（本机那一档踩过，见 §17.5 那一格的补注）。 */
    useProgram(firstOf('vert'), nthOf('frag', Math.trunc(Number(args[0]))) ?? firstOf('frag'));
    return 0;
  }
  const f = args.length >= 3 ? shAt(2, 'frag') : shAt(1, 'frag');
  useProgram(shAt(0, 'vert'), f);
  return 0;
}

/* `glquad(mode)` 那一格**不在这一层**：满屏四边形的六个顶点在语言那一侧造
   （`ext/polydraw/gl-rt.js` 的 `gl_quad` —— 位置就是 NDC、`u_mvp` 是单位矩阵、
   混合由 `batchblend` 说）。设备自己再造一份满屏几何就是第二个模型了。 */

/* ---------------------------------------------------------------- 纹理那一族
 *
 * `(gfxtex 槽 宽 高 层 格 数组)` -> `texImage2D`（`docs/design/eval-realtime-gpu.md`
 * 第 11 节）。**槽是脚本自己编号的**（`glbindtexture(槽)` 用的就是它）。
 *
 * `格` 是 `KGL_*` 那个打包好的数：低 4 位像素格式、`0xf0` 过滤、`0xf00` 环绕
 * （`polydraw.c:190-193`）。三格与真 GL 的差别写在下面各自那一句里 —— 最大的一格是
 * **BGRA 在 WebGL 里没有**，所以 `KGL_BGRA32` 在上传前换成 RGBA（格式转换是设备的事）。
 */
const TX = {
  /** 槽 -> `{ id: WebGLTexture, w, h, fmt }`。 */
  slots: new Map(),
  /** 现在的纹理单元（`glactivetexture(GL_TEXTURE0+i)`）。 */
  unit: 0,
};

/** 这一槽的那格 GL 纹理（没有就造一格）。 */
function texOf(slot) {
  let t = TX.slots.get(slot);
  if (t === undefined) {
    t = { id: D.gl.createTexture(), w: 0, h: 0, fmt: 0 };
    TX.slots.set(slot, t);
  }
  return t;
}

/** 过滤与环绕那两段位（`0xf0` / `0xf00`）-> GL 的参数。 */
function texParams(fmt) {
  const gl = D.gl;
  const filt = fmt & 0xf0;
  const wrap = fmt & 0xf00;
  const mip = filt >= 0x20;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER,
    filt === 0x10 ? gl.NEAREST : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
    mip ? gl.LINEAR_MIPMAP_LINEAR : (filt === 0x10 ? gl.NEAREST : gl.LINEAR));
  const w = wrap === 0x100 ? gl.MIRRORED_REPEAT
    : (wrap === 0 ? gl.REPEAT : gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, w);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, w);
  return mip;
}

function texIn(slot, w, h, d, fmt, px) {
  const gl = D.gl;
  if (gl === null) return 0;
  if (d !== 1) {
    throw new Error(`gfxtex：这一档只接 2D 纹理（层 = ${d}）—— 3D 纹理（GLSETTEX 六实参`
      + '那一档）在 WebGL2 上要 TEXTURE_3D，还没接');
  }
  /* 纹理是**按 draw call 的状态**：攒着的批要先画掉，不然它们会拿到新图。 */
  flush();
  const kind = fmt & 15;
  const t = texOf(slot);
  gl.activeTexture(gl.TEXTURE0 + TX.unit);
  gl.bindTexture(gl.TEXTURE_2D, t.id);
  const n = w * h;
  if (kind === 0) {
    /* `KGL_BGRA32`：一格 double 是一格打包好的像素（与 `rgb()` 回的那种数同一形）。
       WebGL 没有 BGRA，所以这儿摊成 RGBA。高 8 位有值就当 alpha，没有就是不透明
       （脚本里最常见的是 `0xRRGGBB` 那种三分量的数）。 */
    const b = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const v = Math.trunc(px[i]) >>> 0;
      b[i * 4] = (v >> 16) & 255;
      b[i * 4 + 1] = (v >> 8) & 255;
      b[i * 4 + 2] = v & 255;
      const al = (v >>> 24) & 255;
      b[i * 4 + 3] = al === 0 ? 255 : al;
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, b);
  } else if (kind === 1) {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = Math.max(0, Math.min(255, Math.trunc(px[i])));
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, b);
  } else if (kind === 4) {
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = px[i];
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, f);
  } else if (kind === 5) {
    const f = new Float32Array(n * 4);
    for (let i = 0; i < n * 4; i++) f[i] = px[i];
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, f);
  } else {
    throw new Error(`gfxtex：这一档没接 KGL 格式 ${kind}（KGL_SHORT/KGL_INT）——`
      + ' 有的是 BGRA32(0) / CHAR(1) / FLOAT(4) / VEC4(5)');
  }
  if (texParams(fmt)) gl.generateMipmap(gl.TEXTURE_2D);
  t.w = w;
  t.h = h;
  t.fmt = fmt;
  return 0;
}

/** `glgetuniformloc(名字下标)` -> 一格句柄。句柄就是"第几个"（我们自己的编号）。 */
const UNI = { list: [], byProg: new Map() };
function uniLoc(idx) {
  const nm = SH.names.get(String(Math.trunc(idx)));
  if (nm === undefined) throw new Error(`glgetuniformloc：名字表里没有下标 ${idx}`);
  if (SH.cur === null) {
    const v = firstOf('vert');
    const f = firstOf('frag');
    if (v === null || f === null) {
      throw new Error('glgetuniformloc：还没有着色器 —— `.pss` 里要有 @v 与 @f 区段');
    }
    useProgram(v, f);
  }
  /* 句柄是**按 program 记**的（同一个名字在两份 program 里是两格位置）。 */
  let per = UNI.byProg.get(SH.cur);
  if (per === undefined) { per = new Map(); UNI.byProg.set(SH.cur, per); }
  const had = per.get(nm);
  if (had !== undefined) return had;
  const loc = D.gl.getUniformLocation(SH.cur, nm);
  UNI.list.push({ prog: SH.cur, loc });
  const h = UNI.list.length - 1;
  per.set(nm, h);
  return h;
}

/** `gluniform{1,2,3,4}f(句柄, …)`。句柄不认（着色器里没这个名字）就**当场报**。 */
function uniSet(h, vals) {
  const e = UNI.list[Math.trunc(h)];
  if (e === undefined) throw new Error(`gluniform：没有这格句柄 ${h}（glgetuniformloc 回的才算）`);
  if (e.loc === null) return 0;    /* 着色器里没用到那个 uniform —— GL 那边也是静默 */
  const gl = D.gl;
  gl.useProgram(e.prog);
  if (vals.length === 1) gl.uniform1f(e.loc, vals[0]);
  else if (vals.length === 2) gl.uniform2f(e.loc, vals[0], vals[1]);
  else if (vals.length === 3) gl.uniform3f(e.loc, vals[0], vals[1], vals[2]);
  else gl.uniform4f(e.loc, vals[0], vals[1], vals[2], vals[3]);
  return 0;
}

/** `glgetattribloc(名字下标)` -> 属性在当前 program 里的位置（直接就是 GL 的那个号）。 */
function attrLoc(idx) {
  const nm = SH.names.get(String(Math.trunc(idx)));
  if (nm === undefined) throw new Error(`glgetattribloc：名字表里没有下标 ${idx}`);
  if (SH.cur === null) {
    const v = firstOf('vert');
    const f = firstOf('frag');
    if (v === null || f === null) {
      throw new Error('glgetattribloc：还没有着色器 —— `.pss` 里要有 @v 与 @f 区段');
    }
    useProgram(v, f);
  }
  return D.gl.getAttribLocation(SH.cur, nm);
}

/** `glvertexattrib*f(位置, …)`：记下那格**常量属性**的值（变了就把顶点断成另一段）。 */
function attrSet(loc, val) {
  const k = Math.trunc(loc);
  const had = G.attrs.get(k);
  if (had !== undefined && had.every((v, i) => v === val[i])) return 0;
  G.attrs.set(k, val);
  G.attrVer += 1;
  return 0;
}

/* ---------------------------------------------------------------- 那张名字表 */

/**
 * **一格宿主调用**（名字 + 一串 double，回一个 double）。认不出的名字**当场炸**，
 * 并说清这一格设备有哪些名字 —— 不许静默回 0（那是"图不对但没人知道"的来源）。
 */
function call(name, args) {
  const gl = D.gl;
  const a = (i) => Number(args[i] ?? 0);
  switch (`${name}/${args.length}`) {
    case 'cls/3':
      flush();                                  /* 先把攒着的画掉，再清 —— 次序与脚本一致 */
      gl.clearColor(clamp01(a(0)), clamp01(a(1)), clamp01(a(2)), 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return 0;
    /* `cls(打包好的颜色)`：EvalDraw 里最常见的那个写法（`cls(0)`）。 */
    case 'cls/1': {
      flush();
      const v = Math.trunc(a(0)) & 0xffffff;
      gl.clearColor(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return 0;
    }
    case 'setcol/3': D.col = [clamp01(a(0)), clamp01(a(1)), clamp01(a(2))]; return 0;
    case 'setcol/1': {
      const v = Math.trunc(a(0)) & 0xffffff;
      D.col = [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
      return 0;
    }
    /* 一格像素 = 一格 1×1 的四边形（`GL_POINTS` 的点大小在 WebGL 里不可靠）。 */
    case 'setpix/2':
      tri(a(0), a(1), a(0) + 1, a(1), a(0), a(1) + 1);
      tri(a(0) + 1, a(1), a(0), a(1) + 1, a(0) + 1, a(1) + 1);
      return 0;
    case 'moveto/2': D.x = a(0); D.y = a(1); return 0;
    case 'lineto/2': seg(D.x, D.y, a(0), a(1)); D.x = a(0); D.y = a(1); return 0;
    /* `drawsph(x,y,r)`：半径为负是描边（`evaldraw_ref.md`）。 */
    case 'drawsph/3':
      if (a(2) < 0) ring(a(0), a(1), -a(2));
      else disc(a(0), a(1), a(2));
      return 0;
    case 'drawcone/6': cone(a(0), a(1), a(2), a(3), a(4), a(5)); return 0;
    case 'rgb/3':
      return Math.round(Math.min(255, Math.max(0, a(0)))) * 65536
        + Math.round(Math.min(255, Math.max(0, a(1)))) * 256
        + Math.round(Math.min(255, Math.max(0, a(2))));
    /* `refresh()`：把这一帧交出去 —— 这一档就是画掉攒着的顶点（canvas 上就看见了）。 */
    case 'refresh/0': flush(); return 0;
    /**
     * `nextframe`：**这一档一帧都不放过去**（直接回 0）。理由：浏览器里产物是在主线程
     * 同步跑的，`while` 会把页面卡死 —— 所以帧循环交给
     * `requestAnimationFrame`（`setFrame` 那一格），产物那条 while 一轮都不转。
     */
    case 'nextframe/0': flush(); return 0;
    case 'numframes/0': return D.fno > 0 ? D.fno - 1 : 0;
    case 'klock/0': return (performance.now() - D.t0) / 1000;
    /* `FRAMEINIT`（见 CPU 备选那一份的注）：第一帧 1、之后 0。 */
    case 'frameinit/0': return D.fno <= 1 ? 1 : 0;
    /* `getpix(x,y)`：这一档要从 GPU 读回一格像素 —— 每格一次 `readPixels` 太贵，
       所以**明着拒**（`gethlin` 那一族在这一档没有落点，CPU 备选那一档有）。 */
    case 'xres/0': return D.w;
    case 'yres/0': return D.h;
    /* ── 输入那一族。位置是 canvas 像素，`bstatus`/`keystatus` 脚本写得动（消一次点击）。 */
    case 'mousx/0': return D.mx;
    case 'mousy/0': return D.my;
    case 'bstatus/0': return D.bst;
    case 'setbstatus/1': D.bst = Math.trunc(a(0)); return 0;
    case 'keystatus/1': {
      const k = Math.trunc(a(0));
      return k >= 0 && k < 256 ? D.keys[k] : 0;
    }
    case 'setkeystatus/2': {
      const k = Math.trunc(a(0));
      if (k >= 0 && k < 256) D.keys[k] = a(1);
      return 0;
    }
    /* ── GL 那一族在这一层剩下的几格。**立即模式与矩阵栈不在这儿**（那是语言那一侧的
       `ext/polydraw/gl-rt.js`，两门语言共用一份）—— 见 `G` 的头注"只有一个模型"。 */
    /* **深度测试那一格设备状态**（语言那一侧的 `gl_enable(GL_DEPTH_TEST)` 转过来的 ——
       GL 的状态机在语言那一侧，"开不开 z 缓冲"这件事只有设备做得到）。 */
    case 'gldepth/1': G.depth = Math.trunc(a(0)) !== 0; return 0;
    case 'glcull/1': {
      const m = Math.trunc(a(0));
      G.cull = (m === 1 || m === 2) ? m : 0;
      return 0;
    }
    /* ── **批上带的那点状态**（第四刀，见 `B` 的头注）。 */
    case 'batchprog/1':
      B.prog = Math.trunc(a(0));
      return 0;
    case 'batchmvp/5': {
      const c = Math.trunc(a(0)) & 3;
      for (let k = 0; k < 4; k++) B.mvp[c * 4 + k] = a(1 + k);
      /* 版本号一动，下一段顶点就不会并进上一段（uniform 是按 draw call 摆的）。 */
      B.mvpVer += 1;
      return 0;
    }
    /* 模型视图那一格（`u_mv`）—— 与上一格逐字同形，见 §18.4。 */
    case 'batchmv/5': {
      const c = Math.trunc(a(0)) & 3;
      for (let k = 0; k < 4; k++) B.mv[c * 4 + k] = a(1 + k);
      B.mvpVer += 1;
      return 0;
    }
    case 'batchblend/1': B.blend = Math.trunc(a(0)); return 0;
    /* ── 纹理那一族（见 `TX` 的头注）。挑单元 / 挑槽都是**按 draw call 的状态** ——
       语言那一侧已经先 `gl_flush()` 了（`gl_bindtex`/`gl_activetex`）。 */
    case 'glactivetexture/1': {
      /* 实参是 `GL_TEXTURE0+i`（0x84c0 起）；脚本偶尔直接写小整数，两种都收。 */
      const v = Math.trunc(a(0));
      TX.unit = v >= 0x84c0 ? v - 0x84c0 : v;
      if (TX.unit < 0 || TX.unit > 7) throw new Error(`glactivetexture：单元 ${TX.unit} 出界（0..7）`);
      return 0;
    }
    case 'glbindtexture/1': {
      const slot = Math.trunc(a(0));
      const t = TX.slots.get(slot);
      gl.activeTexture(gl.TEXTURE0 + TX.unit);
      /* 还没设过内容的槽：绑一格空的（与 PolyDraw 一样不报 —— 画出来是黑的）。 */
      gl.bindTexture(gl.TEXTURE_2D, t === undefined ? texOf(slot).id : t.id);
      return 0;
    }
    /* 收下但不管的那几格（光照/混合/剔除/线宽）。 */
    case 'glnormal/3':
    case 'glcullface/1':
    case 'gllinewidth/1':
    case 'glswapinterval/1':
    case 'glblendfunc/2':
    case 'glalphaenable/1':
    case 'glalphadisable/1':
      return 0;
    /* ── 可编程管线那一族。名字在方言里是**名字表的下标**（见 `gfxdef` 的头注）。 */
    case 'glsetshader/1':
    case 'glsetshader/2':
    case 'glsetshader/3':
      return setShader(args.map((v) => Number(v)));
    case 'glgetuniformloc/1': return uniLoc(a(0));
    case 'gluniform1f/2': return uniSet(a(0), [a(1)]);
    case 'gluniform2f/3': return uniSet(a(0), [a(1), a(2)]);
    case 'gluniform3f/4': return uniSet(a(0), [a(1), a(2), a(3)]);
    case 'gluniform4f/5': return uniSet(a(0), [a(1), a(2), a(3), a(4)]);
    /* `gluniform(句柄, 值)` / `gluniform(句柄, 个数, 数组)`：说明书里是同一个名字两种元数。
       数组那一档要一格数组实参 —— 宿主面只收 double，所以**明着拒**。 */
    case 'gluniform/2': return uniSet(a(0), [a(1)]);
    /* `glgetattribloc(名字下标)` / `glvertexattrib{1,2,3,4}f(句柄, …)`：
       **常量属性**那一档（数组关着时 GL 用的就是当前值）。逐顶点变的那一档没接 ——
       我们这儿顶点是攒成一批画的，要逐顶点得给顶点布局再加一格，记在这儿。 */
    case 'glgetattribloc/1': return attrLoc(a(0));
    case 'glvertexattrib1f/2': return attrSet(a(0), [a(1), 0, 0, 1]);
    case 'glvertexattrib2f/3': return attrSet(a(0), [a(1), a(2), 0, 1]);
    case 'glvertexattrib3f/4': return attrSet(a(0), [a(1), a(2), a(3), 1]);
    case 'glvertexattrib4f/5': return attrSet(a(0), [a(1), a(2), a(3), a(4)]);
    default:
      throw new Error(`这格设备（WebGL2）上没有 '${name}'（${args.length} 个实参）——`
        + ' 2D 那一族是 cls/setcol/setpix/moveto/lineto/drawsph/drawcone/rgb/refresh，'
        + ' 宿主量是 nextframe/numframes/klock/xres/yres/mousx/mousy/bstatus/keystatus，'
        + ' 批与它的状态是 (gfxbatch …)/batchprog/batchmvp/batchblend/gldepth，'
        + ' 可编程管线是 glsetshader/glgetuniformloc/gluniform*/glgetattribloc/glvertexattrib*，'
        + ' 纹理是 (gfxtex …)/glbindtexture/glactivetexture（文件那一档还没接：glsettex("x.png")）；'
        + ' **GL 立即模式与矩阵栈不在设备这一层**（在语言那一侧的 ext/polydraw/gl-rt.js，'
        + '只有一个模型）');
  }
}

/* ---------------------------------------------------------------- 帧循环（rAF）
 *
 * 浏览器这一档的帧循环**在页面这边**：产物把"每帧那一格函数"交过来
 * （方言的 `(gfxframefn …)` → `$gfx_frame_fn` → 这儿的 `setFrame`），
 * 我们用 `requestAnimationFrame` 反复调它 —— 每帧之间让出控制权，页面不卡。
 *
 * 一帧里干三件事：帧号加一（脚本读到的 `numframes` 就是它减一）、调那格函数、`flush`。
 * 函数里抛了就**停下并把话留在控制台上** —— 不许一帧错一次地刷下去（那会把控制台灌满，
 * 而真浏览器那条判据判的正是"控制台一条错都没有"）。
 */
function setFrame(f) {
  if (typeof f !== 'function') return;
  D.frameFn = f;
  if (D.raf !== 0) return;
  const tick = () => {
    D.raf = 0;
    D.fno += 1;
    const t = performance.now();
    if (D.pt0 === 0) D.pt0 = t;
    try {
      D.frameFn();
    } catch (e) {
      console.error('EVAL 的帧函数抛了，帧循环停下：', e);
      return;
    }
    flush();
    /* 性能账：这一帧我们花了多少、每 ~0.5 秒结算一次 fps（用的是**墙上时间**，
       所以 fps 反映的是真正刷了几帧，而不是 1000/每帧耗时那个上限）。 */
    D.psum += performance.now() - t;
    D.pn += 1;
    const span = performance.now() - D.pt0;
    if (span >= 500) {
      D.pfps = (D.pn * 1000) / span;
      D.pms = D.psum / D.pn;
      D.pn = 0;
      D.psum = 0;
      D.pt0 = performance.now();
    }
    D.raf = requestAnimationFrame(tick);
  };
  D.raf = requestAnimationFrame(tick);
}

/**
 * 这一档的**性能账**（状态栏显示它，与 CLI 的 `--perf` 是同一组数）：
 * `fps` 是每秒真刷了几帧，`ms` 是一帧里**我们**花的时间（帧函数 + 上传 + draw call）。
 * 还没攒够半秒时 `fps` 是 0 —— 调用方那时就别显示。
 */
function perf() {
  return { fps: D.pfps, ms: D.pms, frames: D.fno, live: D.raf !== 0 };
}

/** 停掉帧循环（换文件、判据收尾都要它 —— 不停的话上一份脚本会一直在画）。 */
function stop() {
  if (D.raf !== 0) cancelAnimationFrame(D.raf);
  D.raf = 0;
}

/**
 * **手动走一帧**（判据用）：停掉 rAF 之后造几个事件，再走一帧 —— 于是"这一帧里
 * 输入是什么"是确定的。`bstatus--` / `keystatus[k]=0` 那种"消掉一次"的写法只在
 * 紧接着的那一帧成立，用 rAF 连着跑是判不住的（帧号会在造事件的时候往前走）。
 */
function step() {
  if (typeof D.frameFn !== 'function') return 0;
  D.fno += 1;
  D.frameFn();
  flush();
  return D.fno;
}

/**
 * **重开一趟**（同一格设备接着跑下一份脚本时要它）：停掉帧循环、清掉攒着的顶点、
 * 2D 与 GL 那两摊状态各回初值、画布清成黑。
 *
 * 为什么不是"新建一格设备"：WebGL 上下文一页只有个位数，每跑一趟建一格的话
 * 几趟之后浏览器就把最早那几格回收了（画面变黑、也没有报）。
 */
function reset() {
  stop();
  D.frameFn = null;
  D.batches.length = 0;
  D.col = [1, 1, 1];
  D.x = 0;
  D.y = 0;
  D.fno = 0;
  D.t0 = performance.now();
  /* 性能账也归零 —— 上一份脚本的 fps 不许挂在下一份头上。 */
  D.pn = 0;
  D.psum = 0;
  D.pms = 0;
  D.pfps = 0;
  D.pt0 = 0;
  G.depth = false;
  G.cull = 0;
  G.attrs.clear();
  G.attrVer = 0;
  /* 批上带的那点状态也归零（`batchprog`/`batchmvp`/`batchblend`）—— 上一份脚本挑的
     program 不许跟到下一份头上。 */
  B.prog = 0;
  B.mvp = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  B.mv = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  B.mvpVer = 0;
  B.blend = 1;
  /* 着色器那一摊也要清：`SH.progs` 是**按名字**缓存的，改过 `@f` 区段之后名字没变、
     原文变了 —— 不清的话下一趟还拿着上一趟编好的那份（"改了没反应"就是这么来的）。 */
  SH.src.clear();
  SH.names.clear();
  SH.progs.clear();
  SH.cur = null;
  UNI.list.length = 0;
  UNI.byProg.clear();
  /* 纹理那一摊也清：GL 的纹理对象要真删（不删就一趟一趟攒着 —— 上下文有上限）。 */
  if (D.gl !== null) for (const t of TX.slots.values()) D.gl.deleteTexture(t.id);
  TX.slots.clear();
  TX.unit = 0;
  const gl = D.gl;
  if (gl !== null) {
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }
}

/** 这一帧的像素（判据用）：`readPixels` 回来的是**下上翻**的，这儿翻正。 */function snapshot() {
  const gl = D.gl;
  flush();
  const n = D.w * D.h * 4;
  const raw = new Uint8Array(n);
  gl.readPixels(0, 0, D.w, D.h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  const out = new Uint8Array(n);
  const row = D.w * 4;
  for (let y = 0; y < D.h; y++) {
    out.set(raw.subarray((D.h - 1 - y) * row, (D.h - y) * row), y * row);
  }
  return { w: D.w, h: D.h, bytes: out };
}

/**
 * 把这一格设备装上（页面调一次）。回的就是那格全局。
 *
 * `canvas` 由调用方给（Studio 里是预览区那一格）—— 这一层不碰 DOM 布局，
 * 只认"给我一格 canvas"。
 */
/**
 * **收一段顶点批**（`(gfxbatch 类 数 顶点)`）：只有一个模型 —— 变换 / 拆 mode /
 * 2D 图元变顶点 / 合批全在语言那一侧，这一层只把那一段攒进当前段里，`flush` 时
 * 一次上传 + 一次 `drawArrays`（`docs/design/eval-realtime-gpu.md` 第 9 节）。
 *
 * 位置是哪一种空间由 `batchprog` 说（见 `B`）：
 *   * `B.prog === 0` —— **裁剪空间**，而内建那对着色器收的是屏幕坐标，所以这儿按
 *     `x/w*0.5+0.5` 换一次（与 CPU 备选那一档、本机 OpenGL 那一档同一道算式）；
 *   * `B.prog !== 0` —— **物体坐标**，原样递给脚本那格顶点着色器（`u_mvp` 是
 *     语言那一侧发来的那张，见 `batchmvp`）。
 */
function batchIn(kind, n, verts) {
  const prog = B.prog === 0 ? null : SH.cur;
  if (prog !== null) {
    const b = batch(kind === 0 ? 'line' : 'tri', prog, B.mvp.slice());
    b.mv = B.mv.slice();
    for (let i = 0; i < n; i++) {
      const o = i * 16;
      for (let k = 0; k < 16; k++) b.v.push(verts[o + k]);
    }
    return n;
  }
  const sx = (o) => {
    const w = verts[o + 3] === 0 ? 1 : verts[o + 3];
    return [(verts[o] / w * 0.5 + 0.5) * D.w, (0.5 - verts[o + 1] / w * 0.5) * D.h, verts[o + 2] / w];
  };
  /* 点那一档：一格顶点摊成一个 1×1 的四边形（WebGL 里 `gl_PointSize` 不可靠 ——
     与 `setpix` 同一手）。"一个点多大"是设备的事，语言那一侧不知道像素。 */
  if (kind === 2) {
    const b = batch('tri');
    for (let i = 0; i < n; i++) {
      const o = i * 16;
      const [x, y, z] = sx(o);
      const c = [verts[o + 4], verts[o + 5], verts[o + 6], verts[o + 7]];
      const quad = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y], [x + 1, y + 1], [x, y + 1]];
      for (const [qx, qy] of quad) {
        b.v.push(qx, qy, z, 1, c[0], c[1], c[2], c[3], 0, 0, 0, 1, 0, 0, 1, 0);
      }
    }
    return n;
  }
  const b = batch(kind === 0 ? 'line' : 'tri');
  for (let i = 0; i < n; i++) {
    const o = i * 16;
    const [x, y, z] = sx(o);
    b.v.push(x, y, z, 1,
      verts[o + 4], verts[o + 5], verts[o + 6], verts[o + 7],
      verts[o + 8], verts[o + 9], verts[o + 10], verts[o + 11],
      verts[o + 12], verts[o + 13], verts[o + 14], verts[o + 15]);
  }
  return n;
}

/**
 * `(gfxarr "名字" [a0 a1 a2 a3] 数组)`：**带一整块数组的宿主调用**（§19.1）。
 *
 * 这一档有的是 `gluniform{1..4}{f,i}v`；`glgettex`（把纹理读回来）在 WebGL2 上没有
 * `glGetTexImage`，要另走一趟离屏 `readPixels` —— 还没做，**当场报**不静默。
 */
function arrIn(name, args, blk) {
  const nm = String(name);
  if (nm.startsWith('gluniform') && nm.length === 12 && nm[11] === 'v'
      && nm[9] >= '1' && nm[9] <= '4' && (nm[10] === 'f' || nm[10] === 'i')) {
    const comps = nm.charCodeAt(9) - 48;
    const e = UNI.list[Math.trunc(Number(args[0]))];
    if (e === undefined) throw new Error(`gluniform*v：没有这格句柄 ${args[0]}`);
    if (e.loc === null) return 0;
    let cnt = Math.trunc(Number(args[1]));
    if (cnt < 0) cnt = 0;
    if (cnt * comps > blk.length) cnt = Math.trunc(blk.length / comps);
    const v = nm[10] === 'i' ? new Int32Array(cnt * comps) : new Float32Array(cnt * comps);
    for (let i = 0; i < cnt * comps; i++) v[i] = blk[i];
    const gl = D.gl;
    gl.useProgram(e.prog);
    const f = nm[10] === 'i'
      ? [gl.uniform1iv, gl.uniform2iv, gl.uniform3iv, gl.uniform4iv][comps - 1]
      : [gl.uniform1fv, gl.uniform2fv, gl.uniform3fv, gl.uniform4fv][comps - 1];
    f.call(gl, e.loc, v);
    return 0;
  }
  throw new Error(`这格设备（WebGL2）上没有 '${nm}'（有的是 gluniform{1..4}{f,i}v）`);
}

export function installGlDevice(canvas, w = 320, h = 240) {
  open(canvas, w, h);
  const dev = {
    kind: 'webgl2',
    call,
    batch: batchIn,
    tex: texIn,
    arr: arrIn,
    present: flush,
    snapshot,
    setFrame,
    perf,
    frames: () => D.fno,
    stop,
    step,
    reset,
    def,
    size: () => ({ w: D.w, h: D.h }),
    /** 现在的输入（判据用：造一次事件之后核对设备真收到了）。 */
    input: () => ({ mx: D.mx, my: D.my, bst: D.bst, keys: D.keys }),
  };
  globalThis.__OMNI_GFX = dev;
  return dev;
}

