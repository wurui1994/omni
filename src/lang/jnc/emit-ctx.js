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
import { emitType, tyKey } from './emit-type.js';
import { readFormals, OP_NAMES } from './emit-fn.js';
import { emitExpr, strLitFold } from './emit-expr.js';
import { lvalueShape, SHAPE_ACCESS } from '../common/place.js';
import {
  memberShape, copyValLines, STR_MEMBERS, strMember,
} from './member-table.js';
import { compoundValue, errTest, errValue, escapeText } from './stmt-table.js';
import { wrapTo, realOf, intConvCode } from './int-table.js';
import { fmtRun, specPiece, specDress } from '../common/fmt.js';
import { zeroText, CRT_CHAR } from './expr-table.js';
/* `variant_t` 那格结构体是合成出来的：名字与那四格字段的家在 runtime 那一份。 */
import { VARIANT, VARIANT_FIELDS, varBoxShell, varUnboxShell, mcFireName, mcFireShell } from './runtime.js';
import {
  addrTaken, liftable, liftedType, cellName, arrayFromCurly,
} from './emit-global.js';
import { evalConst } from './const-eval.js';
/* "一族候选里挑一条"这一句是**引擎**的（各实参里最差的一档当分、取最高分、并列即歧义）——
   打分才是这门语言的（`argCost`）。抄两份的坏处不是行数，是两份会各自漂。 */
import { pick, worst } from '../../core/frontend-engine/overload.js';

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
    fnNode, env, acct: acct0, fns = new Map(), aggFields = new Map(), aggCtors = new Set(),
    ecBox = { n: 0 }, tmpBox = { n: 0 }, globals = new Map(), gLifted = new Set(),
    gBindable = new Set(), roots = new Map(), gEmit = new Map(),
    methods = new Map(), self = null, tags = new Map(), fieldInits = new Set(),
    gProps = new Map(), propScope = null, aggStatics = new Map(), aggProps = new Map(),
    aggBases = new Map(), helperBox = new Set(), aggPaths = new Map(), aggAliases = new Map(),
    gAlias = new Map(), vdispatch = new Map(), ovl = new Map(), parseExpr = null,
  } = o;
  let ctxRef = null;
  /**
   * **记账过几笔**（`acctSeen`）：外面那几层（`emit-body` 的 printf / 赋值 / 调用三格）先前
   * 一律补一条"这一格还拼不出来"，于是**真正的原因被自己的转手账盖住** —— 尺子上最大的三堆
   * 全是这种转手账。所以这一层数一数：里头记过了就不再补，里头没记那才是**这一层的 bug**
   * （与 `lower.js` 里 `emitBody` 那个兜底同一条）。
   */
  let acctN = 0;
  const acct = (why) => { acctN += 1; acct0(why); };
  /**
   * **`try <表达式>` 把往上传关掉那一格**（第五十九刀，exceptions.rst:60）：`try` 底下调
   * errorcode **什么都不插** —— 算出来的值（可能正是那个出错值）原样交出去，由写的人自己比。
   * 旧降级发的就是一句光的调用（124-errcptr.jnc 的 `(let a (ptr Entry) (call make (int 3)))`）。
   * 记成一格计数（不是布尔）：`try try f()` 与嵌在实参里的那几层都不会互相抹掉。
   */
  const ecOff = { n: 0 };
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
  /* ─── `variant_t` 那一族（第一百一十三刀）：那格结构体是**合成**出来的（源码里没有它的     声明），所以"它有哪几格字段"与"装/拆的壳"都由这一层给，家在 `runtime.js` 那一份。 */
  const VAR_TY = { k: 'struct', name: VARIANT };
  /** 一格值装进 variant 时落哪一种（`null` = 这一层还不收）。 */
  const varKind = (t) => {
    if (t === null || t === undefined) return null;
    if (t.k === 'int' || t.k === 'enum') return 'i';
    if (t.k === 'real') return 'r';
    if (t.k === 'bool') return 'b';
    if (t.k === 'string') return 's';
    return null;
  };
  /** 壳一份模块只发一次；答的是那个名字（拼调用点用）。 */
  const varShellOnce = (name, text) => {
    if (!helperBox.has(name) && text !== null) { helperBox.add(name); helpers.push(text); }
    return name;
  };
  /**
   * **格式化字面量 `$"…"`**（第二百刀，literals.rst:62）：它产出的是**一格字符串的值**
   * （不是一次输出），所以整条落成一串 `(bin "+" …)`。词法把整个字面量当**一个记号**，
   * 里头 `$名字` / `$(表达式)` 那几段于是要按位置**再解析一遍**（`parseExpr`）。
   *
   * 一格注入怎么变成串按它的类型走（与 printf 那张表同一口径）：串原样、整数 `tostr`、
   * 实数 `sfix … 6`（C 的 `%f` 默认六位）、布尔按 1/0。
   *
   * `%…` 那两族（`%1` 按序号引实参、`%05d` 光写 spec）与 `$(…; spec)`（宽度/精度）
   * **明说不收** —— 那要把 printf 那套 spec 机器接上来，是另一刀。
   */
  const fmtOf = (node) => {
    const tok = named(node)?.text;
    const raw = String(tok?.value ?? '');
    if (!raw.startsWith('$"') || !raw.endsWith('"') || raw.length < 3) {
      acct('格式化字面量的记号读不出来'); return null;
    }
    if (parseExpr === null) {
      acct('格式化字面量 `$"…"`（这一趟没有再解析一遍的入口）'); return null;
    }
    const file = tok?.span?.file ?? null;
    const base = (tok?.span?.start ?? 0) + 2;
    const inner = raw.slice(2, -1);
    const parts = [];
    let lit = '';
    const flushLit = () => { if (lit !== '') { parts.push(`(str "${lit}")`); lit = ''; } };
    const strOf = (v) => {
      const k = v.type?.k;
      if (k === 'string') return v.code;
      if (k === 'int' || k === 'enum') return `(tostr ${v.code})`;
      if (k === 'real') return `(sfix ${v.code} (int 6))`;
      if (k === 'bool') return `(tostr (sel ${v.code} (int 1) (int 0)))`;
      return null;
    };
    const inject = (src, off) => {
      const t = parseExpr(file, src, base + off);
      if (t === null) { acct(`格式化字面量里 '${src}' 解不出来`); return false; }
      const v = emitExpr(t, null, ctxRef);
      if (v === null) return false;                       // 账已经记过
      const s = strOf(v);
      if (s === null) { acct(`格式化字面量里那一格是 ${v.type?.k ?? '?'}（还没接）`); return false; }
      flushLit();
      parts.push(s);
      return true;
    };
    let i = 0;
    while (i < inner.length) {
      const c = inner[i];
      if (c === '\\' && i + 1 < inner.length) { lit += inner.slice(i, i + 2); i += 2; continue; }
      if (c === '%') {
        acct('格式化字面量里的 `%…`（按序号引实参 / 光写 spec）还没接'); return null;
      }
      if (c !== '$') { lit += c; i += 1; continue; }
      if (inner[i + 1] === '$') { lit += '$'; i += 2; continue; }
      if (inner[i + 1] === '(') {
        let depth = 0;
        let j = i + 1;
        for (; j < inner.length; j += 1) {
          if (inner[j] === '(') depth += 1;
          else if (inner[j] === ')') { depth -= 1; if (depth === 0) break; }
        }
        if (depth !== 0) { acct('格式化字面量里 `$(` 没配上 `)`'); return null; }
        const body = inner.slice(i + 2, j);
        if (body.includes(';')) {
          acct('格式化字面量里 `$(…; spec)`（宽度/精度）还没接'); return null;
        }
        if (!inject(body, i + 2)) return null;
        i = j + 1;
        continue;
      }
      const m = /^[A-Za-z_][\w$]*(\.[A-Za-z_][\w$]*)*/.exec(inner.slice(i + 1));
      if (m === null) { acct('格式化字面量里 `$` 后面不是名字也不是 `(`'); return null; }
      if (!inject(m[0], i + 1)) return null;
      i += 1 + m[0].length;
    }
    flushLit();
    if (parts.length === 0) return { code: '(str "")', type: T.string };
    return { code: parts.reduce((a, b) => `(bin "+" ${a} ${b})`), type: T.string };
  };
  const fieldsOf = (aggName) => {
    /* variant 那四格字段由这一层给 —— "按值抄一份"走的就是它们（105-variant.jnc 的
       `Entry p2 = p1` 与 `dispatch(variant_t in, …)` 那格按值形参）。 */
    if (aggName === VARIANT) return VARIANT_FIELDS;
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
  /** 长度从花括号里数出来的那几格（名字 → 定下来的类型）—— 查名那一层用它，不再解一遍声明。 */
  const forced = new Map();
  /** 体这一层要的模块级槽（`once` 的旗子、`static` 局部量那一格）—— 模块那一层照单发。 */
  const slots = [];
  /** 体这一层**抬出去的那几格函数**（造对象那三句 —— `new` 是一格表达式，装不下三句）。 */
  const helpers = [];
  /**
   * **造一格类的对象**（第五十二 / 五十七刀）：`(pnew (ptr 根) (int 1))` + 写死 `$tag` +
   * （有的话）调 construct —— **三句**，而 `new C` / `C c;` 都是一格表达式/一格初值，
   * 所以照旧降那条路把这三句抬成一个函数。
   *
   * 拦住的那几格都明说（绝不悄悄交出一段没构造好的内存）：
   *   - 有基类的（基类的构造要逐格调，第九十四刀）；
   *   - 字段写了初值的（那几句要插到 construct 开头，第七十八刀）；
   *   - construct 要实参的（实参得当helper 的形参传进去 —— 另一刀）。
   */
  const newObj = (cls, argNodes = []) => {
    const root = clsRoot(cls);
    const tag = tags.get(cls);
    if (tag === undefined) { acct(`'${cls}' 没有动态类型标签（类体没解出来）`); return null; }
    const ctorBase = `${cls}$construct`;
    let ctorKey = ctorBase;
    let ctor = methods.get(ctorBase);
    /* **构造也能重载**（`construct()` / `construct(int)` / `construct(int,int)`，139-ctoroverload.jnc）：
       同名那一族按实参挑一格 —— 与普通调用走的是同一格 `pickOvl`。挑不出来它自己记账。 */
    if (ctor !== undefined) {
      const p0 = pickOvl(ctorBase, ctor, argNodes ?? []);
      if (p0 === null) return null;
      ctor = p0.sig;
      ctorKey = p0.key;
    }
    /* **字段写了初值那几格是构造干的活**（第七十八刀）：所以构造非在不可 —— 合成那一步没成时
       这儿明说不收，绝不交出一段没初始化过的内存。 */
    if (fieldInits.has(cls) && ctor === undefined) {
      acct(`造 '${cls}'：它的字段写了初值，可它没有构造（合成那一步没成）`); return null;
    }
    /**
     * **`new C(1)` 那几格实参**：`new` 是一格表达式而造一格对象是三句，所以三句抬成了
     * 一格 helper —— 实参于是变成**helper 的形参**（`$i0`、`$i1`…），在调 `construct`
     * 那一句里原样递下去。这是旧降级的真输出（167-staticfield.jnc 的 `$newo0`）。
     *
     * **construct 的默认实参**（第一百七十五刀）：形参写了初值（`construct(int step = 1)`）
     * 而调用方给的实参不够时按默认的补 —— 与普通函数那一条是同一件事。
     */
    /* **空槽**（`new C(1, , 3)`，第八十八刀）：那一格与"末尾少给"是同一件事 —— 记成 null，
       下面按默认值补。 */
    const args = (argNodes ?? []).map((a) => (headOf(a) === 'unbound' ? null : a));
    const ps = ctor?.params ?? [];
    const defs = ctor?.defaults ?? [];
    if (args.length > ps.length) {
      acct(`造 '${cls}'：给了 ${args.length} 个实参，可 construct 只收 ${ps.length} 个`); return null;
    }
    {
      /* 空着的那几格（末尾少给的、写成空槽的）有默认值吗 —— 有就按默认的补，没有才报。 */
      let bad = false;
      for (let i = 0; i < ps.length; i += 1) {
        if (i < args.length && args[i] !== null) continue;
        if (defs[i] === null || defs[i] === undefined) {
          acct(`造 '${cls}'：construct 要 ${ps.length} 个实参，给了 ${args.length}（第 ${i + 1} 格没有默认值）`);
          bad = true; break;
        }
      }
      if (bad) return null;
    }
    const vals = [];
    const formals = [];
    for (let i = 0; i < ps.length; i += 1) {
      const rp = resolveType(ps[i], env);
      if (rp.type === null) { acct(`造 '${cls}'：construct 的第 ${i + 1} 格形参：${rp.why}`); return null; }
      /* 空着的那几格按**默认实参**补（上头已经查过它们都有默认值）。 */
      const a = i < args.length && args[i] !== null ? args[i] : defs[i];
      const v = emitExpr(a, withBits(rp.type, ps[i]), ctxRef);
      if (v === null) return null;                         // 账已经记过
      vals.push(v.code);
      formals.push(`($i${i} ${emitType(rp.type, 'slot', tyc)})`);
    }
    const ty = `(ptr ${root})`;
    const fn = `$newo${tmpBox.n}`;
    tmpBox.n += 1;
    const lines = [
      `  (fn ${fn} (${formals.join(' ')}) ${ty}`,
      '    (do',
      `      (let $p ${ty} (pnew ${ty} (int 1)))`,
      `      (pstore (pfield (var $p) $tag) (int ${tag}))`,
    ];
    if (ctor !== undefined) {
      const pass = formals.map((_, i) => ` (var $i${i})`).join('');
      lines.push(`      (expr (call ${ctor.emit ?? ctorKey} (var $p)${pass}))`);
    }
    lines.push('      (ret (var $p))))');
    helpers.push(lines.join('\n'));
    const pass2 = vals.map((v) => ` ${v}`).join('');
    return { code: `(call ${fn}${pass2})`, type: { k: 'class', name: cls } };
  };
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
  /** 方法体里 `this` 那一格的类型（类是一条引用，结构体是"那段内存的地址"）。 */
  const selfType = () => (self === null ? null
    : (self.kind === 'class' ? { k: 'class', name: self.agg } : { k: 'struct', name: self.agg }));
  /**
   * **`basetype` / `basetype1` / `basetype2` 说的是哪一格基类**（type_class.rst:226：前两个
   * 是同一格）。这一层只答"哪个类"—— 而**一整条继承链共用一格方言结构体**（第五十六刀），
   * 所以换到基类那一面**发零条指令**：`$this` 原样递下去，只是调的函数换成基类那一个。
   */
  const baseAt = (idxNode) => {
    if (self === null) { acct('`basetype` 不在方法体里'); return null; }
    const n0 = Number.parseInt(String(idxNode?.value ?? '1'), 10);
    const i = Number.isFinite(n0) && n0 >= 1 ? n0 : 1;
    const list = aggBases.get(self.agg) ?? [];
    const b = list[i - 1];
    if (b === undefined) { acct(`'${self.agg}' 没有第 ${i} 格基类，可这儿写了 basetype`); return null; }
    return b;
  };
  /**
   * **一格查着了的变量落成什么形状**（`lvalueShape` 那三条）。两处用它：裸名字那一路、
   * 以及 `a.g`（命名空间里的模块级量，第五十一刀）—— 同一格量，不该有两个答案。
   */
  const varPlace = (key, t, isG) => {
    /* **长度是从花括号里数出来的那一格**（`int b[] = { 7, 8 };`）：声明上压根没有长度，
       所以查名这一层要用**定下来的那一格类型**，不能再解一遍声明（解出来是"长度不是字面量"）。 */
    const r = forced.has(key) ? { type: forced.get(key), why: null } : resolveType(t, env);
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
  };
  /**
   * 一串**点**摊成方言那一侧的名字（`a.g` → `a$g`）。摊不动（里头不是纯名字）答 null。
   */
  const dottedFlat = (node) => {
    const h = headOf(node);
    if (h === 'name') return String(named(node)?.text?.value ?? '') || null;
    if (h !== 'field') return null;
    const f = named(node) ?? {};
    const left = dottedFlat(f.obj);
    const seg = String(f.name?.value ?? '');
    if (left === null || seg === '') return null;
    return `${left}$${seg}`;
  };
  /**
   * **一对花括号的初值**（`{ 10, 20, 30 }`）：按格子写。数组逐格、结构体逐字段；写少了的
   * 那几格保持零（那段内存是 pnew 出来的、本来就是零 —— C 与 jancy 都是这条）。
   * 嵌套的花括号跟着往里走。拼不出来答 null（账在这一层记）。
   */
  const curlyLines = (dst, type, node, pad) => {
    const all = allInChain(named(node)?.items, 'items-add', 'items');
    /* **末尾那个逗号不算一格**（`{ 1, 2, }`）：链上会多出一格**空占位**（一格没有内容的
       list）—— 数长度那一头（`arrayFromCurly` 的 `chainCount`）数的就是"真有值的项数"，
       两边得一样。中间那种空项（`{ 1, , 3 }` —— 保留原值）另算，走到就记账。 */
    const has = (x) => {
      if (x === null || x === undefined) return false;
      if (!Array.isArray(x.items)) return true;                        // 一格记号
      return x.items.length > 1;                                      // 空占位的 list 不算
    };
    let last = -1;
    for (const [i, it] of all.entries()) if (has(it)) last = i;
    const items = all.slice(0, last + 1);
    const one = (at, ty, it) => {
      if (it === null || it === undefined) { acct('花括号里有一格空项（保持原值那一族）还没接'); return null; }
      if (headOf(it) === 'curly') return curlyLines(at, ty, it, pad);
      const v = emitExpr(it, ty, ctxRef);
      if (v === null) return null;                          // 账已经记过
      return [`${pad}(pstore ${at} ${v.code})`];
    };
    const out = [];
    if (type?.k === 'arr') {
      if (items.length > type.n) {
        acct(`花括号里给了 ${items.length} 格，可那一格数组只有 ${type.n} 格`); return null;
      }
      const b0 = `(pelem ${dst})`;
      for (const [i, it] of items.entries()) {
        const ls = one(i === 0 ? b0 : `(padd ${b0} (int ${i}))`, type.el, it);
        if (ls === null) return null;
        out.push(...ls);
      }
      return out;
    }
    if (type?.k === 'struct') {
      const fs = fieldsOf(type.name);
      if (fs === null) { acct(`花括号：'${type.name}' 的字段表还没有`); return null; }
      if (items.length > fs.length) {
        acct(`花括号里给了 ${items.length} 格，可 '${type.name}' 只有 ${fs.length} 格字段`); return null;
      }
      for (const [i, it] of items.entries()) {
        const ls = one(`(pfield ${dst} ${fs[i].name})`, fs[i].type, it);
        if (ls === null) return null;
        out.push(...ls);
      }
      return out;
    }
    acct(`花括号初值落在 ${type?.k ?? '?'} 上（那不是一整块）`);
    return null;
  };
  /** 一格可写位置读出来那一段文字（`SHAPE_ACCESS`）。属性那一格的 `args` 是 `this` 那一半。 */
  const readLv = (lv) => SHAPE_ACCESS[lv.shape].read(lv.code, lv.args);
  /**
   * 一格可写位置**写进去**那一句（`SHAPE_ACCESS`）。写不下来答 null（账在这一层记）——
   * 三处（赋值、复合赋值、`++`）问的是同一件事，所以只有一份。
   */
  const writeLv = (lv, v) => {
    if (lv.shape === 'agg') { acct('往结构体/数组里赋值要逐字段抄一份（还没接）'); return null; }
    if (lv.shape === 'prop' && lv.hasSet === false) {
      acct(`属性 '${lv.propName ?? '?'}' 没有存值器（const 属性 —— 写不下去）`); return null;
    }
    /* 存值器写着 `errorcode` 的那一格（`operator []` 那一族）：写这一句要顺带把错往上传，
       而这儿只发一整句 —— 明说不收（吞掉那个词就等于调用点再也不检查错误码了）。 */
    if (lv.ecSet === true) {
      acct(`'${lv.propName ?? '?'}' 的存值器是 errorcode（传播那两句插不进这一句写）还没接`); return null;
    }
    return SHAPE_ACCESS[lv.shape].write(lv.code, v, lv.args);
  };
  /**
   * **静态字段那一格的位置**（第二百一十五刀）：它不在对象里 —— 就是"类那一层上的模块级量"，
   * 方言那一侧的名字是 `东家$名字`。所以形状按模块级那一套算（`lvalueShape` 的 isGlobal）。
   */
  const staticPlace = (st) => {
    const r = resolveType(st.type, env);
    if (r.type === null) { acct(`静态字段 '${st.name}'：${r.why}`); return null; }
    const ty = withBits(r.type, st.type);
    /* 取过地址的那一格要提成 `(ptr T)`（模块级那一半是第二十四刀）—— 还没接，明说。 */
    if (gLifted.has(st.name)) {
      acct(`静态字段 '${st.name}' 被取过地址（要提成一格 (ptr T)）还没接`); return null;
    }
    const shape = lvalueShape({
      isStruct: ty.k === 'struct', isArr: ty.k === 'arr', isGlobal: true, gLifted: false, lifted: false,
    });
    return { shape, code: shape === 'var' ? st.emit : `(var ${st.emit})`, type: ty };
  };
  /**
   * **成员属性那一格的位置**（第六十九刀）：读是 `(call 东家$属性$get $this)`、写是
   * `(call 东家$属性$set $this 值)`。`self` 是那一格对象的地址（`x.p` 里是 x，裸写时是 `$this`）。
   *
   * **取值器真发出来了才认**：完整声明式（`property { … }`）与 `autoget` / `bindable`
   * 那几族的取/存是**生成**出来的，这一层还没发 —— 那时候答 null（记账），绝不发一句
   * 调用去叫一个不存在的函数。
   */
  const propPlace = (pr, selfCode) => {
    const hasFn = (n) => methods.has(n) || fns.has(n);
    const g = `${pr.emit}$get`;
    if (!hasFn(g)) {
      acct(`属性 '${pr.name}' 的取值器还没发出来（autoget / bindable / 反应器那几族另算）`);
      return null;
    }
    /**
     * **属性那一格的类型**：写在声明上的优先（`int property m_value;`）；写不出来的那种
     * （`property m_doubled { int get() {…} }` —— 类型在**取值器**上，prop_full.rst:15）
     * 就听取值器回的那一格。两条都不成才记账。
     */
    const mg = methods.get(g) ?? fns.get(g);
    const r = resolveType({ ...pr.type, shape: 'data' }, env);
    let ty = r.type === null ? null : withBits(r.type, pr.type);
    if (ty === null && mg.ret !== null && mg.ret !== undefined) ty = withBits(mg.ret, mg.retDecl);
    if (ty === null) { acct(`属性 '${pr.name}'：${r.why}`); return null; }
    return {
      shape: 'prop',
      code: pr.emit,
      args: selfCode === null || selfCode === undefined ? [] : [selfCode],
      hasSet: hasFn(`${pr.emit}$set`),
      propName: pr.name,
      type: ty,
    };
  };
  /**
   * **不是普通字段的那几族成员**（`MEMBER_ORDER` / `NAME_LVALUE_ORDER` 里那几条）：今天收
   * 静态字段与成员属性。裸写的名字（方法体里）、`x.m`、`类名.m` 三处问的是**同一份** ——
   * 一格成员是什么，不该有三个答案。
   *
   * 答 `undefined` 是"不是这几族"（调用方接着往下问），答 `null` 是"是这一族可拼不出来"
   * （账已经记过）。
   */
  const memberOther = (selfCode, aggName, key) => {
    const st = aggStatics.get(aggName)?.get(key);
    if (st !== undefined) return staticPlace(st);
    const pr = aggProps.get(aggName)?.get(key);
    if (pr !== undefined) {
      /* 成员属性要一格对象（取/存那两个函数第一个实参是 `this`）—— `类名.属性` 那种写法
         是静态属性那一族，还没接。 */
      if (selfCode === null || selfCode === undefined) {
        acct(`属性 '${pr.name}' 要一格对象（静态属性那一族还没接）`); return null;
      }
      return propPlace(pr, selfCode);
    }
    return undefined;
  };
  /**
   * **一格方法在哪儿**（`findMethod`）：今天**只看自己那一格**。
   *
   * 沿基类链往上找那一半**明说还不接**：量过 —— 基类上的同名方法有三种不同的落法
   * （体在基类里发一格 `B$step`、只有原型而体写在别处、以及**虚方法**要走派发表 `$$vd$`），
   * 光按名字往上找会把后两种静静地调错（78-notype.jnc 报"未声明的函数 B$step"、
   * 86-multibase.jnc 印出来的数变了）。所以这一层照旧答"查不着"，把账留着。
   */
  const findMethod = (aggName, mname) => {
    const key = `${aggName}$${mname}`;
    const hit = methods.get(key);
    if (hit !== undefined) return callable(aggName, mname, { sig: hit, key });
    /* **体里的 `alias`**（`alias twice = doubled;`，192-unionalias.jnc）：先解一跳再照旧查
       —— 它没有存储、没有类型，只是"这个名字指着谁"。 */
    const al = aggAliases.get(aggName)?.get(mname);
    if (al !== undefined) return findMethod(aggName, al);
    /* **体外写的方法**（`void Counter.reset(int step) { … }`，49-class.jnc）：它的名字是点串，
       登记在**函数**那张表里，而方言那一侧的名字与体里写的一模一样（`Counter$reset`）——
       所以这儿顺手问一次那张表。基类那一问（`basecall`）先前就是这么办的，两处同一条。 */
    const out = fns.get(key);
    if (out !== undefined) return { sig: out, key };
    /**
     * **沿基类链往上找**（78-notype.jnc / 86-multibase.jnc / 62-opaque.jnc）：类那一族
     * **一整条继承链只发一格 struct**（第五十六刀），所以基类的方法拿派生类那一格 `this`
     * 调是对的 —— 名字与 `$this` 的类型两头都对得上。
     *
     * 三样明说不收，各有出处：
     *   - **虚方法**（`virtual` / `override` / `abstract`）：那要走派发表 `$$vd$`，
     *     一句 `(call B$step …)` 会把派发静静地绕过去（54-virtual.jnc）；
     *   - 链上**同名撞车**（两格基类各有一格同名方法）：按名字挑是猜；
     *   - 查不着的照旧答 null（调用方记账）。
     * 走法是按声明次序的广度优先（与并字段那一处同一口径：第一格基类先）。
     */
    const seen = new Set([aggName]);
    const queue = [...(aggBases.get(aggName) ?? [])];
    const hits = [];
    while (queue.length > 0) {
      const b = queue.shift();
      if (seen.has(b)) continue;
      seen.add(b);
      const k2 = `${b}$${mname}`;
      const h2 = methods.get(k2) ?? fns.get(k2);
      if (h2 !== undefined) hits.push({ sig: h2, key: k2 });
      else queue.push(...(aggBases.get(b) ?? []));
    }
    if (hits.length !== 1) return null;                    // 一格都没有，或撞车了（不猜）
    return callable(aggName, mname, hits[0]);
  };
  /**
   * **查着的那一格能不能"一句直调"**（两条界，`null` = 非走派发表不可）：
   *   1. **虚方法而底下真有人覆盖它**：那时派发表里那一格不是常量（78-notype.jnc 的
   *      `B* b = d; b.show();` 该印 D 那一行）。没人覆盖的话表里永远指着同一个函数 ——
   *      一句 `(call B$put …)` 与查表跑出来的是同一件事，那一格照旧直调；
   *   2. **只写了原型、体不在这份模块里**（`abstract` / 接口那一族）：一句 `(call B$step …)`
   *      指着的是谁也没发过的函数（量出来就是"未声明的函数 'B$step'"）。体写在类外的那种
   *      **算有体** —— 它登记在函数表里。
   * 判据里"底下"指的是**接收方那个静态类型**的派生类：能装进它的只有它们。跨文件的派生类
   * 看不见 —— 那一族在"跨文件/宿主面"那笔账里。
   */
  const callable = (aggName, mname, found) => {
    const needsVd = (found.sig.virt === true && overriddenBelow(aggName, mname))
      || (found.sig.hasBody !== true && !fns.has(found.key));
    if (!needsVd) return found;
    /* **真要派发的那一格走分派函数**（`B$$vd$show`，第五十七刀）：签名听**声明那一格**的
       （形参、返回都一样），只是被调的名字换成那一个 —— 发码那一头读的是 `sig.emit`，
       所以要连它一起换（不然发出来还是 `(call B$step …)`）。表里没有那一格才记账。 */
    const vd = vdispatch.get(`${aggName}$${mname}`);
    return vd === undefined ? null : { sig: { ...found.sig, emit: vd }, key: vd };
  };
  /**
   * **不发一个字就问得出来的那几种类型**（第五十八刀 B，135-overloadcheap.jnc 顶上那段）。
   *
   * 同元重载要按各实参的类型挑，而"降一遍再看类型"在这一处使不得 —— 降会造临时、会插语句、
   * 会把 errorcode 那两句提上来，而这一步只是**问**。所以这一格只回**纯查表**问得准的那几种，
   * 别的答 null（挑那一层照实说不收）。整数**字面量**另标一格 `lit`：jancy 对常量的
   * int → int 加宽算 `Identity`，于是 `p(int)` / `p(long)` 喂 `1` 在它那儿就是 ambiguous ——
   * 这一层因此一律不给字面量"完全一样"那一档（见 `argCost`）。
   */
  const cheapTy = (n) => {
    if (n === null || n === undefined || typeof n !== 'object') return null;
    if (!Array.isArray(n.items)) {
      if (n.kind === 'string') return { ty: T.string, lit: true };
      const s = String(n.value ?? '');
      if (/^(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|[0-9]+)$/.test(s)) return { ty: T.int, lit: true };
      if (/^[0-9]+(\.[0-9]*([eE][+-]?[0-9]+)?|[eE][+-]?[0-9]+)$/.test(s)) return { ty: T.real, lit: true };
      return null;
    }
    const h = headOf(n);
    const nm2 = named(n) ?? {};
    if (h === 'paren') return cheapTy(nm2.inner);
    if (h === 'true' || h === 'false') return { ty: T.bool, lit: true };
    /* `'a'` 是一个**整数**字面量（第九十七刀）—— 与 `65` 同一档。 */
    if (h === 'char') return { ty: T.int, lit: true };
    /* `$"…"` 出来的是一格**动态**的串（literals.rst:62）：类型是 string，可不算字面量那一档
       （那一格只对整数之间那条有意思）。贴着写的拼接同一件事。 */
    if (h === 'fmt' || h === 'concat') return { ty: T.string, lit: false };
    if (h === 'unary') {
      const op = String(nm2.op?.value ?? '');
      if (op === '!') return { ty: T.bool, lit: false };
      if (op !== '-' && op !== '+' && op !== '~') return null;
      const b = cheapTy(nm2.a);
      if (b === null || !(b.ty.k === 'int' || b.ty.k === 'real')) return null;
      if (op === '~' && b.ty.k === 'real') return null;
      return b;
    }
    /* `&x`：取地址不改"那一格是什么类型"这件事 —— 出来的是 `T*`。 */
    if (h === 'addr') {
      const b = cheapTy(nm2.a);
      return b === null || b.lit ? null : { ty: { k: 'ptr', target: b.ty }, lit: false };
    }
    if (h === 'new') {
      const t0 = readAnonType(named(nm2.type)?.specs, named(nm2.type)?.ptrs);
      if (t0 === null || headOf(nm2.type) !== 'type-name') return null;
      const r0 = resolveType(t0, env);
      if (r0.type === null || r0.type.k === 'void') return null;
      return { ty: { k: 'ptr', target: r0.type }, lit: false };
    }
    return cheapTy2(n, h, nm2);
  };
  /** `cheapTy` 的后一半：名字、取字段、调用那三格（要查那几张表）。 */
  const cheapTy2 = (n, h, nm2) => {
    if (h === 'name' || h === 'field' || h === 'ptr-field') {
      /* 枚举项（`Code.Sync`）与折叠过的 `const`：`constOrFn` 只查表、不发一个字。 */
      const cv = constOrFn(n);
      if (cv !== null && cv !== undefined && cv.type !== undefined) return { ty: cv.type, lit: false };
    }
    if (h === 'name') {
      const key = String(nm2.text?.value ?? '');
      const t = names.get(key) ?? globals.get(key);
      if (t !== undefined) {
        const r = resolveType(t, env);
        return r.type === null ? null : { ty: withBits(r.type, t), lit: false };
      }
      /* 方法体里**裸写**的字段（`m_len` 就是 `this.m_len`）。 */
      const ft = self === null ? undefined : aggFields.get(self.agg)?.get(key);
      if (ft === undefined) return null;
      const r2 = resolveType(ft, env);
      return r2.type === null ? null : { ty: withBits(r2.type, ft), lit: false };
    }
    if (h === 'field' || h === 'ptr-field') {
      const ob = cheapTy(nm2.obj);
      if (ob === null) return null;
      const b = ob.ty.k === 'ptr' ? ob.ty.target : ob.ty;
      const agg = b !== null && b !== undefined && (b.k === 'struct' || b.k === 'class') ? b.name : null;
      const fname = String(nm2.name?.value ?? '');
      const ft = agg === null ? undefined : aggFields.get(agg)?.get(fname);
      if (ft === undefined) return null;
      const r = resolveType(ft, env);
      return r.type === null ? null : { ty: withBits(r.type, ft), lit: false };
    }
    /* 调用：被调是个裸名字、又**不是重载**（那要先挑一格）时，这一格的类型就是它的返回类型。 */
    if (h === 'call') {
      const f = nm2.fn;
      if (f === null || f === undefined || !Array.isArray(f.items) || headOf(f) !== 'name') return null;
      const key = String(named(f)?.text?.value ?? '');
      if (names.has(key) || globals.has(key) || (ovl.get(key)?.length ?? 0) > 1) return null;
      const s = fns.get(key);
      if (s === undefined || s.ret === null || s.ret === undefined) return null;
      return { ty: withBits(s.ret, s.retDecl), lit: false };
    }
    return null;
  };
  /**
   * **一格实参配一格形参有多合得上**（第五十八刀 B）：照 jancy 的 CastKind 排的一张表，
   * 0 = 合不上（引擎那一层 `pick` 见 0 就跳过这一条）。行与旧降级的 `JNC_CASTS` 同一份：
   *   - int 之间：两个方向 jancy 都是 Implicit —— 字面量一律 3（不给"完全一样"那一档，
   *     不然 `p(int)` / `p(long)` 喂 `1` 会各得一分而分不出来，jancy 那边也正是 ambiguous）；
   *   - 完全一样 4；类的**上转** 3（一条链共用一格方言结构体，发零条指令）；
   *   - `int -> real` / `bool -> int` / `枚举 -> int` 各 1（跨族）；
   *   - `T* -> void*` 与 `枚举 -> 基枚举`：jancy 收，可这一层给 0 —— 与旧降级同一格数。
   */
  const sameTy2 = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined
    && tyKey(a) === tyKey(b);
  const argCost = (from, to, lit) => {
    if (from === null || from === undefined || to === null || to === undefined) return 0;
    if (from.k === 'int' && to.k === 'int') return lit === true ? 3 : (sameTy2(from, to) ? 4 : 3);
    /* **类那一族先归一**：`D* dp` 解出来是 `class:D`（类自己吞掉那一个 `*`），而 `new D` 那一格
       问出来的是 `ptr(class:D)` —— 两种写法说的是同一件事，所以比之前先把那层壳摘掉。 */
    const cls = (t) => (t.k === 'class' ? t
      : (t.k === 'ptr' && t.target?.k === 'class' ? t.target : null));
    const fc = cls(from);
    const tc2 = cls(to);
    if (fc !== null && tc2 !== null) {
      if (fc.name === tc2.name) return 4;
      return derivesFrom(fc.name, tc2.name) ? 3 : 0;     // 上转收，下转要类型信息（不收）
    }
    if (sameTy2(from, to)) return 4;
    if (to.k === 'real' && from.k === 'int') return 1;
    if (to.k === 'int' && from.k === 'bool') return 1;
    if (to.k === 'int' && from.k === 'enum') return 1;
    return 0;
  };
  /**
   * **同名那一族里挑一格**（第五十八刀，76-overload.jnc / 77-overload-types.jnc）。两步：
   *
   *   1. 按**给了几个实参**筛：一格候选收得下的个数是 `[形参数 - 有默认值的格数, 形参数]`；
   *   2. 剩下不止一条时按**实参的类型**排（`cheapTy` / `argCost`）：每条候选取各实参里
   *      **最差**的那一档当它的分、取最高分、并列即歧义 —— "怎么挑"这一句是引擎的
   *      （`frontend-engine/overload.js`），打分才是这门语言的。
   *
   * 哪个实参的类型问不出来、或者平手，**明说不收**，不猜。
   * 挑这一步排在**求实参**之前：形参的类型要拿去降实参（`null` 从那儿知道自己是哪种指针）。
   */
  const sigAt = (k) => methods.get(k) ?? fns.get(k);
  const pickOvl = (key0, sig0, args) => {
    const fam = ovl.get(key0);
    if (fam === undefined || fam.length < 2) return { sig: sig0, key: key0 };
    const real = args.filter((a) => headOf(a) !== 'unbound');
    const given = real.length;
    const fits = [];
    for (const e of fam) {
      const s = sigAt(e.key);
      if (s === undefined) continue;
      const want = (s.params ?? []).length;
      const opt = (s.defaults ?? []).filter((d) => d !== null).length;
      if (given >= want - opt && given <= want) fits.push({ sig: s, key: e.key });
    }
    if (fits.length === 1) return fits[0];
    if (fits.length === 0) {
      acct(`'${key0}' 有 ${fam.length} 条重载，没有一条收 ${given} 个实参`);
      return null;
    }
    const tys = real.map((a) => cheapTy(a));
    const bad = tys.findIndex((t) => t === null);
    if (bad >= 0) {
      acct(`'${key0}' 的同元重载：第 ${bad + 1} 个实参的类型这一层还得先降一遍才知道`);
      return null;
    }
    const { best, tie } = pick(fits, (c) => worst(
      tys.length,
      (i) => {
        const pt = (c.sig.params ?? [])[i] ?? null;
        const pr = pt === null ? null : resolveType(pt, env);
        const want = pr === null || pr.type === null ? null : withBits(pr.type, pt);
        return argCost(tys[i].ty, want, tys[i].lit);
      },
    ));
    if (best === null) {
      acct(`'${key0}' 的 ${fits.length} 条重载没有一条收得下这几个实参`);
      return null;
    }
    if (tie) {
      acct(`'${key0}' 的同元重载在这一句上分不出来（两条一样合得上 —— jancy 那边这也是歧义）`);
      return null;
    }
    return best;
  };
  /** `sub` 的基类链里有 `base` 吗（含多层、多基类）。 */
  const derivesFrom = (sub, base) => {
    const seen2 = new Set();
    const q2 = [...(aggBases.get(sub) ?? [])];
    while (q2.length > 0) {
      const b = q2.shift();
      if (b === base) return true;
      if (seen2.has(b)) continue;
      seen2.add(b);
      q2.push(...(aggBases.get(b) ?? []));
    }
    return false;
  };
  /** 这个模块里有没有 `agg` 的派生类覆盖了同名的方法（虚派发那一问的判据）。 */
  const overriddenBelow = (agg, mname) => {
    for (const mi of methods.values()) {
      if (mi.name !== mname || mi.owner === undefined || mi.owner === agg) continue;
      if (derivesFrom(mi.owner, agg)) return true;
    }
    return false;
  };
  /**
   * **这个名字在那格聚合体上是"装着函数指针的字段"吗**（`Fn* m_op;`）。
   * jancy 里方法与字段在同一个命名空间，所以两处查名都要问它一句：查不着方法时那一格还
   * 可能是"读出这个字段、按函数值调"（`s.m_op(…)` 与方法体里裸写 `m_op(…)` 是同一件事）。
   */
  const fnptrField = (aggName, key) => {
    const ft = aggFields.get(aggName)?.get(key);
    if (ft === undefined) return false;
    return resolveType(ft, env).type?.k === 'fnptr';
  };
  /**
   * **方法当值用**（`c.bump`，第五十五刀）：jancy 的函数指针是**胖的** —— 里头捕着那个对象。
   * 方言那一侧是"一格闭包壳 + 一次 mkclo"：
   *   壳 `(cfn <方法>$clo (($self (ptr 根))) (形参…) 返回 (ret (call <方法> (cap $self) 形参…)))`，
   *   一份模块只发一格（`helperBox` 去重）；用点是 `(mkclo <方法>$clo <那个对象>)`。
   * 形状按 `agg` 记：**只读、code 就是值**（与结构体那一格同一条读法，写那一侧本来就没有）。
   * 静态方法没有 `this`，那一族另算（照旧答 undefined，调用方接着往下问）。
   */
  const methodValue = (baseCode, aggName, mname) => {
    const found = findMethod(aggName, mname);
    if (found === null || found.sig.stat === true) return undefined;
    const ps = [];
    for (const p of found.sig.params ?? []) {
      const rp = p === null ? null : resolveType(p, env);
      if (rp === null || rp.type === null) return undefined;
      ps.push(withBits(rp.type, p));
    }
    const rt = found.sig.ret === null ? { k: 'void' } : withBits(found.sig.ret, found.sig.retDecl);
    const clo = `${found.key}$clo`;
    if (!helperBox.has(clo)) {
      helperBox.add(clo);
      const formals = ps.map((t2, i) => `($a${i} ${emitType(t2, 'slot', tyc)})`).join(' ');
      const args = ps.map((x, i) => ` (var $a${i})`).join('');
      const inner = `(call ${found.key} (cap $self)${args})`;
      helpers.push([
        `  (cfn ${clo} (($self (ptr ${clsRoot(aggName)}))) (${formals}) ${emitType(rt, 'value', tyc)}`,
        `    ${rt.k === 'void' ? `(expr ${inner})` : `(ret ${inner})`})`,
      ].join('\n'));
    }
    return {
      shape: 'agg',
      code: `(mkclo ${clo} ${baseCode})`,
      type: { k: 'fnptr', params: ps, ret: rt },
    };
  };
  /** 一格字段的位置（`memberOf`）：`(pfield 基 名)`；字段自己是结构体/数组时它又是一格 `agg`。 */
  const memberAt = (baseCode, aggName, fname) => {
    const fs = aggFields.get(aggName);
    if (fs === undefined) { acct(`'${aggName}' 的字段表还没有（跨文件/宿主面/泛型）`); return null; }
    const ft = fs.get(fname);
    if (ft === undefined) {
      /* **体里的 `alias`**（`alias x = m_v;`）：先解一跳再照旧查（与查方法那一处同一条）。 */
      const al2 = aggAliases.get(aggName)?.get(fname);
      if (al2 !== undefined) return memberAt(baseCode, aggName, al2);
      /**
       * **union 里套的匿名 struct 那几格**（第一百〇四刀的"字段路径"）：`h.m_a` 在方言那一侧
       * 是一串取字段 `(pfield (pfield 基 $s0) m_a)` —— 一格名字对着一条**路**，不是一格名字。
       * 这一问排在静态字段/属性那几族之前：它是**真字段**，只是路长了一节。
       */
      const p = aggPaths.get(aggName)?.get(fname);
      if (p !== undefined) {
        /* 位域那一格的声明类型自己是 `bitfield` 形状（`resolveType` 对它答"位域"）——
           问的是"**底**那格类型有多宽、带不带符号"，所以先把那个形状摘掉再解。 */
        const rp = resolveType(p.bits === true ? { ...p.type, shape: 'data' } : p.type, env);
        if (rp.type === null) { acct(`字段 '${fname}'：${rp.why}`); return null; }
        const typ = withBits(rp.type, p.type);
        let code = baseCode;
        for (const s of p.steps) code = `(pfield ${code} ${s})`;
        /**
         * **位域那一格**（第一百一十二刀）：路的尽头是那格**存储**（`$b0`），而"哪几位"是这格
         * 位置的一部分 —— 读要移下来再截宽、写是读改写（`SHAPE_ACCESS.bits`）。
         * 读出来那一格的宽度**就是位数**（符号性听声明的那一格），所以窄格的回卷照旧走整数那张表。
         */
        if (p.bits === true) {
          if (typ.k !== 'int') { acct(`位域 '${fname}' 的声明类型不是整数（${typ.k}）`); return null; }
          const u = typ.u === true;
          return {
            shape: 'bits',
            code,
            args: { off: p.off, cnt: p.cnt, u },
            type: { k: 'int', w: p.cnt, u },
          };
        }
        /**
         * **要反字节序那一格**（第一百二十六刀）：位置的文字与普通字段一模一样，只是读出来
         * 与写进去各要把字节倒一遍（`SHAPE_ACCESS.be`）—— 当普通字段接走就把那一步静静地丢了。
         */
        if (p.be === true) {
          if (typ.k !== 'int') { acct(`bigendian 字段 '${fname}' 不是整数（${typ.k}）`); return null; }
          return {
            shape: 'be', code, args: { w: typ.w ?? 32, u: typ.u === true }, type: typ,
          };
        }
        return { shape: memberShape(typ.k === 'struct', typ.k === 'arr'), code, type: typ };
      }
      /* 普通字段里查不着 —— 静态字段与属性那几族在这一问里（`MEMBER_ORDER` 第 4 条）。 */
      const other = memberOther(baseCode, aggName, fname);
      if (other !== undefined) return other;
      /* **方法当值用**（`c.bump`）：方法与字段在同一个命名空间，所以这一问排在最后一格 ——
         前面那几族（真字段、字段路径、静态字段、属性）都不是，才轮到"那是一格方法"。 */
      const mv = methodValue(baseCode, aggName, fname);
      if (mv !== undefined) return mv;
      acct(`'${aggName}' 上查不着字段 '${fname}'（位域/别名/属性/基类那几族另算）`); return null;
    }
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
   * `.` 左边那一格**当基地址**读出来（取字段与叫方法共用一份）：`p->f` 与"左边不是可写形状"
   * （`f().x`）都是**求一次值**；别的先求它的位置再读一次 —— 那一格读出来的就是基地址。
   */
  const objBase = (ob) => {
    if (headOf(ob) === 'ptr-field' || !LV_SHAPES.has(headOf(ob))) {
      const v = emitExpr(ob, null, ctxRef);
      return v === null ? null : { code: v.code, type: v.type };
    }
    const o = lvOf(ob);
    return o === null ? null : { code: readLv(o), type: o.type };
  };
  /**

   * `{ shape: 'var'|'ptr'|'agg', code, type }`。读写都从它出发（`SHAPE_ACCESS`）。
   * 拼不出来答 null（账已经记过）—— 命名空间里那一格、属性、位域那几族都在这一层之外。
   */
  const lvOf = (node) => {
    const h = headOf(node);
    const nm2 = named(node) ?? {};
    if (h === 'paren') return lvOf(nm2.inner);
    /**
     * **`this`**（第五十二刀）：方法体里它就是第一个形参那一格，方言那一侧叫 `$this`，
     * 里头放的是**那个对象那段内存的地址**。所以它与"结构体的名字"同一种形状（`agg`）——
     * `this.m_x` 与裸写 `m_x` 落在同一句 `(pfield (var $this) m_x)` 上。
     */
    if (h === 'this') {
      if (self === null) { acct('`this` 不在方法体里'); return null; }
      return { shape: 'agg', code: '(var $this)', type: selfType() };
    }
    /**
     * **`bindingof(p)`**（第一百一十七刀，prop_bindable.rst:23-29）：`bindable` 的属性除了那格
     * 存储还生成**一格事件** `<属性>$m_onChanged`，而 `bindingof(p)` 说的就是那一格 ——
     * 它是一格**可写位置**（`+= f` 加听众、`= null` 清空），所以在这一层答，不在表达式那一层。
     * 只认"里头是一格属性的名字"这一种形状；别的（不是属性、不是 bindable）照实说不收。
     */
    if (h === 'bindingof') {
      const inner = nm2.arg;
      const key0 = headOf(inner) === 'name' ? String(named(inner)?.text?.value ?? '') : null;
      if (key0 === null) { acct('bindingof 里头不是一格名字'); return null; }
      const ty0 = { k: 'mc', params: [] };
      const gp = gProps.get(key0);
      if (gp !== undefined) {
        if (!(gp.type?.mods ?? []).includes('bindable')) {
          acct(`bindingof('${key0}')：那格属性不是 bindable（没有生成的事件）`); return null;
        }
        return { shape: 'var', code: `${gp.emit}$m_onChanged`, type: ty0 };
      }
      const mp = self === null ? undefined : aggProps.get(self.agg)?.get(key0);
      if (mp !== undefined) {
        if (!(mp.type?.mods ?? []).includes('bindable')) {
          acct(`bindingof('${key0}')：那格属性不是 bindable（没有生成的事件）`); return null;
        }
        return { shape: 'ptr', code: `(pfield (var $this) ${mp.emit}$m_onChanged)`, type: ty0 };
      }
      acct(`bindingof('${key0}')：查不着那格属性`); return null;
    }
    if (h === 'name') {
      const key = String(nm2.text?.value ?? '');
      /* **局部与形参遮住模块级那一格**（查名的第一步就是"查得着的变量"，次序即规则）。 */
      const t = names.get(key) ?? globals.get(key);
      const isG = !names.has(key) && globals.has(key);
      if (t === undefined) {
        /**
         * **属性的取/存体里那一层**（`int g_p.get() { return m_value; }`）：属性那对花括号
         * 开的是一层命名空间（prop_full.rst:15），里头裸写的 `m_value` 指的是这格属性生成的
         * 存储 —— 在方言那一侧它叫 `g_p$m_value`。这一问排在"查不着"之前。
         */
        /**
         * **`bindable` 生成的那格事件**（第一百一十七刀）：取/存体里裸写的 `m_onChanged` 指的是
         * `<属性>$m_onChanged` —— 它与 `m_value` 是同一层作用域里的两格生成物，只是类型是
         * 多播（叫它就是"通知所有听众"）。成员属性那一格是**字段**，模块级那一格是一格量。
         */
        if (propScope !== null && propScope.mc === true && key === 'm_onChanged') {
          const ty3 = { k: 'mc', params: [] };
          const nm4 = `${propScope.emit}$m_onChanged`;
          return propScope.field === true
            ? { shape: 'ptr', code: `(pfield (var $this) ${nm4})`, type: ty3 }
            : { shape: 'var', code: nm4, type: ty3 };
        }
        if (propScope !== null && propScope.store.has(key)) {
          const t2 = propScope.store.get(key);
          const r2 = resolveType({ ...t2, shape: 'data' }, env);
          if (r2.type === null) { acct(`属性的存储 '${key}'：${r2.why}`); return null; }
          const nm3 = `${propScope.emit}$${key}`;
          const ty2 = withBits(r2.type, t2);
          /**
           * **成员属性那一格存储是一格字段**（`Cell$m_v$m_value`，67-propauto.jnc 的
           * `(pload (pfield (var $this) Cell$m_v$m_value))`）—— 与模块级那一格是两种住处，
           * 所以形状也是两种：字段是 `ptr`（读写走 pload / pstore），模块级那一格按量算。
           */
          if (propScope.field === true) {
            return {
              shape: memberShape(ty2.k === 'struct', ty2.k === 'arr'),
              code: `(pfield (var $this) ${nm3})`,
              type: ty2,
            };
          }
          /* **被 `&` 取过地址的那一格是模块级的 `(ptr T)` 自己**（第二十四刀）：读写走
             `pload` / `pstore`，`&m_value` 就是那一格。`&` 数的是**源码里写的**名字，
             而源码里写的正是 `m_value`（prop_autoget.rst:26）。 */
          const box2 = gLifted.has(key) && liftable(ty2);
          const shape2 = lvalueShape({
            isStruct: ty2.k === 'struct',
            isArr: ty2.k === 'arr',
            isGlobal: true,
            gLifted: box2,
            lifted: false,
          });
          return { shape: shape2, code: shape2 === 'var' ? nm3 : `(var ${nm3})`, type: ty2 };
        }
        /* **写出来的属性**（第六十九刀）：它不是一格内存 —— 读是 `(call g_p$get)`、写是
           `(call g_p$set …)`。这一问排在"查不着"之前：报"未声明"是**认错人**（名字在，
           只是它那一格要走取/存两个函数）。 */
        const pr = gProps.get(key);
        if (pr !== undefined) return propPlace({ ...pr, name: key }, null);
        /* **方法体里裸写的字段**（`NAME_LVALUE_ORDER` 的第二格）：`m_x` 就是 `this.m_x`。
           排在"查不着"之前 —— 它是一格真字段，报"未声明"是认错人。
           静态字段与成员属性紧跟在它后面（`memberOther`，与 `x.m` 问的是同一份）。 */
        if (self !== null) {
          /* **别名与字段路径也算"这一格是字段"**（95-aliaspath.jnc / 199-aliasfield.jnc）：
             `alias m_len = m_list.m_len;` 之后体里裸写的 `m_len` 就是那条路 —— 判据要与
             `x.m` 那一处（`memberAt` 里的三问：真字段 / 解一跳 / 一条路）问的是同一份，
             不然同一个名字点着写查得着、裸写查不着。 */
          if ((aggFields.get(self.agg)?.has(key) ?? false)
            || (aggAliases.get(self.agg)?.has(key) ?? false)
            || (aggPaths.get(self.agg)?.has(key) ?? false)) {
            return memberAt('(var $this)', self.agg, key);
          }
          const other = memberOther('(var $this)', self.agg, key);
          if (other !== undefined) return other;
        }
        acct(`'${key}' 查不着（要作用域图）`); return null;
      }
      /* **模块级的 `bindable` data**（第七十刀）：那一格生成取/存两个函数，读它是
         `(call 名字$get)`、写它是 `(call 名字$set …)` —— 属性那一族，另算。 */
      if (isG && gBindable.has(key)) {
        acct(`模块级的 bindable data '${key}'（读写各是一次调用）还没接`); return null;
      }
      return varPlace(key, t, isG);
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
      /**
       * **`operator [] ` 那一族**（第一百三十一刀，130-opindex.jnc）：左边是结构体/类时
       * 下标不是 `*(a + i)` —— 它是**一对取/存**（`<东家>$op$index$get` / `$set`），
       * 与属性那一格**同一种形状**（`prop`）：读一次调用、写另一次调用。差别只在
       * "self 那一串多带一格下标" —— `args` 本来就是一串，所以一份模板管两族。
       * 这一问排在"退化成指针"**之前**：左边是聚合体时压根没有 `(padd …)` 这条路。
       */
      const iagg = aggBehind(a.type);
      /* 取/存两格都走 `findMethod` —— 于是**基类上写的那一对**也查得着（163-opindexbase.jnc），
         与查普通方法同一条路（虚方法/撞车两样照旧明说不收）。 */
      const igf = iagg === null ? null : findMethod(iagg, 'op$index$get');
      const ig = igf === null ? undefined : igf.sig;
      if (ig !== undefined) {
        const kp = (ig.params ?? [])[0] ?? null;
        const kr = kp === null ? null : resolveType(kp, env);
        const kw = kr === null || kr.type === null ? { k: 'int', w: 64, u: false } : withBits(kr.type, kp);
        const iv = emitExpr(nm2.key, kw, ctxRef);
        if (iv === null) return null;
        if (ig.ret === null || ig.ret === undefined) {
          acct(`'${iagg}' 的 operator [] 取值器没有返回类型`); return null;
        }
        const isf = findMethod(iagg, 'op$index$set');
        const is = isf === null ? undefined : isf.sig;
        return {
          shape: 'prop',
          /* 名字用**查着那一格的东家**（基类上写的就发基类那个名字）。 */
          code: igf.key.slice(0, igf.key.length - '$get'.length),
          args: [a.code, iv.code],
          hasSet: is !== undefined,
          /* **存值器写着 `errorcode`**（`bool errorcode set(int i, char c)`，130-opindex.jnc）：
             那一句写要**顺带把错往上传**（第五十八刀），而这一层的写是一整句、插不进那两句
             —— 所以往这一格上记一面旗子，写那一侧照它明说不收（吞掉那个词就等于调用点
             再也不检查错误码了）。读那一侧不受影响。 */
          ecSet: is !== undefined && is.ec === true,
          propName: `${iagg}.operator []`,
          type: withBits(ig.ret, ig.retDecl),
        };
      }
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
      /**
       * **左边是类型名**（`C.m_count`、`S.m_table[1]`）：那是**静态成员**（第二百一十五刀）
       * —— 它不在对象里，所以这一问要排在"求左边那一格"**之前**（求它只会报"查不着"）。
       * 同名的局部量/模块级量遮住类型名（查名的次序即规则）。
       */
      if (h === 'field' && headOf(ob) === 'name') {
        const tn = String(named(ob)?.text?.value ?? '');
        const te = names.has(tn) || globals.has(tn) ? undefined : env.get(tn);
        if (te !== undefined && (te.kind === 'class' || te.kind === 'struct' || te.kind === 'union')) {
          const other = memberOther(null, te.name, fname);
          if (other !== undefined) return other;
          acct(`'${tn}' 上查不着静态成员 '${fname}'（静态方法/嵌套类型那几族另算）`); return null;
        }
      }
      /**
       * **`a.g` 是命名空间里的那一格模块级量**（第五十一刀）：它在表达式里长得像一串取字段，
       * 所以这一问必须排在"取字段"**之前**。判据是"整串摊得动、摊出来的名字正好是某一格模块级量
       * 在方言那一侧的名字"（`ns$g`）—— 摊不动或对不上就往下走，不猜。
       */
      if (h === 'field') {
        const flat = dottedFlat(node);
        if (flat !== null && flat.includes('$')) {
          for (const [k, t] of globals) {
            if ((gEmit.get(k) ?? k) !== flat) continue;
            if (gBindable.has(k)) {
              acct(`模块级的 bindable data '${k}'（读写各是一次调用）还没接`); return null;
            }
            return varPlace(k, t, true);
          }
          /* **命名空间里的那一格属性**（`cfg.level`，64-prop.jnc）：与上头那一条同一个判据 ——
             整串摊出来正好是某格属性在方言那一侧的名字（`cfg$level`）。它不是一格内存，
             读写各是一次调用，所以答的是 `prop` 形状（与裸写 `g_p` 走的是同一格）。 */
          for (const [k, pr] of gProps) {
            if ((pr.emit ?? k) !== flat) continue;
            return propPlace({ ...pr, name: k }, null);
          }
        }
      }
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
    /** 记账过几笔（外面那几层拿它判"里头记过没有"，别拿转手账盖住真原因）。 */
    acctSeen: () => acctN,
    /**
     * **`try <表达式>` 那一格**：里头调 errorcode 时**不插传播那两句**（`try` 就是这个意思）。
     * 表达式那一层只知道"有这么个词"，往上传是这一层的事 —— 所以口子开在这儿。
     */
    noEc: (f) => {
      ecOff.n += 1;
      try { return f(); } finally { ecOff.n -= 1; }
    },
    pre,
    /**
     * **这一格函数要的模块级槽**（`{ name, ty }`）：`once` 的那面旗子、`static` 局部量那一格
     * 与它的闸门。它们在方言里是 `(global …)`，可**要它们的是体那一层** —— 所以体这儿记下来、
     * 模块那一层照单发。少这个口子，`once` 发出来的 `jnc$once$0` 谁也没声明过（161-once.jnc）。
     */
    slots,
    /** 抬出去的那几格函数（造对象那三句）—— 模块那一层照单发。 */
    helpers,
    /**
     * **造一格类的对象**（pnew + 写 `$tag` + 构造，抬成一格 helper）。模块那一层要它是为了
     * **内嵌的对象字段**（第一百六十一刀）：那一格在父对象的构造开头造出来，与局部量
     * `Inner in;` 走的是同一条路 —— 不该有两份实现。
     */
    newObj,
    /**
     * **`countof(x)`**：定长数组有多少格 —— 一格**编译期常量**（jancy 的 countof 就是那一格
     * 类型上的数；跑起来数的那种是 `dynamic countof`，另一族）。所以这一层要的是那一格的
     * **类型**，不是它的值：走可写位置那一层拿类型，一个字都不发。
     * 类型给 `size_t`（jancy 那儿 countof 回的就是它）。
     */
    countOf: (node) => {
      const lv = lvOf(node);
      if (lv === null) return null;                      // 账已经记过
      if (lv.type?.k !== 'arr') {
        acct(`countof 的里头不是定长数组（${lv.type?.k ?? '?'}）`); return null;
      }
      return { code: `(int ${lv.type.n})`, type: { k: 'int', w: 64, u: true } };
    },
    /**
     * **一对花括号的初值**（`{ 10, 20, 30 }`，第十九 / 二十一刀那两格的初始化那一半）：
     * **按格子写** —— 数组逐格 `(pstore (padd (pelem 目标) (int i)) 值)`、结构体逐字段
     * `(pstore (pfield 目标 名字) 值)`。写少了的那几格**保持零**（那段内存是 pnew 出来的，
     * 本来就是零 —— C 与 jancy 都是这条）；嵌套的花括号跟着往里走。
     * 给多了、或落在"不是一整块"的类型上：当场记账（不猜）。
     */
    curlyLines: (dst, type, node, pad) => curlyLines(dst, type, node, pad),
    /**
     * **赋值当表达式用**（第一百二十七 / 一百二十八刀的那一族：`return m_i = v + 1;`、
     * 链式 `a = b = c`、`int r = *p = 5;`）。方言里赋值是**一条语句**，答不出值 ——
     * 所以旧降级抬出一格助手函数：
     *
     *   `(fn jnc$asgn$int ((p (ptr int)) (x int)) int (pstore (var p) (var x)) (ret (var x)))`
     *
     * 于是"写进去再答那个值"就是**一次调用**（106-asgnexpr.jnc 的真输出）。一格类型一份助手，
     * 一份模块只发一次（`helperBox`）。
     *
     * 左边得是一格**有地址**的位置（`ptr` 形状）：普通的名字那一格没有地址，旧降级那时候把它
     * 提到堆上 —— 那是"提"那一族的事，这儿明说不收。
     */
    asgnExpr: (node, want) => {
      const an = named(node) ?? {};
      const op = String(an.op?.value ?? '=');
      if (op !== '=') { acct(`复合赋值 '${op}' 当表达式用还没接`); return null; }
      const lv = lvOf(an.a);
      if (lv === null) return null;                        // 账已经记过
      if (lv.shape !== 'ptr') {
        acct(`赋值当表达式用：左边那一格是 ${lv.shape}（要一格有地址的位置）还没接`); return null;
      }
      const ty = lv.type;
      if (!['int', 'real', 'bool', 'string'].includes(ty?.k)) {
        acct(`赋值当表达式用落在 ${ty?.k ?? '?'} 上还没接`); return null;
      }
      const v = emitExpr(an.b, ty, ctxRef);
      if (v === null) return null;                         // 账已经记过
      const tw = emitType(ty, 'value', tyc);
      const nm4 = `jnc$asgn$${tw.replace(/[^A-Za-z0-9]/g, '')}`;
      if (!helperBox.has(nm4)) {
        helperBox.add(nm4);
        helpers.push([
          `  (fn ${nm4} ((p (ptr ${tw})) (x ${tw})) ${tw}`,
          '    (pstore (var p) (var x))',
          '    (ret (var x)))',
        ].join('\n'));
      }
      return { code: `(call ${nm4} ${lv.code} ${v.code})`, type: ty };
    },
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
    isVar: (t) => t !== null && t !== undefined && t.k === 'struct' && t.name === VARIANT,
    isEnum: (t) => t !== null && t !== undefined && t.k === 'enum',
    isClass: (t) => t !== null && t !== undefined && t.k === 'class',
    isStruct: (t) => t !== null && t !== undefined && t.k === 'struct',
    isFn: (t) => t !== null && t !== undefined && t.k === 'fnptr',
    isPtr: (t) => t !== null && t !== undefined && (t.k === 'ptr' || t.k === 'tptr'),
    /**
     * **`variant_t` 的装箱与拆箱**（第一百一十三刀，105-variant.jnc 的真输出）：一格 variant
     * 是四格的结构体（标签 + 三格载荷），装/拆各是**一次调用** —— 表达式那一层回的是一格值，
     * 没有能挂语句的地方，所以那几句包成助手（`runtime.js` 里那两格壳，一份模块只发一次）。
     *   装：int/enum → `$i`、real → `$r`、bool → `$b`（载荷是整数，所以先 `(sel v 1 0)`）、
     *       string → `$s`；别的种明说不收。
     *   拆：标签对不上是**运行期**的事（jancy 那边也是），所以壳里是 `(fail …)`；
     *       取整数那一格回的是 64 位载荷，按左边要的宽度收口（`intConvCode`），
     *       取布尔那一格回整数，比一下 0。
     */
    varBoxName: (kind) => varShellOnce(`jnc$var$${kind}`, varBoxShell(kind)),
    /* 格式化字面量那一格（第二百刀）：整条落成一串 `(bin "+" …)`，答的是一格字符串的值。 */
    fmtOf,
    boxVar: (v) => {
      const k = varKind(v.type);
      if (k === null) { acct(`往 variant_t 里装一格 ${v.type?.k ?? '?'} 还没接`); return null; }
      const arg = k === 'b' ? `(sel ${v.code} (int 1) (int 0))` : v.code;
      return { code: `(call ${varShellOnce(`jnc$var$${k}`, varBoxShell(k))} ${arg})`, type: VAR_TY };
    },
    unboxVar: (v, want) => {
      const k = varKind(want);
      if (k === null) { acct(`从 variant_t 里取一格 ${want?.k ?? '?'} 还没接`); return null; }
      const call = `(call ${varShellOnce(`jnc$var$to$${k}`, varUnboxShell(k))} ${v.code})`;
      if (k === 'b') return { code: `(bin "!=" ${call} (int 0))`, type: { k: 'bool' } };
      if (k === 'i') return { code: intConvCode(call, { k: 'int', w: 64, u: false }, want), type: want };
      return { code: call, type: want };
    },
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
      /* **属性不是一格内存**（第六十九刀）：`&g_p` 在 jancy 里是"属性指针"（取/存两个函数 +
         那个对象），与一格普通指针两码事 —— 这一层没有那格类型，明说。 */
      if (lv.shape === 'prop') { acct('对属性取地址（那是一格属性指针，不是普通指针）还没接'); return null; }

      return { code: lv.code, type: { k: 'ptr', target: lv.type } };
    },
    /** 一格局部量声明：`int x = 5;` → `(let x int (int 5))`。 */
    localDecl: (node, ind, ctx) => {
      const pad = ' '.repeat(ind);
      const vn = named(node);
      const h0 = headOf(node);
      if (vn === null || (h0 !== 'var-decl' && h0 !== 'var-decl-curly')) {
        acct(`这一格局部量声明还拼不出来（${h0 ?? '?'}）`); return null;
      }
      /**
       * **带花括号初值的局部量**（`int a[3] = { 1, 2, 3 };`）：那是**另一个节点**
       * （`var-decl-curly`：一格 `dcl` + 一格 `value`，不是 `dcl*` 那条链）—— 可它与
       * "`init` 右边是一对花括号"是**同一件事**，所以两种形状在这儿收成同一条路：
       * 声明子那一串取哪一格、花括号那一格从哪儿读，各按节点形状问一次，往下就只有一份规则。
       */
      const isCurlyNode = h0 === 'var-decl-curly';
      /* `static` 的局部量是**另一条路**（第二十六刀）：一格模块级的槽 `名字$sN` + 一道
         只跑一次的闸门 `名字$sN$1`。 */
      const sp0 = readSpecs(vn.specs);
      const isStatic = sp0 !== null && sp0.words.includes('static');
      /* **体里的 `alias`**（`alias plus = add;` / `alias P = Point;`，第二百六十二刀）：
         它一个字都不发 —— "这个名字指着谁"在探子那一遍（`module-scan`）就登记好了，
         与体里的 typedef / enum / struct 同一条。 */
      if (sp0 !== null && sp0.words.includes('alias')) return [];
      const out = [];
      const dcls = isCurlyNode ? [vn.dcl] : allInChain(vn.dcls, 'dcls-add', 'dcls');
      for (const d of dcls) {
        const isInit = headOf(d) === 'init';
        const dd = isInit ? named(d)?.dcl : d;
        const t = readDeclType(vn.specs, dd);
        if (t === null || t.name === null) { acct('局部量的名字读不出来'); return null; }
        /**
         * **右边是一对花括号**（`int d[4] = { 5, 6 };` / `int b[] = { 7, 8 };`）：那一格是
         * "开一格自己的内存 + 按格子写"（`curlyLines`）。长度写空的从花括号里数
         * （`arrayFromCurly` —— 与模块级那一格用的是同一份）。
         */
        const cv = isCurlyNode ? (vn.value ?? null)
          : (isInit && headOf(named(d)?.value) === 'curly' ? named(d).value : null);
        let r = resolveType(t, env);
        if (r.type === null && cv !== null) {
          const inferred = arrayFromCurly({ name: t.name, type: t, at: node }, env, cv);
          if (inferred !== null) r = { type: inferred, why: null };
        }
        if (r.type === null) { acct(`局部量 '${t.name}'：${r.why}`); return null; }
        names.set(t.name, t);
        if (cv !== null) {
          forced.set(t.name, r.type);
          /**
           * **`static` + 花括号**（`static int a[3] = { 1, 2 };`）：存储是一格模块级的槽
           * `名字$sN`，类型带上 `(ptr (blk …))`（与模块级那一格同一条 ——  `staticLocalLines`
           * 那一头已经发了 `(global a$s3 (ptr (blk int 3)))`），初值在**一道闸门**里
           * （`once`：`(if (un "!" 闸门$1) (do (set 闸门$1 true) 初值…))`），按格子写。
           */
          if (isStatic) {
            const dn = `${t.name}$s${tmpBox.n}`;
            tmpBox.n += 1;
            alias.set(t.name, dn);
            slots.push({ name: dn, ty: emitType(r.type, 'slot', tyc) });
            slots.push({ name: `${dn}$1`, ty: 'bool' });
            const ls1 = curlyLines(`(var ${dn})`, r.type, cv, `${pad}    `);
            if (ls1 === null) return null;                 // 账已经记过
            /* **那一格内存要先开出来**（`(pnew …)`）：块里装的是结构体时它不是自动开的
               —— 少这一句，往 `(pfield (pelem …) m_id)` 里写就是空指针
               （196-localstruct.jnc 量出来的）。开在闸门里：只开一次，紧挨着填。 */
            out.push([
              `${pad}(if (un "!" (var ${dn}$1))`,
              `${pad}  (do`,
              `${pad}    (set ${dn}$1 (bool true))`,
              `${pad}    (set ${dn} (pnew ${emitType(r.type, 'slot', tyc)} (int 1)))`,
              ...ls1,
              `${pad}  ))`,
            ].join('\n'));
            continue;
          }
          if (r.type.k !== 'arr' && r.type.k !== 'struct') {
            acct(`局部量 '${t.name}' 的花括号初值落在 ${r.type.k} 上（那不是一整块）还没接`); return null;
          }
          if (taken.has(t.name)) {
            acct(`局部量 '${t.name}' 被取过地址又写了花括号初值 —— 那两件事的次序还没量`); return null;
          }
          const ty1 = emitType(r.type, 'slot', tyc);
          const ls1 = curlyLines(`(var ${t.name})`, r.type, cv, pad);
          if (ls1 === null) return null;                   // 账已经记过
          out.push(`${pad}(let ${t.name} ${ty1} (pnew ${ty1} (int 1)))`, ...ls1);
          continue;
        }
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
          /**
           * **`static` 的类变量**（`static Counter c;`，第一百五十四刀）：存储是一格模块级的槽
           * `名字$sN`（类型就是 `(ptr 根)`），而"造那一格对象"包在**那道只跑一次的闸门**里
           * —— 与普通局部量 `Counter c;` 走同一条 `newObj`（pnew + 写 `$tag` + 构造）。
           * 写了初值的照旧拒（类的变量赋不了值，第五十二刀）。
           */
          if (r.type.k === 'class' && (t.ptrs ?? 0) === 0 && !isInit) {
            const dn0 = `${t.name}$s${tmpBox.n}`;
            tmpBox.n += 1;
            alias.set(t.name, dn0);
            slots.push({ name: dn0, ty: emitType(r.type, 'value', tyc) });
            slots.push({ name: `${dn0}$1`, ty: 'bool' });
            const ct1 = named(t.raw?.dcl)?.ctor;
            const cargs1 = headOf(ct1) === 'ctor'
              ? allInChain(named(ct1)?.args, 'args-add', 'args') : [];
            const o1 = newObj(r.type.name, cargs1);
            if (o1 === null) return null;                    // 账已经记过
            out.push([
              `${pad}(if (un "!" (var ${dn0}$1))`,
              `${pad}  (do`,
              `${pad}    (set ${dn0}$1 (bool true))`,
              `${pad}    (set ${dn0} ${o1.code})))`,
            ].join('\n'));
            continue;
          }
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
          /* **一格类的局部量**（`Outer o;`）：jancy 那儿它是**自动造出来的对象**
             （类变量在作用域里就构造好），不是一条空引用 —— 所以走造对象那条路
             （`newObj`：pnew + 写 `$tag` + 构造）。先前这儿按 `zeroText` 发 `(pnull …)`，
             跑起来是"指针越界"（195-embctor.jnc 量出来的）。
             **写了 `*` 的那一种不造**（`Node* z;`）：那一格是一条空引用（49-class.jnc 的
             `if (z == null)` 就是量它）—— 类那一族在解类型时吞掉一个 `*`，所以这儿得回头
             问一句"源码里写了几个星"。 */
          if (r.type.k === 'class' && (t.ptrs ?? 0) === 0) {
            /* **声明符尾巴上那对括号是构造实参**（`Counter c(100);`，第一百〇三刀）——
               只有类与结构体收得下。args 躺在 `(ctor (args …))` 上，与 `new C(…)` 那一格
               走的是**同一条** `newObj`（那一头已经会按默认实参补、会明说不收）。 */
            const ct = named(t.raw?.dcl)?.ctor;
            const cargs = headOf(ct) === 'ctor'
              ? allInChain(named(ct)?.args, 'args-add', 'args') : [];
            const o2 = newObj(r.type.name, cargs);
            if (o2 === null) return null;
            out.push(`${pad}(let ${t.name} ${ty} ${o2.code})`);
            continue;
          }
          const z = zeroText(r.type, { tyText: (x) => emitType(x, 'value', tyc), clsRoot });

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
        /**
         * **写了初值的结构体/数组是"抄一份"**（第十二 / 二十一刀）：jancy 里聚合体是**值**
         * 语义 —— `Point q = p;` 之后改 q 不动 p。方言里一格 `pstore` 搬不动一整块，所以
         * 逐字段 / 逐格搬（`copyVal`，`member-table.js` 里那一份）。
         *
         * 源头先钉在一格临时量上（`$sN`）：那一串可能是一次调用（`f()`），逐字段搬会把它
         * **重求好几遍**。
         */
        if (r.type.k === 'struct' || r.type.k === 'arr') {
          const src = ctx.expr(named(d)?.value, declTy);
          if (src === null) return null;
          const s = `$s${tmpBox.n}`;
          tmpBox.n += 1;
          const ls = copyValLines({
            dst: `(var ${t.name})`, src: `(var ${s})`, type: r.type, pad, fieldsOf,
          });
          if (ls === null) { acct(`'${t.name}' 抄一份抄不出来（字段表/环那两格）`); return null; }
          out.push(`${pad}(let ${s} ${ty} ${src})`);
          out.push(`${pad}(let ${t.name} ${ty} (pnew ${ty} (int 1)))`);
          out.push(...ls);
          continue;
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
      /**
       * **右边是一对花括号**（`a = { 1, 2 };`，25-static-local.jnc 的 `arrset`）：按格子写 ——
       * 没写到的那几格**保留原值**（那是赋值，不是重新初始化；`curlyLines` 只发写到的那几格，
       * 正好是这一条）。左边得是一整块（`agg` 形状）。
       */
      if (headOf(an.b) === 'curly' || headOf(an.b) === 'curly-init') {
        if (op !== '=') { acct(`复合赋值 '${op}' 的右边是一对花括号`); return null; }
        const lv0 = lvOf(an.a);
        if (lv0 === null) return null;                     // 账已经记过
        if (lv0.shape !== 'agg') {
          acct(`右边是一对花括号，可左边那一格是 ${lv0.shape}（不是一整块）`); return null;
        }
        const ls0 = curlyLines(lv0.code, lv0.type, an.b, pad);
        return ls0 === null ? null : ls0;
      }
      const lv = lvOf(an.a);
      if (lv === null) return null;
      /**
       * **往一格事件（多播）上写**（第一百一十七刀，69-propbind.jnc）：那一格不是普通的量 ——
       *   `bindingof(p) += f;` 是**加一格听众**（`(apush 那一格 (fnref f))`，加进来的次序
       *     就是叫的次序）；
       *   `bindingof(p) = null;` 是**清空**（`(set 那一格 (anew … (int 0)))`）。
       * 别的算符（`-=` 那一族要"减一格听众"，得先有个句柄）明说不收。
       */
      if (lv.type?.k === 'mc') {
        if (op === '+=') {
          const v0 = emitExpr(an.b, { k: 'fnptr', params: lv.type.params ?? [], ret: null }, ctxRef);
          if (v0 === null) return null;                      // 账已经记过
          if (v0.type?.k !== 'fnptr') {
            acct(`往事件上加的那一格是 ${v0.type?.k ?? '?'}，不是函数值`); return null;
          }
          return [`${pad}(apush ${readLv(lv)} ${v0.code})`];
        }
        if (op === '=' && headOf(an.b) === 'null') {
          const w0 = writeLv(lv, `(anew ${emitType(lv.type, 'value', tyc)} (int 0))`);
          return w0 === null ? null : [`${pad}${w0}`];
        }
        acct(`往事件上 '${op}' 那一格还没接（加听众是 \`+=\`、清空是 \`= null\`）`); return null;
      }
      /**
       * **往结构体/数组里赋值是"抄一份"**（第十二 / 二十一刀）：`(pstore)` 搬不动一整块，
       * 逐字段 / 逐格搬（`copyVal`）。源头先钉在一格临时量上 —— 右边可能是一次调用。
       * 复合赋值落在整块上是算符重载那一族，另算。
       */
      /**
       * **`operator :=`**（第一百三十刀）与**抄一份**（第十二 / 二十一刀）这两族要一起判 ——
       * 都盯着"左边是一整块聚合体"这一格，而右边只该求**一次**：
       *   1. 写了赋值算符、右边**不同型** → 那一句是**一次调用**（同型是拷贝，不是转换）；
       *   2. 左边是结构体/数组（形状 `agg`）→ 逐字段 / 逐格搬（`copyVal`），
       *      源头先钉在一格临时量上（右边可能是一次调用，逐字段搬会重求好几遍）；
       *   3. 别的（类的变量那一格形状是 `var`，里头放的**是地址**）→ 与普通写同一条。
       */
      const aggName = lv.type?.k === 'struct' || lv.type?.k === 'class' ? lv.type.name : null;
      const oa = aggName === null ? undefined : methods.get(`${aggName}$op$assign`);
      if (lv.shape === 'agg' || (oa !== undefined && op === '=')) {
        if (op !== '=') {
          acct(`复合赋值 '${op}' 落在结构体/数组上（算符重载那一族）还没接`); return null;
        }
        let want = lv.type;
        if (oa !== undefined) {
          const pt = (oa.params ?? [])[0] ?? null;
          const pr = pt === null ? null : resolveType(pt, env);
          want = pr === null || pr.type === null ? null : withBits(pr.type, pt);
        }
        const src = emitExpr(an.b, want, ctx);
        if (src === null) return null;
        const sameType = src.type?.k === lv.type?.k && (src.type?.name ?? null) === (lv.type?.name ?? null);
        if (oa !== undefined && !sameType) {
          return [`${pad}(expr (call ${aggName}$op$assign ${readLv(lv)} ${src.code}))`];
        }
        if (lv.shape === 'agg') {
          const s = `$s${tmpBox.n}`;
          tmpBox.n += 1;
          const ls = copyValLines({
            dst: lv.code, src: `(var ${s})`, type: lv.type, pad, fieldsOf,
          });
          if (ls === null) { acct('抄一份抄不出来（字段表/环那两格）'); return null; }
          return [`${pad}(let ${s} ${emitType(lv.type, 'slot', tyc)} ${src.code})`, ...ls];
        }
        const w0 = writeLv(lv, src.code);
        return w0 === null ? null : [`${pad}${w0}`];
      }
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
        const w1 = writeLv(lv, code);
        return w1 === null ? null : [`${pad}${w1}`];
      }
      const v = ctx.expr(an.b, lv.type);
      if (v === null) return null;
      const w2 = writeLv(lv, v);
      return w2 === null ? null : [`${pad}${w2}`];
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
      const w = writeLv(lv, code);
      return w === null ? null : [`${pad}${w}`];
    },
    /** 调用：被调是**裸名字**且查得着顶层那几格函数时 → `(call 名字 实参…)`。 */
    callOf: (node, want, ctx) => {
      const nm2 = named(node) ?? {};
      const fn = nm2.fn;
      const args = allInChain(nm2.args, 'args-add', 'args');
      const asName = headOf(fn) === 'name' ? String(named(fn)?.text?.value ?? '') : null;
      /**
       * **方法那一族**（第五十二刀）：`p.sum()`、`q.sum()`（`P*` 上与 `P` 上一样，第二十五刀）、
       * 以及方法体里**裸叫方法**（`sum()` 就是 `this.sum()`）。方言那一侧它是一格普通函数
       * `<东家>$<方法名>`，`this` 由这一层补成**第一个实参**。
       *
       * 这一问排在"函数指针"与"按名字找函数"**之前** —— 它是一格真方法，落到那两条上报的是
       * "被调认不出来"，那是认错人。
       */
      let sig = null;
      let selfArg = null;
      let key = asName;
      /**
       * **`basetype.foo(…)` / `basetype.construct(…)` 是静态绑定**（第五十六刀，
       * `CALL_ORDER` 的第 6 条）：说的就是"调基类那一个"，不过虚派发。这一问要排在方法调用
       * **之前** —— `basetype` 不是一格值，求它只会报"表里没有这一格表达式"。
       * 换到基类那一面发**零条指令**（整条链共用一格结构体），所以 `$this` 原样递下去。
       */
      if (asName === null && headOf(fn) === 'field' && headOf(named(fn)?.obj) === 'basetype') {
        const fn2 = named(fn) ?? {};
        const mname = String(fn2.name?.value ?? '');
        const b = baseAt(named(fn2.obj)?.type);
        if (b === null) return null;                       // 账已经记过
        const mi = methods.get(`${b}$${mname}`) ?? fns.get(`${b}$${mname}`);
        if (mi === undefined) {
          acct(`基类 '${b}' 上查不着 '${mname}'（合成出来的构造那一族另算）`); return null;
        }
        sig = mi;
        selfArg = mi.stat === true ? null : '(var $this)';
        key = `${b}$${mname}`;
      } else if (asName === null && (headOf(fn) === 'field' || headOf(fn) === 'ptr-field')) {
        const fn2 = named(fn) ?? {};
        const mname = String(fn2.name?.value ?? '');
        /**
         * **左边是类型名**（`S.make()`）：那是**静态方法**（decl_storage.rst 的
         * StorageKind_Static）—— 它没有 `this`，所以这一问要排在"求左边那一格"之前
         * （求它只会报"查不着"）。同名的局部量/模块级量遮住类型名。
         */
        if (headOf(fn2.obj) === 'name') {
          const tn = String(named(fn2.obj)?.text?.value ?? '');
          const te = names.has(tn) || globals.has(tn) ? undefined : env.get(tn);
          if (te !== undefined && ['class', 'struct', 'union'].includes(te.kind)) {
            const mi2 = methods.get(`${te.name}$${mname}`);
            if (mi2 === undefined) {
              acct(`'${tn}' 上查不着静态方法 '${mname}'`); return null;
            }
            if (mi2.stat !== true) {
              acct(`'${tn}.${mname}(…)' 那一格不是静态方法（要一格对象）`); return null;
            }
            sig = mi2;
            selfArg = null;
            key = `${te.name}$${mname}`;
          }
        }
        /**
         * **跟在点后面的 `basetype`**（`d.basetype.val()`，119-basetypedot.jnc）：
         * 一整条继承链共用一格方言结构体（第五十六刀），所以"换到基类那一面"**发零条指令**
         * —— 左边那一格原样求值，只是调的函数换成基类那一个。而且它是**静态绑定**
         * （`basetype.m()` 说的就是"调基类那一个"，不查分派表）——所以这儿直接按名字取，
         * 不走 `findMethod` 那条（那条会因为"虚方法"而明说不收）。
         */
        const obh = headOf(fn2.obj);
        const obName = obh === 'field' ? String(named(fn2.obj)?.name?.value ?? '') : '';
        if (sig === null && /^basetype[12]?$/.test(obName)) {
          const inner = named(fn2.obj).obj;
          const ob0 = objBase(inner);
          if (ob0 === null) return null;                   // 账已经记过
          const agg0 = aggBehind(ob0.type);
          if (agg0 === null) { acct(`'.basetype' 的左边不是结构体/类（${ob0.type?.k ?? '?'}）`); return null; }
          const i0 = obName === 'basetype2' ? 2 : 1;
          const b0 = (aggBases.get(agg0) ?? [])[i0 - 1];
          if (b0 === undefined) { acct(`'${agg0}' 没有第 ${i0} 格基类，可这儿写了 basetype`); return null; }
          const mi3 = methods.get(`${b0}$${mname}`) ?? fns.get(`${b0}$${mname}`);
          if (mi3 === undefined) {
            acct(`基类 '${b0}' 上查不着 '${mname}'（合成出来的构造那一族另算）`); return null;
          }
          sig = mi3;
          selfArg = mi3.stat === true ? null : ob0.code;
          key = `${b0}$${mname}`;
        }
        /**
         * **命名空间里的函数**（`a.inner()` / `a.b.deep()`，48-namespace.jnc）：命名空间只是个
         * 前缀（第五十一刀）—— 整串摊得动、摊出来正好是函数表里那一格（`a$inner` / `a$b$deep`）
         * 就是它。这一问也排在"求左边那一格"之前：`a` 不是一格值，求它只会报"查不着"。
         * 判据里那句"头一段不是查得着的变量"是**遮蔽**那条规矩：同名的局部量/模块级量先赢。
         */
        if (sig === null) {
          const flat = dottedFlat(fn);
          const head0 = flat === null ? '' : flat.slice(0, flat.indexOf('$'));
          if (flat !== null && flat.includes('$') && !names.has(head0) && !globals.has(head0)) {
            const f2 = fns.get(flat);
            if (f2 !== undefined) { sig = f2; selfArg = null; key = flat; }
          }
        }
        if (sig === null) {
          const ob = objBase(fn2.obj);
          if (ob === null) return null;
          const agg = aggBehind(ob.type);
          if (agg === null) { acct(`叫方法时 '.' 的左边不是结构体/类（${ob.type?.k ?? '?'}）`); return null; }
          const found = findMethod(agg, mname);
          if (found === null) {
            /**
             * **字段里装着一格函数指针**（`Fn* m_f;` 之后 `s.m_f(3, 4)`，116-structtypedef.jnc）：
             * jancy 里方法与字段在**同一个命名空间**里，所以查不着方法时这一格还可能是
             * "读出那个字段、按函数值调"。判据是它的类型解出来正好是 `fnptr` —— 是就
             * **不在这儿定**，落到下面"从一格函数指针上调"那条（`(callfn …)`，第五十五刀）。
             */
            if (!fnptrField(agg, mname)) {
              acct(`'${agg}' 上查不着方法 '${mname}'（属性/事件/虚派发那几族另算）`); return null;
            }
          } else {
            sig = found.sig;
            selfArg = found.sig.stat === true ? null : ob.code;
            key = found.key;
          }
        }
      } else if (asName !== null && !names.has(asName) && !globals.has(asName)
        && self !== null && findMethod(self.agg, asName) !== null) {
        const found = findMethod(self.agg, asName);
        sig = found.sig;
        selfArg = sig.stat === true ? null : '(var $this)';
        key = found.key;
      }
      if (sig === null) {
        /**
         * **从一格函数指针上调**（第五十五刀）：方言的 `(callfn E 实参…)`，签名就在那一格
         * 的类型里。这一问排在"按名字找函数"**之前** —— 同名的局部量遮住模块级那个函数
         * （lower.js:14730 那条注解就是这一句）。被调不是裸名字（`(*p)(…)`、`a[i](…)`）时
         * 也走这条：那时它只能是一格函数值。
         */
        const viaVal = asName === null || names.has(asName) || globals.has(asName)
          /* **方法体里裸写一格装着函数指针的字段**（`m_op(…)`，109-fnfield.jnc）：与
             `s.m_op(…)` 是同一件事 —— 读出那一格、按函数值调。 */
          || (self !== null && fnptrField(self.agg, asName))
          /* **取/存体里裸写那格生成的事件**（`m_onChanged();`，第一百一十七刀）：它不是
             函数表里的名字，是这格属性的生成物 —— 求它得出一格多播，叫它就是通知所有听众。 */
          || (propScope !== null && propScope.mc === true && asName === 'm_onChanged');
        if (viaVal) {
          const fv = emitExpr(fn, null, ctxRef);
          if (fv === null) return null;
          /**
           * **叫一格事件就是"通知所有听众"**（第一百一十七刀，69-propbind.jnc 的 `m_onChanged()`）：
           * 多播那一格不是一格函数值 —— 它是一串，所以落成一次**通知助手**的调用
           * （`jnc$mc_fire`，一份模块只发一次；次序就是加进来的次序）。
           */
          if (fv.type?.k === 'mc') {
            const ps0 = fv.type.params ?? [];
            if (args.length !== ps0.length) {
              acct(`叫那格事件给了 ${args.length} 个实参，可它收 ${ps0.length} 个`); return null;
            }
            const vs = [];
            for (const [i, a3] of args.entries()) {
              const v3 = emitExpr(a3, ps0[i] ?? null, ctxRef);
              if (v3 === null) return null;
              vs.push(v3.code);
            }
            const fire = varShellOnce(mcFireName(fv.type), mcFireShell(fv.type));
            return {
              code: `(call ${fire} ${fv.code}${vs.map((x) => ` ${x}`).join('')})`,
              type: { k: 'void' },
            };
          }
          if (fv.type?.k !== 'fnptr') {
            acct(`被调那一格是 ${fv.type?.k ?? '?'}，不是函数值（算符重载那一族另算）`); return null;
          }
          const parts0 = [];
          for (const [i, a2] of args.entries()) {
            const v = ctxRef.expr(a2, fv.type.params[i] ?? null);
            if (v === null) return null;
            parts0.push(v);
          }
          const rt0 = fv.type.ret ?? { k: 'void' };
          return { code: `(callfn ${fv.code}${parts0.map((x) => ` ${x}`).join('')})`, type: rt0 };
        }
        if (key === 'printf') { acct('printf 那一族（格式化）还没接'); return null; }
        sig = fns.get(key);
        /* **`alias plus = add;`**（197-localalias.jnc）：先解一跳再照旧查函数表 ——
           别名没有存储，它就是"这个名字指着谁"。 */
        if (sig === undefined) {
          const to = gAlias.get(key);
          if (to !== undefined) { sig = fns.get(to); if (sig !== undefined) key = to; }
        }
        /**
         * **CRT 的那几格字符判据**（第一百七十六刀，148-crtchar.jnc）：`isdigit` / `toupper` 那
         * 十个名字来自宿主的 C 运行时，而方言里没有宿主 —— 所以各落成一格**自己发的函数**
         * `jnc$crt$<名字>`（一份模块只发一次，`helperBox` 去重），体是表里那一句纯表达式。
         * 这一问排在"查不着（跨文件/宿主面）"之前，也排在**查名之后** —— 源码里自己写了
         * 同名函数的那一格先赢（那时上头 `fns.get` 已经查着了）。
         */
        if (sig === undefined) {
          const crt = CRT_CHAR.get(key);
          if (crt !== undefined) {
            if (args.length !== 1) {
              acct(`'${key}' 收 1 个实参，这里给了 ${args.length}`); return null;
            }
            const v0 = emitExpr(args[0], { k: 'int', w: 32, u: false }, ctxRef);
            if (v0 === null) return null;
            if (v0.type?.k !== 'int') { acct(`'${key}' 的实参要一格整数（这里是 ${v0.type?.k ?? '?'}）`); return null; }
            const nm5 = `jnc$crt$${key}`;
            if (!helperBox.has(nm5)) {
              helperBox.add(nm5);
              helpers.push([
                `  (fn ${nm5} ((c int)) ${emitType(crt.type, 'value', tyc)}`,
                `    (ret ${crt.body}))`,
              ].join('\n'));
            }
            return { code: `(call ${nm5} ${v0.code})`, type: crt.type };
          }
        }
        if (sig === undefined) { acct(`调的那个 '${key}' 查不着（跨文件/宿主面）`); return null; }
      }
      const parts = [];
      /* **同名那一族先挑一格**（第五十八刀）：上头那几条路查出来的是**基名**那一格签名，
         而同名的还有几格 —— 按实参个数挑，挑不出来明说不收（`pickOvl` 里记账）。 */
      {
        const p0 = pickOvl(key, sig, args);
        if (p0 === null) return null;
        sig = p0.sig;
        key = p0.key;
      }
      /* **实参给少了就按默认实参补**（第一百七十五刀）：`void def(void function* cb() = null)`
         的 `def()` 落出来是 `(call def (null (fnty () void)))`。补的那一格按形参的类型降
         —— `null` 正要从那儿知道自己是哪种指针。 */
      const nArgs = Math.max(args.length, sig.params.length);
      for (let i = 0; i < nArgs; i += 1) {
        /**
         * **空槽**（`f(1, , 3)`，第八十八刀）：树上是一格 `(unbound)`，意思与"末尾少给"
         * 一模一样 —— 这一格用那个形参的默认值。所以两种写法在这儿收成同一条：
         * 把它换成默认值那个**语法节点**，往下就只有一份规则（同一份类型、同一句诊断）。
         */
        const a2 = args[i] === undefined || headOf(args[i]) === 'unbound' ? undefined : args[i];
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
      const code = `(call ${sig.emit ?? key}${selfArg === null ? '' : ` ${selfArg}`}`
        + `${parts.map((x) => ` ${x}`).join('')})`;

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
      if (sig.ec === true && ecOff.n === 0) {
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
    /**
     * **`print(x)`：一次输出，不添换行**（第六十四刀，`(write 值)`）。`printf` 那一格要解格式，
     * 这一格**不解** —— 那正是两者最要紧的差别（`print("100% sure")` 里的 `%` 就是个字符）。
     * 源码里自己写了一格 `print` 的那一格先赢：答 `undefined`，调用方照常路走。
     */
    printOut: (node, ind) => {
      if (fns.has('print') || names.has('print') || globals.has('print')) return undefined;
      const args = allInChain(named(node)?.args, 'args-add', 'args');
      if (args.length !== 1) { acct(`print 收 1 个实参，这里给了 ${args.length}`); return null; }
      const v = emitExpr(args[0], T.string, ctxRef);
      if (v === null) return null;                          // 账已经记过
      if (v.type?.k !== 'string') {
        acct(`print 的实参要一格字符串（这里是 ${v.type?.k ?? '?'}）`); return null;
      }
      return [`${' '.repeat(ind)}(write ${v.code})`];
    },
    /** `printf("%d %d\n", a, b)` → 按 `\n` 切段，每段一条 `(print …)`；`%d` 那一格是 `(tostr 值)`。 */
    printf: (node, ind, ctx) => {
      const args = allInChain(named(node)?.args, 'args-add', 'args');
      if (args.length === 0) { acct('printf 一个实参都没有'); return null; }
      /* 格式串那一格是一格**记号**，而且**转义已经解好了**：
         `{ kind:'string', value:'%d\n', raw:'%d\\n' }`（印出来才知道的 —— 先前既按裸引号
         判、又想 JSON.parse 一遍，两样都错）。所以直接用 `value`。
         **贴着写的几格串也是一格串**（`printf("1" "2" "3" "\n")`，第五十四刀）——
         `strLitFold` 折一次，与 `string_t s = "a" "b"` 问的是同一件事。
         格式化字面量（`$"…"`）是另一族，折不动，记账。 */
      const fmt = strLitFold(args[0]);
      if (fmt === null) {
        acct('printf 的格式串不是一格字面量（格式化字面量那一族另算）'); return null;
      }
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
    /**
     * **`new T` / `new T[n]`**（第五十二 / 一百二十九刀）：`(pnew (ptr T) 个数)`，出来的是
     * 一格指针。类那一族与"有 construct 的结构体"另算 —— 那两种是**三句**（造一格、写 `$tag`、
     * 调构造），而 `new` 是一格表达式，得抬成一个函数；这一层还没接，明说。
     */
    newOf: (node, want) => {
      const nm2 = named(node) ?? {};
      const to = ctxRef.typeNameOf(nm2.type);
      if (to === null) return null;
      if (to.k === 'void') { acct('new void'); return null; }
      if (to.k === 'class') {
        if (headOf(node) === 'new-array') { acct(`不能造类的数组（'${to.name}'）`); return null; }
        /* 带实参的那一格照样走 `newObj` —— 实参变成 helper 的形参（`$i0`…）。 */
        return newObj(to.name, allInChain(nm2.args, 'args-add', 'args'));
      }
      if (to.k === 'struct' && aggCtors.has(to.name)) {
        acct(`new ${to.name}（那一格有 construct，造完还要调它）还没接`); return null;
      }
      if (headOf(node) === 'new' && nm2.args !== undefined && nm2.args !== null) {
        acct('new T(…) 带构造实参那一族还没接'); return null;
      }
      let count = '(int 1)';
      if (headOf(node) === 'new-array') {
        const c = emitExpr(nm2.size, { k: 'int', w: 64, u: false }, ctxRef);
        if (c === null) return null;
        if (c.type?.k !== 'int') { acct('new T[n] 的 n 要整数'); return null; }
        count = c.code;
      }
      const pt = { k: 'ptr', target: to };
      return { code: `(pnew ${emitType(pt, 'value', tyc)} ${count})`, type: pt };
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
    /**
     * 这一格算子在那两边的类型上**是不是算符重载**（`operator ==` 那几格，第一百二十二刀）。
     * 表在 `OP_NAMES`（源码里的算子 → `op$<名字>`），东家从类型上问 —— 答真的话调用方明说
     * 不收，而不是落到"指针互比"那一支上去比地址。
     */
    opFor: (op, a, b) => {
      const w = OP_NAMES[op];
      if (w === undefined) return false;
      for (const ty of [a, b]) {
        const agg = aggBehind(ty);
        if (agg !== null && methods.has(`${agg}$op$${w}`)) return true;
      }
      return false;
    },
    /* 驱动把它那一格 `ctx` 交回来（`expr` / `ecOut` / `guards` 都在它上头）。 */

    onCtx: (c2) => { ctxRef = c2; },
  };
}
