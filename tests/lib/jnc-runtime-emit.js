// tests/lib/jnc-runtime-emit.js —— **运行期助手**那条腿的尺子（整格函数：头 + 体）
//
// 这一族是新降级第一处**连体一起发**的东西：源码里没有它的体，体就是规则本身
// （`src/lang/jnc/runtime.js` 那两张表）。所以量的不是"头对不对"，是**整格函数**对不对。
// 现在量两族：
//   - 字符那一族 `jnc$crt$…`（旧降级 lower.js:13385 crtCharFn，被调到就发一格、不重复）
//   - 通知那一格 `jnc$mc_fire[$签名]`（lower.js:5279 mcFire，一种签名一格）
//
// 尺子：拿旧降级的真输出当外部尺（`node src/cli.js emit sx 文件.jnc`）。
//
// 三栏账（与别的尺子一样）：
//   1. 拼不出来的（记账，不算对）
//   2. **新腿发了、旧降级没有这个名字的**（防着凭空多发）
//   3. 旧降级发了、新腿还没试的（覆盖）
//
// 用法：node tests/lib/jnc-runtime-emit.js [文件数，默认 400] [--all]

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Diagnostics } from '../../src/core/source/diag.js';
import { initJnc, jncFrontEnd, jncParse } from '../../src/core/lang/jnc.js';
import { headOf, named } from '../../src/lang/jnc/adapt.js';
import { allInChain } from '../../src/lang/jnc/declare.js';
import { readDeclType } from '../../src/lang/jnc/types.js';
import { resolveType } from '../../src/lang/jnc/resolve-type.js';
import {
  crtCharShell, isCrtChar, mcFireShell, mcFireName,
  varBoxShell, varUnboxShell, variantStruct, VARIANT,
} from '../../src/lang/jnc/runtime.js';

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
 * 旧降级输出里那几格助手（**整格**）。头一行是 `  (fn 名字 …`，体是**缩进更深**的那几行 ——
 * 顶层的东西两格、体四格起，所以"往下收到不再缩进更深"就是整格。
 * 行数按族各不相同（字符那一族两行、通知五行、装箱四/五行），所以不写死行数。
 */
function shellsOf(text, re) {
  const out = new Map();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = re.exec(lines[i]);
    if (m === null) continue;
    const body = [lines[i]];
    for (let j = i + 1; j < lines.length && /^ {4}/.test(lines[j]); j += 1) body.push(lines[j]);
    out.set(m[1], body.join('\n'));
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

/**
 * 旧降级输出里那几格 `jnc$mc_fire…` 助手（**整格**，五行：头 + 四行体）。
 */
function mcShellsOf(text) {
  return shellsOf(text, /^ {2}\(fn (jnc\$mc_fire[\w$]*) /);
}

/**
 * 顶层（含名字空间里）那几格**事件**声明 → 方言那一侧的多播类型。
 * `event g_onTick();` / `multicast g_onPair(int a, int b);` 都落在说明符表里
 * （`SHAPE_WORDS` 把它们的形状改成 `event`），`resolveType` 答的是 `{ k:'mc', params }`。
 * 类里那几格成员事件先不收（那要 `this` 那一层）—— 记账。
 */
function topEvents(tree) {
  const out = new Map();
  const dig = (n) => {
    if (n === null || n === undefined || typeof n !== 'object' || !Array.isArray(n.items)) return;
    const h = headOf(n);
    if (h === 'fn-def' || h === 'agg') return;
    if (h === 'var-decl') {
      const vn = named(n);
      if (vn !== null) {
        for (const d of allInChain(vn.dcls, 'dcls-add', 'dcls')) {
          const dd = headOf(d) === 'init' ? named(d)?.dcl : d;
          const t = readDeclType(vn.specs, dd);
          if (t === null || t.name === null || t.shape !== 'event') continue;
          const r = resolveType(t, new Map());
          if (r.type !== null && r.type.k === 'mc') out.set(t.name, r.type);
        }
      }
      return;
    }
    for (const it of n.items) dig(it);
  };
  dig(tree);
  return out;
}

/** 一份树里**叫出去**的那几格事件（`g_onTick();`）→ 助手名字 -> 多播类型，按第一次出现的次序。 */
function mcFiresIn(tree, events) {
  const out = new Map();
  const dig = (n) => {
    if (n === null || n === undefined || typeof n !== 'object' || !Array.isArray(n.items)) return;
    if (headOf(n) === 'call') {
      const fn = named(n)?.fn;
      if (fn !== null && fn !== undefined && Array.isArray(fn.items) && headOf(fn) === 'name') {
        const mc = events.get(String(named(fn)?.text?.value ?? ''));
        if (mc !== undefined) {
          const nm = mcFireName(mc);
          if (!out.has(nm)) out.set(nm, mc);
        }
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
let byName = 0;                                                      // 只按名字对壳的文字那一栏
let byNameSame = 0;
let varMissed = 0;
const varMissedAt = [];

for (const f of files) {
  let out = '';
  try {
    out = execFileSync('node', ['src/cli.js', 'emit', 'sx', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { continue; }
  const oracle = shellsOf(out, /^ {2}\(fn jnc\$crt\$(\w+) /);
  const mcOracle = mcShellsOf(out);
  const varOracle = shellsOf(out, /^ {2}\(fn (jnc\$var\$[\w$]+) /);
  let tree = null;
  try { tree = jncParse(tb, f, new Diagnostics()); } catch { continue; }
  const used = crtCallsIn(tree);
  const fires = mcFiresIn(tree, topEvents(tree));
  if (oracle.size === 0 && used.length === 0 && mcOracle.size === 0 && fires.size === 0
    && varOracle.size === 0) continue;
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
  for (const [nm, mc] of fires) {
    const mine = mcFireShell(mc);
    const want = mcOracle.get(nm);
    if (want === undefined) { extra += 1; extraAt.push(`${short}　${nm}`); continue; }
    cmp += 1;
    if (mine === want) same += 1;
    else if (diff.length < 20) diff.push(`${short}　${nm}\n      旧 ${want}\n      新 ${mine}`);
  }
  for (const nm of mcOracle.keys()) {
    if (!fires.has(nm)) { missed += 1; missedAt.push(`${short}　${nm}`); }
  }
  /* **`variant_t` 那一族**：这一栏量的只是"给了名字，壳的文字对不对"——
     哪几格该发（触发点：一格值装进 variant、拆出来那几处强转）还没做，
     那要赋值/强转那一层。所以单独记一栏，不混进上面那个"名字与文字都由新腿定"的数里。 */
  for (const [nm, want] of varOracle) {
    const m = /^jnc\$var\$to\$(\w+)$/.exec(nm);
    const mine = m !== null ? varUnboxShell(m[1]) : varBoxShell(nm.slice('jnc$var$'.length));
    if (mine === null) { varMissed += 1; varMissedAt.push(`${short}　${nm}`); continue; }
    byName += 1;
    if (mine === want) byNameSame += 1;
    else if (diff.length < 20) diff.push(`${short}　${nm}\n      旧 ${want}\n      新 ${mine}`);
  }
  /* 那格结构体自己（`(struct jnc$variant …)`）—— 一格，也按名字对。 */
  const vs = out.split('\n').find((l) => l.startsWith(`  (struct ${VARIANT} `));
  if (vs !== undefined) {
    byName += 1;
    if (variantStruct() === vs) byNameSame += 1;
    else if (diff.length < 20) diff.push(`${short}　${VARIANT}\n      旧 ${vs}\n      新 ${variantStruct()}`);
  }
}

console.log(`带运行期助手的语料 ${filesOk} 份　对比整格函数 ${cmp} 格`
  + `　一模一样 ${same}（${(same / Math.max(cmp, 1) * 100).toFixed(1)}%）　不一致 ${cmp - same}`);
if (byName > 0) {
  console.log(`只按名字对的（触发点还没做，variant 那一族）：${byName} 格`
    + `　一模一样 ${byNameSame}（${(byNameSame / byName * 100).toFixed(1)}%）　不一致 ${byName - byNameSame}`);
}
if (varMissed > 0) {
  console.log(`variant 那一族表里没有的：${varMissed} 格　→ ${varMissedAt.slice(0, 8).join('  ')}`);
}
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
/* 覆盖那一栏（旧降级发了、新腿还没试的）**不判红** —— 与别的尺子同一条口径：
   它说的是"还没做到哪儿"，不是"做错了"。判红看的是对不上与凭空多发。 */
process.exitCode = cmp > 0 && same === cmp && extra === 0 && byName === byNameSame ? 0 : 1;
