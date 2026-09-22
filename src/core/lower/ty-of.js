// src/core/lower/ty-of.js —— **标准 IR 的表达式 → 它的类型**（ADR-0044）
//
// 方言（`.sx`）是静态类型而且**不推导只检查**，而借来的那几门里有好几门（awk / Scheme /
// Common Lisp / lua）一个类型都不写 —— 那笔账从前落在 `graph/backend-core.js` 里
// （十一门语言共用的一份猜法）。现在它分两半：
//
//   * **这一份是公共的那一半**：一格 IR 表达式的类型怎么算（字面量、算子、调用、下标、
//     字段、内建）。它只认标准 IR（ADR-0044 §1.2），不认任何一门语言的记号。
//   * **语言的那一半在 adapter 里**：形参与局部量装的是什么、记录有哪些字段、哪一档
//     默认是 int —— 只有认识那门语言的人答得出（见 `ext/chez/adapter/index.js` 文件头）。
//
// 收的 `ctx` 是三张表：`env`（名字 → 类型，有个 `get` 就够）、`fns`（函数名 → { params, ret }）、
// `fields`（记录名 → `[{ name, type }]`）。

export const INT = { kind: 'int' };
export const REAL = { kind: 'real' };
export const STR = { kind: 'string' };
export const BOOL = { kind: 'bool' };
export const arrOf = (elem) => ({ kind: 'arr', elem });
export const dictOf = (value) => ({ kind: 'map', key: STR, value });
/** 一格具名的类型。`ref` 为真 = 引用语义（方言的 `(class …)`），否则值语义（`(struct …)`）。 */
export const named = (name, ref = false) => ({ kind: 'named', name, ref });

/** 两格类型一样吗（这一层只要"一样不一样"，不做子类型）。 */
export function sameType(a, b) {
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'arr') return sameType(a.elem, b.elem);
  if (a.kind === 'map') return sameType(a.value, b.value);
  if (a.kind === 'named') return a.name === b.name;
  return true;
}

/**
 * 一棵 IR 表达式的类型。`env` 是"名字 → 类型"（形参 + 局部 + 全局），
 * `fns` 是"函数名 → { params, ret }"，`fields` 是"记录名 → 字段表"。
 */
export function typeOf(e, ctx) {
  if (e === null || e === undefined) return INT;
  switch (e.kind) {
    case 'int': return INT;
    case 'real': return REAL;
    case 'string': return STR;
    case 'bool': return BOOL;
    case 'name': return ctx.env.get(e.name) ?? INT;
    case 'binop': {
      if (['<', '>', '<=', '>=', '==', '!=', '&&', '||'].includes(e.op)) return BOOL;
      const l = typeOf(e.left, ctx);
      return l.kind === 'real' ? REAL : (l.kind === 'string' ? STR : typeOf(e.right, ctx));
    }
    case 'unop': return e.op === '!' ? BOOL : typeOf(e.operand, ctx);
    case 'call': {
      const sig = ctx.fns.get(e.fn.name);
      return sig === undefined ? INT : sig.ret;
    }
    case 'if-expr': return e.type ?? typeOf(e.then, ctx);
    case 'block-expr': return typeOf(e.value, ctx);
    /* 函数值那两格（`(fnref f)` / `(callfn v …)`）—— 见 `lower-expr.js` 里那段话。 */
    case 'fn-ref': {
      const sig = ctx.fns.get(e.name);
      return sig === undefined
        ? INT
        : { kind: 'fn-type', params: sig.params.map((p) => p.type), ret: sig.ret };
    }
    case 'call-value': {
      const t = typeOf(e.fn, ctx);
      return t.kind === 'fn-type' ? t.ret : INT;
    }
    case 'builtin': return builtinType(e, ctx);
    case 'field': {
      const t = typeOf(e.obj, ctx);
      const fs = t.kind === 'named' ? ctx.fields.get(t.name) : undefined;
      const f = fs === undefined ? undefined : fs.find((x) => x.name === e.name);
      return f === undefined ? INT : f.type;
    }
    case 'new-record': return e.type;
    default: return e.type ?? INT;
  }
}

/** 内建那几格交出来的类型（名字就是方言里那一格算子）。 */
function builtinType(e, ctx) {
  switch (e.name) {
    case 'aget': {
      const t = typeOf(e.args[0], ctx);
      return t.kind === 'arr' ? t.elem : INT;
    }
    case 'dget': {
      const t = typeOf(e.args[0], ctx);
      return t.kind === 'map' ? t.value : INT;
    }
    case 'dhas': return BOOL;
    case 'alen': case 'dlen': case 'slen': case 'toint': return INT;
    case 'toreal': return REAL;
    case 'tostr': return STR;
    case 'anew': return e.args[0].type ?? arrOf(INT);
    case 'dnew': return e.args[0].type ?? dictOf(INT);
    case 'cnew': case 'new': return e.args[0].type ?? INT;
    default: return INT;
  }
}
