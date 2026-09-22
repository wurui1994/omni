// ext/freebasic/adapter/expr.js —— **FreeBASIC 的树 → 标准 IR 的表达式**（ADR-0044）
//
// FB 与前三门最大的不同：**它自己写类型**（`Dim acc As Integer`、`As Integer` 的返回类型），
// 所以类型那半笔账在这儿是"照抄"，不是"推断"。另外三条 FB 自己的规矩：
//   * **名字不分大小写**（`Print` 与 `print` 同一格）—— 关键字与登记表一律降小写着比；
//   * `xs(0)` 既可能是取下标也可能是调用 —— 靠"这个名字声明成数组了吗"分（登记表）；
//   * 语句位置上顶上是 `=` 的表达式**就是赋值**（FB 用同一个记号做比较与赋值）。

import { isList, tag, kids, leaf, part, unquote } from '../../../src/core/lower/cst.js';
import { INT, REAL, STR, BOOL, arrOf, named, typeOf } from '../../../src/core/lower/ty-of.js';

/** 算子：FB 写法（降小写）→ 方言里那一格。 */
const OPS = new Map([
  ['+', '+'], ['-', '-'], ['*', '*'], ['/', '/'], ['\\', '/'], ['mod', '%'],
  ['<', '<'], ['>', '>'], ['<=', '<='], ['>=', '>='], ['=', '=='], ['<>', '!='],
  ['&', '+'], ['andalso', '&&'], ['and', '&&'], ['orelse', '||'], ['or', '||'],
  ['shl', '<<'], ['shr', '>>'],
]);

/** 类型名（降小写）→ 标准 IR 的类型。 */
const TYPES = new Map([
  ['integer', INT], ['long', INT], ['longint', INT], ['short', INT], ['byte', INT],
  ['ubyte', INT], ['uinteger', INT], ['ulong', INT],
  ['double', REAL], ['single', REAL],
  ['string', STR], ['boolean', BOOL],
]);

/** 转换那一族（`CInt` / `CDbl` / …，降小写着查）。 */
const CONV = new Map([
  ['cint', 'toint'], ['clng', 'toint'], ['clngint', 'toint'], ['cbyte', 'toint'],
  ['cshort', 'toint'], ['cdbl', 'toreal'], ['csng', 'toreal'], ['str', 'tostr'],
]);

export const lower = (s) => String(s ?? '').toLowerCase();
export const nameOf = (x) => (tag(x) === 'n' ? leaf(kids(x)[0]) : leaf(x));
/** 一格类型当实参用（`(anew (arr int) N)` 的第一格）。 */
export const tyArg = (type) => ({ kind: 'type', type });

/** `As Integer` / `As Point` → 标准 IR 的类型（认不得就当那门语言自己的记录）。 */
export function typeOfTok(tok, C) {
  const n = lower(nameOf(tok));
  if (TYPES.has(n)) return TYPES.get(n);
  if (C.records.has(n)) return named(C.ref(C.records.get(n).name), true);
  throw new Error(`fb->IR: 这个类型还没接：${nameOf(tok)}`);
}

/** 一格二元：数值那一格要自己补转换（与两门 Lisp 同一条理由）。 */
function mkBin(op, a, b, C) {
  const ta = typeOf(a, C.tyCtx());
  const tb = typeOf(b, C.tyCtx());
  let l = a;
  let r = b;
  if (ta.kind === 'real' && tb.kind === 'int') r = { kind: 'builtin', name: 'toreal', args: [b] };
  if (ta.kind === 'int' && tb.kind === 'real') l = { kind: 'builtin', name: 'toreal', args: [a] };
  /* 串接：FB 的 `&` 与 `+` 都能接串，而两边得先都是串 —— 数要 `tostr`。 */
  if (op === '+' && (ta.kind === 'string' || tb.kind === 'string')) {
    if (ta.kind !== 'string') l = { kind: 'builtin', name: 'tostr', args: [a] };
    if (tb.kind !== 'string') r = { kind: 'builtin', name: 'tostr', args: [b] };
  }
  return { kind: 'binop', op, left: l, right: r };
}

/** 一格表达式。 */
export function exprOf(x, C) {
  switch (tag(x)) {
    case 'num': {
      const t = String(leaf(kids(x)[0]));
      const v = Number(t);
      return (t.includes('.') || /[eEdD]/.test(t))
        ? { kind: 'real', value: v } : { kind: 'int', value: v };
    }
    case 'str': return { kind: 'string', value: unquote(leaf(kids(x)[0])) };
    case 'n': {
      const n = nameOf(x);
      if (lower(n) === 'true') return { kind: 'bool', value: true };
      if (lower(n) === 'false') return { kind: 'bool', value: false };
      return { kind: 'name', name: C.ref(n) };
    }
    case 'paren': case 'expr': return exprOf(kids(x)[0], C);
    /* `p.x` / `This.tag` —— 一格记录的字段。 */
    case 'dot': return { kind: 'field', obj: exprOf(kids(x)[0], C), name: String(leaf(kids(x)[1])) };
    case 'bin': {
      const [op, a, b] = kids(x);
      const o = OPS.get(lower(leaf(op)));
      if (o === undefined) throw new Error(`fb->IR: 这个算子还没接：${leaf(op)}`);
      return mkBin(o, exprOf(a, C), exprOf(b, C), C);
    }
    case 'un': {
      const [op, a] = kids(x);
      const o = lower(leaf(op));
      if (o === 'not') return { kind: 'unop', op: '!', operand: exprOf(a, C) };
      return { kind: 'unop', op: o, operand: exprOf(a, C) };
    }
    /* `f(1)` / `xs(0)` / `CInt(x)` —— 三件事同一个形状，靠名字分（FB 的老规矩）。 */
    case 'call': {
      const [fn, args] = kids(x);
      const nm = lower(nameOf(fn));
      const argNodes = args === undefined ? [] : kids(args).map((a) => exprOf(a, C));
      if (CONV.has(nm)) {
        const to = CONV.get(nm);
        const v = argNodes[0];
        const t = typeOf(v, C.tyCtx());
        if (to === 'toint' && t.kind === 'int') return v;
        if (to === 'toreal' && t.kind === 'real') return v;
        return { kind: 'builtin', name: to, args: [v] };
      }
      if (C.arrays.has(nm)) {
        return {
          kind: 'index',
          obj: { kind: 'name', name: C.ref(nameOf(fn)) },
          index: argNodes[0],
        };
      }
      if (nm === 'len') {
        const v = argNodes[0];
        const t = typeOf(v, C.tyCtx());
        return { kind: 'builtin', name: t.kind === 'string' ? 'slen' : 'alen', args: [v] };
      }
      return { kind: 'call', fn: { kind: 'name', name: C.ref(nameOf(fn)) }, args: argNodes };
    }
    /* `{10, 20, 30}`：数组字面量（只出现在声明的初值上）。 */
    case 'braces': {
      const its = kids(x).map((k) => exprOf(k, C));
      const elem = its.length === 0 ? INT : typeOf(its[0], C.tyCtx());
      const tmp = C.fresh('arr');
      C.bind(tmp, arrOf(elem));
      const stmts = [{
        kind: 'let', name: tmp, type: arrOf(elem),
        init: { kind: 'builtin', name: 'anew', args: [tyArg(arrOf(elem)), { kind: 'int', value: its.length }] },
      }];
      its.forEach((v, i) => stmts.push({
        kind: 'assign',
        target: { kind: 'index', obj: { kind: 'name', name: tmp }, index: { kind: 'int', value: i } },
        value: v,
      }));
      return { kind: 'block-expr', stmts, value: { kind: 'name', name: tmp } };
    }
    default:
      if (isList(x) && x.items.length === 0) throw new Error('fb->IR: 空表当值用');
      throw new Error(`fb->IR: 这一格表达式还没接：${tag(x)}`);
  }
}

/** 条件位置上的那一格（FB 的条件本来就是布尔算子，别的当场报）。 */
export function condOf(x, C) {
  const e = exprOf(x, C);
  const t = typeOf(e, C.tyCtx());
  if (t.kind === 'bool' || e.kind === 'bool') return e;
  if (t.kind === 'int') {
    /* `Do … Loop` 的条件省掉时这一格是字面量；数当条件是 "不为 0"（FB 的规矩）。 */
    return { kind: 'binop', op: '!=', left: e, right: { kind: 'int', value: 0 } };
  }
  throw new Error(`fb->IR: 这一格当条件用还没接（装的是 ${t.kind}）`);
}

export { TYPES as FB_TYPES };
