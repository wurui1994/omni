/* Omni Studio —— **纯函数那一半**：文本进、HTML/SVG 出。一个 DOM 都不碰。
 *
 * 为什么单独一份：这三样（高亮、markdown、EPS -> SVG）是**能判的**——
 * 给一段输入、比一段输出。留在 `studio.js` 里就只能靠眼睛看，而那三样恰恰是
 * "看着像对的、其实少了一格"的重灾区。判据在 `tests/serve/run.js`（node 里直接 import
 * 这一份，不需要浏览器）。
 *
 * 纪律：**这一份里不许出现 `document` / `window`**。
 */

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
 * 为什么翻在这一头：EPS 那一轴的判据是**逐字节**的（tests/asy 那 192 份参考），
 * 在 asy 库里再加一条输出路会动到那条轴；而预览要的只是"看得见"。
 * 真正的 `emit svg`（在 asy 那条腿里出 SVG）是另一格，记在任务里。
 *
 * PS 的 y 轴朝上、SVG 朝下 —— 所以外层套一格 `translate(0,y0+y1) scale(1,-1)`，
 * 里头的坐标一律按 PS 的算，读起来与 EPS 正文对得上。
 */
export function epsToSvg(eps) {
  const toks = [];
  {
    /* 词法：`%` 到行尾是注释（`%%BoundingBox` 例外，上头另外抠）；`{…}` 整段跳过
       （序言里那格 `/Setlinewidth {…} bind def`）；`[…]` 收成一格。 */
    const re = /\[|\]|\{|\}|\/?[^\s[\]{}%]+|%[^\n]*/g;
    let m = re.exec(eps);
    let depth = 0;
    while (m !== null) {
      const t = m[0];
      if (t.startsWith('%')) { /* 注释 */ }
      else if (t === '{') depth++;
      else if (t === '}') depth = Math.max(0, depth - 1);
      else if (depth === 0) toks.push(t);
      m = re.exec(eps);
    }
  }
  const bb = /%%(?:HiRes)?BoundingBox:\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(eps);
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
      case 'fill': emit('fill'); break;
      case 'eofill': emit('eofill'); break;
      case 'stroke': emit('stroke'); break;
      default: num.length = 0; break;    // 认不出的算子：清掉它的实参
    }
  }
  const [x0, y0, x1, y1] = box;
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${w} ${h}"`
    + ` width="100%" style="max-height:100%">`
    + `<g transform="translate(0 ${y0 + y1}) scale(1 -1)">${parts.join('')}</g></svg>`;
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
