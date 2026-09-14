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
import {
  NO_CODE, NOT_YET, stmtLines, jumpLevel, jumpText,
  whileLines, doWhileLines, forLines, ifLines, switchLines, assertLines, srcTextOf,
  returnKind,
} from './stmt-table.js';

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
      stmt: (x, i) => emitStmt(x, { ...ctx, ind: i }),
      hole: (x, name) => named(x)?.[name],
      once: () => ctx.tmp('jnc$once$'),
      escape: ctx.escape,
    });
  }
  if (NOT_YET.has(h)) { ctx.acct(NOT_YET.get(h)); return null; }

  if (h === 'if') {
    const c = ctx.cond(nm.cond);
    const t = ctx.block(nm.then, ctx.ind + 2);
    if (c === null || t === null) return null;
    const e = nm.else === undefined || nm.else === null ? null : ctx.block(nm.else, ctx.ind + 2);
    return ifLines(c, t, e, pad);
  }

  if (h === 'while') {
    const c = ctx.cond(nm.cond);
    if (c === null) return null;
    ctx.loops.push({ kind: 'loop', step: false });
    const b = ctx.block(nm.body, ctx.ind + 2);
    ctx.loops.pop();
    return b === null ? null : whileLines(c, b, pad);
  }

  if (h === 'do') {
    const flag = ctx.tmp('$do');
    ctx.loops.push({ kind: 'loop', step: false });
    const b = ctx.block(nm.body, ctx.ind + 4);
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
    const msg = nm.words === undefined || nm.words === null ? null : ctx.litFold?.(nm.words) ?? null;
    return assertLines(c, span.file.path, where.line, text, msg, pad);
  }

  if (h === 'expr-stmt') return ctx.exprStmt(nm.expr ?? n.items[1], ctx.ind);
  if (h === 'var-decl' || h === 'var-decl-curly') return ctx.localDecl(n, ctx.ind, ctx);

  if (h === 'switch') {
    const c = ctx.cond(nm.cond ?? nm.expr);
    if (c === null) return null;
    const sv = ctx.tmp('$sv');
    const sk = ctx.tmp('$sk');
    const plan = ctx.switchPlan?.(n, ctx.ind + 6);
    if (plan === null || plan === undefined) { ctx.acct('switch 的分组还拼不出来'); return null; }
    return switchLines({
      sv, sk, condText: c, cases: plan.cases, groups: plan.groups, pad,
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
