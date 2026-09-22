// src/core/lower/lower-expr.js —— 公共降级器的表达式降级（ADR-0044）
//
// 标准 IR 的表达式描述 → .sx text。所有语言共用。

import * as sx from './sx.js';

/**
 * 降级一个表达式。回一段 .sx 文本。
 *
 * @param {object} expr  标准 IR 表达式描述
 * @param {object} ctx   降级上下文
 * @returns {string}     .sx 文本
 */
export function lowerExpr(expr, ctx) {
  switch (expr.kind) {
    case 'int': return sx.int(expr.value);
    case 'real': return sx.real(expr.value);
    case 'string': return sx.str(expr.value);
    case 'bool': return sx.bool(expr.value);
    case 'null': return '(null void)';
    case 'name': return sx.varOf(expr.name);
    case 'binop': return lowerBinop(expr, ctx);
    case 'unop': return lowerUnop(expr, ctx);
    case 'call': return lowerCall(expr, ctx);
    case 'method': return lowerMethod(expr, ctx);
    case 'field': return lowerField(expr, ctx);
    case 'index': return lowerIndex(expr, ctx);
    case 'ternary': return lowerTernary(expr, ctx);
    case 'cast': return lowerCast(expr, ctx);
    case 'new-record': return lowerNewRecord(expr, ctx);
    case 'new-list': return lowerNewList(expr, ctx);
    case 'new-map': return lowerNewMap(expr, ctx);
    case 'addr-of': return lowerAddrOf(expr, ctx);
    case 'deref': return lowerDeref(expr, ctx);
    case 'slice': return lowerSlice(expr, ctx);
    default:
      if (ctx.hooks?.lowerExpr) {
        const r = ctx.hooks.lowerExpr(expr, ctx);
        if (r !== null && r !== undefined) return r;
      }
      return `(var __unknown_${expr.kind})`;
  }
}

function lowerBinop(e, ctx) {
  const a = lowerExpr(e.left, ctx);
  const b = lowerExpr(e.right, ctx);
  // 整数二元：需要类型信息决定是否掩码。由语言钩子提供。
  if (ctx.hooks?.intBinary) {
    const r = ctx.hooks.intBinary(e.op, a, b, e);
    if (r !== null && r !== undefined) return r;
  }
  // 短路：&& 和 || 走分支
  if (e.op === '&&') return sx.sel(a, b, sx.bool(false));
  if (e.op === '||') return sx.sel(a, sx.bool(true), b);
  return sx.bin(e.op, a, b);
}

function lowerUnop(e, ctx) {
  const a = lowerExpr(e.operand, ctx);
  if (ctx.hooks?.intUnary) {
    const r = ctx.hooks.intUnary(e.op, a, e);
    if (r !== null && r !== undefined) return r;
  }
  if (e.op === '!') return sx.un('!', a);
  if (e.op === '-') return sx.un('-', a);
  return sx.un(e.op, a);
}

function lowerCall(e, ctx) {
  const fn = lowerExpr(e.fn, ctx);
  const args = e.args.map((a) => lowerExpr(a, ctx));
  // 如果 fn 是一个名字，用 call；否则用 callfn
  if (e.fn.kind === 'name') return sx.call(e.fn.name, args);
  return sx.callfn(fn, args);
}

function lowerMethod(e, ctx) {
  const obj = lowerExpr(e.obj, ctx);
  const args = e.args.map((a) => lowerExpr(a, ctx));
  // 方法调用 → 普通调用（obj 作为第一个参数）
  if (ctx.hooks?.lowerMethod) {
    const r = ctx.hooks.lowerMethod(e, obj, args, ctx);
    if (r !== null && r !== undefined) return r;
  }
  return sx.call(e.name, [obj, ...args]);
}

function lowerField(e, ctx) {
  const obj = lowerExpr(e.obj, ctx);
  if (ctx.hooks?.lowerField) {
    const r = ctx.hooks.lowerField(e, obj, ctx);
    if (r !== null && r !== undefined) return r;
  }
  return sx.pload(sx.pfield(obj, e.name));
}

function lowerIndex(e, ctx) {
  const obj = lowerExpr(e.obj, ctx);
  const idx = lowerExpr(e.index, ctx);
  if (ctx.hooks?.lowerIndex) {
    const r = ctx.hooks.lowerIndex(e, obj, idx, ctx);
    if (r !== null && r !== undefined) return r;
  }
  return sx.pload(sx.padd(sx.pelem(obj), idx));
}

function lowerTernary(e, ctx) {
  return sx.sel(
    lowerExpr(e.cond, ctx),
    lowerExpr(e.then, ctx),
    lowerExpr(e.else_, ctx),
  );
}

function lowerCast(e, ctx) {
  if (ctx.hooks?.lowerCast) {
    const r = ctx.hooks.lowerCast(e, ctx);
    if (r !== null && r !== undefined) return r;
  }
  return lowerExpr(e.expr, ctx);
}

function lowerNewRecord(e, ctx) {
  if (ctx.hooks?.lowerNewRecord) return ctx.hooks.lowerNewRecord(e, ctx);
  // 默认：struct 字面量暂不支持（需要语言钩子）
  return `(var __new_record_${e.type ?? 'anon'})`;
}

function lowerNewList(e, ctx) {
  if (ctx.hooks?.lowerNewList) return ctx.hooks.lowerNewList(e, ctx);
  return `(var __new_list)`;
}

function lowerNewMap(e, ctx) {
  if (ctx.hooks?.lowerNewMap) return ctx.hooks.lowerNewMap(e, ctx);
  return `(var __new_map)`;
}

function lowerAddrOf(e, ctx) {
  if (ctx.hooks?.lowerAddrOf) return ctx.hooks.lowerAddrOf(e, ctx);
  return lowerExpr(e.expr, ctx);
}

function lowerDeref(e, ctx) {
  return sx.pload(lowerExpr(e.expr, ctx));
}

function lowerSlice(e, ctx) {
  if (ctx.hooks?.lowerSlice) return ctx.hooks.lowerSlice(e, ctx);
  return lowerExpr(e.obj, ctx);
}
