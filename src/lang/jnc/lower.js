// src/lang/jnc/lower.js —— **规则化的降级**：把那几张表接成一整份 `(module …)`
//
// 这一份是"组装"那一层：`module-scan.js` 说这份源码里有什么，`emit-agg` / `emit-global` /
// `emit-fn` / `emit-body` 各自把自己那一格发出来，这儿只管**次序与骨架**：
//
//   (module
//     <struct/global/fn 一格一格，按声明序>
//     (main
//       <模块级那几格量的 pnew>        ;; 两阶段：pnew 全排在初值之前（第二十四刀）
//       <模块级那几格量的初值>          ;; jancy 的 module.construct 就是这个顺序
//       <用户 main 的体>))
//
// **不拿旧降级当尺子**：这一层要的是"行为一致"—— 降出来的 `.sx` 跑起来与 `.expected` 相同。
// 拼不出来的那一格 `acct(为什么)`，整份源码降不动就把那几笔账当诊断报出去（不悄悄发错代码）。

import { headOf, named } from './adapt.js';
import { chainOf, allInChain, readDcl } from './declare.js';
import { readDeclType } from './types.js';
import { readSpecs } from './specs.js';
import { resolveType } from './resolve-type.js';
import { emitType } from './emit-type.js';
import { collectEnumConsts } from './const-eval.js';
import { scanAggs, scanFns, memberInit, sigOf } from './module-scan.js';
import { readBodyMembers } from './agg.js';
import { structLine, hasStatements as hasStmts } from './emit-agg.js';
/* `variant_t` 那格结构体是合成出来的（用到才发、发在最前头）—— 名字与那一行的家在 runtime。 */
import { VARIANT, variantStruct } from './runtime.js';
import {
  globalLines, addrTaken, liftable, liftedType, arrayFromCurly, staticCtorFlag,
} from './emit-global.js';
import { fnHead, readFormals, fnName, needsCtor, hasStaticCtor } from './emit-fn.js';
import { emitBody, makeCtx } from './emit-body.js';
import { makeFnEnv } from './emit-ctx.js';
import { lvalueShape, SHAPE_ACCESS } from '../common/place.js';
import { templateTable, expandTemplates, synthType } from './generic.js';
import { zeroText } from './expr-table.js';

/** 顶层那一串条目（`unit` / `unit-add` 空基例链），带上命名空间前缀。 */
function topItems(tree, out = [], ns = null) {
  for (const it0 of chainOf(tree, 'unit-add')) {
    /* **属性块是个壳**（`[attr] int g_n;`，节点表的 `attributed`）：剥掉它再看里头那一格
       —— 不剥的话整份 99-attr.jnc 里的函数与模块级量一格都发不出来。 */
    const it = headOf(it0) === 'attributed' ? (named(it0)?.decl ?? it0) : it0;
    if (headOf(it) === 'namespace') {
      const nm = named(it);
      const seg = nm === null ? null : String(named(nm.name)?.text?.value ?? '');
      const inner = seg === null || seg === '' ? ns : (ns === null ? seg : `${ns}$${seg}`);
      topItems(nm.body, out, inner);
      continue;
    }
    out.push({ it, ns });
  }
  return out;
}

/**
 * 一份语法树 → 一份方言文本。`opts.needEntry` 为真时没有 `main` 就报错（跑要入口，`sx` 不要）。
 * 降不动答 `''` 并往 `diags` 里记 —— 与旧降级同一条口径。
 */
export function lowerJncRules(tree0, diags, opts = {}) {
  const env = new Map();
  const accts = [];
  const acct = (why) => { if (!accts.includes(why)) accts.push(why); };

  /**
   * **`import "x.jnc"` 不是 #include，也不是"取一个模块对象"**（第六十刀）：它是"把那份文件的
   * 顶层条目也算进**这一个**模块里" —— 没有作用域、没有可见性、没有顺序。所以落法就是
   * **把那棵树的顶层条目并进来**，往下每一层都当它们是本文件写的（`modules.js` 顶上那段）。
   *
   * 三条与 jancy 一样（`jnc_ct_ImportMgr.cpp`）：
   *   - 找法先看 import 那份文件自己的目录，再按 `-I` 的次序（`find` 是外面递进来的，
   *     与旧那条路共用一份）；
   *   - 查重认**resolve 过的那一格**，所以 `./a.jnc` 与 `a.jnc` 是同一份（第二遍是句空话）；
   *   - 名字是**传递**的：并进来的那棵树里的 import 接着并。
   * 并进来的排在**最前头**：它们是本文件字段/形参的类型，方言那一侧要求先声明。
   *
   * `.jncx`（zip）与动态库那两族**明说不收**（这一层不解压、不读符号表）。
   */
  let tree = tree0;
  const find = opts.find ?? null;
  const parse = opts.parse ?? null;
  /* **格式化字面量里那一段要再解析一遍**（第二百刀）：词法把整个 `$"…"` 当一个记号，
     `$(x + 1)` 里头那条表达式于是要按位置重解一次。没递这个入口的那一趟明说不收。 */
  const parseExpr = opts.parseExpr ?? null;
  if (find !== null && parse !== null) {
    const seen = new Set();
    const brought = [];
    const litOf = (n) => {
      if (n === null || n === undefined || typeof n !== 'object') return null;
      if (!Array.isArray(n.items)) {
        /* 串那一格记号是 `{ kind: 'string', value: 已经脱过引号的文本 }`（词法那一层脱的）。 */
        if (n.kind === 'string' && typeof n.value === 'string') return n.value;
        return typeof n.value === 'string' && n.value.startsWith('"') ? n.value.slice(1, -1) : null;
      }
      for (const it of n.items.slice(1)) {
        const s = litOf(it);
        if (s !== null) return s;
      }
      return null;
    };
    const digImports = (n, from) => {
      if (n === null || n === undefined || typeof n !== 'object' || !Array.isArray(n.items)) return;
      if (headOf(n) === 'import') {
        const im = named(n);
        const spec = litOf(im?.path);
        if (im?.header !== null && im?.header !== undefined) {
          acct('`import "…" with "…"`（宿主的头文件）还没接'); return;
        }
        if (spec === null) { acct('import 的路径不是一格字面量'); return; }
        if (!spec.endsWith('.jnc')) {
          /**
           * **`import "X.jncx"` 在这一层是空跑**（第二百一十刀，第六十刀那条"永久边界"改成
           * 一句提醒）。那一句在 jancy 里**只**做一件事：把编译好的扩展库装进来
           * （`addImport` 里 `isExtensionLib` 那一支走 `loadDynamicLib`）。**声明不在它里头**
           * —— `io_base` 那个库的源码表是空的（jnc_io_IoLib.cpp:155-156），所以写
           * `import "io_base.jncx"` 的文件**另外**还写着 `import "io_SocketAddress.jnc"`
           * 那几句（UdpFlowMonSession.jnc:7-10 就是这个形状）：名字是从后面那几句来的。
           *
           * 于是这一句在这一层没有可发的东西：「有哪些符号」由那几句 `.jnc` import 说、
           * 「体在哪儿」由 C_ABI 那条约定说。`.jncx` 自己是构建产物（整棵参考树里一个都没有），
           * 落成一句 `(lib …)` 是发明。所以照旧不发东西，但**不再拦整份文件** —— 代价照实
           * 记一句提醒（名字写错了这一层看不出来，与 `(cabi …)` 同一笔，ADR-0022 的 J4b）。
           */
          diags.warn(null, `import "${spec}"：这一层不装编译好的扩展库 —— 声明从那几句 .jnc import 来、`
            + '体按 C_ABI 那条约定去找（这一句在这儿是空跑）');
          return;
        }
        const p = find(spec, from);
        if (p === null) { acct(`import '${spec}' 找不着`); return; }
        if (seen.has(p)) return;                         // 第二遍是句空话
        seen.add(p);
        const t2 = parse(p);
        if (t2 === null || t2 === undefined) { acct(`import '${spec}' 解不开`); return; }
        brought.push(...chainOf(t2, 'unit-add'));
        digImports(t2, p);                               // 名字是传递的
        return;
      }
      for (const it of n.items) digImports(it, from);
    };
    digImports(tree, opts.path ?? '.');
    if (brought.length > 0) {
      tree = [...brought, ...chainOf(tree, 'unit-add')].reduce(
        (acc, one) => ({ items: [{ value: 'unit-add' }, acc, one] }),
        { items: [{ value: 'unit' }] },
      );
    }
  }

  /**
   * **泛型 = 单态化**（第一百一十七刀，`generic.js`）：一格用点造一格实例。这一步排在**最前面**
   * —— 替换完那棵树上就只剩普通的 `agg` / `typedef` / `fn-def`，往下每一层（探子、字段表、
   * 发声明、发体）**一个字都不用改**。造出来的那几格插在**最前头**：它们是别人字段的类型，
   * 方言那一侧要求先声明。
   *
   * 合成实参那几条 typedef（`Box<int const*>` 的 `jnc$tp$int_const_p`）直接进类型环境。
   * 解不出来的那几笔照实记账（不猜）。
   */
  const templates = templateTable(tree);
  /* **体外写的那几格泛型成员**（`T Box<T>.fetch() {…}`）：`expandTemplates` 会跟着每格实例
     各替换出来一份，所以**原来那几条不发码** —— 按节点认（下面那一遍靠它跳过去）。 */
  const tmplOuters = new Set();
  for (const tm of templates.values()) for (const o of (tm.outer ?? [])) tmplOuters.add(o);
  if (templates.size > 0) {
    const ex = expandTemplates(tree, templates);
    for (const [w, n] of ex.fails) acct(`泛型：${w}（${n} 处）`);
    for (const [syn, e] of ex.typedefs) {
      env.set(syn, { kind: 'typedef', type: synthType(e), name: syn });
    }
    const head = [];
    for (const td of ex.tdefs.values()) if (td !== null && td !== undefined) head.push(td);
    for (const ag of ex.insts.values()) if (ag !== null && ag !== undefined) head.push(ag);
    for (const os of ex.outers.values()) head.push(...os);
    /* 顶层那条链是左递归的空基例（`(unit)` + `unit-add`）—— 照它的形状重搭一条。 */
    tree = [...head, ...chainOf(ex.tree, 'unit-add')].reduce(
      (acc, one) => ({ items: [{ value: 'unit-add' }, acc, one] }),
      { items: [{ value: 'unit' }] },
    );
  }

  collectEnumConsts(tree, env);
  /* **同名那一族**（第五十八刀）：基名 → 一串 `{ key, asig }`。两遍扫（聚合体那遍与顶层那遍）
     记在**同一张**表里 —— 类体里那句原型与体外那个定义是同一格，签名一样就不该多出一号。 */
  const ovl = new Map();
  const {
    fields: aggFields, ctors: aggCtors, vars: globals, gEmit, gProps, methods, fieldInits,
    bindable: gBindable, roots, aggs, statics: aggStatics, props: aggProps, bases: aggBases,
    overloads, fieldPaths: aggPaths, aggAliases, gAlias,
  } = scanAggs(tree, env, ovl);
  const fns = scanFns(tree, env, ovl);
  const gLifted = addrTaken(tree);
  const clsRoot = (n) => roots.get(n) ?? n;
  const tyc = { clsRoot };
  /* **动态类型的标签**（第五十七刀）：一格类一个号，**从 1 起**（0 是"这一格没写过"，
     撞不上任何一个类）。造对象时写死它，虚派发那一段按它分派 —— 两处认的是同一张表。 */
  const tags = new Map();
  for (const a of aggs) {
    if (a.word !== 'class' && a.word !== 'opaque class') continue;
    if (a.emitName !== null) tags.set(a.emitName, tags.size + 1);
  }

  const decls = [];
  const cells = [];                                    // 模块级那几格量的 pnew
  const inits = [];                                    // 模块级那几格量的初值
  let mainBody = null;
  const tmpBox = { n: 0 };
  const ecBox = { n: 0 };
  /** 一份模块只发一次的那几格助手（`jnc$asgn$T` 那一族）—— 键就是它的名字。 */
  const helperBox = new Set();
  /**
   * **虚派发那张表**：`<接收方的静态类型>$<方法名>` → 分派函数的名字（`B$$vd$show`）。
   * 早声明是因为体那一层的探子（`makeFnEnv`）要收着它 —— 真填在下面"虚派发"那一段
   * （那时方法表已经齐了，合成出来的构造也在里头）。
   */
  const vdispatch = new Map();

  /**
   * **模块级那一层的初值**（jancy 的 `module.construct`）：`int counter = 3;` 里右边那一格
   * 是一整条表达式，所以它要的正是**函数体那一层**的探子。这儿借一格"没有函数节点"的
   * 探子（`fnNode: null` —— 没有形参、没有返回类型、`this` 也没有），于是初值与函数体里
   * 的表达式**走同一份规则**，不是第二份实现。
   *
   * 一格模块只造一次（临时号与 errorcode 的号都在那两个盒子里连着数）。
   */
  let modEnv = null;
  const modInit = () => {
    if (modEnv === null) {
      const e = makeFnEnv({
        fnNode: null,
        env,
        acct: (w) => acct(`模块级的初值：${w}`),
        fns,
        aggFields,
        aggPaths,
        aggAliases,
        gAlias,
        vdispatch,
        ovl,
        parseExpr,
        aggCtors,
        ecBox,
        helperBox,
        tmpBox,
        globals,
        gLifted,
        gBindable,
        gEmit,
        gProps,
        methods,
        tags,
        fieldInits,
        roots,
        aggStatics,
        aggProps,
        aggBases,
      });
      modEnv = { e, ctx: makeCtx(e) };
    }
    return modEnv;
  };

  /* ---------------------------------------------------------- 1. 聚合体 */
  for (const a of aggs) {
    /* 类那一族**一整条继承链只发一格**（第五十六刀）：不是根的不发。 */
    if ((a.word === 'class' || a.word === 'opaque class')
      && (roots.get(a.emitName) ?? a.emitName) !== a.emitName) continue;
    const bitsOne = new Map();
    const line = structLine(a, env, aggs, bitsOne);
    if (line === null || line.line === null) { acct(`聚合体 '${a.emitName}' 还发不出来`); continue; }
    /**
     * **位域落在哪一格存储上，发结构体那一遍已经算过了**（第一百一十二刀）—— 读写两侧照它算，
     * 布局这件事于是只有一处家。收进的是"字段路径"那张表（位域也是**一条路**加上"哪几位"），
     * 所以取字段那一处照旧一问就查得着。
     * 类那一族一整条链只发一格结构体，可源码里写的是**派生类**的名字 —— 所以链上每一格都记。
     */
    if (bitsOne.size > 0) {
      const chain = new Set([a.emitName, ...aggs
        .filter((x) => (roots.get(x.emitName) ?? x.emitName) === a.emitName)
        .map((x) => x.emitName)]);
      for (const nm of chain) {
        const t = aggPaths.get(nm) ?? new Map();
        for (const [k, v] of bitsOne) if (!t.has(k)) t.set(k, v);
        aggPaths.set(nm, t);
      }
    }
    /* `lines` 是**整批**（union 里套的匿名 struct 排在前头、自己那一行在最后）——
       前头那几行是这一行里字段的类型，方言那一侧要求先声明（103-unionstruct.jnc）。 */
    for (const l of line.lines ?? [line.line]) decls.push(`  ${l}`);
  }

  /* ------------------------------------- 1b. 静态字段（类那一层上的"模块级量"） */
  /**
   * **`static int m_count;` 不在对象里**（第二百一十五刀）：它就是一格模块级的量，名字带上
   * 东家那一段前缀。所以这儿走的是与命名空间里那一格量**同一条路** —— `globalLines` 发
   * `(global C$m_count int)`、要内存的摆一句 pnew、写了初值的进 `inits`。一个字节的新机器都没造。
   */
  for (const [owner, tbl] of aggStatics) {
    for (const st of tbl.values()) {
      /* 合过的表里有基类那几格（派生类里也看得见它们）—— 发的时候只发自己那几格。 */
      if (st.owner !== owner) continue;
      /* 长度写空的（`static int m_table[] = { 10, 20, 12 };`）从花括号里数 —— 与模块级、
         局部那两处用的是同一份 `arrayFromCurly`（183-staticcurly.jnc）。这一格要**先算出来**：
         发 `(global …)` 那一行本身就要那个长度，少了它整格连声明都发不出来。 */
      const cvs = st.init !== null && st.init.curly === true ? st.init.value
        : (st.curlyValue ?? null);
      const g = globalLines(st, env, {
        ns: owner, clsRoot, taken: gLifted, curly: cvs,
      });
      for (const l of g.lines) decls.push(`  ${l}`);
      if (g.why !== null) {
        if (!g.why.includes('对的行为')) acct(`静态字段 '${st.emit}'：${g.why}`);
        continue;
      }
      let r = resolveType(st.type, env);
      if (r.type === null && cvs !== null) {
        const inferred = arrayFromCurly({ name: st.name, type: st.type, at: st.at }, env, cvs);
        if (inferred !== null) r = { type: inferred, why: null };
      }
      /* 直接用 `var-decl-curly` 那一格的也走花括号那条路。 */
      const hasCurly = cvs !== null;
      if (r.type === null) { acct(`静态字段 '${st.emit}'：${r.why}`); continue; }
      if (gLifted.has(st.name) && liftable(r.type)) {
        acct(`静态字段 '${st.emit}' 被取过地址（要提成一格 (ptr T)）还没接`); continue;
      }
      if (r.type.k === 'struct' || r.type.k === 'arr') {
        cells.push(`    (set ${st.emit} (pnew ${emitType(r.type, 'slot', tyc)} (int 1)))`);
      }
      if (st.init === null && !hasCurly) continue;
      /* **花括号初值按格子写**（模块级那一层的探子发，排在 pnew 之后）。 */
      if (hasCurly) {
        if (r.type.k !== 'arr' && r.type.k !== 'struct') {
          acct(`静态字段 '${st.emit}' 的花括号初值落在 ${r.type.k} 上（那不是一整块）还没接`); continue;
        }
        const mi2 = modInit();
        const ls2 = mi2.e.curlyLines(`(var ${st.emit})`, r.type, cvs, '    ');
        if (ls2 === null) continue;                          // 账已经记过
        inits.push(...ls2);
        continue;
      }
      if (r.type.k === 'struct' || r.type.k === 'arr' || r.type.k === 'class') {
        acct(`静态字段 '${st.emit}' 写了初值的聚合体（要逐字段抄一份）还没接`); continue;
      }
      const mi = modInit();
      const v = mi.ctx.expr(st.init.value, mi.e.withBits(r.type, st.type));
      if (v === null) continue;                            // 账已经记过
      inits.push(`    ${SHAPE_ACCESS.var.write(st.emit, v)}`);
    }
  }

  /* ---------------------------------------------------------- 2. 顶层条目 */
  const items = topItems(tree, [], null);

  /* 先发**模块级那几格量**（`(global …)` 要排在函数之前：初值里能调函数，可声明得先在）。 */
  for (const { it, ns } of items) {
    const h = headOf(it);
    if (h !== 'var-decl' && h !== 'var-decl-curly') continue;
    const vn = named(it);
    if (vn === null) continue;
    const sp = readSpecs(vn.specs);
    const storage = sp === null ? [] : sp.words;
    /* **`alias` 不是一格量**（`alias Hue = Color;` / `alias dbl = twice;`，第八十七刀）：
       它没有存储 —— "这个名字指着谁"在探子那一遍就登记好了，这儿一个字都不发。 */
    if (storage.includes('alias')) continue;
    const dcls = h === 'var-decl-curly' ? [vn.dcl] : allInChain(vn.dcls, 'dcls-add', 'dcls');
    for (const d of dcls) {
      const isInit = headOf(d) === 'init';
      const dcl = isInit ? named(d)?.dcl : d;
      const t = readDeclType(vn.specs, dcl);
      if (t === null || t.name === null) { acct('模块级那一格量的名字读不出来'); continue; }
      const m = {
        name: t.name, type: t, shape: t.shape, storage, at: it,
      };
      /* **带花括号初值的那一格**（`int table[3] = { 10, 20, 30 };`）：初值躺在 `var-decl-curly`
         的 `value` 洞里，不是一格 `init` 节点 —— 底下"写了初值"那一支照不到它，所以这一格
         自己走一条：先摆一句 pnew，再**按格子写**（`curlyLines`）。
         长度写空的（`int a[] = {1,2,3}`）从花括号里数（`arrayFromCurly`，与 `(global …)`
         那一行用的是同一份）。 */
      if (h === 'var-decl-curly') {
        const g2 = globalLines(m, env, { ns, clsRoot, taken: gLifted });
        for (const l of g2.lines) decls.push(`  ${l}`);
        if (g2.why !== null) {
          if (!g2.why.includes('对的行为')) acct(`模块级 '${t.name}'：${g2.why}`);
          continue;
        }
        const rc = resolveType(t, env).type ?? arrayFromCurly(m, env);
        if (rc === null) { acct(`模块级 '${t.name}'：花括号那一格的类型认不出来`); continue; }
        if (rc.k !== 'arr' && rc.k !== 'struct') {
          acct(`模块级 '${t.name}' 的花括号初值落在 ${rc.k} 上（那不是一整块）还没接`); continue;
        }
        /* **写了花括号初值又被 `&` 取过地址不是两件难事**（第二百一十八刀，23-addr-global.jnc）：
           走到这儿的只有结构体与数组，而它们那一格里放的**本来就是地址**（第十二 / 二十一刀）
           —— `&t` 一个字都不发，压根没有"提到堆上"那一步。局部量那一处同一条。 */
        const full = ns === null ? t.name : `${ns}$${t.name}`;
        cells.push(`    (set ${full} (pnew ${emitType(rc, 'slot', tyc)} (int 1)))`);
        const mi2 = modInit();
        const ls = mi2.e.curlyLines(`(var ${full})`, rc, vn.value, '    ');
        if (ls === null) continue;                         // 账已经记过
        inits.push(...ls);
        continue;
      }
      const g = globalLines(m, env, { ns, clsRoot, taken: gLifted });
      for (const l of g.lines) decls.push(`  ${l}`);
      /**
       * `why` 里有两种不同的东西，混在一起记账就把"做对了"记成了"还没做"：
       *   - **"（对的行为）"那几条**：这一格本来就不发存储（不带 `autoget`/`bindable` 的属性、
       *     函数的前向声明…）—— 不是缺口，往下也不用摆 pnew 与初值；
       *   - 别的：真的拼不出来，记账。
       */
      if (g.why !== null) {
        if (!g.why.includes('对的行为')) acct(`模块级 '${t.name}'：${g.why}`);
        continue;
      }
      /* **属性那一格不是一格内存**（读写各是一次调用）：存储那几行上面已经发了，
         底下 pnew / 初值那一套是给"一格量"用的，属性走不到那儿。 */
      if (t.shape === 'prop' || t.shape === 'event') {
        /* **`autoget` / `bindable` 生成的那格存储**（`<属性>$m_value`）：被取过地址时它是一格
           `(ptr T)`（第二十四刀）—— 那就要一句 pnew，不然取值器 `pload` 的是一条空指针
           （67-propauto.jnc 量出来就是"null pointer dereference"）。 */
        const pmods = t.mods ?? [];
        if (pmods.includes('autoget') || pmods.includes('bindable')) {
          const rp = resolveType({ ...t, shape: 'data' }, env);
          const boxed = (gLifted.has(t.name) || gLifted.has('m_value'))
            && rp.type !== null && liftable(rp.type);
          if (boxed) {
            const store = `${ns === null ? t.name : `${ns}$${t.name}`}$m_value`;
            cells.push(`    (set ${store} (pnew ${liftedType(rp.type, tyc)} (int 1)))`);
          }
        }
        continue;
      }
      /* 要一段自己的内存的那几格（结构体 / 数组 / 提过的标量）：一句 pnew 排在初值之前。 */
      const r = resolveType(t, env);
      if (r.type === null) { acct(`模块级 '${t.name}'：${r.why}`); continue; }
      const full = ns === null ? t.name : `${ns}$${t.name}`;
      const box = gLifted.has(t.name) && liftable(r.type);
      if (r.type.k === 'struct' || r.type.k === 'arr') {
        const st = emitType(r.type, 'slot', tyc);
        cells.push(`    (set ${full} (pnew ${st} (int 1)))`);
      } else if (r.type.k === 'class' && (t.ptrs ?? 0) === 0) {
        /**
         * **模块级的类变量**（`Counter g_c;` / `Point g_p(3, 4);`，49-class.jnc / 50-construct.jnc）：
         * jancy 里这是"程序一起来就造好的一格对象"（`module.construct`），与局部量
         * `Counter c;` **同一条路** —— pnew + 写 `$tag` + 构造。所以直接借 `newObj`
         * （它会按默认实参补、会明说不收），声明符尾巴上那对括号就是构造实参。
         * 少这一步，`g_p.area()` 拿到的是一段全零的内存（量出来那一行是 `0 0`，该是 `12 42`）。
         */
        const ct0 = named(t.raw?.dcl)?.ctor;
        const cargs0 = headOf(ct0) === 'ctor'
          ? allInChain(named(ct0)?.args, 'args-add', 'args') : [];
        const o0 = modInit().e.newObj(r.type.name, cargs0);
        if (o0 === null) continue;                           // 账已经记过
        cells.push(`    (set ${full} ${o0.code})`);
      } else if (box) {
        const pt = liftedType(r.type, tyc);
        cells.push(`    (set ${full} (pnew ${pt} (int 1)))`);
      }
      if (isInit) {
        /* 初值那一句由**函数体那一层**降（它认表达式）—— 借模块级那一格探子。 */
        /**
         * **模块级那一格聚合体写了初值**（`int h[3] = g;`，第二百零八刀）：结构体与数组是
         * **按值的一整块**（第十二 / 二十一刀），所以这一句不是一次 `pstore` —— 是"逐字段 /
         * 逐格搬"（`copyLines`，与局部量 `int b[3] = a;`、按值传形参共用同一份模板）。
         * 那一格的内存上头已经 pnew 出来了，这儿只把源头搬进去。
         * 类那一族另算（写了初值的类变量要"先造对象、再拿初值调 `operator :=`"）。
         */
        if (r.type.k === 'struct' || r.type.k === 'arr') {
          const mi0 = modInit();
          const sv = mi0.ctx.expr(named(d)?.value, r.type);
          if (sv === null) continue;                    // 账已经记过
          const ls0 = mi0.e.copyLines(`(var ${full})`, sv, r.type, '    ');
          if (ls0 === null) {
            acct(`模块级 '${t.name}' 的初值抄不出来（字段表/环那两格）`); continue;
          }
          inits.push(...ls0);
          continue;
        }
        if (r.type.k === 'class') {
          /* **模块级那一格类变量写了初值**（`SB g_a = 5;`，第二百零九刀）：上头那一支已经把
             对象造好了（pnew + `$tag` + 构造），这儿只补"拿初值调 `operator :=`"那一句 ——
             与局部量那一处共用同一份（`opAssignLines`）。没写那个算符的照旧记账不收。 */
          const mi1 = modInit();
          const ls1 = mi1.e.opAssignLines(`(var ${full})`, r.type, named(d)?.value, '    ');
          if (ls1 === null) {
            acct(`模块级 '${t.name}' 写了初值的类变量（要 operator :=）还没接`); continue;
          }
          inits.push(...ls1);
          continue;
        }
        const mi = modInit();
        const v = mi.ctx.expr(named(d)?.value, mi.e.withBits(r.type, t));
        if (v === null) continue;                       // 账已经记过
        const shape = lvalueShape({
          isStruct: false, isArr: false, isGlobal: true, gLifted: box, lifted: false,
        });
        const code = shape === 'var' ? full : `(var ${full})`;
        inits.push(`    ${SHAPE_ACCESS[shape].write(code, v)}`);
      } else if (r.type.k !== 'struct' && r.type.k !== 'arr' && !box) {
        const z = zeroText(r.type, { tyText: (x) => emitType(x, 'value', tyc), clsRoot });
        if (z !== null && r.type.k === 'string') inits.push(`    (set ${full} ${z})`);
      }
    }
  }

  /**
   * 发**一格函数或方法**的整段（头 + 体 + 它要的模块级槽）。三处共用它：顶层函数、
   * 体写在类里的方法、体写在类外的方法（`int P.scaled(int k){…}`）—— 三者只差
   * "东家是谁"与"`this` 那一格怎么写"，所以不该有三份实现。
   *
   * `owner` 是方言那一侧的前缀（命名空间或东家），`selfInfo` 为 null 就是没有 `this`。
   * `head0` 是**插在体之前**的那几行（字段初值那一族：jancy 把它们放在基类构造之后、
   * 用户的体之前，jnc_ct_Parser.cpp:3005-3009）。`inProp` 告诉 `fnHead` 这是属性体里的函数。
   */
  const emitFn = (node, shown, owner, selfInfo, ns, propScope = null, head0 = [], inProp = false,
    dup = 0, headAs = null) => {
    const nm = named(node);
    const t = nm === null ? null : readDeclType(nm.specs, nm.dcl);
    if (t === null) { acct(`函数 '${shown}' 的类型读不出来`); return; }
    const sp = readSpecs(nm.specs);
    const m = {
      name: t.name, type: t, shape: t.shape, storage: sp === null ? [] : sp.words, at: node, ns,
    };
    const selfTy = selfInfo === null ? null
      : emitType(selfInfo.kind === 'class' ? { k: 'class', name: selfInfo.agg }
        : { k: 'struct', name: selfInfo.agg }, 'slot', tyc);
    /* **重载那一格的号**（第五十八刀）：名字由 `overloadSuffix` 拼（`f$o1`）—— 扫那一遍
       记的号（`dup`）与这儿发的名字走的是同一格函数，两头才对得上。 */
    /* **头由调用方给**那一格（`headAs`）：属性的**简写取值器**（第一百三十九刀）那对花括号
       就是取值器的体，可声明符上压根没有形参表 —— 送去 `fnHead` 只会报"认不出形参表"。
       名字、形参（只有 `$this`）与返回类型都由那一处按属性自己那格类型拼好递进来。 */
    const hd = headAs !== null ? { head: headAs, why: null } : fnHead(m, env, {
      owner, self: selfTy, clsRoot, inProp, dup,
    });
    if (hd === null || hd.head === null) { acct(`函数 '${shown}' 的头还发不出来（${hd?.why ?? '?'}）`); return; }
    const e = makeFnEnv({
      fnNode: node,
      env,
      acct: (w) => acct(`${shown}：${w}`),
      fns,
      aggFields,
      aggPaths,
      aggAliases,
      gAlias,
      vdispatch,
      ovl,
      parseExpr,
      aggCtors,
      methods,
      tags,
      fieldInits,
      self: selfInfo,
      ecBox,
      helperBox,
      tmpBox,
      globals,
      gLifted,
      gBindable,
      gEmit,
      gProps,
      propScope,
      roots,
      aggStatics,
      aggProps,
      aggBases,
    });
    /* **`int main()` 落成方言的入口 `(main …)`，那一格不回值**：所以体那一层看见的是
       "回 void 的函数"，`return 0;` 就是一句 `(ret)`（`returnKind` 里 `inMain` 那一条），
       回非 0 的那一格明说不收（方言的入口没有退出码）。 */
    const isMain = t.name === 'main' && ns === null && selfInfo === null;
    if (isMain) { e.retVoid = true; e.inMain = true; e.retType = null; }
    /* **答 null 必须留下一笔账**：不然这一格函数就静静地不见了 —— `(fn check …)` 没发出来，
       而调它的那几处照旧发 `(call check …)`（170-throw.jnc 就是这么坏的）。 */
    const n0 = accts.length;
    const body = emitBody(nm.body, e, 4);
    if (body === null) {
      if (accts.length === n0) acct(`函数 '${shown}' 的体答了 null 却没记账（这一层的 bug）`);
      return;
    }
    const whole = [...e.pre, ...head0, body].join('\n');
    /* 体那一层要的**模块级槽**（`once` 的旗子、`static` 局部量那一格与它的闸门）：
       发在函数**前面** —— 方言那一侧先声明后用。 */
    for (const s of e.slots) decls.push(`  (global ${s.name} ${s.ty})`);
    /* 抬出去的那几格（造对象那三句）—— 与槽同一条：发在用它的那格函数前面。 */
    for (const hh of e.helpers) decls.push(hh);
    if (isMain) { mainBody = whole; return; }
    decls.push(`  ${hd.head}\n${whole})`);
  };

  /**
   * **这一格类有没有"零实参就能调"的构造**（第二百一十二刀）：形参全带默认值也算。同名那一族
   * （`construct()` / `construct(int)`）里有一条算得上就答 false —— 自动补那一次调它。
   * 一条都没有（而构造确实在）才答 true：那时候这一格由**写的人**在自己的构造里调
   * （type_class.rst 那句 "if a member field requires construction this must be done in the
   * beginning of the constructor"）。压根没有构造的答 false —— 那一路没什么可调的，
   * 而"字段写了初值却没有构造"那条界照旧由 `newObj` 自己守。
   */
  const ctorNeedsArgs = (cn) => {
    const base = `${cn}$construct`;
    const fam = ovl.get(base) ?? [{ key: base }];
    let had = false;
    for (const one of fam) {
      const s = methods.get(one.key);
      if (s === undefined) continue;
      had = true;
      const ps = s.params ?? [];
      const ds = s.defaults ?? [];
      if (ps.every((_, i) => ds[i] !== null && ds[i] !== undefined)) return false;
    }
    return had;
  };

  /**
   * **字段的默认值**（第七十八刀）：jancy 那儿它们不是"预构造"—— 初值挂在字段上，由
   * `MemberBlock::initializeFields`（jnc_ct_MemberBlock.cpp:141-182）在**构造里**重放，
   * 次序是"基类构造 → 静态构造 → 字段初值 → 用户的体"（jnc_ct_Parser.cpp:3005-3009）。
   *
   * 所以这一层答的就是那几行 `(pstore (pfield (var $this) f) 值)` —— 两处用它：合成出来的
   * 构造、以及**插在人写的 `construct` 开头**。初值是一整条表达式（能引用模块级量、别的字段、
   * 同类的方法），所以借的是**函数体那一层**的探子（`self` 指着这个类）。
   *
   * 按**声明序**发（`m_y = m_x + 1` 看得见 `m_x` 的初值 —— 次序即规则）。拼不出来答 null。
   */
  const fieldInitLines = (a, pad) => {
    const cls = a.emitName;
    const kind = a.word === 'class' || a.word === 'opaque class' ? 'class' : 'struct';
    const e = makeFnEnv({
      fnNode: null,
      env,
      acct: (w) => acct(`'${cls}' 的字段初值：${w}`),
      fns,
      aggFields,
      aggPaths,
      aggAliases,
      gAlias,
      vdispatch,
      ovl,
      parseExpr,
      aggCtors,
      methods,
      tags,
      fieldInits,
      self: { agg: cls, kind, emit: kind === 'class' ? clsRoot(cls) : cls },
      ecBox,
      helperBox,
      tmpBox,
      globals,
      gLifted,
      gBindable,
      gEmit,
      gProps,
      roots,
      aggStatics,
      aggProps,
      aggBases,
    });
    const ctx = makeCtx(e);
    const out = [];
    for (const m of a.members) {
      if (m.name === null || m.type === null) continue;
      if (m.shape !== 'data' && m.shape !== 'array' && m.shape !== 'fnptr') continue;
      if (m.storage.includes('static') || m.storage.includes('alias')) continue;
      const init = memberInit(m);
      const r = resolveType(m.type, env);
      if (r.type === null) { acct(`'${cls}.${m.name}' 的初值：${r.why}`); return null; }
      /**
       * **内嵌的对象字段**（第一百六十一刀）：字段的类型是**类**时那一格是一格真对象 ——
       * 在父对象的构造里造出来（`ClassType::calcLayout` 的 `m_classFieldArray`，
       * jnc_ct_ClassType.cpp:360-376）。这一层的类值本来就是"一格地址 + 一次 pnew"，
       * 所以它就是"把 `newObj` 那一格的结果写进这个字段"——与局部量 `Inner in;` 同一条路。
       */
      if (r.type.k === 'class') {
        if (init !== null) {
          acct(`'${cls}.${m.name}' 是内嵌的对象却写了初值（那一族还没接）`); return null;
        }
        /**
         * **它的构造要实参的那一格不在这儿自动构造**（第二百一十二刀，195-embctor.jnc）：
         * type_class.rst 那句话说得明白 —— "if a member field requires construction this must
         * be done in the beginning of the constructor (much like with base type constructors)"。
         * 所以这一层只把那段内存开出来（pnew + 写 `$tag`），那次 `m_in.construct(x)` 由**写的人**
         * 在自己的构造里调（与 `basetype.construct(…)` 逐字同一条路）。
         *
         * 判据是"这一格有没有一条零实参就能调的构造"（形参全带默认值也算）：有就照旧自动补，
         * 没有才交给写的人。猜着补一格实参是发明。
         */
        const needs = ctorNeedsArgs(r.type.name);
        const o = e.newObj(r.type.name, [], needs);
        if (o === null) return null;                       // 账已经记过
        out.push(`${pad}(pstore (pfield (var $this) ${m.name}) ${o.code})`);
        continue;
      }
      /* **内嵌的结构体**：它就地布局，所以要构造的话就是"拿它那一格的地址调它的构造"。
         没有构造的那种不用发字（那段内存本来是零）。 */
      if (r.type.k === 'struct') {
        if (init !== null) {
          acct(`'${cls}.${m.name}' 写了初值的结构体字段（要逐字段抄一份）还没接`); return null;
        }
        const sn = r.type.name;
        const wants = aggCtors.has(sn) || synth.has(sn);
        if (!wants) continue;
        if (!methods.has(`${sn}$construct`)) {
          acct(`'${cls}.${m.name}'：内嵌的 '${sn}' 要构造，可那一格还没发出来`); return null;
        }
        if ((methods.get(`${sn}$construct`).params ?? []).length > 0) {
          acct(`'${cls}.${m.name}'：内嵌的 '${sn}' 的构造要实参 —— 补不出来`); return null;
        }
        out.push(`${pad}(expr (call ${sn}$construct (pfield (var $this) ${m.name})))`);
        continue;
      }
      if (init === null) continue;
      if (init.curly === true) {
        acct(`'${cls}.${m.name}' 的花括号初值（要逐格抄一份）还没接`); return null;
      }
      if (r.type.k === 'arr') {
        acct(`'${cls}.${m.name}' 写了初值的数组字段（要逐格抄一份）还没接`); return null;
      }
      const v = ctx.expr(init.value, e.withBits(r.type, m.type));
      if (v === null) return null;                         // 账已经记过
      out.push(`${pad}(pstore (pfield (var $this) ${m.name}) ${v})`);
    }
    /**
     * **完整声明式属性体里那几格字段写了初值**（`property m_p { int m_v = 7; … }`，
     * 152-propfieldinit.jnc）：那几格存储就是**这个类的字段**（名字带上属性那一段，
     * `C$m_p$m_v`）—— 所以初值那一句与普通字段一模一样，只是名字长一节。
     * 花括号/聚合体那几族照旧明说不收（与普通字段同一条界）。
     */
    for (const m of a.members) {
      if (m.shape !== 'prop' || m.name === null) continue;
      const body = named(m.at)?.body;
      if (headOf(body) !== 'compound') continue;
      for (const im of readBodyMembers(body)) {
        if (im.name === null || im.type === null) continue;
        if (im.shape !== 'data' && im.shape !== 'array' && im.shape !== 'fnptr') continue;
        const ini = memberInit(im);
        if (ini === null) continue;
        const rr = resolveType(im.type, env);
        if (rr.type === null) { acct(`'${cls}.${m.name}.${im.name}' 的初值：${rr.why}`); return null; }
        if (ini.curly === true || ['arr', 'struct', 'class'].includes(rr.type.k)) {
          acct(`'${cls}.${m.name}.${im.name}' 的初值落在 ${rr.type.k} 上（要逐格抄一份）还没接`);
          return null;
        }
        const v2 = ctx.expr(ini.value, e.withBits(rr.type, im.type));
        if (v2 === null) return null;                        // 账已经记过
        out.push(`${pad}(pstore (pfield (var $this) ${cls}$${m.name}$${im.name}) ${v2})`);
      }
    }
    /* 初值里要的那几格模块级槽与抬出去的 helper（`new` 那三句）—— 与函数体那条同一条路。 */
    for (const s of e.slots) decls.push(`  (global ${s.name} ${s.ty})`);
    for (const hh of e.helpers) decls.push(hh);
    if (e.pre.length > 0) { acct(`'${cls}' 的字段初值要体首那几行（按值传那一族）还没接`); return null; }
    return out;
  };

  /**
   * **合成出来的构造**（第七十八 / 九十四刀）：一格类自己没写 `construct`，可**基类有**、
   * 或者**字段写了初值** —— jancy 那儿编译器给它生成一格
   * （jnc_ct_DerivableType.cpp:465-472 / 909-927），里头先逐格调基类那一个、再放字段初值。
   *
   * 别的理由（事件、`bindable` / `autoget`、`static construct`、成员自己带构造）各是自己
   * 一刀 —— 那几格记账，绝不发一格漏了半截的构造冒充"造好了"。
   *
   * 收敛着来（基类先于派生类定下来），因为"基类有没有构造"本身也可能是合成出来的。
   */
  /**
   * **`static construct` 落成一道只跑一次的闸门**（第一百三十三 / 二百五十六刀）：
   * jancy 的静态构造在"第一次用到这个类"时跑一遍，这一层把那件事钉在**实例构造的开头**
   * —— 一格模块级 bool 当旗子（`<类>$construct$static$1`），没举起来就举起来、再调一次
   * `<类>$construct$static`（193-staticctorns.jnc / 50-construct.jnc 的真输出）。
   *
   * 两处共用它：合成出来的构造、以及人写的构造（那时插在体的最前头）。
   */
  const staticGate = (a, cls, pad) => {
    if (!hasStaticCtor(a)) return [];
    const flag = `${cls}$construct$static$1`;
    decls.push(`  ${staticCtorFlag(cls)}`);
    return [
      `${pad}(if (un "!" (var ${flag}))`,
      `${pad}  (do`,
      `${pad}    (set ${flag} (bool true))`,
      `${pad}    (expr (call ${cls}$construct$static))))`,
    ];
  };
  const synth = new Map();                               // 类 → { bases, agg }
  {
    const hasCtorOf = (cn) => methods.has(`${cn}$construct`) || synth.has(cn);
    /* **结构体那一侧也要合成**（第二百一十六刀，120-structctor.jnc 的 `Wrap`）：里头内嵌一格
       带构造的结构体，而它自己一个 `construct` 都没写 —— 不合成的话那一格停在零值上，
       而源码明明写着 `Inner.construct`。判据与类那一侧逐条同一份，只差 `this` 那一格的类型
       （结构体就是它自己，不过 `clsRoot`、也没有 `$tag`）。union 不在里头（几格挤在同一段
       内存上，"逐格构造"这句话在那儿没有意义）。 */
    const pending = aggs.filter((a) => a.word === 'class' || a.word === 'opaque class'
      || a.word === 'struct');
    /* **这几族这一层还接不上**：有它们在就不合成（否则发出来的构造漏了半截）。
       **属性自己不算一格理由**：写出来的那对取/存是两格函数、体里那几格字段就是普通字段
       （初值那几句由 `fieldInitLines` 发，152-propfieldinit.jnc）—— 真要另一套的是
       `autoget` / `bindable` 生成的那一格（下面那条）与事件、反应器。
       **`static construct` 也不算**：它落成"一道只跑一次的闸门 + 一次调用"（`staticGate`）。 */
    const otherReason = (a) => a.members.some((m) => m.shape === 'event' || m.shape === 'reactor')
      || a.members.some((m) => ['bindable', 'autoget'].some((w) => (m.type?.mods ?? []).includes(w)));
    /* **内嵌的对象字段**（类的字段、或带构造的结构体字段）也要一格构造 —— 它是合成的理由之一。 */
    const hasEmbedded = (a) => a.members.some((m) => {
      if (m.shape !== 'data' || m.type === null || m.type.ptrs !== 0) return false;
      const r = resolveType(m.type, env);
      if (r.type === null) return false;
      if (r.type.k === 'class') return true;
      return r.type.k === 'struct' && aggCtors.has(r.type.name ?? '');
    });
    for (let pass = 0; pass < pending.length + 1; pass += 1) {
      let grew = false;
      for (const a of pending) {
        const cls = a.emitName;
        if (cls === null || synth.has(cls) || methods.has(`${cls}$construct`)) continue;
        if (!needsCtor(a, env) || otherReason(a)) continue;
        const bs = (aggBases.get(cls) ?? []).filter((b) => hasCtorOf(b));
        /* 合成的**理由**有四样：基类要构造、字段带初值、内嵌的对象、以及**有静态构造**
           （那一格实例构造里就只有那道闸门，193-staticctorns.jnc）。 */
        if (bs.length === 0 && !fieldInits.has(cls) && !hasEmbedded(a) && !hasStaticCtor(a)) continue;
        synth.set(cls, { bases: bs, agg: a });
        grew = true;
      }
      if (!grew) break;
    }
    for (const a of pending) {
      const cls = a.emitName;
      if (cls === null || synth.has(cls) || methods.has(`${cls}$construct`)) continue;
      if (needsCtor(a, env)) {
        acct(`合成 '${cls}' 的构造（事件 / bindable / static construct / 成员自己带构造那几族）还没接`);
      }
    }
    for (const [cls, s] of synth) {
      const selfTy = s.agg.word === 'struct' ? `(ptr ${cls})` : `(ptr ${clsRoot(cls)})`;
      const fi = fieldInitLines(s.agg, '    ');
      if (fi === null) continue;                           // 账已经记过
      const lines = [
        ...staticGate(s.agg, cls, '    '),
        ...s.bases.map((b) => `    (expr (call ${b}$construct (var $this)))`),
        ...fi,
      ];
      decls.push(`  (fn ${cls}$construct (($this ${selfTy})) void\n${lines.join('\n')})`);
      /* 造对象与 `basetype.construct(…)` 两处查的是同一张方法表 —— 合成的这一格也得在里头。 */
      methods.set(`${cls}$construct`, {
        params: [],
        defaults: [],
        ret: null,
        retDecl: null,
        emit: `${cls}$construct`,
        ec: false,
        stat: false,
        owner: cls,
        name: 'construct',
        node: null,
        hasBody: false,
      });
    }
  }

  /**
   * **完整声明式属性的取/存两个体**（`property g_p { int get() {…} void set(int x) {…} }`，
   * prop_full.rst:15）：那对花括号里是**两格函数**，在方言里就是 `<属性名>$get` /
   * `<属性名>$set`（成员属性头上多一格 `$this`）。那对花括号还开了一层作用域 ——
   * 里头裸写 `m_value` 指的是这格属性生成的存储，所以把它当 `propScope` 递进去。
   *
   * 发得出来答 true；那对花括号里没有取/存（简写取值器、`autoget` / `bindable` 那几族）答 false。
   */
  /** 这一格属性写了 `bindable` 吗（写了就多生成一格事件 `<属性>$m_onChanged`，第一百一十七刀）。 */
  const mcOf = (node) => {
    const nm0 = named(node);
    const t0 = nm0 === null ? null : readDeclType(nm0.specs, nm0.dcl);
    return (t0?.mods ?? []).includes('bindable');
  };
  const emitPropBody = (node, emitName, selfInfo, ns, store, field = false) => {
    const body = named(node)?.body;
    if (headOf(body) !== 'compound') return false;
    /* 名字走 `fnName` 的**属性体那一档**（`inProp`）：那对花括号里裸写的 `get` / `set` 就是
       这格属性的取/存（prop_full.rst:15）；同样的写法在类体里是下标算符，靠这一格分开。 */
    const leafOf = (im) => fnName({ name: im.name, type: im.type, at: im.at }, true);
    const accs = readBodyMembers(body)
      .map((im) => ({ im, leaf: leafOf(im) }))
      .filter((x) => x.im.shape === 'fn' && (x.leaf === 'get' || x.leaf === 'set'));
    if (accs.length === 0) {
      /**
       * **简写取值器**（第一百三十九刀，154-proptailptr.jnc / 140-propgetbody.jnc）：那对花括号
       * 里**就是取值器的体**（`int const property m_twice { return m_n * 2; }`）—— 不是取/存
       * 两个体，也不是 `autoget` 那一族。落出来就是一格 `(fn <属性>$get (($this …)) T …)`，
       * 与人写全了 `get() {…}` 那一种**发的是同一个东西**（旧降级的真输出同）。
       * 判据：那对花括号里没有取/存两格声明，而里头有语句。
       */
      if (!hasStmts(body)) return false;
      const key = `${emitName}$get`;
      if (methods.has(key) || fns.has(key)) return false;
      const nm0 = named(node);
      const t0 = nm0 === null ? null : readDeclType(nm0.specs, nm0.dcl);
      const r0 = t0 === null ? null : resolveType({ ...t0, shape: 'data' }, env);
      if (r0 === null || r0.type === null) {
        acct(`属性 '${emitName}' 的简写取值器：${r0?.why ?? '类型读不出来'}`); return false;
      }
      const selfPart = selfInfo === null ? ''
        : `($this ${emitType(selfInfo.kind === 'class' ? { k: 'class', name: selfInfo.agg }
          : { k: 'struct', name: selfInfo.agg }, 'slot', tyc)})`;
      methods.set(key, {
        params: [],
        defaults: [],
        ret: r0.type.k === 'void' ? null : r0.type,
        retDecl: t0,
        emit: key,
        ec: false,
        stat: selfInfo === null,
        virt: false,
        declVirt: false,
        owner: emitName,
        name: 'get',
        node,
        hasBody: false,
      });
      emitFn(node, key, emitName, selfInfo, ns, { emit: emitName, store: store ?? new Map(), field, mc: mcOf(node) },
        [], true, 0, `(fn ${key} (${selfPart}) ${emitType(r0.type, 'value', tyc)}`);
      return true;
    }
    for (const { im, leaf } of accs) {
      const key = `${emitName}$${leaf}`;
      if (headOf(im.at) !== 'fn-def') {
        acct(`属性 '${emitName}' 的 ${leaf} 只有原型（体写在别处）还没接`); continue;
      }
      /* 先登记签名：**别处的体**（别的方法、main）读这格属性时查的就是这张表。 */
      const sig = sigOf(named(im.at), env, key, im.type);
      if (sig === null) { acct(`属性 '${emitName}' 的 ${leaf} 的签名读不出来`); continue; }
      /* **带下标的属性**（`get(size_t i)` / `set(size_t i, T v)`，66-propidx.jnc）另一族 ——
         那一格读写要多带一个下标实参，还没接。 */
      const want = leaf === 'get' ? 0 : 1;
      if (sig.params.length !== want) {
        acct(`属性 '${emitName}' 的 ${leaf} 收 ${sig.params.length} 个形参（带下标的属性那一族）还没接`);
        continue;
      }
      methods.set(key, {
        ...sig, owner: emitName, name: leaf, node: im.at, hasBody: false,
      });
      emitFn(im.at, key, emitName, selfInfo, ns, { emit: emitName, store: store ?? new Map(), field, mc: mcOf(node) }, [], true);
    }
    return true;
  };

  /**
   * **`autoget` 的取值器是生成出来的**（prop_autoget.rst:15-17："取值器不用写，编译器给一格
   * 存储 `m_value`；写了取值器就用写的那个"）。所以这一层只做一件事：**没写取值器**的那一格
   * 生成一格 `(fn <属性>$get … (ret <读那格存储>))`。
   *
   * 存储在哪儿由"是不是成员"定：模块级那一格是一格量（取过地址的提成 `(ptr T)`，第二十四刀 ——
   * 那时候读要 `pload`），成员那一格是**字段**（`<东家>$<属性>$m_value`）。
   * 聚合体/变体那几格明说不收（读法不是一句 `var`）。
   */
  const genAutoget = (nameSrc, emitName, type, selfInfo, autoType = null) => {
    const mods = type?.mods ?? [];
    /* **`autoget` 那个词写在体里那一格存储上**（`int property m_v { int autoget m_value; … }`，
       141-propfullmem.jnc）：与写在属性上（`int autoget property m_v;`）是同一件事 ——
       差别只在"类型听谁的"。所以这一层收两种写法，往下一个字都不变。 */
    if (autoType === null && !mods.includes('autoget')) return false;
    if (methods.has(`${emitName}$get`) || fns.has(`${emitName}$get`)) return false;
    const src = autoType ?? type;
    const r = resolveType({ ...src, shape: 'data' }, env);
    if (r.type === null) { acct(`属性 '${emitName}' 生成的取值器：${r.why}`); return false; }
    const ty = r.type;
    /* 类那一格**读法与指针一样**（那一格里放的就是对象那段内存的地址）—— 所以它照收
       （68-propptr.jnc 的 `Icon* autoget property m_icon`）。聚合体/数组那两格不收：
       那一格里放的**是**那段内存，读出来是地址、写要抄一份 —— 生成不出"一句 var"。 */
    if (!['int', 'real', 'bool', 'string', 'ptr', 'tptr', 'enum', 'fnptr', 'class'].includes(ty.k)) {
      acct(`属性 '${emitName}' 生成的取值器落在 ${ty.k} 上（读法不是一句 var）还没接`); return false;
    }
    const storage = `${emitName}$m_value`;
    const boxed = (gLifted.has(nameSrc) || gLifted.has('m_value')) && liftable(ty);
    const read = selfInfo === null
      ? (boxed ? `(pload (var ${storage}))` : `(var ${storage})`)
      : `(pload (pfield (var $this) ${storage}))`;
    const selfPart = selfInfo === null ? '' : `($this (ptr ${clsRoot(selfInfo.agg)}))`;
    decls.push(`  (fn ${emitName}$get (${selfPart}) ${emitType(ty, 'value', tyc)}\n    (ret ${read}))`);
    methods.set(`${emitName}$get`, {
      params: [],
      defaults: [],
      ret: ty,
      retDecl: src,
      emit: `${emitName}$get`,
      ec: false,
      stat: false,
      owner: emitName,
      name: 'get',
      node: null,
      hasBody: false,
    });
    return true;
  };

  /**
   * **虚派发：一格虚方法落成一个分派函数**（第五十七刀，78-notype.jnc / 54-virtual.jnc 的真输出）。
   *
   *   (fn B$$vd$show (($a0 (ptr B))) void
   *     (do
   *       (if (bin "==" (pload (pfield (var $a0) $tag)) (int 2))
   *         (do (expr (call D$show (var $a0))) (ret)))
   *       (expr (call B$show (var $a0)))))
   *
   * 三条都是从那份真输出上读下来的：
   *   - 分派函数的东家是**声明**那一格虚槽的类（`virtual` / `abstract`；`override` 是接上头那一格）；
   *   - 按 `$tag` 一格一格比，撞上哪个派生类就调它的实现（`(ret)` 收尾），都不是就落到
   *     基类自己那一格；基类是 `abstract`（没有体）时最后那一格用**最后一个**派生类兜底
   *     （标签把每一种都盖住了，所以那一句永远走得到）；
   *   - 调用点按**接收方的静态类型**查这张表 —— 链上任一格查的都是同一个分派函数。
   *
   * 一句都发不出来的（形参/返回解不出来、一个实现都没有）**明说不收**：`vdispatch` 里没有
   * 那一格，查方法那一头照旧记账。
   */
  {
    const below = (base) => aggs.filter((x) => {
      if (x.emitName === base) return false;
      const seen3 = new Set();
      const q3 = [...(aggBases.get(x.emitName) ?? [])];
      while (q3.length > 0) {
        const b = q3.shift();
        if (b === base) return true;
        if (seen3.has(b)) continue;
        seen3.add(b);
        q3.push(...(aggBases.get(b) ?? []));
      }
      return false;
    }).map((x) => x.emitName);
    for (const [key, mi] of [...methods]) {
      if (mi.declVirt !== true || mi.owner === undefined) continue;
      const cls = mi.owner;
      const vd = `${cls}$$vd$${mi.name}`;
      if (vdispatch.get(`${cls}$${mi.name}`) === vd) continue;   // 一格只发一次
      /* 形参那一串（`$a0` 是 `this`）与返回类型都听**声明那一格**的。 */
      const ps = [];
      let bad2 = false;
      for (const p of mi.params ?? []) {
        const rp = p === null ? null : resolveType(p, env);
        if (rp === null || rp.type === null) { bad2 = true; break; }
        ps.push(emitType(rp.type, 'slot', tyc));
      }
      if (bad2) { acct(`虚方法 '${key}' 的分派：形参解不出来`); continue; }
      const rt = mi.ret === null || mi.ret === undefined ? null : mi.ret;
      const args = ps.map((x, i) => ` (var $a${i + 1})`).join('');
      /* 分支体那一格是**一串语句**（`(do …)`）—— 发码那一头 `if` 的两边读的是体，
         直接给一句 `(ret …)` 会当场翻（第五十七刀，54-virtual.jnc 上量出来的）。 */
      const one = (fn) => (rt === null
        ? `(do (expr (call ${fn} (var $a0)${args})) (ret))`
        : `(do (ret (call ${fn} (var $a0)${args})))`);
      const has = (x) => methods.get(`${x}$${mi.name}`)?.hasBody === true || fns.has(`${x}$${mi.name}`);
      /* 一格派生类**自己没写**这个方法时，它跑的是**上头最近那一格**写的那个实现
         （54-virtual.jnc：`Cube` 没写 `area`，标签 3 那一格调的是 `Square$area`）。 */
      const eff = (x) => {
        const seen4 = new Set();
        const q4 = [x];
        while (q4.length > 0) {
          const y = q4.shift();
          if (seen4.has(y)) continue;
          seen4.add(y);
          if (has(y)) return y;
          q4.push(...(aggBases.get(y) ?? []));
        }
        return null;
      };
      const selfHas = mi.hasBody === true || fns.has(key);
      const subs = below(cls).map((x) => [x, eff(x)]).filter(([, e]) => e !== null);
      if (!selfHas && subs.length === 0) {
        acct(`虚方法 '${key}' 一个实现都没有（分派发不出来）`); continue;
      }
      const lines = [];
      const tail = selfHas ? cls : subs[subs.length - 1][1];
      for (const [x, e] of subs) {
        if (e === tail) continue;
        lines.push(`      (if (bin "==" (pload (pfield (var $a0) $tag)) (int ${tags.get(x) ?? 0}))`);
        lines.push(`        ${one(`${e}$${mi.name}`)})`);
      }
      lines.push(`      ${rt === null ? `(expr (call ${tail}$${mi.name} (var $a0)${args}))` : `(ret (call ${tail}$${mi.name} (var $a0)${args}))`}`);
      const formals = [`($a0 (ptr ${clsRoot(cls)}))`, ...ps.map((t2, i) => `($a${i + 1} ${t2})`)];
      decls.push([
        `  (fn ${vd} (${formals.join(' ')}) ${rt === null ? 'void' : emitType(rt, 'value', tyc)}`,
        '    (do',
        ...lines,
        '    ))',
      ].join('\n'));
      /* 链上每一格（声明它的那个类与它所有派生类）查的都是**同一个**分派函数。 */
      vdispatch.set(`${cls}$${mi.name}`, vd);
      for (const x of below(cls)) vdispatch.set(`${x}$${mi.name}`, vd);
    }
  }

  /* **属性那一族先发**（在方法与顶层函数之前）：别处的体读它时要查得着那两格签名。 */
  const propDone = new Set();
  for (const a of aggs) {
    const kind = a.word === 'class' || a.word === 'opaque class' ? 'class' : 'struct';
    for (const m of a.members) {
      if (m.shape !== 'prop' || m.name === null) continue;
      const emitName = `${a.emitName}$${m.name}`;
      const self0 = { agg: a.emitName, kind, emit: kind === 'class' ? clsRoot(a.emitName) : a.emitName };
      /* 扫那一遍已经把体里的字段收进 `aggProps[…].store` 了 —— 这儿直接用它。 */
      const pr1 = aggProps.get(a.emitName)?.get(m.name);
      const store = pr1?.store ?? new Map();
      if (emitPropBody(m.at, emitName, self0, null, store, true) === true) propDone.add(m.at);
      /* 那对花括号里没写取值器（或压根没有花括号）时，`autoget` 那一格自己生成一个
         —— `autoget` 写在属性上、还是写在体里那格存储上，两种写法都在这儿收（`pr1.auto`）。 */
      genAutoget(m.name, emitName, m.type, self0, pr1?.auto ?? null);
    }
  }
  for (const { it, ns } of items) {
    const h = headOf(it);
    if (h !== 'fn-def' && h !== 'fn-proto') continue;
    const nm0 = named(it);
    const t0 = nm0 === null ? null : readDeclType(nm0.specs, nm0.dcl);
    if (t0 === null || t0.shape !== 'prop' || t0.name === null) continue;
    const pr = gProps.get(t0.name);
    const store1 = pr?.store ?? new Map();
    /**
     * **完整声明式属性那几格存储**（`property g_p { int m_v; … }` → `(global g_p$m_v int)`）：
     * 它在树上是一格 fn-def，所以模块级那一圈（只看 `var-decl`）压根照不到它 —— 存储那几行
     * 得在这儿发。少这一步，取/存的体里发的 `(var g_p$m_v)` 谁也没声明过（151-propfield.jnc）。
     */
    const gp = globalLines(
      { name: t0.name, type: t0, shape: t0.shape, storage: [], at: it },
      env,
      { ns, clsRoot, taken: gLifted },
    );
    for (const l of gp.lines) decls.push(`  ${l}`);
    if (gp.why !== null && !gp.why.includes('对的行为')) acct(`属性 '${t0.name}'：${gp.why}`);
    /**
     * **体里那几格字段写了初值**（`property g_p { int m_v = 5; … }`，152-propfieldinit.jnc）：
     * 顶层这一格存储就是一格**模块级的量**（`g_p$m_v`），所以初值那一句与模块级那一圈
     * 一模一样 —— 进 `inits`。取过地址的那一格（`(ptr T)`）另算，明说不收。
     */
    const body0 = named(it)?.body;
    if (headOf(body0) === 'compound') {
      const full0 = ns === null ? t0.name : `${ns}$${t0.name}`;
      for (const im of readBodyMembers(body0)) {
        if (im.name === null || im.type === null) continue;
        if (im.shape !== 'data' && im.shape !== 'array' && im.shape !== 'fnptr') continue;
        const ini = memberInit(im);
        if (ini === null) continue;
        const rr = resolveType(im.type, env);
        if (rr.type === null) { acct(`属性 '${t0.name}.${im.name}' 的初值：${rr.why}`); continue; }
        if (ini.curly === true || ['arr', 'struct', 'class'].includes(rr.type.k)
          || gLifted.has(im.name)) {
          acct(`属性 '${t0.name}.${im.name}' 的初值落在 ${rr.type.k} 上（或那一格被取过地址）还没接`);
          continue;
        }
        const mi0 = modInit();
        const v0 = mi0.ctx.expr(ini.value, mi0.e.withBits(rr.type, im.type));
        if (v0 === null) continue;                           // 账已经记过
        inits.push(`    ${SHAPE_ACCESS.var.write(`${full0}$${im.name}`, v0)}`);
      }
    }
    if (emitPropBody(it, pr?.emit ?? t0.name, null, ns, store1) === true) propDone.add(it);
  }
  /* 顶层那几格属性的 `autoget` 取值器（两种写法都在这张表里：`int autoget property g;` 与
     `property g { … }`）—— 写了取值器的那一格由上面那两条路发，这儿只补没写的。 */
  for (const [nameSrc, pr] of gProps) genAutoget(nameSrc, pr.emit, pr.type, null);

  /* **方法那一族**（体写在类里的那几格）：一格一格发 `(fn <东家>$<方法名> (($this …) …) …)`。 */
  for (const key of overloads) {
    acct(`方法 '${key}' 有重载（按实参挑哪一格）还没接`);
  }
  /**
   * 人写的 `construct` 里**显式**调了哪几格基类的构造（`basetype.construct(…)` /
   * `basetype2.construct(…)`）。答的是一格集合：**没在里头的那几格由编译器补一句**
   * （53-inherit.jnc 那格 `Cow`、86-multibase.jnc 那格 `C3` 只显式调了第一格）——
   * 补的那几句排在字段初值与体之前（jnc_ct_Parser.cpp:3005-3009）。
   *
   * 先前这儿是一格布尔（"有没有调过基类构造"），于是多基类时**只要调了一格，另一格就漏了**
   * —— 86-multibase.jnc 的 `c.m_b` 印出来是 0（该是 20）。按格记才对得上。
   */
  const explicitBases = (node, out = new Set()) => {
    if (node === null || node === undefined || typeof node !== 'object') return out;
    if (Array.isArray(node)) { for (const x of node) explicitBases(x, out); return out; }
    if (headOf(node) === 'field') {
      const f = named(node);
      if (String(f?.name?.value ?? '') === 'construct') {
        const ob = f?.obj;
        /* `basetype` 与 `basetype1` 是同一格（type_class.rst:226）。 */
        if (headOf(ob) === 'basetype') {
          const n0 = Number.parseInt(String(named(ob)?.type?.value ?? '1'), 10);
          out.add(Number.isFinite(n0) && n0 >= 1 ? n0 : 1);
        } else if (headOf(ob) === 'name') {
          /* 写基类的**名字**也算显式调（`I1.construct(a)`）。 */
          out.add(String(named(ob)?.text?.value ?? ''));
        }
      }
    }
    if (Array.isArray(node.items)) for (const x of node.items) explicitBases(x, out);
    return out;
  };
  for (const [key, mi] of methods) {
    if (mi.hasBody !== true) continue;                   // 只写原型的，体在类外（下面那条路发）
    const a = aggs.find((x) => x.emitName === mi.owner);
    const kind = a !== undefined && (a.word === 'class' || a.word === 'opaque class') ? 'class' : 'struct';
    const ownerEmit = kind === 'class' ? clsRoot(mi.owner) : mi.owner;
    /* **构造那一格前头还有三截**：静态构造那道闸门 + 基类的构造（没显式调的那几格补上）
       + 字段初值。 */
    const head0 = [];
    if (mi.name === 'construct') {
      if (a !== undefined) head0.push(...staticGate(a, mi.owner, '    '));
      const done = explicitBases(named(mi.node)?.body);
      const bs = (aggBases.get(mi.owner) ?? []).filter((b, i) => methods.has(`${b}$construct`)
        && !done.has(i + 1) && !done.has(b) && !done.has(b.slice(b.lastIndexOf('$') + 1)));
      if (bs.length > 0) {
        const bad = bs.find((b) => ((methods.get(`${b}$construct`).params) ?? []).length > 0);
        if (bad !== undefined) {
          acct(`'${key}' 没显式调基类 '${bad}' 的构造，而那一格要实参 —— 补不出来`); continue;
        }
        head0.push(...bs.map((b) => `    (expr (call ${b}$construct (var $this)))`));
      }
      if (fieldInits.has(mi.owner) || a !== undefined) {
        const fi = a === undefined ? [] : fieldInitLines(a, '    ');
        if (fi === null) continue;                       // 账已经记过
        head0.push(...fi);
      }
    }
    /**
     * **写在类体里的成员属性取/存**（`void m_v.set(int x) {…}`，67-propauto.jnc）：方法表里它
     * 的名字是 `m_v$set` —— 那一格里裸写的 `m_value` 是这格属性**生成的存储**，而成员属性的
     * 存储是**一格字段**（`Cell$m_v$m_value`）。所以要把属性那一层当作用域递进去（带 `field`）。
     */
    let ps = null;
    if (mi.name.endsWith('$get') || mi.name.endsWith('$set')) {
      const pname = mi.name.slice(0, mi.name.lastIndexOf('$'));
      const pr2 = aggProps.get(mi.owner)?.get(pname);
      if (pr2 !== undefined) {
        const store = new Map();
        const mods2 = pr2.type?.mods ?? [];
        if (mods2.includes('autoget') || mods2.includes('bindable')) store.set('m_value', pr2.type);
        ps = { emit: pr2.emit, store, field: true, mc: mods2.includes('bindable') };
      }
    }
    emitFn(
      mi.node,
      key,
      mi.owner,
      mi.stat === true ? null : { agg: mi.owner, kind, emit: ownerEmit },
      null,
      ps,
      head0,
      false,
      mi.dup ?? 0,
    );
  }

  /* 再发**顶层那几格函数**（体写在类外的方法也在这儿 —— 它的名字是点串）。 */
  /* **这一格是同名那一族里的第几号**（第五十八刀）：扫那一遍按声明次序排好了号，这儿按
     **那个语法节点**认回来 —— 两头拼名字用的是同一格 `overloadSuffix`。查不着答 null。 */
  const dupOf = (node) => {
    for (const s of fns.values()) if (s.node === node) return s.dup ?? 0;
    return null;
  };
  for (const { it, ns } of items) {
    const h = headOf(it);
    if (h !== 'fn-def' && h !== 'fn-proto') continue;
    if (h === 'fn-proto') continue;                      // 原型不发码
    /**
     * **泛型的成员写在体外**（`T Box<T>.fetch() { … }`，第二百二十二刀，126-genericouter.jnc）：
     * jancy 里"体内写"与"体外写"是同一件事、任选其一（type_class.rst:41-59）。那几条条目已经
     * **跟着每格实例各替换出来一份**了（`expandTemplates` 的 `outers`，名字落成 `Box$int$fetch`
     * —— 与从体里提上来的那一批一模一样），所以**原来那一条不发码**：它里头那个 `T` 谁也没绑过。
     *
     * 少这一句，那一条会照字面降下去，报的是"顶层函数的名字读不出来"（东家是一格 `tinst`，
     * 不是名字）—— 账记在这儿，因在别处。
     */
    if (tmplOuters.has(it)) continue;
    const nm = named(it);
    const t = nm === null ? null : readDeclType(nm.specs, nm.dcl);
    if (t === null) { acct('顶层函数的类型读不出来'); continue; }
    /* **完整声明式的属性**（`int property g_p { get() {…} set(int x) {…} }`，prop_full.rst:15）：
       它在树上长得像一格函数声明，可那对花括号里是**取/存两个体**，不是一格函数体。
       整族另算 —— 送去发"函数的头"只会报"认不出形参表"，那是认错人。 */
    if (t.shape === 'prop') {
      /* 那对花括号里是取/存两个体的那一种上面已经发了（`emitPropBody`）；剩下的是简写取值器、
         `autoget` / `bindable` / 反应器那几族 —— 各是自己一刀。 */
      if (propDone.has(it)) continue;
      acct(`'${t.name ?? '?'}'：属性那对花括号里不是取/存两个体（简写 / autoget / bindable）还没接`);
      continue;
    }

    if (t.name === null) {
      /* **体写在类外**（`int P.scaled(int k) { … }`）：名字是点串，东家是它前面那一段。
         哪一段是东家**要按聚合体表认**，不能"在最后一个 `$` 上切"：`Reg$construct$static`
         那样切出来的是 `Reg$construct`（50-construct.jnc 量的正是这一格）。所以从长到短试。 */
      const dotted = fnName({ name: null, type: t, at: it });
      if (dotted === null || !dotted.includes('$')) { acct('顶层函数的名字读不出来'); continue; }
      let ownerName = null;
      for (let i = dotted.lastIndexOf('$'); i > 0; i = dotted.lastIndexOf('$', i - 1)) {
        const pre = dotted.slice(0, i);
        if (aggs.some((x) => x.emitName === pre)) { ownerName = pre; break; }
      }
      if (ownerName === null) {
        /* 东家不是一格聚合体：那是**模块级属性的取/存**（`int g_p.get() {…}` —— 属性那对
           花括号开的是一层命名空间，第六十九刀）。它在方言里就是一格普通函数
           `g_p$get` / `g_p$set`（没有 `$this`）—— 名字由 `fnHead` 从点串拼出来。 */
        const leaf = dotted.slice(dotted.lastIndexOf('$') + 1);
        if (leaf === 'get' || leaf === 'set') {
          /* 取/存那两个体里裸写的 `m_value` / `m_v` 指的是这格属性**的存储** —— 把属性那一格
             当一层作用域递进去（`propScope`）。**模块级属性的字段存储**也在这张表里
             （`gProps[属性名].store`）—— 151-propfield.jnc 的 `g_p$m_v` 就是这一格。 */
          const pname = dotted.slice(0, dotted.lastIndexOf('$'));
          const pr0 = gProps.get(pname);
          const store0 = pr0?.store ?? new Map();
          emitFn(it, dotted, null, null, ns, { emit: pname, store: store0, mc: (gProps.get(pname)?.type?.mods ?? []).includes('bindable') });
          continue;
        }
        acct(`'${dotted}' 的东家查不着（不是这份源码里的聚合体）`);
        continue;
      }
      const a = aggs.find((x) => x.emitName === ownerName);
      const kind = a.word === 'class' || a.word === 'opaque class' ? 'class' : 'struct';
      const st = methods.get(dotted)?.stat === true;
      const selfInfo = st ? null
        : { agg: ownerName, kind, emit: kind === 'class' ? clsRoot(ownerName) : ownerName };
      /**
       * **体外写的成员属性取/存**（`void Cell.m_v.set(int x) {…}`，67-propauto.jnc）：那一格
       * 里裸写的 `m_value` 是这格属性**生成的存储**，而成员属性的存储是**一格字段**
       * （`Cell$m_v$m_value`）—— 所以 propScope 要带上 `field`。
       */
      const leaf2 = dotted.slice(dotted.lastIndexOf('$') + 1);
      let ps = null;
      if (leaf2 === 'get' || leaf2 === 'set') {
        const pemit = dotted.slice(0, dotted.lastIndexOf('$'));
        const pname = pemit.slice(ownerName.length + 1);
        const pr2 = aggProps.get(ownerName)?.get(pname);
        /* 前面那一段解得出一格**属性**才是取/存；解不出（`int C0.get() {…}` —— 前面那段就是
           类名）就是一格**名字恰好叫 get / set 的普通方法**（第一百三十六刀，127-outerget.jnc）。 */
        if (pr2 !== undefined) {
          const store = pr2.store ?? new Map();
          const mods2 = pr2.type?.mods ?? [];
          if (mods2.includes('autoget') || mods2.includes('bindable')) store.set('m_value', pr2.type);
          ps = { emit: pr2.emit ?? pemit, store, field: true, mc: mods2.includes('bindable') };
        }
      }
      emitFn(it, dotted, null, selfInfo, ns, ps, [], false, dupOf(it) ?? 0);
      continue;
    }
    /* **重载**（同名的第二格函数，第五十八刀）：号在扫那一遍就排好了（`f` / `f$o1`）——
       这儿只把它取出来交给 `fnHead`。取不出来（那一格压根没进函数表）照旧记账：
       照发下去方言那侧会撞名，而调用那一处查的是最后登记的那一格，也就是**静静地调错**。 */
    const dup0 = dupOf(it);
    if (dup0 === null) { acct(`函数 '${t.name}' 有重载（按实参挑哪一格）还没接`); continue; }
    emitFn(it, t.name, ns, null, ns, null, [], false, dup0);
  }

  /* 账先报、入口后查（次序要紧）：`main` 的体拼不出来时 `mainBody` 也是空的，先查入口就把
     真正拦住的那几笔账盖成了"这份源码里没有 main"—— 那是假话。 */
  if (accts.length > 0) {
    for (const w of accts) diags.error(null, `规则化降级还没接：${w}`);
    return '';
  }
  if (mainBody === null && opts.needEntry === true) {
    diags.error(null, 'jancy 的入口是 `int main()`，这份源码里没有');
    return '';
  }

  /**
   * **模块级那一层初值要的东西**（`$newoN` 那几格助手、`once` 的槽）：与函数体那条同一条路
   * —— 体那一层记下来、模块那一层照单发。这一遍要排在**所有** `modInit()` 用完之后
   * （少了它，`Point g_p(3, 4);` 发出来的 `(call $newo0)` 谁也没声明过）。
   */
  if (modEnv !== null) {
    for (const s of modEnv.e.slots) decls.push(`  (global ${s.name} ${s.ty})`);
    for (const hh of modEnv.e.helpers) decls.push(hh);
  }

  const prologue = [...cells, ...inits].join('\n');
  const body = mainBody === null ? prologue
    : (prologue === '' ? mainBody : `${prologue}\n${mainBody}`);
  /**
   * **`variant_t` 那格结构体用到才发、且发在最前头**（第一百一十三刀）：它是**合成**出来的
   * （源码里没有它的声明），而用它的地方有三处 —— 字段的类型、形参/返回的类型、装拆的壳。
   * 那三处哪一处先出现都可能，所以判据只有一句：**整份模块里提到了它就发**。方言那一侧
   * 要求先声明后用，所以插在所有条目之前。
   */
  const all = [...decls, body].join('\n');
  if (all.includes(VARIANT) && !all.includes(`(struct ${VARIANT} `)) {
    decls.unshift(variantStruct());
  }
  return `${['(module', ...decls, `  (main\n${body})`, ')'].join('\n')}\n`;
}
