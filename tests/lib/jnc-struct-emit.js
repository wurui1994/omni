// tests/lib/jnc-struct-emit.js —— **两条腿并跑**：新读取器算出的字段类型 vs 旧降级真发的
//
// 这把尺子是"重写降级"那一步的入口。做法：
//   1. 拿旧降级当外部尺 —— `omni emit sx x.jnc`，从输出里抠出每个 `(struct S (f 类型) …)`；
//   2. 新的一条腿：节点表 → `readAgg` → `readDeclType` → `resolveType` → `emitType(field)`；
//   3. 逐格对。对不上就是新腿的表还差一条；解不出来的记账（不猜、不算对）。
//
// 只对**数据字段**（`shape === 'data' | 'array'`）—— 方法、属性、事件那几族还没搬。
//
// 用法：node tests/lib/jnc-struct-emit.js [文件数，默认 40] [--all]

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Diagnostics } from '../../src/core/source/diag.js';
import { initJnc, jncFrontEnd, jncParse } from '../../src/core/lang/jnc.js';
import { headOf } from '../../src/lang/jnc/adapt.js';
import { readAgg, readEnum } from '../../src/lang/jnc/agg.js';
import { resolveType } from '../../src/lang/jnc/resolve-type.js';
import { emitType } from '../../src/lang/jnc/emit-type.js';
import { structLine } from '../../src/lang/jnc/emit-agg.js';
import { nameText } from '../../src/lang/jnc/declare.js';

const EXTERNAL = '/Users/wurui/Documents/Lang/reference/jancy/samples/jnc';
const argv = process.argv.slice(2);
/* 语料两处：`samples/jnc`（写法花样多）与 `tests/jnc/cases`（旧降级一定发得出来）。
   `--cases` 切到后者 —— 对比的格数多得多，闸门用它。 */
const CORPUS = argv.includes('--cases') || !existsSync(EXTERNAL) ? 'tests/jnc/cases' : EXTERNAL;
const limit = Number(argv.find((a) => /^\d+$/.test(a)) ?? 40);
const all = argv.includes('--all');

function walk(dir, out = []) {
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const e of names) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (e.endsWith('.jnc')) out.push(p);
  }
  return out;
}

/** 从旧降级的输出里抠出 `(struct S (f 类型) …)`：`S` -> { fields, line }。 */
function structsOf(text) {
  const out = new Map();
  for (const m of text.matchAll(/\(struct ([A-Za-z_$][\w$]*)\s([^\n]*)\)/g)) {
    const fields = new Map();
    let s = m[2];
    while (s.length > 0) {
      const i = s.indexOf('(');
      if (i < 0) break;
      const end = balanced(s, i);
      if (end === null) break;
      const inner = s.slice(i + 1, end - 1);
      const sp = inner.indexOf(' ');
      if (sp > 0) fields.set(inner.slice(0, sp), inner.slice(sp + 1).trim());
      s = s.slice(end);
    }
    out.set(m[1], { fields, line: m[0] });
  }
  return out;
}

/** 从 `from`（`(`）起配平，答闭括号后一位。 */
function balanced(s, from) {
  let depth = 0;
  for (let j = from; j < s.length; j += 1) {
    if (s[j] === '(') depth += 1;
    else if (s[j] === ')') {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
  }
  return null;
}

initJnc({ log: () => {} });
const tb = jncFrontEnd();
const files = walk(CORPUS).sort().slice(0, limit);

let filesOk = 0;
let cmp = 0;
let same = 0;
const diff = [];
const unresolved = new Map();
let noStruct = 0;
/** 整行对比：这个聚合体的**全部字段**都解得出来时，把一整行拼出来与旧降级对。 */
let lineTry = 0;
let lineSame = 0;
const lineDiff = [];
const lineSkip = new Map();

for (const f of files) {
  let out = '';
  try {
    out = execFileSync('node', ['src/cli.js', 'emit', 'sx', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { continue; }                              // 旧降级发不出来的归语料尺子
  let tree = null;
  try { tree = jncParse(tb, f, new Diagnostics()); } catch { continue; }
  filesOk += 1;
  const oracle = structsOf(out);
  /* 环境：这份文件自己声明的聚合体与枚举（跨文件那一半要导入表，先记账）。 */
  const env = new Map();
  const aggs = [];
  /* 嵌套类型的名字带**东家**（旧降级发的是 `Outer$Inner`）—— 这一格是尺子逼出来的：
     不带东家时 `Outer.m_in` 会算成 `Inner`，与旧降级对不上。 */
  const scan = (n, owner) => {
    if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
    const h = headOf(n);
    let inner = owner;
    if (h === 'agg') {
      const a = readAgg(n);
      if (a !== null) {
        aggs.push(a);
        const nm = nameText(a.name);
        if (nm !== null) {
          const emitName = owner === null ? nm : `${owner}$${nm}`;
          a.emitName = emitName;
          inner = emitName;
          env.set(nm, {
            kind: a.word === 'union' ? 'union' : (a.word === 'struct' ? 'struct' : 'class'),
            name: emitName,
            agg: a,
          });
        }
      }
    } else if (h === 'enum') {
      const e = readEnum(n);
      const nm = e === null ? null : nameText(e.name);
      if (nm !== null) env.set(nm, { kind: 'enum', name: nm });
    }
    for (const it of n.items) scan(it, inner);
  };
  scan(tree, null);

  for (const a of aggs) {
    const nm = a.emitName ?? nameText(a.name);
    if (nm === null) continue;
    const rec = oracle.get(nm);
    if (rec === undefined) { noStruct += 1; continue; }             // 旧降级没发这一格
    const fields = rec.fields;
    const parts = [];
    let whole = true;                                              // 这一格的字段是不是全解得出来
    for (const m of a.members) {
      if (m.shape !== 'data' && m.shape !== 'array') { whole = false; continue; }
      if (m.name === null) { whole = false; continue; }
      const want = fields.get(m.name);
      const r = resolveType(m.type, env);
      if (r.type === null) {
        unresolved.set(r.why, (unresolved.get(r.why) ?? 0) + 1);
        whole = false;
        continue;
      }
      const got = emitType(r.type, 'field');
      parts.push(`(${m.name} ${got})`);
      if (want === undefined) { whole = false; continue; }          // 旧降级没发这一格字段
      cmp += 1;
      if (got === want) same += 1;
      else if (diff.length < 20) diff.push(`${f.split('/').pop()}　${nm}.${m.name}：旧 ${want} / 新 ${got}`);
    }
    /* **整行**由 `emit-agg.js` 那三条规则拼（类的 `$tag`、基类字段前置、自己的按次序）。
       拼不出来的（union 分组、属性/事件带出来的隐藏字段那几族）不算试过 —— 记账。 */
    const built = structLine(a, env, aggs);
    if (built.line !== null) {
      lineTry += 1;
      if (built.line === rec.line) lineSame += 1;
      else if (lineDiff.length < 10) lineDiff.push(`${f.split('/').pop()}\n      旧 ${rec.line}\n      新 ${built.line}`);
    } else {
      lineSkip.set(built.why, (lineSkip.get(built.why) ?? 0) + 1);
    }
  }
}

console.log(`语料 ${filesOk}/${files.length} 份（旧降级发得出来的）　对比字段 ${cmp} 格`
  + `　一致 ${same}（${(same / Math.max(cmp, 1) * 100).toFixed(1)}%）　不一致 ${cmp - same}`);
console.log(`解不出来（记账，不算对）：${[...unresolved].sort((a, b) => b[1] - a[1])
  .map(([w, n]) => `${w}×${n}`).join('  ') || '无'}`);
if (noStruct > 0) console.log(`旧降级没发这个聚合体：${noStruct} 个（类的根名与嵌套那一族）`);
console.log(`整行（emit-agg.js 拼得出来的那些）：试 ${lineTry} 行　一模一样 ${lineSame}`
  + `（${(lineSame / Math.max(lineTry, 1) * 100).toFixed(1)}%）`);
if (lineSkip.size > 0) {
  console.log(`  拼不出来（记账）：${[...lineSkip].sort((a, b) => b[1] - a[1])
    .map(([w, n]) => `${w}×${n}`).join('  ')}`);
}
if (lineDiff.length > 0) {
  console.log('\n整行对不上：');
  for (const d of (all ? lineDiff : lineDiff.slice(0, 5))) console.log(`  ${d}`);
}
if (diff.length > 0) {
  console.log('\n不一致（新腿的表还差一条）：');
  for (const d of (all ? diff : diff.slice(0, 10))) console.log(`  ${d}`);
}
process.exitCode = cmp > 0 && same === cmp ? 0 : 1;
