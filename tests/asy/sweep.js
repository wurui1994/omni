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
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const S = join(HERE, '..', '..', 'stage0', 'src');
const { lexText } = await import(join(S, 'glr/lex.js'));
const { glrParse } = await import(join(S, 'glr/driver.js'));
const { readGrammar } = await import(join(S, 'glr/grammar.js'));
const { buildTable } = await import(join(S, 'glr/table.js'));
const { readSexpr } = await import(join(S, 'sexpr/read.js'));
const { Diagnostics, SourceFile } = await import(join(S, 'source/diag.js'));
const { AsySession } = await import(join(S, 'frontend-asy/lower.js'));
const { parseAsyBuiltins } = await import(join(S, 'frontend-asy/types.js'));

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
dirs.push(join(HERE, '..', '..', 'stage0', 'lib', 'asy'));
const exDir = process.argv[2];
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
sess.add(parseSrc('<warm>', `${WARM}\nint asy__sweep_warm=0;\n`), warmDiags);
const modBad = new Map();
for (const it of warmDiags.items) {
  if (it.severity !== 'error') continue;
  const sp = it.span;
  const f = sp === null || sp === undefined ? '?' : sp.file.path.replace(/^.*\//, '');
  modBad.set(f, (modBad.get(f) === undefined ? 0 : modBad.get(f)) + 1);
}
const base = sess.snapshot();

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
  try {
    sess.add(parseFile(p), diags);
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
  const ms = Date.now() - st;
  if (ms > worst) { worst = ms; worstF = f; }
  if (first === '') { okN++; console.log(`OK   ${f} ${ms}ms`); } else { badN++; console.log(`DIAG ${f} ${ms}ms :: ${first}`); }
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`--- 例子自己那一份：${files.length} 个里干净 ${okN}、有诊断 ${badN}`
  + `（共 ${secs}s，最慢 ${worstF} ${worst}ms）`);
if (modBad.size === 0) {
  console.log('--- 模块那一份：0 条');
} else {
  const parts = [];
  for (const [f, n] of modBad) parts.push(`${f} ${n}`);
  console.log(`--- 模块那一份（热身那一趟报的，例子里不重复报）：${parts.join('、')}`);
}
