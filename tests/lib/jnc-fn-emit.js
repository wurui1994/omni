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
import { readAgg, readEnum, readBodyMembers } from '../../src/lang/jnc/agg.js';
import { collectEnumConsts } from '../../src/lang/jnc/const-eval.js';
import { readSpecs } from '../../src/lang/jnc/specs.js';
import { classRoot } from '../../src/lang/jnc/emit-agg.js';
import {
  fnHead, fnName, fnOwnerSegs, overloadIndex, isReactor, reactorHeads,
  isBindableData, dataAccessorHeads, isAutogetProp, autogetGetterHead,
  isVirtual, dispatchHead, needsCtor, hasWrittenCtor, ctorHead, overloadSuffix, aliasHead,
} from '../../src/lang/jnc/emit-fn.js';
import { templateTable, expandTemplates, synthType } from '../../src/lang/jnc/generic.js';
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

/** 一格 `alias` 声明指向的名字（`alias dispose = close;` → `close`）。 */
function aliasTargetName(at, dclNode) {
  const nm = named(at);
  if (nm === null || headOf(at) !== 'var-decl') return null;
  for (const d of allInChain(nm.dcls, 'dcls-add', 'dcls')) {
    if (headOf(d) !== 'init') continue;
    const dn = named(d);
    if (dn === null) continue;
    if (dclNode !== undefined && dn.dcl !== dclNode) continue;
    const t = lastName(dn.value);
    if (t !== null) return t;
  }
  return null;
}

/** 一格限定名的**全路径**（`ui.Combo` → `ui$Combo`；`extension` 的目标类型要它）。 */
function dottedPath(n) {
  const segs = [];
  const walk = (x) => {
    if (x === null || x === undefined || typeof x !== 'object') return;
    if (!Array.isArray(x.items)) {
      if (typeof x.value === 'string' && /^[A-Za-z_]\w*$/.test(x.value)) segs.push(x.value);
      return;
    }
    for (const it of x.items.slice(1)) walk(it);
  };
  walk(n);
  return segs.length === 0 ? null : segs.join('$');
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
/** 覆盖率那一栏：旧降级发了、新腿连试都没试的那几格。 */
let uncovered = 0;
const noFnAt = [];
const families = new Map();
const uncoveredAt = [];

/** 一个符号名归哪一族（按尾巴认，认不出就说"别的"）。 */
function familyOf(nm) {
  if (/^\$newo\d+$/.test(nm)) return 'new 那一格的构造壳（$newoN）';
  if (/^\$newc\d+$/.test(nm)) return '花括号初值的壳（$newcN）';
  if (nm.startsWith('jnc$')) return '运行期助手（jnc$…）';
  if (/\$r\d+$/.test(nm)) return 'reactor 的反应体（$rN）';
  if (/\$e\d+$/.test(nm)) return 'reactor 的 onevent（$eN）';
  if (/\$\$vd\$/.test(nm)) return '虚派发表（$$vd$）';
  if (nm.endsWith('$get') || nm.endsWith('$set')) return '编译器生成的取/存（bindable data 那一族）';
  if (nm.endsWith('$construct')) return '编译器生成的构造';
  return '别的';
}

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
  const vars = [];                                   // 顶层的数据声明（bindable 那一族要它）
  const aliasTops = [];                              // 顶层的别名（`alias dbl = twice;`）
  const scan = (n, owner, inAgg, extSelf) => {
    if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
    const h = headOf(n);
    let inner = owner;
    let agg = inAgg;
    let ext = extSelf;
    if (h === 'extension') {
      /* **extension**（`extension Ext: C1 { … }`，第一百〇七刀）：体里的方法就是"目标类型的
         成员" —— 东家是**目标类型**（点串换成 `$`），`$this` 也是它
         （98-extension.jnc 的真输出 `(fn C1$bar (($this (ptr C1))) int`、
         `(fn ui$Combo$plus (($this (ptr ui$Combo)) (k int)) int`）。 */
      const en = named(n);
      const tgt = en === null ? null : dottedPath(en.bases);
      if (tgt !== null) { inner = tgt; ext = `(ptr ${tgt})`; agg = false; }
    } else if (h === 'namespace') {
      /* **命名空间只是名字的前缀**（第五十一刀）：`namespace a { int bump(){} }` 旧降级发的是
         `(fn a$bump …)`，套起来的是 `a$b$deep`（48-namespace.jnc 的真输出）。 */
      const nn = named(n);
      const nm = nn === null ? null : nameText(nn.name);
      if (nm !== null) inner = owner === null ? nm : `${owner}$${nm}`;
      agg = false;
      ext = undefined;
    } else if (h === 'agg') {
      const a = readAgg(n);
      if (a !== null) {
        aggs.push(a);
        /* 体里那几格是**成员**，不是顶层函数 —— 这一格与"名字读不读出来"无关：泛型的名字是
           `tinst`（读不出普通名字），先前于是把 `Box<T>` 体里的方法当成了顶层函数，报出来是
           一串"返回类型解不出来"（那儿的 `T` 本来就没绑上）。 */
        agg = true;
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
            extSelf,                                     // extension 体里那一格的 `$this`
          });
        }
      }
      return;                                        // 体里的东西不再往下扫（局部类先不管）
    } else if (h === 'var-decl') {
      const vn = named(n);
      const sp = vn === null ? null : readSpecs(vn.specs);
      /* **顶层的 bindable data**（`int bindable g_b;`）也生成两格取/存 —— 收下来当一格用点。 */
      if (!inAgg && vn !== null) {
        for (const d of allInChain(vn.dcls, 'dcls-add', 'dcls')) {
          const dcl = headOf(d) === 'init' ? named(d)?.dcl : d;
          const t = readDeclType(vn.specs, dcl);
          if (t !== null && t.name !== null) {
            vars.push({
              name: t.name, type: t, shape: t.shape, storage: sp === null ? [] : sp.words, at: n, ns: owner,
            });
          }
        }
      }
      if (sp !== null && sp.words.includes('alias')) {
        for (const d of allInChain(vn.dcls, 'dcls-add', 'dcls')) {
          if (headOf(d) !== 'init') continue;
          const dn = named(d);
          if (dn === null) continue;
          const who = nameText(named(dn.dcl)?.name);
          const to = lastName(dn.value);
          if (who !== null && to !== null) {
            env.set(who, { kind: 'alias', to });
            aliasTops.push({ name: who, to, ns: owner });
          }
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
    for (const it of n.items) scan(it, inner, agg, ext);
  };
  scan(tree, null, false, undefined);
  /* **泛型**：一格用点造一格实例（`generic.js`）—— 方法跟着叫 `Box$int$get_v`
     （110-generic.jnc 的真输出）。实例是替换好的普通 `agg`，所以照旧读；合成实参那几条
     typedef 与泛型 typedef 造出来的那几条也进 env。 */
  const templates = templateTable(tree);
  if (templates.size > 0) {
    const g = expandTemplates(tree, templates);
    for (const [tn, e] of g.typedefs) env.set(tn, { kind: 'typedef', type: synthType(e) });
    for (const td of g.tdefs.values()) {
      if (td === null) continue;
      const tnm = named(td);
      if (tnm === null) continue;
      for (const d of allInChain(tnm.dcls, 'dcls-add', 'dcls')) {
        const t = readDeclType(tnm.specs, d);
        if (t !== null && t.name !== null) env.set(t.name, { kind: 'typedef', type: t });
      }
    }
    for (const [inm, node] of g.insts) {
      if (node === null) continue;
      const a = readAgg(node);
      if (a === null) continue;
      a.emitName = inm;
      aggs.push(a);
      /* 实例体里那几条 typedef 已经各自改过名（`Box$Node$Entry`）—— 一并进 env。 */
      const tds = [];
      const dig = (x) => {
        if (x === null || typeof x !== 'object' || !Array.isArray(x.items)) return;
        if (headOf(x) === 'typedef') { tds.push(x); return; }
        for (const it of x.items) dig(it);
      };
      dig(node);
      for (const td of tds) {
        const tnm = named(td);
        if (tnm === null) continue;
        for (const d of allInChain(tnm.dcls, 'dcls-add', 'dcls')) {
          const t = readDeclType(tnm.specs, d);
          if (t !== null && t.name !== null) env.set(t.name, { kind: 'typedef', type: t });
        }
      }
      env.set(inm, {
        kind: a.word === 'union' ? 'union' : (a.word === 'struct' ? 'struct' : 'class'),
        name: inm,
        agg: a,
      });
    }
    /* **体外写的那几格成员**跟着实例替换出来一份（`Value MapImpl<T>.get(…)` →
       `MapImpl$int$get`）—— 当顶层那一批处理。 */
    for (const os of g.outers.values()) {
      for (const o of os) {
        const on = named(o);
        const t = on === null ? null : readDeclType(on.specs, on.dcl);
        const sp = on === null ? null : readSpecs(on.specs);
        if (t === null) continue;
        tops.push({
          name: t.name,
          type: t,
          shape: t.shape,
          storage: sp === null ? [] : sp.words,
          at: o,
          ns: null,
        });
      }
    }
  }
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
  const accCases = [];                              // 生成取/存的那几格（bindable data）
  const getCases = [];                              // 只生成取值器的那几格（autoget 属性）
  const vdCases = [];                               // 虚派发那几格（$$vd$）
  const vdSeen = new Set();
  const ctorCases = [];                             // 编译器生成的构造（没写、可要初始化）
  const aliasCases = [];                            // 方法/函数的别名（发一格转手函数）
  for (const m of vars) {
    if (isBindableData(m)) accCases.push({ m, ctx: { owner: m.ns ?? null, self: null, clsRoot } });
    else if (isAutogetProp(m)) getCases.push({ m, ctx: { owner: m.ns ?? null, self: null, clsRoot } });
  }
  for (const a of aggs) {
    const own = a.emitName ?? nameText(a.name);
    if (own === null) continue;
    /* **没写 construct、可要初始化**的那一格由编译器生成（75-fielddefault / 80-class-event /
       53-inherit / 120-structctor 那几族）。 */
    if (!hasWrittenCtor(a) && needsCtor(a, env)) {
      ctorCases.push({ agg: a, name: own, self: selfOf(a) });
    }
    for (const m of a.members) {
      /* **bindable data** 生成两格取/存（82-reactor.jnc 的 `Sess$m_state$get` / `$set`）。 */
      if (isBindableData(m)) {
        accCases.push({ m, ctx: { owner: own, self: selfOf(a), clsRoot } });
        continue;
      }
      /* **autoget 属性**只生成取值器（存值器是写出来的那一格，67-propauto.jnc）。 */
      if (isAutogetProp(m)) {
        getCases.push({ m, ctx: { owner: own, self: selfOf(a), clsRoot } });
        continue;
      }
      /* **完整声明式的属性**：取/存写在属性体里（`property m_v { int get(){…} void set(int x){…} }`）
         —— 那对花括号开的是一层命名空间（prop_full.rst:15），所以东家是 `<东家>$<属性名>`。
         体里一格函数都没有、可有语句的那一种是**简写取值器**（140-propgetbody.jnc），
         按 autoget 那一族发一格 `$get`。 */
      if (m.shape === 'prop' && m.name !== null) {
        const body = named(m.at)?.body;
        const inner = headOf(body) === 'compound' ? readBodyMembers(body) : [];
        /* 只有原型的那一格不算一个函数（体写在属性外面，与它是同一个）——
           不滤掉就会多走号（153-propsetovl.jnc 的 `g_q$set$o3` / `$o4`）。 */
        const accs = inner.filter((x) => x.shape === 'fn' && headOf(x.at) === 'fn-def');
        if (accs.length > 0) {
          for (const im of accs) {
            cases.push({
              m: im,
              ctx: { owner: `${own}$${m.name}`, self: selfOf(a), clsRoot, inProp: true },
            });
          }
          continue;
        }
        if (headOf(body) === 'compound') {
          getCases.push({ m, ctx: { owner: own, self: selfOf(a), clsRoot } });
          continue;
        }
      }
      /* **方法的别名**（`alias dispose = close;`）发一格转手函数，签名照抄目标那一格。 */
      if (m.storage.includes('alias') && m.name !== null) {
        const to = aliasTargetName(m.at, m.type?.raw?.dcl);
        const tgt = to === null ? undefined
          : a.members.find((x) => x.shape === 'fn' && fnName(x) === to);
        if (tgt !== undefined) {
          aliasCases.push({ name: m.name, tgt, ctx: { owner: own, self: selfOf(a), clsRoot } });
          continue;
        }
      }
      /* **虚方法**多发一格虚派发函数（一整条链上同名的只一格 —— 按"链的根 + 方法名"去重）。 */
      if (m.shape === 'fn' && isVirtual(m)) {
        const rootA = (a.word === 'class' || a.word === 'opaque class') ? classRoot(a, aggs, env) : a;
        const rootN = rootA.emitName ?? nameText(rootA.name);
        const dk = `${rootN}$$vd$${m.name}`;
        if (rootN !== null && !vdSeen.has(dk)) {
          vdSeen.add(dk);
          vdCases.push({ m, ctx: { root: rootN, self: selfOf(a), clsRoot } });
        }
      }
      if (m.shape !== 'fn') continue;
      /* **只有原型的那一格不算一个函数**：它的体或写在类外（那儿另有一格，名字一样）、
         或在宿主那边（旧降级压根不发）。先前两处各算一格，重载号于是多走一位 ——
         50-construct.jnc 的 `Counter$construct$o1` 就是这么来的。 */
      if (headOf(m.at) !== 'fn-def') continue;
      cases.push({ m, ctx: { owner: own, self: selfOf(a) } });
    }
  }
  for (const m of tops) {
    /* **顶层的完整声明式属性**（`property g_p { int get(){…} void set(int x){…} }`，
       72-propfull.jnc）在树上是一格没有 `fn-suffix` 的 `fn-def`、体就是属性体 ——
       取/存于是叫 `g_p$get` / `g_p$set`（顶层那一格没有 `$this`）。 */
    if (m.shape === 'prop' && m.name !== null) {
      const body = named(m.at)?.body;
      const inner = headOf(body) === 'compound' ? readBodyMembers(body) : [];
      /* 只有原型的那一格不算一个函数（体写在属性外面，与它是同一个）——
         不滤掉就会多走号（153-propsetovl.jnc 的 `g_q$set$o3` / `$o4`）。 */
      const accs = inner.filter((x) => x.shape === 'fn' && headOf(x.at) === 'fn-def');
      const own = m.ns === null || m.ns === undefined ? m.name : `${m.ns}$${m.name}`;
      if (accs.length > 0) {
        for (const im of accs) {
          cases.push({ m: im, ctx: { owner: own, self: null, clsRoot, inProp: true } });
        }
        continue;
      }
      if (headOf(body) === 'compound') {
        getCases.push({ m, ctx: { owner: m.ns ?? null, self: null, clsRoot } });
        continue;
      }
    }
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
    const self = host !== undefined ? selfOf(host.agg) : (m.extSelf ?? null);
    /* 点串的头一段不是聚合体时（`g_p.get()` 那种**顶层属性**的取/存）本来就没有 `$this`
       —— 旧降级发的是 `(fn g_p$get () int`（107-psetexpr.jnc）。 */
    cases.push({ m: mm, ctx: { owner: m.ns ?? null, self } });
  }

  for (const al of aliasTops) {
    const tgt = tops.find((x) => x.shape === 'fn' && x.name === al.to);
    if (tgt !== undefined) {
      aliasCases.push({ name: al.name, tgt: { ...tgt, storage: tgt.storage ?? [] }, ctx: { owner: al.ns ?? null, self: null, clsRoot } });
    }
  }

  /* **重载的号**按声明次序发（`q` / `q$o1` / …）—— 拼不出来的那几格照样占一个号，
     所以先问号、再拼头。 */
  const nextDup = overloadIndex();
  const mineNames = new Set();                        // 新腿**试过**的那几个名字（算覆盖率用）
  /* **生成的取/存**先对（它们不占重载号 —— 旧降级那边是另一遍发出来的）。 */
  for (const c of aliasCases) {
    const r = aliasHead(c.name, c.tgt, env, c.ctx);
    if (r.heads.length === 0) {
      skip.set(`别名的转手：${r.why}`, (skip.get(`别名的转手：${r.why}`) ?? 0) + 1);
      continue;
    }
    for (const h of r.heads) {
      mineNames.add(h.name);
      const wantL = oracle.get(h.name);
      if (wantL === undefined) { noFn += 1; noFnAt.push(`${f.split('/').pop()}　${h.name}`); continue; }
      cmp += 1;
      if (h.head === wantL) same += 1;
      else if (diff.length < 20) {
        diff.push(`${f.split('/').pop()}\n      旧 ${wantL}\n      新 ${h.head}`);
      }
    }
  }
  for (const c of ctorCases) {
    const h = ctorHead(c.name, c.self);
    mineNames.add(h.name);
    const wantC = oracle.get(h.name);
    if (wantC === undefined) { noFn += 1; noFnAt.push(`${f.split('/').pop()}　${h.name}`); continue; }
    cmp += 1;
    if (h.head === wantC) same += 1;
    else if (diff.length < 20) {
      diff.push(`${f.split('/').pop()}\n      旧 ${wantC}\n      新 ${h.head}`);
    }
  }
  for (const c of accCases.concat(getCases, vdCases)) {
    const r = c.ctx.root !== undefined
      ? dispatchHead(c.m, env, c.ctx)
      : (c.m.shape === 'prop'
        ? autogetGetterHead(c.m, env, c.ctx) : dataAccessorHeads(c.m, env, c.ctx));
    if (r.heads.length === 0) {
      skip.set(`生成的取/存：${r.why}`, (skip.get(`生成的取/存：${r.why}`) ?? 0) + 1);
      continue;
    }
    for (const h of r.heads) {
      mineNames.add(h.name);
      const wantA = oracle.get(h.name);
      if (wantA === undefined) { noFn += 1; noFnAt.push(`${f.split('/').pop()}　${h.name}`); continue; }
      cmp += 1;
      if (h.head === wantA) same += 1;
      else if (diff.length < 20) {
        diff.push(`${f.split('/').pop()}\n      旧 ${wantA}\n      新 ${h.head}`);
      }
    }
  }
  for (const c of cases) {
    /* **reactor** 那一格发的是 `$start` / `$stop` 两格（82-reactor.jnc）—— 各自与旧降级对。 */
    if (isReactor(c.m)) {
      for (const h of reactorHeads(c.m, c.ctx).heads) {
        mineNames.add(h.name);
        const wantR = oracle.get(h.name);
        if (wantR === undefined) { noFn += 1; noFnAt.push(`${f.split('/').pop()}　${h.name}`); continue; }
        cmp += 1;
        if (h.head === wantR) same += 1;
        else if (diff.length < 20) {
          diff.push(`${f.split('/').pop()}\n      旧 ${wantR}\n      新 ${h.head}`);
        }
      }
      continue;
    }
    /* 名字要与 `fnHead` 用同一条口径 —— 属性体里那格裸写的 `get`/`set` 是取/存，不是下标算符
       （先前尺子这一侧漏传 `inProp`，键算成了 `…$op$index$set`）。 */
    const base = fnName(c.m, c.ctx.inProp === true);
    const sym = base === null ? null : (c.ctx.owner === null ? base : `${c.ctx.owner}$${base}`);
    const dup = sym === null ? 0 : nextDup(sym);
    const built = fnHead(c.m, env, { ...c.ctx, dup, clsRoot });
    const key = sym === null ? '?' : `${sym}${overloadSuffix(base, dup)}`;
    if (key !== '?') mineNames.add(key);
    const want = oracle.get(key);
    if (built.head === null) {
      skip.set(built.why, (skip.get(built.why) ?? 0) + 1);
      if (skipAt.length < 20) skipAt.push(`${f.split('/').pop()}　${key}　${built.why}`);
      continue;
    }
    if (want === undefined) {                         // 旧降级没发这一格（原型、宿主面那几族）
      noFn += 1;
      noFnAt.push(`${f.split('/').pop()}　${key}`);
      continue;
    }
    cmp += 1;
    if (built.head === want) same += 1;
    else if (diff.length < 20) {
      diff.push(`${f.split('/').pop()}\n      旧 ${want}\n      新 ${built.head}`);
    }
  }
  /* **覆盖率**：旧降级发了、新腿连试都没试的那几格 —— 按名字的样子归族记账。
     这一栏是"还差哪几族"的实账（不归到 100% 那个数里去，那个数只说试过的对不对）。 */
  for (const nm of oracle.keys()) {
    if (mineNames.has(nm)) continue;
    uncovered += 1;
    const fam = familyOf(nm);
    families.set(fam, (families.get(fam) ?? 0) + 1);
    if (uncoveredAt.length < (all ? 400 : 20)) uncoveredAt.push(`${f.split('/').pop()}　${nm}`);
  }
}

console.log(`语料 ${filesOk}/${files.length} 份　对比函数头 ${cmp} 行`
  + `　一模一样 ${same}（${(same / Math.max(cmp, 1) * 100).toFixed(1)}%）　不一致 ${cmp - same}`);
if (noFn > 0) console.log(`旧降级没发这一格函数：${noFn} 个（只有原型、宿主面、被分派吃掉那几族）`);
if (uncovered > 0) {
  console.log(`旧降级发了、新腿还没试的：${uncovered} 格　→ ${[...families]
    .sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w}×${n}`).join('  ')}`);
}
if (skip.size > 0) {
  console.log(`拼不出来（记账，不算对）：${[...skip].sort((a, b) => b[1] - a[1])
    .map(([w, n]) => `${w}×${n}`).join('  ')}`);
}
if (all && noFnAt.length > 0) {
  console.log('\n新腿发了、旧降级没有这个名字的（要么名字错了、要么本来就不该发）：');
  for (const d of noFnAt.slice(0, 40)) console.log(`  ${d}`);
}
if (all && uncoveredAt.length > 0) {
  console.log('\n还没试的那几格（照着去补下一族）：');
  for (const d of uncoveredAt) console.log(`  ${d}`);
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
