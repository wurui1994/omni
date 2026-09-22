/* Omni Studio —— 前端。原生 ESM，一个依赖都不装。
 *
 * 三块：目录树（虚拟文件系统）、代码区（展示/编辑 + 高亮）、输出区（输出/阶段/shell）。
 * 与服务那侧的约定在 `docs/design/omni-serve-studio.md`。
 *
 * 一条自己定的纪律：**"阶段耗时"那一栏直接印服务给的 `-v` 那张表**，不在这儿重新算、
 * 也不从格式里往回抠结构。那张表本来就是数据的一种印法（`src/core/cli/stages.js`）。
 */

/* 纯函数那一半（高亮 / markdown / EPS -> SVG）住在 `render.js` —— 那一份一个 DOM 都不碰，
 * 于是判据能在 node 里直接 import 它（`tests/serve/run.js`）。 */
import {
  highlight, mdToHtml, epsToSvg, drawKindOf, drawBlocks, glslSource, glslVertex, glslSizeOf,
  glslDeclType, STD_LIBS, GALLERY, esc,
  labStats, labConflictsHtml, labRulesHtml, labTreeHtml, labTreeSexpr,
  labSexprEq, labExtOfGrammar, LAB_EMIT_FORMATS,
} from './render.js';

const $ = (s) => document.querySelector(s);
const el = (t, cls, txt) => {
  const n = document.createElement(t);
  if (cls) n.className = cls;
  if (txt !== undefined) n.textContent = txt;
  return n;
};

/* ---------------------------------------------------------------- 主题 */

const ACCENTS = [
  ['#0a84ff', '蓝'], ['#5e5ce6', '紫'], ['#bf5af2', '洋红'], ['#ff375f', '红'],
  ['#ff9f0a', '橙'], ['#30d158', '绿'], ['#40c8e0', '青'], ['#8e8e93', '灰'],
];

function initTheme() {
  const saved = localStorage.getItem('omni.accent');
  if (saved) document.documentElement.style.setProperty('--accent', saved);
  const t = localStorage.getItem('omni.theme');
  if (t) document.documentElement.dataset.theme = t;

  const box = $('#swatches');
  for (const [c, name] of ACCENTS) {
    const b = el('button');
    b.style.background = c;
    b.style.color = c;
    b.title = name;
    b.setAttribute('aria-pressed', String((saved ?? ACCENTS[0][0]) === c));
    b.onclick = () => {
      document.documentElement.style.setProperty('--accent', c);
      localStorage.setItem('omni.accent', c);
      for (const o of box.children) o.setAttribute('aria-pressed', String(o === b));
    };
    box.append(b);
  }
  $('#btn-theme').onclick = () => {
    const cur = document.documentElement.dataset.theme;
    const next = cur === 'dark' ? 'light' : (cur === 'light' ? '' : 'dark');
    if (next) document.documentElement.dataset.theme = next;
    else delete document.documentElement.dataset.theme;
    localStorage.setItem('omni.theme', next);
  };
}

/* ---------------------------------------------------------------- 预览：GLSL
 *
 * 片元着色器直接在页面上跑（WebGL2，一个全屏三角）。**同一格 canvas 反复用** ——
 * 浏览器对 WebGL 上下文的个数有上限（十来个），每换一份文件新建一格很快就黑屏。
 *
 * 喂的 uniform（有就喂）：`u_resolution`/`iResolution`/`u_res`、`u_time`/`iTime`、
 * 以及**任何 `sampler2D`** —— 绑一张现造的棋盘格，不然采样的那几份一片黑。
 * `#version 330 core` 那几份自动换成 `300 es` + 一句精度（判据里那 12 份都是桌面 GL 的写法）。
 */
/* `mx`/`my` 是鼠标在**画布像素**里的位置（y 已经翻成"从下往上"，GL 的惯例），
   `dx`/`dy` 是按下的那一下（Shadertoy 的 `iMouse.zw`）；`frame` 是帧号；
   `paused` 与 `pt` 是暂停那一格（暂停时时间停在 `pt`，不是继续走）。 */
const GL = {
  canvas: null, gl: null, prog: null, raf: 0, t0: 0, tex: null,
  mx: 0, my: 0, dx: 0, dy: 0, down: false, frame: 0, paused: false, pt: 0, bar: null,
  scale: Math.min(2, (typeof window === 'undefined' ? 1 : window.devicePixelRatio) || 1),
};

/** 倍率那一格能按到哪几档（默认那一档跟着屏幕，所以它也在表里）。 */
const GL_SCALES = [0.5, 1, 2];

/** 一张 8×8 的棋盘格（给 `sampler2D` 那几份垫底）。只造一次。 */
function glslCheckerTex(gl) {
  if (GL.tex !== null) return GL.tex;
  const n = 8;
  const px = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = ((x + y) % 2 === 0) ? 230 : 40;
      const i = (y * n + x) * 4;
      px[i] = v; px[i + 1] = v; px[i + 2] = v; px[i + 3] = 255;
    }
  }
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  GL.tex = t;
  return t;
}

/**
 * 编一份片元着色器 + 配套的顶点段，回链好的 program（编不过就 throw，带原话）。
 *
 * 顶点段**照片元段生成**（`glslVertex`）：写着 `in vec2 v_uv;` 的那几份少了对应的
 * 顶点输出在 ES 3.00 上链不上。两处用它 —— 预览那一栏（活的）与首页那一屏（截一张图）。
 */
function glslLink(gl, src) {
  const mk = (type, code) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, code);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(log ?? '编不过');
    }
    return sh;
  };
  const vs = mk(gl.VERTEX_SHADER, glslVertex(src));
  const fs = mk(gl.FRAGMENT_SHADER, glslSource(src));
  const prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? '链不上');
  return prog;
}

function glslRun(src, host) {
  if (GL.raf !== 0) { cancelAnimationFrame(GL.raf); GL.raf = 0; }
  if (GL.canvas === null) {
    GL.canvas = el('canvas', 'gl-canvas');
    GL.gl = GL.canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: false });
  }
  const gl = GL.gl;
  if (gl === null) { host.textContent = '这个浏览器没有 WebGL2'; return; }
  if (GL.canvas.parentElement !== host) { host.textContent = ''; host.append(GL.canvas); }
  /* 上一趟的编译错误那一格要收掉 —— 不收的话改对了它还挂在下面。 */
  for (const n of [...host.querySelectorAll('.gl-err')]) n.remove();
  let prog = null;
  try {
    prog = glslLink(gl, src);
  } catch (e) {
    host.textContent = '';
    const p = el('pre', 'gl-err', String(e.message ?? e));
    host.append(GL.canvas, p);
    return;
  }
  if (GL.prog !== null) gl.deleteProgram(GL.prog);
  GL.prog = prog;
  gl.useProgram(prog);
  const uni = (...names) => {
    for (const n of names) { const l = gl.getUniformLocation(prog, n); if (l !== null) return l; }
    return null;
  };
  const uRes = uni('u_resolution', 'iResolution', 'u_res', 'resolution');
  const uTime = uni('u_time', 'iTime', 'time');
  /* **鼠标与帧号**：喂之前先问源码它声明成什么类型（`glslDeclType`）——
     `iMouse` 按 Shadertoy 的惯例是 `vec4`（xy 当前、zw 按下那一下），自己写的多半是
     `vec2 u_mouse`；帧号有人写 `int iFrame`、有人写 `float`。喂错类型不是"值不对"，
     是 WebGL 当场报 INVALID_OPERATION、整张图不画。 */
  const MOUSE = ['u_mouse', 'iMouse', 'mouse'];
  const FRAME = ['u_frame', 'iFrame', 'frame'];
  const uMouse = uni(...MOUSE);
  const uFrame = uni(...FRAME);
  const mouseTy = glslDeclType(src, MOUSE) ?? 'vec2';
  const frameTy = glslDeclType(src, FRAME) ?? 'int';
  /* `sampler2D` 那几份：绑一张棋盘格。不绑的话默认采样器指着 0 号纹理单元上那张
     "什么都没有"，整块画成黑的 —— 看着像编译失败，其实只是没喂数据。 */
  const uTex = uni('u_tex', 'iChannel0', 'tex', 'texture0');
  if (uTex !== null) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, glslCheckerTex(gl));
    gl.uniform1i(uTex, 0);
  }
  GL.t0 = performance.now();
  GL.frame = 0;
  GL.paused = false;
  GL.pt = 0;
  /* **画多大由文件自己说**（`glslSizeOf`）：vispy 那几份把坐标写死在 128² 上，铺满一格
     大画布的话那个圆点缩在角上。0 = 跟着显示区走（用了分辨率 uniform 的那一族）。 */
  const fixed = glslSizeOf(src);
  GL.canvas.classList.toggle('fixed', fixed > 0);
  /* **动的那一族**：时间、鼠标、帧号任意一格在就要一直画（从前只看时间那一格）。 */
  const live = uTime !== null || uMouse !== null || uFrame !== null;
  const scalable = fixed === 0;
  glslMouseHook();
  glslBar(host, live, scalable);
  const draw = () => {
    const r = host.getBoundingClientRect();
    /* **倍率**：默认跟着屏幕（`devicePixelRatio`，上限 2），画布下面那一条里可以按成
       0.5x / 1x / 2x —— 大着色器在高倍率下会掉帧，而这一栏是给人看的，不是判据。
       尺寸写死在源码里的那一族（`glslSizeOf > 0`）不受它管：那一族的尺寸是答案的一部分。 */
    const w = fixed > 0 ? fixed : Math.max(1, Math.round(r.width * GL.scale));
    const h = fixed > 0 ? fixed : Math.max(1, Math.round((r.height || r.width * 0.6) * GL.scale));
    if (GL.canvas.width !== w || GL.canvas.height !== h) { GL.canvas.width = w; GL.canvas.height = h; }
    gl.viewport(0, 0, w, h);
    if (uRes) gl.uniform2f(uRes, w, h);
    /* 暂停时时间停在按下去那一刻（`GL.pt`），不是"接着走" —— 不然一继续就跳一大段。 */
    const t = GL.paused ? GL.pt : (performance.now() - GL.t0) / 1000;
    if (uTime) gl.uniform1f(uTime, t);
    if (uMouse) {
      if (mouseTy === 'vec4') gl.uniform4f(uMouse, GL.mx, GL.my, GL.dx, GL.dy);
      else if (mouseTy === 'vec3') gl.uniform3f(uMouse, GL.mx, GL.my, GL.down ? 1 : 0);
      else gl.uniform2f(uMouse, GL.mx, GL.my);
    }
    if (uFrame) {
      if (frameTy === 'float') gl.uniform1f(uFrame, GL.frame);
      else gl.uniform1i(uFrame, GL.frame);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!GL.paused) GL.frame += 1;
    if (live) GL.raf = requestAnimationFrame(draw);
  };
  draw();
}

/** 鼠标那一格只挂一次（画布是复用的）。存的是**画布像素**，y 已翻成从下往上。 */
function glslMouseHook() {
  if (GL.canvas === null || GL.canvas.dataset.mouse === '1') return;
  GL.canvas.dataset.mouse = '1';
  const at = (e) => {
    const r = GL.canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / Math.max(1, r.width) * GL.canvas.width;
    const y = (1 - (e.clientY - r.top) / Math.max(1, r.height)) * GL.canvas.height;
    return [x, y];
  };
  GL.canvas.addEventListener('pointermove', (e) => { [GL.mx, GL.my] = at(e); });
  GL.canvas.addEventListener('pointerdown', (e) => {
    [GL.mx, GL.my] = at(e); GL.dx = GL.mx; GL.dy = GL.my; GL.down = true;
  });
  GL.canvas.addEventListener('pointerup', () => { GL.down = false; });
}

/**
 * 画布下面那一条：**暂停/继续**与**重播**。静的那一族（一格动态 uniform 都没有）
 * 不摆这一条 —— 按了也没有任何变化，摆上去就是骗人。
 */
function glslBar(host, live, scalable) {
  if (GL.bar !== null) GL.bar.remove();
  GL.bar = null;
  if (!live && !scalable) return;
  const bar = el('div', 'gl-bar');
  if (live) {
    const pause = el('button', 'icon-btn sm', '⏸');
    pause.title = '暂停 / 继续';
    const again = el('button', 'icon-btn sm', '↺');
    again.title = '从头重播';
    pause.onclick = () => {
      if (GL.paused) {
        GL.t0 = performance.now() - GL.pt * 1000;
        GL.paused = false;
        pause.textContent = '⏸';
      } else {
        GL.pt = (performance.now() - GL.t0) / 1000;
        GL.paused = true;
        pause.textContent = '▶';
      }
    };
    again.onclick = () => { GL.t0 = performance.now(); GL.pt = 0; GL.frame = 0; };
    bar.append(pause, again);
  }
  /* 倍率：0.5x / 1x / 2x 轮着按。**尺寸写死的那一族这一格没用**（画布不跟显示区走），
     所以那时候不摆它 —— 与暂停那一格同一条规矩：按了没变化就别摆。 */
  if (scalable) {
    const sc = el('button', 'icon-btn sm', `${GL.scale}x`);
    sc.title = '画布倍率（0.5 / 1 / 2 —— 大着色器降一档更顺）';
    sc.onclick = () => {
      const i = GL_SCALES.indexOf(GL.scale);
      GL.scale = GL_SCALES[(i + 1) % GL_SCALES.length];
      sc.textContent = `${GL.scale}x`;
    };
    bar.append(sc);
  }
  host.append(bar);
  GL.bar = bar;
}

/**
 * 首页卡片上那张**静态**的着色器缩略图（回 dataURL，失败回 null）。
 *
 * 为什么不给每格卡片一个活的 canvas：浏览器对 WebGL 上下文有个位数的上限，十来张卡片
 * 一人一格当场黑屏。这儿**一格离屏上下文**轮流画每一份，画完截成 PNG 贴进 `<img>` ——
 * 首页要的是"一眼看到图"，不是十个动画一起转。
 */
const THUMB = { canvas: null, gl: null };

function glslThumb(src, px) {
  if (THUMB.canvas === null) {
    THUMB.canvas = document.createElement('canvas');
    THUMB.gl = THUMB.canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true });
  }
  const gl = THUMB.gl;
  if (gl === null) return null;
  const fixed = glslSizeOf(src);
  const n = fixed > 0 ? fixed : px;
  THUMB.canvas.width = n;
  THUMB.canvas.height = n;
  let prog = null;
  try {
    prog = glslLink(gl, src);
  } catch {
    return null;
  }
  gl.useProgram(prog);
  const uni = (...names) => {
    for (const q of names) { const l = gl.getUniformLocation(prog, q); if (l !== null) return l; }
    return null;
  };
  const uRes = uni('u_resolution', 'iResolution', 'u_res', 'resolution');
  const uTime = uni('u_time', 'iTime', 'time');
  const uTex = uni('u_tex', 'iChannel0', 'tex', 'texture0');
  if (uTex !== null) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, glslCheckerTex(gl));
    gl.uniform1i(uTex, 0);
  }
  gl.viewport(0, 0, n, n);
  if (uRes) gl.uniform2f(uRes, n, n);
  /* 带时间的那几份定在 1.4 秒：0 那一刻常常是"什么都还没动"的初始态。 */
  if (uTime) gl.uniform1f(uTime, 1.4);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const url = THUMB.canvas.toDataURL('image/png');
  gl.deleteProgram(prog);
  return url;
}

/* ---------------------------------------------------------------- 首页（展示模式）
 *
 * 展示模式**不是"IDE 把编辑关掉"**（从前是，那没道理：一进来先看一份看不懂的源码）。
 * 它是首页：一屏卡片，每格一张真跑出来的图，点一下进 IDE 打开那份源码。
 * 上哪几格由 `gallery.js` 那张策展的清单说 —— **没有图的例子不上首页**。
 *
 * 缩略图怎么来（三种腿各一种，都是现成的那一套）：
 *   asy   —— 真跑一趟（`/api/run`），EPS 翻成 SVG
 *   glsl  —— 离屏 WebGL2 截一张 PNG（`glslThumb`）
 *   html  —— 就是一份网页，`<iframe srcdoc sandbox>`
 *
 * **一格一格来**（`for await`）：十来格一起冲会把热工人池挤满，而首页是给人看的 ——
 * 先出来的那几格已经能看了。看不见的那几格根本不跑（`IntersectionObserver`）。
 */
async function galleryThumb(card, g) {
  const box = card.querySelector('.shot');
  try {
    if (g.kind === 'asy' || g.kind === 'svg') {
      /* asy 那几格走**默认那条出口**（EPS，页面自己翻）—— 与 IDE 那一页不勾「SVG 出图」
         时同一条路。首页上这几格都是纯路径的二维图，两条出口画出来一样；位图那一族
         （三维、`image()`）只有这条路有（`epsToSvg` 现在会把 PS 的 image 翻成 `<image>`）。 */
      const r = await post('/api/run', { path: g.path });
      const out = (r.stdout ?? '').trim();
      const kind = drawKindOf(out);
      if (kind === null) throw new Error(r.stderr || '这一格没出图');
      box.innerHTML = kind === 'eps' ? epsToSvg(out) : out;
      return;
    }
    const f = await api(`/api/file?path=${encodeURIComponent(g.path)}`);
    if (g.kind === 'glsl') {
      const url = glslThumb(f.text, 320);
      if (url === null) throw new Error('着色器编不过');
      const img = el('img');
      img.src = url;
      img.alt = g.title;
      box.textContent = '';
      box.append(img);
      return;
    }
    if (g.kind === 'html') {
      const fr = el('iframe');
      fr.setAttribute('sandbox', 'allow-scripts allow-modals');
      fr.setAttribute('scrolling', 'no');
      fr.srcdoc = f.text;
      box.textContent = '';
      box.append(fr);
    }
  } catch (e) {
    box.classList.add('bad');
    box.textContent = String(e.message ?? e).slice(0, 120);
  }
}

function renderGallery() {
  const host = $('#gallery-grid');
  if (host === null || host.childElementCount > 0) return;    /* 只铺一次 */
  /* **单体 HTML 那一份只跑得了图那条腿**（`browser-main.js` 里写着哪几个后缀）——
     asy 与 omni 的卡片在那儿只会是一排红字。展示模式的正事是"好看的例子摆出来"，
     所以那两类**不摆**，改在标题下面说一句为什么（`#gallery-note`）。
     判据：`tests/studio/run.js` 里那份"单体里画廊摆的全是它跑得动的"。 */
  const offline = typeof window.__OMNI_LOCAL === 'function';
  const list = offline ? GALLERY.filter((g) => g.kind === 'glsl' || g.kind === 'html') : GALLERY;
  const note = $('#gallery-note');
  if (note !== null && offline) {
    note.hidden = false;
    note.textContent = '这是单体 HTML 那一份：它只带了图那条腿，'
      + `所以 asy 与 omni 那 ${GALLERY.length - list.length} 格没摆上来 —— 要看它们跑 \`omni serve\`。`;
  }
  const jobs = [];
  for (const g of list) {
    const card = el('button', 'card');
    card.innerHTML = `<div class="shot"><span class="dots"></span></div>`;
    const meta = el('div', 'meta');
    meta.append(el('b', '', g.title), el('span', 'note', g.note),
      el('span', 'tag', g.kind));
    card.append(meta);
    card.onclick = async () => {
      setMode('ide');
      await openFile(g.path);
      /* **点进来就跑一趟**（首页上那张图正是跑出来的）：不跑的话进了 IDE 只剩一屏源码，
         而刚刚明明看着那张图 —— 那一下最奇怪。md / glsl / html 那三种的预览是源码本身，
         `openFile` 已经画好了，不必再跑。 */
      if (g.kind === 'asy' || g.kind === 'svg') run();
    };
    host.append(card);
    jobs.push([card, g]);
  }
  /* 看得见的才跑。`IntersectionObserver` 没有的浏览器（很老的）就一格一格全跑。 */
  const queue = [];
  const pump = async () => {
    if (pump.on === true) return;
    pump.on = true;
    while (queue.length > 0) await galleryThumb(...queue.shift());
    pump.on = false;
  };
  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver((es) => {
      for (const e of es) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        const j = jobs.find(([c]) => c === e.target);
        if (j !== undefined) { queue.push(j); pump(); }
      }
    }, { rootMargin: '200px' });
    for (const [c] of jobs) io.observe(c);
  } else {
    queue.push(...jobs);
    pump();
  }
}

/* ---------------------------------------------------------------- 控制台模式
 *
 * matlab / spyder / idle 那一种：命令行 + 变量区 + 绘图区。
 * 会话在服务那侧（`/api/repl`）—— **与终端上 `omni repl` 是同一台机器**
 * （`src/core/repl.js` 的 `Session`），这一页只管画。
 *
 * 续行那一格照 gsl-shell 的做法：服务说 `incomplete` 就把这一行攒着、提示符换成 `…`
 * （它那边的判据是"语法错且消息结尾是 `'<eof>'`"，我们这边是 `Session.lang.complete()`
 *   —— 两边都是"问编译器"，不是在界面上数括号）。
 *
 * **模式是 `mixed`，不是 REPL 默认的 `dynamic`**（量出来的）：控制台的正事是调有类型的
 * 库函数，而 `dynamic` 里 `[[1.0, 2.0], [3.0, 4.0]]` 这种字面量推不成 `list<list<real>>`，
 * `matOf(…)` 当场报"没有匹配的重载"。代价是一个名字不能中途换类型（`x = 10` 之后
 * `x = "s"` 会报）—— 数值控制台上那一条极少用到，而矩阵那一条每句都要。
 */
const CON = { id: `w${Date.now().toString(36)}`, buf: '', hist: [], at: -1, busy: false };
function conLog(text, cls) {
  const box = $('#con-log');
  if (box === null || text === '') return;
  const n = el('div', cls, text.replace(/\n$/, ''));
  box.append(n);
  box.scrollTop = box.scrollHeight;
}

/** 回显自己敲的那一行（带提示符，像终端一样）。 */
function conEcho(line, cont) {
  const box = $('#con-log');
  const n = el('div', 'in');
  n.append(el('span', 'ps', cont ? '… ' : '> '), document.createTextNode(line));
  box.append(n);
  box.scrollTop = box.scrollHeight;
}

/**
 * 一趟的输出该挂哪儿。
 *
 * **看输出，不猜**：以 `<svg` 起头的就是一张图（`std/plot.omni` 的 `show`），挂进绘图栏；
 * 别的原样进日志。与 asy 那条"看 stdout 是不是 `%!PS`"同一条纪律 ——
 * 界面上不该有"这一句会不会出图"的猜测，跑完看一眼就知道。
 */
function conShow(out) {
  if (out === '') return;
  /* **图不一定是整句**（与预览那一栏同一格 `drawBlocks`）：一行里既印了数又印了图的
     时候，图进绘图栏、剩下的字进日志 —— 从前只认"整句以 `<svg` 起头"，那种一行就全成了
     一屏尖括号。一行印好几张图的话最后那张留在栏里（那一栏只有一格）。 */
  const dr = drawBlocks(out);
  if (dr.kind === 'svg') {
    const box = $('#con-plot');
    box.innerHTML = dr.blocks[dr.blocks.length - 1];
    const many = dr.blocks.length > 1 ? `（${dr.blocks.length} 张，摆的是最后一张）` : '';
    conLog(`— 出了一张图${many}（右下） —`, 'note');
    if (dr.rest.trim() !== '') conLog(dr.rest.replace(/\n{2,}/g, '\n').trim(), 'out');
    return;
  }
  conLog(out, 'out');
}

function conVars(vars) {  const box = $('#con-vars');
  const n = $('#con-nvars');
  if (box === null) return;
  if (n !== null) n.textContent = vars.length === 0 ? '' : `${vars.length} 格`;
  if (vars.length === 0) {
    box.textContent = '';
    box.append(el('div', 'hint', '还没有变量'));
    return;
  }
  box.textContent = '';
  for (const v of vars) {
    const row = el('div', 'vars-row');
    row.append(el('span', 'nm', v.name), el('span', 'ty', v.type), el('span', 'vl', v.value));
    row.title = `${v.name} : ${v.type} = ${v.value}`;
    box.append(row);
  }
}

async function conSend(line) {
  if (CON.busy) return;
  const cont = CON.buf !== '';
  conEcho(line, cont);
  CON.buf = cont ? `${CON.buf}\n${line}` : line;
  /* 续行里敲一个空行 = 强制提交（与终端那一路、也与 python 的 REPL 一样）。 */
  const force = cont && line.trim() === '';
  CON.busy = true;
  try {
    const r = await post('/api/repl', {
      session: CON.id, line: CON.buf, lang: $('#con-lang').value, mode: 'mixed',
    });
    if (r.incomplete === true && !force) {
      $('#con-ps1').textContent = '…';
      return;
    }
    CON.buf = '';
    $('#con-ps1').textContent = '>';
    conShow(r.out ?? '');
    conLog(r.err ?? '', 'err');
    conVars(r.vars ?? []);
  } catch (e) {
    CON.buf = '';
    $('#con-ps1').textContent = '>';
    conLog(String(e.message ?? e), 'err');
  } finally {
    CON.busy = false;
  }
}

function initConsole() {
  const inp = $('#con-in');
  if (inp === null) return;
  /* 开头那一行：**有哪几份库**。不写的话没人知道 `import "std/turtle.omni";` 存在 ——
     控制台里没有目录树可翻。那张表钉在真目录上（判据比 `src/lib/*.omni`）。 */
  if ($('#con-log').childElementCount === 0) {
    conLog('omni 控制台 —— 一行一句，表达式自动印值。', 'note');
    conLog(`库：${STD_LIBS.map(([n, d]) => `${n}（${d}）`).join('　')}`, 'note');
    conLog('用法：import "std/plot.omni";　然后 plotLine("t", xs, ys).show()', 'note');
  }
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const v = inp.value;
      inp.value = '';
      if (v.trim() !== '' || CON.buf !== '') {
        if (v.trim() !== '') { CON.hist.push(v); CON.at = CON.hist.length; }
        conSend(v);
      }
      return;
    }
    /* 上下键翻历史 —— 控制台上这一格不做的话，每条命令都要重打一遍。 */
    if (e.key === 'ArrowUp' && CON.hist.length > 0) {
      e.preventDefault();
      CON.at = Math.max(0, CON.at - 1);
      inp.value = CON.hist[CON.at] ?? '';
      return;
    }
    if (e.key === 'ArrowDown' && CON.hist.length > 0) {
      e.preventDefault();
      CON.at = Math.min(CON.hist.length, CON.at + 1);
      inp.value = CON.at === CON.hist.length ? '' : (CON.hist[CON.at] ?? '');
    }
  });
  $('#con-lang').onchange = (e) => {
    $('#con-lang-tag').textContent = e.target.value;
    CON.buf = '';
    $('#con-ps1').textContent = '>';
    conLog(`— 换成 ${e.target.value}：开一格新会话 —`, 'note');
    conVars([]);
    post('/api/repl', { session: CON.id, line: '', lang: e.target.value, reset: true })
      .catch(() => {});
  };
  $('#con-reset').onclick = async () => {
    CON.buf = '';
    $('#con-ps1').textContent = '>';
    const r = await post('/api/repl', {
      session: CON.id, line: '', lang: $('#con-lang').value, reset: true,
    });
    $('#con-log').textContent = '';
    conLog('— 会话忘掉了 —', 'note');
    conVars(r.vars ?? []);
  };
}

/* ---------------------------------------------------------------- 预览：派发
 *
 * 四种：markdown 排版、asy 的图（EPS -> SVG）、glsl 的着色器（WebGL2）、html 的页面
 * （`<iframe>` —— 那本来就是浏览器自己的活，我们一个字都不用译）。
 * 都没有的时候这一栏空着 —— 但**栏本身不拆**（拆了会让右边整块跳一下，见 `openFile`）。
 */
function renderPreview(kind, payload) {
  const host = $('#preview');
  const tab = document.querySelector('#out-tabs button[data-tab="preview"]');
  if (kind === null) {
    host.textContent = '';
    host.classList.add('empty');
    tab.disabled = true;
    return;
  }
  tab.disabled = false;
  host.classList.remove('empty');
  if (kind === 'md') { host.innerHTML = `<article class="md">${mdToHtml(payload)}</article>`; return; }
  if (kind === 'eps') {
    const svg = epsToSvg(payload);
    host.innerHTML = `<div class="svg-wrap">${svg}</div>`;
    return;
  }
  /* 原生 SVG 出口（`-f svg`）与"stdout 本身就是 SVG"那一族：原样挂。
     **不经 `epsToSvg`** —— 那一格只认 PS 算子。`payload` 可以是一块，也可以是好几块
     （一趟印了好几张图）—— 一块一格 `.svg-wrap`，竖着摆。 */
  if (kind === 'svg') {
    const blocks = Array.isArray(payload) ? payload : [payload];
    const wraps = blocks.map((s) => `<div class="svg-wrap">${s}</div>`).join('');
    /* 一张就照老样子（`.preview` 是 flex，居中那一套靠它）；好几张套一格竖着排的容器 ——
       不套的话两张会被 flex 并排挤扁。 */
    host.innerHTML = blocks.length === 1 ? wraps : `<div class="svg-list">${wraps}</div>`;
    return;
  }
  if (kind === 'html') {
    /* `srcdoc` + `sandbox="allow-scripts"`：脚本照跑（例子里有 canvas 动画），
     * 可它**没有同源身份** —— 碰不到这一页的 DOM、cookie、也不能往上跳转。
     * 这一栏本来就是"给一段 html 一个浏览器"，多一层沙箱是白送的。 */
    const f = el('iframe', 'html-frame');
    f.setAttribute('sandbox', 'allow-scripts allow-modals');
    f.srcdoc = payload;
    host.textContent = '';
    host.append(f);
    return;
  }
  if (kind === 'glsl') glslRun(payload, host);
}

/**
 * 这一份文件的预览是哪一种（没有回 null）。
 *
 * ⚠️ **asy 不在这儿说话**：它到底有没有图要等跑完看 stdout 是不是 EPS ——
 * `tests/asy/cases` 底下一百多份是**算术例子**，一张图都不出。从前这儿一律回 `eps`，
 * 于是打开任何 `.asy` 都往"预览"栏切一下、而那栏是空的。现在由 `run()` 收到
 * `%!PS` 才点亮那一栏（见 `run` 里那一句）。
 */
function previewKind(lang) {
  if (lang === 'markdown') return 'md';
  if (lang === 'glsl') return 'glsl';
  if (lang === 'html') return 'html';
  return null;
}

/* ---------------------------------------------------------------- 状态 */

const S = { tree: null, path: null, lang: 'text', text: '', busy: false, seq: 0 };

/**
 * 与"服务"说话的**唯一一处**。
 *
 * 两种跑法共用这一格：连着 `omni serve` 时走 `fetch`；单体 HTML 那一份里
 * `window.__OMNI_LOCAL` 已经挂上了一台"就在本页跑"的服务（`src/studio/browser-main.js`），
 * 形状与 `/api/*` 逐字相同，于是这份 UI **一行都不用分叉**。
 * 这一格就是那条边界 —— 别在别处再写 `fetch`。
 */
const api = async (p, init) => {
  if (typeof window !== 'undefined' && window.__OMNI_LOCAL !== undefined) {
    return window.__OMNI_LOCAL(p, init);
  }
  const r = await fetch(p, init);
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
};
const post = (p, body) => api(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
/** 保存 / 新建走 PUT（服务那侧按 method 分支：GET 是读、PUT 是写）。 */
const put = (p, body) => api(p, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/* ---------------------------------------------------------------- 目录树 */

function countFiles(n) {
  if (n.kind === 'file') return 1;
  return (n.children ?? []).reduce((a, k) => a + countFiles(k), 0);
}

/** 展开那个三角形。SVG 而不是 `▸` —— 字形三角在各字体里大小差得离谱，也点不着。 */
function caretSvg() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 10 10');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M3 1.5 L7.5 5 L3 8.5 Z');
  s.append(p);
  return s;
}

/**
 * 一格节点。
 *
 * **"开着"与"孩子建了没有"必须同时改**（第一次点击没反应那个 bug）：从前根节点一上来就
 * 加 `.open`，可孩子是懒建的、那时还没建 —— 于是看起来是"合着的、三角却朝下"，
 * 第一次点击把 `.open` 去掉（看起来才对上：三角转回右），第二次点击才真的展开。
 * 现在只有 `setOpen` 一处改这件事，它先保证孩子在、再改类名。
 */
function renderNode(n, depth) {
  const box = el('div', 'node');
  const row = el('div', `row ${n.kind}${n.dirty === true ? ' dirty' : ''}`);
  const caret = el('span', 'caret');
  if (n.kind === 'dir') caret.append(caretSvg());
  row.append(caret);
  row.append(el('span', 'nm', n.name));
  if (n.kind === 'dir') row.append(el('span', 'cnt', String(countFiles(n))));
  row.title = n.path;
  box.append(row);
  if (n.kind === 'dir') {
    const kids = el('div', 'kids');
    box.append(kids);
    /* **懒展开**：一千多格一次全建 DOM 会卡，展开那一刻才建。 */
    let built = false;
    const setOpen = (on) => {
      if (on && !built) {
        for (const k of n.children ?? []) kids.append(renderNode(k, depth + 1));
        built = true;
      }
      box.classList.toggle('open', on);
      row.setAttribute('aria-expanded', String(on));
    };
    row.onclick = () => setOpen(!box.classList.contains('open'));
    if (depth === 0) setOpen(true);          // 顶层默认展开 —— 孩子也就在这一刻建好
    else setOpen(false);
  } else {
    row.onclick = () => { openFile(n.path, row); };
  }
  return box;
}

async function loadTree() {
  S.tree = await api('/api/tree');
  const body = $('#tree-body');
  body.textContent = '';
  for (const r of S.tree.roots) body.append(renderNode(r, 0));
}

/** 过滤：把不含这串的文件行藏起来（目录跟着空就藏）。 */
function applyFilter(q) {
  const s = q.trim().toLowerCase();
  for (const row of $('#tree-body').querySelectorAll('.row.file')) {
    const hit = s === '' || row.querySelector('.nm').textContent.toLowerCase().includes(s);
    row.parentElement.style.display = hit ? '' : 'none';
  }
  /* 有过滤串时把所有目录摊开 —— 不然藏在折叠里的命中看不见。 */
  if (s !== '') for (const n of $('#tree-body').querySelectorAll('.node')) n.classList.add('open');
}

/* ---------------------------------------------------------------- 代码区 */

/**
 * 重画高亮那一层。
 *
 * **实参是"现在编辑器里的那份文本"**，不是 `S.text`。两者故意分开：
 * `S.text` 是"上一次与服务对齐过的内容"，`run()` 拿它判 dirty；高亮要画的是**当下**。
 * 从前这儿读 `S.text` 而 `input` 处理函数顺手把 `S.text` 也改了 —— 于是 dirty 永远为假，
 * **用户改了没有效果**（改过的源码根本没递出去）。那是两个 bug 共用一格变量的后果。
 *
 * 末尾补一格 `\n`：`<pre>` 会把最后一个换行吞掉，而 textarea 不会 —— 少了它，
 * 在文件末尾敲回车时高亮层比光标短一行（"输入错位"里最常见的那一种）。
 */
function paint(text) {
  $('#view').firstElementChild.innerHTML = `${highlight(text, S.lang)}\n`;
}

/**
 * 打开一份文件。
 *
 * **切之前先把当前这份存下来**（改过的话）：用户切走再切回来，改动还在 —— 那是
 * "虚拟文件系统"这四个字的最低要求。存去哪见 `serve.js` 的 `EDITS`（仓库里一个字节不动）。
 *
 * **别在这儿清输出区**（"闪烁"那一条）：从前这儿先把 stdout/stderr/阶段三格清空、
 * 再去跑 —— 于是切一份例子看得见"空一下再填回来"，连滚动条都跟着出现又消失。
 * 现在的做法是**旧结果留在原处、整块压暗**（`.stale`），新结果到了一次换掉。
 * 跑不了的那几门（`.md` 之类）才真的清 —— 它们本来就没有输出。
 */
async function openFile(path, row) {
  await stash();
  for (const r of $('#tree-body').querySelectorAll('.row.on')) r.classList.remove('on');
  if (row) row.classList.add('on');
  setStatus('读…', '');
  let f = null;
  try {
    f = await api(`/api/file?path=${encodeURIComponent(path)}`);
  } catch (e) {
    setStatus('读不到', 'bad');
    $('#stderr').textContent = `${path}：${e.message ?? e}`;
    return;
  }
  S.path = f.path; S.lang = f.lang; S.text = f.text;
  $('#cur-path').textContent = f.path;
  $('#cur-lang').textContent = f.lang === 'text' ? '' : f.lang;
  $('#edit').value = f.text;
  paint(f.text);
  $('#view').scrollTop = 0; $('#edit').scrollTop = 0;
  const runnable = RUNNABLE.has(f.lang);
  $('#btn-run').disabled = !runnable;
  /* js 那个开关只在 js 上有意义 —— 别的语言上藏起来（不是置灰：省一格视觉噪声）。
     asy 的出口开关同一条规矩。 */
  $('#js-parse-box').hidden = f.lang !== 'js';
  $('#asy-svg-box').hidden = f.lang !== 'asy';
  closeDrawer();
  setStatus(f.dirty === true ? '改过' : '', '');
  const kind = previewKind(f.lang);
  /* md / glsl / html 的预览**不用跑**：源码就是全部输入，立刻画。
     asy 不在这儿点亮那一栏 —— 它出不出图要等 stdout（见 `previewKind` 的头注）。 */
  renderPreview(kind, f.text);
  showPreviewTab(kind !== null);
  if (runnable) {
    markStale(true);
    run();
  } else {
    markStale(false);
    $('#stdout').textContent = ''; $('#stderr').textContent = '';
    $('#stages').textContent = '';
  }
}

/** 旧结果压暗（新的还在路上）。**不动 DOM 结构** —— 只加一格类名。 */
function markStale(on) {
  $('.out-body').classList.toggle('stale', on);
}

/** 有预览就把那一栏点亮、并切过去；没有就退回"输出"。 */
function showPreviewTab(has) {
  const tabs = $('#out-tabs');
  const pv = tabs.querySelector('button[data-tab="preview"]');
  const cur = tabs.querySelector('button.on');
  if (has) selectTab(pv);
  else if (cur === pv) selectTab(tabs.querySelector('button[data-tab="stdout"]'));
}

function selectTab(b) {
  if (!b) return;
  for (const o of $('#out-tabs').children) o.classList.toggle('on', o === b);
  for (const p of document.querySelectorAll('.tabp')) {
    p.classList.toggle('on', p.dataset.tab === b.dataset.tab);
  }
}

/** 把编辑器里改过的内容存进虚拟文件系统（没改就什么都不做）。 */
async function stash() {
  if (S.path === null) return;
  const now = $('#edit').value;
  if (now === S.text) return;
  try { await put('/api/file', { path: S.path, text: now }); S.text = now; }
  catch { /* 存不上不拦着用户切文件 */ }
}

/** 能跑的那几门（别的只展示 —— 比如 `.md`）。 */
const RUNNABLE = new Set(['omni', 'sx', 'go', 'c', 'asy', 'js', 'lua', 'nim', 'v', 'mojo',
  'cpp', 'awk', 'scheme', 'lisp', 'basic', 'jancy', 'wat']);

/** 关掉窄屏那个抽屉（连遮罩一起）。`main` 里把遮罩挂上来。 */
let DRAWER_MASK = null;
function closeDrawer() {
  $('#tree').classList.remove('open');
  if (DRAWER_MASK !== null) DRAWER_MASK.style.display = 'none';
}

function setStatus(txt, kind) {
  const b = $('#status');
  b.textContent = txt;
  b.className = `badge${kind ? ` ${kind}` : ''}`;
}

/* ---------------------------------------------------------------- 运行 */

/**
 * 跑当前这份文件。
 *
 * **改过的源码怎么跑**：body 里带 `text`，服务落一格暂存再跑（不动仓库里的文件）。
 * 没改过就只递 path —— 那时连暂存都不用。
 */
/**
 * 跑当前这份文件。
 *
 * 五条要紧的：
 *
 * 1. **不因为"上一趟还在跑"就不跑**。从前这儿 `if (S.busy) return` —— 实时模式下
 *    上一趟在路上时最后那几下键就被丢了，表现成"改了没有效果"。现在照发，
 *    靠 `S.seq` 丢掉旧回包（"只认最后一趟"本来就是这一层的规矩）。
 * 2. **改过的源码只走一趟往返**。`body.text` 递过去，服务那侧顺手就把它写进虚拟文件系统
 *    （`serve.js` 的 `putEdit`）—— 不必先 PUT 再 POST。实时模式下那省掉的是一半延迟。
 * 3. 状态栏印 `ms` 与 `via`（warm/cold）—— "实时"这件事得**看得见**。
 * 4. **运行按钮只在"真的等得住"时才置灰**（`BTN_GRACE` 毫秒）。热工人那侧大半趟
 *    8~40ms，比人眼能分辨的一帧还短 —— 灰一下再亮回来纯是闪。到点还没回来才置灰，
 *    那时它是**有用的信息**（"这一趟真的慢"）。
 * 5. **js 默认原样交给 node**（`--direct`）。要对照我们那条腿时把"我们的解析"那格勾上。
 *    理由：这一页的用处之一是拿真 node 当参照，默认走我们的前端会让"对照"这件事
 *    每次都要先想一下。
 */
const BTN_GRACE = 150;

async function run() {
  if (S.path === null) return;
  const my = ++S.seq;
  S.busy = true;
  /* 到点还没回来才置灰（见头注第 4 条）。 */
  const graceTimer = setTimeout(() => {
    if (my === S.seq && S.busy) { $('#btn-run').disabled = true; $('#btn-run').classList.add('busy'); }
  }, BTN_GRACE);
  setStatus('跑…', '');
  const t0 = performance.now();
  const currentText = $('#edit').value;
  const dirty = currentText !== S.text;
  const direct = S.lang === 'js' && !$('#js-parse').checked;
  /* asy 的出口：勾着就走**原生 SVG**（`-f svg`），不勾是 EPS 由这一页翻。
     旗子进 argv 那一格在服务那侧带白名单（`serve.js` 的 `RUN_FORMATS`）。 */
  const format = S.lang === 'asy' && $('#asy-svg').checked ? 'svg' : undefined;
  try {
    const r = await post('/api/run', {
      path: S.path,
      text: dirty ? currentText : undefined,
      lang: S.lang,
      direct,
      format,
      verbose: true,
    });
    /* **只认最后一趟**：实时模式下旧的回包要丢掉，不然结果会往回跳。 */
    if (my !== S.seq) return;
    /* 递过去的那一份服务已经存住了 —— 这儿跟上，于是下一趟不必再递。 */
    if (dirty) S.text = currentText;
    const ms = Math.round(performance.now() - t0);
    $('#stdout').textContent = r.stdout ?? '';
    $('#stderr').textContent = r.stderr ?? '';
    renderStages(r.stages, r.stderr ?? '', ms);
    markStale(false);
    /* **看输出决定预览挂什么 —— 与语言无关**（从前这一格只问 asy）。
       一份 `.omni` 跑出来 stdout 是一张 SVG（`std/plot.omni` 的 `show()`），那也是图；
       从首页点进来看到的正是那张图，进了 IDE 却只有一堆尖括号 —— 那才奇怪。
       图不一定在开头（`tests/cases/27_plot.omni` 印的是字节数 + SVG + 字节数），
       所以用 `drawBlocks` 整块抠。`cases/` 底下那些算术例子照旧一张图都没有，
       那时候**不点亮"预览"栏、也不切过去**。 */
    const dr = drawBlocks(r.stdout ?? '');
    if (dr.kind !== null) {
      renderPreview(dr.kind, dr.kind === 'svg' ? dr.blocks : r.stdout);
      showPreviewTab(true);
    } else if (previewKind(S.lang) === null) {
      /* 这一趟没有图，而这门语言的预览也不是"源码本身"（md / glsl / html 那三种是）
         —— 那就把上一趟留下的图收掉。 */
      renderPreview(null, '');
      showPreviewTab(false);
    }
    const via = r.via === 'warm' ? '' : ' · 冷';
    const how = direct ? ' · node' : '';
    setStatus(`${r.code === 0 ? 'ok' : `exit ${r.code}`} · ${ms}ms${via}${how}`, r.code === 0 ? 'ok' : 'bad');
  } catch (e) {
    if (my === S.seq) {
      $('#stderr').textContent = String(e.message ?? e);
      markStale(false);
      setStatus('失败', 'bad');
    }
  } finally {
    clearTimeout(graceTimer);
    if (my === S.seq) {
      S.busy = false;
      $('#btn-run').classList.remove('busy');
      $('#btn-run').disabled = !RUNNABLE.has(S.lang);
    }
  }
}

/**
 * 阶段那一栏。
 *
 * 服务给了结构化的 `stages` 就按列排；没给就**原样印 `-v` 那张表** ——
 * 那本来就是同一份数据的一种印法，不在这儿从格式里往回抠结构。
 */
function renderStages(stages, stderrText, totalMs) {
  const box = $('#stages');
  const rows = Array.isArray(stages) && stages.length > 0
    ? stages.map((s, i) => [String(i + 1), s.phase ?? '', s.verb ?? '', s.in ?? '', s.out ?? '',
      s.ms === undefined ? '' : `${s.ms}ms`])
    : null;
  if (rows === null) {
    box.textContent = '';
    const lines = stderrText.split('\n').filter((l) => l.startsWith('omni:') || /\+\d+ms$/.test(l));
    box.append(el('pre', '', lines.length > 0 ? lines.join('\n') : '（这一趟没有阶段信息：加 -v）'));
  } else {
    /* **按行复用**，不是每趟重建 DOM（与目录树那一格同一条纪律）：实时模式下这一栏
       一秒能重画好几遍，整块拆掉再拼会闪、还会把选中的文字弄丢。行数对不上时才加/删。
       **末尾那行"合计"先摘掉**（它带 `st-tot`）—— 不摘的话它会被当成一行数据复用，
       而新的合计又往后加一行，每跑一趟多一行。 */
    for (const n of [...box.children]) {
      if (!n.classList.contains('st-row') || n.classList.contains('st-tot')) n.remove();
    }
    while (box.childElementCount > rows.length) box.lastElementChild.remove();
    while (box.childElementCount < rows.length) {
      const row = el('div', 'st-row');
      for (const cls of ['', 'ph', '', '', '', 'ms']) row.append(el('span', cls));
      box.append(row);
    }
    rows.forEach((cells, i) => {
      const row = box.children[i];
      cells.forEach((txt, k) => {
        if (row.children[k].textContent !== txt) row.children[k].textContent = txt;
      });
    });
  }
  const tot = el('div', 'st-row st-tot');
  tot.append(el('span', '', ''));
  tot.append(el('span', 'ph', '合计'));
  tot.append(el('span', '', 'wall'));
  tot.append(el('span', '', ''));
  tot.append(el('span', '', ''));
  tot.append(el('span', 'ms', `${totalMs}ms`));
  box.append(tot);
}

/* ---------------------------------------------------------------- 虚拟 shell */

const shLog = (txt, cls) => {
  const n = el('div', cls, txt);
  $('#sh-log').append(n);
  $('#sh-log').scrollTop = $('#sh-log').scrollHeight;
};

/** 树上找一格路径（`ls` / `cat` 用；没有回 null）。 */
function findNode(path) {
  const walk = (n) => {
    if (n.path === path) return n;
    for (const k of n.children ?? []) { const r = walk(k); if (r) return r; }
    return null;
  };
  for (const r of S.tree?.roots ?? []) { const x = walk(r); if (x) return x; }
  return null;
}

let CWD = '';

async function shell(line) {
  shLog(`$ ${line}`, 'ps1-line');
  const parts = line.trim().split(/\s+/);
  const cmd = parts[0];
  /* ---- 纯前端那几格（不打服务） ---- */
  if (cmd === 'clear') { $('#sh-log').textContent = ''; return; }
  if (cmd === 'pwd') { shLog(CWD === '' ? '/' : `/${CWD}`); return; }
  if (cmd === 'cd') {
    const t = parts[1] ?? '';
    CWD = t === '' || t === '/' ? '' : (t === '..' ? CWD.slice(0, Math.max(0, CWD.lastIndexOf('/'))) : (CWD ? `${CWD}/${t}` : t));
    return;
  }
  if (cmd === 'ls') {
    const p = parts[1] ?? CWD;
    const n = p === '' ? { children: S.tree?.roots ?? [] } : findNode(p);
    if (n === null) { shLog(`ls: ${p}: 没有这一格`, 'err'); return; }
    shLog((n.children ?? []).map((k) => (k.kind === 'dir' ? `${k.name}/` : k.name)).join('  '));
    return;
  }
  if (cmd === 'cat') {
    const p = parts[1];
    if (!p) { shLog('cat: 要一个路径', 'err'); return; }
    try { const f = await api(`/api/file?path=${encodeURIComponent(p)}`); shLog(f.text); }
    catch { shLog(`cat: ${p}: 读不到`, 'err'); }
    return;
  }
  /* ---- 别的一律交给服务（含 tcc/go/nim 等效命令的翻译，翻在服务那侧） ---- */
  try {
    const r = await post('/api/shell', { line, cwd: CWD });
    if (r.stdout) shLog(r.stdout.replace(/\n$/, ''));
    if (r.stderr) shLog(r.stderr.replace(/\n$/, ''), 'err');
    if (r.code !== 0) shLog(`exit ${r.code}`, 'err');
  } catch (e) { shLog(String(e.message ?? e), 'err'); }
}

/* ---------------------------------------------------------------- 实验室（Lab） */

/** GLR 模块迟装：这几份不碰 node，但 serve 模式下也可以不装（如果不进 Lab 模式）。 */
let GLR = null;
async function ensureGlr() {
  if (GLR !== null) return;
  /* 单体 HTML 模式：`browser-main.js` 把 GLR 模块挂在 `window.__OMNI_GLR` 上。
     serve 模式：从 `/core/…` 动态拉模块（serve.js 映射 `/core/…` 到 `src/core/…`）。
     **动态 import 写成字符串拼接**以避免 bundle-studio 的 import 检查（那一格只查静态写法）。 */
  if (window.__OMNI_GLR !== undefined) {
    GLR = window.__OMNI_GLR;
    return;
  }
  const base = '/core/';
  const load = (p) => Function('return import("' + base + p + '")')();
  const [read, diag, grammar, table, driver, lex] = await Promise.all([
    load('sexpr/read.js'),
    load('source/diag.js'),
    load('glr/grammar.js'),
    load('glr/table.js'),
    load('glr/driver.js'),
    load('glr/lex.js'),
  ]);
  GLR = { ...diag, ...read, ...grammar, ...table, ...driver, ...lex };
}

const LAB_TEMPLATES = {
  expr: `;; 经典算术表达式：语法本身有歧义，全靠优先级消掉。
;; 门槛是**零冲突** —— 如果优先级实现错了，这份语法立刻会剩下一堆移进/归约。
(grammar expr
  (tokens NUM UMINUS)
  (prec left "+" "-")
  (prec left "*" "/")
  (prec right "^")
  (prec right UMINUS)
  (start E)
  (lex
    (skip space)
    (comment ";;" (* (not "\\n")))
    (token NUM (+ digit) (? "." (+ digit)))
    (op "+" "-" "*" "/" "^" "(" ")"))
  (rule E
    (-> (E "+" E) (add $1 $3))
    (-> (E "-" E) (sub $1 $3))
    (-> (E "*" E) (mul $1 $3))
    (-> (E "/" E) (div $1 $3))
    (-> (E "^" E) (pow $1 $3))
    (-> ("-" E) (prec UMINUS) (neg $2))
    (-> ("(" E ")") $2)
    (-> (NUM) $1)))`,
  empty: `(grammar scratch
  (tokens NUM NAME)
  (start S)
  (lex
    (skip space)
    (token NUM (+ digit))
    (token NAME (+ alpha))
    (op "(" ")"))
  (rule S
    (-> (NAME) $1)))`,
};

const LAB = {
  inited: false,
  timer: null,
  grammarText: '',
  sampleText: '',
  lastTable: null,
  lastTree: null,
  /** 示例面板那几组（输入, 期望）。**内联的判据** —— 改一条规则就看它们变不变。 */
  examples: null,
};

function labSelectTab(btn) {
  const parent = btn.parentElement;
  const body = document.querySelector('.lab-body');
  for (const b of parent.children) b.classList.toggle('on', b === btn);
  for (const p of body.children) p.classList.toggle('on', p.dataset.tab === btn.dataset.tab);
  /* 管线与示例两栏是**按需算**的（前者走网络，后者要跑一遍解析）——
     切过去的那一下才刷，不然每敲一个字都白算两栏。 */
  if (btn.dataset.tab === 'lab-pipeline') labRefreshPipeline();
  if (btn.dataset.tab === 'lab-examples') labRefreshExamples();
}

function labPaintGrammar(text) {
  /* S-expression 语法高亮（复用 lisp 那套）。 */
  $('#lab-gview code').innerHTML = highlight(text, 'lisp') + '\n';
}

function labPaintSample(text) {
  /* 示例源码暂时不做语法高亮（那门语言的词法表还在上面编着）。 */
  $('#lab-sview code').textContent = text + '\n';
}

/** 在浏览器里重建语法表 + 重解析 + 刷新面板。 */
async function labRefresh() {
  await ensureGlr();
  const gText = LAB.grammarText;
  const sText = LAB.sampleText;
  const status = $('#lab-status');
  const tablePanel = $('#lab-table');
  const treePanel = $('#lab-tree-panel');

  /* 1. 读 S-expression */
  const diags = new GLR.Diagnostics();
  const sf = new GLR.SourceFile('<lab>', gText);
  const nodes = GLR.readSexpr(sf, diags);
  if (diags.errorCount() > 0) {
    status.textContent = '语法错误';
    status.className = 'badge bad';
    tablePanel.innerHTML = `<div class="hint" style="color:var(--bad)">`
      + diags.items.map((d) => d.msg).join('<br>') + '</div>';
    treePanel.innerHTML = '';
    LAB.lastTable = null;
    LAB.lastTree = null;
    return;
  }

  /* 2. 建表 */
  const g = GLR.readGrammar(nodes, diags);
  if (g === null || diags.errorCount() > 0) {
    status.textContent = '语法无效';
    status.className = 'badge bad';
    tablePanel.innerHTML = `<div class="hint" style="color:var(--bad)">`
      + diags.items.map((d) => d.msg).join('<br>') + '</div>';
    treePanel.innerHTML = '';
    LAB.lastTable = null;
    LAB.lastTree = null;
    return;
  }

  let tb;
  try { tb = GLR.buildTable(g); } catch (e) {
    status.textContent = '建表失败';
    status.className = 'badge bad';
    tablePanel.innerHTML = `<div class="hint" style="color:var(--bad)">${e.message}</div>`;
    LAB.lastTable = null;
    return;
  }
  LAB.lastTable = tb;

  /* 3. 表面板 */
  const st = labStats(tb);
  status.textContent = st.conflicts === 0 ? `${st.states} 状态` : `${st.conflicts} 冲突`;
  status.className = st.conflicts === 0 ? 'badge ok' : 'badge bad';
  tablePanel.innerHTML = '<div class="lab-stats">'
    + labStatHtml('状态', st.states, false)
    + labStatHtml('记号', st.terms, false)
    + labStatHtml('非终结符', st.nonterms, false)
    + labStatHtml('规则', st.rules, false)
    + labStatHtml('冲突', st.conflicts, st.conflicts === 0)
    + '</div>'
    + labConflictsHtml(tb)
    + labRulesHtml(tb);

  /* 4. 解析示例 */
  if (sText.trim() && g.lex) {
    const sd = new GLR.Diagnostics();
    const ssf = new GLR.SourceFile('<sample>', sText);
    const toks = GLR.lexText(g.lex, ssf, sd);
    if (sd.errorCount() > 0) {
      treePanel.innerHTML = '<div class="hint" style="color:var(--bad)">词法错误：'
        + sd.items.map((d) => d.msg).join('; ') + '</div>';
      LAB.lastTree = null;
    } else {
      const pd = new GLR.Diagnostics();
      const tree = GLR.glrParse(tb, toks, pd);
      LAB.lastTree = tree;
      if (pd.errorCount() > 0) {
        treePanel.innerHTML = '<div class="hint" style="color:var(--bad)">语法错误：'
          + pd.items.map((d) => d.msg).join('; ') + '</div>'
          + labTreeHtml(tree);
      } else {
        treePanel.innerHTML = labTreeHtml(tree)
          + '<hr style="border:0;border-top:1px solid var(--line);margin:12px 0">'
          + '<pre style="font:12px/1.6 var(--mono);color:var(--fg-2);white-space:pre-wrap">'
          + labTreeSexpr(tree) + '</pre>';
      }
    }
  } else {
    treePanel.innerHTML = '<div class="hint">在下面写一段示例代码，这里会显示解析树。</div>';
    LAB.lastTree = null;
  }

  /* 5. 管线面板（只在选中时触发，走网络） */
  labRefreshPipeline();

  /* 6. 示例面板 */
  labRefreshExamples();
}

function labStatHtml(label, n, isOk) {
  const cls = isOk ? ' ok' : (label === '冲突' && n > 0 ? ' bad' : '');
  return `<div class="lab-stat"><div class="n${cls}">${n}</div><div class="lbl">${label}</div></div>`;
}

function labScheduleRefresh() {
  if (LAB.timer !== null) clearTimeout(LAB.timer);
  LAB.timer = setTimeout(() => { LAB.timer = null; labRefresh(); }, 250);
}

/** 一次性初始化（懒：第一次进 Lab 模式才调）。 */
async function initLab() {
  if (LAB.inited) {
    $('#lab-grammar').focus();
    return;
  }
  LAB.inited = true;

  const gta = $('#lab-grammar');
  const sta = $('#lab-sample');

  /* 语法编辑器事件 */
  gta.addEventListener('input', () => {
    LAB.grammarText = gta.value;
    labPaintGrammar(gta.value);
    labScheduleRefresh();
  });
  gta.addEventListener('scroll', () => {
    const v = $('#lab-gview');
    v.scrollTop = gta.scrollTop;
    v.scrollLeft = gta.scrollLeft;
  });
  gta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); labInsert(gta, '  '); }
  });

  /* 示例编辑器事件 */
  sta.addEventListener('input', () => {
    LAB.sampleText = sta.value;
    labPaintSample(sta.value);
    labScheduleRefresh();
  });
  sta.addEventListener('scroll', () => {
    const v = $('#lab-sview');
    v.scrollTop = sta.scrollTop;
    v.scrollLeft = sta.scrollLeft;
  });
  sta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); labInsert(sta, '  '); }
  });

  /* 加载项目语法的下拉框 */
  const sel = $('#lab-load');
  /* 模板选项 */
  const optExpr = document.createElement('option');
  optExpr.value = '__tpl:expr'; optExpr.textContent = '模板：算术表达式';
  sel.appendChild(optExpr);
  const optEmpty = document.createElement('option');
  optEmpty.value = '__tpl:empty'; optEmpty.textContent = '模板：空白';
  sel.appendChild(optEmpty);

  /* 项目里的 .grammar 文件 */
  try {
    const tree = await api('/api/tree');
    const paths = [];
    (function walk(nodes, prefix) {
      for (const n of nodes) {
        const p = prefix ? prefix + '/' + n.name : n.name;
        if (n.kind === 'dir') walk(n.children ?? [], p);
        else if (p.endsWith('.grammar')) paths.push(p);
      }
    })(tree, '');
    if (paths.length > 0) {
      const sep = document.createElement('option');
      sep.disabled = true; sep.textContent = '— 项目语法 —';
      sel.appendChild(sep);
      for (const p of paths.sort()) {
        const o = document.createElement('option');
        o.value = p; o.textContent = p.replace(/^(ext|src|tests)\//, '');
        sel.appendChild(o);
      }
    }
  } catch { /* 单体模式没有 /api/tree */ }

  sel.onchange = async () => {
    const v = sel.value;
    if (!v) return;
    if (v.startsWith('__tpl:')) {
      const key = v.slice(6);
      gta.value = LAB_TEMPLATES[key] ?? '';
    } else {
      try {
        const f = await api(`/api/file?path=${encodeURIComponent(v)}`);
        gta.value = f.text;
      } catch { gta.value = `;; 读不到 ${v}`; }
    }
    LAB.grammarText = gta.value;
    labPaintGrammar(gta.value);
    labScheduleRefresh();
  };

  /* 默认填一份模板 */
  gta.value = LAB_TEMPLATES.expr;
  LAB.grammarText = gta.value;
  labPaintGrammar(gta.value);
  sta.value = '1 + 2 * 3';
  LAB.sampleText = sta.value;
  labPaintSample(sta.value);
  gta.focus();
  labRefresh();
}

function labInsert(ta, s) {
  const a = ta.selectionStart;
  ta.value = ta.value.slice(0, a) + s + ta.value.slice(ta.selectionEnd);
  ta.selectionStart = ta.selectionEnd = a + s.length;
  ta.dispatchEvent(new Event('input'));
}

/* ---- 管线面板 ---- */

let labPipelineSeq = 0;

async function labRefreshPipeline() {
  const panel = $('#lab-pipeline');
  /* 只在管线 tab 选中时才发请求（省网络）。 */
  const btn = document.querySelector('#lab-tabs button[data-tab="lab-pipeline"]');
  if (!btn || !btn.classList.contains('on')) return;

  const sText = LAB.sampleText.trim();
  if (!sText) {
    panel.innerHTML = '<div class="hint">在下面写一段示例代码，管线面板会显示逐层中间产物。</div>';
    return;
  }
  /* 需要知道这是哪门已注册的语言才能走 /api/emit。
     如果是从项目里加载的 .grammar（有对应的语言），才能走管线。 */
  const sel = $('#lab-load');
  const loadedPath = sel ? sel.value : '';
  if (!loadedPath || loadedPath.startsWith('__tpl:')) {
    panel.innerHTML = '<div class="hint" style="color:var(--fg-3)">'
      + '管线面板需要一门已注册的语言 —— 加载项目里的 .grammar 后，'
      + '在示例栏写那门语言的代码，这里会显示逐层 emit 输出。</div>';
    return;
  }

  /* 从 .grammar 路径猜语言后缀。ext/go/go.grammar -> .go 那门语言的后缀 */
  const langExt = labExtOfGrammar(loadedPath);
  if (!langExt) {
    const langDir = loadedPath.split('/')[1] ?? '';
    panel.innerHTML = '<div class="hint" style="color:var(--fg-3)">'
      + `不认识 '${langDir}' 对应的语言后缀，管线面板暂时不可用。</div>`;
    return;
  }

  const seq = ++labPipelineSeq;
  panel.innerHTML = '<div class="hint">正在获取管线各层…</div>';

  /* 逐层发 /api/emit。并行发出去、按序展示。 */
  const results = await Promise.all(LAB_EMIT_FORMATS.map(async (fmt) => {
    try {
      const r = await post('/api/emit', {
        text: sText,
        lang: langExt.slice(1),
        format: fmt,
      });
      return { fmt, stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.code ?? 0 };
    } catch (e) {
      return { fmt, stdout: '', stderr: String(e.message ?? e), code: 1 };
    }
  }));

  if (seq !== labPipelineSeq) return; // 旧请求丢掉

  let h = '<div style="display:flex;gap:8px;padding:4px 0 8px;flex-wrap:wrap">';
  for (const { fmt } of results) {
    h += `<button class="seg-btn lab-pipe-btn" data-fmt="${fmt}"`;
    h += ` style="appearance:none;border:1px solid var(--line);background:var(--bg-sunk);`
      + `color:var(--fg-2);font:12px var(--mono);padding:4px 10px;border-radius:6px;cursor:pointer">`
      + `${fmt.toUpperCase()}</button>`;
  }
  h += '</div><pre class="lab-pipe-out" style="font:12px/1.6 var(--mono);color:var(--fg-2);'
    + 'white-space:pre-wrap;word-break:break-all;max-height:100%;overflow:auto"></pre>';
  panel.innerHTML = h;

  const out = panel.querySelector('.lab-pipe-out');
  const btns = panel.querySelectorAll('.lab-pipe-btn');
  const show = (fmt) => {
    const r = results.find((x) => x.fmt === fmt);
    if (!r) return;
    for (const b of btns) b.style.background = b.dataset.fmt === fmt ? 'var(--accent)' : 'var(--bg-sunk)',
      b.style.color = b.dataset.fmt === fmt ? '#fff' : 'var(--fg-2)';
    out.textContent = r.code === 0 ? (r.stdout || '（空）') : `错误：\n${r.stderr}`;
    if (r.code !== 0) out.style.color = 'var(--bad)'; else out.style.color = 'var(--fg-2)';
  };
  for (const b of btns) b.onclick = () => show(b.dataset.fmt);
  /* 默认显示第一个成功的 */
  const first = results.find((r) => r.code === 0) ?? results[0];
  show(first.fmt);
}

/* ---- 示例面板（内联判据） ---- */

function labRefreshExamples() {
  const panel = $('#lab-examples');
  const btn = document.querySelector('#lab-tabs button[data-tab="lab-examples"]');
  if (!btn || !btn.classList.contains('on')) return;

  if (!LAB.examples || LAB.examples.length === 0) {
    LAB.examples = [{ input: '1 + 2', expected: '(add 1 2)' }];
  }

  let h = '';
  for (let i = 0; i < LAB.examples.length; i++) {
    const ex = LAB.examples[i];
    const got = labParseToSexpr(ex.input);
    const pass = got !== null && labSexprEq(got, ex.expected);
    const icon = got === null ? '?' : (pass ? '✓' : '✗');
    const cls = got === null ? 'var(--fg-3)' : (pass ? 'var(--ok)' : 'var(--bad)');
    h += `<div class="lab-ex-row" data-idx="${i}" style="margin:0 0 10px;padding:8px;`
      + `border-radius:var(--r-sm);background:var(--bg-sunk)">`
      + `<div style="display:flex;align-items:center;gap:8px;margin:0 0 4px">`
      + `<span style="font:600 16px var(--font);color:${cls}">${icon}</span>`
      + `<input class="lab-ex-input" data-idx="${i}" value="${escAttr(ex.input)}" `
      + `style="flex:1;border:1px solid var(--line);background:var(--bg-elev);color:var(--fg);`
      + `font:12px var(--mono);padding:4px 8px;border-radius:5px;outline:0">`
      + `<span style="color:var(--fg-3);font:12px var(--font)">→</span>`
      + `<input class="lab-ex-expected" data-idx="${i}" value="${escAttr(ex.expected)}" `
      + `style="flex:1;border:1px solid var(--line);background:var(--bg-elev);color:var(--fg);`
      + `font:12px var(--mono);padding:4px 8px;border-radius:5px;outline:0">`
      + `<button class="lab-ex-del" data-idx="${i}" style="appearance:none;border:0;background:none;`
      + `color:var(--bad);cursor:pointer;font:14px var(--font)">✕</button>`
      + `</div>`;
    if (!pass && got !== null) {
      h += `<div style="font:11px var(--mono);color:var(--bad);padding:2px 0 0 28px">`
        + `实际：${esc(got)}</div>`;
    }
    h += '</div>';
  }
  h += `<button id="lab-ex-add" style="appearance:none;border:1px dashed var(--line);`
    + `background:none;color:var(--fg-3);font:12px var(--font);padding:6px 14px;`
    + `border-radius:6px;cursor:pointer;width:100%">＋ 加一组</button>`;
  panel.innerHTML = h;

  /* 接线 */
  panel.querySelector('#lab-ex-add').onclick = () => {
    LAB.examples.push({ input: '', expected: '' });
    labRefreshExamples();
  };
  for (const inp of panel.querySelectorAll('.lab-ex-input')) {
    inp.oninput = () => { LAB.examples[inp.dataset.idx].input = inp.value; labRefreshExamples(); };
  }
  for (const inp of panel.querySelectorAll('.lab-ex-expected')) {
    inp.oninput = () => { LAB.examples[inp.dataset.idx].expected = inp.value; labRefreshExamples(); };
  }
  for (const btn2 of panel.querySelectorAll('.lab-ex-del')) {
    btn2.onclick = () => { LAB.examples.splice(Number(btn2.dataset.idx), 1); labRefreshExamples(); };
  }
}

/** 用当前语法表解析一小段代码，返回 S-expr 文本或 null。 */
function labParseToSexpr(src) {
  if (!GLR || !LAB.lastTable || !LAB.lastTable.grammar.lex || !src.trim()) return null;
  const d = new GLR.Diagnostics();
  const toks = GLR.lexText(LAB.lastTable.grammar.lex, new GLR.SourceFile('<ex>', src), d);
  if (d.errorCount() > 0) return null;
  const pd = new GLR.Diagnostics();
  const tree = GLR.glrParse(LAB.lastTable, toks, pd);
  if (pd.errorCount() > 0) return null;
  return labTreeSexpr(tree);
}

/** 把 S-expr 文本归一化（去掉多余空白和换行）以便比较。 */

/* 管线 tab 被选中时触发一次刷新 */

/* `render.js` 的 `esc` 只转 `& < >`（它是给**文本内容**用的）。这儿要往
   `value="…"` 里塞，所以双引号也得转 —— 不转的话示例里写一个引号就把属性收掉了。 */
const escAttr = (s) => esc(String(s)).replace(/"/g, '&quot;');

/* ---------------------------------------------------------------- 接线 */

function initTabs() {
  const tabs = $('#out-tabs');
  tabs.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    selectTab(b);
  };
  /* Lab 模式的检查面板也是同一套 tab 机制。 */
  const labTabs = $('#lab-tabs');
  labTabs.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    labSelectTab(b);
  };
  const seg = document.querySelector('.seg[role="tablist"]');
  seg.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    setMode(b.dataset.mode);
  };
}

/**
 * 切模式。**展示 = 首页**（一屏卡片），IDE = 编辑与运行。
 *
 * 首页那一屏只在第一次进去时铺（`renderGallery` 自己看 `childElementCount`）——
 * 每次切都重铺的话，那十来张图会重跑一遍，而它们是静态的。
 */
function setMode(m) {
  const seg = document.querySelector('.seg[role="tablist"]');
  for (const o of seg.children) o.classList.toggle('on', o.dataset.mode === m);
  document.body.dataset.mode = m;
  localStorage.setItem('omni.mode', m);
  if (m === 'show') renderGallery();
  if (m === 'ide') $('#edit').focus();
  if (m === 'console') $('#con-in').focus();
  if (m === 'lab') initLab();
}

function initEditor() {
  const ta = $('#edit');
  let timer = null;
  let glTimer = null;
  /** 正在用输入法拼字（中文/日文）—— 那期间别去打扰它。 */
  let composing = false;
  ta.addEventListener('compositionstart', () => { composing = true; });
  ta.addEventListener('compositionend', () => { composing = false; paint(ta.value); });
  ta.addEventListener('input', () => {
    /* **画的是 `ta.value`，不是 `S.text`** —— 见 `paint` 的头注。 */
    paint(ta.value);
    /* md / glsl / html 的预览就是源码本身 —— 不必等一趟往返，边敲边跟着变。
       glsl 与 html 自带防抖：编不过 / 半截标签的中间状态每敲一下重画太吵。 */
    const kind = previewKind(S.lang);
    if (kind === 'md') renderPreview('md', ta.value);
    else if (kind === 'glsl' || kind === 'html') {
      clearTimeout(glTimer);
      glTimer = setTimeout(() => renderPreview(kind, ta.value), 300);
    }
    if (!$('#live').checked || composing) return;
    /* 防抖 250ms（设计文档 §4.4）。热工人那侧一趟 8~19ms，所以这 250ms 现在是**真的**
       在等用户停手，而不是在等 node 启动。 */
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
  /* 滚动要同步 —— 高亮那一层与 textarea 是叠在一起的两块，而**只有 textarea 会滚**
     （`.code-body` 与 `#view` 都不滚，见 studio.css 里那段账）。 */
  ta.addEventListener('scroll', () => {
    $('#view').scrollTop = ta.scrollTop;
    $('#view').scrollLeft = ta.scrollLeft;
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); insert(ta, '  '); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    /* **Cmd+S / Ctrl+S**：存进虚拟文件系统。 */
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      stash().then(() => setStatus('已保存', ''));
    }
  });
  /* 离开页面之前存一把（切标签、关窗口）。 */
  window.addEventListener('visibilitychange', () => { if (document.hidden) stash(); });
}

function insert(ta, s) {
  const a = ta.selectionStart;
  ta.value = ta.value.slice(0, a) + s + ta.value.slice(ta.selectionEnd);
  ta.selectionStart = ta.selectionEnd = a + s.length;
  paint(ta.value);
}

async function main() {
  initTheme();
  initTabs();
  initEditor();
  initConsole();
  $('#btn-run').onclick = run;
  /* js 那个开关：切了就重跑一趟 —— 它改的就是"这一份怎么跑"。 */
  $('#js-parse').onchange = () => { if (S.lang === 'js') run(); };
  $('#asy-svg').onchange = () => { if (S.lang === 'asy') run(); };
  /* 抽屉：开的时候盖一层遮罩，点它就关（不然窄屏上只能再摸那个按钮）。 */
  const mask = el('div', 'mask');
  mask.style.display = 'none';
  mask.onclick = closeDrawer;
  document.body.append(mask);
  DRAWER_MASK = mask;
  $('#btn-tree').onclick = () => {
    const open = $('#tree').classList.toggle('open');
    mask.style.display = open ? 'block' : 'none';
  };
  $('#filter').oninput = (e) => applyFilter(e.target.value);
  /* **新建文件**：原生 prompt 就够（modal 会带来一堆状态）。填相对仓库根的路径，
     写进虚拟文件系统（仓库里一个字节不动），树重建，打开它。 */
  $('#btn-new').onclick = async () => {
    const p = prompt('新文件路径（相对仓库根，如 docs/notes/my.md 或 my.go）');
    if (!p || p.startsWith('/') || p.includes('..')) return;
    try {
      await put('/api/file', { path: p, text: '' });
      await loadTree();
      await openFile(p);
      $('#edit').focus();
    } catch (e) { setStatus(`新建失败：${e.message ?? e}`, 'bad'); }
  };
  $('#sh').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const v = e.target.value;
    e.target.value = '';
    if (v.trim()) shell(v);
  });
  /* **默认落在首页**（展示模式）—— 它现在是首页，落在首页是首页的定义。
     上一次挑的那一格记在 localStorage 里：天天用 IDE 的人不该每趟都先过一眼画廊。 */
  const saved = localStorage.getItem('omni.mode');
  setMode(saved === 'ide' || saved === 'console' || saved === 'lab' ? saved : 'show');
  try {
    await loadTree();
    const h = await api('/api/health');
    shLog(`omni studio · 腿：${h.legs.join(' / ')}`);
  } catch (e) {
    $('#tree-body').textContent = `目录树读不到：${e.message}`;
  }
}

main();
