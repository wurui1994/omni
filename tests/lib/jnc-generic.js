// tests/lib/jnc-generic.js —— 泛型**单态化**两条腿并跑：新表造出来的实例名 vs 旧降级真发的
//
// 外部尺照旧是旧降级的真输出（`node src/cli.js emit sx x.jnc`）：泛型在那边落成一格一格
// `(struct Box$int …)`，所以"该造哪几格实例"这件事是**看得见**的。这把尺子逐名对：
//   - 少造了（旧降级有、新表没有）→ 缺一条规则；
//   - 多造了（新表有、旧降级没有）→ 造多了（旧降级只造用得着的那几格）。
// 造不出来的那几笔记账（不猜）。
//
// 用法：node tests/lib/jnc-generic.js [文件数，默认 400]

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Diagnostics } from '../../src/core/source/diag.js';
import { initJnc, jncFrontEnd, jncParse } from '../../src/core/lang/jnc.js';
import { templateTable, expandTemplates } from '../../src/lang/jnc/generic.js';

const argv = process.argv.slice(2);
const CORPUS = 'tests/jnc/cases';
const limit = Number(argv.find((a) => /^\d+$/.test(a)) ?? 400);
const all = argv.includes('--all');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.jnc')) out.push(p);
  }
  return out;
}

initJnc({ log: () => {} });
const tb = jncFrontEnd();
const files = walk(CORPUS).sort().slice(0, limit);

let filesWithTmpl = 0;
let want = 0;
let got = 0;
const missing = [];
const extra = [];
const fails = new Map();

for (const f of files) {
  let tree = null;
  try { tree = jncParse(tb, f, new Diagnostics()); } catch { continue; }
  const templates = templateTable(tree);
  if (templates.size === 0) continue;
  let out = '';
  try {
    out = execFileSync('node', ['src/cli.js', 'emit', 'sx', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { continue; }
  filesWithTmpl += 1;
  /* 旧降级发出来的、名字以某个模板名打头的那几格结构体 —— 就是它造的实例。 */
  const oracle = new Set();
  for (const m of out.matchAll(/\(struct ([A-Za-z_$][\w$]*)\s/g)) {
    for (const base of templates.keys()) {
      if (m[1].startsWith(`${base}$`)) { oracle.add(m[1]); break; }
    }
  }
  /* 一格实例也可能**不发结构体**：类那一族一整条继承链只发一格，派生的那格实例并进了根
     （129-baseparam.jnc 的 `ImplC$BaseC` 并进 `struct BaseC`，只在 `ImplC$BaseC$val`
     这个函数名里露头）。所以再收一遍**所有**以模板名打头的标识符，拿来认这一类实例。 */
  const seen = new Set();
  for (const m of out.matchAll(/[A-Za-z_$][\w$]*/g)) {
    for (const base of templates.keys()) {
      if (m[0].startsWith(`${base}$`)) { seen.add(m[0]); break; }
    }
  }
  const madeBy = (nm) => oracle.has(nm) || [...seen].some((s) => s.startsWith(`${nm}$`));
  const r = expandTemplates(tree, templates);
  for (const [w, n] of r.fails) fails.set(w, (fails.get(w) ?? 0) + n);
  const mine = new Set([...r.insts.keys()]);
  want += oracle.size;
  for (const nm of oracle) {
    if (mine.has(nm)) got += 1;
    else if (missing.length < 20) missing.push(`${f.split('/').pop()}　${nm}`);
  }
  for (const nm of mine) {
    if (!madeBy(nm) && extra.length < 20) extra.push(`${f.split('/').pop()}　${nm}`);
    else if (!oracle.has(nm)) { want += 1; got += 1; }               // 并进根那一族（不发结构体）
  }
}

console.log(`带泛型的语料 ${filesWithTmpl} 份　旧降级造了 ${want} 格实例`
  + `　新表也造出来 ${got}（${(got / Math.max(want, 1) * 100).toFixed(1)}%）`);
if (fails.size > 0) {
  console.log(`造不出来（记账，不算对）：${[...fails].sort((a, b) => b[1] - a[1])
    .map(([w, n]) => `${w}×${n}`).join('  ')}`);
}
if (missing.length > 0) {
  console.log('\n少造了（旧降级有、新表没有）：');
  for (const d of (all ? missing : missing.slice(0, 8))) console.log(`  ${d}`);
}
if (extra.length > 0) {
  console.log('\n多造了（新表有、旧降级没有）：');
  for (const d of (all ? extra : extra.slice(0, 8))) console.log(`  ${d}`);
}
process.exitCode = want > 0 && got === want && extra.length === 0 ? 0 : 1;
