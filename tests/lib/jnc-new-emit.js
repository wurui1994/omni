// tests/lib/jnc-new-emit.js —— **语句/表达式那条腿的第一把尺子**：`new` 那几格壳函数
//
// 旧降级把每一处 `new C(…)` 落成一格**壳函数**（实参在调用方求值、抄一份的活儿在被调里，
// lower.js:15328/15379/15406/15435）：
//   `new C` / `new C(…)`（类）      → `$newo<i>`，回 `(ptr 链的根)`
//   `new S` / `new S(…)`（结构体）  → `$news<i>`，回 `(ptr S)`
//   `new T { … }`（花括号初值）      → `$newc<i>`
// 编号是**源码次序**（一族一个计数器）—— 82-reactor.jnc 的四处 `new` 正好落成
// `$newo0..3`（Sess / Sess / Inl / Inl）。
//
// 这一刀只对**不带实参**的那几格（形参表是空的，类型不用定型就能拼出整行）；带实参的照样
// **占一个号**（不占号后面全错），但只记账不比。带 `[n]` 的 `new T[n]` 也先记账。
//
// 用法：node tests/lib/jnc-new-emit.js [文件数，默认 400] [--all]

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Diagnostics } from '../../src/core/source/diag.js';
import { initJnc, jncFrontEnd, jncParse } from '../../src/core/lang/jnc.js';
import { headOf, named } from '../../src/lang/jnc/adapt.js';
import { readAgg } from '../../src/lang/jnc/agg.js';
import { classRoot } from '../../src/lang/jnc/emit-agg.js';
import { nameText } from '../../src/lang/jnc/declare.js';

const argv = process.argv.slice(2);
const limit = Number(argv.find((a) => /^\d+$/.test(a)) ?? 400);
const all = argv.includes('--all');

function walkDir(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkDir(p, out);
    else if (e.endsWith('.jnc')) out.push(p);
  }
  return out;
}

/** 一份文件里 `import "x.jnc";` 那几条的路径。 */
function importPaths(tree) {
  const out = [];
  const dig = (n) => {
    if (n === null || n === undefined || typeof n !== 'object' || !Array.isArray(n.items)) return;
    if (headOf(n) === 'import') {
      const p = named(n)?.path;
      if (p !== null && p !== undefined && typeof p.value === 'string') out.push(p.value);
      return;
    }
    for (const it of n.items) dig(it);
  };
  dig(tree);
  return out;
}

/** 旧降级输出里每一格壳函数的头。 */
function shellsOf(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    const m = /^\s*\(fn (\$new[ocs]\d+) (\(.*\)) (.+)$/.exec(line);
    if (m !== null) out.set(m[1], `(fn ${m[1]} ${m[2]} ${m[3]}`);
  }
  return out;
}

/** 一格 `new` 的类型名（`new C` / `new C(…)` 的 `C`）。 */
function newTypeName(n) {
  const nm = named(n);
  const t = nm === null ? null : nm.type;
  if (t === null || t === undefined) return null;
  const segs = [];
  const dig = (x) => {
    if (x === null || x === undefined || typeof x !== 'object') return;
    if (!Array.isArray(x.items)) {
      if (typeof x.value === 'string' && /^[A-Za-z_]\w*$/.test(x.value)) segs.push(x.value);
      return;
    }
    for (const it of x.items.slice(1)) dig(it);
  };
  dig(t);
  return segs.length === 0 ? null : segs[segs.length - 1];
}

/** 这一格 `new` 带实参吗（`args` 那一格里有东西）。 */
function hasArgs(n) {
  const a = named(n)?.args;
  if (a === null || a === undefined) return false;
  const h = headOf(a);
  if (h === 'args') return named(a)?.first !== undefined;             // `(args 第一格)`
  return h !== null;
}

initJnc({ log: () => {} });
const tb = jncFrontEnd();
const files = walkDir('tests/jnc/cases').sort().slice(0, limit);

let filesOk = 0;
let cmp = 0;
let same = 0;
const diff = [];
const skip = new Map();
let noShell = 0;

for (const f of files) {
  let out = '';
  try {
    out = execFileSync('node', ['src/cli.js', 'emit', 'sx', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { continue; }
  let tree = null;
  try { tree = jncParse(tb, f, new Diagnostics()); } catch { continue; }
  const oracle = shellsOf(out);
  if (oracle.size === 0) continue;
  filesOk += 1;
  /* 环境（`new C` 要知道 C 是类还是结构体、类的根是谁）：入口 + import 进来的那几份。 */
  const env = new Map();
  const aggs = [];
  const trees = [];
  const seen = new Set([f]);
  const queue = importPaths(tree).slice();
  while (queue.length > 0) {
    const abs = join(f.slice(0, f.lastIndexOf('/')), queue.shift());
    if (seen.has(abs) || !existsSync(abs)) continue;
    seen.add(abs);
    let t2 = null;
    try { t2 = jncParse(tb, abs, new Diagnostics()); } catch { continue; }
    for (const r2 of importPaths(t2)) queue.push(r2);
    trees.push(t2);
  }
  trees.push(tree);
  const scanAggs = (n, owner) => {
    if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
    let inner = owner;
    /* **命名空间也是名字的前缀**（`namespace ui { class ToolBar … }` → `ui$ToolBar`）——
       不带它就把 `(ptr ui$ToolBar)` 发成了 `(ptr ToolBar)`（96-defconst / 98-extension）。 */
    if (headOf(n) === 'namespace') {
      const nn = named(n);
      const nm = nn === null ? null : nameText(nn.name);
      if (nm !== null) inner = owner === null ? nm : `${owner}$${nm}`;
    } else if (headOf(n) === 'agg') {
      const a = readAgg(n);
      const nm = a === null ? null : nameText(a.name);
      if (a !== null && nm !== null) {
        a.emitName = owner === null ? nm : `${owner}$${nm}`;
        inner = a.emitName;
        aggs.push(a);
        env.set(nm, {
          kind: a.word === 'union' ? 'union' : (a.word === 'struct' ? 'struct' : 'class'),
          name: a.emitName,
          agg: a,
        });
      }
    }
    for (const it of n.items) scanAggs(it, inner);
  };
  for (const t of trees) scanAggs(t, null);

  /* `new` 那几处**按源码次序**（同一族一个计数器）。 */
  const sites = [];
  const scanNew = (n) => {
    if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
    const h = headOf(n);
    if (h === 'new' || h === 'new-array' || h === 'new-curly') sites.push({ h, node: n });
    for (const it of n.items) scanNew(it);
  };
  for (const t of trees) scanNew(t);

  const note = (w) => skip.set(w, (skip.get(w) ?? 0) + 1);
  const next = { o: 0, s: 0, c: 0 };
  for (const st of sites) {
    const tn = newTypeName(st.node);
    const rec = tn === null ? undefined : env.get(tn);
    /* 哪一族：花括号初值是 `$newc`，结构体是 `$news`，类是 `$newo`；认不出来的记账。 */
    let fam = null;
    if (st.h === 'new-curly') fam = 'c';
    else if (rec !== undefined && rec.kind === 'class') fam = 'o';
    else if (rec !== undefined && (rec.kind === 'struct' || rec.kind === 'union')) fam = 's';
    if (st.h === 'new-array') { note('`new T[n]` 那一族'); continue; }
    if (fam === null) { note(`认不出 new 的类型（${tn ?? '?'}）`); continue; }
    const idx = next[fam];
    next[fam] += 1;                                                  // 带实参的也占一个号
    const name = `$new${fam}${idx}`;
    if (fam === 'c') { note('花括号初值那一族（要定型）'); continue; }
    if (hasArgs(st.node)) { note('带实参的 new（要定型）'); continue; }
    const root = rec.kind === 'class' ? classRoot(rec.agg, aggs, env) : rec.agg;
    const rn = root.emitName ?? nameText(root.name);
    const head = `(fn ${name} () (ptr ${rn})`;
    const want = oracle.get(name);
    if (want === undefined) { noShell += 1; continue; }
    cmp += 1;
    if (head === want) same += 1;
    else if (diff.length < 20) diff.push(`${f.split('/').pop()}\n      旧 ${want}\n      新 ${head}`);
  }
}

console.log(`带 new 壳的语料 ${filesOk} 份　对比 ${cmp} 行`
  + `　一模一样 ${same}（${(same / Math.max(cmp, 1) * 100).toFixed(1)}%）　不一致 ${cmp - same}`);
if (noShell > 0) console.log(`旧降级没发这一格壳：${noShell} 个`);
if (skip.size > 0) {
  console.log(`还没做（记账，不算对）：${[...skip].sort((a, b) => b[1] - a[1])
    .map(([w, n]) => `${w}×${n}`).join('  ')}`);
}
if (diff.length > 0) {
  console.log('\n对不上：');
  for (const d of (all ? diff : diff.slice(0, 5))) console.log(`  ${d}`);
}
process.exitCode = cmp > 0 && same === cmp ? 0 : 1;
