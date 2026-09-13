// tests/lib/jnc-crt-emit.js —— **运行期助手**那条腿的第一把尺子：字符那一族（`jnc$crt$…`）
//
// 这一族是新降级第一处**连体一起发**的东西：源码里没有它的体，体就是规则本身
// （`src/lang/jnc/runtime-crt.js` 那张表）。所以量的不是"头对不对"，是**整格函数**对不对。
//
// 尺子：拿旧降级的真输出当外部尺（`node src/cli.js emit sx 文件.jnc`）。
// 旧降级"这一格名字被调了就发一格壳"（lower.js:13385 crtCharFn，一个名字一格、不重复），
// 所以新腿要做的是同一件事：扫出**被调到的**那几个名字，一格发一格。
//
// 三栏账（与别的尺子一样）：
//   1. 拼不出来的（记账，不算对）
//   2. **新腿发了、旧降级没有这个名字的**（防着凭空多发）
//   3. 旧降级发了、新腿还没试的（覆盖）
//
// 用法：node tests/lib/jnc-crt-emit.js [文件数，默认 400] [--all]

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Diagnostics } from '../../src/core/source/diag.js';
import { initJnc, jncFrontEnd, jncParse } from '../../src/core/lang/jnc.js';
import { headOf, named } from '../../src/lang/jnc/adapt.js';
import { crtCharShell, isCrtChar } from '../../src/lang/jnc/runtime-crt.js';

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

/**
 * 旧降级输出里那几格 `jnc$crt$…` 助手（**整格**，两行）。
 * 顶层的东西都是两格缩进、体四格，所以"下一行"就是它的体。
 */
function crtShellsOf(text) {
  const out = new Map();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^ {2}\(fn jnc\$crt\$(\w+) /.exec(lines[i]);
    if (m === null) continue;
    out.set(m[1], `${lines[i]}\n${lines[i + 1] ?? ''}`);
  }
  return out;
}

/** 一份树里**被调到**的字符助手名字（按第一次出现的次序）。 */
function crtCallsIn(tree) {
  const out = [];
  const dig = (n) => {
    if (n === null || n === undefined || typeof n !== 'object' || !Array.isArray(n.items)) return;
    if (headOf(n) === 'call') {
      /* 洞名照公共节点表来：`(call fn args)`（common-nodes.js:42）。被调是**裸名字**才算 ——
         `io.isdigit(…)` 那种是成员访问，不是这一族。 */
      const fn = named(n)?.fn;
      if (fn !== null && fn !== undefined && Array.isArray(fn.items) && headOf(fn) === 'name') {
        const nm = String(named(fn)?.text?.value ?? '');
        if (isCrtChar(nm) && !out.includes(nm)) out.push(nm);
      }
    }
    for (const it of n.items) dig(it);
  };
  dig(tree);
  return out;
}

initJnc({ log: () => {} });
const tb = jncFrontEnd();
const files = walkDir('tests/jnc/cases').sort().slice(0, limit);

let filesOk = 0;
let cmp = 0;
let same = 0;
const diff = [];
let extra = 0;                                                       // 新腿发了、旧降级没有这个名字的
const extraAt = [];
let missed = 0;                                                      // 旧降级发了、新腿没试的
const missedAt = [];

for (const f of files) {
  let out = '';
  try {
    out = execFileSync('node', ['src/cli.js', 'emit', 'sx', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { continue; }
  const oracle = crtShellsOf(out);
  let tree = null;
  try { tree = jncParse(tb, f, new Diagnostics()); } catch { continue; }
  const used = crtCallsIn(tree);
  if (oracle.size === 0 && used.length === 0) continue;
  filesOk += 1;
  const short = f.split('/').pop();
  for (const nm of used) {
    const mine = crtCharShell(nm);
    const want = oracle.get(nm);
    if (want === undefined) { extra += 1; extraAt.push(`${short}　jnc$crt$${nm}`); continue; }
    cmp += 1;
    if (mine === want) same += 1;
    else if (diff.length < 20) diff.push(`${short}　jnc$crt$${nm}\n      旧 ${want}\n      新 ${mine}`);
  }
  for (const nm of oracle.keys()) {
    if (!used.includes(nm)) { missed += 1; missedAt.push(`${short}　jnc$crt$${nm}`); }
  }
}

console.log(`带字符助手的语料 ${filesOk} 份　对比整格函数 ${cmp} 格`
  + `　一模一样 ${same}（${(same / Math.max(cmp, 1) * 100).toFixed(1)}%）　不一致 ${cmp - same}`);
if (extra > 0) {
  console.log(`新腿发了、旧降级没有这个名字的：${extra} 格　→ ${extraAt.slice(0, 8).join('  ')}`);
}
if (missed > 0) {
  console.log(`旧降级发了、新腿还没试的：${missed} 格　→ ${missedAt.slice(0, 8).join('  ')}`);
}
if (diff.length > 0) {
  console.log('\n对不上：');
  for (const d of (all ? diff : diff.slice(0, 5))) console.log(`  ${d}`);
}
process.exitCode = cmp > 0 && same === cmp && extra === 0 && missed === 0 ? 0 : 1;
