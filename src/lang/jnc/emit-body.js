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
        const ls = env.printf?.(node, ind, ctx);
        if (ls === null || ls === undefined) { env.acct('printf 那一族还拼不出来'); return null; }
        return ls;
      }
    }
    if (h === 'assign') {
      const ls = env.assign?.(node, ind, ctx);
      if (ls === null || ls === undefined) { env.acct('赋值这一格还拼不出来'); return null; }
      return ls;
    }
    const code = ctx.expr(node);
    return code === null ? null : [`${pad}(expr ${code})`];
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
      const ls = emitStmt(node, { ...ctx, ind });
      return ls === null ? null : ls.join('\n');
    }
    /* 语句链是**空基例**那一族（`unit` 一格子项都没有 + `unit-add {list, one}`，节点表 :25-26）
       —— 空基例要用 `chainOf`，拿 `allInChain` 走会把整条链当成一条语句（declare.js 那条注）。 */
    const list = chainOf(named(node)?.body, 'unit-add');
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
    const oneshot = stepLines.length > 0 && (env.contTargets?.(nm.body) === true);
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
    const list = chainOf(named(nm.body)?.body, 'unit-add');
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

  /* 把拼齐的 `ctx` 交回给调用方 —— 注入那几格（`callOf` 那些）也要用它的 `expr`。 */
  env.onCtx?.(ctx);
  return ctx;
}
