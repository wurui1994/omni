// src/core/lower/lower-stmt.js —— 公共降级器的语句降级（ADR-0044）
//
// 标准 IR 的语句描述 → .sx text。所有语言共用。
// 每门语言的 adapter 把 CST 翻成 §1.2 的标准描述，这一份接手。

import * as sx from './sx.js';

/**
 * 降级一条语句。回一段 .sx 文本（可能多行）。
 *
 * @param {object} stmt  标准 IR 语句描述（§1.2 的形状）
 * @param {object} ctx   降级上下文 { scope, typeEnv, lowerExpr, lowerStmts, hooks }
 * @returns {string}     .sx 文本
 */
export function lowerStmt(stmt, ctx) {
  switch (stmt.kind) {
    case 'if': return lowerIf(stmt, ctx);
    case 'while': return lowerWhile(stmt, ctx);
    case 'for': return lowerFor(stmt, ctx);
    case 'for-range': return lowerForRange(stmt, ctx);
    case 'return': return lowerReturn(stmt, ctx);
    case 'break': return lowerBreak(stmt, ctx);
    case 'continue': return lowerContinue(stmt, ctx);
    case 'let': return lowerLet(stmt, ctx);
    case 'assign': return lowerAssign(stmt, ctx);
    case 'expr-stmt': return lowerExprStmt(stmt, ctx);
    case 'block': return lowerBlock(stmt, ctx);
    case 'switch': return lowerSwitch(stmt, ctx);
    case 'defer': return ctx.hooks?.lowerDefer?.(stmt, ctx) ?? '';
    default:
      if (ctx.hooks?.lowerStmt) {
        const r = ctx.hooks.lowerStmt(stmt, ctx);
        if (r !== null && r !== undefined) return r;
      }
      return `;;  未降级的语句：${stmt.kind}`;
  }
}

/** 降级一组语句，连成一个 (do ...) 块。 */
export function lowerStmts(stmts, ctx) {
  const lines = stmts.map((s) => lowerStmt(s, ctx)).filter((s) => s !== '');
  return lines.length === 0 ? '(do)' : `(do${lines.map((l) => `\n  ${l}`).join('')})`;
}

function lowerIf(s, ctx) {
  const c = ctx.lowerExpr(s.cond, ctx);
  const t = lowerStmts(s.then, ctx);
  const e = s.else_ ? lowerStmts(s.else_, ctx) : null;
  return e !== null ? `(if ${c} ${t} ${e})` : `(if ${c} ${t})`;
}

function lowerWhile(s, ctx) {
  const c = ctx.lowerExpr(s.cond, ctx);
  const b = lowerStmts(s.body, ctx);
  return `(while ${c} ${b})`;
}

function lowerFor(s, ctx) {
  // C 系的 for(init; cond; post) body → 展开成 init + while(cond) { body; post }
  const parts = [];
  if (s.init) parts.push(lowerStmt(s.init, ctx));
  const c = s.cond ? ctx.lowerExpr(s.cond, ctx) : sx.bool(true);
  const bodyParts = s.body.map((st) => lowerStmt(st, ctx));
  if (s.post) bodyParts.push(lowerStmt(s.post, ctx));
  const body = bodyParts.length === 0 ? '(do)' : `(do${bodyParts.map((l) => `\n  ${l}`).join('')})`;
  parts.push(`(while ${c} ${body})`);
  return parts.join('\n');
}

function lowerForRange(s, ctx) {
  // for name in iter { body } — 由语言的 hooks 处理（Go 的 range 和 Nim 的 for 语义不同）
  if (ctx.hooks?.lowerForRange) return ctx.hooks.lowerForRange(s, ctx);
  return `;;  for-range 需要语言钩子`;
}

function lowerReturn(s, ctx) {
  if (s.values.length === 0) return sx.ret();
  if (s.values.length === 1) return sx.ret(ctx.lowerExpr(s.values[0], ctx));
  // 多返回值：由语言钩子处理（Go 有，C 没有）
  if (ctx.hooks?.lowerMultiReturn) return ctx.hooks.lowerMultiReturn(s, ctx);
  return sx.ret(ctx.lowerExpr(s.values[0], ctx));
}

function lowerBreak(s, _ctx) {
  return s.label ? sx.op('brk', s.label) : sx.op('brk');
}

function lowerContinue(s, _ctx) {
  return s.label ? sx.op('cont', s.label) : sx.op('cont');
}

function lowerLet(s, ctx) {
  const v = s.init ? ctx.lowerExpr(s.init, ctx) : null;
  const ty = ctx.hooks?.typeToSx?.(s.type) ?? 'int';
  ctx.scope.declare(s.name, { type: s.type });
  if (v !== null) return `(let ${s.name} ${ty} ${v})`;
  return `(let ${s.name} ${ty})`;
}

function lowerAssign(s, ctx) {
  const target = ctx.lowerExpr(s.target, ctx);
  const value = ctx.lowerExpr(s.value, ctx);
  // 简单名字赋值 → (set name value)
  if (s.target.kind === 'name') return sx.set(s.target.name, value);
  // 其他（字段赋值、下标赋值）由表达式层处理
  return sx.exprStmt(value);
}

function lowerExprStmt(s, ctx) {
  return sx.exprStmt(ctx.lowerExpr(s.expr, ctx));
}

function lowerBlock(s, ctx) {
  ctx.scope.push();
  const r = lowerStmts(s.stmts, ctx);
  ctx.scope.pop();
  return r;
}

function lowerSwitch(s, ctx) {
  // switch → if/else 链（核心方言没有 switch）
  const v = ctx.lowerExpr(s.value, ctx);
  let out = '';
  for (let i = s.cases.length - 1; i >= 0; i--) {
    const c = s.cases[i];
    const cond = sx.bin('==', v, ctx.lowerExpr(c.match, ctx));
    const body = lowerStmts(c.body, ctx);
    const els = out || (s.default_ ? lowerStmts(s.default_, ctx) : null);
    out = els ? `(if ${cond} ${body} ${els})` : `(if ${cond} ${body})`;
  }
  if (!out && s.default_) return lowerStmts(s.default_, ctx);
  return out || '(do)';
}
