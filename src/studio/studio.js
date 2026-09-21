/* Omni Studio —— 前端。原生 ESM，一个依赖都不装。
 *
 * 三块：目录树（虚拟文件系统）、代码区（展示/编辑 + 高亮）、输出区（输出/阶段/shell）。
 * 与服务那侧的约定在 `docs/design/omni-serve-studio.md`。
 *
 * 一条自己定的纪律：**"阶段耗时"那一栏直接印服务给的 `-v` 那张表**，不在这儿重新算、
 * 也不从格式里往回抠结构。那张表本来就是数据的一种印法（`src/core/cli/stages.js`）。
 */

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

/* ---------------------------------------------------------------- 语法高亮
 *
 * 一门语言一张小表：关键字、注释的形状、串的形状。**不上第三方** —— 要零依赖，
 * 而且这一层只要"读起来分得清"，不需要真的解析。
 */

const KW = {
  common: 'if else for while return break continue switch case default goto do',
  omni: 'fn let mut const type struct enum match import export pub as in is nil true false',
  sx: 'module fn main let set do if while ret print var call int real bool str struct class global cabi lib ccall',
  go: 'package import func var const type struct interface map chan go defer select range nil true false iota',
  c: 'int char long short float double void unsigned signed static extern struct union enum typedef sizeof const volatile register inline',
  cpp: 'class public private protected virtual template typename namespace using new delete this nullptr auto constexpr',
  nim: 'proc func method template macro var let const type object ref ptr import export discard nil true false when',
  v: 'fn mut pub struct enum interface import module or none true false',
  lua: 'function local end then elseif repeat until nil true false and or not',
  mojo: 'fn def struct var let alias trait raises owned borrowed inout import from as pass None True False',
  basic: 'Dim As Sub Function End If Then Else For Next Do Loop While Wend Type Declare',
  awk: 'BEGIN END function print printf getline next exit delete',
  scheme: 'define lambda let let* letrec cond case when unless set! quote begin',
  lisp: 'defun defvar defparameter let let* lambda cond when unless setf loop',
  js: 'function let const var class extends new this async await yield import export from null undefined true false typeof instanceof',
  asy: 'pen path guide picture real pair triple struct void return import access from as new operator',
  wat: 'module func param result local global memory data export import i32 i64 f32 f64 call br_if loop block',
  jancy: 'class property construct destruct int char void bool string alias enum',
  glsl: 'void float vec2 vec3 vec4 mat4 uniform varying attribute in out precision',
};

const LINE_COM = {
  go: '//', c: '//', cpp: '//', js: '//', v: '//', jancy: '//', glsl: '//', asy: '//',
  omni: '//', sx: ';', nim: '#', mojo: '#', lua: '--', awk: '#', basic: "'",
  scheme: ';', lisp: ';', wat: ';;',
};
const BLOCK_COM = { go: ['/*', '*/'], c: ['/*', '*/'], cpp: ['/*', '*/'], js: ['/*', '*/'],
  v: ['/*', '*/'], jancy: ['/*', '*/'], glsl: ['/*', '*/'], asy: ['/*', '*/'],
  omni: ['/*', '*/'], lua: ['--[[', ']]'], sx: null };

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** 一份源码 -> 带 span 的 HTML。**按字符扫一遍**，不回溯。 */
function highlight(text, lang) {
  const kws = new Set(`${KW.common} ${KW[lang] ?? ''}`.trim().split(/\s+/));
  const lc = LINE_COM[lang] ?? '//';
  const bc = BLOCK_COM[lang];
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    /* 块注释 */
    if (bc && text.startsWith(bc[0], i)) {
      const e = text.indexOf(bc[1], i + bc[0].length);
      const j = e < 0 ? n : e + bc[1].length;
      out += `<span class="com">${esc(text.slice(i, j))}</span>`;
      i = j; continue;
    }
    /* 行注释 */
    if (text.startsWith(lc, i)) {
      let j = text.indexOf('\n', i);
      if (j < 0) j = n;
      out += `<span class="com">${esc(text.slice(i, j))}</span>`;
      i = j; continue;
    }
    /* 串（单/双引号，认反斜杠转义） */
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && text[j] !== c) { if (text[j] === '\\') j++; j++; }
      out += `<span class="str">${esc(text.slice(i, Math.min(j + 1, n)))}</span>`;
      i = j + 1; continue;
    }
    /* 数字 */
    if (/[0-9]/.test(c) && !/[A-Za-z_]/.test(text[i - 1] ?? '')) {
      let j = i;
      while (j < n && /[0-9a-fA-FxX._eE+-]/.test(text[j])) {
        if ((text[j] === '+' || text[j] === '-') && !/[eE]/.test(text[j - 1])) break;
        j++;
      }
      out += `<span class="num">${esc(text.slice(i, j))}</span>`;
      i = j; continue;
    }
    /* 标识符 / 关键字 */
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$!?*-]/.test(text[j])) {
        if (text[j] === '-' && lang !== 'scheme' && lang !== 'lisp') break;
        j++;
      }
      const w = text.slice(i, j);
      if (kws.has(w)) out += `<span class="kw">${esc(w)}</span>`;
      else if (text[j] === '(') out += `<span class="fn">${esc(w)}</span>`;
      else if (/^[A-Z]/.test(w)) out += `<span class="ty">${esc(w)}</span>`;
      else out += esc(w);
      i = j; continue;
    }
    if ('(){}[];,.:'.includes(c)) { out += `<span class="pn">${esc(c)}</span>`; i++; continue; }
    out += esc(c);
    i++;
  }
  return out;
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

function renderNode(n, depth) {
  const box = el('div', 'node');
  if (depth === 0) box.classList.add('open');
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
    /* **懒展开**：一千多格一次全建 DOM 会卡，展开那一刻才建。 */
    let built = false;
    row.onclick = () => {
      if (!built) { for (const k of n.children) kids.append(renderNode(k, depth + 1)); built = true; }
      box.classList.toggle('open');
    };
    box.append(kids);
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
  $('#btn-run').disabled = !RUNNABLE.has(f.lang);
  closeDrawer();
  setStatus(f.dirty === true ? '改过' : '', '');
  $('#stdout').textContent = ''; $('#stderr').textContent = '';
  $('#stages').textContent = '';
  /* 打开就跑一趟（能跑的那几门）—— 用户要的是"打开新例子就看到结果"。
     热工人那侧一趟 8~19ms，所以这一下不用犹豫。 */
  if (RUNNABLE.has(f.lang)) run();
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
 * 三条要紧的：
 *
 * 1. **不因为"上一趟还在跑"就不跑**。从前这儿 `if (S.busy) return` —— 实时模式下
 *    上一趟在路上时最后那几下键就被丢了，表现成"改了没有效果"。现在照发，
 *    靠 `S.seq` 丢掉旧回包（"只认最后一趟"本来就是这一层的规矩）。
 * 2. **改过的源码只走一趟往返**。`body.text` 递过去，服务那侧顺手就把它写进虚拟文件系统
 *    （`serve.js` 的 `putEdit`）—— 不必先 PUT 再 POST。实时模式下那省掉的是一半延迟。
 * 3. 状态栏印 `ms` 与 `via`（warm/cold）—— "实时"这件事得**看得见**。
 */
async function run() {
  if (S.path === null) return;
  const my = ++S.seq;
  S.busy = true;
  $('#btn-run').disabled = true;
  setStatus('跑…', '');
  const t0 = performance.now();
  const currentText = $('#edit').value;
  const dirty = currentText !== S.text;
  try {
    const r = await post('/api/run', {
      path: S.path,
      text: dirty ? currentText : undefined,
      lang: S.lang,
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
    const via = r.via === 'warm' ? '' : ' · 冷';
    setStatus(`${r.code === 0 ? 'ok' : `exit ${r.code}`} · ${ms}ms${via}`, r.code === 0 ? 'ok' : 'bad');
  } catch (e) {
    if (my === S.seq) { $('#stderr').textContent = String(e.message ?? e); setStatus('失败', 'bad'); }
  } finally {
    if (my === S.seq) { S.busy = false; $('#btn-run').disabled = !RUNNABLE.has(S.lang); }
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
    if (!b) return;
    for (const o of tabs.children) o.classList.toggle('on', o === b);
    for (const p of document.querySelectorAll('.tabp')) {
      p.classList.toggle('on', p.dataset.tab === b.dataset.tab);
    }
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
  /** 正在用输入法拼字（中文/日文）—— 那期间别去打扰它。 */
  let composing = false;
  ta.addEventListener('compositionstart', () => { composing = true; });
  ta.addEventListener('compositionend', () => { composing = false; paint(ta.value); });
  ta.addEventListener('input', () => {
    /* **画的是 `ta.value`，不是 `S.text`** —— 见 `paint` 的头注。 */
    paint(ta.value);
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
