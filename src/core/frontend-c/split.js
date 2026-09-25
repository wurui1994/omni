/* src/core/frontend-c/split.js —— 顶层声明扫描器（ADR-0046 的 S1）
 *
 * 一句话：**用语法定边界，用原文的字节做内容**。这一层只回答"顶层那一格从第几个字节
 * 开始、到第几个字节结束"，`split` 那一层只做 slice 与 concat —— 于是"拆开再接回去
 * 逐字节等于原文"不是努力做到的，是**结构上成立**的（全部切片是 `[0,len)` 的一个划分）。
 *
 * 为什么不复用 `tccpp.js`：那一半是**预处理器**的词法层 —— 它一边取 token 一边展开宏、
 * 查头文件、按条件丢代码。而这件事要的恰恰相反：`polydraw.c` 头 8 行是 `#if 0` 包着的
 * nmake 脚本（**不是 C**），预处理之后它不存在，拿预处理后的 token 定边界那 8 行就丢了。
 * 所以这儿是一台独立的**生词法扫描器**：不展开宏、不查头、不求值条件。
 *
 * 函数体内部**一个字节都不解析** —— 体是花括号配对找到的，而"跳过串/字符常量/注释里的
 * 花括号"正好是词法层的事，所以这条路不欠什么。
 */

/** 这一格是什么。`skip` 是 `#if 0` 那种整段（里头可能压根不是 C）。 */
export const KIND = {
  pp: 'pp', skip: 'skip', func: 'func', proto: 'proto', var: 'var', type: 'type', tail: 'tail',
};

const isIdCh = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90)
  || (c >= 48 && c <= 57) || c === 95 || c === 36;
const isIdStart = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36;
const isSp = (c) => c === 32 || c === 9 || c === 13 || c === 10 || c === 12 || c === 11;

/** 从 `i` 起跳过一段注释；不是注释就回 `i`。 */
function skipComment(s, i) {
  if (s.charCodeAt(i) !== 47) return i;            // '/'
  const n = s.charCodeAt(i + 1);
  if (n === 47) {                                   // '//' 到行尾（认续行反斜杠）
    let j = i + 2;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 10) break;
      if (c === 92) { j += (s.charCodeAt(j + 1) === 13 ? 3 : 2); continue; }
      j++;
    }
    return j;
  }
  if (n === 42) {                                   // '/*' 到 '*/'
    let j = i + 2;
    while (j < s.length && !(s.charCodeAt(j) === 42 && s.charCodeAt(j + 1) === 47)) j++;
    return Math.min(j + 2, s.length);
  }
  return i;
}

/** 从 `i` 起跳过一个串或字符常量（`i` 指着引号）。认转义与续行。 */
function skipQuoted(s, i) {
  const q = s.charCodeAt(i);
  let j = i + 1;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 92) { j += 2; continue; }             // 反斜杠吃掉下一个（含换行）
    if (c === q) return j + 1;
    if (c === 10) return j;                          // 未闭合：到行尾就算（错在源码里，不在这儿）
    j++;
  }
  return j;
}

/** 跳过空白与注释，回第一个"有内容"的位置。 */
function skipBlank(s, i) {
  for (;;) {
    while (i < s.length && isSp(s.charCodeAt(i))) i++;
    const j = skipComment(s, i);
    if (j === i) return i;
    i = j;
  }
}

/** 一整行预处理指令的末尾（认续行反斜杠；行内的注释也算这一行的）。 */
function endOfDirective(s, i) {
  let j = i;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 92) { j += (s.charCodeAt(j + 1) === 13 ? 3 : 2); continue; }
    if (c === 47) { const k = skipComment(s, j); if (k !== j) { j = k; continue; } }
    if (c === 10) return j + 1;
    j++;
  }
  return j;
}

/** 这一行指令的名字（`#  define` -> `define`）。 */
function directiveName(s, i) {
  let j = skipBlank(s, i + 1);
  let k = j;
  while (k < s.length && isIdCh(s.charCodeAt(k))) k++;
  return s.slice(j, k);
}

/** `#if 0`（后面只许跟注释或行尾）—— 只有这一种形状触发整段文本跳过。 */
function isIfZero(s, i, name) {
  if (name !== 'if') return false;
  let j = i + 1;
  while (j < s.length && isSp(s.charCodeAt(j)) && s.charCodeAt(j) !== 10) j++;
  j += 2;                                    // 'if'
  /* **只许在同一行里找那个 `0`**：`skipBlank` 会跨过换行，于是 `#if 0 //注释` 那一行
     判到了**下一行**的第一个字符上（`eval.c:1` 就是这个形状，下一行是 nmake 的
     `!ifndef COMP`）—— 于是"整段跳过"没触发，nmake 脚本被当成 C 扫了，
     `eval.c` 一下只剩 35 格、8 个函数。踩过一次，记在这儿。 */
  while (j < s.length && isSp(s.charCodeAt(j)) && s.charCodeAt(j) !== 10) j++;
  if (s.charCodeAt(j) !== 48) return false;  // '0'
  j++;
  if (isIdCh(s.charCodeAt(j))) return false; // `0x1` / `0L` 不算
  while (j < s.length && isSp(s.charCodeAt(j)) && s.charCodeAt(j) !== 10) j++;
  const c = s.charCodeAt(j);
  if (c === 10 || c === 13 || j >= s.length) return true;
  /* 行尾的注释不算内容。 */
  const k = skipComment(s, j);
  if (k === j) return false;
  while (j < k && isSp(s.charCodeAt(j)) && s.charCodeAt(j) !== 10) j++;
  const d = s.charCodeAt(k);
  return k >= s.length || d === 10 || d === 13 || s.charCodeAt(k - 1) === 10;
}

/**
 * 一段 `#if 0 … #endif` 的末尾（认嵌套）。
 *
 * 为什么只对 `#if 0` 做文本跳过，别的 `#if` 一律当普通指令：`#ifdef _WIN32` 那种包着的
 * 是**声明**，照 C 扫才对；而 `#if 0` 里头按惯例是"留着不编的东西"，`polydraw.c` 里那一段
 * 就是 nmake 脚本 —— 那不是 C，扫它必错。
 */
function endOfIfZero(s, i) {
  let j = endOfDirective(s, i);
  let depth = 1;
  while (j < s.length && depth > 0) {
    j = skipBlank(s, j);
    if (s.charCodeAt(j) === 35) {                     // '#'
      const nm = directiveName(s, j);
      if (nm === 'if' || nm === 'ifdef' || nm === 'ifndef') depth++;
      else if (nm === 'endif') depth--;
      j = endOfDirective(s, j);
      continue;
    }
    /* 里头不是 C：一行一行吃过去就行。 */
    while (j < s.length && s.charCodeAt(j) !== 10) j++;
    if (j < s.length) j++;
  }
  return j;
}

/** 这一族关键字出现过就说明这一格是"类型"而不是"量"。 */
const TYPE_KW = new Set(['typedef', 'struct', 'union', 'enum']);

/** 这几个"长得像函数调用"的修饰不是函数名（`__declspec(naked) void nrnd()`）。 */
const ATTR_KW = new Set(['__declspec', '__attribute__', '__asm', 'asm', '_Alignas', 'alignas']);

/**
 * 从 `i`（已跳过空白，不是 `#`）起扫**一格顶层声明**，回 `{ kind, name, end }`。
 *
 * 判据只有三条，全在词法层：
 *   * 深度 0 的 `;` -> 声明结束（`var` / `proto` / `type`，看有没有那几个关键字）；
 *   * 深度 0 的 `{` -> 配对到 `}`；**配完看下一个 token**：是 `;` 就把它吃掉、这一格是
 *     `type`/`var`（`struct X {…} y;`），不是就到 `}` 为止、这一格是 `func`；
 *   * 名字：函数取"深度 0 的第一个 `(` 前面那个标识符"；别的取 `;`/`=`/`[` 前最后一个。
 *
 * K&R 那种老式形参（`f(a,b) int a,b; { … }`）也落在第二条里 —— 中间那几句声明在
 * `{` 之前，照旧被吃进同一格，正是我们要的（一格 = 一个函数的全部字节）。
 */
function scanDecl(s, i) {
  let j = i;
  let depth = 0;           // ( [ 的深度
  let name = '';           // 最近一个标识符
  let fname = '';          // 函数名（深度 0 的第一个 '(' 前那个）
  let sawKw = false;       // typedef/struct/union/enum 出现过
  let sawParen = false;    // 深度 0 出现过 '('
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (isSp(c)) { j++; continue; }
    if (c === 47) { const k = skipComment(s, j); if (k !== j) { j = k; continue; } }
    if (c === 34 || c === 39) { j = skipQuoted(s, j); continue; }
    if (c === 35) { j = endOfDirective(s, j); continue; } // 声明中间夹着的 #if/#endif
    if (isIdStart(c)) {
      let k = j;
      while (k < s.length && isIdCh(s.charCodeAt(k))) k++;
      const w = s.slice(j, k);
      if (TYPE_KW.has(w)) sawKw = true;
      if (depth === 0) name = w;
      j = k;
      continue;
    }
    if (c === 40 || c === 91) {                          // '(' '['
      /* `__declspec(naked)` 那一族不是函数名（踩过：8 个函数全叫 `__declspec`）。 */
      if (c === 40 && depth === 0 && !sawParen && !ATTR_KW.has(name)) {
        sawParen = true; fname = name;
      }
      depth++; j++; continue;
    }
    if (c === 41 || c === 93) { depth--; j++; continue; } // ')' ']'
    if (c === 59 && depth <= 0) {                        // ';'
      return { kind: sawKw ? KIND.type : (sawParen ? KIND.proto : KIND.var), name, end: j + 1 };
    }
    if (c === 123 && depth <= 0) {                       // '{'
      const close = matchBrace(s, j);
      /* **带 typedef/struct/union/enum 的那一档不在这儿收尾**：`typedef struct {…} foo;`
         的 `}` 后面还有声明符，要一直扫到深度 0 的 `;`（踩过一次：那六个 typedef 全被
         判成 `func`，名字还叫 `struct`）。只有"`}` 紧跟着 `;`"才是这儿结束。 */
      const nx = skipBlank(s, close);
      if (s.charCodeAt(nx) === 59) {
        return { kind: sawKw ? KIND.type : KIND.var, name: nameBefore(s, j, nx), end: nx + 1 };
      }
      if (sawKw) {
        const semi = semiAfter(s, close);
        return { kind: KIND.type, name: nameBefore(s, j, semi), end: semi };
      }
      return { kind: KIND.func, name: fname || name, end: close };
    }
    j++;
  }
  return { kind: sawKw ? KIND.type : KIND.var, name, end: j };
}

/** 从 `i` 起找深度 0 的 `;`（跳过串 / 注释 / 括号），回它后面那一格。 */
function semiAfter(s, i) {
  let j = i;
  let d = 0;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 47) { const k = skipComment(s, j); if (k !== j) { j = k; continue; } }
    if (c === 34 || c === 39) { j = skipQuoted(s, j); continue; }
    if (c === 40 || c === 91 || c === 123) d++;
    else if (c === 41 || c === 93 || c === 125) d--;
    else if (c === 59 && d <= 0) return j + 1;
    j++;
  }
  return j;
}

/** `{` 配对（跳过串 / 字符常量 / 注释里的花括号）。回 `}` 后面那一格。 */
function matchBrace(s, i) {
  let j = i + 1;
  let d = 1;
  while (j < s.length && d > 0) {
    const c = s.charCodeAt(j);
    if (c === 47) { const k = skipComment(s, j); if (k !== j) { j = k; continue; } }
    if (c === 34 || c === 39) { j = skipQuoted(s, j); continue; }
    if (c === 123) d++;
    else if (c === 125) d--;
    j++;
  }
  return j;
}

/** `struct {…} 名字;` 那一档的名字：`}` 与 `;` 之间最后一个标识符。 */
function nameBefore(s, open, semi) {
  const close = matchBrace(s, open);
  const mid = s.slice(close, semi);
  const ids = mid.match(/[A-Za-z_$][A-Za-z_0-9$]*/g);
  if (ids !== null && ids.length > 0) return ids[ids.length - 1];
  /* 没有声明符（`struct X {…};`）—— 名字在 `{` 前面。 */
  const head = s.slice(open > 200 ? open - 200 : 0, open).match(/[A-Za-z_$][A-Za-z_0-9$]*/g);
  return head === null ? '' : head[head.length - 1];
}

/**
 * 整份源码 -> 切片清单。**全部切片是 `[0, len)` 的一个划分**（这一条在下面 assert）。
 *
 * 一格切片 `{ kind, name, start, end, lead }`：`lead` 是"上一格结束到这一格开始"之间的
 * 那一段（注释、空行、`#define`…），它**跟着后面那一格走** —— 一段注释描述的是它下面
 * 那个函数，这是 C 的通例，也是让"函数带着它的注释一起搬家"的唯一办法。
 * 所以切片的字节区间是 `[lead, end)`，`start` 只是"正文从哪儿起"。
 */
export function scanTopLevel(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const lead = i;
    const at = skipBlank(src, i);
    if (at >= src.length) {                 // 尾巴上只剩空白与注释
      out.push({ kind: KIND.tail, name: '', lead, start: at, end: src.length });
      break;
    }
    if (src.charCodeAt(at) === 35) {        // '#'
      const nm = directiveName(src, at);
      const zero = isIfZero(src, at, nm);
      const end = zero ? endOfIfZero(src, at) : endOfDirective(src, at);
      out.push({ kind: zero ? KIND.skip : KIND.pp, name: nm, lead, start: at, end });
      i = end;
      continue;
    }
    if (src.charCodeAt(at) === 59) {        // 孤零零一个 ';'
      out.push({ kind: KIND.var, name: '', lead, start: at, end: at + 1 });
      i = at + 1;
      continue;
    }
    const d = scanDecl(src, at);
    out.push({ kind: d.kind, name: d.name, lead, start: at, end: d.end });
    i = d.end;
    if (d.end <= at) throw new Error(`c split: 扫描器在 ${at} 没前进（死循环兜底）`);
  }
  assertPartition(out, src.length);
  return out;
}

/** 划分完整性：首格从 0 起、逐格首尾相接、末格到尾。不成立就当场报（不许"大概对"）。 */
function assertPartition(chunks, len) {
  let at = 0;
  for (const c of chunks) {
    if (c.lead !== at) throw new Error(`c split: 第 ${chunks.indexOf(c)} 格从 ${c.lead} 起，应当是 ${at}`);
    at = c.end;
  }
  if (at !== len) throw new Error(`c split: 全部切片只覆盖到 ${at}，文件有 ${len} 字节`);
}

/** 把切片按次序接回去（判据用）。 */
export function joinChunks(src, chunks) {
  return chunks.map((c) => src.slice(c.lead, c.end)).join('');
}

/** 一格切片的行号（1 起）。清单与描述文件都用它消歧。 */
export function lineOf(src, off) {
  let n = 1;
  for (let i = 0; i < off; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}

/** `--scan`：把家底摊开（`种类 名字 行号 字节数`）。不作任何分类判断。 */
export function formatScan(src, chunks) {
  const out = [`# ${chunks.length} 格；列是 种类 名字 行号 字节数`];
  for (const c of chunks) {
    out.push(`${c.kind}\t${c.name}\t${lineOf(src, c.start)}\t${c.end - c.lead}`);
  }
  return `${out.join('\n')}\n`;
}

/**
 * 读描述文件：`目标文件<TAB>种类<TAB>符号名<TAB>行号`。
 *
 * 键是 `种类:名字:行号` —— 行号是**消歧用的**（`eval.c` 里四个 `rdtsc64`、两个
 * `kasm87err`）。允许 `*` 当行号：那一档"这个种类这个名字的全部格子都进这个文件"。
 */
export function readPlan(text) {
  const exact = new Map();
  const wild = new Map();
  let n = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '' || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 3) throw new Error(`c split: 描述文件这一行少列：${line}`);
    const [file, kind, name] = f;
    const at = f[3] === undefined || f[3] === '' ? '*' : f[3].trim();
    if (at === '*') wild.set(`${kind}:${name}`, file);
    else exact.set(`${kind}:${name}:${at}`, file);
    n++;
  }
  return { exact, wild, rows: n };
}

/** 这一格该去哪个文件（先精确、再通配）。没指派就回 null —— 调用方要报错。 */
export function targetOf(plan, src, c) {
  const k = `${c.kind}:${c.name}`;
  const e = plan.exact.get(`${k}:${lineOf(src, c.start)}`);
  if (e !== undefined) return e;
  const w = plan.wild.get(k);
  return w === undefined ? null : w;
}

/**
 * 照描述文件切。回 `{ files, manifest, missing }`：
 *   * `files`：目标文件名 -> 内容（**原文的字节，按原次序接起来**，一个字节不改）；
 *   * `manifest`：原次序的 `{ file, len }` 表 —— `--check` 拿它把几份产物"拉链"回原文；
 *   * `missing`：描述文件里没指派的格子（调用方要据此报错退出）。
 */
export function applyPlan(src, chunks, plan) {
  const files = new Map();
  const manifest = [];
  const missing = [];
  for (const c of chunks) {
    const f = targetOf(plan, src, c);
    if (f === null) { missing.push({ ...c, line: lineOf(src, c.start) }); continue; }
    const body = src.slice(c.lead, c.end);
    files.set(f, (files.get(f) ?? '') + body);
    manifest.push({ file: f, len: body.length });
  }
  return { files, manifest, missing };
}

/**
 * `--check`：拿 manifest 把几份产物按原次序"拉链"回来，与原文逐字节比。
 *
 * 这一条是 ADR-0046 的硬线：拆开再接回去**等于**原文。它同时验两件事 ——
 * 内容没被改（slice/concat 而已）与划分没漏（长度加起来正好是原文）。
 *
 * `synth` 那些格子是**新材料**（生成的 `#include` 行之类）：拉链时要**跳过内容、
 * 但照旧推进那份文件的游标** —— 不然后面全错位。
 */
export function checkRejoin(src, manifest, files) {
  const cur = new Map();
  let out = '';
  for (const m of manifest) {
    const at = cur.get(m.file) ?? 0;
    const piece = (files.get(m.file) ?? '').slice(at, at + m.len);
    if (m.synth !== true) out += piece;
    cur.set(m.file, at + m.len);
  }
  return { ok: out === src, got: out.length, want: src.length };
}

/**
 * **同一个文件的格子必须连着**（`--map` 的硬要求）。
 *
 * 为什么是硬要求：缝合文件（`stitchFile`）是"一份文件 `#include` 一次"，
 * 于是"缝起来的记号次序 = 原文次序"**只在每份文件占一段连续区间时成立**。
 * 不连续就等于悄悄重排了声明次序 —— C 里次序是有意义的（用之前要先声明）。
 * 头一版按名字指派，`eval.c` 的 10 份文件摊成 **69 段**，那份缝合文件是错的。
 *
 * 回不连续的那几份（文件名 -> 段数），全连续时回空表。
 */
export function contiguity(manifest) {
  const runsOf = new Map();
  let prev = null;
  for (const m of manifest) {
    if (m.synth === true) continue;
    if (m.file !== prev) runsOf.set(m.file, (runsOf.get(m.file) ?? 0) + 1);
    prev = m.file;
  }
  const bad = new Map();
  for (const [f, n] of runsOf) if (n > 1) bad.set(f, n);
  return bad;
}

/**
 * 一段文本里 `#if`/`#ifdef`/`#ifndef` 与 `#endif` 的净深度（跳过注释与串）。
 *
 * `#else`/`#elif` 不计 —— 它们不改深度，只换分支。
 */
function ppDelta(text) {
  let d = 0;
  let i = 0;
  let atLineStart = true;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 47) { const k = skipComment(text, i); if (k !== i) { i = k; continue; } }
    if (c === 34 || c === 39) { i = skipQuoted(text, i); atLineStart = false; continue; }
    if (c === 10) { atLineStart = true; i++; continue; }
    if (c === 35 && atLineStart) {
      const nm = directiveName(text, i);
      if (nm === 'if' || nm === 'ifdef' || nm === 'ifndef') d++;
      else if (nm === 'endif') d--;
      i = endOfDirective(text, i);
      atLineStart = true;
      continue;
    }
    if (c !== 32 && c !== 9 && c !== 13) atLineStart = false;
    i++;
  }
  return d;
}

/**
 * **每一份产物的条件编译必须自己配平**（`--map` 的第二道硬闸）。
 *
 * 为什么是硬要求：缝合走的是 `#include`，而 `#include` 的边界**不能**劈开一个
 * `#if … #endif` —— 预处理器要求每份文件里的条件自己闭合。踩过一次：`eval.c` 的
 * `#ifdef _MSC_VER`（`kasm_state.c` 末尾）与它的 `#else/#endif`（`kasm_cpu.c` 开头）
 * 被切点劈成两半，于是 `kasm_state.c: unterminated conditional directive` +
 * `kasm_cpu.c: #else without #if`，一条命令都编不过。四对文件全是这个形状。
 *
 * 回不配平的那几份（文件名 -> 净深度），全配平时回空表。
 */
export function ppBalance(files) {
  const bad = new Map();
  for (const [f, text] of files) {
    const d = ppDelta(text);
    if (d !== 0) bad.set(f, d);
  }
  return bad;
}

/**
 * **缝合文件**：按原次序 `#include` 那几份产物的一份 `.c`。
 *
 * 为什么要它（这一格决定了"拆分不动原文"能不能编过）：拆出来的模块里那些 `static`
 * 全局与函数**只在原来那一个翻译单元里可见**。要让它们分成真正独立的 `.o`，就得给
 * 跨模块用到的那些去掉 `static` 并在头里补 `extern` —— **那是改原文**，用户明令不许。
 *
 * 所以第一步走 unity build：`eval.c` 换成一份只有 `#include` 的壳，编译器看见的
 * 记号流与原来**一模一样**（次序就是 manifest 的次序），`static` 语义一个字没变，
 * 而人读代码时看的是拆开的那几份。`build.cmd` 一个字都不用改。
 *
 * 不补 `#line`：`#include` 本身就把 `__FILE__`/`__LINE__` 换成被包含那份文件的 ——
 * 报错与调试信息自然指到拆开后的那一份上。在 `#include` 前面写 `#line 1 "x"` 反而是错的
 * （那句说的是"下一行是 x 的第 1 行"，而下一行是 `#include` 自己）。
 */
export function stitchFile(source, manifest) {
  const seen = [];
  for (const m of manifest) {
    if (m.synth === true) continue;
    if (seen.length === 0 || seen[seen.length - 1] !== m.file) seen.push(m.file);
  }
  const out = [`/* ${source} —— 由 \`omni c split\` 生成的缝合文件（ADR-0046）。`,
    ' * 原文一个字节都没改：这几份 `#include` 的字节接起来**等于**原文，次序就是这里的次序。',
    ' * 为什么走 unity build 而不是各编成 .o：拆出来的模块里那些 `static` 只在原来那一个',
    ' * 翻译单元里可见，要分开编就得去掉 `static` 并补 `extern` —— 那是改原文，不许。',
    ' */'];
  for (const f of seen) out.push(`#include "${f}"`);
  return `${out.join('\n')}\n`;
}





