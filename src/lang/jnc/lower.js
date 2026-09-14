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
import { scanAggs, scanFns, memberInit } from './module-scan.js';
import { structLine } from './emit-agg.js';
import { globalLines, addrTaken, liftable, liftedType } from './emit-global.js';
import { fnHead, readFormals, fnName, needsCtor, hasStaticCtor } from './emit-fn.js';
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
    bindable: gBindable, roots, aggs, statics: aggStatics, props: aggProps, bases: aggBases,
    overloads,
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
   * `head0` 是**插在体之前**的那几行（字段初值那一族：jancy 把它们放在基类构造之后、
   * 用户的体之前，jnc_ct_Parser.cpp:3005-3009）。
   */
  const emitFn = (node, shown, owner, selfInfo, ns, propScope = null, head0 = []) => {
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
      aggCtors,
      methods,
      tags,
      fieldInits,
      self: { agg: cls, kind, emit: kind === 'class' ? clsRoot(cls) : cls },
      ecBox,
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
    /* **这几族这一层还接不上**：有它们在就不合成（否则发出来的构造漏了半截）。 */
    const otherReason = (a) => hasStaticCtor(a)
      || a.members.some((m) => m.shape === 'event' || m.shape === 'prop' || m.shape === 'reactor')
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

  /* **方法那一族**（体写在类里的那几格）：一格一格发 `(fn <东家>$<方法名> (($this …) …) …)`。 */
  for (const key of overloads) {
    acct(`方法 '${key}' 有重载（按实参挑哪一格）还没接`);
  }
  /**
   * 人写的 `construct` 里有没有**显式**调基类的构造（`basetype.construct(…)`）。没有的话
   * 编译器补一句（53-inherit.jnc 那格 `Cow`：基类那一个不带实参，所以自动补）——
   * 补的那一句要排在字段初值与体之前（jnc_ct_Parser.cpp:3005-3009）。
   */
  const callsBaseCtor = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some((x) => callsBaseCtor(x));
    if (headOf(node) === 'field') {
      const f = named(node);
      if (String(f?.name?.value ?? '') === 'construct' && headOf(f?.obj) === 'basetype') return true;
    }
    return Array.isArray(node.items) ? node.items.some((x) => callsBaseCtor(x)) : false;
  };
  for (const [key, mi] of methods) {
    if (mi.hasBody !== true) continue;                   // 只写原型的，体在类外（下面那条路发）
    const a = aggs.find((x) => x.emitName === mi.owner);
    const kind = a !== undefined && (a.word === 'class' || a.word === 'opaque class') ? 'class' : 'struct';
    const ownerEmit = kind === 'class' ? clsRoot(mi.owner) : mi.owner;
    /* **构造那一格前头还有两截**：基类的构造（没显式调就补）+ 字段初值。 */
    const head0 = [];
    if (mi.name === 'construct') {
      const bs = (aggBases.get(mi.owner) ?? []).filter((b) => methods.has(`${b}$construct`));
      if (bs.length > 0 && !callsBaseCtor(named(mi.node)?.body)) {
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
    emitFn(
      mi.node,
      key,
      mi.owner,
      mi.stat === true ? null : { agg: mi.owner, kind, emit: ownerEmit },
      null,
      null,
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
