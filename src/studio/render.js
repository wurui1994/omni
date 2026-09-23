/* Omni Studio —— **纯函数那一半**：文本进、HTML/SVG 出。一个 DOM 都不碰。
 *
 * 为什么单独一份：这三样（高亮、markdown、EPS -> SVG）是**能判的**——
 * 给一段输入、比一段输出。留在 `studio.js` 里就只能靠眼睛看，而那三样恰恰是
 * "看着像对的、其实少了一格"的重灾区。判据在 `tests/serve/run.js`（node 里直接 import
 * 这一份，不需要浏览器）。
 *
 * 纪律：**这一份里不许出现 `document` / `window`**。
 */

/* 首页那一屏的清单从这儿**转手出去**：`studio.js` 只 import 这一份（单体 HTML 那边
   是这么定的 —— 见 `tools/bundle-studio.mjs` 的 `uiScript`），而清单该有自己一份文件。 */
export { GALLERY, galleryPaths } from './gallery.js';

/* ---------------------------------------------------------------- 语法高亮
 *
 * 一门语言一张小表：关键字、注释的形状、串的形状。**不上第三方** —— 要零依赖，
 * 而且这一层只要"读起来分得清"，不需要真的解析。
 */

export const KW = {
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
  /* html / css 在这一层只要"标签与注释分得清"——关键字表给的是常见标签名与属性名。 */
  html: 'html head body meta title link script style div span p a img ul ol li table tr td th'
    + ' form input button select option label canvas svg path circle rect text defs DOCTYPE',
  css: 'color background margin padding border font display flex grid position width height',
};

const LINE_COM = {
  go: '//', c: '//', cpp: '//', js: '//', v: '//', jancy: '//', glsl: '//', asy: '//',
  omni: '//', sx: ';', nim: '#', mojo: '#', lua: '--', awk: '#', basic: "'",
  scheme: ';', lisp: ';', wat: ';;',
  /* html / css / json 没有行注释。**得给一个不可能出现的串** —— 缺省那个 `'//'`
     会把 `https://…` 后面整行吞成注释，而留空串更糟（`startsWith('')` 恒真，全文变注释）。 */
  html: '\u0000', css: '\u0000', json: '\u0000', markdown: '\u0000',
};
const BLOCK_COM = { go: ['/*', '*/'], c: ['/*', '*/'], cpp: ['/*', '*/'], js: ['/*', '*/'],
  v: ['/*', '*/'], jancy: ['/*', '*/'], glsl: ['/*', '*/'], asy: ['/*', '*/'],
  omni: ['/*', '*/'], lua: ['--[[', ']]'], sx: null,
  html: ['<!--', '-->'], css: ['/*', '*/'] };

export const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** 一份源码 -> 带 span 的 HTML。**按字符扫一遍**，不回溯。 */
export function highlight(text, lang) {
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

/* ---------------------------------------------------------------- Markdown
 *
 * 一格**够用的** md -> HTML：标题、粗/斜、行内码、围栏代码块、列表、引用、
 * 分隔线、链接、表格。零依赖（整页的规矩），一遍扫行、块级先分段再处理行内。
 *
 * 为什么不上第三方：这一页从头到尾一个依赖都不装；而 md 在这儿的用处是**读文档**，
 * 不是发布排版 —— 上面那十来样覆盖了 docs/ 底下几乎每一行。
 * 行内那一步**在转义之后做**，所以 `<` 永远是字面量，注不进标签。
 */
function mdInline(s) {
  let t = esc(s);
  /* 行内码先抽出来占位 —— 不然 `**` 之类会在代码里被当成标记。 */
  const code = [];
  t = t.replace(/`([^`]+)`/g, (_m, c) => `\u0000${code.push(c) - 1}\u0000`);
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, a, u) => `<img alt="${a}" src="${u}">`);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, a, u) => `<a href="${u}" target="_blank" rel="noopener">${a}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/(^|[\s(（])_([^_]+)_(?=[\s).,:;!?）]|$)/g, '$1<i>$2</i>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>');
  t = t.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  return t.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${code[Number(i)]}</code>`);
}

const MD_BLOCK_START = (l) => /^(#{1,6})\s/.test(l) || /^\s*(```+|~~~+)/.test(l)
  || /^\s*([-*+]|\d+[.)])\s+/.test(l) || /^\s*>/.test(l)
  || /^\s*(---+|\*\*\*+|___+)\s*$/.test(l);

export function mdToHtml(src) {
  const lines = src.split('\n');
  const out = [];
  let i = 0;
  /* 列表与表格要成段收，所以这一层按"块"走，不是按行 map。 */
  while (i < lines.length) {
    const l = lines[i];
    /* 围栏代码块：里头一个字都不解释，只转义（认不出的语言原样印）。 */
    const fence = /^\s*(```+|~~~+)(.*)$/.exec(l);
    if (fence) {
      const mark = fence[1][0].repeat(3);
      const lang = fence[2].trim().split(/\s+/)[0] ?? '';
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(mark)) { buf.push(lines[i]); i++; }
      i++;
      const txt = buf.join('\n');
      const body = KW[lang] !== undefined ? highlight(txt, lang) : esc(txt);
      out.push(`<pre class="md-code"><code>${body}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) { out.push(`<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    /* 表格：`| a | b |` 接一行 `|---|---|` */
    if (/^\s*\|/.test(l) && i + 1 < lines.length && /^\s*\|[\s|:-]+\|?\s*$/.test(lines[i + 1])) {
      const cells = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      const th = head.map((c) => `<th>${mdInline(c)}</th>`).join('');
      const tb = rows.map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('');
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`);
      continue;
    }
    /* 列表（有序/无序，续行按缩进并进上一格） */
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i])
          && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i++;
        }
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((x) => `<li>${mdInline(x)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (/^\s*>\s?/.test(l)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push(`<blockquote>${mdToHtml(buf.join('\n'))}</blockquote>`);
      continue;
    }
    if (l.trim() === '') { i++; continue; }
    /* 段落：连着的非空行算一段（软换行当空格，与 CommonMark 一致）。 */
    const buf = [];
    while (i < lines.length && lines[i].trim() !== '' && !MD_BLOCK_START(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${mdInline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

/* ---------------------------------------------------------------- 预览：EPS -> SVG
 *
 * asy 那条腿印出来的是 **EPS 正文**（`omni run x.asy` 的 stdout，见 asy_builtins.asy 的
 * `shipout`）。浏览器不认 EPS，于是这一格把它翻成 SVG —— **只认我们自己发的那一小套
 * 算子**（`newpath/moveto/lineto/curveto/closepath/setrgbcolor/setgray/Setlinewidth/
 * fill/eofill/stroke/gsave/grestore/translate/concat/clip/setdash`），认不出的整句忽略。
 *
 * 为什么留着这一格（asy 那条腿现在有**原生 SVG 出口**了，`-f svg`）：不勾"SVG 出图"
 * 那一档、以及画廊里拿到的是 EPS 的时候，还得靠它。默认那条路已经换成原生出口 ——
 * 那一路把标签也发成 `<text>`，而这一格对嵌在 EPS 里的 dvips 字节无能为力。
 *
 * PS 的 y 轴朝上、SVG 朝下 —— 所以外层套一格 `translate(0,y0+y1) scale(1,-1)`，
 * 里头的坐标一律按 PS 的算，读起来与 EPS 正文对得上。
 */
/**
 * 一份 stdout 是哪一种图（`null` = 不是图）。
 *
 * **看输出，不看后缀**：asy 有两条出口（`-f svg` 的原生 SVG 与 EPS），而同一批 `.asy`
 * 里一百多份根本不出图（`cases/` 底下那些是算术例子）。所以这一格只问三句：
 * `%!PS` 起头是 EPS、`<?xml` 或 `<svg` 起头是 SVG、别的都不是图。
 * 与"控制台看输出决定挂哪儿"同一条纪律。
 */
export function drawKindOf(out) {
  const s = String(out ?? '').trimStart();
  if (s.startsWith('%!PS')) return 'eps';
  if (s.startsWith('<?xml') || s.startsWith('<svg')) return 'svg';
  /* **图形设备**（`ext/js/lib/ege.js` / `ext/jnc/lib/ege.jnc`）：stdout 上只有一行指针
     `#gfx rgba <路径> <宽> <高>`，图在那份表面文件里（w*h*4 的裸 RGBA）。
     认的是这一行，不是后缀 —— 哪门语言印的都一样。 */
  if (gfxRef(s) !== null) return 'gfx';
  return null;
}

/**
 * 一趟输出里那行**设备指针**：`#gfx rgba <路径> <宽> <高>` -> `{ path, w, h }`。
 *
 * 为什么图不走 stdout：这一格是图形设备。`putpixel` 一百万次落在内存里那块 RGBA 上，
 * 跨出程序的只有**一帧表面**；stdout 上那一行说的是"表面在哪儿"。
 * 从前这儿是一份"绘图命令表"（每笔一行），那在 `.frag` 级的小图上还行，
 * 一张 384×288 的 Mandelbrot 就是十一万行 —— 图像这一档不能那么算。
 */
export function gfxRef(out) {
  const m = /(?:^|\n)#gfx rgba (\S+) (\d+) (\d+)\s*(?:\n|$)/.exec(String(out ?? ''));
  if (m === null) return null;
  return { path: m[1], w: Number(m[2]), h: Number(m[3]) };
}

/**
 * 把一份裸 RGBA 表面贴到 canvas 上（`putImageData` 一次）。
 *
 * `bytes` 是**一个字符一个字节**的串（封闭 ABI 的 `readBinary` 那个口径），
 * 或者一格 `Uint8Array` —— 两种都收：服务那侧走 base64 解出来的串，
 * 单体那侧从内存里那张表直接拿到串。
 */
export function rgbaDraw(canvas, bytes, w, h) {
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  const img = g.createImageData(w, h);
  const d = img.data;
  const n = Math.min(d.length, w * h * 4);
  if (typeof bytes === 'string') {
    for (let i = 0; i < n; i++) d[i] = bytes.charCodeAt(i) & 255;
  } else {
    for (let i = 0; i < n; i++) d[i] = bytes[i];
  }
  g.putImageData(img, 0, 0);
  return { w, h };
}

/** 表面文件的头（`#rgba <宽> <高>\n`）切掉，回 `{ w, h, body }`。 */
export function rgbaSplit(text) {
  const s = String(text ?? '');
  const nl = s.indexOf('\n');
  const m = nl < 0 ? null : /^#rgba (\d+) (\d+)$/.exec(s.slice(0, nl));
  if (m === null) return null;
  return { w: Number(m[1]), h: Number(m[2]), body: s.slice(nl + 1) };
}





/**
 * 一趟输出里**有没有图、图是哪几块**（`{ kind, blocks, rest }`）。
 *
 * 与 `drawKindOf` 的差别是这一条：**图不一定在开头**。`tests/cases/27_plot.omni` 印的是
 * `2285` / 一整份 SVG / `2199`（它是判据，顺带把字节数印出来对账）—— 按"开头是不是 `<svg`"
 * 判的话这一份就"没有图"，而它明明画了一张。所以这儿把 `<svg …</svg>` 整块整块抠出来，
 * 剩下的文本原样交回去（进日志那一栏）。一趟印好几张图也就跟着白捡。
 *
 * EPS 那一族仍然只认"开头是 `%!PS`"：EPS 正文里什么字节都可能有，在里头找边界不可靠。
 */
export function drawBlocks(out) {
  const s = String(out ?? '');
  if (s.trimStart().startsWith('%!PS')) return { kind: 'eps', blocks: [s], rest: '' };
  /* 设备那一族不在这儿抠块：stdout 上只有一行指针，图在表面文件里（见 `gfxRef`）。 */
  if (gfxRef(s) !== null) return { kind: 'gfx', blocks: [], rest: s, ref: gfxRef(s) };
  const blocks = [];
  let rest = '';
  let i = 0;
  for (;;) {
    const a = s.indexOf('<svg', i);
    const b = a < 0 ? -1 : s.indexOf('</svg>', a);
    if (a < 0 || b < 0) { rest += s.slice(i); break; }
    rest += s.slice(i, a);
    blocks.push(s.slice(a, b + 6));
    i = b + 6;
  }
  return { kind: blocks.length > 0 ? 'svg' : null, blocks, rest };
}

export function epsToSvg(eps) {
  /* **位图先摘出来**（`image` 那一族）：三维那一族的 EPS 里一条路径都没有，全部内容
     就是一格 PS 的 image 字典 + 一大段十六进制（`asy_builtins.asy` 的 `asy__emitraw`）；
     二维的 `image(…)` 那一族走 ASCII85（`asy__emitimg`）。摘出来换成一格记号，
     于是下面那台小解释器照旧只管算子与坐标，位图在 `psImage` 里单独翻。 */
  const { text: epsText, imgs } = psImages(eps);
  const toks = [];
  {
    /* 词法：`%` 到行尾是注释（`%%BoundingBox` 例外，上头另外抠）；`{…}` 整段跳过
       （序言里那格 `/Setlinewidth {…} bind def`）；`[…]` 收成一格。 */
    const re = /\[|\]|\{|\}|\/?[^\s[\]{}%]+|%[^\n]*/g;
    let m = re.exec(epsText);
    let depth = 0;
    while (m !== null) {
      const t = m[0];
      if (t.startsWith('%')) { /* 注释 */ }
      else if (t === '{') depth++;
      else if (t === '}') depth = Math.max(0, depth - 1);
      else if (depth === 0) toks.push(t);
      m = re.exec(epsText);
    }
  }
  /* 画布：**优先 `%%HiResBoundingBox`**（浮点那一份）。只认整数那一份的话，
     205.5 会被当成 205 —— 量出来就是整张图横着差 0.5 单位（在 4 倍下是 2 像素，
     拿 gs 与 rsvg 的截图比时那条高对比的边界一眼看得见）。 */
  const bbh = /%%HiResBoundingBox:\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(eps);
  const bb = bbh ?? /%%BoundingBox:\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(eps);
  const box = bb === null ? [0, 0, 200, 200] : bb.slice(1, 5).map(Number);
  const st = { ctm: [1, 0, 0, 1, 0, 0], rgb: '#000', lw: 1, cap: 0, join: 0, dash: '' };
  const stack = [];
  const num = [];
  const at = (x, y) => {
    const [a, b, c, d, e, f] = st.ctm;
    return [a * x + c * y + e, b * x + d * y + f];
  };
  const f2 = (v) => (Math.round(v * 100) / 100);
  let d = '';
  let cur = [0, 0];
  const parts = [];
  const pop = (n) => num.splice(Math.max(0, num.length - n), n).map(Number);
  const emit = (kind) => {
    if (d === '') return;
    const w = Math.max(0.35, st.lw);
    parts.push(kind === 'fill'
      ? `<path d="${d}" fill="${st.rgb}" fill-rule="${kind === 'eofill' ? 'evenodd' : 'nonzero'}"/>`
      : `<path d="${d}" fill="none" stroke="${st.rgb}" stroke-width="${f2(w)}"`
        + ` stroke-linecap="${['butt', 'round', 'square'][st.cap] ?? 'butt'}"`
        + ` stroke-linejoin="${['miter', 'round', 'bevel'][st.join] ?? 'miter'}"`
        + `${st.dash === '' ? '' : ` stroke-dasharray="${st.dash}"`}/>`);
  };
  for (const t of toks) {
    if (/^-?[\d.]+(e-?\d+)?$/i.test(t)) { num.push(t); continue; }
    switch (t) {
      case 'gsave': stack.push({ ...st, ctm: [...st.ctm] }); break;
      case 'grestore': { const p = stack.pop(); if (p) Object.assign(st, p); break; }
      case 'translate': { const [x, y] = pop(2); const [a, b, c, dd] = st.ctm;
        st.ctm = [a, b, c, dd, st.ctm[4] + a * x + c * y, st.ctm[5] + b * x + dd * y]; break; }
      case 'scale': { const [x, y] = pop(2);
        st.ctm = [st.ctm[0] * x, st.ctm[1] * x, st.ctm[2] * y, st.ctm[3] * y, st.ctm[4], st.ctm[5]]; break; }
      case 'concat': { const v = pop(6);
        const [a, b, c, dd, e, f] = st.ctm;
        st.ctm = [v[0] * a + v[1] * c, v[0] * b + v[1] * dd,
          v[2] * a + v[3] * c, v[2] * b + v[3] * dd,
          v[4] * a + v[5] * c + e, v[4] * b + v[5] * dd + f];
        break; }
      case 'newpath': d = ''; break;
      case 'moveto': { const [x, y] = pop(2); cur = at(x, y); d += `M${f2(cur[0])} ${f2(cur[1])}`; break; }
      case 'lineto': { const [x, y] = pop(2); cur = at(x, y); d += `L${f2(cur[0])} ${f2(cur[1])}`; break; }
      case 'curveto': { const v = pop(6);
        const p1 = at(v[0], v[1]); const p2 = at(v[2], v[3]); const p3 = at(v[4], v[5]);
        d += `C${f2(p1[0])} ${f2(p1[1])} ${f2(p2[0])} ${f2(p2[1])} ${f2(p3[0])} ${f2(p3[1])}`;
        cur = p3; break; }
      case 'closepath': d += 'Z'; break;
      case 'setrgbcolor': { const [r, g, b] = pop(3);
        const h = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
        st.rgb = `#${h(r)}${h(g)}${h(b)}`; break; }
      case 'setgray': { const [g] = pop(1);
        const h = Math.round(Math.min(1, Math.max(0, g)) * 255).toString(16).padStart(2, '0');
        st.rgb = `#${h}${h}${h}`; break; }
      case 'Setlinewidth': case 'setlinewidth': { const [w] = pop(1); st.lw = w; break; }
      case 'setlinecap': st.cap = pop(1)[0]; break;
      case 'setlinejoin': st.join = pop(1)[0]; break;
      case 'setdash': { num.length = 0; break; }
      /* PS 的数组：`[` 起头（前头攒下的数与它无关，清掉），`]` 什么都不做 ——
         **括号不许清数**：`[ a b c d e f] concat` 的六个数就在括号里，清掉的话
         `concat` 拿到的是六个 undefined，CTM 整条变 NaN。从前这一格是清的，
         而它没露馅只因为 `concat` 只跟位图一起出现，而位图那时被整句忽略。 */
      case '[': num.length = 0; break;
      case ']': break;
      case 'fill': emit('fill'); break;
      case 'eofill': emit('eofill'); break;
      case 'stroke': emit('stroke'); break;
      default: {
        /* **位图那一格**（上面摘出来的记号）：当前的 CTM 正好把单位正方形送到目标那块
           平行四边形上（`[ax ay bx by x y] concat`），所以一格 `<image>` 加同一个矩阵
           就摆对了。图自己那一格是**上下颠倒**的：PS 的第 0 行在下边，而 SVG 的
           `<image>` 从上往下画 —— 所以位图按"第 0 行在上"写（BMP 的负高度那一档），
           于是在这个 y 朝上的组里正好翻回来。核对过：gs 渲的 EPS 与 rsvg 渲的这份 SVG
           逐像素只差抗锯齿那一档（见 tests/serve 那一格）。 */
        if (t.startsWith('__OMNIIMG')) {
          const im = imgs[Number(t.slice(9))];
          const u = im === undefined ? null : psImageUri(im);
          if (u !== null) {
            const c = st.ctm.map((v) => f2(v)).join(' ');
            parts.push(`<image transform="matrix(${c})" x="0" y="0" width="1" height="1"`
              + ` preserveAspectRatio="none" href="${u}"/>`);
          }
          num.length = 0;
          break;
        }
        num.length = 0;    // 认不出的算子：清掉它的实参
        break;
      }
    }
  }
  const [x0, y0, x1, y1] = box;
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${w} ${h}"`
    + ` width="100%" style="max-height:100%">`
    + `<g transform="translate(0 ${y0 + y1}) scale(1 -1)">${parts.join('')}</g></svg>`;
}

/**
 * 把 EPS 里每一格 `image` 摘出来，原位换成一格记号 `__OMNIIMG<k>`。
 *
 * 形状是我们自己发的那两种（`asy_builtins.asy` 的 `asy__emitraw` / `asy__emitimg`）：
 *   `<< /ImageType 1 /Width W /Height H /BitsPerComponent 8 … >> image <数据><终止>`
 * 终止记号看 filter：十六进制那一族是 `>`，ASCII85 那一族是 `~>`。
 * **不能一律找 `>`**：ASCII85 的字母表是 `!`..`u`，`>` 正在里头（0x3E）。
 */
export function psImages(eps) {
  const imgs = [];
  let text = '';
  let i = 0;
  for (;;) {
    const a = eps.indexOf('<<', i);
    if (a < 0) { text += eps.slice(i); break; }
    const b = eps.indexOf('>>', a);
    const dict = b < 0 ? '' : eps.slice(a + 2, b);
    const rest = b < 0 ? '' : eps.slice(b + 2, b + 40);
    if (b < 0 || !/^\s*image\b/.test(rest) || !/\/ImageType\s+1/.test(dict)) {
      text += eps.slice(i, a + 2);
      i = a + 2;
      continue;
    }
    const c = eps.indexOf('image', b) + 5;
    const a85 = /ASCII85Decode/.test(dict);
    const term = a85 ? '~>' : '>';
    const e = eps.indexOf(term, c);
    const data = e < 0 ? eps.slice(c) : eps.slice(c, e);
    const gw = /\/Width\s+(\d+)/.exec(dict);
    const gh = /\/Height\s+(\d+)/.exec(dict);
    text += `${eps.slice(i, a)} __OMNIIMG${imgs.length} `;
    imgs.push({
      w: gw === null ? 0 : Number(gw[1]),
      h: gh === null ? 0 : Number(gh[1]),
      a85,
      data,
    });
    i = e < 0 ? eps.length : e + term.length;
  }
  return { text, imgs };
}

/**
 * `std/` 底下那几份库（控制台开头那一行提示用它）。
 *
 * **它是一份清单，所以会过期** —— 判据把它钉在真目录上：`tests/serve/run.js` 里
 * 那一格读 `src/lib/*.omni` 与这张表逐个比，添一份库忘了写进来就是红的。
 */
export const STD_LIBS = [
  ['matrix', '矩阵：解方程 / 逆 / 行列式'],
  ['num', '数值：积分 / 拟合 / 求根 / FFT / ODE'],
  ['plot', '折线图（出 SVG）'],
  ['turtle', '海龟绘图（logo 那一套）'],
  ['complex', '复数'],
  ['rand', '随机数（minstd）'],
  ['spec', '特殊函数：Γ / B / erf'],
  ['json', 'JSON 与动态值的打印'],
];

/**
 * 一格 PS 位图 -> `data:image/png;base64,…`（回 null = 说不通，那就不画）。
 *
 * **PNG，而且是"不压缩的 PNG"**。两条理由：
 *   * 这一格必须是**纯函数**（判据在 node 里直接 import 它，没有 canvas、也不该拉 zlib
 *     进来），而 deflate 有一档合法的"原样存"（stored block，每段最多 65535 字节）——
 *     于是只要 CRC32 与 Adler32 两张小算术就够了，一共几十行。
 *   * BMP 更短（表头 + 像素，二十行），**可是只有浏览器认**：量出来 `rsvg-convert`
 *     根本不画 `data:image/bmp`（整张白），于是"拿 gs 渲 EPS、拿 rsvg 渲 SVG 比像素"
 *     这条判据就做不成了。换 PNG 之后那条判据能跑 —— 判据比省几行代码要紧。
 *
 * 行序：PNG 从上往下写，我们**按数据的倒序写**（最后一行写在最上）。理由是量出来的：
 * PS 的第 0 行在下边，`<image>` 又摆在那个 `scale(1 -1)` 的组里 —— 照数据顺序写的话
 * 出来是上下颠倒的（拿 gs 渲 EPS、rsvg 渲 SVG 比过：颠倒那一版 RMSE 0.070，倒序之后
 * 降到 0.009，剩下的是两台光栅器的抗锯齿差）。
 */
export function psImageUri(im) {
  const { w, h } = im;
  if (!(w > 0) || !(h > 0)) return null;
  const px = im.a85 ? a85Decode(im.data) : hexDecode(im.data);
  if (px.length < w * h * 3) return null;
  /* 原始扫描线：每行前面一个 0（filter = None）。行序倒过来（见上面那段）。 */
  const row = w * 3;
  const raw = new Uint8Array((row + 1) * h);
  for (let y = 0; y < h; y++) {
    const src = y * row;
    raw[y * (row + 1)] = 0;
    raw.set(px.subarray(src, src + row), y * (row + 1) + 1);
  }
  const idat = zlibStored(raw);
  const ihdr = new Uint8Array(13);
  const be = (a, o, v) => {
    a[o] = (v >>> 24) & 255; a[o + 1] = (v >>> 16) & 255;
    a[o + 2] = (v >>> 8) & 255; a[o + 3] = v & 255;
  };
  be(ihdr, 0, w);
  be(ihdr, 4, h);
  ihdr[8] = 8;     // 每通道 8 位
  ihdr[9] = 2;     // 真彩色（RGB）
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    be(out, 0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    be(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const cs = [chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  let n = sig.length;
  for (const c of cs) n += c.length;
  const png = new Uint8Array(n);
  png.set(sig, 0);
  let o = sig.length;
  for (const c of cs) { png.set(c, o); o += c.length; }
  return `data:image/png;base64,${b64(png)}`;
}

/** zlib 流，**整段原样存**（deflate 的 stored block，每段最多 65535 字节）。 */
function zlibStored(raw) {
  const N = 65535;
  const blocks = Math.max(1, Math.ceil(raw.length / N));
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  out[0] = 0x78; out[1] = 0x01;                  // CM=deflate、无字典、最快那一档
  let o = 2;
  for (let i = 0; i < raw.length || i === 0; i += N) {
    const len = Math.min(N, raw.length - i);
    const last = i + len >= raw.length ? 1 : 0;
    out[o] = last; o += 1;                        // BFINAL + BTYPE=00
    out[o] = len & 255; out[o + 1] = (len >> 8) & 255;
    out[o + 2] = ~len & 255; out[o + 3] = (~len >> 8) & 255;
    o += 4;
    out.set(raw.subarray(i, i + len), o);
    o += len;
    if (last === 1) break;
  }
  const ad = adler32(raw);
  out[o] = (ad >>> 24) & 255; out[o + 1] = (ad >>> 16) & 255;
  out[o + 2] = (ad >>> 8) & 255; out[o + 3] = ad & 255;
  return out.subarray(0, o + 4);
}

function adler32(b) {
  let a = 1;
  let s = 0;
  for (let i = 0; i < b.length; i++) {
    a = (a + b[i]) % 65521;
    s = (s + a) % 65521;
  }
  return ((s << 16) | a) >>> 0;
}

let CRCT = null;
function crc32(b) {
  if (CRCT === null) {
    CRCT = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRCT[i] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRCT[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 十六进制文本 -> 字节（空白与换行随便夹，`asy__emitraw` 就是一长行）。 */
function hexDecode(s) {
  const t = s.replace(/[^0-9a-fA-F]/g, '');
  const n = t.length >> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(t.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** ASCII85 -> 字节（`z` 是四个 0；末尾不足五个按规矩补 `u`）。 */
function a85Decode(s) {
  const bytes = [];
  let tup = 0;
  let n = 0;
  for (const ch of s) {
    if (ch === 'z' && n === 0) { bytes.push(0, 0, 0, 0); continue; }
    const v = ch.charCodeAt(0) - 33;
    if (v < 0 || v > 84) continue;               // 空白与别的都跳过
    tup = tup * 85 + v;
    n += 1;
    if (n === 5) {
      bytes.push((tup >>> 24) & 255, (tup >>> 16) & 255, (tup >>> 8) & 255, tup & 255);
      tup = 0; n = 0;
    }
  }
  if (n > 1) {
    for (let k = n; k < 5; k++) tup = tup * 85 + 84;
    const b = [(tup / 16777216) & 255, (tup >>> 16) & 255, (tup >>> 8) & 255, tup & 255];
    for (let k = 0; k < n - 1; k++) bytes.push(b[k]);
  }
  return new Uint8Array(bytes);
}

/** 字节 -> base64。**分段**：`String.fromCharCode(...两百万个)` 会把栈冲爆。 */
function b64(bytes) {
  let s = '';
  const N = 0x8000;
  for (let i = 0; i < bytes.length; i += N) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(i + N, bytes.length)));
  }
  return btoa(s);
}

/* ---------------------------------------------------------------- GLSL 的源码修修
 *
 * 桌面 GL 的片元着色器 -> WebGL2（GLSL ES 3.00）。纯字符串活儿，所以住在这一份里（能判）。
 */
/**
 * 桌面 GL 的片元着色器 -> WebGL2（GLSL ES 3.00）。
 *
 * ⚠️ **`#version` 那一行可能不在第一行**：判据里 vispy 那几份前头有十来行注释
 * （桌面编译器容得下"注释在 #version 之前"）。所以这儿**不许只认行首那一处** ——
 * 从前写的是 `/^\s*#version[^\n]*\n/`，于是原来那句留在正文里，我们又在最前面加了一句，
 * 浏览器报 `'version' : #version directive must occur before anything else`
 * （量到的就是 `vispy-disc.frag`）。整份里把它抹掉，再把我们那句放到**第一个字节**。
 */
export function glslSource(src) {
  let s = src.replace(/^[ \t]*#version[^\n]*\r?\n?/gm, '');
  const pre = '#version 300 es\nprecision highp float;\n';
  /* 桌面写法里 `out vec4 名字;` 照收；没有 out 声明的（老 `gl_FragColor` 写法）补一格。 */
  if (!/\bout\s+vec4\s+\w+\s*;/.test(s)) s = `out vec4 fragColor;\n${s.replace(/\bgl_FragColor\b/g, 'fragColor')}`;
  return pre + s;
}

/** 片元着色器里那些**从顶点段进来**的量（`in vec2 v_uv;`）。回 `[[类型, 名字], …]`。 */
export function glslInputs(src) {
  const out = [];
  for (const m of src.matchAll(/(?:^|\n)[ \t]*in[ \t]+(float|vec2|vec3|vec4)[ \t]+([A-Za-z_]\w*)[ \t]*;/g)) {
    out.push([m[1], m[2]]);
  }
  return out;
}

/**
 * **配套的顶点段**。我们画的是一格铺满屏幕的三角形（`gl_VertexID`，不传顶点缓冲）。
 *
 * 为什么不能写死一份：片元段里写着 `in vec2 v_uv;` 的（`pretty.frag` 就是）在 ES 3.00 上
 * **链不上** —— 那一格输入没有对应的顶点输出。所以顶点段要照片元段的声明生成：
 * 每一格 `in` 配一格同名 `out`，值给那格三角形的 0..1 坐标（`vec2` 直接给，别的按位补齐）。
 */
export function glslVertex(src) {
  const ins = glslInputs(src);
  const val = (ty, p) => (ty === 'vec2' ? p
    : ty === 'float' ? `${p}.x`
      : ty === 'vec3' ? `vec3(${p}, 0.0)` : `vec4(${p}, 0.0, 1.0)`);
  return ['#version 300 es',
    ...ins.map(([ty, nm]) => `out ${ty} ${nm};`),
    'void main(){',
    ' vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));',
    ...ins.map(([ty, nm]) => ` ${nm} = ${val(ty, 'p')};`),
    ' gl_Position = vec4(p * 2.0 - 1.0, 0, 1);',
    '}'].join('\n');
}

/**
 * 这一份着色器**该画多大**。回 0 = 跟着显示区走。
 *
 * 为什么不是"一律铺满"：vispy 那几份把坐标写死了（`vec2 center = vec2(64.0, 64.0)`，
 * 冲的是 128² 的画布）—— 铺满一格大画布的话，那个圆点缩在左下角，看着像画错了。
 * 判据是**文件自己说的**：每份例子头上都有那一行 `omni run … --size 128`（这棵树的惯例），
 * 照它走，页面上看到的就与 `omni run x.frag -o out.png` 出的那张 PNG 是同一张图。
 *
 * 用了分辨率那一格 uniform 的（`u_res` / `iResolution` / …）是**与尺寸无关**的写法，
 * 那一族跟着显示区走（回 0），大屏上就是高清的。没写 `--size` 的按 256 —— 与 CLI 同一个默认。
 */
export function glslSizeOf(src) {
  if (/\b(u_res|u_resolution|iResolution|resolution)\b/.test(src)) return 0;
  const m = /--size[ \t]+(\d+)/.exec(src);
  return m === null ? 256 : Number(m[1]);
}

/**
 * 某一格 uniform **在源码里声明成什么类型**（没有那一格回 `null`）。
 *
 * 为什么要问类型而不是照一种喂：同一件事在两套惯例里类型不同 —— Shadertoy 的
 * `iMouse` 是 `vec4`（xy 当前位置、zw 按下的位置），而自己写的多半是 `vec2 u_mouse`；
 * 帧号那格有人写 `int iFrame`、有人写 `float u_frame`。喂错类型不是"值不对"，
 * 是 `gl.uniform2f` 打在 vec4 上 —— WebGL 直接报 `INVALID_OPERATION`，整张图不画。
 * 所以这一格照源码定，`glslRun` 按它选 `uniform2f` / `uniform4f` / `uniform1i` / `uniform1f`。
 *
 * 只认最朴素的那一行（`uniform <类型> <名字>;`，中间可以有 `highp` 那种限定符）——
 * 这棵树里的例子都是那么写的，猜更复杂的形态只会把判据变软。
 */
export function glslDeclType(src, names) {
  for (const n of names) {
    const re = new RegExp(`uniform\\s+(?:(?:lowp|mediump|highp)\\s+)?(\\w+)\\s+${n}\\s*[;[]`);
    const m = re.exec(src);
    if (m !== null) return m[1];
  }
  return null;
}

/* ---------------------------------------------------------------- Lab 模式
 *
 * 语法表、冲突、规则、解析树的格式化。全是纯函数，不碰 DOM。
 * 判据在 tests/studio（node 里直接 import）。
 */

/** 表面板的统计数字。 `tb` = `buildTable(g)` 的返回值。 */
export function labStats(tb) {
  return {
    states: tb.states.length,
    terms: tb.grammar.terms.size,
    nonterms: tb.grammar.nonterms.size,
    conflicts: tb.conflicts.length,
    rules: tb.rules.length - 1, // 去掉增广的 $accept 规则
  };
}

/** 冲突清单 → HTML 卡片。 */
export function labConflictsHtml(tb) {
  if (tb.conflicts.length === 0) {
    return '<div style="padding:10px;color:var(--ok);font-weight:600">✓ 零冲突</div>';
  }
  let h = '';
  for (const c of tb.conflicts) {
    h += '<div class="lab-conflict">'
      + `<span class="kind">${esc(c.kind)}</span> `
      + `状态 ${c.state}，记号 <code>${esc(c.token)}</code>`
      + '</div>';
  }
  return h;
}

/** 规则表 → HTML。 */
export function labRulesHtml(tb) {
  let h = '<div class="lab-rules">';
  const rules = tb.rules;
  for (let i = 0; i < rules.length - 1; i++) { // 去掉增广规则
    const r = rules[i];
    h += `<div class="rule"><span class="idx">${i}</span>`
      + `<span class="lhs">${esc(r.lhs)}</span> → `
      + `<span class="rhs">${r.rhs.map(esc).join(' ')}</span></div>`;
  }
  h += '</div>';
  return h;
}

/** 解析树 → 嵌套 HTML（树形视图）。 `n` 是 glrParse 的返回值。 */
export function labTreeHtml(n) {
  if (n === null || n === undefined) return '<div class="hint">（无解析结果）</div>';
  return '<div class="lab-tree-view">' + _treeNode(n) + '</div>';
}

function _treeNode(n) {
  if (n.kind === 'atom') {
    return `<div class="lab-node-head"><span class="leaf">${esc(n.value)}</span></div>`;
  }
  if (n.kind === 'string') {
    return `<div class="lab-node-head"><span class="leaf str">"${esc(n.value)}"</span></div>`;
  }
  // list
  const items = n.items ?? [];
  const tag = items.length > 0 && items[0].kind === 'atom' ? items[0].value : '';
  let h = '<div class="lab-node">';
  h += `<div class="lab-node-head"><span class="tag-name">${tag ? esc(tag) : '(…)'}</span></div>`;
  const start = tag ? 1 : 0;
  for (let i = start; i < items.length; i++) h += _treeNode(items[i]);
  h += '</div>';
  return h;
}

/** 解析树 → S-expression 文本。 */
export function labTreeSexpr(n, indent) {
  if (indent === undefined) indent = 0;
  const pad = '  '.repeat(indent);
  if (n === null || n === undefined) return '';
  if (n.kind === 'atom') return pad + n.value;
  if (n.kind === 'string') return pad + JSON.stringify(n.value);
  const items = n.items ?? [];
  if (items.length === 0) return pad + '()';
  // short list (all atoms/strings, fits in ~80 chars) → one line
  if (items.every((x) => x.kind !== 'list') && items.length <= 6) {
    const inner = items.map((x) => x.kind === 'string' ? JSON.stringify(x.value) : x.value).join(' ');
    if (inner.length < 72) return `${pad}(${inner})`;
  }
  let s = `${pad}(${items[0].kind === 'atom' ? items[0].value : ''}`;
  const start = items[0].kind === 'atom' ? 1 : 0;
  for (let i = start; i < items.length; i++) {
    s += '\n' + labTreeSexpr(items[i], indent + 1);
  }
  s += ')';
  return s;
}

/**
 * 示例面板比两串 S-expr **按空白归一之后**再比。
 *
 * 为什么不逐字节比：`labTreeSexpr` 会按长度决定"一行还是换行缩进"
 * （短表折成一行、长的摊开），所以同一棵树在加了一条规则之后**排版可能变、结构没变**。
 * 判据要盯的是结构，不是排版。归一之后 `(add 1 2)` 与
 * `(add\n  1\n  2)` 是同一格 —— 人手写期望值时也就不必猜缩进。
 */
export function labSexprEq(a, b) {
  const norm = (s) => String(s).replace(/\s+/g, ' ').replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')').trim();
  return norm(a) === norm(b);
}

/**
 * `ext/<目录名>` -> 那门语言的文件后缀（管线面板要它拼 `{ lang }`）。
 *
 * 为什么是一张手写的表：`omni-ext.json` 里的 `provides.exts` 只有三份填了
 * （量过：gsl-shell / lua / tiny），别的都靠 `omni-lang.js` 里 `registerLang` 那一句 ——
 * 那一句在运行期才执行，网页这侧拿不到。等哪天那几份 json 补齐了再回来删这张表。
 * **`gsl-shell` 落 `.lua`**：它是 lua 的方言（ADR-0037），文件后缀就是 `.lua`。
 */
export const LAB_LANG_EXT = {
  go: '.go', nim: '.nim', vlang: '.v', lua: '.lua', mojo: '.mojo',
  cpp: '.cpp', freebasic: '.bas', awk: '.awk', chez: '.ss', sbcl: '.lisp',
  'gsl-shell': '.lua', tiny: '.tiny',
};

/** 一份 `.grammar` 的仓库路径 -> 那门语言的后缀，或 null（没有对应的注册语言）。 */
export function labExtOfGrammar(path) {
  const parts = String(path).split('/');
  if (parts[0] !== 'ext' || parts.length < 2) return null;
  return LAB_LANG_EXT[parts[1]] ?? null;
}

/** 管线面板那几层（从源码到产物的次序）。 */
export const LAB_EMIT_FORMATS = ['ast', 'oir', 'mir', 'sx', 'js', 'c'];