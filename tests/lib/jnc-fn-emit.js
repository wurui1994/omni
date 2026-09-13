// tests/lib/jnc-fn-emit.js —— **函数的头**两条腿并跑：新表拼出来的 vs 旧降级真发的
//
// 与 jnc-struct-emit.js 同一个套路（那把尺子把聚合体顶到了 196/197）：
//   1. 外部尺 = 旧降级的真输出（`node src/cli.js emit sx x.jnc`），抠出每一行 `(fn 名字 (形参) 返回`；
//   2. 新的一条腿 = 节点表 → readAgg / readDeclType → emit-fn.js 的 `fnHead`；
//   3. 逐行对。拼不出来的记账（不猜、不算对）。
//
// 只比**头**（名字 + 形参 + 返回），体是下一刀。`main` 不比 —— 旧降级把它的体抬进了别处，
// 压根不发 `(fn main …)`。
//
// 用法：node tests/lib/jnc-fn-emit.js [文件数，默认 40] [--cases] [--all]

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Diagnostics } from '../../src/core/source/diag.js';
import { initJnc, jncFrontEnd, jncParse } from '../../src/core/lang/jnc.js';
import { headOf, named } from '../../src/lang/jnc/adapt.js';
import { readAgg, readEnum } from '../../src/lang/jnc/agg.js';
import { collectEnumConsts } from '../../src/lang/jnc/const-eval.js';
import { readSpecs } from '../../src/lang/jnc/specs.js';
import { classRoot } from '../../src/lang/jnc/emit-agg.js';
import { fnHead, fnName, fnOwnerSegs, overloadIndex } from '../../src/lang/jnc/emit-fn.js';
import { nameText, allInChain } from '../../src/lang/jnc/declare.js';
import { readDeclType } from '../../src/lang/jnc/types.js';

const EXTERNAL = '/Users/wurui/Documents/Lang/reference/jancy/samples/jnc';
const argv = process.argv.slice(2);
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

/** 一格表达式里最后那一段名字。 */
function lastName(n) {
  if (n === null || n === undefined || typeof n !== 'object') return null;
  if (!Array.isArray(n.items)) return typeof n.value === 'string' ? n.value : null;
  for (let i = n.items.length - 1; i >= 1; i -= 1) {
    const s = lastName(n.items[i]);
    if (s !== null) return s;
  }
  return null;
}

/** 旧降级输出里每一行函数头：名字 -> `(fn 名字 (形参) 返回`。 */
function headsOf(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    const m = /^\s*\(fn (\S+) (\(.*\)) (.+)$/.exec(line);
    if (m === null) continue;
    out.set(m[1], `(fn ${m[1]} ${m[2]} ${m[3]}`);
  }
  return out;
}

initJnc({ log: () => {} });
const tb = jncFrontEnd();
const files = walk(CORPUS).sort().slice(0, limit);

let filesOk = 0;
let cmp = 0;
let same = 0;
const diff = [];
const skip = new Map();
const skipAt = [];
let noFn = 0;

for (const f of files) {
  let out = '';
  try {
    out = execFileSync('node', ['src/cli.js', 'emit', 'sx', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { continue; }
  let tree = null;
  try { tree = jncParse(tb, f, new Diagnostics()); } catch { continue; }
  filesOk += 1;
  const oracle = headsOf(out);
  const env = new Map();
  const aggs = [];
  const tops = [];                                   // 顶层的函数（fn-def / fn-proto）
  const scan = (n, owner, inAgg) => {
    if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
    const h = headOf(n);
    let inner = owner;
    let agg = inAgg;
    if (h === 'namespace') {
      /* **命名空间只是名字的前缀**（第五十一刀）：`namespace a { int bump(){} }` 旧降级发的是
         `(fn a$bump …)`，套起来的是 `a$b$deep`（48-namespace.jnc 的真输出）。 */
      const nn = named(n);
      const nm = nn === null ? null : nameText(nn.name);
      if (nm !== null) inner = owner === null ? nm : `${owner}$${nm}`;
      agg = false;
    } else if (h === 'agg') {
      const a = readAgg(n);
      if (a !== null) {
        aggs.push(a);
        const nm = nameText(a.name);
        if (nm !== null) {
          const emitName = owner === null ? nm : `${owner}$${nm}`;
          a.emitName = emitName;
          inner = emitName;
          agg = true;
          env.set(nm, {
            kind: a.word === 'union' ? 'union' : (a.word === 'struct' ? 'struct' : 'class'),
            name: emitName,
            agg: a,
          });
        }
      }
    } else if (h === 'fn-def' || h === 'fn-proto') {
      if (!inAgg) {
        const nm = named(n);
        const t = nm === null ? null : readDeclType(nm.specs, nm.dcl);
        const sp = nm === null ? null : readSpecs(nm.specs);
        if (t !== null) {
          tops.push({
            name: t.name,
            type: t,
            shape: t.shape,
            storage: sp === null ? [] : sp.words,
            at: n,
            ns: owner,                                   // 命名空间那一段前缀（没有就 null）
          });
        }
      }
      return;                                        // 体里的东西不再往下扫（局部类先不管）
    } else if (h === 'var-decl') {
      const vn = named(n);
      const sp = vn === null ? null : readSpecs(vn.specs);
      if (sp !== null && sp.words.includes('alias')) {
        for (const d of allInChain(vn.dcls, 'dcls-add', 'dcls')) {
          if (headOf(d) !== 'init') continue;
          const dn = named(d);
          if (dn === null) continue;
          const who = nameText(named(dn.dcl)?.name);
          const to = lastName(dn.value);
          if (who !== null && to !== null) env.set(who, { kind: 'alias', to });
        }
      }
    } else if (h === 'typedef') {
      const tn = named(n);
      if (tn !== null) {
        for (const d of allInChain(tn.dcls, 'dcls-add', 'dcls')) {
          const t = readDeclType(tn.specs, d);
          if (t !== null && t.name !== null) env.set(t.name, { kind: 'typedef', type: t });
        }
      }
    } else if (h === 'enum') {
      const e = readEnum(n);
      const nm = e === null ? null : nameText(e.name);
      if (nm !== null) env.set(nm, { kind: 'enum', name: nm });
    }
    for (const it of n.items) scan(it, inner, agg);
  };
  scan(tree, null, false);
  collectEnumConsts(tree, env);

  /** 一格聚合体的 `$this` 怎么写（类 → `(ptr 连通块的根)`，结构体/union → `(ptr S)`）。 */
  const selfOf = (a) => {
    const isCls = a.word === 'class' || a.word === 'opaque class';
    const root = isCls ? classRoot(a, aggs, env) : a;
    const nm = root.emitName ?? nameText(root.name);
    return nm === null ? null : `(ptr ${nm})`;
  };

  /* **谁的根是谁**（类那一族在方言里写的是连通块的根）：发形参/返回都要它。 */
  const roots = new Map();
  for (const a of aggs) {
    if (a.word !== 'class' && a.word !== 'opaque class') continue;
    const nm = a.emitName ?? nameText(a.name);
    const rn = classRoot(a, aggs, env);
    const rnm = rn.emitName ?? nameText(rn.name);
    if (nm !== null && rnm !== null) roots.set(nm, rnm);
  }
  const clsRoot = (n) => roots.get(n) ?? n;

  const cases = [];
  for (const a of aggs) {
    const own = a.emitName ?? nameText(a.name);
    if (own === null) continue;
    for (const m of a.members) {
      if (m.shape !== 'fn') continue;
      cases.push({ m, ctx: { owner: own, self: selfOf(a) } });
    }
  }
  for (const m of tops) {
    if (m.shape !== 'fn') continue;
    if (m.name === 'main') continue;                  // 旧降级不发它（体被抬走了）
    const mm = { ...m, storage: m.storage ?? [] };
    /* **体外定义**（`int C0.get(){…}`）：名字是点串，东家是点串里**最后一格能解成聚合体**的
       那一段 —— `C1.p.get` 的 `p` 是属性、东家是 `C1`；`a.Cls.f` 的东家是 `Cls`。 */
    const segs = m.name === null ? fnOwnerSegs(mm) : null;
    let host;
    for (let i = (segs === null ? -1 : segs.length - 1); i >= 0; i -= 1) {
      const rec = env.get(segs[i]);
      if (rec !== undefined && rec.agg !== undefined) { host = rec; break; }
    }
    const self = host !== undefined ? selfOf(host.agg) : null;
    /* 点串的头一段不是聚合体时（`g_p.get()` 那种**顶层属性**的取/存）本来就没有 `$this`
       —— 旧降级发的是 `(fn g_p$get () int`（107-psetexpr.jnc）。 */
    cases.push({ m: mm, ctx: { owner: m.ns ?? null, self } });
  }

  /* **重载的号**按声明次序发（`q` / `q$o1` / …）—— 拼不出来的那几格照样占一个号，
     所以先问号、再拼头。 */
  const nextDup = overloadIndex();
  for (const c of cases) {
    const base = fnName(c.m);
    const sym = base === null ? null : (c.ctx.owner === null ? base : `${c.ctx.owner}$${base}`);
    const dup = sym === null ? 0 : nextDup(sym);
    const built = fnHead(c.m, env, { ...c.ctx, dup, clsRoot });
    const key = sym === null ? '?' : (dup > 0 ? `${sym}$o${dup}` : sym);
    const want = oracle.get(key);
    if (built.head === null) {
      skip.set(built.why, (skip.get(built.why) ?? 0) + 1);
      if (skipAt.length < 20) skipAt.push(`${f.split('/').pop()}　${key}　${built.why}`);
      continue;
    }
    if (want === undefined) { noFn += 1; continue; }  // 旧降级没发这一格（原型、宿主面那几族）
    cmp += 1;
    if (built.head === want) same += 1;
    else if (diff.length < 20) {
      diff.push(`${f.split('/').pop()}\n      旧 ${want}\n      新 ${built.head}`);
    }
  }
}

console.log(`语料 ${filesOk}/${files.length} 份　对比函数头 ${cmp} 行`
  + `　一模一样 ${same}（${(same / Math.max(cmp, 1) * 100).toFixed(1)}%）　不一致 ${cmp - same}`);
if (noFn > 0) console.log(`旧降级没发这一格函数：${noFn} 个（只有原型、宿主面、被分派吃掉那几族）`);
if (skip.size > 0) {
  console.log(`拼不出来（记账，不算对）：${[...skip].sort((a, b) => b[1] - a[1])
    .map(([w, n]) => `${w}×${n}`).join('  ')}`);
}
if (all && skipAt.length > 0) {
  console.log('\n拼不出来的那几处：');
  for (const d of skipAt) console.log(`  ${d}`);
}
if (diff.length > 0) {
  console.log('\n对不上：');
  for (const d of (all ? diff : diff.slice(0, 5))) console.log(`  ${d}`);
}
process.exitCode = cmp > 0 && same === cmp ? 0 : 1;
