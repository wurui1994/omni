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
import { fnHead, readFormals } from './emit-fn.js';
import { emitBody, makeCtx } from './emit-body.js';
import { makeFnEnv } from './emit-ctx.js';
import { lvalueShape, SHAPE_ACCESS } from './lvalue-table.js';
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
    fields: aggFields, ctors: aggCtors, vars: globals, gEmit, bindable: gBindable, roots, aggs,
  } = scanAggs(tree, env);
  const fns = scanFns(tree, env);
  const gLifted = addrTaken(tree);
  const clsRoot = (n) => roots.get(n) ?? n;
  const tyc = { clsRoot };

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
        roots,
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
      if (g.why !== null) { acct(`模块级 '${t.name}'：${g.why}`); continue; }
      for (const l of g.lines) decls.push(`  ${l}`);
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

  /* 再发**函数**（顶层那几格；方法那一族还没接）。 */
  const nth = new Map();
  for (const { it, ns } of items) {
    const h = headOf(it);
    if (h !== 'fn-def' && h !== 'fn-proto') continue;
    const nm = named(it);
    const t = nm === null ? null : readDeclType(nm.specs, nm.dcl);
    if (t === null || t.name === null) { acct('顶层函数的名字读不出来'); continue; }
    const k = nth.get(t.name) ?? 0;
    nth.set(t.name, k + 1);
    if (h === 'fn-proto') continue;                    // 原型不发码
    const sp = readSpecs(nm.specs);
    const m = {
      name: t.name, type: t, shape: t.shape, storage: sp === null ? [] : sp.words, at: it, ns,
    };
    const hd = fnHead(m, env, { owner: ns, self: null, clsRoot });
    if (hd === null || hd.head === null) { acct(`函数 '${t.name}' 的头还发不出来`); continue; }
    const e = makeFnEnv({
      fnNode: it,
      env,
      acct: (w) => acct(`${t.name}：${w}`),
      fns,
      aggFields,
      aggCtors,
      ecBox,
      tmpBox,
      globals,
      gLifted,
      gBindable,
      gEmit,
      roots,
    });
    /* **`int main()` 落成方言的入口 `(main …)`，那一格不回值**：所以体那一层看见的是
       "回 void 的函数"，`return 0;` 就是一句 `(ret)`（`returnKind` 里 `inMain` 那一条），
       回非 0 的那一格明说不收（方言的入口没有退出码）。 */
    const isMain = t.name === 'main' && ns === null;
    if (isMain) { e.retVoid = true; e.inMain = true; e.retType = null; }
    /* **答 null 必须留下一笔账**：不然这一格函数就静静地不见了 —— `(fn check …)` 没发出来，
       而调它的那几处照旧发 `(call check …)`（170-throw.jnc 就是这么坏的）。所以这儿数一下
       账本，一笔都没添就自己记一条"这一层的 bug"。 */
    const n0 = accts.length;
    const body = emitBody(nm.body, e, 4);
    if (body === null) {
      if (accts.length === n0) acct(`函数 '${t.name}' 的体答了 null 却没记账（这一层的 bug）`);
      continue;
    }
    const whole = e.pre.length === 0 ? body : [...e.pre, body].join('\n');
    /* 体那一层要的**模块级槽**（`once` 的旗子、`static` 局部量那一格与它的闸门）：
       发在函数**前面** —— 方言那一侧先声明后用。 */
    for (const s of e.slots) decls.push(`  (global ${s.name} ${s.ty})`);
    if (isMain) { mainBody = whole; continue; }
    decls.push(`  ${hd.head}\n${whole})`);
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
