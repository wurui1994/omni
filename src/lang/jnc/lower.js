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
import { structLine } from './emit-agg.js';
import {
  globalLines, addrTaken, liftable, liftedType, arrayFromCurly,
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
          acct(`import '${spec}'：不是一份 .jnc（.jncx 与动态库那两族另算）`); return;
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
  const {
    fields: aggFields, ctors: aggCtors, vars: globals, gEmit, gProps, methods, fieldInits,
    bindable: gBindable, roots, aggs, statics: aggStatics, props: aggProps, bases: aggBases,
    overloads, fieldPaths: aggPaths, aggAliases, gAlias,
  } = scanAggs(tree, env);
  const fns = scanFns(tree, env);
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
    const line = structLine(a, env, aggs);
    if (line === null || line.line === null) { acct(`聚合体 '${a.emitName}' 还发不出来`); continue; }
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
      const g = globalLines(st, env, { ns: owner, clsRoot, taken: gLifted });
      for (const l of g.lines) decls.push(`  ${l}`);
      if (g.why !== null) {
        if (!g.why.includes('对的行为')) acct(`静态字段 '${st.emit}'：${g.why}`);
        continue;
      }
      /* 长度写空的（`static int m_table[] = { 10, 20, 12 };`）从花括号里数 —— 与模块级、
         局部那两处用的是同一份 `arrayFromCurly`（183-staticcurly.jnc）。 */
      const cvs = st.init !== null && st.init.curly === true ? st.init.value
        : (st.curlyValue ?? null);
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
        if (gLifted.has(t.name)) {
          acct(`模块级 '${t.name}' 被取过地址又写了花括号初值 —— 那两件事的次序还没量`); continue;
        }
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
         * **模块级的类变量**（`Counter g_c;`，49-class.jnc）：jancy 里这是"程序一起来就造好的
         * 一格对象"（`module.construct` 的 pnew + 写 `$tag`），与局部量 `Counter c;` 的那一格
         * **同一条路**（pnew + tag + 构造）。少这一步，`g_c.reset(7)` 跑的时候里头是零 ——
         * 指针越界。
         */
        const tag = tags.get(r.type.name) ?? 0;
        const root = clsRoot(r.type.name);
        cells.push(`    (set ${full} (pnew (ptr ${root}) (int 1)))`);
        cells.push(`    (pstore (pfield (var ${full}) $tag) (int ${tag}))`);
      } else if (box) {
        const pt = liftedType(r.type, tyc);
        cells.push(`    (set ${full} (pnew ${pt} (int 1)))`);
      }
      if (isInit) {
        /* 初值那一句由**函数体那一层**降（它认表达式）—— 借模块级那一格探子。
           结构体与数组要"逐字段抄一份"（`copyVal`），那一族另算。 */
        if (r.type.k === 'struct' || r.type.k === 'arr' || r.type.k === 'class') {
          acct(`模块级 '${t.name}' 写了初值的聚合体（要逐字段抄一份）还没接`); continue;
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
  const emitFn = (node, shown, owner, selfInfo, ns, propScope = null, head0 = [], inProp = false) => {
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
    const hd = fnHead(m, env, { owner, self: selfTy, clsRoot, inProp });
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
        const o = e.newObj(r.type.name);
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
  const synth = new Map();                               // 类 → { bases, agg }
  {
    const hasCtorOf = (cn) => methods.has(`${cn}$construct`) || synth.has(cn);
    const pending = aggs.filter((a) => a.word === 'class' || a.word === 'opaque class');
    /* **这几族这一层还接不上**：有它们在就不合成（否则发出来的构造漏了半截）。
       **属性自己不算一格理由**：写出来的那对取/存是两格函数、体里那几格字段就是普通字段
       （初值那几句由 `fieldInitLines` 发，152-propfieldinit.jnc）—— 真要另一套的是
       `autoget` / `bindable` 生成的那一格（下面那条）与事件、反应器。 */
    const otherReason = (a) => hasStaticCtor(a)
      || a.members.some((m) => m.shape === 'event' || m.shape === 'reactor')
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
        if (bs.length === 0 && !fieldInits.has(cls) && !hasEmbedded(a)) continue;
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
      const selfTy = `(ptr ${clsRoot(cls)})`;
      const fi = fieldInitLines(s.agg, '    ');
      if (fi === null) continue;                           // 账已经记过
      const lines = [
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
  const emitPropBody = (node, emitName, selfInfo, ns, store, field = false) => {
    const body = named(node)?.body;
    if (headOf(body) !== 'compound') return false;
    /* 名字走 `fnName` 的**属性体那一档**（`inProp`）：那对花括号里裸写的 `get` / `set` 就是
       这格属性的取/存（prop_full.rst:15）；同样的写法在类体里是下标算符，靠这一格分开。 */
    const leafOf = (im) => fnName({ name: im.name, type: im.type, at: im.at }, true);
    const accs = readBodyMembers(body)
      .map((im) => ({ im, leaf: leafOf(im) }))
      .filter((x) => x.im.shape === 'fn' && (x.leaf === 'get' || x.leaf === 'set'));
    if (accs.length === 0) return false;
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
      emitFn(im.at, key, emitName, selfInfo, ns, { emit: emitName, store: store ?? new Map(), field }, [], true);
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
    if (!['int', 'real', 'bool', 'string', 'ptr', 'tptr', 'enum', 'fnptr'].includes(ty.k)) {
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
    /* **构造那一格前头还有两截**：基类的构造（没显式调的那几格补上）+ 字段初值。 */
    const head0 = [];
    if (mi.name === 'construct') {
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
        ps = { emit: pr2.emit, store, field: true };
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
    );
  }

  /* 再发**顶层那几格函数**（体写在类外的方法也在这儿 —— 它的名字是点串）。 */
  const nth = new Map();
  for (const { it, ns } of items) {
    const h = headOf(it);
    if (h !== 'fn-def' && h !== 'fn-proto') continue;
    if (h === 'fn-proto') continue;                      // 原型不发码
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
          emitFn(it, dotted, null, null, ns, { emit: pname, store: store0 });
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
        const store = pr2 !== undefined ? (pr2.store ?? new Map()) : new Map();
      const mods2 = pr2?.type?.mods ?? [];
      if (mods2.includes('autoget') || mods2.includes('bindable')) store.set('m_value', pr2.type);
      ps = { emit: pr2?.emit ?? emitName, store, field: true };
      }
      emitFn(it, dotted, null, selfInfo, ns, ps);
      continue;
    }
    const k = nth.get(t.name) ?? 0;
    nth.set(t.name, k + 1);
    /* **重载**（同名的第二格函数）：按实参挑哪一格是一整族规则（`frontend-engine/overload.js`
       那一套：完全一样 / 上转 / 数值转换各一档）。这一层还没接 —— 照发下去方言那侧会撞名
       （`'q' 重复定义`），而调用那一处查的是**最后**登记的那一格签名，也就是**静静地调错**。 */
    if (k > 0) { acct(`函数 '${t.name}' 有重载（按实参挑哪一格）还没接`); continue; }
    emitFn(it, t.name, ns, null, ns);
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

  const prologue = [...cells, ...inits].join('\n');
  const body = mainBody === null ? prologue
    : (prologue === '' ? mainBody : `${prologue}\n${mainBody}`);
  return `${['(module', ...decls, `  (main\n${body})`, ')'].join('\n')}\n`;
}
