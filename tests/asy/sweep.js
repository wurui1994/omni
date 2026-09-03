// asy 例子的**快扫**：一个进程、一份 base 镜像。
//
// 为什么要这一份：一个例子一个进程时，prelude 与 plain/graph/three 那一摞每次都要重降一遍，
// 220 个例子跑掉 9 分钟 —— 改一刀量一遍的循环于是没法用。这里把「语法表、AST、
// 以及常用模块的降级结果」都只做一次，每个例子从镜像的一份浅拷贝起降，互相看不见
// （镜像的内容见 AsySession.snapshot）。量出来：220 个 2.8s，最慢一个 0.27s。
//
// 两个数分开报，不要混：
//   - **自己那一份**：例子文件里的诊断（base 模块的诊断在热身那一趟就报完了，不重复报）；
//   - **模块那一份**：热身时每个模块报了几条 —— `import three;` 还剩几条就在这里。
// 一个例子真正"能跑"要两边都为 0。
//
// 用法：
//   ASYMPTOTE_DIR=<真 base> node tests/asy/sweep.js <examples 目录> [文件…]
//   OMNI_SWEEP_WARM='import graph;import three;' 换热身的那串 import
//   OMNI_SWEEP_SX=1 顺带把降出来的核心方言也过一遍方言自己的检查（慢一档，见下面 SXCHK）
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// 静态 import 而不是 `await import(join(S, …))`：这一份也在**自解析轴**里
// （tests/js-roundtrip 把仓库里的每个 .js 都喂给我们自己的 JS 前端），而 async/await
// 不在那个子集里 —— 这曾是那条轴上唯一的一条红。路径本来就是固定的，动态 import
// 一样东西也没多给。
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { readGrammar } from '../../src/core/glr/grammar.js';
import { buildTable } from '../../src/core/glr/table.js';
import { readSexpr } from '../../src/core/sexpr/read.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { AsySession } from '../../src/core/frontend-asy/lower.js';
import { parseAsyBuiltins } from '../../src/core/frontend-asy/types.js';
// 核心方言那一层的检查（只在 OMNI_SWEEP_SX=1 时用，见下面 SXCHK 那一段话）
import { lowerCoreSexpr } from '../../src/core/sexpr/lower.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const S = join(HERE, '..', '..', 'src', 'core');

const gpath = join(S, 'frontend-asy/asy.grammar');
const gdiag = new Diagnostics();
const g = readGrammar(readSexpr(new SourceFile(gpath, readFileSync(gpath, 'utf8')), gdiag), gdiag);
gdiag.throwIfErrors();
const tb = buildTable(g);
const builtins = parseAsyBuiltins(readFileSync(join(S, 'frontend-asy/builtins.tab'), 'utf8'));

// AST 只解析一次（base 那一摞在 220 个例子之间共用同一份树）
const trees = new Map();
function parseSrc(p, text) {
  const had = trees.get(p);
  if (had !== undefined) return had;
  const pd = new Diagnostics();
  const file = new SourceFile(p, text);
  const toks = lexText(tb.grammar.lex, file, pd);
  pd.throwIfErrors();
  const t = glrParse(tb, toks, pd);
  pd.throwIfErrors();
  trees.set(p, t);
  return t;
}
const parseFile = (p) => parseSrc(p, readFileSync(p, 'utf8'));

/** span 里存的是**字节偏移**，行列要现算（漏了这一步会打出 undefined:undefined） */
const lc = (sp) => {
  const { line, col } = sp.file.lineCol(sp.start);
  return `${line}:${col}`;
};

const dirs = [];
if (process.env.ASYMPTOTE_DIR) for (const d of process.env.ASYMPTOTE_DIR.split(':')) if (d) dirs.push(d);
dirs.push(join(HERE, '..', '..', 'src', 'lib', 'asy'));
const exDir = process.argv[2];
const SXCHK = process.env.OMNI_SWEEP_SX === '1';
/**
 * 把两份 `(module …)` 接成一份（深一格那一档要用）。`sess.add` 每一趟回的都是一份**完整**的
 * `(module …)`，而一份核心方言源文件"是恰好一个 (module …)" —— 直接拼起来方言那边第一句就拒。
 *
 * 两处要剪：
 *   - 前一份（热身）的收尾括号，**连它自己的 `(main …)` 一起剪** —— 一份模块"(main …) 只能有一个"，
 *     两份都带 main 时方言那边每个例子都只会报这一条，底下真正的错一条也看不见（量过）。
 *     剪掉热身的 main 只少检查"那一摞模块的初始化调用"，那一份在下面 warmSx 里整份过一遍。
 *   - 后一份的 `(module` 与收尾括号。
 * `(main` 顶在 2 个空格那一列（模块里的顶层形式都是这一列，函数体里至少 4 个空格），
 * 所以按 `\n  (main` 找最后一处就够。
 */
const modHead = (a) => {
  const im = a.lastIndexOf('\n  (main');
  if (im >= 0) return a.slice(0, im);
  const ia = a.lastIndexOf(')');
  return ia < 0 ? null : a.slice(0, ia);
};
const spliceMod = (head, b) => {
  const ib = b.indexOf('(module');
  if (head === null || ib < 0) return null;
  const tail = b.slice(ib + '(module'.length);
  const ic = tail.lastIndexOf(')');
  if (ic < 0) return null;
  return `${head}\n${tail.slice(0, ic)}\n)`;
};
if (exDir === undefined) {
  console.error('用法：node tests/asy/sweep.js <examples 目录> [文件…]');
  process.exit(2);
}
const load = (name) => {
  const cands = name.indexOf('.') < 0 ? [name] : [name, name.split('.').join('/')];
  for (const nm of cands) {
    const q = join(exDir, `${nm}.asy`);
    if (existsSync(q)) return parseFile(q);
  }
  for (const d of dirs) {
    for (const nm of cands) {
      const q = join(d, `${nm}.asy`);
      if (existsSync(q)) return parseFile(q);
    }
  }
  return null;
};

const sess = new AsySession({ path: '<sweep>', load, builtins, prelude: 'asy_builtins' });
// 热身用 `access` 而不是 `import`：access 只把模块**降**出来（缓存住），不把名字摊进 0 号单元。
// 用 import 热身量出来是**假的** —— stats/patterns 那些摊进来的 N、E 会遮住 plain 的同名量，
// 例子里于是冒出三十来条 `label(string,pair,real[])` 匹配不上的假诊断。
const WARM = process.env.OMNI_SWEEP_WARM
  || 'access graph;access three;access graph3;access solids;access geometry;'
   + 'access contour;access palette;access math;access stats;access patterns;';

// 热身：prelude、autoplain 与上面那串模块都只降这一次。它们的诊断按**文件**分组报出来 ——
// 那是"模块那一份"，与例子自己的诊断分开算。
const warmDiags = new Diagnostics();
const warmText = sess.add(parseSrc('<warm>', `${WARM}\nint asy__sweep_warm=0;\n`), warmDiags);
const modBad = new Map();
for (const it of warmDiags.items) {
  if (it.severity !== 'error') continue;
  const sp = it.span;
  const f = sp === null || sp === undefined ? '?' : sp.file.path.replace(/^.*\//, '');
  modBad.set(f, (modBad.get(f) === undefined ? 0 : modBad.get(f)) + 1);
}
const base = sess.snapshot();
// 深一格那一档要用的两样：热身那一段（剪掉它自己的 main 之后）占多少行 ——
// 例子的错按行号与它分开；以及热身那一段**整份**在核心方言那一层有几条错
// （每个例子都接了同一段，只报一次）。
const warmHead = SXCHK ? modHead(warmText) : null;
const warmLineN = SXCHK ? warmHead.split('\n').length : 0;
let warmSx = 0;
if (SXCHK) {
  const wd = new Diagnostics();
  try { lowerCoreSexpr(new SourceFile('<warm>.sx', warmText), wd); } catch (e) { warmSx = -1; }
  if (warmSx === 0) for (const it of wd.items) if (it.severity === 'error') warmSx++;
}

const files = process.argv.length > 3 ? process.argv.slice(3)
  : readdirSync(exDir).filter((f) => f.endsWith('.asy')).sort();
const t0 = Date.now();
let okN = 0;
let badN = 0;
let worst = 0;
let worstF = '';
for (const f of files) {
  const p = join(exDir, f);
  sess.restore(sess.cloneSnap(base));
  const diags = new Diagnostics();
  const st = Date.now();
  let first = '';
  let sxText = null;
  try {
    sxText = sess.add(parseFile(p), diags);
  } catch (e) {
    first = `throw: ${String(e.message).split('\n')[0].slice(0, 110)}`;
  }
  for (const it of diags.items) {
    if (it.severity !== 'error') continue;
    const sp = it.span;
    const at = sp === null || sp === undefined ? '?' : `${sp.file.path.replace(/^.*\//, '')}:${lc(sp)}`;
    if (first === '') first = `${at}: ${it.msg.split('\n')[0]}`;
    break;
  }
  // 深一格那一档（OMNI_SWEEP_SX=1）：把降出来的那份核心方言也过一遍方言自己的检查。
  // 为什么要分开：这把尺子平时只数**前端**那一层的诊断，于是"前端认下来、核心方言那边才炸"
  // 的那种错在例子面上看不见（量过一次：`... a` 整份接进可变形参时只改了类型名、码没转，
  // 报的是 `xxx.asy.sx:行:列`，而例子面照旧算"干净"）。
  // 注意得把**热身那一段也接在前面**：`sess.add` 回的是这一趟的增量，记录类型那些声明在
  // 热身那一段里 —— 只检查增量会冒出一堆"类型只能是 …"的假错（量过）。所以这一档慢
  // （每个例子都要读一遍几万行的方言文本），不是默认 —— 默认那一趟得留在 10s 里。
  if (first === '' && SXCHK && sxText !== null) {
    const sd = new Diagnostics();
    const merged = spliceMod(warmHead, sxText);
    if (merged === null) {
      first = 'sx: 接不起来（两份 (module …) 的形状变了？）';
    } else {
      try {
        lowerCoreSexpr(new SourceFile(`${p}.sx`, merged), sd);
      } catch (e) {
        first = `sx throw: ${String(e.message).split('\n')[0].slice(0, 110)}`;
      }
    }
    for (const it of sd.items) {
      if (it.severity !== 'error') continue;
      const sp = it.span;
      // 热身那一段自己的错不算在这个例子头上（每个例子都接了同一段，不然 220 个全一样）——
      // 那一份在下面"模块那一份（核心方言那一层）"里报一次。
      if (sp !== null && sp !== undefined && sp.file.lineCol(sp.start).line <= warmLineN) continue;
      const at = sp === null || sp === undefined ? '?' : `${sp.file.path.replace(/^.*\//, '')}:${lc(sp)}`;
      if (first === '') first = `${at}: ${it.msg.split('\n')[0]}`;
      break;
    }
  }
  const ms = Date.now() - st;
  if (ms > worst) { worst = ms; worstF = f; }
  if (first === '') { okN++; console.log(`OK   ${f} ${ms}ms`); } else { badN++; console.log(`DIAG ${f} ${ms}ms :: ${first}`); }
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`--- 例子自己那一份：${files.length} 个里干净 ${okN}、有诊断 ${badN}`
  + `（共 ${secs}s，最慢 ${worstF} ${worst}ms${SXCHK ? '；核心方言那一层也过了' : ''}）`);
if (modBad.size === 0) {
  console.log('--- 模块那一份：0 条');
} else {
  const parts = [];
  for (const [f, n] of modBad) parts.push(`${f} ${n}`);
  console.log(`--- 模块那一份（热身那一趟报的，例子里不重复报）：${parts.join('、')}`);
}
if (SXCHK) {
  console.log(`--- 模块那一份（核心方言那一层）：${warmSx < 0 ? '读不下来（throw）' : `${warmSx} 条`}`);
}
