// src/lang/jnc/emit-body.js —— **函数体驱动**：把 `emit-stmt` 与 `emit-expr` 串成"整个体"
//
// 这一份补的正是那几格注入：
//   `block`（一串语句 → 一段文字，`catch:` 要切两段）、`cond`（条件）、`exprStmt`（一条表达式
//   语句）、`forPlan`（`for` 的三格）、`switchPlan`（分组与派发表）、`tmp`（共用的临时号）。
//
// 还差的两块由更上层给（它们要类型那条腿）：`lookup`（裸名字的九步）与
// `fieldOf` / `elemOf` / `callOf`。给不出来时驱动**记账走开**，不猜。

import { headOf, named } from './adapt.js';
import { allInChain, chainOf } from './declare.js';
import { emitStmt } from './emit-stmt.js';
import { emitExpr } from './emit-expr.js';
import { truthyCode } from './expr-table.js';
import {
  catchAt, catchBlockLines, CONT_LOOP_HEADS, EC_HOIST,
} from './stmt-table.js';

/**
 * 一格函数体（`compound`）→ 一段文字。`env` 里要给：
 *   { tmp(prefix), acct(why), loops, retVoid, inMain, T, is*, lookup, fieldOf, elemOf, callOf }
 * 拼不出来答 `null`（账已经记过）。
 */
export function emitBody(bodyNode, env, ind = 4) {
  const ctx = makeCtx(env);
  return ctx.block(bodyNode, ind);
}

/**
 * 体里有没有一条 `continue` 正好指着**这一层**（第四十二刀）。数的规矩与 `continue N`
 * 一致：**只数真循环**（`CONT_LOOP_HEADS`）—— switch 那圈合成的 while 不算。
 */
function contTargets(n, d) {
  if (n === null || n === undefined || typeof n !== 'object' || !Array.isArray(n.items)) return false;
  const h = headOf(n);
  if (h === 'continue') {
    const lv = Number(named(n)?.level?.value ?? 1) || 1;
    return lv === d + 1;
  }
  const inner = CONT_LOOP_HEADS.has(h) ? d + 1 : d;
  for (const it of n.items) if (contTargets(it, inner)) return true;
  return false;
}

/** 把那几格注入拼齐，答一个能递给 `emitStmt` 的 `ctx`。 */
export function makeCtx(env) {
  const ctx = {
    ...env,
    loops: env.loops ?? [],
    guards: env.guards ?? [],
    ind: 0,
  };

  /**
   * 一条语句 —— **errorcode 的传播落点就开在这儿**（第五十八刀）。`EC_HOIST` 那几族开一格
   * 落点：降完把收上来的那两句（`(let $eN …)` 与 `(if 出错 跳)`）摆在**这条语句之前**。
   * 别的族把落点**关掉**（`ecOut === null`）—— 关掉就是"这儿插不进语句"，落进去的
   * errorcode 调用当场记账不收，而不是悄悄发一段跑法不一样的代码。
   *
   * 循环那三种不开：条件每一圈都要重求，抬到外面就是错的。
   */
  ctx.stmt = (node, ind) => {
    const h = headOf(node);
    const saveOut = ctx.ecOut;
    const savePad = ctx.ecPad;
    ctx.ecOut = h !== null && EC_HOIST.has(h) ? [] : null;
    ctx.ecPad = ' '.repeat(ind);
    const r = emitStmt(node, { ...ctx, ind });
    const pre = ctx.ecOut;
    ctx.ecOut = saveOut;
    ctx.ecPad = savePad;
    if (r === null) return null;
    return pre === null || pre.length === 0 ? r : [...pre, ...r];
  };

  /**
   * 在**惰性位置**上降一格东西（第五十八刀）：`&&` / `||` 的右边、`? :` 的两支 —— 那儿求不求值
   * 要看别人。传播那两句只插得到"这条语句之前"，插到那儿就成了"无条件先调一遍"，求值顺序与
   * 短路语义一起被改掉。所以这些位置把落点**关掉**。
   */
  ctx.lazy = (run) => {
    const save = ctx.ecOut;
    ctx.ecOut = null;
    const r = run();
    ctx.ecOut = save;
    return r;
  };

  /**
   * **一格守护作用域**（第五十九刀）：`try { … }` 与 `catch:` 前面那一段都是它。里头的
   * errorcode 调用出错时**跳这一圈的出口**（`escapeText` 按"到栈顶的距离"算层号），
   * 而不是回调用方。`flag` 不是 null 时还要先记一笔"出过错"（`catch:` 用它挑处理段）。
   */
  ctx.guard = (flag, run) => {
    ctx.loops.push({ kind: 'oneshot', step: false });
    ctx.guards.push({ flag, loopIdx: ctx.loops.length - 1 });
    const r = run();
    ctx.guards.pop();
    ctx.loops.pop();
    return r;
  };

  /**
   * 一格条件。方言的条件只收 bool，而 jancy 把整数、实数、指针、枚举、字符串与函数值
   * 都当条件用 —— 那次隐式转换在这儿**显式写出来**（`truthyCode`，次序就是规则）。
   * 先前这一层只把值降出来就交上去，于是 `if (s)`（字符串）与 `x ? …` 里那一格都少了这一步。
   */
  ctx.cond = (node) => {
    const v = emitExpr(node, env.T?.bool ?? null, ctx);
    if (v === null) return null;
    const code = truthyCode(v.code, v.type, ctx);
    if (code === null) { env.acct('这一格当条件用还拼不出来（真值化那一步）'); return null; }
    return code;
  };

  /** 一格表达式 → 文字（要什么类型由调用方给，默认不指定）。 */
  ctx.expr = (node, want = null) => {
    const v = emitExpr(node, want, ctx);
    return v === null ? null : v.code;
  };

  /**
   * 一条表达式语句。方言那一侧是 `(expr …)`；赋值那一族由 `ctx.assign` 接
   * （分派次序在 `ASSIGN_ORDER`：花括号右边不是赋值、属性要排在求左值之前）。
   */
  ctx.exprStmt = (node, ind) => {
    const pad = ' '.repeat(ind);
    const h = headOf(node);
    /* **`x++` / `++x` / `x--` / `--x` 当一条语句**：就是"读一次、加一、写回" ——
       前缀与后缀在**语句位置上没差别**（那点差别只在"整条表达式的值"上，而语句不要值）。
       写回时那一格要回卷（落进一格），所以走的是 `wide` 那条路。 */
    if (['post-inc', 'pre-inc', 'post-dec', 'pre-dec'].includes(h)) {
      const one = h.endsWith('dec') ? '-' : '+';
      const ls = env.incDec?.(named(node)?.a, one, ind, ctx);
      if (ls === null || ls === undefined) { env.acct(`\`${h}\` 这一格还拼不出来`); return null; }
      return ls;
    }
    /* **`printf(…)` 发的是几行语句**（按 `\n` 切段，每段一条 `print`）—— 不是一格值，
       所以它在这一层就要认出来，不能等到"降一格表达式"那儿。 */
    if (h === 'call') {
      const fn = named(node)?.fn;
      const key = headOf(fn) === 'name' ? String(named(fn)?.text?.value ?? '') : null;
      if (key === 'printf') {
        const n0 = env.acctSeen?.() ?? 0;
        const ls = env.printf?.(node, ind, ctx);
        if (ls === null || ls === undefined) {
          /* **别拿转手账盖住真原因**：里头记过了就不再补一条（`acctSeen`）。 */
          if ((env.acctSeen?.() ?? 0) === n0) env.acct('printf 那一族还拼不出来（里头没记账 —— 这一层的 bug）');
          return null;
        }
        return ls;
      }
      /**
       * **`print(x)` 也是一句语句**（`(write 值)`，不添换行 —— 第六十四刀）：所以它与 printf
       * 同一层认出来，等到"降一格表达式"那儿就晚了（那一层回的是值）。
       * 源码里**自己写了**一格 `print` 的那一格先赢：那时这个钩子答 `undefined`，
       * 往下照常路走（90-print-own.jnc 量的正是这一格）。
       */
      if (key === 'print') {
        const n0 = env.acctSeen?.() ?? 0;
        const ls = env.printOut?.(node, ind, ctx);
        if (ls === null) {
          if ((env.acctSeen?.() ?? 0) === n0) env.acct('print 那一族还拼不出来（里头没记账 —— 这一层的 bug）');
          return null;
        }
        if (ls !== undefined) return ls;
      }
    }
    if (h === 'assign') {
      const n0 = env.acctSeen?.() ?? 0;
      const ls = env.assign?.(node, ind, ctx);
      if (ls === null || ls === undefined) {
        if ((env.acctSeen?.() ?? 0) === n0) env.acct('赋值这一格还拼不出来（里头没记账 —— 这一层的 bug）');
        return null;
      }
      return ls;
    }
    const v = emitExpr(node, null, ctx);
    if (v === null) return null;
    /* **抬走了的那一格**（errorcode 的传播、惰性那两格单元…）：值已经落在临时量上、传播那两句
       也已经排在这条语句之前了，所以这条语句本身**一个字都不发**（lower.js:11721）。
       先前照旧发一句 `(expr (var $e0))` —— 55-errorcode.jnc 的 `viaStmt` 就是量出它的那一格。 */
    if (v.hoisted === true) return [];
    return [`${pad}(expr ${v.code})`];
  };

  /**
   * **控制语句的体**（`if` / `while` / `do` / `for` 那四格的体）。旧降级的 `body()`
   * （lower.js:12474-12485）**单条与块都套一圈 `(do …)`** —— 省一处形状判断，也让那一圈
   * 自带的作用域把体里的声明关住。所以这一层与 `block` 分家：`block` 是"一串语句"
   * （函数体、switch 的一组），`body` 是"控制语句下面那一格"。
   *
   * 先前这两件事共用 `block`，于是 `if (n <= 1) return 1;` 少了那一圈 `(do …)`
   * —— 尺子上一次量出五格（02-control.jnc 的 `fact`、15-forward.jnc 那两格…）。
   */
  ctx.body = (node, ind) => {
    const pad = ' '.repeat(ind);
    const inner = ctx.block(node, ind + 2);
    return inner === null ? null : `${pad}(do\n${inner}\n${pad})`;
  };

  /**
   * 一个 `{ … }` 块 → 一段文字。**`catch:` 把语句序列切成两段**（第五十九刀），所以那一格
   * 由块这一层拦下来 —— 它不是一条能单独降的语句。
   */
  ctx.block = (node, ind) => {
    /* **体可以只是一条语句**（`if (x) return;`、`while (c) i++;`）——旧降级那儿走的是
       `body()` 而不是 `block()`：一条语句就降那一条，不用套 `(do …)`。 */
    if (headOf(node) !== 'compound') {
      const ls = ctx.stmt(node, ind);
      return ls === null ? null : ls.join('\n');
    }
    /* 语句链是**空基例**那一族（`unit` 一格子项都没有 + `unit-add {list, one}`，节点表 :25-26）
       —— 空基例要用 `chainOf`，拿 `allInChain` 走会把整条链当成一条语句（declare.js 那条注）。 */
    const list = chainOf(named(node)?.body, 'unit-add');
    /* **`catch:` 那一格的标签文本在 `word` 洞里**（节点表 :151 `{ label: { word } }`）——
       先前照 `text` / `name` 读，两样都是 undefined，于是 `catch:` 一格都没认出来、
       整条落到"表里没有这一格语句：label"上（**按表读树**，又是同一处）。 */
    const labelOf = (s) => String(named(s)?.word?.value ?? '');
    const isCatch = (s) => headOf(s) === 'label' && labelOf(s) === 'catch';
    const at = catchAt(list, isCatch);
    if (at >= 0) {
      const flag = env.tmp('$c');
      /* 前一段是**守护起来的**（`ctx.guard`）：里头的 errorcode 调用出错时先记一笔
         `(set $cN 真)` 再跳这一圈的出口，处理那一段靠那个标志挑。 */
      let bad = false;
      const guarded = ctx.guard(flag, () => {
        const acc = [];
        for (const s of list.slice(0, at)) {
          const ls = ctx.stmt(s, ind + 4);
          if (ls === null) { bad = true; return acc; }
          acc.push(...ls);
        }
        return acc;
      });
      if (bad) return null;
      /* 处理那一段在**守护之外**（jancy 同：catch 作用域里再抛是往外一层找）。 */
      const handler = [];
      for (const s of list.slice(at + 1)) {
        const ls = ctx.stmt(s, ind + 4);
        if (ls === null) return null;
        handler.push(...ls);
      }
      return catchBlockLines(flag, guarded, handler, ' '.repeat(ind)).join('\n');
    }
    const out = [];
    for (const s of list) {
      const ls = ctx.stmt(s, ind);
      if (ls === null) return null;
      out.push(...ls);
    }
    return out.join('\n');
  };

  /**
   * `for` 的三格。`init` 是声明或一串表达式语句、`step` 是一串表达式语句、条件可空。
   * **带步进又有 `continue` 指着这一层**时给体套一圈一次性循环（第四十二刀）——
   * "有没有 continue 指着这一层"由调用方数（`env.contTargets`）。
   */
  ctx.forPlan = (n, ind) => {
    const nm = named(n) ?? {};
    const initLines = [];
    if (headOf(nm.init) === 'var-decl' || headOf(nm.init) === 'var-decl-curly') {
      const ls = env.localDecl?.(nm.init, ind + 2, ctx);
      if (ls === null || ls === undefined) return null;
      initLines.push(...ls);
    } else if (nm.init !== undefined && nm.init !== null && headOf(nm.init) !== 'none') {
      for (const e of allInChain(nm.init, 'exprs-add', 'exprs')) {
        const ls = ctx.exprStmt(e, ind + 2);
        if (ls === null) return null;
        initLines.push(...ls);
      }
    }
    const stepLines = [];
    if (nm.step !== undefined && nm.step !== null && headOf(nm.step) !== 'none') {
      for (const e of allInChain(nm.step, 'exprs-add', 'exprs')) {
        const ls = ctx.exprStmt(e, ind + 6);
        if (ls === null) return null;
        stepLines.push(...ls);
      }
    }
    let condText = null;
    if (nm.cond !== undefined && nm.cond !== null && headOf(nm.cond) !== 'none') {
      condText = ctx.cond(nm.cond);
      if (condText === null) return null;
    }
    const oneshot = stepLines.length > 0 && contTargets(nm.body, 0);
    ctx.loops.push({ kind: 'loop', step: stepLines.length > 0 });
    if (oneshot) ctx.loops.push({ kind: 'oneshot', step: false });
    const body = ctx.body(nm.body, ind + (oneshot ? 8 : 4));
    if (oneshot) ctx.loops.pop();
    ctx.loops.pop();
    if (body === null) return null;
    return { initLines, condText, stepLines, body, oneshot };
  };

  /**
   * `switch` 的分组与派发表。一组 = 一串 `case` 标签后面那几条语句；`default` 那一组由
   * "一个都不中时指向组的个数"那条规则自然落下（缺省组在派发表里没有条目）。
   * 那圈合成的 `while` 记成 `switch`：`break` 数它、`continue` 不数它。
   */
  ctx.switchPlan = (n, ind) => {
    const nm = named(n) ?? {};
    /* **`switch` 的 `body` 洞里躺的就是那条语句链**（`unit-add`），不是一格 `compound`
       —— 先前多剥了一层（`named(nm.body)?.body`），于是一组都数不出来：`$sk` 的缺省值
       成了 0、派发那几句一条都没发（35-switch.jnc 量出来的）。 */
    const list = chainOf(nm.body, 'unit-add');
    const groups = [];
    const cases = [];
    let def = null;
    let cur = null;
    ctx.loops.push({ kind: 'switch', step: false });
    for (const s of list) {
      const h = headOf(s);
      if (h === 'case' || h === 'default') {
        if (cur === null) { cur = []; groups.push(cur); }
        else if (cur.length > 0) { cur = []; groups.push(cur); }
        if (h === 'case') {
          const k = env.constInt?.(named(s)?.value);
          if (k === null || k === undefined) { ctx.loops.pop(); env.acct('case 的值算不出来'); return null; }
          cases.push({ value: k, group: groups.length - 1 });
        } else {
          /* **`default:` 记的是它那一组的号**：一个都不中时 `$sk` 指它。两个 default 是错。 */
          if (def !== null) { ctx.loops.pop(); env.acct('switch 里有两个 default'); return null; }
          def = groups.length - 1;
        }
        continue;                                  // `case` / `default` 自己没有体（都是扁平的标记）
      }
      if (cur === null) { cur = []; groups.push(cur); }
      const ls = ctx.stmt(s, ind);
      if (ls === null) { ctx.loops.pop(); return null; }
      cur.push(...ls);
    }
    ctx.loops.pop();
    return {
      cases,
      def: def === null ? groups.length : def,
      groups: groups.map((g) => (g.length === 0 ? null : g.join('\n'))),
    };
  };

  /* 把拼齐的 `ctx` 交回给调用方 —— 注入那几格（`callOf` 那些）也要用它的 `expr`。 */
  env.onCtx?.(ctx);
  return ctx;
}
