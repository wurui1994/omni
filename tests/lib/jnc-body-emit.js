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
import { compoundValue } from '../../src/lang/jnc/stmt-table.js';
import { lvalueShape, SHAPE_ACCESS } from '../../src/lang/jnc/lvalue-table.js';
import { memberShape } from '../../src/lang/jnc/member-table.js';
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
  /** `.` 的左边落在哪个聚合体上（`structBehind`）：结构体自己、类那一格（里放的**就是**
      对象那段内存的地址）、以及"指到结构体的指针"—— 三者的 code 都是那段内存的地址，
      所以 `s.f` 与 `p->f` 落在同一句 `pfield` 上（第二十五刀：`.` 与 `->` 是同一个算符）。 */
  const aggBehind = (ty) => {
    if (ty === null || ty === undefined) return null;
    if (ty.k === 'struct' || ty.k === 'class') return ty.name ?? null;
    if (ty.k === 'ptr' && (ty.target?.k === 'struct' || ty.target?.k === 'class')) {
      return ty.target.name ?? null;
    }
    return null;
  };
  /** 这几种形状**本身可写**（`LV_SHAPES`）；别的当右值求一次值。 */
  const LV_SHAPES = new Set(['name', 'field', 'index', 'ptr-field', 'indirect']);
  /** 一格可写位置读出来那一段文字（`SHAPE_ACCESS`）。 */
  const readLv = (lv) => SHAPE_ACCESS[lv.shape].read(lv.code);
  /** 一格字段的位置（`memberOf`）：`(pfield 基 名)`；字段自己是结构体/数组时它又是一格 `agg`。 */
  const memberAt = (baseCode, aggName, fname) => {
    const fs = aggFields.get(aggName);
    if (fs === undefined) { acct(`'${aggName}' 的字段表还没有（跨文件/宿主面/泛型）`); return null; }
    const ft = fs.get(fname);
    if (ft === undefined) { acct(`'${aggName}' 上查不着字段 '${fname}'（位域/别名/属性/基类那几族另算）`); return null; }
    const r = resolveType(ft, env);
    if (r.type === null) { acct(`字段 '${fname}'：${r.why}`); return null; }
    const ty = withBits(r.type, ft);
    return {
      shape: memberShape(ty.k === 'struct', ty.k === 'arr'),
      code: `(pfield ${baseCode} ${fname})`,
      type: ty,
    };
  };
  /**
   * 一格**可写位置**（`lvalue`，`LVALUE_ORDER` 那四格 + `lvalue0` 那几族）：
   * `{ shape: 'var'|'ptr'|'agg', code, type }`。读写都从它出发（`SHAPE_ACCESS`）。
   * 拼不出来答 null（账已经记过）—— 命名空间里那一格、属性、位域那几族都在这一层之外。
   */
  const lvOf = (node) => {
    const h = headOf(node);
    const nm2 = named(node) ?? {};
    if (h === 'paren') return lvOf(nm2.inner);
    if (h === 'name') {
      const key = String(nm2.text?.value ?? '');
      const t = names.get(key);
      if (t === undefined) { acct(`'${key}' 查不着（要作用域图）`); return null; }
      const r = resolveType(t, env);
      if (r.type === null) { acct(`'${key}'：${r.why}`); return null; }
      const ty = withBits(r.type, t);
      /* **结构体与数组是 `agg`**（那一格里放的就是地址，第十二 / 二十一刀）；别的是 `var`。
         "提到堆上"那一族（第九 / 二十四刀）要 `&x` 的账，这一层还没有 —— 走到它就记账。 */
      const shape = lvalueShape({ isStruct: ty.k === 'struct', isArr: ty.k === 'arr' });
      return { shape, code: shape === 'var' ? key : `(var ${key})`, type: ty };
    }
    /* `*p`（`ptrLv`）：p 是一格指针值，那一格的位置**就是**它；目标是结构体/数组时是 `agg`。 */
    if (h === 'indirect') {
      const p = emitExpr(nm2.a, null, ctxRef);
      if (p === null) return null;
      if (p.type?.k !== 'ptr' && p.type?.k !== 'tptr') { acct("'*' 的左边不是指针"); return null; }
      const tt = p.type.target;
      return { shape: memberShape(tt?.k === 'struct', tt?.k === 'arr'), code: p.code, type: tt };
    }
    /* `a[i]`（`subLv`）：jancy 的下标就是 `*(a + i)`，范围检查在解引用那一步。
       左边先退化（数组是**一整块**，退化是一句 `(pelem …)`），下标要 64 位整数。 */
    if (h === 'index') {
      const a = emitExpr(nm2.obj, null, ctxRef);
      if (a === null) return null;
      if (a.type?.k !== 'ptr' && a.type?.k !== 'tptr') { acct('下标的左边不是指针/数组'); return null; }
      const i = emitExpr(nm2.key, { k: 'int', w: 64, u: false }, ctxRef);
      if (i === null) return null;
      const tt = a.type.target;
      return {
        shape: memberShape(tt?.k === 'struct', tt?.k === 'arr'),
        code: `(padd ${a.code} ${i.code})`,
        type: tt,
      };
    }
    if (h === 'field' || h === 'ptr-field') {
      const fname = String(nm2.name?.value ?? '');
      if (fname === '') { acct('取字段的名字读不出来（点串/泛型那几族另算）'); return null; }
      const ob = nm2.obj;
      let baseCode = null;
      let bt = null;
      /* `p->f` 与"左边不是可写形状"（`f().x`）都是**求一次值**；别的先求它的位置再读一次
         —— 那一格读出来的就是基地址。 */
      if (h === 'ptr-field' || !LV_SHAPES.has(headOf(ob))) {
        const v = emitExpr(ob, null, ctxRef);
        if (v === null) return null;
        baseCode = v.code;
        bt = v.type;
      } else {
        const o = lvOf(ob);
        if (o === null) return null;
        baseCode = readLv(o);
        bt = o.type;
      }
      const agg = aggBehind(bt);
      if (agg === null) { acct(`'.' 的左边不是结构体/类（${bt?.k ?? '?'}）`); return null; }
      return memberAt(baseCode, agg, fname);
    }
    acct(`可写位置这一格还拼不出来：${h}`);
    return null;
  };
  /** 一格可写位置**当值用**：读它一次。 */
  const valOfLv = (node) => {
    const lv = lvOf(node);
    return lv === null ? null : { code: readLv(lv), type: lv.type };
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
    decay: (v) => (v.type?.k === 'arr'
      ? { code: `(pelem ${v.code})`, type: { k: 'ptr', target: v.type.el } } : v),
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
        /* **写了初值的结构体/数组**是"抄一份"（`aggSource` + `copyAgg` / `copyArr`）：源头要
           先钉在一格临时量上（`(let $sN …)`），再逐字段搬。另一族 —— 记账走开。 */
        if (r.type.k === 'struct' || r.type.k === 'arr') {
          acct(`'${t.name}' 写了初值的结构体/数组要逐字段抄一份（还没接）`); return null;
        }
        const v = ctx.expr(named(d)?.value, declTy);
        if (v === null) return null;
        out.push(`${pad}(let ${t.name} ${ty} ${v})`);
      }
      return out;
    },
    /**
     * 赋值（`ASSIGN_ORDER`）：左边整格交给**可写位置**那一层（`lvOf`），写法照形状走
     * （`SHAPE_ACCESS`）。右边是一对花括号（按格子写，空项保留原值）与左边是属性
     * （调存值器）那两族排在前面，这儿都记账走开。
     *
     * **jnc 的 `assign` 换过洞名**（节点表 :63 那条 `replaces: true`）：holes 是
     * `{ op, a, b }`，不是公共库那格 `{ targets, values }`。先前照公共库读，`targets`
     * 永远是 undefined —— 于是"赋值的左边还拼不出来"那 30 格账全是这一个读错造成的
     * （**按表读树**，又栽在同一处）。
     */
    assign: (node, ind, ctx) => {
      const pad = ' '.repeat(ind);
      const an = named(node) ?? {};
      const op = String(an.op?.value ?? '=');
      if (headOf(an.b) === 'curly' || headOf(an.b) === 'curly-init') {
        acct('右边是一对花括号（按格子写、空项保留原值）还没接'); return null;
      }
      const lv = lvOf(an.a);
      if (lv === null) return null;
      /* `agg` 的写**不是一句**：结构体逐字段、数组逐格抄一份（`copyVal`）—— 另一族，记账。 */
      if (lv.shape === 'agg') { acct('往结构体/数组里赋值要逐字段抄一份（还没接）'); return null; }
      /* **复合赋值**（`lv op= v`）：右边按 lv 那一格降，中间那一格由 `compoundValue` 定
         （常用算术转换、回卷只发一次、`%` 例外、指针上是指针算术）。 */
      if (op !== '=') {
        const vv = emitExpr(an.b, lv.type, ctx);
        if (vv === null) return null;
        const code = compoundValue({
          bin: op.slice(0, -1),
          cur: readLv(lv),
          lvType: lv.type,
          v: vv,
          isInt: (t) => t !== null && t !== undefined && t.k === 'int',
          isPtr: (t) => t !== null && t !== undefined && (t.k === 'ptr' || t.k === 'tptr'),
        });
        if (code === null) { acct(`复合赋值 '${op}' 落在 ${lv.type?.k ?? '?'} 上还没接`); return null; }
        return [`${pad}${SHAPE_ACCESS[lv.shape].write(lv.code, code)}`];
      }
      const v = ctx.expr(an.b, lv.type);
      if (v === null) return null;
      return [`${pad}${SHAPE_ACCESS[lv.shape].write(lv.code, v)}`];
    },
    /**
     * `x++` 当一条语句（lower.js:11529-11568）：读一次、加一、写回。三族各有写法 ——
     * 整数按**它自己那一格**回卷（`char c = 127; c++` 是 -128）、指针是 `(padd … ±1)`、
     * 实数是 `(bin "+" … (real 1.0))`。
     */
    incDec: (target, one, ind, ctx) => {
      const pad = ' '.repeat(ind);
      const lv = lvOf(target);
      if (lv === null) return null;
      const cur = readLv(lv);
      const ty = lv.type;
      let code = null;
      if (ty?.k === 'int') {
        code = wrapTo(`(bin ${JSON.stringify(one)} ${cur} (int 1))`, ty.w ?? 32, ty.u === true);
      } else if (ty?.k === 'ptr' || ty?.k === 'tptr') {
        code = `(padd ${cur} (int ${one === '+' ? '1' : '-1'}))`;
      } else if (ty?.k === 'real') {
        code = `(bin ${JSON.stringify(one)} ${cur} (real 1.0))`;
      } else { acct(`'++' 落在 ${ty?.k ?? '?'} 上还没接（算符重载那一族另算）`); return null; }
      if (lv.shape === 'agg') { acct("'++' 落在结构体/数组上（算符重载那一族）还没接"); return null; }
      return [`${pad}${SHAPE_ACCESS[lv.shape].write(lv.code, code)}`];
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
    /* 取字段与下标都从**可写位置**那一层出发，读一次（结构体/数组那一格读出来的就是地址）。 */
    fieldOf: (node) => valOfLv(node),
    elemOf: (node) => valOfLv(node),
    derefOf: (node) => valOfLv(node),
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
