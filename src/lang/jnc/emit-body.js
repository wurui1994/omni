// src/lang/jnc/emit-body.js —— **函数体驱动**：把 `emit-stmt` 与 `emit-expr` 串成"整个体"
//
// 这一份补的正是那几格注入：
//   `block`（一串语句 → 一段文字，`catch:` 要切两段）、`cond`（条件）、`exprStmt`（一条表达式
//   语句）、`forPlan`（`for` 的三格）、`switchPlan`（分组与派发表）、`tmp`（共用的临时号）。
//
// 还差的两块由更上层给（它们要类型那条腿）：`lookup`（裸名字的九步）与
// `fieldOf` / `elemOf` / `callOf`。给不出来时驱动**记账走开**，不猜。

import { headOf, named } from './adapt.js';
import { allInChain } from './declare.js';
import { emitStmt } from './emit-stmt.js';
import { emitExpr } from './emit-expr.js';
import { catchAt, catchBlockLines } from './stmt-table.js';

/**
 * 一格函数体（`compound`）→ 一段文字。`env` 里要给：
 *   { tmp(prefix), acct(why), loops, retVoid, inMain, T, is*, lookup, fieldOf, elemOf, callOf }
 * 拼不出来答 `null`（账已经记过）。
 */
export function emitBody(bodyNode, env, ind = 4) {
  const ctx = makeCtx(env);
  return ctx.block(bodyNode, ind);
}

/** 把那几格注入拼齐，答一个能递给 `emitStmt` 的 `ctx`。 */
export function makeCtx(env) {
  const ctx = {
    ...env,
    loops: env.loops ?? [],
    ind: 0,
  };

  /** 一格条件：方言那一侧就是一段文字（`bool` 那一格由调用方定型）。 */
  ctx.cond = (node) => {
    const v = emitExpr(node, env.T?.bool ?? null, ctx);
    return v === null ? null : v.code;
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
    if (h === 'assign') {
      const ls = env.assign?.(node, ind);
      if (ls === null || ls === undefined) { env.acct('赋值这一格还拼不出来'); return null; }
      return ls;
    }
    const code = ctx.expr(node);
    return code === null ? null : [`${pad}(expr ${code})`];
  };

  /**
   * 一个 `{ … }` 块 → 一段文字。**`catch:` 把语句序列切成两段**（第五十九刀），所以那一格
   * 由块这一层拦下来 —— 它不是一条能单独降的语句。
   */
  ctx.block = (node, ind) => {
    if (headOf(node) !== 'compound') { env.acct('这里要一个 { … } 块'); return null; }
    const list = allInChain(named(node)?.body, 'stats-add', 'stats');
    const isCatch = (s) => headOf(s) === 'label'
      && String(named(s)?.text?.value ?? named(s)?.name?.value ?? '') === 'catch';
    const at = catchAt(list, isCatch);
    if (at >= 0) {
      const flag = env.tmp('$c');
      ctx.loops.push({ kind: 'oneshot', step: false });
      const guarded = [];
      for (const s of list.slice(0, at)) {
        const ls = emitStmt(s, { ...ctx, ind: ind + 4 });
        if (ls === null) { ctx.loops.pop(); return null; }
        guarded.push(...ls);
      }
      ctx.loops.pop();
      const handler = [];
      for (const s of list.slice(at + 1)) {
        const ls = emitStmt(s, { ...ctx, ind: ind + 4 });
        if (ls === null) return null;
        handler.push(...ls);
      }
      return catchBlockLines(flag, guarded, handler, ' '.repeat(ind)).join('\n');
    }
    const out = [];
    for (const s of list) {
      const ls = emitStmt(s, { ...ctx, ind });
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
      const ls = env.localDecl?.(nm.init, ind + 2);
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
    const oneshot = stepLines.length > 0 && (env.contTargets?.(nm.body) === true);
    ctx.loops.push({ kind: 'loop', step: stepLines.length > 0 });
    if (oneshot) ctx.loops.push({ kind: 'oneshot', step: false });
    const body = ctx.block(nm.body, ind + (oneshot ? 8 : 4));
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
    const list = allInChain(named(nm.body)?.body, 'stats-add', 'stats');
    const groups = [];
    const cases = [];
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
        }
        const inner = named(s)?.body;
        if (inner !== undefined && inner !== null) {
          const ls = emitStmt(inner, { ...ctx, ind });
          if (ls === null) { ctx.loops.pop(); return null; }
          cur.push(...ls);
        }
        continue;
      }
      if (cur === null) { cur = []; groups.push(cur); }
      const ls = emitStmt(s, { ...ctx, ind });
      if (ls === null) { ctx.loops.pop(); return null; }
      cur.push(...ls);
    }
    ctx.loops.pop();
    return { cases, groups: groups.map((g) => g.join('\n')) };
  };

  return ctx;
}
