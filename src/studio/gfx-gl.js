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
// * GL 立即模式那一族（`glbegin`/`glvertex`/`glcolor` + 矩阵栈）**已接**，而且比 CPU
//   备选那一档多一样东西：`glEnable(GL_DEPTH_TEST)` 真开 GPU 的 z 缓冲。
//   着色器与纹理那两族**还没接** —— 认不出的名字当场报，报里说清"哪一格没有"。那是第 5、6 刀。
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
 * 现在该往哪一段里攒。**四样都一致才接着上一段**：图元类、深度测试、用哪格 program、
 * 那批常量属性的版本 —— 换了任一样就新开一段（于是脚本的次序与状态都保住了）。
 *
 * `prog` 是 `null` 表示走内建那对着色器（2D 与固定管线）；不是 null 就是脚本自己
 * `glsetshader` 挑的那格 —— 那时顶点位置递的是**物体坐标**，变换交给它的顶点着色器
 * （`u_mvp` 由我们喂：MODELVIEW 与 PROJECTION 的积，按这一段攒的时候那一刻记下）。
 */
function batch(kind, prog = null, mvp = null) {
  const last = D.batches[D.batches.length - 1];
  if (last !== undefined && last.kind === kind && last.depth === G.depth
    && last.prog === prog && last.attrVer === G.attrVer) return last;
  const b = { kind, depth: G.depth, prog, mvp, attrVer: G.attrVer, v: [] };
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
/** 一格**带自己颜色/深度/纹理坐标**的顶点（GL 立即模式那一族）。 */
const pushV = (b, v) => {
  if (b.prog === null) b.v.push(v.x, v.y, v.z, 1);
  else b.v.push(v.ox, v.oy, v.oz, v.ow);
  b.v.push(v.r, v.g, v.b, v.a, v.u, v.tv, v.p, v.q);
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
  const ST = 48;                    /* 一格顶点 12 个 float */
  for (const b of D.batches) {
    if (b.v.length === 0) continue;
    const prog = b.prog === null ? D.prog : b.prog;
    gl.useProgram(prog);
    if (b.prog === null) {
      gl.uniform2f(gl.getUniformLocation(prog, 'u_size'), D.w, D.h);
    } else {
      const mvp = gl.getUniformLocation(prog, 'u_mvp');
      if (mvp !== null) gl.uniformMatrix4fv(mvp, false, new Float32Array(b.mvp));
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, D.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(b.v), gl.STREAM_DRAW);
    for (const [nm2, size, off] of [['a_pos', 4, 0], ['a_col', 4, 16], ['a_tex', 4, 32]]) {
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
    gl.drawArrays(b.kind === 'tri' ? gl.TRIANGLES : gl.LINES, 0, b.v.length / 12);
  }
  D.batches.length = 0;
}

/* ---------------------------------------------------------------- GL 立即模式
 *
 * PolyDraw 的宿主是**真 OpenGL 1.x 的薄包装**（`polydraw.c:619` 起那一排 `qgl*`），
 * 所以这一族的口径是固定管线的定义本身：顶点过 MODELVIEW 再过 PROJECTION、除以 w、
 * 映到视口。语义**逐条照 `ext/polydraw/gl-rt.js`**（那份是同一族的 CPU 备选实现）——
 * 两边要能对得上，不然"换设备"就变成了"换语义"。
 *
 * 与 CPU 备选那一档的差别（这一档更好，写在这儿免得当成 bug）：
 * * 光栅化与顶点色插值交给 GPU（CPU 那份是包围盒 + 重心坐标）；
 * * **有深度测试**（`glEnable(GL_DEPTH_TEST)` 真开 GPU 的 z 缓冲）—— CPU 那份没有，
 *   所以 3D 例子在这一档才是对的。
 *
 * 还没接（认不出的名字当场报）：着色器与纹理那两族、`glMultMatrix`、`glCapture`。
 */
const G = {
  on: false,
  mode: -1,                       /* `glBegin` 那一格（GL 的号：0 点 … 9 多边形），-1 = 没在攒 */
  verts: [],                      /* 攒着的顶点（屏幕坐标与物体坐标都留着，见 `glVertex`） */
  mv: null, pj: null, st: [],     /* MODELVIEW / PROJECTION / 矩阵栈（列主序 m[c*4+r]） */
  col: [1, 1, 1, 1],
  tex: [0, 0, 0, 1],              /* 现在的纹理坐标（`glTexCoord`） */
  fov: 90,
  depth: false,                   /* 深度测试开着没有（`glEnable(GL_DEPTH_TEST)`） */
  /* `glVertexAttrib*` 设的那几格**常量属性**：位置 -> 四个数。`attrVer` 是它的版本号 ——
     值一变就把顶点断成另一段（常量属性是**按 draw call** 摆的，段里不能变）。 */
  attrs: new Map(), attrVer: 0,
};

const GL_VMAX = 1024;
const ident = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * `gluPerspective` 那张矩阵（列主序）。**收的是 `tan(fovy/2)` 而不是角度** ——
 * 理由是逐字节：默认那一档的 fovy 是 `ksetfov(90)` 算出来的
 * （`gfov = atan(高/宽)*360/π` 度），于是 `tan(fovy/2) = tan(atan(高/宽))` = **高/宽，
 * 一格除法就够**；真去调 `tan`/`atan` 的话 JS 的 Math 与 C 的 libm 差 1 ulp，
 * 三条腿的表面就不再逐字节相同（量过：02-gl.pss 差 96 字节、一条边上的 24 格像素）。
 */
function perspectiveT(ft, aspect, zn, zf) {
  const pj = ident();
  const f = 1 / ft;
  pj[0] = f / aspect;
  pj[5] = f;
  pj[10] = (zf + zn) / (zn - zf);
  pj[11] = -1;
  pj[14] = 2 * zf * zn / (zn - zf);
  pj[15] = 0;
  return pj;
}

/** `ksetfov`（`polydraw.c:1484`）：回的是 fovy（度）。默认 `setfov(90)` 在 4:3 上是 73.7 度。 */
const fovOf = (fov) => Math.tan(fov * Math.PI / 360) * Math.atan(D.h / D.w) * 360 / Math.PI;

function glNeed() {
  if (G.on) return;
  G.on = true;
  G.mv = ident();
  G.pj = ident();
  G.st = [];
  G.col = [1, 1, 1, 1];
  G.tex = [0, 0, 0, 1];
  G.mode = -1;
  G.verts = [];
  /* `setfov(90)` 是 PolyDraw 开机时那一句（`polydraw.c:2455`）。`fovT` 是它的
     `tan(fovy/2)` —— 默认这一档**正好是高/宽**（见 `perspectiveT` 的头注）。 */
  G.fov = fovOf(90);
  G.fovT = D.h / D.w;
}

/**
 * **每帧的 GL 初态**（`(gfxcall "framebegin")`，PolyDraw 那张表的脚本每帧开头发一次）。
 *
 * 照 `polydraw.c:3572-3579` 一条条抄：清 color/depth/stencil、**开深度测试**、
 * PROJECTION = `gluPerspective(gfov, 宽/高, 0.1, 1000)`、MODELVIEW = 单位。
 *
 * 这一格是**按语言的**：EvalDraw 那张表（2D 那一族）不发它 —— 那边没有 GL，
 * 而且"这一帧要不要清"是脚本自己用 `cls()` 说的。
 */
function frameBegin() {
  glNeed();
  const gl = D.gl;
  G.mv = ident();
  G.pj = perspectiveT(G.fovT, D.w / D.h, 0.1, 1000);
  G.st = [];
  G.depth = true;
  D.batches.length = 0;
  if (gl !== null) {
    gl.viewport(0, 0, D.w, D.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
  }
  return 0;
}

/** `G.mv = G.mv · t`（**右乘**，与 GL 同）。 */
function mvMul(t) {
  const m = G.mv;
  const out = [];
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let a = 0;
      for (let k = 0; k < 4; k++) a += m[k * 4 + r] * t[c * 4 + k];
      out[c * 4 + r] = a;
    }
  }
  G.mv = out;
}

/** clip = PROJECTION · (MODELVIEW · v)。 */
function glXf(x, y, z, w) {
  const e = [];
  for (let r = 0; r < 4; r++) {
    e.push(G.mv[r] * x + G.mv[4 + r] * y + G.mv[8 + r] * z + G.mv[12 + r] * w);
  }
  const o = [];
  for (let r = 0; r < 4; r++) {
    o.push(G.pj[r] * e[0] + G.pj[4 + r] * e[1] + G.pj[8 + r] * e[2] + G.pj[12 + r] * e[3]);
  }
  return o;
}

/**
 * 一格顶点：变换 -> 透视除法 -> 视口（GL 的 y 朝上、我们的画布 y 朝下，所以翻过来）。
 *
 * **物体坐标也留着**：脚本要是 `glsetshader` 挑了自己的着色器，变换就该由它的顶点着色器
 * 做（`ftransform()`），我们只把物体坐标与 `u_mvp` 递过去 —— 两套坐标一格顶点里都有，
 * `glEnd` 那一刻按"有没有挑着色器"决定递哪一套。
 */
function glVertex(x, y, z, w) {
  glNeed();
  if (G.verts.length >= GL_VMAX) return;
  const c = glXf(x, y, z, w);
  /* `w <= 0`（在眼睛后头）**整格丢掉** —— 近平面插值这一版没做，与 CPU 那份同一条边界。
     着色器那一档不丢（裁剪交给 GPU 自己）。 */
  if (c[3] <= 0 && SH.cur === null) return;
  const iw = c[3] === 0 ? 1 : 1 / c[3];
  G.verts.push({
    x: (c[0] * iw * 0.5 + 0.5) * D.w,
    y: (0.5 - c[1] * iw * 0.5) * D.h,
    z: c[2] * iw,
    ox: x, oy: y, oz: z, ow: w,
    r: G.col[0], g: G.col[1], b: G.col[2], a: G.col[3],
    u: G.tex[0], tv: G.tex[1], p: G.tex[2], q: G.tex[3],
  });
}

/** MODELVIEW 与 PROJECTION 的积（着色器那一档的 `u_mvp`）。 */
function mvpNow() {
  const out = [];
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let a = 0;
      for (let k = 0; k < 4; k++) a += G.pj[k * 4 + r] * G.mv[c * 4 + k];
      out[c * 4 + r] = a;
    }
  }
  return out;
}

/** 这一段该用哪格 program（`null` = 内建那对）。 */
const progNow = () => SH.cur;

/** 一段线 / 一格三角形 / 一格点（都带逐顶点的色与深度）。 */
function glSeg(i, j) {
  const b = batch('line', progNow(), mvpNow());
  pushV(b, G.verts[i]);
  pushV(b, G.verts[j]);
}

function glTri(i, j, k) {
  const b = batch('tri', progNow(), mvpNow());
  pushV(b, G.verts[i]);
  pushV(b, G.verts[j]);
  pushV(b, G.verts[k]);
}

/** 一格点 = 1×1 的两个三角形（`gl_PointSize` 在 WebGL 里不可靠）。 */
function glPt(i) {
  const v = G.verts[i];
  const b = batch('tri', progNow(), mvpNow());
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 0], [0, 1], [1, 1]]) {
    pushV(b, { ...v, x: v.x + dx, y: v.y + dy });
  }
}

/** `glEnd()`：按 `mode` 把攒下的顶点拆开（十格 mode 的号是 GL 的）。 */
function glEnd() {
  glNeed();
  const m = G.mode;
  const n = G.verts.length;
  G.mode = -1;
  if (m === 0) for (let i = 0; i < n; i++) glPt(i);
  if (m === 1) for (let i = 0; i + 1 < n; i += 2) glSeg(i, i + 1);
  if (m === 3) for (let i = 0; i + 1 < n; i++) glSeg(i, i + 1);
  if (m === 2) {
    for (let i = 0; i + 1 < n; i++) glSeg(i, i + 1);
    if (n > 2) glSeg(n - 1, 0);
  }
  if (m === 4) for (let i = 0; i + 2 < n; i += 3) glTri(i, i + 1, i + 2);
  if (m === 5) for (let i = 2; i < n; i++) glTri(i - 2, i - 1, i);
  if (m === 6 || m === 9) for (let i = 2; i < n; i++) glTri(0, i - 1, i);
  if (m === 7) {
    for (let i = 0; i + 3 < n; i += 4) { glTri(i, i + 1, i + 2); glTri(i, i + 2, i + 3); }
  }
  if (m === 8) {
    for (let i = 2; i + 1 < n; i += 2) { glTri(i - 2, i - 1, i); glTri(i - 1, i + 1, i); }
  }
  G.verts = [];
}

/* ---------------------------------------------------------------- 可编程管线
 *
 * `.pss` 的后半是 `@v` / `@f` / `@g` 区段（GLSL 原文）。语言那一侧把它们**原样**交到
 * 这儿（方言的 `(gfxdef 种类 名字 内容)`），运行期的 `glsetshader(名字下标…)` 再按名字挑。
 *
 * ## 原文要翻一遍（这一档是 WebGL2 = GLSL ES 300）
 *
 * PolyDraw 跑的是真 OpenGL 1.x/2.x，脚本里的着色器是**旧式 GLSL**（`ftransform()`、
 * `gl_FragColor`、`attribute`/`varying`）。WebGL2 只认 GLSL ES 300，所以这儿翻一遍 ——
 * 翻的是**明白的那几格**（下面 `toEs300`），认不出的原文照原样递下去，让驱动去报
 * （报里带着原文与行号，比我们猜着改好）。本机 OpenGL 那一档**不必翻**（真 GL 认旧式）。
 */
const SH = {
  /** 名字 -> `{ kind: 'vert'|'frag'|'geom', text }`（`(gfxdef …)` 登记进来的）。 */
  src: new Map(),
  /** 下标 -> 串（`glsetshader("vert",…)` 那种名字在方言里是下标 —— 见 `gfxdef` 的头注）。 */
  names: new Map(),
  /** `"顶点名|片元名"` -> 已经链好的 program（编一次，之后每帧复用）。 */
  progs: new Map(),
  cur: null,                      /* 现在挑着的那格 program（`glsetshader` 设、`glquad` 用） */
  quad: null,                     /* 满屏四边形那一格 buffer（造一次） */
};

/** 登记一格有名字的串（着色器原文 / 名字表）。 */
function def(kind, name, text) {
  if (kind === 'name') { SH.names.set(String(name), text); return 0; }
  if (kind === 'vert' || kind === 'frag' || kind === 'geom') {
    SH.src.set(String(name), { kind, text });
    return 0;
  }
  throw new Error(`(gfxdef …) 不认识的种类 '${kind}'（要 vert/frag/geom/name）`);
}

/** 第一份某一类的着色器（脚本没调 `glsetshader` 时的默认那一对）。 */
function firstOf(kind) {
  for (const [name, s] of SH.src) if (s.kind === kind) return name;
  return null;
}

/**
 * **旧式 GLSL -> GLSL ES 300**（只翻明白的那几格）。
 *
 * * `attribute` -> `in`；`varying` -> 顶点里 `out`、片元里 `in`；
 * * `gl_Vertex` -> `a_pos`（我们喂的顶点属性，vec4）、`gl_MultiTexCoord0` -> `a_tex`；
 * * `ftransform()` -> `u_mvp * a_pos`（固定管线那两个矩阵的积，由设备喂 uniform）；
 * * `gl_TexCoord[0]` -> 一格我们自己声明的 `v_tex0`（两段各自 out/in）；
 * * `gl_FragColor` -> 自己声明的 `o_col`；`texture2D` -> `texture`；
 * * `gl_ModelViewProjectionMatrix` -> `u_mvp`。
 */
function toEs300(kind, src) {
  if (src.includes('#version 300 es')) return src;
  let s = src;
  const usesTex0 = /gl_TexCoord\s*\[\s*0\s*\]/.test(s);
  s = s.replace(/\bgl_TexCoord\s*\[\s*0\s*\]/g, 'v_tex0');
  s = s.replace(/\bgl_MultiTexCoord0\b/g, 'a_tex');
  s = s.replace(/\bftransform\s*\(\s*\)/g, '(u_mvp * a_pos)');
  s = s.replace(/\bgl_ModelViewProjectionMatrix\b/g, 'u_mvp');
  s = s.replace(/\bgl_Vertex\b/g, 'a_pos');
  s = s.replace(/\btexture2D\s*\(/g, 'texture(');
  s = s.replace(/\battribute\b/g, 'in');
  const head = ['#version 300 es', 'precision highp float;'];
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

/** 挑一对着色器、编好链好（编一次）。 */
function useProgram(vName, fName) {
  const key = `${vName}|${fName}`;
  const had = SH.progs.get(key);
  if (had !== undefined) { SH.cur = had; return had; }
  const gl = D.gl;
  const v = SH.src.get(vName);
  const f = SH.src.get(fName);
  if (v === undefined || f === undefined) {
    throw new Error(`glsetshader：没有这一对着色器（顶点 '${vName}'、片元 '${fName}'）——`
      + ` 登记进来的是 ${[...SH.src.keys()].map((k) => JSON.stringify(k)).join(' ')}`
      + '（`.pss` 里要有 @v / @f 区段）');
  }
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, toEs300('vert', v.text)));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, toEs300('frag', f.text)));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`glsetshader：program 链不上（${vName}/${fName}）：${gl.getProgramInfoLog(p)}`);
  }
  SH.progs.set(key, p);
  SH.cur = p;
  return p;
}

/** `glsetshader(…)`：实参是**名字表的下标**（见 `gfxdef`）；旧式的数字那一档按序号取。 */
function setShader(args) {
  glNeed();
  const nameAt = (i) => {
    const k = String(Math.trunc(Number(args[i])));
    const s = SH.names.get(k);
    if (s !== undefined) return s;
    /* 旧式那一档（`glsetshader(0)`）：数字是"第几份"，按登记次序取。 */
    const all = [...SH.src.keys()];
    return all[Math.trunc(Number(args[i]))] ?? null;
  };
  if (args.length === 1) {
    const f = nameAt(0) ?? firstOf('frag');
    return useProgram(firstOf('vert'), f) === null ? 0 : 0;
  }
  const v = nameAt(0);
  const f = args.length >= 3 ? nameAt(2) : nameAt(1);
  useProgram(v, f);
  return 0;
}

/** `glquad(mode)`：满屏四边形。`0` 走 alpha 混合、`1` 不透明（说明书 `glquad(mode)` 那一行）。 */
function glQuad(mode) {
  const gl = D.gl;
  flush();                         /* 先把攒着的 2D/立即模式画掉 —— 次序与脚本一致 */
  if (SH.cur === null) {
    const v = firstOf('vert');
    const f = firstOf('frag');
    if (v === null || f === null) {
      throw new Error('glquad：还没有着色器 —— `.pss` 里要有 @v 与 @f 区段'
        + '（或者先 glsetshader(…) 挑一对）');
    }
    useProgram(v, f);
  }
  if (SH.quad === null) {
    SH.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, SH.quad);
    /* 两个三角形，位置就是 NDC（旧式着色器里 `ftransform()` 乘的是单位矩阵 ——
       满屏四边形本来就该直接盖满），纹理坐标 0..1。 */
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 1, 0, 0, 0, 1, 1, -1, 0, 1, 1, 0, 0, 1, -1, 1, 0, 1, 0, 1, 0, 1,
      1, -1, 0, 1, 1, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, -1, 1, 0, 1, 0, 1, 0, 1,
    ]), gl.STATIC_DRAW);
  }
  gl.useProgram(SH.cur);
  gl.bindBuffer(gl.ARRAY_BUFFER, SH.quad);
  const aPos = gl.getAttribLocation(SH.cur, 'a_pos');
  const aTex = gl.getAttribLocation(SH.cur, 'a_tex');
  if (aPos >= 0) {
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 4, gl.FLOAT, false, 32, 0);
  }
  if (aTex >= 0) {
    gl.enableVertexAttribArray(aTex);
    gl.vertexAttribPointer(aTex, 4, gl.FLOAT, false, 32, 16);
  }
  const mvp = gl.getUniformLocation(SH.cur, 'u_mvp');
  if (mvp !== null) gl.uniformMatrix4fv(mvp, false, new Float32Array(ident()));
  if (Math.trunc(mode) === 0) {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  } else {
    gl.disable(gl.BLEND);
  }
  if (G.depth) gl.enable(gl.DEPTH_TEST);
  else gl.disable(gl.DEPTH_TEST);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.disable(gl.BLEND);
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
    /* ── GL 立即模式那一族（固定管线）。语义逐条照 `ext/polydraw/gl-rt.js`。 */
    case 'glclear/1': {
      flush();
      const mask = Math.trunc(a(0));
      /* GL 的清屏色从没被设过（`myext[]` 里没有 GLCLEARCOLOR）所以是黑；
         mask 给 0 时 `qglClear` 清全部（`polydraw.c:622`）。 */
      gl.clearColor(0, 0, 0, 1);
      const bits = mask === 0
        ? gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT
        : ((mask & 0x4000) !== 0 ? gl.COLOR_BUFFER_BIT : 0)
          | ((mask & 0x100) !== 0 ? gl.DEPTH_BUFFER_BIT : 0);
      if (bits !== 0) gl.clear(bits);
      return 0;
    }
    case 'glbegin/1': glNeed(); G.mode = Math.trunc(a(0)); G.verts = []; return 0;
    case 'glend/0': glEnd(); return 0;
    case 'glvertex/2': glVertex(a(0), a(1), 0, 1); return 0;
    case 'glvertex/3': glVertex(a(0), a(1), a(2), 1); return 0;
    case 'glvertex/4': glVertex(a(0), a(1), a(2), a(3)); return 0;
    /* `glColor` 的分量是 0..1（GL 的 `glColor3d`），不是 `setcol` 那种 0..255。 */
    case 'glcolor/3':
      glNeed();
      G.col = [a(0), a(1), a(2), 1];
      return 0;
    case 'glcolor/4':
      glNeed();
      G.col = [a(0), a(1), a(2), a(3)];
      return 0;
    /* `glTexCoord(u,v[,p,q])`：现在的纹理坐标（着色器那一档从 `a_tex` 读得到）。 */
    case 'gltexcoord/2': glNeed(); G.tex = [a(0), a(1), 0, 1]; return 0;
    case 'gltexcoord/3': glNeed(); G.tex = [a(0), a(1), a(2), 1]; return 0;
    case 'gltexcoord/4': glNeed(); G.tex = [a(0), a(1), a(2), a(3)]; return 0;
    case 'gltranslate/3': {
      glNeed();
      const t = ident();
      t[12] = a(0); t[13] = a(1); t[14] = a(2);
      mvMul(t);
      return 0;
    }
    case 'glscale/3': {
      glNeed();
      const t = ident();
      t[0] = a(0); t[5] = a(1); t[10] = a(2);
      mvMul(t);
      return 0;
    }
    /* `glRotate(角度, x, y, z)`：角度是**度**，轴先归一化（GL 的规矩）。 */
    case 'glrotate/4': {
      glNeed();
      const t = ident();
      const len = Math.hypot(a(1), a(2), a(3));
      if (len > 0) {
        const x = a(1) / len;
        const y = a(2) / len;
        const z = a(3) / len;
        const rad = a(0) * Math.PI / 180;
        const c = Math.cos(rad);
        const s = Math.sin(rad);
        const d = 1 - c;
        t[0] = x * x * d + c; t[1] = y * x * d + z * s; t[2] = x * z * d - y * s;
        t[4] = x * y * d - z * s; t[5] = y * y * d + c; t[6] = y * z * d + x * s;
        t[8] = x * z * d + y * s; t[9] = y * z * d - x * s; t[10] = z * z * d + c;
      }
      mvMul(t);
      return 0;
    }
    case 'glpushmatrix/0':
      glNeed();
      /* 栈满了就**不推**（GL 那边是 GL_STACK_OVERFLOW，画面照旧）。 */
      if (G.st.length < 32) G.st.push(G.mv.slice());
      return 0;
    case 'glpopmatrix/0':
      glNeed();
      if (G.st.length > 0) G.mv = G.st.pop();
      return 0;
    /* `gluPerspective(fovy, aspect, zn, zf)`：**直接设** PROJECTION（`polydraw.c:1477`）。 */
    case 'gluperspective/4':
      glNeed();
      G.pj = perspectiveT(Math.tan(a(0) * Math.PI / 360), a(1), a(2), a(3));
      return 0;
    /* **每帧的 GL 初态**（照 `polydraw.c:3572-3579`）：PolyDraw 那张表的脚本每帧发一次。 */
    case 'framebegin/0': return frameBegin();
    /* `SETFOV(fov)`：照 `ksetfov`（`polydraw.c:1484`）—— 只算一格数并回它，**不碰矩阵**
       （下一帧的 `framebegin` 会拿它当 fovy）。 */
    case 'setfov/1':
      glNeed();
      G.fov = fovOf(a(0));
      G.fovT = Math.tan(G.fov * Math.PI / 360);
      return G.fov;
    /* `glEnable`/`glDisable`：只认深度测试那一格，别的收下不管（这一档没有光照）。 */
    case 'glenable/1': glNeed(); if (Math.trunc(a(0)) === 0x0b71) G.depth = true; return 0;
    case 'gldisable/1': glNeed(); if (Math.trunc(a(0)) === 0x0b71) G.depth = false; return 0;
    /* **深度测试那一格设备状态**（语言那一侧的 `gl_enable` 转过来的 —— 只有一个模型：
       GL 的状态机在语言那一侧，"开不开 z 缓冲"这件事只有设备做得到）。 */
    case 'gldepth/1': glNeed(); G.depth = Math.trunc(a(0)) !== 0; return 0;
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
    case 'glquad/1': return glQuad(a(0));
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
        + ' GL 立即模式是 glclear/glbegin/glend/glvertex/glcolor/gltranslate/glrotate/'
        + 'glscale/glpushmatrix/glpopmatrix/gluperspective/setfov（+ glenable 那几格）；'
        + ' **着色器与纹理那两族还没接**（docs/design/eval-realtime-gpu.md 第 5、6 刀）');
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
  G.on = false;
  G.mode = -1;
  G.verts = [];
  G.st = [];
  G.depth = false;
  G.attrs.clear();
  G.attrVer = 0;
  /* 着色器那一摊也要清：`SH.progs` 是**按名字**缓存的，改过 `@f` 区段之后名字没变、
     原文变了 —— 不清的话下一趟还拿着上一趟编好的那份（"改了没反应"就是这么来的）。 */
  SH.src.clear();
  SH.names.clear();
  SH.progs.clear();
  SH.cur = null;
  UNI.list.length = 0;
  UNI.byProg.clear();
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
 * 进来的位置是**裁剪空间**（x,y,z,w），而内建那对着色器收的是**屏幕坐标** ——
 * 所以这儿按 `x/w*0.5+0.5` 换一次（与 CPU 备选那一档、本机 OpenGL 那一档同一道算式，
 * 三档设备的口径必须是同一个）。
 */
function batchIn(kind, n, verts) {
  const sx = (o) => {
    const w = verts[o + 3] === 0 ? 1 : verts[o + 3];
    return [(verts[o] / w * 0.5 + 0.5) * D.w, (0.5 - verts[o + 1] / w * 0.5) * D.h, verts[o + 2] / w];
  };
  /* 点那一档：一格顶点摊成一个 1×1 的四边形（WebGL 里 `gl_PointSize` 不可靠 ——
     与 `setpix` 同一手）。"一个点多大"是设备的事，语言那一侧不知道像素。 */
  if (kind === 2) {
    const b = batch('tri');
    for (let i = 0; i < n; i++) {
      const o = i * 12;
      const [x, y, z] = sx(o);
      const c = [verts[o + 4], verts[o + 5], verts[o + 6], verts[o + 7]];
      const quad = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y], [x + 1, y + 1], [x, y + 1]];
      for (const [qx, qy] of quad) b.v.push(qx, qy, z, 1, c[0], c[1], c[2], c[3], 0, 0, 0, 1);
    }
    return n;
  }
  const b = batch(kind === 0 ? 'line' : 'tri');
  for (let i = 0; i < n; i++) {
    const o = i * 12;
    const [x, y, z] = sx(o);
    b.v.push(x, y, z, 1,
      verts[o + 4], verts[o + 5], verts[o + 6], verts[o + 7],
      verts[o + 8], verts[o + 9], verts[o + 10], verts[o + 11]);
  }
  return n;
}

export function installGlDevice(canvas, w = 320, h = 240) {
  open(canvas, w, h);
  const dev = {
    kind: 'webgl2',
    call,
    batch: batchIn,
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

