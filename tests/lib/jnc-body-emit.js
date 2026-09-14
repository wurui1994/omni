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
import { readSpecs } from '../../src/lang/jnc/specs.js';
import { readAgg, readEnum } from '../../src/lang/jnc/agg.js';
import { resolveType } from '../../src/lang/jnc/resolve-type.js';
import { emitType } from '../../src/lang/jnc/emit-type.js';
import { readFormals } from '../../src/lang/jnc/emit-fn.js';
import { emitBody } from '../../src/lang/jnc/emit-body.js';
import { emitExpr } from '../../src/lang/jnc/emit-expr.js';
import { INT_BITS } from '../../src/lang/jnc/resolve-type.js';
import { wrapTo, realOf, intConvCode } from '../../src/lang/jnc/int-table.js';
import { fmtRun, specPiece } from '../../src/lang/jnc/fmt-table.js';
import { zeroText } from '../../src/lang/jnc/expr-table.js';

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
/** 顶层那几格函数的签名（名字 → { params, ret }）—— 调用那一族要它。 */
function topFns(tree, env) {
  const out = new Map();
  const dig = (n) => {
    if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
    const h = headOf(n);
    if (h === 'agg') return;
    if (h === 'fn-def' || h === 'fn-proto') {
      const nm = named(n);
      const t = nm === null ? null : readDeclType(nm.specs, nm.dcl);
      if (t !== null && t.name !== null && t.shape === 'fn') {
        const dc = readDcl(nm.dcl);
        const sf = dc === null ? undefined : dc.suffixes.find((x) => x.kind === 'fn-suffix');
        const fs = sf === undefined ? [] : (readFormals(sf.node) ?? []);
        const rr = t.base.kind === 'none' ? null : resolveType({ ...t, shape: 'data' }, env);
        const sp = readSpecs(nm.specs);
        out.set(t.name, {
          params: fs.map((f) => (f.type === null ? null : f.type)),
          ret: rr === null || rr.type === null || rr.type.k === 'void' ? null : rr.type,
          retDecl: t,
          /* `errorcode` 那一族（第五十八刀）：调它的那一处要把"出错就跳"提上来
             （`EC_HOIST`），所以调用那一格得知道被调是不是它。 */
          ec: sp !== null && sp.words.includes('errorcode'),
        });
      }
      return;
    }
    for (const it of n.items) dig(it);
  };
  dig(tree);
  return out;
}

/**
 * 顶层那几格**聚合体**：一边把名字记进 `env`（`resolveType` 要它才认得 `Inner`），
 * 一边攒一张**字段表**（`emitName` → 名字 → 那一格的声明类型）—— 取字段与"往字段里写"
 * 两侧都从它出发。位域、别名路径、属性那几族**不收**（`member-table.js` 的七格里那几条
 * 各有自己的一套，收进来就等于拿普通字段那一支把它们悄悄接走了）。
 */
function topAggs(tree, env) {
  const fields = new Map();
  const ctors = new Set();                                           // 有 construct 的那几格
  const scan = (n, owner) => {
    if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
    const h = headOf(n);
    let inner = owner;
    if (h === 'namespace') {
      const nm = nameText(named(n)?.name);
      if (nm !== null) inner = owner === null ? nm : `${owner}$${nm}`;
    } else if (h === 'agg') {
      const a = readAgg(n);
      const nm = a === null ? null : nameText(a.name);
      if (a !== null && nm !== null) {
        const emitName = owner === null ? nm : `${owner}$${nm}`;
        inner = emitName;
        env.set(nm, {
          kind: a.word === 'union' ? 'union' : (a.word === 'struct' ? 'struct' : 'class'),
          name: emitName,
          agg: a,
        });
        const fs = new Map();
        for (const m of a.members) {
          if (m.name === null || m.type === null) continue;
          if (m.shape === 'bitfield' || m.shape === 'prop' || m.shape === 'event') continue;
          if (m.shape === 'typedef' || m.shape === 'nested-type' || m.shape === 'friend') continue;
          if (m.shape === 'fn') { if (m.name === 'construct') ctors.add(emitName); continue; }
          if (m.storage.includes('static')) continue;                // 不进对象（落成模块级那一格）
          fs.set(m.name, m.type);
        }
        fields.set(emitName, fs);
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
    for (const it of n.items) scan(it, inner);
  };
  scan(tree, null);
  return { fields, ctors };
}

function makeEnv(fnNode, env, acct, fns = new Map(), aggFields = new Map(), aggCtors = new Set()) {
  const names = new Map();
  const nm = named(fnNode);
  const dc = nm === null ? null : readDcl(nm.dcl);
  const sf = dc === null ? undefined : dc.suffixes.find((x) => x.kind === 'fn-suffix');
  for (const f of (sf === undefined ? [] : readFormals(sf.node) ?? [])) {
    if (f.name !== null && f.type !== null) names.set(f.name, f.type);
    /* **按值传结构体**（第十三刀）：被调那一侧在体首**抄一份**（`(let v$v …)` + 逐字段
       `pstore`），往后体里读写的都是那一份。整格是另一族 —— 记账走开，不猜。 */
    if (f.type !== null) {
      const rf = resolveType(f.type, env);
      if (rf.type !== null && (rf.type.k === 'struct' || rf.type.k === 'arr')) {
        acct('按值传结构体/数组的形参要在体首抄一份（还没接）');
      }
    }
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
  /** 一格类型上挂不挂字段：结构体/类**是**它自己；`S*` 那一格里放的就是它的地址。
      **只剥一层星号** —— `S** pp` 要先读一次，那是另一族（记账走开）。 */
  const aggNameOf = (ty) => {
    if (ty === null || ty === undefined) return null;
    if (ty.k === 'struct' || ty.k === 'class') return ty.name ?? null;
    if (ty.k === 'ptr' && (ty.target?.k === 'struct' || ty.target?.k === 'class')) {
      return ty.target.name ?? null;
    }
    return null;
  };
  /** 字段挂着的那个**东家的地址**。 */
  const baseAddr = (obj) => {
    const h = headOf(obj);
    if (h === 'paren') return baseAddr(named(obj)?.inner);
    if (h === 'name') {
      /* 结构体的名字里放的**就是那段内存的地址**（第十二刀），`S* p` 那一格里放的也是地址
         —— 两者同一个字 `(var x)`，所以这儿不分家。 */
      const key = String(named(obj)?.text?.value ?? '');
      const t = names.get(key);
      if (t === undefined) { acct(`取字段的东家 '${key}' 查不着（要作用域图）`); return null; }
      const r = resolveType(t, env);
      const agg = aggNameOf(r.type);
      if (agg === null) { acct('取字段的东家不是结构体/类（变体/属性/命名空间那几族另算）'); return null; }
      return { code: `(var ${key})`, agg };
    }
    if (h === 'field') {
      const f = fieldAt(obj);
      if (f === null) return null;
      const agg = aggNameOf(f.type);
      if (agg === null) { acct('取字段的东家不是结构体/类'); return null; }
      /* 内嵌的结构体字段那一格**就是地址**（`agg`，`member-table.js` 的 memberShape）；
         是指针的要先读出来。 */
      return { code: f.type.k === 'ptr' ? `(pload ${f.addr})` : f.addr, agg };
    }
    acct('取字段的东家还拼不出来（下标/调用/解引用那几族）');
    return null;
  };
  /** 一格 `obj.m` 的**地址**（`(pfield 基 名字)`）+ 那一格的类型。 */
  const fieldAt = (node) => {
    const fn2 = named(node) ?? {};
    const fname = String(fn2.name?.value ?? '');
    if (fname === '') { acct('取字段的名字读不出来（点串/泛型那几族另算）'); return null; }
    const b = baseAddr(fn2.obj);
    if (b === null) return null;
    const fs = aggFields.get(b.agg);
    if (fs === undefined) { acct(`'${b.agg}' 的字段表还没有（跨文件/宿主面/泛型）`); return null; }
    const ft = fs.get(fname);
    if (ft === undefined) { acct(`'${b.agg}' 上查不着字段 '${fname}'（位域/别名/属性/基类那几族另算）`); return null; }
    const r = resolveType(ft, env);
    if (r.type === null) { acct(`字段 '${fname}'：${r.why}`); return null; }
    return { addr: `(pfield ${b.code} ${fname})`, type: withBits(r.type, ft), decl: ft };
  };
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
    tmp: (p) => `${p}${n++}`,
    loops: [],
    retVoid: retT === null,
    /* 返回类型那一格也要带**位宽与符号性**（`withBits`）：`size_t f()` 里 `return i * 3`
       落进去是"转到无符号那一格"= `& 掩码`，不是有符号那一套摊符号位。先前这儿写死
       `u: false`，于是 32-unsigned.jnc 的 `half` 与 55-errorcode.jnc 的 `usize` 各多一圈。 */
    retType: nm === null ? retT : withBits(retT, readDeclType(nm.specs, nm.dcl)),
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
    realOf: (code, t) => realOf(code, t?.w ?? 32, t?.u === true),
    /** 整数转到另一格（同宽同符号一个字都不发）—— `CONV_CHAIN` 的枚举那一条要它。 */
    intConv: (v, to) => ({ code: intConvCode(v.code, v.type, to), type: to }),
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
      /* `static` 的局部量是**另一条路**（第二十六刀）：一格模块级的槽 `名字$sN` + 一道
         只跑一次的闸门 `名字$sN$1`。声明这一层发不出它 —— 记账走开，不猜。 */
      const sp0 = readSpecs(vn.specs);
      if (sp0 !== null && sp0.words.includes('static')) {
        acct('`static` 的局部量（模块级那一格 + 只跑一次的闸门）还没接'); return null;
      }
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
        if (!isInit) {
          /* **没写初值**那一格（`LOCAL_DECL_ORDER` 的数组/结构体两条 + 标量的零值）：
             结构体与数组各是一段自己的 `(pnew … (int 1))` 内存（第十二 / 十刀），标量按
             `zeroText`。有 `construct` 的结构体还要紧跟一句构造 —— 那一族记账走开。 */
          if (r.type.k === 'struct' || r.type.k === 'arr') {
            const root = r.type.k === 'struct' ? r.type.name : null;
            if (root !== null && aggCtors.has(root)) {
              acct(`'${t.name}' 是有 construct 的结构体（造完那一句还没接）`); return null;
            }
            out.push(`${pad}(let ${t.name} ${ty} (pnew ${ty} (int 1)))`);
            continue;
          }
          const z = zeroText(r.type, { tyText: (x) => emitType(x, 'value') });
          if (z === null) { acct(`没写初值的 '${t.name}'：这一格的零值还给不出来`); return null; }
          out.push(`${pad}(let ${t.name} ${ty} ${z})`);
          continue;
        }
        const v = ctx.expr(named(d)?.value, declTy);
        if (v === null) return null;
        out.push(`${pad}(let ${t.name} ${ty} ${v})`);
      }
      return out;
    },
    /** 赋值：左边是一格名字，或**一格字段**（`(pstore (pfield 基 名) 值)`）。 */
    assign: (node, ind, ctx) => {
      const pad = ' '.repeat(ind);
      const an = named(node);
      const tg = an?.targets;
      const first = headOf(tg) === 'targets' ? named(tg)?.first : tg;
      const vals = an?.values;
      const v0 = headOf(vals) === 'values' ? named(vals)?.first : vals;
      if (headOf(first) === 'field') {
        const f = fieldAt(first);
        if (f === null) return null;
        /* 往结构体/数组字段里赋值是**逐字段抄一份**（copyAgg / copyArr）—— 另一族，记账。 */
        if (f.type.k === 'struct' || f.type.k === 'arr') {
          acct('往结构体/数组字段里赋值要逐字段抄一份（还没接）'); return null;
        }
        const v2 = ctx.expr(v0, f.type);
        if (v2 === null) return null;
        return [`${pad}(pstore ${f.addr} ${v2})`];
      }
      if (headOf(first) !== 'name') { acct('赋值的左边还拼不出来（要可写位置那一层）'); return null; }
      const key = String(named(first)?.text?.value ?? '');
      const t = names.get(key);
      if (t === undefined) { acct(`赋值的左边 '${key}' 查不着`); return null; }
      const r = resolveType(t, env);
      const v = ctx.expr(v0, r.type);
      if (v === null) return null;
      return [`${pad}(set ${key} ${v})`];
    },
    /** `x++` 当一条语句：`(set x (回卷 (bin "+" (var x) (int 1))))`；字段那一格走取/存。 */
    incDec: (target, one, ind, ctx) => {
      const pad = ' '.repeat(ind);
      if (headOf(target) === 'field') {
        const f = fieldAt(target);
        if (f === null) return null;
        const raw2 = `(bin ${JSON.stringify(one)} (pload ${f.addr}) (int 1))`;
        const c2 = f.type.k === 'int' ? wrapTo(raw2, f.type.w ?? 32, f.type.u === true) : raw2;
        return [`${pad}(pstore ${f.addr} ${c2})`];
      }
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
    /** 调用：被调是**裸名字**且查得着顶层那几格函数时 → `(call 名字 实参…)`。 */
    callOf: (node, want, ctx) => {
      const nm2 = named(node) ?? {};
      const fn = nm2.fn;
      if (headOf(fn) !== 'name') { acct('被调那一格还认不出来（方法/函数指针/算符）'); return null; }
      const key = String(named(fn)?.text?.value ?? '');
      if (key === 'printf') { acct('printf 那一族（格式化）还没接'); return null; }
      const sig = fns.get(key);
      if (sig === undefined) { acct(`调的那个 '${key}' 查不着（跨文件/宿主面）`); return null; }
      /* `errorcode` 的那几格（第五十八刀）：调它时"出错就跳"要提到语句那一层
         （`(let $eN …)` + `(if (un "!" …) …)`），整格是另一族 —— 记账走开。 */
      if (sig.ec === true) { acct('调 errorcode 那一族（出错就跳要提到语句层）还没接'); return null; }
      const args = allInChain(nm2.args, 'args-add', 'args');
      const parts = [];
      for (const [i, a2] of args.entries()) {
        const pt = sig.params[i] ?? null;
        const pr = pt === null ? null : resolveType(pt, env);
        const w = pr === null || pr.type === null ? null : withBits(pr.type, pt);
        const v = ctxRef.expr(a2, w);
        if (v === null) return null;
        parts.push(v);
      }
      return {
        code: `(call ${key}${parts.map((x) => ` ${x}`).join('')})`,
        type: sig.ret === null ? { k: 'void' } : withBits(sig.ret, sig.retDecl),
      };
    },
    /** `printf("%d %d\n", a, b)` → 按 `\n` 切段，每段一条 `(print …)`；`%d` 那一格是 `(tostr 值)`。 */
    printf: (node, ind, ctx) => {
      const args = allInChain(named(node)?.args, 'args-add', 'args');
      if (args.length === 0) { acct('printf 一个实参都没有'); return null; }
      /* 格式串那一格是一格**记号**，而且**转义已经解好了**：
         `{ kind:'string', value:'%d\n', raw:'%d\\n' }`（印出来才知道的 —— 先前既按裸引号
         判、又想 JSON.parse 一遍，两样都错）。所以直接用 `value`。
         拼接（`"a" "b"`）与格式化字面量（`$"…"`）是另两族，它们是 list，记账。 */
      const f0 = args[0];
      if (f0 === undefined || Array.isArray(f0?.items) || f0.kind !== 'string'
        || typeof f0.value !== 'string') {
        acct('printf 的格式串不是一格字面量（拼接/格式化字面量那两族另算）'); return null;
      }
      const fmt = f0.value;
      const vals = args.slice(1);
      let bad = false;
      const r = fmtRun(fmt, 'stmt', (spec, i) => {
        if (spec.width !== null || spec.prec !== null || spec.flags.left || spec.flags.zero
          || spec.flags.plus || spec.flags.space || spec.flags.alt) {
          acct(`带宽度/精度/标志的 %${spec.conv} 还没接`); bad = true; return null;
        }
        const v = vals[i];
        if (v === undefined) { acct('printf 的实参比转换说明少'); bad = true; return null; }
        /* 那一块长什么样按**转换字符**走（`specPiece`）—— `%d` 是 `(tostr …)`、`%f` 是
           `(sfix … 6)`、`%x` 是 `(sbase … 16)`、`%s` 碰上字符串**一个字都不套**。
           先前这儿一律 `(tostr …)`，于是 `printf("%s", s)` 多套一层、`%f` 印成了 `%.6g`。 */
        const vv = emitExpr(v, null, ctx);
        if (vv === null) { bad = true; return null; }
        const piece = specPiece(spec, vv, ctx);
        if (piece === null) { acct(`%${spec.conv} 碰上这一格类型还没接`); bad = true; return null; }
        return piece;
      }, ' '.repeat(ind));
      if (bad || r === null) return null;
      return r.lines;
    },
    fieldOf: (node) => {
      const f = fieldAt(node);
      if (f === null) return null;
      /* 结构体与数组那一格里放的**就是地址**（`agg`）—— 读它就是那个地址，不 `pload`。 */
      if (f.type.k === 'struct' || f.type.k === 'arr') return { code: f.addr, type: f.type };
      return { code: `(pload ${f.addr})`, type: f.type };
    },
    elemOf: () => { acct('下标还没接'); return null; },
    contTargets: () => false,
  };
}

initJnc({ log: () => {} });
const tb = jncFrontEnd();
const files = walkDir('tests/jnc/cases').sort().slice(0, limit);

let ctxRef = null;
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
  const { fields: aggFields, ctors: aggCtors } = topAggs(tree, env);
  const fns = topFns(tree, env);
  /* **重载过的名字要整族躲开**（第七十九刀）：旧降级给第二格起改名（`q$2` 那一套），
     而尺子这边是按名字取旧输出的一格 —— 拿三个不同的体去对同一格是**错的比法**。
     所以先数一遍：一个名字出现不止一次就整族记账走开（135-overloadcheap.jnc、
     158-overloadlit.jnc 量出来的三格假不一致就是它）。 */
  const seen = new Map();
  {
    const cnt = (n) => {
      if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
      const h = headOf(n);
      if (h === 'agg') return;
      if (h === 'fn-def' || h === 'fn-proto') {
        const d0 = readDcl(named(n)?.dcl);
        if (d0 !== null && d0.name !== null) seen.set(d0.name, (seen.get(d0.name) ?? 0) + 1);
        return;
      }
      for (const it of n.items) cnt(it);
    };
    cnt(tree);
  }

  const dig = (n) => {
    if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
    if (headOf(n) === 'agg') return;                                 // 方法那一族要 `this`，还没接
    if (headOf(n) === 'fn-def') {
      const nm = named(n);
      const dc = nm === null ? null : readDcl(nm.dcl);
      const name = dc === null ? null : dc.name;
      const want = name === null ? undefined : oracle.get(name);
      if (want !== undefined && (seen.get(name) ?? 0) > 1) {
        const w = `'${name}' 重载过（旧降级给第二格起改了名，按名字取的比法不成立）`;
        skip.set(w, (skip.get(w) ?? 0) + 1);
        return;
      }
      if (want !== undefined) {
        const why = [];
        const e = makeEnv(n, env, (w) => { why.push(w); }, fns, aggFields, aggCtors);
        e.onCtx = (c2) => { ctxRef = c2; };
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
