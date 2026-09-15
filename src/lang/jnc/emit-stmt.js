// src/lang/jnc/emit-stmt.js —— **语句驱动**：照 `stmt-table.js` 那张表把一条语句降成方言的几行
//
// 表在 `stmt-table.js`（形状与模板），这一份只做三件事：
//   1. 按节点头**查表分派**（不再 if-else 堆一片）；
//   2. 把体、条件、表达式这三样交给注入的回调（`ctx.block` / `ctx.cond` / `ctx.expr`）——
//      表达式那一半是另一条腿，这一层不认识它；
//   3. 取号（`ctx.tmp()`：`$doN` / `$svN` / `$skN` / `$cN` / `jnc$once$N` 共用那一个计数器）。
//
// 答一串行（`string[]`，缩进已经拼好），拼不出来答 `null` 并往 `ctx.acct(why)` 记一笔账。
// **不猜**：表里没有的头一律记账走开，这是与别的读取器同一条规矩。

import { headOf, named } from './adapt.js';
import { allInChain } from './declare.js';
import {
  NO_CODE, NOT_YET, stmtLines, jumpLevel, jumpText,
  whileLines, doWhileLines, forLines, ifLines, switchLines, assertLines, srcTextOf,
  returnKind,
} from './stmt-table.js';
import { strLitFold } from './emit-expr.js';

/**
 * 一条语句 → 几行。`ctx`：
 *   {
 *     ind,                       // 缩进（空格数）
 *     block(node, ind),          // 一个 `{ … }` 块 → 一段文字（换行拼好的）
 *     cond(node),                // 一格条件 → 方言文字
 *     expr(node),                // 一格表达式 → 方言文字
 *     exprStmt(node, ind),       // 一条表达式语句 → 几行
 *     localDecl(node, ind),      // 一格局部量声明 → 几行
 *     tmp(prefix),               // 取一个号（共用计数器）
 *     loops,                     // 循环栈：[{ kind: 'loop'|'switch'|'oneshot', step }]
 *     escape(),                  // errorcode / throw 那一跳
 *     retVoid, inMain,           // 返回那一族要的两件事
 *     acct(why),                 // 记账
 *   }
 */
export function emitStmt(n, ctx) {
  const h = headOf(n);
  if (h === null) { ctx.acct('认不出的语句'); return null; }
  const pad = ' '.repeat(ctx.ind);
  const nm = named(n) ?? {};

  /* 表里直接有的那几族（不发码、`(do …)`、`unsafe`、`try`、`once`、`throw`）。 */
  if (NO_CODE.has(h) || ['compound', 'unsafe', 'try', 'once', 'throw', 'attributed'].includes(h)) {
    return stmtLines(h, n, {
      pad,
      ind: ctx.ind,
      block: ctx.block,
      stmt: (x, i) => (ctx.stmt === undefined ? emitStmt(x, { ...ctx, ind: i }) : ctx.stmt(x, i)),
      hole: (x, name) => named(x)?.[name],
      /* `once` 的那面旗子是**模块级**的（跨调用留着，cflow_once.rst:15）：所以要走
         `newSlot` 让模块那一层把 `(global jnc$once$N bool)` 发出来 —— 光取个名字不够。 */
      once: () => (ctx.newSlot === undefined ? ctx.tmp('jnc$once$') : ctx.newSlot('jnc$once$', 'bool')),

      escape: ctx.escape,
      /* `try { … }` 那一格要**先把守护推上去**再降体（errorcode 出错时跳这一圈的出口）。
         少了这一格，落在嵌套 `try` 里的调用会去认外层 `catch:` 的标志 —— 56-catch.jnc
         的 `both` 就是量出它的那一格。 */
      guard: ctx.guard,
    });
  }
  if (NOT_YET.has(h)) { ctx.acct(NOT_YET.get(h)); return null; }

  if (h === 'if') {
    const c = ctx.cond(nm.cond);
    const t = ctx.body(nm.then, ctx.ind + 2);
    if (c === null || t === null) return null;
    const e = nm.else === undefined || nm.else === null ? null : ctx.body(nm.else, ctx.ind + 2);
    return ifLines(c, t, e, pad);
  }

  if (h === 'while') {
    const c = ctx.cond(nm.cond);
    if (c === null) return null;
    ctx.loops.push({ kind: 'loop', step: false });
    const b = ctx.body(nm.body, ctx.ind + 2);
    ctx.loops.pop();
    return b === null ? null : whileLines(c, b, pad);
  }

  if (h === 'do') {
    const flag = ctx.tmp('$do');
    ctx.loops.push({ kind: 'loop', step: false });
    const b = ctx.body(nm.body, ctx.ind + 4);
    const c = ctx.cond(nm.cond);
    ctx.loops.pop();
    return b === null || c === null ? null : doWhileLines(flag, c, b, pad);
  }

  if (h === 'break' || h === 'continue') {
    const lvl = Number(nm.level?.value ?? 1) || 1;
    const r = jumpLevel(h, lvl, ctx.loops);
    if (r.level === null) {
      ctx.acct(r.bug === true
        ? `内部错：带步进的 for 没有套一次性循环，${h} 无处可跳`
        : `${h}${lvl === 1 ? '' : lvl} 要往外数 ${lvl} 层，这里只有 ${r.seen} 层`);
      return null;
    }
    return [`${pad}${jumpText(r.op, r.level)}`];
  }

  if (h === 'return') {
    const v = nm.value;
    const has = v !== undefined && v !== null;
    const r = returnKind({
      hasValue: has,
      retVoid: ctx.retVoid === true,
      inMain: ctx.inMain === true,
      isLiteralZero: has && !Array.isArray(v.items) && String(v.value) === '0',
      valueTypeName: has ? ctx.cheapTypeName?.(v) ?? null : null,
    });
    if (r.kind === 'ret') return [`${pad}(ret)`];
    if (r.kind === 'ret-value') {
      /* **返回类型就是那一格的 `want`**：回卷、装箱、int→real 那几条都挂在"落进一格"那一层，
         所以这儿必须把它传下去（少这一格，`return x + y` 就少了那次回卷）。 */
      const code = ctx.expr(v, ctx.retType ?? null);
      return code === null ? null : [`${pad}(ret ${code})`];
    }
    if (r.kind === 'expr-then-ret') {
      const ls = ctx.exprStmt(v, ctx.ind);
      return ls === null ? null : [...ls, `${pad}(ret)`];
    }
    ctx.acct(r.why);
    return null;
  }

  if (h === 'assert') {
    const c = ctx.cond(nm.cond);
    if (c === null) return null;
    const span = nm.cond?.span;
    const text = srcTextOf(span);
    if (text === null) { ctx.acct('assert 的条件取不到源码文本'); return null; }
    const where = span.file.lineCol(span.start);
    /* 洞的名字是 `msg`（节点表 :158），话要**折成一格串字面量**（`strLitFold`）——
       先前这儿读的是 `nm.words`、折的是一个压根不存在的 `ctx.litFold`，于是
       `assert(x == 4, "x should be four")` 后面那句话一声不响地丢了（rt/assert-fail.jnc
       量出来的：jancy 的 `assertionFailure` 带话时要追一个 ` (%s)`，
       jnc_ct_Parser.cpp:3798-3825）。 */
    const msg = strLitFold(nm.msg ?? null);
    return assertLines(c, span.file.path, where.line, text, msg, pad);
  }

  if (h === 'expr-stmt') return ctx.exprStmt(nm.expr ?? n.items[1], ctx.ind);
  if (h === 'var-decl' || h === 'var-decl-curly') return ctx.localDecl(n, ctx.ind, ctx);

  if (h === 'switch') {
    /* **`switch` 的洞名是 `value`**（节点表 :148），不是 `cond` —— 先前照 `cond ?? expr` 读，
       两样都是 undefined，于是整条落到"空的表达式"上（35-switch / 38-enum / 39-breakn /
       40-forcont 那四格账全是它）。**按表读树**。
       括号里是**逗号串**时那是**正则 switch**（Stmt.llk:192-195 的 resolver 就按这个分）
       —— 另一族，记账走开。 */
    const es = allInChain(nm.value, 'exprs-add', 'exprs');
    if (es.length !== 1) { ctx.acct('正则 switch（括号里是逗号串）'); return null; }
    /* **switch 的那一格值不真值化**（它要的是整数，不是 bool）：枚举落到基整数上，
       而枚举在方言里本来就发成 int，所以文字一个字都不用改。先前走了 `ctx.cond`，
       于是 `switch (x)` 出来是 `(bin "!=" (var x) (int 0))`。 */
    const c = ctx.expr(es[0]);
    if (c === null) return null;
    /* **`$svN` 与 `$skN` 共用同一个号**（旧降级那儿是 `$sv${tmp}` / `$sk${tmp}` 再 `tmp++`）。 */
    const nth = ctx.tmp('');
    const sv = `$sv${nth}`;
    const sk = `$sk${nth}`;
    const plan = ctx.switchPlan?.(n, ctx.ind + 6);
    if (plan === null || plan === undefined) { ctx.acct('switch 的分组还拼不出来'); return null; }
    return switchLines({
      sv, sk, condText: c, cases: plan.cases, groups: plan.groups, def: plan.def, pad,
    });
  }

  if (h === 'for') {
    const plan = ctx.forPlan?.(n, ctx.ind);
    if (plan === null || plan === undefined) { ctx.acct('for 的三格还拼不出来'); return null; }
    return forLines({ ...plan, pad });
  }

  ctx.acct(`表里没有这一格语句：${h}`);
  return null;
}
