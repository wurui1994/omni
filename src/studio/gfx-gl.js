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
  /* **画过几回**（只增不减）：`getpix` 拿它当"这一帧的读回还新不新"的印记 ——
     一格像素一次 `readPixels` 太贵，所以整帧读一次、缓存到下一笔画之前（见 `getPix`）。 */
  dseq: 0,
  frameFn: null, raf: 0,          /* 每帧那一格函数 + rAF 的句柄（帧循环在页面这边） */
  /* **性能那几格**（实时那一档的核心指标，`perf()` 交出去给状态栏显示）：
     `pn`/`psum` 是这一段里的帧数与耗时和（量的是"帧函数 + flush"那一截，
     不含浏览器等下一次 vsync 的空档 —— 那一截不是我们的开销）；
     `pms`/`pfps` 是上一次结算出来的两个数（每 ~0.5 秒结算一次，照 c_impl 的 view）。 */
  pn: 0, psum: 0, pms: 0, pfps: 0, pt0: 0,
  mx: 0, my: 0, bst: 0,           /* 鼠标：canvas 左上角起的像素位置 + 按键位（bit0 左/1 右/2 中） */
  keys: null,                     /* `keystatus[256]`：扫描码 -> 0/1（下面那张表把 code 换成扫描码） */
  /* **看门狗**（见 `refresh/0` 那段注）：这一趟帧函数是什么时候进去的、里头调了几次
     `refresh()`、给它多少毫秒。`fbudget` 摆 1500ms：够慢脚本画一帧，又远在浏览器
     "这一页没响应"那道线之前。 */
  fstart: 0, refs: 0, fbudget: 1500,
  /* **Worker 那一档的帧边界**（`frameBeat`）：下一帧该在什么时刻（`slot`）、上一帧等完的
     时刻（`bend`，拿来算"我们花了多少"）、帧号上限（`cap`，0 = 无上限）、
     每过一帧叫一声谁（`tick`，宿主用它知道"又活了一帧"）。 */
  slot: 0, bend: 0, cap: 0, tick: null,
  gk: 0,                          /* `glklockstart()` 的那个起点（见 call 里那两格） */
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

/* **内建那对的贴图版**（`batchprog(2)`）：EvalDraw 的 `glsettex` 那条路 ——
   那门语言没有着色器，选了图之后的多边形就该贴着它画（`evaldraw.txt:1627`）。
   顶点色**乘**纹素（固定管线的 `GL_MODULATE`）。**与 `runtime-gl/omni_ev_gl.c` 的
   `FS_TEX_SRC` 逐句对应** —— 差的只有 `#version` 那一行与坐标空间那一格。 */
const VS_TEX = `#version 300 es
in vec4 a_pos;
in vec4 a_col;
in vec4 a_tex;
uniform vec2 u_size;
out vec3 v_col;
out vec2 v_uv;
void main() {
  vec2 p = vec2(a_pos.x / u_size.x * 2.0 - 1.0, 1.0 - a_pos.y / u_size.y * 2.0);
  gl_Position = vec4(p, clamp(a_pos.z, -1.0, 1.0), 1.0);
  v_col = a_col.rgb;
  v_uv = a_tex.xy;
}`;

const FS_TEX = `#version 300 es
precision highp float;
in vec3 v_col;
in vec2 v_uv;
uniform sampler2D u_tex0;
out vec4 o_col;
void main() { o_col = vec4(v_col, 1.0) * texture(u_tex0, v_uv); }`;

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
/**
 * **一格 2D 画布**（裁子图与取像素那两处用）。
 *
 * 页面上是 `document.createElement('canvas')`；**没有 DOM 的那一档**（Worker +
 * OffscreenCanvas，任务 #39）是 `new OffscreenCanvas(w,h)` —— 两边都有 `getContext('2d')`
 * / `drawImage` / `getImageData`，所以调用处一个字都不用改。两样都没有就回 null
 * （调用处记一笔 miss，不静默当成成功）。
 */
function mk2d(w, h) {
  const doc = globalThis.document;
  if (doc !== undefined && doc !== null && typeof doc.createElement === 'function') {
    const c = doc.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  const OC = globalThis.OffscreenCanvas;
  if (typeof OC === 'function') return new OC(w, h);
  return null;
}

/**
 * **取一张图**（文件纹理与 `pic` 两处）。页面上就是 `new Image()`；**Worker 里没有它**
 * （任务 #39）⇒ 用 `fetch + createImageBitmap` 补一格**形状一样的壳子**：
 * `onload` / `onerror` / `naturalWidth` / `naturalHeight` 这几格调用处照旧读。
 *
 * 两处与 `Image` 不一样，调用处要照着写：
 * * 换 URL 走 **`imgSrc(im, url)`** 而不是 `im.src = url` —— 这一份不许用赋值器
 *   （取值/赋值器不在那个 JS 子集里，`check:self` 那道门）；
 * * 往 GL / 2D 画布上传那一格递 **`imgOf(im)`**（页面上是那张 `Image`、Worker 里是
 *   `ImageBitmap` —— `texImage2D` 与 `drawImage` 两样都认）。
 */
function newImg() {
  const IM = globalThis.Image;
  if (typeof IM === 'function') return new IM();
  return { onload: null, onerror: null, naturalWidth: 0, naturalHeight: 0, bmp: null, shim: 1 };
}

function imgSrc(im, url) {
  if (im.shim !== 1) { im.src = url; return; }
  const f = globalThis.fetch;
  const mk = globalThis.createImageBitmap;
  const bad = () => { if (typeof im.onerror === 'function') im.onerror(); };
  if (typeof f !== 'function' || typeof mk !== 'function') { bad(); return; }
  f(url).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
    .then((b) => mk(b))
    .then((bm) => {
      im.bmp = bm;
      im.naturalWidth = bm.width;
      im.naturalHeight = bm.height;
      if (typeof im.onload === 'function') im.onload();
    })
    .catch(() => { bad(); });
}

const imgOf = (im) => (im.shim === 1 ? im.bmp : im);

function open(canvas, w, h) {
  /* **`alpha: false` 是一条判据不是一格口味**：正本画的是窗口的帧缓冲，那儿没有
     alpha 通道 —— 片元写多少 alpha 都不影响看见的颜色。浏览器这边默认 `alpha: true`
     且预乘，于是脚本里那句 `gl_FragColor = vec4(r,g,b,0)`（ken 那批写 0 的很多，
     ceilflor2/driftbox 都是）出来**整张透明**：画确实画上了（readPixels 七万多个
     亮像素、60fps），屏幕上却是 `.gfx-canvas` 的黑底 —— "很多例子全黑"就是这一格。 */
  const gl = canvas.getContext('webgl2', {
    alpha: false, antialias: false, preserveDrawingBuffer: true, depth: true,
  });
  if (gl === null) throw new Error('这个浏览器没有 WebGL2 —— 换 --gfx=cpu 那一档');
  /* 浮点颜色附件（`glgettex` 读 `KGL_FLOAT`/`KGL_VEC4` 那两格要它才够完整）。
     拿不到就算了 —— 那时 `texGet` 回 -1，不静默当成读到了。 */
  gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('OES_texture_float_linear');
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`WebGL2 设备的 program 链不上：${gl.getProgramInfoLog(prog)}`);
  }
  /* 贴图版那一格（`batchprog(2)`）：链不上就留 null，那时退回平色那对。 */
  const ptex = gl.createProgram();
  gl.attachShader(ptex, compile(gl, gl.VERTEX_SHADER, VS_TEX));
  gl.attachShader(ptex, compile(gl, gl.FRAGMENT_SHADER, FS_TEX));
  gl.linkProgram(ptex);
  const texok = gl.getProgramParameter(ptex, gl.LINK_STATUS);
  if (texok) {
    gl.useProgram(ptex);
    const sl = gl.getUniformLocation(ptex, 'u_tex0');
    if (sl !== null) gl.uniform1i(sl, 0);
  }
  D.canvas = canvas;
  D.gl = gl;
  D.prog = prog;
  D.progtex = texok ? ptex : null;
  D.buf = gl.createBuffer();
  D.w = w;
  D.h = h;
  /**
   * **换上下文就得把攥着 GL 对象的缓存全丢掉**（一页里连着跑两份产物才看得见）。
   *
   * 这一层的状态是模块级的（`SH` / `TX` / `B` / `G` / `CAP` / `CAP4`），而每装一次设备
   * 都是**一格新的 WebGL2 上下文** —— 上一趟留下的 program / 纹理 / FBO 属于那个已经
   * 没人要的上下文，拿到这一格里用就是"静静地什么都不发生"。
   * 现形的那一趟（2026-09-29）：先跑 `07-capture4.pss`（它末尾 `glsetshader("vert","showtex")`
   * 留着 `SH.cur`）、再跑 `02-gl.pss` ⇒ 后者**整幅全黑**（批带着一格外来的 program）。
   * 判据里先前只是被次序盖住了：那两格之间从来没有"前一份挑过着色器"的组合。
   *
   * **`SH.src` / `SH.names` 不能丢**：那是文本与名字，而 `(gfxdef …)` 可能在开设备**之前**
   * 就登记过了（本机那一档也是这条，见 §13.6）—— 丢了就成"这格设备没有那份着色器"。
   */
  SH.progs.clear();
  SH.cur = null;
  TX.slots.clear();
  TX.unit = 0;
  CAP.on = false;
  CAP.w = 0;
  CAP.h = 0;
  CAP4.fbo = null;
  CAP4.on = false;
  B.prog = 0;
  B.mvp = ident();
  B.mv = ident();
  B.mvpVer = 0;
  B.blend = 1;
  G.attrs.clear();
  G.attrVer = 0;
  G.depth = false;
  G.cull = 0;
  /* 攒着的那几段顶点也属于上一个上下文（上一份程序的最后一帧没交完的话）。 */
  D.batches.length = 0;
  D.dseq = 0;
  D.fno = 0;
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
  /**
   * **没有 DOM 的那一档**（`OffscreenCanvas` / Worker 里，任务 #39）：这儿一个监听都挂不上
   * （`OffscreenCanvas` 没有 `addEventListener`、Worker 里没有 `window`）。
   * 那时输入由**宿主推进来**（`dev.setInput(…)`）—— 键位表照旧在这儿开好，
   * 于是脚本读 `keystatus[…]` 读到的是 0，而不是"这一格压根没有"。
   */
  const canEv = typeof canvas.addEventListener === 'function';
  const win = globalThis.window;
  if (!canEv || win === undefined || win === null) return;
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
  win.addEventListener('keydown', (ev) => {
    const c = SCAN[ev.code];
    if (c !== undefined) D.keys[c] = 1;
  });
  win.addEventListener('keyup', (ev) => {
    const c = SCAN[ev.code];
    if (c !== undefined) D.keys[c] = 0;
  });
}

/**
 * **输入从外头推进来**（没有 DOM 的那一档：Worker + OffscreenCanvas，任务 #39）。
 *
 * 形状与设备自己那几格一样：`mx`/`my` 是**canvas 像素**、`bst` 是按键位
 * （0 左 / 1 右 / 2 中）、`keys` 是"扫描码 -> 0/1"的稀疏对象或数组。
 * 给了哪几格就更新哪几格 —— 宿主那侧一般每帧只推动过的那一格。
 */
function setInput(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v.mx === 'number') D.mx = v.mx;
  if (typeof v.my === 'number') D.my = v.my;
  if (typeof v.bst === 'number') D.bst = v.bst;
  const ks = v.keys;
  if (ks !== null && ks !== undefined && D.keys !== null) {
    for (const k of Object.keys(ks)) {
      const i = Number(k);
      if (i >= 0 && i < 256) D.keys[i] = ks[k] === 0 ? 0 : 1;
    }
  }
  return 0;
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
function batch(kind, prog = null, mvp = null, tex = false) {
  /* 这一笔之后"读回来的那一帧"就旧了（见 `D.dseq` 的注）。 */
  D.dseq += 1;
  const last = D.batches[D.batches.length - 1];
  if (last !== undefined && last.kind === kind && last.depth === G.depth
    && last.prog === prog && last.attrVer === G.attrVer
    && last.mvpVer === B.mvpVer && last.blend === B.blend
    && last.cull === G.cull && last.tex === tex) return last;
  const b = {
    kind, depth: G.depth, prog, mvp, attrVer: G.attrVer, mvpVer: B.mvpVer, blend: B.blend,
    cull: G.cull, tex, v: [],
  };
  D.batches.push(b);
  return b;
}

/**
 * 一格顶点**十六个数**：位置 4（内建那档是屏幕 x,y,深度,1；着色器那档是物体坐标）、
 * 颜色 4、纹理坐标 4、法向 4。一种布局管两条路 —— 两种布局就是两份 `flush`。
 *
 * **十六不是十二**（2026-09-25 修）：`flush` 那边的步长是 `ST = 64`（16 个 float）、
 * 顶点数是 `b.v.length / 16`，而这儿从前只推 12 个数 —— 2D 那一族于是每格顶点错位
 * 四个 float，尾巴上还凑出**多半格顶点**：`draw2d.kc` 在真浏览器里左上角多一格
 * (255,255,0) 的点（位置是补出来的 0,0、颜色读到了下一格顶点的前几个数）。
 * 判据 `tests/studio/run.js` 那四条红就是从这儿来的。
 */
const push = (b, x, y) => {
  b.v.push(x, y, 0, 1, D.col[0], D.col[1], D.col[2], 1, 0, 0, 0, 1, 0, 0, 1, 0);
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
    const bi = b.prog === null && b.tex === true && D.progtex !== null ? D.progtex : null;
    const prog = b.prog === null ? (bi === null ? D.prog : bi) : b.prog;
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
 *
 * **precision 那几行不止 float 一格**：ES 3.00 只给 `sampler2D`/`samplerCube` 定了默认
 * 精度，`sampler3D` 没有 —— 于是 `ken/texture3d.pss` 那一族（体素那块 64³）编不过：
 * `ERROR: 0:9: 'sampler3D' : No precision specified`。桌面 GL 压根没有精度这回事，
 * 所以这一格是浏览器这一档独有的头，不是脚本要改的东西。
 */
function toEs300(kind, src) {
  if (src.includes('#version')) return src;
  return `#version 300 es\nprecision highp float;\nprecision highp sampler3D;\n${src}`;
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
  /* **几何段这一档做不到**：WebGL2（GLSL ES 300）压根没有几何着色器。
     有 `@g` 的脚本在编译期就按"顶点出 `gv_*`、几何出 `v_*`"那条链翻好了
     （`ext/polydraw/glsl.js`），少了几何段这一节 v/f 是接不上的 —— 所以**当场报**，
     不静默链一个错的（口径：`docs/design/eval-realtime-gpu.md` §28.14）。 */
  if (v.text.includes('gv_col0')) {
    throw new Error('glsetshader：这一档（WebGL2）没有几何着色器 ——'
      + ' 这份脚本有 `@g` 区段，只有本机 OpenGL 那一档（`--gfx gl`）跑得了');
  }
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
    /* `tar` 是这一槽**现在是哪一种纹理**（2D / 3D）—— `glbindtexture` 要按它绑，
       绑错了 GL 会把这一槽当不完整的纹理，采样一律回黑（`ken/texture3d.pss` 那一族）。 */
    t = { id: D.gl.createTexture(), w: 0, h: 0, d: 1, fmt: 0, tar: D.gl.TEXTURE_2D };
    TX.slots.set(slot, t);
  }
  return t;
}

/** 过滤与环绕那两段位（`0xf0` / `0xf00`）-> GL 的参数。 */
function texParams(fmt, tar = 0) {
  const gl = D.gl;
  const t = tar === 0 ? gl.TEXTURE_2D : tar;
  const filt = fmt & 0xf0;
  const wrap = fmt & 0xf00;
  const mip = filt >= 0x20;
  gl.texParameteri(t, gl.TEXTURE_MAG_FILTER,
    filt === 0x10 ? gl.NEAREST : gl.LINEAR);
  gl.texParameteri(t, gl.TEXTURE_MIN_FILTER,
    mip ? gl.LINEAR_MIPMAP_LINEAR : (filt === 0x10 ? gl.NEAREST : gl.LINEAR));
  const w = wrap === 0x100 ? gl.MIRRORED_REPEAT
    : (wrap === 0 ? gl.REPEAT : gl.CLAMP_TO_EDGE);
  gl.texParameteri(t, gl.TEXTURE_WRAP_S, w);
  gl.texParameteri(t, gl.TEXTURE_WRAP_T, w);
  /* 3D 与立方体那两档还有第三根轴（`ken/texture3d.pss` 按 >1 的 z 采样）。 */
  if (t === gl.TEXTURE_3D || t === gl.TEXTURE_CUBE_MAP) {
    gl.texParameteri(t, gl.TEXTURE_WRAP_R, w);
  }
  return mip;
}

function texIn(slot, w, h, d, fmt, px) {
  const gl = D.gl;
  if (gl === null) return 0;
  /* 纹理是**按 draw call 的状态**：攒着的批要先画掉，不然它们会拿到新图。 */
  flush();
  const kind = fmt & 15;
  const t = texOf(slot);
  /* **`层 > 1` 就是 3D 那一档**（`kglsettexarray3` 的第三格是 zsiz，`polydraw.c:1400`）——
     口径照本机那一档（`omni_ev_gl_tex`）。这一槽从前若是 2D，换目标就得换纹理对象：
     GL 的纹理对象一旦绑过某个目标就定死了（"already has a target" 会报错）。 */
  const tar = d > 1 ? gl.TEXTURE_3D : gl.TEXTURE_2D;
  if (t.tar !== tar && t.w !== 0) {
    gl.deleteTexture(t.id);
    t.id = gl.createTexture();
  }
  t.tar = tar;
  const three = tar === gl.TEXTURE_3D;
  gl.activeTexture(gl.TEXTURE0 + TX.unit);
  gl.bindTexture(tar, t.id);
  const n = w * h * (d > 0 ? d : 1);
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
      /* **3D 那一档 alpha 原样收**：那一族体素（`rgba(r,g,b,(issol!=0)*48)`）空的地方
         alpha 就是 0，当成不透明会把一块体素整块糊实（本机那一档的头注记过这一格）。
         2D 那一档照旧"0 当不透明"——脚本用 `rgb()` 造的图没人看 alpha。 */
      b[i * 4 + 3] = three ? al : (al === 0 ? 255 : al);
    }
    if (three) gl.texImage3D(tar, 0, gl.RGBA8, w, h, d, 0, gl.RGBA, gl.UNSIGNED_BYTE, b);
    else gl.texImage2D(tar, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, b);
  } else if (kind === 1) {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = Math.max(0, Math.min(255, Math.trunc(px[i])));
    if (three) gl.texImage3D(tar, 0, gl.R8, w, h, d, 0, gl.RED, gl.UNSIGNED_BYTE, b);
    else gl.texImage2D(tar, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, b);
  } else if (kind === 4) {
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = px[i];
    if (three) gl.texImage3D(tar, 0, gl.R32F, w, h, d, 0, gl.RED, gl.FLOAT, f);
    else gl.texImage2D(tar, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, f);
  } else if (kind === 5) {
    const f = new Float32Array(n * 4);
    for (let i = 0; i < n * 4; i++) f[i] = px[i];
    if (three) gl.texImage3D(tar, 0, gl.RGBA32F, w, h, d, 0, gl.RGBA, gl.FLOAT, f);
    else gl.texImage2D(tar, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, f);
  } else {
    throw new Error(`gfxtex：这一档没接 KGL 格式 ${kind}（KGL_SHORT/KGL_INT）——`
      + ' 有的是 BGRA32(0) / CHAR(1) / FLOAT(4) / VEC4(5)');
  }
  if (texParams(fmt, tar)) gl.generateMipmap(tar);
  t.w = w;
  t.h = h;
  t.d = d;
  t.fmt = fmt;
  return 0;
}

/* ---------------------------------------------------------------- 抓屏那一族
 *
 * `glcapture()` / `glcaptureend(槽)`（§22）：中间画的那一摊**不上屏**，而是整帧
 * 拷进一格纹理，随后当贴图再画一趟（后处理：`tigrou/clock.pss` 是 3.0*uv 采样、
 * `funky`/`gears`/`tree` 是模糊、`ken/texture.pss` 是把画面贴到方块上）。
 *
 * 口径**照本机那一档**（`runtime-gl/omni_ev_gl.c` 里 `omni_ev_gl_capbegin` 的头注：
 * 三份实现在这一格不是一回事 —— 整帧、视口与矩阵一格都不动照 `c_impl`，而
 * **"拷完把画布清掉"照原版**）。这一层与本机那一档的唯一差别是**没有离屏帧缓冲**：页面这格设备一直画在画布上，所以
 * "抓屏"就是从默认帧缓冲 `copyTexImage2D`。看得见的后果是抓屏那一趟会在画布上闪
 * 一下（同一帧里随后那趟全屏贴图会盖掉它），换 FBO 才能免掉 —— 先不换，两层帧缓冲
 * 是另一件活（本机那一档为此有一整套 `-1` 哨兵）。
 *
 * `siz` 收下不用：原版那个 `qglCapture(double dcaptexsiz)` 读的是一格根本没传的实参
 * （`myext[]` 里是零参的 `GLCAPTURE()`），边长在正本里就是栈上的垃圾。
 */
const CAP = { w: 0, h: 0, on: false };
/** 四参那一档（画进真纹理）：自己一格 FBO + "这一趟是四参"的记号（本机那档的 `g_cap4`）。 */
const CAP4 = { fbo: null, on: false };

/**
 * **四参 `glcapture(槽,宽,高,格)`**（`myext[]` 里 `"GLCAPTURE(,,,)"`，`polydraw.c:1217`
 * 的 `kglCapture`）：往**一张真纹理**上画，而不是零参那种"画完再从画布拷一张"。
 * 口径与本机那一档（`omni_ev_gl_capbegin4`）逐句对应，两处一起改。
 *
 * 浮点那两格（`KGL_FLOAT` / `KGL_VEC4`）要 `EXT_color_buffer_float` 才当得了渲染目标 ——
 * 那一格在开设备时就问过（见上头 `getExtension`）。不完整的 FBO 上画东西是**静静地什么都
 * 不发生**，所以这儿 `checkFramebufferStatus` 当场记一笔 miss 并回 -1。
 */
function capBegin4(slot, w, h, fmt) {
  const gl = D.gl;
  if (gl === null) return 0;
  if (w < 1 || h < 1 || w * h > 67108864) return -1;
  flush();
  if (CAP4.fbo === null) CAP4.fbo = gl.createFramebuffer();
  const t = texOf(slot);
  if (t.tar !== gl.TEXTURE_2D && t.w !== 0) {
    gl.deleteTexture(t.id);
    t.id = gl.createTexture();
  }
  t.tar = gl.TEXTURE_2D;
  gl.activeTexture(gl.TEXTURE0 + TX.unit);
  gl.bindTexture(gl.TEXTURE_2D, t.id);
  if (t.w !== w || t.h !== h || t.fmt !== fmt) {
    const kind = fmt & 15;
    const ifmt = kind === 1 ? gl.R8
      : (kind === 4 ? gl.R32F : (kind === 5 ? gl.RGBA32F : gl.RGBA8));
    const efmt = (kind === 1 || kind === 4) ? gl.RED : gl.RGBA;
    const ety = (kind === 4 || kind === 5) ? gl.FLOAT : gl.UNSIGNED_BYTE;
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, efmt, ety, null);
    /* **不许要 mipmap**：只有第 0 层的纹理挑了 mipmap 过滤就是不完整的，采出来一片黑。
       过滤那一段位里 `>= 0x20`（要 mipmap）的降成 LINEAR，环绕照旧听脚本的。 */
    texParams((fmt & 0xf0) >= 0x20 ? (fmt & ~0xf0) : fmt);
    t.w = w;
    t.h = h;
    t.fmt = fmt;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, CAP4.fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.id, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    CAP4.on = false;
    return miss('glcapture:fbo') - 1;
  }
  gl.viewport(0, 0, w, h);
  CAP4.on = true;
  CAP.on = false;
  return 0;
}

function capBegin() {
  const gl = D.gl;
  if (gl === null) return 0;
  flush();
  CAP.w = D.w;
  CAP.h = D.h;
  CAP.on = true;
  /* 从干净的黑底起（照 c_impl）：后处理按 >1 的坐标采样时，采到的只该是这一趟画的。 */
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  return 0;
}

function capEnd(slot) {
  const gl = D.gl;
  if (gl === null) return 0;
  flush();
  /* **四参那一趟**：解绑 + 还原视口就完了 —— 不拷（画的时候就在那张纹理上）、不清
     （原版 `qglEndCapture` 在 `glastcap` 那一支提前 return）。 */
  if (CAP4.on) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, D.w, D.h);
    CAP4.on = false;
    return 0;
  }
  const w = CAP.w === 0 ? D.w : CAP.w;
  const h = CAP.h === 0 ? D.h : CAP.h;
  const t = texOf(slot);
  /* 这一槽从前可能是 3D（`texIn` 那一档）—— 换回 2D 要换纹理对象（目标定死一次）。 */
  if (t.tar !== gl.TEXTURE_2D && t.w !== 0) {
    gl.deleteTexture(t.id);
    t.id = gl.createTexture();
  }
  t.tar = gl.TEXTURE_2D;
  gl.activeTexture(gl.TEXTURE0 + TX.unit);
  gl.bindTexture(gl.TEXTURE_2D, t.id);
  /* **内部格式要跟着读缓冲**：`alpha: false` 的画布是 RGB8，往 RGBA 拷是
     INVALID_OPERATION（ES 3.0 要求目标的分量是读缓冲的子集）。正本那边也是没有
     alpha 通道的窗口帧缓冲，所以采样时 alpha 是 1 —— 与 RGB 这一格同一个意思。 */
  const rgba = gl.getContextAttributes().alpha === true;
  gl.copyTexImage2D(gl.TEXTURE_2D, 0, rgba ? gl.RGBA : gl.RGB, 0, 0, w, h, 0);
  /* 第 0 行是帧缓冲**最下面**那一行 —— 与 `glquad()` 的纹理坐标（t=0 在下）对得上。 */
  texParams(0);
  t.w = w;
  t.h = h;
  t.fmt = 0;
  /* **拷完把画布清掉**（`polydraw.c:1283` 那句 `glClear`）—— 与本机那一档同一手：
     抓屏那一趟画的东西**不留在屏幕上**。**只有配过对的才清**（原版那格 `glastcap`：
     四参的 `glcapture(槽,宽,高,格)` 走真 FBO，那一条不清）——
     见 `omni_ev_gl_capend` 的头注。 */
  if (CAP.on) {
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
  }
  CAP.on = false;
  return 0;
}

/**
 * **文件纹理**（`glsettexfile 槽 名字下标 格`，§20 —— 脚本里写的是 `glsettex("earth.jpg",…)`）。
 *
 * 本机那两档设备自己开文件（目录只有宿主知道），页面这一档只能**过网**：
 * `GET /api/asset?path=<脚本所在目录>/<名字>`（那一格在 `src/core/serve.js`，闸是
 * `safePath` + 图片后缀白名单）。
 *
 * 浏览器里取图是**异步**的，而 `glsettex` 在脚本里是同步一句。所以这一格：
 *
 *   1. 当场先摆一格 **1×1 的白**（白乘上去等于"没贴图"）—— 图还在路上的那几帧照旧画得出，
 *      而不是黑掉、更不是把帧循环停下；
 *   2. 背后 `new Image()` 取，回来了再往**同一格 `WebGLTexture`** 上传一次。
 *      槽与句柄都没换，所以脚本那边一个字都不用改；
 *   3. 一份图只取一趟（`FT.st` 记状态）—— 脚本多半每帧都调一次 `glsettex`。
 *
 * 行序**照本机那一档**（`runtime-gl/omni_ev_gl.c:937` 是解码出来的第一行当 GL 的第一行），
 * 所以这儿**不开** `UNPACK_FLIP_Y_WEBGL`。
 */
const FT = {
  /** 这一趟脚本所在的目录（Studio 在跑之前摆一次，见 `setAssets`）。 */
  base: '',
  /** `槽|名字|格` -> `'load' | 'ok' | 'err'`。 */
  st: new Map(),
};

/** `<base>/<名字>` 化简成一条干净的相对路径（`.` 与 `..` 在这儿就地消掉）。 */
function assetPath(name, base = FT.base) {
  const parts = `${base}/${name}`.split('/');
  const out = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') { out.pop(); continue; }
    out.push(p);
  }
  return out.join('/');
}

/** 一格图的 URL。 */
const assetUrl = (rel) => `/api/asset?path=${encodeURIComponent(rel)}`;

function texFile(slot, name, fmt) {
  const gl = D.gl;
  if (gl === null || typeof name !== 'string' || name === '') return 1;
  const key = `${slot}|${name}|${fmt}`;
  const had = FT.st.get(key);
  if (had !== undefined) return had === 'err' ? 1 : 0;
  FT.st.set(key, 'load');
  flush();
  const t = texOf(slot);
  /* 这一槽从前可能是 3D —— 换回 2D 要换纹理对象（见 `texIn` 那一句的注）。 */
  if (t.tar !== gl.TEXTURE_2D && t.w !== 0) {
    gl.deleteTexture(t.id);
    t.id = gl.createTexture();
  }
  t.tar = gl.TEXTURE_2D;
  gl.activeTexture(gl.TEXTURE0 + TX.unit);
  gl.bindTexture(gl.TEXTURE_2D, t.id);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([255, 255, 255, 255]));
  texParams(fmt);
  t.w = 1;
  t.h = 1;
  t.fmt = fmt;
  const im = newImg();
  let tried = 0;
  /* **落点试两处**：先脚本旁边，再那棵语料树的根。为什么有第二处：原版是拿
     `polydraw.exe` 所在的目录当基准的（本机那一档对应 `OMNI_GFX_DIR`）——
     `tigrou/disco ball.pss` 写的是 `"b2dr_sph.jpg"`，而那张图在语料树的根上。 */
  const root = FT.base.split('/')[0] ?? '';
  const next = () => {
    tried += 1;
    if (tried === 1) { imgSrc(im, assetUrl(assetPath(name))); return true; }
    if (tried === 2 && root !== '' && root !== FT.base) {
      imgSrc(im, assetUrl(assetPath(name, root)));
      return true;
    }
    return false;
  };
  im.onload = () => {
    const g2 = D.gl;
    if (g2 === null) return;
    FT.st.set(key, 'ok');
    /* **一竖条 6 格那一档是立方体贴图**（`polydraw.c:1338`）：口径照本机那一档
       （`omni_ev_gl_texfile`）—— 哪一格是哪一面照原版那张 `cubemapindex`
       （`polydraw.c:1093` = `{1,3,4,5,0,2}`，**不是顺着来的**）。
       WebGL 这边没法从图里取子矩形，所以过一格 2D 画布把每一面裁出来再传。 */
    const cube = im.naturalWidth > 0 && im.naturalWidth * 6 === im.naturalHeight;
    const tar = cube ? g2.TEXTURE_CUBE_MAP : g2.TEXTURE_2D;
    /* 头一句占位的白是按 2D 传的，而纹理对象的目标一绑就定死 —— 换目标要换对象。 */
    if (t.tar !== tar && t.w !== 0) {
      g2.deleteTexture(t.id);
      t.id = g2.createTexture();
    }
    t.tar = tar;
    g2.activeTexture(g2.TEXTURE0 + TX.unit);
    g2.bindTexture(tar, t.id);
    if (cube) {
      const faces = [
        g2.TEXTURE_CUBE_MAP_POSITIVE_X, g2.TEXTURE_CUBE_MAP_NEGATIVE_X,
        g2.TEXTURE_CUBE_MAP_POSITIVE_Y, g2.TEXTURE_CUBE_MAP_NEGATIVE_Y,
        g2.TEXTURE_CUBE_MAP_POSITIVE_Z, g2.TEXTURE_CUBE_MAP_NEGATIVE_Z,
      ];
      const order = [1, 3, 4, 5, 0, 2];
      const fw = im.naturalWidth;
      const fh = im.naturalHeight / 6;
      const cut = mk2d(fw, fh);
      if (cut === null) { miss('glsettexfile:2d'); return; }
      const c2 = cut.getContext('2d');
      for (let f = 0; f < 6; f++) {
        c2.clearRect(0, 0, fw, fh);
        c2.drawImage(imgOf(im), 0, fh * order[f], fw, fh, 0, 0, fw, fh);
        g2.texImage2D(faces[f], 0, g2.RGBA, g2.RGBA, g2.UNSIGNED_BYTE, cut);
      }
    } else {
      g2.texImage2D(g2.TEXTURE_2D, 0, g2.RGBA, g2.RGBA, g2.UNSIGNED_BYTE, imgOf(im));
    }
    if (texParams(fmt, tar)) g2.generateMipmap(tar);
    t.w = im.naturalWidth;
    t.h = im.naturalHeight;
  };
  im.onerror = () => {
    if (next()) return;
    FT.st.set(key, 'err');
    /* **读不到就要说话**：静默失败等于"图不对但没人知道"（与本机那一档同一条）。 */
    // eslint-disable-next-line no-console
    console.warn(`#gfx 文件纹理没上去：'${name}'（脚本旁边与 '${root}/' 两处都取不到）`);
  };
  next();
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
  /* **数组那一档**：脚本拿 `句柄 + i` 指第 i 格（`ken/geo_duptris.pss` 的
     `glUniform4f(env+1, …)`；真 GL 里数组元素的位置本来就是连着的）——
     所以这儿把 `名字[1]`、`名字[2]`… 挨着登记，句柄上的加法就成立了。
     停在第一个查不着的下标（WebGL 的位置是不透明对象，只能按名字一个个问）。 */
  if (loc !== null) {
    for (let k = 1; k < 64; k++) {
      const el = D.gl.getUniformLocation(SH.cur, `${nm}[${k}]`);
      if (el === null) break;
      UNI.list.push({ prog: SH.cur, loc: el });
      per.set(`${nm}[${k}]`, UNI.list.length - 1);
    }
  }
  return h;
}

/**
 * `gluniform{1,2,3,4}{f,i}(句柄, …)`。句柄不认（着色器里没这个名字）就**当场报**。
 *
 * **整数那一档非有不可**（`ints === true`）：采样器与开关位走它（`sampler2D` 只吃
 * `uniform1i`，用 `1f` 喂它在 WebGL2 上是 `INVALID_OPERATION`）。
 * 撞过：`evaldraw/demos/drawcone2.kc` 在页面上跑，帧函数第一帧就抛
 * "这格设备（WebGL2）上没有 'gluniform1i'"，帧循环当场停 —— CPU 备选那一档早就有它
 * （`host/gfx-cpu.js` 的 `gluniform1i/2`），这边漏了。
 */
function uniSet(h, vals, ints = false) {
  const e = UNI.list[Math.trunc(h)];
  if (e === undefined) throw new Error(`gluniform：没有这格句柄 ${h}（glgetuniformloc 回的才算）`);
  if (e.loc === null) return 0;    /* 着色器里没用到那个 uniform —— GL 那边也是静默 */
  const gl = D.gl;
  gl.useProgram(e.prog);
  if (ints) {
    const v = vals.map((x) => Math.trunc(x));
    if (v.length === 1) gl.uniform1i(e.loc, v[0]);
    else if (v.length === 2) gl.uniform2i(e.loc, v[0], v[1]);
    else if (v.length === 3) gl.uniform3i(e.loc, v[0], v[1], v[2]);
    else gl.uniform4i(e.loc, v[0], v[1], v[2], v[3]);
  } else if (vals.length === 1) gl.uniform1f(e.loc, vals[0]);
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

/* ---------------------------------------------------------------- 读回一格像素
 *
 * `getpix(x,y)`（`gethlin` 那一族也靠它）：这一档的画面在 GPU 上，一格像素一次
 * `readPixels` 是**几十微秒**级的同步等待 —— 一个 `for` 循环读几千格就是几百毫秒。
 * 所以**整帧读一次、缓存住**：`D.dseq`（画过几回）当印记，下一笔画之前的所有
 * `getpix` 共用同一份读回。读回来的行序是下上翻的（`readPixels` 从最下面一行起），
 * 脚本的 y=0 在最上面，所以取下标时翻回来。
 *
 * 语义照 CPU 备选那一档（`gfx-cpu.js` 的 `getpix/2`）：出界回 0，回的是 `0xRRGGBB`。
 */
const RP = { seq: -1, px: null };

function getPix(x, y) {
  const gl = D.gl;
  if (gl === null) return 0;
  const xi = Math.trunc(x);
  const yi = Math.trunc(y);
  if (!(xi >= 0 && yi >= 0 && xi < D.w && yi < D.h)) return 0;
  if (RP.seq !== D.dseq || RP.px === null) {
    flush();
    const n = D.w * D.h * 4;
    if (RP.px === null || RP.px.length !== n) RP.px = new Uint8Array(n);
    gl.readPixels(0, 0, D.w, D.h, gl.RGBA, gl.UNSIGNED_BYTE, RP.px);
    RP.seq = D.dseq;
  }
  const o = ((D.h - 1 - yi) * D.w + xi) * 4;
  return (RP.px[o] << 16) | (RP.px[o + 1] << 8) | RP.px[o + 2];
}

/* ---------------------------------------------------------------- KV6 体素模型
 *
 * `drawkv6("cow.kv6",…)`（`evaldraw.txt:921`）：与 `pic` 那一族同一个分工 ——
 * 设备把模型解开、语言那一侧一次抄过来自己画（见 `ext/polydraw/gfx3-rt.js`
 * 的 `g3_kv67`）。两句话：`kv6siz(名字下标)` 问几格体素（还没到手回 -1），
 * `(gfxarr "kv6read" …)` 把那张表抄走。
 *
 * **解码不在这一层**：`/api/asset?path=…` 认 `.kv6`，服务端用那份唯一的解码器
 * （`src/core/host/kv6.js`）解开，发过来的已经是**一格体素四个 float64**
 * （x,y,z 减过支点 + 0xRRGGBB）。于是浏览器这侧一个字节都不用解析，
 * 也不必把那份解码器搬进页面（单体那一档的打包不受影响）。
 *
 * 取文件是异步的，所以与 `PIC` 一样：第一趟开始取并回 -1，到手之后再回个数。
 * **落点试两处**（脚本旁边、再 `<语料树根>/data/`）：EvalDraw 自己把模型放在跟着
 * 程序走的 `data/` 里，脚本里那个名字是"模型名"不是相对路径。
 */
const KV = { m: new Map(), cur: null };

function kv6Load(name) {
  const e = { st: 'load', n: 0, vox: null };
  KV.m.set(name, e);
  const root = FT.base.split('/')[0] ?? '';
  const urls = [assetUrl(assetPath(name))];
  if (root !== '' && root !== FT.base) urls.push(assetUrl(assetPath(`data/${name}`, root)));
  let i = 0;
  const step = () => {
    if (i >= urls.length) {
      e.st = 'err';
      // eslint-disable-next-line no-console
      console.warn(`#gfx KV6 没上来：'${name}'（脚本旁边与 '${root}/data/' 两处都取不到）`);
      return;
    }
    const u = urls[i];
    i += 1;
    fetch(u).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('404'))))
      .then((ab) => {
        e.vox = new Float64Array(ab);
        e.n = Math.trunc(e.vox.length / 4);
        e.st = e.n > 0 ? 'ok' : 'err';
      })
      .catch(step);
  };
  step();
  return e;
}

function kv6Siz(nameIdx) {
  const name = SH.names.get(String(Math.trunc(nameIdx)));
  if (typeof name !== 'string' || name === '') return -1;
  let e = KV.m.get(name);
  if (e === undefined) e = kv6Load(name);
  KV.cur = e.st === 'ok' ? e : null;
  return e.st === 'ok' ? e.n : -1;
}

function kv6Read(out) {
  const e = KV.cur;
  if (e === null || e.vox === null) return 0;
  const cnt = Math.min(e.n, Math.trunc(out.length / 4));
  for (let i = 0; i < cnt * 4; i++) out[i] = e.vox[i];
  return cnt;
}

/* ---------------------------------------------------------------- 那张名字表 */

/**
 * **一格宿主调用**（名字 + 一串 double，回一个 double）。认不出的名字**记一笔账再当空操作**
 * （见 `default`）—— 不许静默回 0：账在 `dev.misses()` 里，控制台也报一行。
 */
/** **没接住的那几格的账**（名字/元数 -> 这一趟被调了几次）。见 `call` 的 `default`。 */
const MISS = new Map();

/** 记一笔"这一格没接住"（第一次在控制台报一行，之后静默）。 */
function miss(op, note = '') {
  if (!MISS.has(op)) {
    MISS.set(op, 0);
    // eslint-disable-next-line no-console
    console.warn(`#gfx miss ${op} —— 这格设备（WebGL2）还没接这一格，当空操作，`
      + `账记在 dev.misses()。${note}`);
  }
  MISS.set(op, MISS.get(op) + 1);
  return 0;
}

function call(name, args) {
  const gl = D.gl;
  const a = (i) => Number(args[i] ?? 0);
  switch (`${name}/${args.length}`) {
    case 'cls/3':
      flush();                                  /* 先把攒着的画掉，再清 —— 次序与脚本一致 */
      D.dseq += 1;                              /* 清屏也是一笔画（`getpix` 的读回要作废） */
      gl.clearColor(clamp01(a(0)), clamp01(a(1)), clamp01(a(2)), 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return 0;
    /* `cls(打包好的颜色)`：EvalDraw 里最常见的那个写法（`cls(0)`）。 */
    case 'cls/1': {
      flush();
      D.dseq += 1;
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
    /* `getcol()`：当前颜色打包回 0xRRGGBB（这一档的 `D.col` 是三格 0..1）——
       EvalDraw 的 `glBegin` 那一族拿它当顶点色（那门语言没有 `glColor`）。 */
    case 'getcol/0': {
      const q = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));
      return q(D.col[0]) * 65536 + q(D.col[1]) * 256 + q(D.col[2]);
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
    /**
     * `refresh()`：把这一帧交出去 —— 这一档就是画掉攒着的顶点（canvas 上就看见了）。
     *
     * **这一档等不了**：`refresh()` 的正本语义是"交图 + 等 + 查出口"（见
     * `core/host/gfx-cpu.js` 的那段头注），而页面上帧函数是主线程里**同步**跑的 ——
     * 真等就是把页面卡死。语料里有二十几份 `.kc` 是**自己在死循环里用 `refresh()` 驱动帧**的
     * （`geeky/pi.kc` 的 `for(z=1;1;z+=2)`），那一族在这一档会一直不回来。
     *
     * 所以摆一道**看门狗**：一趟帧函数里花了超过 `D.fbudget` 毫秒还在 `refresh()`，就抛。
     * 抛出来的样子是"帧循环停下 + 控制台一句说清为什么"，**不是把浏览器标签页掐死**
     * （量过：不带这道闸时 `pi.kc` 一跑，整个标签页被浏览器杀掉，连报错都收不到）。
     * 真要让这一族跑起来得把脚本挪进 Web Worker + OffscreenCanvas —— 那儿
     * `refresh()` 能真的 `Atomics.wait`，主线程照旧刷新。记在任务 #32 里。
     */
    case 'refresh/0': {
      flush();
      D.refs += 1;
      /**
       * **Worker 里这一格是真的等待点**（任务 #39 / §41）—— 但"第几回"要分开，口径与
       * CPU 备选那一档逐句相同（`host/gfx-cpu.js` 的 `refresh/0`）：
       *
       * * **一趟帧函数里的第一回只交图**：宿主每帧调一次帧函数的那一族（绝大多数），
       *   帧的边界是宿主那格节拍器，这儿再等一次就是白等两帧；
       * * **第二回起才是帧边界**：那正是**脚本自己拿 `refresh()` 当帧循环**的形状
       *   （`ext/evaldraw/examples/selfloop.kc`）—— 它那个 `while(1)` 一轮一回，
       *   于是从第二回开始每回都等到下一格 60fps 的时刻、帧号加一、报一声活。
       *
       * 不能拿"在不在帧函数里"分（产物永远是从帧函数里进来的），也不能拿
       * "有没有人调过 nextframe"分（产物入口永远调它）—— 与 CPU 那一档踩过的坑同一个。
       */
      if (inWorker() && D.refs >= 2) { frameBeat(); return 0; }
      if (inWorker()) return 0;
      if (D.fstart > 0 && performance.now() - D.fstart > D.fbudget) {
        throw new Error(`这一份脚本在一趟帧函数里调了 ${D.refs} 次 refresh() 还没回来`
          + `（超过 ${D.fbudget}ms）—— 它是**自己拿 refresh() 当帧循环**的那一族。`
          + '浏览器主线程这一档的帧函数是同步跑的，refresh() 没法真等；'
          + '要跑这一族就把它交给 Worker（`studio/eval-worker.js`，任务 #39）。'
          + ' 本机那两档（omni run --gfx gl / host）现在就能跑它。');
      }
      return 0;
    }
    /**
     * `nextframe`：**两档都一帧都不放过去**（直接回 0）。
     *
     * 主线程那一档的理由：产物是在主线程同步跑的，`while` 会把页面卡死 —— 所以帧循环交给
     * `requestAnimationFrame`（`setFrame` 那一格），产物那条 while 一轮都不转。
     *
     * **Worker 里也回 0**（量过才知道的一格，§41.3）：那儿等得住，可一旦让
     * `while (nextframe()) { … }` 真转起来，`run` 这一趟**就再也不回来** ——
     * Worker 的消息循环跟着一起停（`shot`/`input`/`stop` 全排在队里没人收）。所以这一族
     * 照旧交给宿主那格节拍器（`setFrame`），只有**脚本自己拿 `refresh()` 当帧循环**
     * 那一族才走真等待点（见上面 `refresh/0`）—— 那一族没有别的办法。
     */
    case 'nextframe/0': flush(); return 0;
    case 'numframes/0': return D.fno > 0 ? D.fno - 1 : 0;
    /* `glklockstart()` / `glklockelapsed()`（`polydraw.c:2216` 的 GLKLOCK*）：GPU 那一侧的
       计时，脚本拿它印自己的帧耗时。这一档**收下**：起点记在 `D.gk`、`elapsed` 回毫秒
       （与 CPU 备选那一档"收下回 0"同一类，只是这儿真答得出来）。 */
    case 'glklockstart/0': D.gk = performance.now(); return 0;
    case 'glklockelapsed/0': return D.gk === 0 ? 0 : performance.now() - D.gk;
    case 'klock/0': return (performance.now() - D.t0) / 1000;
    /* `FRAMEINIT`（见 CPU 备选那一份的注）：第一帧 1、之后 0。 */
    case 'frameinit/0': return D.fno <= 1 ? 1 : 0;
    /* `getpix(x,y)`：整帧读一次再按下标取（见 `getPix` 的头注）。 */
    case 'getpix/2': return getPix(a(0), a(1));
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
      /* 还没设过内容的槽：绑一格空的（与 PolyDraw 一样不报 —— 画出来是黑的）。
         **按这一槽自己的目标绑**（2D / 3D，见 `texOf` 的注）。 */
      if (t === undefined) {
        const n2 = texOf(slot);
        gl.bindTexture(n2.tar, n2.id);
      } else {
        gl.bindTexture(t.tar, t.id);
      }
      return 0;
    }
    /* **文件纹理**（见 `texFile` 的头注）：名字在方言里是名字表的下标。 */
    case 'glsettexfile/3':
      return texFile(Math.trunc(a(0)), SH.names.get(String(Math.trunc(a(1)))), Math.trunc(a(2)));
    /* **`pic` 那一族的头一句**（见 `PIC` 的头注）：宽高，还没取到回 -1。 */
    case 'picsiz/1': return picSiz(a(0));
    /* **KV6 那一族的头一句**（见 `KV` 的头注）：几格体素，还没取到回 -1。 */
    case 'kv6siz/1': return kv6Siz(a(0));
    /* **抓屏那一族**（见 `CAP` 的头注）。 */
    case 'glcapture/1': return capBegin();
    case 'glcapture/4':
      return capBegin4(Math.trunc(a(0)), Math.trunc(a(1)), Math.trunc(a(2)), Math.trunc(a(3)));
    case 'glcaptureend/1': return capEnd(Math.trunc(a(0)));
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
    /* **整数那一档**（采样器与开关位）—— 见 `uniSet` 的头注。 */
    case 'gluniform1i/2': return uniSet(a(0), [a(1)], true);
    case 'gluniform2i/3': return uniSet(a(0), [a(1), a(2)], true);
    case 'gluniform3i/4': return uniSet(a(0), [a(1), a(2), a(3)], true);
    case 'gluniform4i/5': return uniSet(a(0), [a(1), a(2), a(3), a(4)], true);
    /* `gluniform(句柄, 值)` / `gluniform(句柄, 个数, 数组)`：说明书里是同一个名字两种元数。
       数组那一档要一格数组实参 —— 宿主面只收 double，所以**明着拒**。 */
    case 'gluniform/2': return uniSet(a(0), [a(1)]);
    /* `klock(i)`：`0` 与 `klock()` 同；`|i|` 在 1..9 是**日期分量**（i>0 本地、i<0 UTC）——
       口径照 `polydraw_src/polydraw.c:1662` 的 `myklock`，那张表与 `host/gfx-cpu.js` 的
       `klockParts` 逐格相同：1 = YYYYMMDDHHMMSS.sss × .001，2 年 3 月 **4 星期（0 = 周日）**
       5 日 6 时 7 分 8 秒 9 毫秒。缺这一格的样子是"帧函数抛了、帧循环停下"（`clock.pss`）。
       这儿在真浏览器里跑，所以直接用 `Date`（`core/host/browser.js` 的 `localStamp` 同路）。 */
    case 'klock/1': {
      const i = Math.trunc(a(0));
      if (i === 0) return (performance.now() - D.t0) / 1000;
      const k = Math.abs(i);
      if (k < 1 || k > 9) return 0;
      const u = i < 0;
      const d = new Date();
      const y = u ? d.getUTCFullYear() : d.getFullYear();
      const mo = (u ? d.getUTCMonth() : d.getMonth()) + 1;
      const dd = u ? d.getUTCDate() : d.getDate();
      const h = u ? d.getUTCHours() : d.getHours();
      const mi = u ? d.getUTCMinutes() : d.getMinutes();
      const s = u ? d.getUTCSeconds() : d.getSeconds();
      const ms = u ? d.getUTCMilliseconds() : d.getMilliseconds();
      if (k === 1) {
        return ((((((y * 100 + mo) * 100 + dd) * 100 + h) * 100 + mi) * 100 + s) * 1000 + ms) * 0.001;
      }
      if (k === 2) return y;
      if (k === 3) return mo;
      if (k === 4) return u ? d.getUTCDay() : d.getDay();
      if (k === 5) return dd;
      if (k === 6) return h;
      if (k === 7) return mi;
      if (k === 8) return s;
      return ms;
    }
    /* `glgetattribloc(名字下标)` / `glvertexattrib{1,2,3,4}f(句柄, …)`：
       **常量属性**那一档（数组关着时 GL 用的就是当前值）。逐顶点变的那一档没接 ——
       我们这儿顶点是攒成一批画的，要逐顶点得给顶点布局再加一格，记在这儿。 */
    case 'glgetattribloc/1': return attrLoc(a(0));
    case 'glvertexattrib1f/2': return attrSet(a(0), [a(1), 0, 0, 1]);
    case 'glvertexattrib2f/3': return attrSet(a(0), [a(1), a(2), 0, 1]);
    case 'glvertexattrib3f/4': return attrSet(a(0), [a(1), a(2), a(3), 1]);
    case 'glvertexattrib4f/5': return attrSet(a(0), [a(1), a(2), a(3), a(4)]);
    default:
      /**
       * **没接住的那一格：记一笔账 + 当空操作**，不掐死帧循环。
       *
       * 从前这儿直接抛：一份脚本用到一格还没接的 API（`setfont` 那一族画布文字、
       * `glsettexfile` 文件纹理），**整个帧循环当场停**、页面上只剩一张残帧。
       * 而这两族是**明知的欠账**（任务 #26 / #28），不是"写错了"。
       *
       * 所以改成：第一次在控制台报一行（谁缺、几个实参），之后静默；账记在
       * `MISS` 里，`perf()` 与 `misses()` 都读得到 —— 判据靠它算"缺哪一格 × 几份"，
       * **不是靠"跑通了"**（那就是"不许拿全黑对全黑白拿分"那条纪律的这一处落点）。
       */
    {
      const m = `${name}/${args.length}`;
      return miss(m, '这一层有的是：'
        + '2D cls/setcol/setpix/moveto/lineto/drawsph/drawcone/rgb/refresh，'
        + '宿主量 nextframe/numframes/klock/xres/yres/mousx/mousy/bstatus/keystatus，'
        + '批与状态 (gfxbatch …)/batchprog/batchmvp/batchblend/gldepth，'
        + '可编程管线 glsetshader/glgetuniformloc/gluniform*/glgetattribloc/glvertexattrib*，'
        + '纹理 (gfxtex …)/glsettexfile/glbindtexture/glactivetexture；'
        + '**GL 立即模式与矩阵栈不在设备这一层**（在语言那一侧的 ext/polydraw/gl-rt.js）');
    }
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
/**
 * **一帧的节拍器**。页面上是 `requestAnimationFrame`（跟着 vsync，帧之间让出控制权）；
 * **Worker 里没有 rAF**（任务 #39 / §41）⇒ 退回 `setTimeout(…, 16)`（≈60Hz）。
 *
 * 两边的句柄空间不一样，但不会混：有 rAF 就一定走 rAF、没有就一定走 timeout，
 * 所以 `unraf` 按同一个判断取消。
 */
const raf = (fn) => (typeof globalThis.requestAnimationFrame === 'function'
  ? globalThis.requestAnimationFrame(fn) : globalThis.setTimeout(fn, 16));

const unraf = (id) => {
  if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(id);
  else globalThis.clearTimeout(id);
};

/** 在不在 Worker 里（没有 `document` 就是）。这一格决定 `refresh()` 能不能真等。 */
const inWorker = () => typeof globalThis.document === 'undefined';

/** `Atomics.wait` 用的那一格（跨源隔离的页面才有 SAB —— 见 §41.2）。懒开一次。
 *
 * 两格 int32：`[0]` 是睡觉那一格（永远是 0，拿它当"睡到某一刻"用），
 * `[1]` 是**停的旗子** —— 宿主在主线程上写 1，Worker 里下一格帧边界就退出去（见
 * `frameBeat`）。为什么要它：脚本自己拿 `refresh()` 当帧循环那一族**不回消息循环**，
 * `stop` 那封消息永远排不上 —— 不给这条路，宿主只能 `terminate()`，而画布
 * （`transferControlToOffscreen`）只能交一次，掐了 Worker 就连画布一起没了。
 */
let WAITBUF = null;

const waitBuf = () => {
  if (WAITBUF !== null) return WAITBUF;
  const SAB = globalThis.SharedArrayBuffer;
  if (typeof SAB !== 'function') return null;
  WAITBUF = new Int32Array(new SAB(8));
  return WAITBUF;
};

/**
 * **等到 `at`（`performance.now()` 的刻度）**。两条路：
 * * 有 `SharedArrayBuffer` 就 `Atomics.wait`（**不烧 CPU**，误差几毫秒，而且宿主一
 *   `Atomics.notify` 就能当场叫醒 —— 停的时候不用等满这一格）；
 * * 没有就忙等（量过误差 < 1ms）。烧一格核，但这是在 Worker 里 —— **主线程照旧刷新**。
 *
 * 只许在 Worker 里叫（页面上等一下就是把标签页冻住）。
 */
function sleepTo(at) {
  const b = waitBuf();
  if (b !== null && typeof Atomics === 'object' && Atomics !== null) {
    for (;;) {
      const left = at - performance.now();
      if (left <= 0) return;
      if (Atomics.load(b, 1) !== 0) return;   /* 宿主说停：不等了，回去看那格旗子 */
      /* 那一格永远是 0，所以这一句一定等到超时（或者被 notify 叫醒）。 */
      Atomics.wait(b, 0, 0, left);
    }
  }
  while (performance.now() < at) { /* 忙等 */ }
}

/**
 * **一帧的边界**（Worker 里 `refresh()` / `nextframe()` 走的就是它，任务 #39 / §41）。
 *
 * 语料里二十几份脚本自己在死循环里用 `refresh()` 驱动帧（`ext/evaldraw/examples/selfloop.kc`
 * 就是那个形状）。主线程上这一族只能被看门狗掐掉；Worker 里**阻塞是合法的**，于是
 * 这一格做四件事：按 60fps 走位等到下一格、帧号加一、记一笔性能账、（有的话）叫一声
 * `D.tick` 让宿主知道又过了一帧。
 *
 * `D.cap > 0` 时数到了就抛一格带 `$exit` 的错 —— 与 CPU 备选那一档 `OMNI_FRAMES` 用尽时
 * 同一手（`host/gfx-cpu.js` 的 `refresh/0`）：脚本自己那个 `while` 没有别的出口。
 */
function frameBeat() {
  const t = performance.now();
  /* 头一帧、或者落后超过 100ms（机器忙了一下）：把零点重新摆在现在 —— 不然它会
     为了"追上"连着跑好几帧不等（那就成了忙循环）。 */
  if (D.slot === 0 || t > D.slot + 100) D.slot = t;
  D.slot += 1000 / 60;
  sleepTo(D.slot);
  D.fno += 1;
  /* 性能账：`ms` 是**我们**花的（这一帧的活 = 这一趟进来到开始等之间），`fps` 是墙上的。 */
  if (D.pt0 === 0) D.pt0 = t;
  D.psum += t - (D.bend === 0 ? t : D.bend);
  D.pn += 1;
  const span = performance.now() - D.pt0;
  if (span >= 500) {
    D.pfps = (D.pn * 1000) / span;
    D.pms = D.psum / D.pn;
    D.pn = 0;
    D.psum = 0;
    D.pt0 = performance.now();
  }
  D.bend = performance.now();
  if (typeof D.tick === 'function') D.tick(D.fno);
  /* **宿主说停**（`[1]` 那格旗子，见 `waitBuf`）：这一族的 `while` 没有别的出口，
     所以停也只能从这儿停 —— 与帧数用尽同一手（抛一格带 `$exit` 的错）。 */
  const b = WAITBUF;
  if (b !== null && Atomics.load(b, 1) !== 0) {
    const e = new Error('gfx: 宿主说停（脚本自己那个 while 没有别的出口）');
    e.$exit = 0;
    throw e;
  }
  if (D.cap > 0 && D.fno >= D.cap) {
    const e = new Error('gfx: 帧数够了（脚本自己那个 while 没有别的出口）');
    e.$exit = 0;
    throw e;
  }
}

function setFrame(f) {
  if (typeof f !== 'function') return;
  D.frameFn = f;
  if (D.raf !== 0) return;
  const tick = () => {
    D.raf = 0;
    D.fno += 1;
    const t = performance.now();
    if (D.pt0 === 0) D.pt0 = t;
    /* 看门狗的零点（见 `refresh/0`）：这一趟帧函数从这儿算起。 */
    D.fstart = t;
    D.refs = 0;
    try {
      D.frameFn();
    } catch (e) {
      /* 带 `$exit` 的那一格**不是错**：脚本自己拿 `refresh()` 当帧循环那一族就是从
         帧边界上退出去的（帧数够了 / 宿主说停，见 `frameBeat`）—— 安静地收摊，
         不然真浏览器那几条判据会在控制台上看见一条"错"。 */
      if (e !== null && typeof e === 'object' && e.$exit !== undefined) { flush(); return; }
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
    D.raf = raf(tick);
  };
  D.raf = raf(tick);
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
  if (D.raf !== 0) unraf(D.raf);
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
  /* 看门狗的零点（见 `refresh/0`）—— 单步这一档也要摆，不然那一族脚本单步也回不来。 */
  D.fstart = performance.now();
  D.refs = 0;
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
  /* Worker 那一档的帧边界（`frameBeat`）：走位的零点按程序算，不许跨程序接着数。 */
  D.slot = 0;
  D.bend = 0;
  /* 停的旗子也归零（不然上一份程序停下那一下会把下一份当场停掉 —— "一页里连着跑
     两份产物"那一类坑的第五个）。 */
  if (WAITBUF !== null) Atomics.store(WAITBUF, 1, 0);
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
  /* 文件纹理那几张的状态跟着槽走（槽都删了）—— 下一趟重新取一遍。 */
  FT.st.clear();
  CAP.w = 0;
  CAP.h = 0;
  /* 读回那一份缓存跟着作废（下一份脚本的第一笔 `getpix` 要真读一趟）。 */
  RP.seq = -1;
  /* KV6 那几份模型也清（换脚本就重取一趟 —— 与文件纹理同一条）。 */
  KV.m.clear();
  KV.cur = null;
  /* **没接住的那本账也清**：它是"这一趟这份脚本缺哪几格"的账 —— 不清的话下一份脚本
     背着上一份的债（踩过一次：`drawsph.pss` 的账里挂着上一份的 `drawspr/4`，
     而它压根没调过 `drawspr`）。 */
  MISS.clear();
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
  /* **三档**：0 内建平色、1 脚本那格、2 内建那对的贴图版（EvalDraw 的 `glsettex`）。
     2 那一档位置照旧是裁剪空间 ⇒ 走下头 `null` 那条路，只是 flush 时挑另一格 program。 */
  const prog = B.prog === 1 ? SH.cur : null;
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
    const b = batch('tri', null, null, B.prog === 2);
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
  const b = batch(kind === 0 ? 'line' : 'tri', null, null, B.prog === 2);
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
/* ---------------------------------------------------------------- 把纹理读回来
 *
 * `glgettex(槽, &数组, 宽, 高, 格)`（§19.1）。口径照本机那一档（`omni_ev_gl_gettex`）：
 * **最后那格 `coltype` 不看**，一格几个 double 由**这一槽自己的格**说（`KGL_VEC4`
 * 一像素 4 个 float，别的一像素一格）；回值是写回了几格，出错回 -1。
 *
 * WebGL2 没有 `glGetTexImage`，所以走**离屏帧缓冲 + `readPixels`**：把这一槽挂到
 * 一格常驻 FBO 的 0 号颜色附件上再读。行序对得上 —— 纹理的第 0 行就是帧缓冲最下面
 * 那一行，`readPixels` 从下往上读，于是出来的顺序与 `glGetTexImage` 相同，不用翻。
 *
 * 两格已知的限制（都写在明处）：
 *   * 3D 与立方体那两档读回还没做（`framebufferTexture2D` 只接 2D 的面）；
 *   * 浮点那两格（`KGL_FLOAT` / `KGL_VEC4`）要 `EXT_color_buffer_float` 才够完整，
 *     拿不到就回 -1（`open` 里试着取一次）。
 *   * **文件纹理刚上路那几帧读到的是 1×1 的占位白**（`glsettex("earth.jpg")` 是异步的）——
 *     `ken/gspiral.pss` 正好在 `numframes == 0` 里读一次，于是页面这一档拿不到那张图。
 *     这是页面这一档独有的账，与"头几帧没有图"（见 `PIC` 的头注）同一类。
 */
const RB = { fbo: null };

function texGet(slot, w, h, out) {
  const gl = D.gl;
  if (gl === null || w < 1 || h < 1) return -1;
  const t = TX.slots.get(slot);
  if (t === undefined || t.w === 0) return -1;
  if (t.tar !== gl.TEXTURE_2D) return miss(`glgettex:${t.tar === gl.TEXTURE_3D ? '3d' : 'cube'}`) - 1;
  const n = w * h;
  if (n > t.w * t.h) return -1;
  const kind = t.fmt & 15;
  const per = kind === 5 ? 4 : 1;
  if (n * per > out.length) return -1;
  flush();
  if (RB.fbo === null) RB.fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, RB.fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.id, 0);
  let wrote = -1;
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
    if (kind === 0 || kind === 1) {
      const b = new Uint8Array(n * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
      if (kind === 0) {
        /* 一格 double = `0xAARRGGBB`（与参考那一行逐字相同 —— 本机那一档是靠
           `GL_BGRA` + 小端拿到同一个数的）。 */
        for (let i = 0; i < n; i++) {
          out[i] = (((b[i * 4 + 3] << 24) | (b[i * 4] << 16)
            | (b[i * 4 + 1] << 8) | b[i * 4 + 2]) >>> 0);
        }
      } else for (let i = 0; i < n; i++) out[i] = b[i * 4];
      wrote = n;
    } else if (kind === 4 || kind === 5) {
      const f = new Float32Array(n * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, f);
      if (kind === 4) for (let i = 0; i < n; i++) out[i] = f[i * 4];
      else for (let i = 0; i < n * 4; i++) out[i] = f[i];
      wrote = n * per;
    }
  }
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return wrote;
}

/**
 * **`pic("a.png",x,y)` 那一族**（`evaldraw.txt:1341`）：`picsiz` 问宽高、`picread` 抄整张。
 *
 * 采样在**语言那一侧**（一次抄过来，之后全是数组下标 —— 每像素问设备一句慢几十倍），
 * 所以这一层只要答两句。取图还是异步的，于是：
 *
 *   * `picsiz` 第一趟**开始取**并回 `-1`（= 还没有这张图，与"读不到"同一个样子）；
 *   * 取回来之后画进一格离屏 canvas 拿像素，之后 `picsiz` 回 `宽*65536+高`、
 *     `picread` 把那一片抄进脚本那块数组；
 *   * 语言那一侧**读不到不缓存**（`gfx3-rt.js` 的 `g3_picneed`）—— 所以下一帧它会再问一次，
 *     图到了就接上。这是页面这一档与本机那两档唯一的差：**头几帧没有图**。
 */
const PIC = {
  /** 名字 -> `{ st:'load'|'ok'|'err', w, h, px: Uint8Array }`。 */
  m: new Map(),
  /** 上一句 `picsiz` 问的是哪一张（`picread` 抄的就是它 —— 语言那一侧两句紧挨着发）。 */
  cur: null,
};

function picLoad(name) {
  const e = { st: 'load', w: 0, h: 0, px: null };
  PIC.m.set(name, e);
  const im = newImg();
  let tried = 0;
  const root = FT.base.split('/')[0] ?? '';
  const next = () => {
    tried += 1;
    if (tried === 1) { imgSrc(im, assetUrl(assetPath(name))); return true; }
    if (tried === 2 && root !== '' && root !== FT.base) {
      imgSrc(im, assetUrl(assetPath(name, root)));
      return true;
    }
    return false;
  };
  im.onload = () => {
    const cv = mk2d(im.naturalWidth, im.naturalHeight);
    if (cv === null) { miss('pic:2d'); return; }
    const c2 = cv.getContext('2d', { willReadFrequently: true });
    c2.drawImage(imgOf(im), 0, 0);
    e.px = c2.getImageData(0, 0, cv.width, cv.height).data;
    e.w = cv.width;
    e.h = cv.height;
    e.st = 'ok';
  };
  im.onerror = () => {
    if (next()) return;
    e.st = 'err';
    // eslint-disable-next-line no-console
    console.warn(`#gfx pic 读不到 '${name}'（脚本旁边与 '${root}/' 两处都取不到）`);
  };
  next();
}

/** `picsiz(名字下标)` -> `宽*65536+高`（还没取到 / 取不到都回 -1）。 */
function picSiz(idx) {
  const name = SH.names.get(String(Math.trunc(idx)));
  if (typeof name !== 'string' || name === '') return -1;
  const e = PIC.m.get(name);
  if (e === undefined) { picLoad(name); return -1; }
  if (e.st !== 'ok') return -1;
  PIC.cur = name;
  return e.w * 65536 + e.h;
}

/** `picread` -> 把上一句 `picsiz` 那张图抄进脚本那块数组（一格一个 0xRRGGBB）。 */
function picRead(blk) {
  const e = PIC.cur === null ? undefined : PIC.m.get(PIC.cur);
  if (e === undefined || e.st !== 'ok' || e.px === null) return 0;
  const n = Math.min(blk.length, e.w * e.h);
  for (let i = 0; i < n; i += 1) {
    blk[i] = (e.px[i * 4] << 16) | (e.px[i * 4 + 1] << 8) | e.px[i * 4 + 2];
  }
  return 0;
}

function arrIn(name, args, blk) {
  const nm = String(name);
  /* **一整张矩阵一句**（`batchmvp16` / `batchmv16`，列主序 16 个数）：与四句
     `batchmvp`/`batchmv` 逐字等价，少 7 句宿主调用（见 `ext/polydraw/gl-rt.js`）。 */
  if (nm === 'batchmvp16' || nm === 'batchmv16') {
    if (blk.length < 16) return 0;
    const m = nm === 'batchmvp16' ? B.mvp : B.mv;
    for (let i = 0; i < 16; i++) m[i] = blk[i];
    B.mvpVer += 1;
    return 0;
  }
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
  /**
   * **整行像素**（`setrow y x0 数 0 行`，2D graphing modes 那一族，一格一个 0xRRGGBB）。
   * 这一档没有平面帧缓冲，所以一格像素还是**一格 1×1 的四边形**（与 `setpix` 同一手）——
   * 一行 320 格就是 320 个四边形，攒在同一批里交出去。
   */
  if (nm === 'setrow') {
    const y = Math.trunc(Number(args[0]));
    const x0 = Math.trunc(Number(args[1]));
    let cnt = Math.trunc(Number(args[2]));
    if (cnt > blk.length) cnt = blk.length;
    const keep = D.col;
    for (let i = 0; i < cnt; i++) {
      const v = Math.trunc(blk[i]) & 0xffffff;
      D.col = [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
      const x = x0 + i;
      tri(x, y, x + 1, y, x, y + 1);
      tri(x + 1, y, x, y + 1, x + 1, y + 1);
    }
    D.col = keep;
    return 0;
  }
  /* **`pic` 那一族的第二句**（见 `PIC` 的头注）：把整张图抄给脚本。 */
  if (nm === 'picread') return picRead(blk);
  /* **KV6 那一族的第二句**（见 `KV` 的头注）：把那张体素表抄给脚本。 */
  if (nm === 'kv6read') return kv6Read(blk);
  /* **把纹理读回来**（`glgettex(槽,&数组,宽,高,格)`，见 `texGet` 的头注）。 */
  if (nm === 'glgettex') {
    return texGet(Math.trunc(Number(args[0])), Math.trunc(Number(args[1])),
      Math.trunc(Number(args[2])), blk);
  }
  throw new Error(`这格设备（WebGL2）上没有 '${nm}'（有的是 setrow / picread / glgettex`
    + ' / gluniform{1..4}{f,i}v）');

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
    /** 这一趟**哪几格没接住、各被调了几次** —— 判据算"缺哪一格 × 几份"靠它。 */
    misses: () => [...MISS.entries()].map(([k, n]) => ({ op: k, n })),
    /**
     * **图从哪儿取**：脚本所在的目录（相对仓库根，例如 `polydraw/ken`）。
     * 文件纹理与 `pic("a.png")` 里的名字是相对脚本的，而页面这一档要过网
     * （`/api/asset?path=…`）—— 所以跑之前摆一次。
     */
    setAssets: (dir) => { FT.base = typeof dir === 'string' ? dir : ''; },
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
    /** 输入从外头推进来（没有 DOM 的那一档：Worker + OffscreenCanvas，见 `setInput`）。 */
    setInput,
    /** 每过一帧叫一声谁（Worker 那一档：宿主靠它知道"又活了一帧"，见 `frameBeat`）。 */
    setTick: (f) => { D.tick = typeof f === 'function' ? f : null; },
    /** 帧号上限（0 = 无上限）：Worker 里脚本自己那个 `while` 靠它有个出口。 */
    setCap: (n) => { D.cap = typeof n === 'number' && n > 0 ? Math.trunc(n) : 0; },
    /**
     * **停的旗子那一块共享内存**（`Int32Array` 的 `[1]`，见 `waitBuf`）：Worker 把它交给
     * 宿主，宿主写 1 + `Atomics.notify(buf, 0)` 就能让自循环那一族在下一格帧边界退出去。
     * 没有 `SharedArrayBuffer`（页面没跨源隔离，比如单体的 `file://`）时回 null ——
     * 那一档只能 `terminate()`。
     */
    stopBuf: () => {
      const b = waitBuf();
      return b === null ? null : b.buffer;
    },
  };
  globalThis.__OMNI_GFX = dev;
  return dev;
}

