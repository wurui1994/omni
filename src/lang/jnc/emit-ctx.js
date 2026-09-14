// src/lang/jnc/emit-ctx.js —— **函数体那一层的探子**（把表接成能跑的一条腿）
//
// `emit-body.js` / `emit-stmt.js` / `emit-expr.js` 三个驱动只认"形状 → 文字"，凡是要
// **知道名字与类型**的地方都由这一份回答：裸名字查名、可写位置、取字段、下标、调用、
// 局部量声明、赋值、`++`、printf、取地址。也就是 ADR-0029 说的"作用域图 + 类型表"那一层，
// 只是这一层是**按文件的一遍扫**（`module-scan.js`）而不是一整张图。
//
// 一份规则只有一处家：这一份先前长在尺子里（tests/lib/jnc-body-emit.js），现在搬进 src/，
// 尺子与真降级**用同一份**。答不出来的一律 `acct(为什么)` 并回 null —— 绝不猜。

import { headOf, named } from './adapt.js';
import { nameText, allInChain, readDcl } from './declare.js';
import { readDeclType, readAnonType } from './types.js';
import { readSpecs } from './specs.js';
import { resolveType, INT_BITS } from './resolve-type.js';
import { emitType } from './emit-type.js';
import { readFormals } from './emit-fn.js';
import { emitExpr } from './emit-expr.js';
import { lvalueShape, SHAPE_ACCESS } from './lvalue-table.js';
import {
  memberShape, copyValLines, STR_MEMBERS, strMember,
} from './member-table.js';
import { compoundValue, errTest, errValue, escapeText } from './stmt-table.js';
import { wrapTo, realOf, intConvCode } from './int-table.js';
import { fmtRun, specPiece, specDress } from './fmt-table.js';
import { zeroText } from './expr-table.js';
import {
  addrTaken, liftable, liftedType, cellName,
} from './emit-global.js';
import { evalConst } from './const-eval.js';

/**
 * 一格函数体要的那一整套探子。`o` 里：
 *   fnNode                      这一格函数的节点（形参、返回类型、体都从它读）
 *   env                         类型环境（名字 → struct/class/enum/typedef/const）
 *   acct(why)                   记账
 *   fns                         顶层函数签名表（名字 → { params, ret, retDecl, ec }）
 *   aggFields / aggCtors        聚合体的字段表 / 有 construct 的那几格
 *   globals / gLifted / gBindable   模块级那几格量
 *   roots                       类的继承链根（第五十六刀）
 *   ecBox / tmpBox              两个**一份模块一个**的计数器
 *   ctxRef()                    拿驱动那一格 ctx（`expr` / `ecOut` / `guards` 都在它上头）
 */
export function makeFnEnv(o) {
  const {
    fnNode, env, acct, fns = new Map(), aggFields = new Map(), aggCtors = new Set(),
    ecBox = { n: 0 }, tmpBox = { n: 0 }, globals = new Map(), gLifted = new Set(),
    gBindable = new Set(), roots = new Map(), gEmit = new Map(),
  } = o;
  let ctxRef = null;
  /* **类那一族在方言里写的是继承链的根**（第五十六刀）—— 发类型时都要带上这一格。 */
  const clsRoot = (cn) => roots.get(cn) ?? cn;
  const tyc = { clsRoot };
  const names = new Map();
  /** 名字在方言那一侧叫什么（`this` → `$this`、按值传的结构体形参 → 它那份拷贝 `名字$v`）。 */
  const alias = new Map();
  /** 体首那几行（按值传的结构体/数组形参在这儿抄一份）。 */
  const pre = [];
  const nm = named(fnNode);
  const dc = nm === null ? null : readDcl(nm.dcl);
  const sf = dc === null ? undefined : dc.suffixes.find((x) => x.kind === 'fn-suffix');
  /** 一格聚合体的字段表（名字 + **解出来**的类型）—— "抄一份"那一层要它。 */
  const fieldsOf = (aggName) => {
    const fs = aggFields.get(aggName);
    if (fs === undefined) return null;
    const out = [];
    for (const [fn2, ft] of fs) {
      const r = resolveType(ft, env);
      if (r.type === null) return null;
      out.push({ name: fn2, type: r.type });
    }
    return out;
  };
  /**
   * **被 `&` 取过地址的名字提到堆上**（第九刀）：那一格是 `(pnew (ptr T) (int 1))`，读写全走
   * 它（于是 `*p` 与它是同一个字），`&x` 就是那一格单元本身。形参提的是**它的一份拷贝**
   * （C 的语义：形参就是个局部量，改它不影响调用方）。结构体与数组不在这条里 —— 它们那一格里
   * 放的**本来就是**地址（`&s` 一个字都不发，第十二 / 二十刀）。
   */
  const taken = addrTaken(fnNode, new Set(), (() => {
    /* **返回类型是数据指针**时 `return entry;` 也算"地址逃出去了"（第一百六十七刀）。 */
    const t0 = nm === null ? null : readDeclType(nm.specs, nm.dcl);
    if (t0 === null || t0.base.kind === 'none') return false;
    const r0 = resolveType({ ...t0, shape: 'data' }, env);
    return r0.type !== null && (r0.type.k === 'ptr' || r0.type.k === 'tptr');
  })());
  const lifts = new Set();
  /** 体这一层要的模块级槽（`once` 的旗子、`static` 局部量那一格）—— 模块那一层照单发。 */
  const slots = [];
  for (const f of (sf === undefined ? [] : readFormals(sf.node) ?? [])) {
    if (f.name !== null && f.type !== null) names.set(f.name, f.type);
    /**
     * **按值传结构体与数组**（第十三 / 二十一刀）：进来的是调用方那一段的**地址**，所以函数
     * 开头先开一格自己的、把它抄进来（`名字$v`），之后这个名字一律指那一格 —— 改形参因此
     * 不动调用方。数组走同一条路（jancy 那边它也是按值的一整块，不是 C 的 `T*`）。
     */
    if (f.name !== null && f.type !== null) {
      const rf = resolveType(f.type, env);
      if (rf.type !== null && (rf.type.k === 'struct' || rf.type.k === 'arr')) {
        const v = `${f.name}$v`;
        const st = emitType(rf.type, 'slot', tyc);
        const ls = copyValLines({
          dst: `(var ${v})`, src: `(var ${f.name})`, type: rf.type, pad: '    ', fieldsOf,
        });
        if (ls === null) acct(`按值传的形参 '${f.name}' 抄不出来（字段表/环那两格）`);
        else {
          pre.push(`    (let ${v} ${st} (pnew ${st} (int 1)))`, ...ls);
          alias.set(f.name, v);
        }
      } else if (rf.type !== null && taken.has(f.name)) {
        /* 被取过地址的**标量形参**：提它的一份拷贝（两句），往后读写都走那一格。 */
        if (!liftable(rf.type)) acct(`对 ${rf.type.k} 的形参取地址（提不动）还没接`);
        else {
          const c = cellName(f.name);
          const pt = liftedType(rf.type, tyc);
          pre.push(`    (let ${c} ${pt} (pnew ${pt} (int 1)))`,
            `    (pstore (var ${c}) (var ${f.name}))`);
          lifts.add(f.name);
        }
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
  /* **errorcode 的临时格子另有一个计数器**（`ecSeq`，与 `$do`/`$sv` 那个 `tmp` 分开），而且它是
     **一份模块一个**、跨函数连着数的（55-errorcode.jnc 里 `$e0`…`$e8` 一路排下去）——
     所以由调用方按文件传进来。`$e` / `$l` / `$s` / `$x` 四族共用它，这一把只接 `$e`。
     **有账的那几格函数会让号跟着差**（旧降级把它们也降了、号照样往前走），那是这把尺子
     现在的界限：真正对不齐时账上会看见，不猜。 */
  /* 整数那几格**各带自己的位宽与符号性**：方言只有一格 int，回卷与"落进一格"全靠这两样。
     先前这四格都是光一个 `{ k:'int' }`（没有 `w` / `u`），于是 `int i = 3000000000;`
     那一次"落进 32 位"一个字都不发 —— 印出来是 3000000000，而 C 与 jancy 是 -1294967296。 */
  const T = {
    int: { k: 'int', w: 32, u: false },
    i32: { k: 'int', w: 32, u: false },
    i64: { k: 'int', w: 64, u: false },
    u64: { k: 'int', w: 64, u: true },
    real: { k: 'real' }, bool: { k: 'bool' }, string: { k: 'string' },
  };
  /** 整数那一格要带**位宽与符号性**：方言只有一格 int，回卷全靠这两样。 */
  const withBits = (ty, decl) => {
    if (ty === null || ty === undefined || ty.k !== 'int') return ty;
    const word = decl?.base?.text ?? 'int';
    /* **无符号那一族的名字**（jancy 的 `setupStdTypedef`）：`uint*` / `u*_t` / `byte_t` /
       `word_t` / `dword_t` / `qword_t`，外加写出来的 `unsigned`。 */
    const u = /^(uint|uchar|ushort|ulong)/.test(word)
      || ['byte_t', 'word_t', 'dword_t', 'qword_t', 'size_t'].includes(word)
      || (decl?.mods ?? []).includes('unsigned');
    /* **写着的词不在表里就听解出来那一格的**（`typedef char sbyte_t;` 之后写的是 `sbyte_t`，
       宽度只有解过 typedef 才知道）—— 那一格由 `resolveType` 带上来。先前这儿一律按写着的
       词查表、查不着就当 32 位有符号，于是所有 typedef 过的整数都丢了宽度与符号性。 */
    const known = INT_BITS[word] !== undefined;
    return { ...ty, w: known ? INT_BITS[word] : (ty.w ?? 32), u: u || ty.u === true };
  };
  const CMP = new Set(['==', '!=', '<', '<=', '>', '>=', '&&', '||']);
  /* 这个函数**自己的出错值**（不是 errorcode 的函数为 null）：调 errorcode 的那一处
     "出错就往外跳"跳的就是 `(ret 这一格)`。 */
  const retTy = nm === null ? retT : withBits(retT, readDeclType(nm.specs, nm.dcl));
  const curErr = (() => {
    const sp = nm === null ? null : readSpecs(nm.specs);
    if (sp === null || !sp.words.includes('errorcode')) return null;
    return errValue(retTy, { tyText: (x) => emitType(x, 'value', tyc) });
  })();
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
      /* **局部与形参遮住模块级那一格**（查名的第一步就是"查得着的变量"，次序即规则）。 */
      const t = names.get(key) ?? globals.get(key);
      const isG = !names.has(key) && globals.has(key);
      if (t === undefined) { acct(`'${key}' 查不着（要作用域图）`); return null; }
      /* **模块级的 `bindable` data**（第七十刀）：那一格生成取/存两个函数，读它是
         `(call 名字$get)`、写它是 `(call 名字$set …)` —— 属性那一族，另算。 */
      if (isG && gBindable.has(key)) {
        acct(`模块级的 bindable data '${key}'（读写各是一次调用）还没接`); return null;
      }
      const r = resolveType(t, env);
      if (r.type === null) { acct(`'${key}'：${r.why}`); return null; }
      const ty = withBits(r.type, t);
      /* **方言那一侧的名字**可能与源码里的不同（按值传的结构体形参指的是它那份拷贝；
         命名空间里那一格模块级量叫 `ns$名字`）。 */
      const dname = alias.get(key) ?? (isG ? (gEmit.get(key) ?? key) : key);
      /* **结构体与数组是 `agg`**（那一格里放的就是地址，第十二 / 二十一刀）；**提过**的那几格是
         `ptr`（局部的用它的单元 `名字$c`，模块级那一格**自己**就是 `(ptr T)`，第九 / 二十四刀）；
         别的是 `var`。 */
      const isLift = !isG && lifts.has(key);
      const shape = lvalueShape({
        isStruct: ty.k === 'struct',
        isArr: ty.k === 'arr',
        isGlobal: isG,
        gLifted: isG && gLifted.has(key),
        lifted: isLift,
      });
      const code = shape === 'var' ? dname : `(var ${isLift ? cellName(dname) : dname})`;
      return { shape, code, type: ty };
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
  /** 提一格局部量到堆上那两句（第九刀）：单元 + 把初值写进去。提不动就记账。 */
  const liftLines = (name, ty, valCode, pad) => {
    if (!liftable(ty)) { acct(`对 ${ty.k} 的局部量取地址（提不动）还没接`); return null; }
    lifts.add(name);
    const c = cellName(name);
    const pt = liftedType(ty, tyc);
    return [`${pad}(let ${c} ${pt} (pnew ${pt} (int 1)))`, `${pad}(pstore (var ${c}) ${valCode})`];
  };
  /**
   * 名字（或点串）**不是一格内存**的那两路 —— 查名要先问它们，因为它们根本没有位置：
   *
   *   1. **编译期常量**：枚举项（`Color.Red` 与裸 `Red` 两个键都在 env 里）、折叠过的
   *      `const`。发出来就是一格字面量。枚举在方言里**就是它的基整数**（第三十九刀），
   *      所以类型给 int —— 位宽按 32 记（`enum E: uint8` 那几格的窄回卷是这一层的界限）。
   *   2. **函数名当值**：`= add` 是 `(fnref add)`（lower.js:15216-15233）。方言的函数值
   *      自带闭包那一半，普通函数那一半是空的。
   *
   * 都不是就答 null（调用方接着按"一格内存"那条走）。
   */
  const constOrFn = (node) => {
    const h = headOf(node);
    if (h !== 'name' && h !== 'field' && h !== 'ptr-field') return null;
    /* 局部量遮住同名的常量/函数（作用域的次序即规则）。`true` / `false` 不走这一路
       —— 它们是 bool 那一格的字面量（常量层把它们当 1 / 0 只为了算枚举项的值）。 */
    if (h === 'name') {
      const key = String(named(node)?.text?.value ?? '');
      if (key === 'true' || key === 'false') return null;
      if (names.has(key) || globals.has(key)) return null;
    }
    const cv = evalConst(node, env);
    if (cv !== null && cv !== undefined) {
      /* **枚举项带的是那个枚举的类型**（不是裸整数）：`%d` 那一格要按它的底类型读
         （`Top = 0x8000000000000000` 存进 uint64 那一格，`%lld` 印出来是负数），
         比较与 `|` 那几族也要问 bitflag 位。查不着是哪个枚举的（折叠过的 `const`）才给 int。 */
      const ent = h === 'name'
        ? env.get(String(named(node)?.text?.value ?? ''))
        : (() => {
          const nm2 = named(node) ?? {};
          const left = String(named(nm2.obj)?.text?.value ?? '');
          const right = String(nm2.name?.value ?? '');
          return env.get(`${left}.${right}`) ?? env.get(right);
        })();
      const ee = ent !== undefined && typeof ent.enum === 'string' ? env.get(ent.enum) : undefined;
      const ty = ee !== undefined && ee.kind === 'enum'
        ? {
          k: 'enum',
          name: ee.name ?? ent.enum,
          base: ee.base ?? { k: 'int', w: 32, u: false },
          bits: ee.bits === true,
        }
        : { k: 'int', w: 32, u: false };
      /* 发出来的那格字面量按**64 位的位型**写（`BigInt.asIntN`）：方言的 int 是一格有符号的
         64 位机器字，而 `Top = 0x8000000000000000` 存的就是最高位 —— 照原数写出去越界，
         印出来也就少了那个负号（134-bitflagtop.jnc 量的正是这一格）。 */
      return { code: `(int ${BigInt.asIntN(64, cv)})`, type: ty };

    }
    if (h !== 'name') return null;
    const key = String(named(node)?.text?.value ?? '');
    const sig = fns.get(key);
    if (sig === undefined) return null;
    const ps = [];
    for (const p of sig.params) {
      const r = resolveType(p, env);
      if (r.type === null) { acct(`'${key}' 当值用：形参 ${r.why}`); return null; }
      ps.push(withBits(r.type, p));
    }
    const rt = sig.ret === null ? { k: 'void' } : withBits(sig.ret, sig.retDecl);
    return { code: `(fnref ${sig.emit ?? key})`, type: { k: 'fnptr', params: ps, ret: rt } };
  };
  return {
    T,
    acct,
    pre,
    /**
     * **这一格函数要的模块级槽**（`{ name, ty }`）：`once` 的那面旗子、`static` 局部量那一格
     * 与它的闸门。它们在方言里是 `(global …)`，可**要它们的是体那一层** —— 所以体这儿记下来、
     * 模块那一层照单发。少这个口子，`once` 发出来的 `jnc$once$0` 谁也没声明过（161-once.jnc）。
     */
    slots,
    newSlot: (prefix, ty) => {
      const nm2 = `${prefix}${tmpBox.n}`;
      tmpBox.n += 1;
      slots.push({ name: nm2, ty });
      return nm2;
    },
    /* 整数那一格的**位宽与符号性**（`withBits`）：模块级那一层降初值时也要它 —— 那一格
       `want` 少了位宽，回卷就少一圈。 */
    withBits,
    /** 比较回 bool；算术回**宽的那一格**（符号性跟着宽的那一边）。 */
    typeOfBinary: (op, a, b) => {
      if (CMP.has(op)) return { k: 'bool' };
      if (a?.k === 'real' || b?.k === 'real') return { k: 'real' };
      if (a?.k !== 'int' || b?.k !== 'int') return a;
      return (a.w ?? 32) >= (b.w ?? 32) ? a : b;
    },
    typeOfUnary: (op, a) => (op === '!' ? { k: 'bool' } : a),
    tmp: (p) => `${p}${tmpBox.n++}`,
    loops: [],
    retVoid: retT === null,
    /* 返回类型那一格也要带**位宽与符号性**（`withBits`）：`size_t f()` 里 `return i * 3`
       落进去是"转到无符号那一格"= `& 掩码`，不是有符号那一套摊符号位。先前这儿写死
       `u: false`，于是 32-unsigned.jnc 的 `half` 与 55-errorcode.jnc 的 `usize` 各多一圈。 */
    retType: retTy,
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
    /** `(T)x` 里那格 `(type-name specs ptrs)` 解成类型（`readAnonType` 收的是这两格洞）。 */
    typeNameOf: (node) => {
      if (headOf(node) !== 'type-name') { acct('强制转换的目标不是一格 type-name'); return null; }
      const nm2 = named(node) ?? {};
      const t0 = readAnonType(nm2.specs, nm2.ptrs);
      if (t0 === null) { acct('强制转换的目标读不出来'); return null; }
      const r0 = resolveType(t0, env);
      if (r0.type === null) { acct(`强制转换的目标：${r0.why}`); return null; }
      return withBits(r0.type, t0);
    },
    /** **同型**：这一层按"发出来的文字"比 —— 方言那一侧同一格类型就是同一段文字。 */
    sameTy: (a, b) => a !== null && a !== undefined && b !== null && b !== undefined
      && emitType(a, 'value', tyc) === emitType(b, 'value', tyc),
    /* `null` 那六格（`NULL_BY_WANT`）与零值那张表都要"类型怎么写"与"类的根是谁"。 */
    tyText: (t) => emitType(t, 'value', tyc),
    clsRoot,
    intConvCode,
    realOf: (code, t) => realOf(code, t?.w ?? 32, t?.u === true),
    /** 整数转到另一格（同宽同符号一个字都不发）—— `CONV_CHAIN` 的枚举那一条要它。 */
    intConv: (v, to) => ({ code: intConvCode(v.code, v.type, to), type: to }),
    /** `case` 的值要**编译期算出来**（枚举成员也在里头 —— `collectEnumConsts` 已经进 env）。 */
    constInt: (node) => {
      const v = evalConst(node, env);
      return v === null || v === undefined ? null : v;
    },
    /** 裸名字：与**可写位置**那一层同一份（`nameLoad` 的四格就是形状那三条），
        常量与函数名那两路排在它前面（它们没有位置）。 */
    lookup: (node) => constOrFn(node) ?? valOfLv(node),
    /**
     * `&x`（第九 / 二十四刀）：**一个字都不算** —— 提过的那一格给它的单元、结构体与数组给
     * 那一格里放着的地址。没提过的（`var` 形状）取不着地址，明说记账。
     */
    addrOf: (node) => {
      const lv = lvOf(node);
      if (lv === null) return null;
      if (lv.shape === 'var') { acct('对没提到堆上的那一格取地址（`&` 那一族还没接全）'); return null; }
      return { code: lv.code, type: { k: 'ptr', target: lv.type } };
    },
    /** 一格局部量声明：`int x = 5;` → `(let x int (int 5))`。 */
    localDecl: (node, ind, ctx) => {
      const pad = ' '.repeat(ind);
      const vn = named(node);
      if (vn === null || headOf(node) !== 'var-decl') { acct('这一格局部量声明还拼不出来'); return null; }
      /* `static` 的局部量是**另一条路**（第二十六刀）：一格模块级的槽 `名字$sN` + 一道
         只跑一次的闸门 `名字$sN$1`。声明这一层发不出它 —— 记账走开，不猜。 */
      const sp0 = readSpecs(vn.specs);
      const isStatic = sp0 !== null && sp0.words.includes('static');
      const out = [];
      for (const d of allInChain(vn.dcls, 'dcls-add', 'dcls')) {
        const isInit = headOf(d) === 'init';
        const dd = isInit ? named(d)?.dcl : d;
        const t = readDeclType(vn.specs, dd);
        if (t === null || t.name === null) { acct('局部量的名字读不出来'); return null; }
        const r = resolveType(t, env);
        if (r.type === null) { acct(`局部量 '${t.name}'：${r.why}`); return null; }
        names.set(t.name, t);
        const ty = emitType(r.type, 'slot', tyc);
        const declTy = withBits(r.type, t);
        /**
         * **`static` 的局部量**（第二十六刀）：两件事各有出处。
         *   **存储**是"程序启动时分配、一直待到程序结束"（decl_storage.rst）—— 也就是一格
         *   模块级的槽 `名字$sN`（号从共用的那个计数器来，`$` 不在 jancy 的标识符里所以撞不上）；
         *   **初值只跑一次** —— jancy 把它包在 `once` 里，这一层落成一道模块级的布尔闸门
         *   `名字$sN$1`：`(if (un "!" 闸门) (do (set 闸门 真) 初值…))`。
         * 没写初值的一个字都不发（那一格本来就是零）。`(global …)` 那两行在模块那一层，
         * 不在这把尺子量的范围里。
         */
        if (isStatic) {
          if (r.type.k === 'struct' || r.type.k === 'arr' || r.type.k === 'class') {
            acct(`'${t.name}' 是 static 的聚合体/类（那一格要 pnew + 构造，还没接）`); return null;
          }
          const dn = `${t.name}$s${tmpBox.n}`;
          tmpBox.n += 1;
          alias.set(t.name, dn);
          /* 那一格与它的闸门都是**模块级**的（"程序启动时分配、一直待到程序结束"，
             decl_storage.rst）—— 记进 `slots`，模块那一层发 `(global …)`。 */
          slots.push({ name: dn, ty: emitType(r.type, 'slot', tyc) });
          slots.push({ name: `${dn}$1`, ty: 'bool' });
          if (!isInit) continue;
          const v0 = ctx.expr(named(d)?.value, declTy);
          if (v0 === null) return null;
          const bpad = `${pad}    `;
          out.push(
            `${pad}(if (un "!" (var ${dn}$1))`,
            `${pad}  (do`,
            `${bpad}(set ${dn}$1 (bool true))`,
            `${bpad}(set ${dn} ${v0})`,
            `${pad}  ))`,
          );
          continue;
        }
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
          const z = zeroText(r.type, { tyText: (x) => emitType(x, 'value', tyc) });
          if (z === null) { acct(`没写初值的 '${t.name}'：这一格的零值还给不出来`); return null; }
          if (taken.has(t.name)) {
            const ls = liftLines(t.name, r.type, z, pad);
            if (ls === null) return null;
            out.push(...ls);
            continue;
          }
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
        /* **被 `&` 取过地址的**（第九刀）：提到一段自己的内存上，初值用 `pstore` 写进去。
           先降初值再进作用域 —— `int x = x;` 里右边那个 x 指的是外层那个（C 的规矩，jancy 同）。 */
        if (taken.has(t.name)) {
          const ls = liftLines(t.name, r.type, v, pad);
          if (ls === null) return null;
          out.push(...ls);
          continue;
        }
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
        /* 右边**不按左边那一格降**：`int k = -7; k /= (unsigned)2;` 在 C 里是**无符号除法**
           （常用算术转换把两边一起提到无符号那一格），先把右边转成 int32 就把那一步吃掉了
           —— 32-unsigned.jnc 的 `g=` 那行量的正是它。中间那一格由 `compoundValue` 定。 */
        const vv = emitExpr(an.b, null, ctx);
        if (vv === null) return null;
        /* **bool 参与整数运算就是 1 / 0**（第三十七刀）：`n += (i % 2 == 0);` 里右边是 bool，
           而 `compoundValue` 的整数那一支只认整数。这一步与二元算子那儿同一条规则。 */
        const vv2 = vv.type?.k === 'bool' && lv.type?.k === 'int'
          ? { code: `(sel ${vv.code} (int 1) (int 0))`, type: { k: 'int', w: 32, u: false } } : vv;
        const code = compoundValue({
          bin: op.slice(0, -1),
          cur: readLv(lv),
          lvType: lv.type,
          v: vv2,
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
      const args = allInChain(nm2.args, 'args-add', 'args');
      /**
       * **从一格函数指针上调**（第五十五刀）：方言的 `(callfn E 实参…)`，签名就在那一格
       * 的类型里。这一问排在"按名字找函数"**之前** —— 同名的局部量遮住模块级那个函数
       * （lower.js:14730 那条注解就是这一句）。被调不是裸名字（`(*p)(…)`、`a[i](…)`）时
       * 也走这条：那时它只能是一格函数值。
       */
      const asName = headOf(fn) === 'name' ? String(named(fn)?.text?.value ?? '') : null;
      const viaVal = asName === null || names.has(asName) || globals.has(asName);
      if (viaVal) {
        const fv = emitExpr(fn, null, ctxRef);
        if (fv === null) return null;
        if (fv.type?.k !== 'fnptr') {
          acct(`被调那一格是 ${fv.type?.k ?? '?'}，不是函数值（算符重载那一族另算）`); return null;
        }
        const parts = [];
        for (const [i, a2] of args.entries()) {
          const v = ctxRef.expr(a2, fv.type.params[i] ?? null);
          if (v === null) return null;
          parts.push(v);
        }
        const rt = fv.type.ret ?? { k: 'void' };
        return { code: `(callfn ${fv.code}${parts.map((x) => ` ${x}`).join('')})`, type: rt };
      }
      const key = asName;
      if (key === 'printf') { acct('printf 那一族（格式化）还没接'); return null; }
      const sig = fns.get(key);
      if (sig === undefined) { acct(`调的那个 '${key}' 查不着（跨文件/宿主面）`); return null; }
      const parts = [];
      /* **实参给少了就按默认实参补**（第一百七十五刀）：`void def(void function* cb() = null)`
         的 `def()` 落出来是 `(call def (null (fnty () void)))`。补的那一格按形参的类型降
         —— `null` 正要从那儿知道自己是哪种指针。 */
      const nArgs = Math.max(args.length, sig.params.length);
      for (let i = 0; i < nArgs; i += 1) {
        const a2 = args[i];
        const pt = sig.params[i] ?? null;
        const pr = pt === null ? null : resolveType(pt, env);
        const w = pr === null || pr.type === null ? null : withBits(pr.type, pt);
        if (a2 === undefined) {
          const d = (sig.defaults ?? [])[i] ?? null;
          if (d === null) { acct(`调 '${key}' 少了第 ${i + 1} 格实参，而那一格没有默认值`); return null; }
          const v0 = ctxRef.expr(d, w);
          if (v0 === null) return null;
          parts.push(v0);
          continue;
        }
        const v = ctxRef.expr(a2, w);
        if (v === null) return null;
        parts.push(v);
      }
      const code = `(call ${sig.emit ?? key}${parts.map((x) => ` ${x}`).join('')})`;
      const rt = sig.ret === null ? { k: 'void' } : withBits(sig.ret, sig.retDecl);
      /**
       * **`errorcode` 的传播**（第五十八刀，lower.js:15065-15084）：抬一格临时、比一下，
       * 出错就往外跳。往哪儿跳看 `guards` —— 里头有 `try { … }` / `catch:` 就跳它的出口，
       * 没有才回调用方（`(ret 出错值)`）。三处说清：
       *   - `try` 底下什么都不插（调用回的**正是**那个出错值）—— `try` 那一族还没接，记账；
       *   - 插不进语句的位置（惰性位置、循环条件）**明说不收**，不悄悄把错吞掉；
       *   - 这个函数自己不是 errorcode、外面也没有 try 时，jancy 走运行期的 dynamic throw
       *     —— 这一层没有运行期展开，所以也是明说不收。
       */
      if (sig.ec === true) {
        /* 往哪儿跳看**最里那一格守护**（`try { … }` / `catch:`）：有它就跳它的出口，
           没有才回调用方。jancy 是同一条（`throwException` 先问 `findCatchScope()`）。 */
        const gs = ctxRef.guards ?? [];
        const g = gs.length === 0 ? null : gs[gs.length - 1];
        if (g === null && curErr === null) {
          acct('不写 `try` 调 errorcode，而这个函数自己不是 errorcode、外面也没有 try/catch（jancy 那儿走运行期的 dynamic throw）'); return null;
        }
        if (ctxRef.ecOut === null || ctxRef.ecOut === undefined) {
          acct('这个位置上的 errorcode 调用（传播那两句插不进语句 —— 惰性位置/循环条件）'); return null;
        }
        const test = errTest(`(var $e${ecBox.n})`, rt, { tyText: (x) => emitType(x, 'value', tyc) });
        if (test === null) { acct(`${rt.k} 定不出出错值的比法`); return null; }
        const v = `$e${ecBox.n}`;
        ecBox.n += 1;
        const jump = escapeText({ guard: g, loopsLen: (ctxRef.loops ?? []).length, curErr });
        ctxRef.ecOut.push(`${ctxRef.ecPad}(let ${v} ${emitType(rt, 'slot', tyc)} ${code})`);
        ctxRef.ecOut.push(`${ctxRef.ecPad}(if ${test} (do ${jump}))`);
        return { code: `(var ${v})`, type: rt, hoisted: true };
      }
      return { code, type: rt };
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
      const r = fmtRun(fmt, 'stmt', (spec, i0, push) => {
        const pad = ' '.repeat(ind);
        /* 要读好几次的那几段先落成局部量（`$fN`，与旧降级同一族名字）—— `%5d` 里的
           `(call f x)` 不落的话补零那一支会把它算四遍。 */
        const spill = (code, ty) => {
          const t = `$f${tmpBox.n}`;
          tmpBox.n += 1;
          push(`${pad}(let ${t} ${ty} ${code})`);
          return `(var ${t})`;
        };
        /* `*` / `.*` 的实参按 C 的次序取：宽度、精度、值（第二十七刀）。两者都要读好几次，
           所以也先落成局部量。 */
        let i = i0;
        const starArg = (what) => {
          const a0 = vals[i];
          if (a0 === undefined) { acct(`printf 的 '*'（${what}）没有对应的实参`); bad = true; return null; }
          const v0 = emitExpr(a0, { k: 'int', w: 32, u: false }, ctx);
          if (v0 === null) { bad = true; return null; }
          if (v0.type?.k !== 'int') { acct(`printf 的 '*'（${what}）要整数`); bad = true; return null; }
          i += 1;
          return spill(v0.code, 'int');
        };
        let wCode = null;
        if (spec.width === '*') { wCode = starArg('宽度'); if (wCode === null) return null; } else if (spec.width !== null
          && (spec.width > 1 || (spec.width === 1 && spec.prec !== null))) {
          /* 宽度 1 平时不用补（一段文本至少一个字符），可精度**能把它变成空串**
             （`%.0d` 印 0 是零个字符），那时宽度 1 也要补一格空格。 */
          wCode = `(int ${spec.width})`;
        }
        let pCode = null;
        if (spec.prec === '*') { pCode = starArg('精度'); if (pCode === null) return null; } else if (spec.prec !== null) {
          if (spec.prec > 30) { acct('printf 的精度最多 30 位'); bad = true; return null; }
          pCode = `(int ${spec.prec})`;
        }
        const v = vals[i];
        if (v === undefined) { acct('printf 的实参比转换说明少'); bad = true; return null; }
        /* 那一块长什么样按**转换字符**走（`specPiece`）—— `%d` 是 `(tostr …)`、`%f` 是
           `(sfix … 6)`、`%x` 是 `(sbase … 16)`、`%s` 碰上字符串**一个字都不套**。
           枚举在这儿就落到基整数上（第三十九刀）：printf 是变参，那一次转换是隐式的。 */
        const vv0 = emitExpr(v, null, ctx);
        if (vv0 === null) { bad = true; return null; }
        const vv = vv0.type?.k === 'enum' ? { code: vv0.code, type: vv0.type.base } : vv0;
        const piece = specPiece(spec, vv, ctx, pCode);
        if (piece === null) { acct(`%${spec.conv} 碰上这一格类型（${vv.type?.k ?? '?'}）还没接`); bad = true; return null; }
        /* 长度修饰只对整数与 `%lf` 那几格有意义（第四十四刀）；别的组合各是一条边界。 */
        const mod = spec.mod ?? '';
        if (mod !== '' && !['hh', 'h', 'l', 'll'].includes(mod)) {
          acct(`printf 的长度修饰 '%${mod}${spec.conv}'`); bad = true; return null;
        }
        /* 标志、精度、宽度那一层（`specDress`）—— 三处 C 的未定义行为在那儿明说不收。 */
        const d = specDress({
          spec, piece, wCode, pCode, spill,
        });
        if (d.nope !== undefined) { acct(d.nope); bad = true; return null; }
        return d.code;
      }, ' '.repeat(ind));
      if (bad || r === null) return null;
      return r.lines;
    },
    /* 取字段与下标都从**可写位置**那一层出发，读一次（结构体/数组那一格读出来的就是地址）。 */
    fieldOf: (node) => {
      /* **枚举项那一路**（`Color.Red`）排在最前：它是一格编译期常量，不是谁的字段。 */
      const cf = constOrFn(node);
      if (cf !== null) return cf;
      /* **`string_t` 的那两格字段**（第一百四十四刀）：`m_length` 就是 `(slen …)`，
         `m_p` 明说不收。它不是一格内存，所以走在"可写位置"那一层之前。 */
      const nm2 = named(node) ?? {};
      const fname = String(nm2.name?.value ?? '');
      if (STR_MEMBERS.has(fname) && LV_SHAPES.has(headOf(nm2.obj))) {
        const b = lvOf(nm2.obj);
        if (b !== null && b.type?.k === 'string') {
          const r = strMember(fname, readLv(b));
          if (r === null) {
            acct('`string_t` 的 `m_p`（一格指到字节上的 `char const*` —— 与方言的 `char*` 不是同一个东西）');
            return null;
          }
          return r;
        }
      }
      return valOfLv(node);
    },
    elemOf: (node) => valOfLv(node),
    derefOf: (node) => valOfLv(node),
    /**
     * **`throw;` 那一跳**（第五十九刀）：与"errorcode 调用出错时那一跳"落的是**同一段代码**
     * （`escapeText`）—— 有守护就跳那圈一次性循环的 `brk`、没有就 `(ret 当前的错值)`。
     * 先前这一格压根没接上（`ctx.escape` 是 undefined），于是 `throw;` 静静地答 null，
     * 整格函数被跳过、连账都没有一笔（170-throw.jnc 里 `check` 就这么消失了）。
     */
    escape: () => {
      const gs = ctxRef.guards ?? [];
      const g = gs.length === 0 ? null : gs[gs.length - 1];
      if (g === null && curErr === null) {
        acct('`throw` 落在既不是 errorcode、外面也没有 try/catch 的地方（jancy 那儿走运行期的 dynamic throw）');
        return null;
      }
      return escapeText({ guard: g, loopsLen: (ctxRef.loops ?? []).length, curErr });
    },
    /* 驱动把它那一格 `ctx` 交回来（`expr` / `ecOut` / `guards` 都在它上头）。 */
    onCtx: (c2) => { ctxRef = c2; },
  };
}
