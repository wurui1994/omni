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
import { highlight, mdToHtml, epsToSvg } from './render.js';

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
 * 认三套常见的 uniform 名（有就喂）：`u_resolution`/`iResolution`、`u_time`/`iTime`。
 * `#version 330 core` 的那几份自动换成 `300 es` + 一句精度 —— 判据里那 15 份都是桌面 GL 的写法。
 */
const GL = { canvas: null, gl: null, prog: null, raf: 0, t0: 0 };

function glslSource(src) {
  let s = src.replace(/^\s*#version[^\n]*\n/, '');
  const pre = '#version 300 es\nprecision highp float;\n';
  /* 桌面写法里 `out vec4 名字;` 照收；没有 out 声明的（老 `gl_FragColor` 写法）补一格。 */
  if (!/\bout\s+vec4\s+\w+\s*;/.test(s)) s = `out vec4 fragColor;\n${s.replace(/\bgl_FragColor\b/g, 'fragColor')}`;
  return pre + s;
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
  let prog = null;
  try {
    const vs = mk(gl.VERTEX_SHADER, '#version 300 es\nvoid main(){\n'
      + ' vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);\n'
      + ' gl_Position = vec4(p * 2.0 - 1.0, 0, 1);\n}');
    const fs = mk(gl.FRAGMENT_SHADER, glslSource(src));
    prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? '链不上');
  } catch (e) {
    host.textContent = '';
    const p = el('pre', 'gl-err', String(e.message ?? e));
    host.append(GL.canvas, p);
    return;
  }
  if (GL.prog !== null) gl.deleteProgram(GL.prog);
  GL.prog = prog;
  gl.useProgram(prog);
  const uRes = gl.getUniformLocation(prog, 'u_resolution') ?? gl.getUniformLocation(prog, 'iResolution');
  const uTime = gl.getUniformLocation(prog, 'u_time') ?? gl.getUniformLocation(prog, 'iTime');
  GL.t0 = performance.now();
  const draw = () => {
    const r = host.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round((r.height || r.width * 0.6) * dpr));
    if (GL.canvas.width !== w || GL.canvas.height !== h) { GL.canvas.width = w; GL.canvas.height = h; }
    gl.viewport(0, 0, w, h);
    if (uRes) gl.uniform2f(uRes, w, h);
    if (uTime) gl.uniform1f(uTime, (performance.now() - GL.t0) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (uTime) GL.raf = requestAnimationFrame(draw);
  };
  draw();
}

/* ---------------------------------------------------------------- 预览：派发
 *
 * 三种：markdown 排版、asy 的图（EPS -> SVG）、glsl 的着色器（WebGL）。
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
  if (kind === 'glsl') glslRun(payload, host);
}

/** 这一份文件的预览是哪一种（没有回 null）。 */
function previewKind(lang) {
  if (lang === 'markdown') return 'md';
  if (lang === 'glsl') return 'glsl';
  if (lang === 'asy') return 'eps';
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
  /* js 那个开关只在 js 上有意义 —— 别的语言上藏起来（不是置灰：省一格视觉噪声）。 */
  $('#js-parse-box').hidden = f.lang !== 'js';
  closeDrawer();
  setStatus(f.dirty === true ? '改过' : '', '');
  const kind = previewKind(f.lang);
  /* md / glsl 的预览**不用跑**：源码就是全部输入。asy 要等 EPS，所以先留着旧图。 */
  if (kind === 'md' || kind === 'glsl') renderPreview(kind, f.text);
  else if (kind === null) renderPreview(null);
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
  try {
    const r = await post('/api/run', {
      path: S.path,
      text: dirty ? currentText : undefined,
      lang: S.lang,
      direct,
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
    /* asy：stdout 就是 EPS 正文，翻成 SVG 画出来（见 `epsToSvg`）。 */
    if (S.lang === 'asy' && (r.stdout ?? '').includes('%!PS')) renderPreview('eps', r.stdout);
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
  box.textContent = '';
  if (Array.isArray(stages) && stages.length > 0) {
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      const row = el('div', 'st-row');
      row.append(el('span', '', String(i + 1)));
      row.append(el('span', 'ph', s.phase ?? ''));
      row.append(el('span', '', s.verb ?? ''));
      row.append(el('span', '', s.in ?? ''));
      row.append(el('span', '', s.out ?? ''));
      row.append(el('span', 'ms', s.ms === undefined ? '' : `${s.ms}ms`));
      box.append(row);
    }
  } else {
    const lines = stderrText.split('\n').filter((l) => l.startsWith('omni:') || /\+\d+ms$/.test(l));
    box.append(el('pre', '', lines.length > 0 ? lines.join('\n') : '（这一趟没有阶段信息：加 -v）'));
  }
  const tot = el('div', 'st-row');
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

/* ---------------------------------------------------------------- 接线 */

function initTabs() {
  const tabs = $('#out-tabs');
  tabs.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    selectTab(b);
  };
  const seg = document.querySelector('.seg[role="tablist"]');
  seg.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    for (const o of seg.children) o.classList.toggle('on', o === b);
    document.body.dataset.mode = b.dataset.mode;
    if (b.dataset.mode === 'ide') $('#edit').focus();
  };
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
    /* md / glsl 的预览就是源码本身 —— 不必等一趟往返，边敲边跟着变。
       glsl 那一格自带防抖：编不过的中间状态每敲一下报一次错太吵。 */
    const kind = previewKind(S.lang);
    if (kind === 'md') renderPreview('md', ta.value);
    else if (kind === 'glsl') {
      clearTimeout(glTimer);
      glTimer = setTimeout(() => renderPreview('glsl', ta.value), 300);
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
  $('#btn-run').onclick = run;
  /* js 那个开关：切了就重跑一趟 —— 它改的就是"这一份怎么跑"。 */
  $('#js-parse').onchange = () => { if (S.lang === 'js') run(); };
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
  /* 窄屏默认展示模式（设计文档 §4.1）。 */
  if (window.matchMedia('(max-width: 800px)').matches) document.body.dataset.mode = 'show';
  else {
    document.body.dataset.mode = 'ide';
    for (const b of document.querySelectorAll('.seg[role="tablist"] button')) {
      b.classList.toggle('on', b.dataset.mode === 'ide');
    }
  }
  try {
    await loadTree();
    const h = await api('/api/health');
    shLog(`omni studio · 腿：${h.legs.join(' / ')}`);
  } catch (e) {
    $('#tree-body').textContent = `目录树读不到：${e.message}`;
  }
}

main();
