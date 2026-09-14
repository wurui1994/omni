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
import { scanAggs, scanFns } from './module-scan.js';
import { structLine } from './emit-agg.js';
import { globalLines, addrTaken, liftable, liftedType } from './emit-global.js';
import { fnHead, readFormals, fnName } from './emit-fn.js';
import { emitBody, makeCtx } from './emit-body.js';
import { makeFnEnv } from './emit-ctx.js';
import { lvalueShape, SHAPE_ACCESS } from '../common/place.js';
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
export function lowerJncRules(tree, diags, opts = {}) {
  const env = new Map();
  const accts = [];
  const acct = (why) => { if (!accts.includes(why)) accts.push(why); };

  collectEnumConsts(tree, env);
  const {
    fields: aggFields, ctors: aggCtors, vars: globals, gEmit, gProps, methods, fieldInits,
    bindable: gBindable, roots, aggs, statics: aggStatics, props: aggProps,
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
        aggCtors,
        ecBox,
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
    decls.push(`  ${line.line}`);
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
      const r = resolveType(st.type, env);
      if (r.type === null) { acct(`静态字段 '${st.emit}'：${r.why}`); continue; }
      if (gLifted.has(st.name) && liftable(r.type)) {
        acct(`静态字段 '${st.emit}' 被取过地址（要提成一格 (ptr T)）还没接`); continue;
      }
      if (r.type.k === 'struct' || r.type.k === 'arr') {
        cells.push(`    (set ${st.emit} (pnew ${emitType(r.type, 'slot', tyc)} (int 1)))`);
      }
      if (st.init === null) continue;
      if (st.init.curly === true) {
        acct(`静态字段 '${st.emit}' 的花括号初值（要逐格抄一份）还没接`); continue;
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
    const dcls = h === 'var-decl-curly' ? [vn.dcl] : allInChain(vn.dcls, 'dcls-add', 'dcls');
    for (const d of dcls) {
      const isInit = headOf(d) === 'init';
      const dcl = isInit ? named(d)?.dcl : d;
      const t = readDeclType(vn.specs, dcl);
      if (t === null || t.name === null) { acct('模块级那一格量的名字读不出来'); continue; }
      const m = {
        name: t.name, type: t, shape: t.shape, storage, at: it,
      };
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
      if (t.shape === 'prop' || t.shape === 'event') continue;
      /* 要一段自己的内存的那几格（结构体 / 数组 / 提过的标量）：一句 pnew 排在初值之前。 */
      const r = resolveType(t, env);
      if (r.type === null) { acct(`模块级 '${t.name}'：${r.why}`); continue; }
      const full = ns === null ? t.name : `${ns}$${t.name}`;
      const box = gLifted.has(t.name) && liftable(r.type);
      if (r.type.k === 'struct' || r.type.k === 'arr') {
        const st = emitType(r.type, 'slot', tyc);
        cells.push(`    (set ${full} (pnew ${st} (int 1)))`);
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
   */
  const emitFn = (node, shown, owner, selfInfo, ns, propScope = null) => {
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
    const hd = fnHead(m, env, { owner, self: selfTy, clsRoot });
    if (hd === null || hd.head === null) { acct(`函数 '${shown}' 的头还发不出来（${hd?.why ?? '?'}）`); return; }
    const e = makeFnEnv({
      fnNode: node,
      env,
      acct: (w) => acct(`${shown}：${w}`),
      fns,
      aggFields,
      aggCtors,
      methods,
      tags,
      fieldInits,
      self: selfInfo,
      ecBox,
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
    const whole = e.pre.length === 0 ? body : [...e.pre, body].join('\n');
    /* 体那一层要的**模块级槽**（`once` 的旗子、`static` 局部量那一格与它的闸门）：
       发在函数**前面** —— 方言那一侧先声明后用。 */
    for (const s of e.slots) decls.push(`  (global ${s.name} ${s.ty})`);
    /* 抬出去的那几格（造对象那三句）—— 与槽同一条：发在用它的那格函数前面。 */
    for (const hh of e.helpers) decls.push(hh);
    if (isMain) { mainBody = whole; return; }
    decls.push(`  ${hd.head}\n${whole})`);
  };

  /* **方法那一族**（体写在类里的那几格）：一格一格发 `(fn <东家>$<方法名> (($this …) …) …)`。 */
  for (const [key, mi] of methods) {
    if (mi.hasBody !== true) continue;                   // 只写原型的，体在类外（下面那条路发）
    const a = aggs.find((x) => x.emitName === mi.owner);
    const kind = a !== undefined && (a.word === 'class' || a.word === 'opaque class') ? 'class' : 'struct';
    const ownerEmit = kind === 'class' ? clsRoot(mi.owner) : mi.owner;
    emitFn(mi.node, key, mi.owner, mi.stat === true ? null : { agg: mi.owner, kind, emit: ownerEmit }, null);
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
      acct(`'${t.name ?? '?'}'：完整声明式的属性（那对花括号里是取/存两个体）还没接`); continue;
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
          /* 取/存那两个体里裸写的 `m_value` 指的是这格属性**生成的存储** —— 把属性那一格
             当一层作用域递进去（`propScope`）。 */
          const pname = dotted.slice(0, dotted.lastIndexOf('$'));
          emitFn(it, dotted, null, null, ns, gProps.get(pname) ?? null);
          continue;
        }
        acct(`'${dotted}' 的东家查不着（不是这份源码里的聚合体）`);
        continue;
      }
      const a = aggs.find((x) => x.emitName === ownerName);
      const kind = a.word === 'class' || a.word === 'opaque class' ? 'class' : 'struct';
      const st = methods.get(dotted)?.stat === true;
      emitFn(it, dotted, null, st ? null : { agg: ownerName, kind, emit: kind === 'class' ? clsRoot(ownerName) : ownerName }, ns);
      continue;
    }
    const k = nth.get(t.name) ?? 0;
    nth.set(t.name, k + 1);
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
