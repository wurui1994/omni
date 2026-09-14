// tests/lib/jnc-global-emit.js —— **顶层数据**那条腿的尺子（`(global 名字 类型)`）
//
// 声明驱动的最后一片：`(struct …)` 与 `(fn …)` 两条腿都量过了，顶层那几格数据发的
// `(global …)` 先前**一把尺子都没量过**。这一把补上。
//
// 尺子：拿旧降级的真输出当外部尺（`node src/cli.js emit sx 文件.jnc`），逐行比。
//
// 三栏账（与别的尺子一样）：
//   1. 拼不出来的（记账，不算对）
//   2. **新腿发了、旧降级没有这个名字的**（防着凭空多发）
//   3. 旧降级发了、新腿还没试的（覆盖，按族分）
//
// 用法：node tests/lib/jnc-global-emit.js [文件数，默认 400] [--all]

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Diagnostics } from '../../src/core/source/diag.js';
import { initJnc, jncFrontEnd, jncParse } from '../../src/core/lang/jnc.js';
import { headOf, named } from '../../src/lang/jnc/adapt.js';
import { readAgg, readEnum } from '../../src/lang/jnc/agg.js';
import { collectEnumConsts } from '../../src/lang/jnc/const-eval.js';
import { nameText, allInChain } from '../../src/lang/jnc/declare.js';
import { readDeclType } from '../../src/lang/jnc/types.js';
import { globalLines, addrTaken, staticCtorFlag, staticLocalLines } from '../../src/lang/jnc/emit-global.js';
import { readSpecs } from '../../src/lang/jnc/specs.js';
import { hasStaticCtor } from '../../src/lang/jnc/emit-fn.js';
import { classRoot } from '../../src/lang/jnc/emit-agg.js';
import { LIB_IMPORTS } from '../../src/lang/jnc/modules.js';

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

/** 旧降级输出里那几行 `(global 名字 类型)`：名字 -> 整行。 */
function globalsOf(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    const m = /^ {2}\((global) (\S+) (.+)\)$/.exec(line);
    if (m !== null) out.set(m[2], line.trim());
  }
  return out;
}

/** 一个符号名归哪一族（覆盖那一栏按族分，认不出就说"别的"）。 */
function familyOf(nm) {
  if (/^jnc\$once\$\d+$/.test(nm)) return '一次性标志（jnc$once$N）';
  if (/\$s\d+(\$1)?$/.test(nm)) return '函数里的静态量（$sN 与它的标志）';
  if (nm.endsWith('$m_value') || nm.endsWith('$m_onChanged')) return '生成的属性存储';
  if (nm.endsWith('$on') || nm.endsWith('$bound')) return 'reactor 的两格 bool';
  return '别的';
}

initJnc({ log: () => {} });
const tb = jncFrontEnd();
const files = walkDir('tests/jnc/cases').sort().slice(0, limit);

let filesOk = 0;
let cmp = 0;
let same = 0;
const diff = [];
const skip = new Map();
const skipAt = [];
let extra = 0;
const extraAt = [];
let uncovered = 0;
const families = new Map();
const uncoveredAt = [];

for (const f of files) {
  let out = '';
  try {
    out = execFileSync('node', ['src/cli.js', 'emit', 'sx', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { continue; }
  let tree = null;
  try { tree = jncParse(tb, f, new Diagnostics()); } catch { continue; }
  const oracle = globalsOf(out);
  if (oracle.size === 0) continue;
  filesOk += 1;
  const short = f.split('/').pop();

  /* 环境（类型里提到的聚合体/枚举/typedef）：入口 + import 进来的那几份 + 隐式的库那几份。 */
  const env = new Map();
  const trees = [];
  const seen = new Set([f]);
  const queue = importPaths(tree).slice();
  for (const b of LIB_IMPORTS) queue.push(b);
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
    /* **名字空间也是前缀**：`namespace ui { struct Item … }` 在方言那一侧叫 `ui$Item`
       （189-importcurly.jnc 的 `ui.Item g_one` 要照这个键去查）。 */
    if (headOf(n) === 'namespace') {
      const nn = named(n);
      const seg = nn === null ? null : nameText(nn.name);
      const pre = seg === null ? owner : (owner === null || owner === undefined ? seg : `${owner}$${seg}`);
      for (const it of n.items) scanAggs(it, pre);
      return;
    }
    /* **typedef 也进环境**（`typedef Item Opt;` → `ui$Opt` 再跳一次到 `ui$Item`）。 */
    if (headOf(n) === 'typedef') {
      const tn = named(n);
      for (const d of allInChain(tn?.dcls, 'dcls-add', 'dcls')) {
        const dd = headOf(d) === 'init' ? named(d)?.dcl : d;
        const t = readDeclType(tn?.specs, dd);
        if (t === null || t.name === null) continue;
        const full = owner === null || owner === undefined ? t.name : `${owner}$${t.name}`;
        env.set(full, { kind: 'typedef', name: full, type: t });
      }
      return;
    }
    if (headOf(n) === 'agg') {
      const a = readAgg(n);
      if (a !== null && a.name !== null) {
        a.emitName = owner === null || owner === undefined
          ? nameText(a.name) : `${owner}$${nameText(a.name)}`;
        inner = a.emitName;
        env.set(a.emitName, {
          kind: a.word === 'union' ? 'union' : (a.word === 'struct' ? 'struct' : 'class'),
          name: a.emitName,
          agg: a,
        });
      }
    }
    /* **枚举那一格也要进环境**：`Lines g_lines = 0;` 里的 `Lines` 是一格枚举类型
       （47-enumcast.jnc）—— 不登记就是"认不出基类型 'name'"。项那一层由
       `collectEnumConsts` 另收（那是常量，不是类型）。 */
    if (headOf(n) === 'enum') {
      const e = readEnum(n);
      const en = e === null ? null : nameText(e.name);
      if (en !== null) {
        const full = owner === null || owner === undefined ? en : `${owner}$${en}`;
        env.set(full, { kind: 'enum', name: full });
      }
    }
    for (const it of n.items) scanAggs(it, inner);
  };
  for (const t of trees) { scanAggs(t, null); collectEnumConsts(t, env); }

  /* **顶层那几格数据**（不在聚合体里、不在函数体里）。命名空间只是前缀。 */
  const tops = [];
  const dig = (n, ns) => {
    if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
    const h = headOf(n);
    if (h === 'agg') return;                                         // 类里的是字段，另一条路收
    if (h === 'fn-def' || h === 'fn-proto') {
      /* **顶层的完整声明式属性与 reactor 在树上是 `fn-def`**（体就是属性体 / 反应体）——
         它们发的是生成的存储（`$m_value` / `$on` / `$bound`）与体里那几格字段
         （151-propfield.jnc 的 `g_p$m_v`、162-oneventlist.jnc 的 `g_r$on`）。
         真的函数就到此为止：体里的是局部量，那是语句那条腿的事。 */
      const fn = named(n);
      const ft = fn === null ? null : readDeclType(fn.specs, fn.dcl);
      if (ft !== null && ft.name !== null
        && (ft.shape === 'prop' || ft.type?.mods?.includes('reactor') || ft.mods.includes('reactor'))) {
        tops.push({ m: { ...ft, at: n, type: ft, name: ft.name }, ns });
      }
      return;
    }
    if (h === 'namespace') {
      const nn = named(n);
      const seg = nn === null ? null : nameText(nn.name);
      const inner = seg === null ? ns : (ns === null ? seg : `${ns}$${seg}`);
      for (const it of n.items) dig(it, inner);
      return;
    }
    if (h === 'var-decl' || h === 'var-decl-curly') {
      const vn = named(n);
      if (vn !== null) {
        const dcls = h === 'var-decl'
          ? allInChain(vn.dcls, 'dcls-add', 'dcls') : [vn.dcl];
        for (const d of dcls) {
          const dd = headOf(d) === 'init' ? named(d)?.dcl : d;
          const t = readDeclType(vn.specs, dd);
          if (t !== null && t.name !== null) tops.push({ m: { ...t, shape: t.shape, at: n, type: t, name: t.name }, ns });
        }
      }
      return;
    }
    if (h === 'fn-proto') return;
    for (const it of n.items) dig(it, ns);
  };
  for (const t of trees) dig(t, null);
  /* **类里的 `static` 字段不进对象**（第一百六十七刀）：它就是一格模块级的量，
     名字是 `<聚合体>$<字段名>`（167-staticfield.jnc 的 `C$m_count` / `S$m_table`）。 */
  const flags = [];
  for (const rec of env.values()) {
    if (rec.agg === undefined) continue;
    /* **写了 `static construct` 就多一格一次性标志**（静态构造只跑一遍）。 */
    if (hasStaticCtor(rec.agg)) flags.push(staticCtorFlag(rec.name));
    for (const m of rec.agg.members) {
      if (m.name === null || !(m.storage ?? []).includes('static')) continue;
      if (m.shape !== 'data' && m.shape !== 'array' && m.shape !== 'fnptr') continue;
      tops.push({ m: { ...m, type: m.type, name: m.name }, ns: rec.name });
    }
  }

  /* **取过地址就提一格**（第二十四刀）：整份源码里 `&名字` 数一遍，发 `(global …)` 之前就要
     答完（`&g` 写在函数体里，可它决定的是模块级那一格的类型）。 */
  const taken = addrTaken(trees);
  const aggList = [...env.values()].map((r) => r.agg).filter((a) => a !== undefined);
  const rootOf = (nm) => {
    const rec = env.get(nm);
    if (rec === undefined || rec.agg === undefined || rec.kind !== 'class') return nm;
    const root = classRoot(rec.agg, aggList, env);
    return root.emitName ?? nm;
  };
  /* **函数里的 `static`**：那几格是模块级的内存，名字 `<源码里的名字>$s<临时号>`
     （写了初值的还多一格 `$1` 闸门）。号取的是**共用的临时号**（与 `$newoN` 同一个计数器）——
     这一份文件里按源码次序数；文件里还有别的取号处时会对不上，那一格记账。 */
  const statics = [];
  const dig2 = (n, inFn) => {
    if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
    const h = headOf(n);
    if (h === 'fn-def') { dig2(named(n)?.body, true); return; }
    /* **`once` 语句**也从这个计数器取号：一处一格 `(global jnc$once$N bool)`
       （161-once.jnc）。与静态量按**源码次序**混在一起数 —— 共用那一个临时号。 */
    if (h === 'once') { statics.push({ kind: 'once' }); for (const it of n.items) dig2(it, inFn); return; }
    if (inFn && (h === 'var-decl' || h === 'var-decl-curly')) {
      const vn = named(n);
      const sp = vn === null ? null : readSpecs(vn.specs);
      if (sp !== null && sp.words.includes('static')) {
        const dcls = h === 'var-decl'
          ? allInChain(vn.dcls, 'dcls-add', 'dcls') : [vn.dcl];
        for (const d of dcls) {
          const hasInit = headOf(d) === 'init' || h === 'var-decl-curly';
          const dd = headOf(d) === 'init' ? named(d)?.dcl : d;
          const t = readDeclType(vn.specs, dd);
          if (t !== null && t.name !== null) {
            statics.push({ kind: 'static', m: { ...t, at: n, type: t, name: t.name }, hasInit });
          }
        }
      }
      return;
    }
    for (const it of n.items) dig2(it, inFn);
  };
  for (const t of trees) dig2(t, false);

  const mine = new Set();
  let tmp = 0;
  for (const one of statics) {
    if (one.kind === 'once') {
      const nm = `jnc$once$${tmp}`;
      tmp += 1;
      mine.add(nm);
      const line = `(global ${nm} bool)`;
      const want = oracle.get(nm);
      if (want === undefined) { extra += 1; extraAt.push(`${short}　${nm}`); continue; }
      cmp += 1;
      if (line === want) same += 1;
      else if (diff.length < 20) diff.push(`${short}\n      旧 ${want}\n      新 ${line}`);
      continue;
    }
    const { m, hasInit } = one;
    const r = staticLocalLines(m, env, { idx: tmp, hasInit, clsRoot: rootOf, taken });
    tmp += 1;
    if (r.lines.length === 0) {
      skip.set(r.why, (skip.get(r.why) ?? 0) + 1);
      skipAt.push(`${short}　${m.name}　${r.why}`);
      continue;
    }
    for (const line of r.lines) {
      const nm = /^\(global (\S+) /.exec(line)?.[1] ?? '?';
      mine.add(nm);
      const want = oracle.get(nm);
      if (want === undefined) { extra += 1; extraAt.push(`${short}　${nm}`); continue; }
      cmp += 1;
      if (line === want) same += 1;
      else if (diff.length < 20) diff.push(`${short}\n      旧 ${want}\n      新 ${line}`);
    }
  }
  for (const line of flags) {
    const nm = /^\(global (\S+) /.exec(line)?.[1] ?? '?';
    mine.add(nm);
    const want = oracle.get(nm);
    if (want === undefined) { extra += 1; extraAt.push(`${short}　${nm}`); continue; }
    cmp += 1;
    if (line === want) same += 1;
    else if (diff.length < 20) diff.push(`${short}\n      旧 ${want}\n      新 ${line}`);
  }
  for (const { m, ns } of tops) {
    const r = globalLines(m, env, { ns, taken, clsRoot: rootOf });
    if (r.lines.length === 0) {
      skip.set(r.why, (skip.get(r.why) ?? 0) + 1);
      skipAt.push(`${short}　${m.name}　${r.why}`);
      continue;
    }
    for (const line of r.lines) {
      const nm = /^\(global (\S+) /.exec(line)?.[1] ?? '?';
      mine.add(nm);
      const want = oracle.get(nm);
      if (want === undefined) { extra += 1; extraAt.push(`${short}　${nm}`); continue; }
      cmp += 1;
      if (line === want) same += 1;
      else if (diff.length < 20) diff.push(`${short}\n      旧 ${want}\n      新 ${line}`);
    }
  }
  for (const nm of oracle.keys()) {
    if (mine.has(nm)) continue;
    uncovered += 1;
    const fam = familyOf(nm);
    families.set(fam, (families.get(fam) ?? 0) + 1);
    uncoveredAt.push(`${short}　${nm}`);
  }
}

console.log(`语料 ${filesOk} 份　对比 ${cmp} 行　一模一样 ${same}`
  + `（${(same / Math.max(cmp, 1) * 100).toFixed(1)}%）　不一致 ${cmp - same}`);
if (extra > 0) {
  console.log(`新腿发了、旧降级没有这个名字的：${extra} 格　→ ${extraAt.slice(0, 8).join('  ')}`);
}
if (uncovered > 0) {
  console.log(`旧降级发了、新腿还没试的：${uncovered} 格　→ ${[...families]
    .sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w}×${n}`).join('  ')}`);
}
/* 两栏分开印：**对的行为**（本来就不该发）与**拼不出来**（还没做）。混在一栏账就虚了。 */
const okNone = [...skip].filter(([w]) => String(w).includes('对的行为'));
const cantDo = [...skip].filter(([w]) => !String(w).includes('对的行为'));
if (okNone.length > 0) {
  console.log(`本来就不发（对的行为）：${okNone.sort((a, b) => b[1] - a[1])
    .map(([w, n]) => `${w}×${n}`).join('  ')}`);
}
if (cantDo.length > 0) {
  console.log(`拼不出来（记账，不算对）：${cantDo.sort((a, b) => b[1] - a[1])
    .map(([w, n]) => `${w}×${n}`).join('  ')}`);
}
if (all && uncoveredAt.length > 0) {
  console.log('\n还没试的那几格：');
  for (const d of uncoveredAt.slice(0, 40)) console.log(`  ${d}`);
}
if (all && skipAt.length > 0) {
  console.log('\n拼不出来的那几处：');
  for (const d of skipAt.slice(0, 40)) console.log(`  ${d}`);
}
if (diff.length > 0) {
  console.log('\n对不上：');
  for (const d of (all ? diff : diff.slice(0, 5))) console.log(`  ${d}`);
}
process.exitCode = cmp > 0 && same === cmp && extra === 0 ? 0 : 1;
