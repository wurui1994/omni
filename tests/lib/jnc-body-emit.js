// tests/lib/jnc-body-emit.js —— **第七条腿**：函数体逐行对（尺子 = 旧降级的真输出）
//
// 前六条腿量的是"头"与"顶层那几行"；这一把量的是**体里那几句**。做法照旧：
// `node src/cli.js emit sx x.jnc` 出来的 `(fn 名字 …` 下面那几行就是外部尺，新腿用
// `emit-body.js`（照 stmt/expr 两张表走）降同一份体，**逐字比**。
//
// 探子（`lookup` / `fieldOf` / `elemOf` / `callOf` / `localDecl` / `assign`）先给**最小的一份**：
// 形参与局部量、整数/实数/布尔/字符串字面量、一元二元、`(let …)` / `(set …)`。别的一律
// **记账走开**（那是"还没做"，不是"做错了"）—— 所以这一把尺子头一版只会量出很少几格，
// 那正是它该说的话。
//
// 用法：node tests/lib/jnc-body-emit.js [文件数，默认 400] [--all]

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Diagnostics } from '../../src/core/source/diag.js';
import { initJnc, jncFrontEnd, jncParse } from '../../src/core/lang/jnc.js';
import { headOf, named } from '../../src/lang/jnc/adapt.js';
import { nameText, allInChain, readDcl } from '../../src/lang/jnc/declare.js';
import { readDeclType } from '../../src/lang/jnc/types.js';
import { resolveType } from '../../src/lang/jnc/resolve-type.js';
import { emitType } from '../../src/lang/jnc/emit-type.js';
import { readFormals } from '../../src/lang/jnc/emit-fn.js';
import { emitBody } from '../../src/lang/jnc/emit-body.js';
import { INT_BITS } from '../../src/lang/jnc/resolve-type.js';
import { wrapTo, uOp } from '../../src/lang/jnc/int-table.js';

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

/** 旧降级输出里每一格函数的**体**：名字 -> 那几行（缩进 4 起，直到不再缩进更深）。 */
function bodiesOf(text) {
  const out = new Map();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^ {2}\(fn (\S+) /.exec(lines[i]);
    if (m === null) continue;
    const body = [];
    for (let j = i + 1; j < lines.length && /^ {4}/.test(lines[j]); j += 1) body.push(lines[j]);
    /* 体的**最后一行**末尾那个 `)` 是函数那一格的收尾，不属于体 —— 去掉它再比。 */
    if (body.length > 0) body[body.length - 1] = body[body.length - 1].replace(/\)$/, '');
    out.set(m[1], body.join('\n'));
  }
  return out;
}

/** 最小的那份探子：形参与局部量的类型表。 */
function makeEnv(fnNode, env, acct) {
  const names = new Map();
  const nm = named(fnNode);
  const dc = nm === null ? null : readDcl(nm.dcl);
  const sf = dc === null ? undefined : dc.suffixes.find((x) => x.kind === 'fn-suffix');
  for (const f of (sf === undefined ? [] : readFormals(sf.node) ?? [])) {
    if (f.name !== null && f.type !== null) names.set(f.name, f.type);
  }
  /* 返回类型：`(ret 值)` 那一格的 `want`。 */
  let retT = null;
  {
    const t0 = nm === null ? null : readDeclType(nm.specs, nm.dcl);
    if (t0 !== null && t0.base.kind !== 'none') {
      const r0 = resolveType({ ...t0, shape: 'data' }, env);
      if (r0.type !== null && r0.type.k !== 'void') retT = r0.type;
    }
  }
  let n = 0;
  const T = {
    int: { k: 'int' }, i32: { k: 'int' }, i64: { k: 'int' }, u64: { k: 'int' },
    real: { k: 'real' }, bool: { k: 'bool' }, string: { k: 'string' },
  };
  /** 整数那一格要带**位宽与符号性**：方言只有一格 int，回卷全靠这两样。 */
  const withBits = (ty, decl) => {
    if (ty === null || ty === undefined || ty.k !== 'int') return ty;
    const word = decl?.base?.text ?? 'int';
    /* **无符号那一族的名字**（jancy 的 `setupStdTypedef`）：`uint*` / `u*_t` / `byte_t` /
       `word_t` / `dword_t` / `qword_t`，外加写出来的 `unsigned`。 */
    const u = /^(uint|uchar|ushort|ulong|utf)/.test(word)
      || ['byte_t', 'word_t', 'dword_t', 'qword_t', 'size_t'].includes(word)
      || (decl?.mods ?? []).includes('unsigned');
    return { ...ty, w: INT_BITS[word] ?? 32, u };
  };
  const CMP = new Set(['==', '!=', '<', '<=', '>', '>=', '&&', '||']);
  return {
    T,
    acct,
    /** 比较回 bool；算术回**宽的那一格**（符号性跟着宽的那一边）。 */
    typeOfBinary: (op, a, b) => {
      if (CMP.has(op)) return { k: 'bool' };
      if (a?.k === 'real' || b?.k === 'real') return { k: 'real' };
      if (a?.k !== 'int' || b?.k !== 'int') return a;
      return (a.w ?? 32) >= (b.w ?? 32) ? a : b;
    },
    typeOfUnary: (op, a) => (op === '!' ? { k: 'bool' } : a),
    /** **会溢出的那几个**（结果要就地回卷）：加减乘与左移。 */
    overflows: (op) => ['+', '-', '*', '<<'].includes(op),
    /** 无符号且 64 位那几格换 u 版算子（第六十一刀）。 */
    opOf: (op, t) => (t?.k === 'int' ? uOp(op, t.w ?? 32, t.u === true) : op),
    /** **算完回卷**：只有整数要（比较回的是 bool，不掩）。 */
    /** **落进一格**时才回卷：`want` 是窄整数、值也是整数那一格。 */
    wrap: (code, want, have) => {
      if (want === null || want === undefined || want.k !== 'int') return code;
      if (have === null || have === undefined || have.k !== 'int') return code;
      /* **编译期常量不用回卷**：字面量那一格早就落在规范形里了（旧降级的 `intLit` 干的），
         所以 `return 1` 是 `(ret (int 1))` 而不是掩一圈（135-overloadcheap.jnc 量出来的）。 */
      if (/^\(int -?\d+\)$/.test(code)) return code;
      if ((want.w ?? 32) >= 64) return code;
      return wrapTo(code, want.w ?? 32, want.u === true);
    },
    tmp: (p) => `${p}${n++}`,
    loops: [],
    retVoid: retT === null,
    retType: retT === null || retT.k !== 'int' ? retT
      : { ...retT, w: INT_BITS[nm === null ? 'int' : (readDeclType(nm.specs, nm.dcl)?.base?.text ?? 'int')] ?? 32, u: false },
    inMain: false,
    /* 判据那几格（表里要问的谓词）。 */
    isInt: (t) => t !== null && t !== undefined && t.k === 'int',
    isReal: (t) => t !== null && t !== undefined && t.k === 'real',
    isBool: (t) => t !== null && t !== undefined && t.k === 'bool',
    isArr: (t) => t !== null && t !== undefined && t.k === 'arr',
    isVar: () => false,
    isEnum: (t) => t !== null && t !== undefined && t.k === 'enum',
    isClass: (t) => t !== null && t !== undefined && t.k === 'class',
    isStruct: (t) => t !== null && t !== undefined && t.k === 'struct',
    isFn: (t) => t !== null && t !== undefined && t.k === 'fnptr',
    isPtr: (t) => t !== null && t !== undefined && (t.k === 'ptr' || t.k === 'tptr'),
    decay: (v) => v,
    realOf: (code) => `(tor ${code})`,
    intConv: (v) => v,
    constInt: () => null,
    /** 裸名字：只认形参与局部量（真正的九步要作用域图 —— 记账）。 */
    lookup: (node) => {
      const key = String(named(node)?.text?.value ?? '');
      const t = names.get(key);
      if (t === undefined) { acct(`裸名字 '${key}' 还查不着（要作用域图）`); return null; }
      const r = resolveType(t, env);
      if (r.type === null) { acct(`'${key}' 的类型解不出来`); return null; }
      return { code: `(var ${key})`, type: withBits(r.type, t) };
    },
    /** 一格局部量声明：`int x = 5;` → `(let x int (int 5))`。 */
    localDecl: (node, ind, ctx) => {
      const pad = ' '.repeat(ind);
      const vn = named(node);
      if (vn === null || headOf(node) !== 'var-decl') { acct('这一格局部量声明还拼不出来'); return null; }
      const out = [];
      for (const d of allInChain(vn.dcls, 'dcls-add', 'dcls')) {
        const isInit = headOf(d) === 'init';
        const dd = isInit ? named(d)?.dcl : d;
        const t = readDeclType(vn.specs, dd);
        if (t === null || t.name === null) { acct('局部量的名字读不出来'); return null; }
        const r = resolveType(t, env);
        if (r.type === null) { acct(`局部量 '${t.name}'：${r.why}`); return null; }
        names.set(t.name, t);
        const ty = emitType(r.type, 'slot');
        const declTy = withBits(r.type, t);
        if (!isInit) { acct(`没写初值的局部量 '${t.name}'（零值那一格还没接）`); return null; }
        const v = ctx.expr(named(d)?.value, declTy);
        if (v === null) return null;
        out.push(`${pad}(let ${t.name} ${ty} ${v})`);
      }
      return out;
    },
    /** 赋值：只认"左边是一格名字"。 */
    assign: (node, ind, ctx) => {
      const pad = ' '.repeat(ind);
      const an = named(node);
      const tg = an?.targets;
      const first = headOf(tg) === 'targets' ? named(tg)?.first : tg;
      if (headOf(first) !== 'name') { acct('赋值的左边还拼不出来（要可写位置那一层）'); return null; }
      const key = String(named(first)?.text?.value ?? '');
      const t = names.get(key);
      if (t === undefined) { acct(`赋值的左边 '${key}' 查不着`); return null; }
      const r = resolveType(t, env);
      const vals = an?.values;
      const v0 = headOf(vals) === 'values' ? named(vals)?.first : vals;
      const v = ctx.expr(v0, r.type);
      if (v === null) return null;
      return [`${pad}(set ${key} ${v})`];
    },
    /** `x++` 当一条语句：`(set x (回卷 (bin "+" (var x) (int 1))))`。 */
    incDec: (target, one, ind, ctx) => {
      const pad = ' '.repeat(ind);
      if (headOf(target) !== 'name') { acct('`++` 的左边还拼不出来（要可写位置那一层）'); return null; }
      const key = String(named(target)?.text?.value ?? '');
      const t = names.get(key);
      if (t === undefined) { acct(`'${key}' 查不着`); return null; }
      const r = resolveType(t, env);
      if (r.type === null) { acct(`'${key}' 的类型解不出来`); return null; }
      const ty = withBits(r.type, t);
      const raw = `(bin ${JSON.stringify(one)} (var ${key}) (int 1))`;
      const code = ty.k === 'int' ? wrapTo(raw, ty.w ?? 32, ty.u === true) : raw;
      return [`${pad}(set ${key} ${code})`];
    },
    fieldOf: () => { acct('取字段还没接'); return null; },
    elemOf: () => { acct('下标还没接'); return null; },
    callOf: () => { acct('调用还没接'); return null; },
    contTargets: () => false,
  };
}

initJnc({ log: () => {} });
const tb = jncFrontEnd();
const files = walkDir('tests/jnc/cases').sort().slice(0, limit);

let filesOk = 0;
let cmp = 0;
let same = 0;
const diff = [];
const skip = new Map();

for (const f of files) {
  let out = '';
  try {
    out = execFileSync('node', ['src/cli.js', 'emit', 'sx', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { continue; }
  let tree = null;
  try { tree = jncParse(tb, f, new Diagnostics()); } catch { continue; }
  const oracle = bodiesOf(out);
  if (oracle.size === 0) continue;
  filesOk += 1;
  const short = f.split('/').pop();
  const env = new Map();

  const dig = (n) => {
    if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
    if (headOf(n) === 'agg') return;                                 // 方法那一族要 `this`，还没接
    if (headOf(n) === 'fn-def') {
      const nm = named(n);
      const dc = nm === null ? null : readDcl(nm.dcl);
      const name = dc === null ? null : dc.name;
      const want = name === null ? undefined : oracle.get(name);
      if (want !== undefined) {
        const why = [];
        const e = makeEnv(n, env, (w) => { why.push(w); });
        const got = emitBody(nm.body, e, 4);
        if (got === null || why.length > 0) {
          const w = why[0] ?? '体拼不出来';
          skip.set(w, (skip.get(w) ?? 0) + 1);
        } else {
          cmp += 1;
          if (got === want) same += 1;
          else if (diff.length < 20) diff.push(`${short}　${name}\n      旧 ${want}\n      新 ${got}`);
        }
      }
      return;                                                        // 体里不再往下找函数
    }
    for (const it of n.items) dig(it);
  };
  dig(tree);
}

console.log(`语料 ${filesOk} 份　对比函数体 ${cmp} 格`
  + `　一模一样 ${same}（${(same / Math.max(cmp, 1) * 100).toFixed(1)}%）　不一致 ${cmp - same}`);
if (skip.size > 0) {
  const top = [...skip].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`还没接（记账，不算对）：${[...skip].reduce((s, [, n]) => s + n, 0)} 格　→ `
    + top.map(([w, n]) => `${w}×${n}`).join('  '));
}
if (diff.length > 0) {
  console.log('\n对不上：');
  for (const d of (all ? diff : diff.slice(0, 5))) console.log(`  ${d}`);
}
process.exitCode = cmp > 0 && same === cmp ? 0 : 1;
