// src/core/lower/lower-expr.js —— 公共降级器的表达式降级（ADR-0044）
//
// 标准 IR 的表达式描述 → .sx text。所有语言共用。

import * as sx from './sx.js';
import { typeToSx, zeroOf } from './ty.js';

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
    /**
     * 内建那一格：`{ kind: 'builtin', name, args }` → `(slen E)` / `(dget d k)` / …
     * **不是"给每门语言开一格节点"**：名字就是方言里那一格算子的名字，元数由 `sx.op`
     * 当场校验。lua 的 `#s` 与 awk 的 `length(s)` 在这儿是同一格。
     */
    case 'builtin': return sx.op(expr.name, ...expr.args.map((a) => lowerExpr(a, ctx)));
    /* 类型当实参那一格（`(anew (arr int) N)` 的第一格、`(dnew …)`、`(new T)`）。 */
    case 'type': return typeToSx(expr.type, ctx.hooks);
    /* 表达式位置上的 `if` / 块 —— **Scheme 那一族里它们是表达式**（见 lowerIfExpr）。 */
    case 'if-expr': return lowerIfExpr(expr, ctx);
    case 'block-expr': return lowerBlockExpr(expr, ctx);
    default:
      if (ctx.hooks?.lowerExpr) {
        const r = ctx.hooks.lowerExpr(expr, ctx);
        if (r !== null && r !== undefined) return r;
      }
      throw new Error(`lower-expr.js: 这一格表达式还没接：${expr.kind}`);
  }
}

/**
 * **表达式位置上的 `if`**（Scheme / Lisp 那一族里 `if` 交一个值）。
 *
 * 方言里 `if` 是语句，所以落成"一格临时量 + 两支各写一次"：
 *   `(let if_tmp1 T 零值)` `(if C (do (set if_tmp1 …)) (do (set if_tmp1 …)))` → `(var if_tmp1)`
 * 前两句进**语句槽**（`ctx.emit`，见 `lowerStmts`），回的只是那一格的读。
 *
 * `expr.type` 是这一格交出来的类型 —— **adapter 或推断那一层填好**（方言不推导）。
 */
function lowerIfExpr(e, ctx) {
  const ty = e.type ?? { kind: 'int' };
  const tmp = ctx.fresh('if_tmp');
  ctx.emit(`(let ${tmp} ${typeToSx(ty, ctx.hooks)} ${zeroOf(ty, ctx.hooks)})`);
  const cond = lowerExpr(e.cond, ctx);
  const arm = (x) => {
    /* 每一支自己一格语句槽：那一支里要先跑的几句只能摆在**那一支里**。 */
    const outer = ctx.sink;
    const pre = [];
    ctx.sink = pre;
    let v;
    try {
      v = lowerExpr(x, ctx);
    } finally {
      ctx.sink = outer;
    }
    return `(do${[...pre, sx.set(tmp, v)].map((l) => `\n  ${l.split('\n').join('\n  ')}`).join('')})`;
  };
  const els = e.else_ === null || e.else_ === undefined ? null : arm(e.else_);
  ctx.emit(els === null ? `(if ${cond} ${arm(e.then)})` : `(if ${cond} ${arm(e.then)} ${els})`);
  return sx.varOf(tmp);
}

/**
 * **表达式位置上的块**（`(let ((x 1)) … 最后一格是值)`）：前面那些语句进语句槽，
 * 回最后那一格的值。一格新的临时量都不用 —— 值就是最后那个表达式。
 */
function lowerBlockExpr(e, ctx) {
  for (const s of e.stmts) {
    const outer = ctx.sink;
    const pre = [];
    ctx.sink = pre;
    let text;
    try {
      text = ctx.lowerStmt(s, ctx);
    } finally {
      ctx.sink = outer;
    }
    for (const p of pre) ctx.emit(p);
    if (text !== '') ctx.emit(text);
  }
  return lowerExpr(e.value, ctx);
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
  /* **默认是记录的字段**（`(fld obj name)`）—— 借来的那十门里"字段"就是这一格。
     指针那一族（jnc 的 `p->f`、C 的成员）要 `pload (pfield …)`，由 `hooks.lowerField` 答。 */
  return sx.fld(obj, e.name);
}

function lowerIndex(e, ctx) {
  const obj = lowerExpr(e.obj, ctx);
  const idx = lowerExpr(e.index, ctx);
  if (ctx.hooks?.lowerIndex) {
    const r = ctx.hooks.lowerIndex(e, obj, idx, ctx);
    if (r !== null && r !== undefined) return r;
  }
  /* **默认是数组的下标**（`(aget a i)`，0 起）。字典要 `dget`（键是值，不是下标）——
     那一格由 adapter 发 `{ kind: 'builtin', name: 'dget' }` 或 `hooks.lowerIndex` 答。 */
  return sx.aget(obj, idx);
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

/**
 * **造一格记录**（`{ kind: 'new-record', type, ref, fields: [{name, value}] }`）。
 *
 * 方言里"造"与"填"是两件事（`(new T)` / `(cnew T)` 造，`(fldset …)` 填，后者是**语句**），
 * 所以这一格落成"一格临时量 + 每个字段一句 fldset"，进语句槽，回那一格的读。
 * `ref` 为真走 `cnew`（引用语义，`(class …)` 声明的），否则 `new`（值语义）。
 */
function lowerNewRecord(e, ctx) {
  if (ctx.hooks?.lowerNewRecord) {
    const r = ctx.hooks.lowerNewRecord(e, ctx);
    if (r !== null && r !== undefined) return r;
  }
  const ty = typeToSx(e.type, ctx.hooks);
  const tmp = ctx.fresh('rec_tmp');
  ctx.emit(`(let ${tmp} ${ty} ${e.ref === true ? sx.cnew(ty) : sx.newVal(ty)})`);
  for (const f of e.fields ?? []) {
    ctx.emit(sx.fldset(sx.varOf(tmp), f.name, lowerExpr(f.value, ctx)));
  }
  return sx.varOf(tmp);
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
