// ext/sbcl/adapter/expr.js —— **Common Lisp 的 datum → 标准 IR 的表达式**（ADR-0044）
//
// 与 `ext/chez/adapter/expr.js` 差的**只是一张词汇表**（`defun` vs `define`、`setq` vs `set!`、
// `princ` vs `display`、`aref` vs `vector-ref`）—— 那正是"同一套标准 IR 承载不同语言"
// 最便宜的一份证据。CL 自己多出来的三样在这一份里：
//   * `(gethash k m)` —— **键在前、表在后**（与别的门反着）；
//   * `(nth-value 1 (gethash …))` —— "在不在"是第二格返回值；
//   * `(setf (位置) 值)` —— 广义位置（`aref` / `gethash` / 结构的访问器），见 index.js。

import { head, kids, text, symName, asList } from '../../../src/core/lower/cst.js';
import { INT, arrOf, dictOf, named, typeOf } from '../../../src/core/lower/ty-of.js';

/** 算子：CL 写法 → 方言里那一格。`=` / `eql` / `equal` 都是相等。 */
const ARITH = new Map([
  ['+', '+'], ['-', '-'], ['*', '*'], ['/', '/'],
  ['<', '<'], ['>', '>'], ['<=', '<='], ['>=', '>='],
  ['=', '=='], ['eql', '=='], ['equal', '=='],
]);

/** 一格类型当实参用（`(anew (arr int) N)` 的第一格）。 */
export const tyArg = (type) => ({ kind: 'type', type });

/** 一格二元（数值那一格要自己补转换 —— 与 chez 那份同一条理由）。 */
function mkBin(op, a, b, C) {
  const ta = typeOf(a, C.tyCtx());
  const tb = typeOf(b, C.tyCtx());
  let l = a;
  let r = b;
  if (ta.kind === 'real' && tb.kind === 'int') r = { kind: 'builtin', name: 'toreal', args: [b] };
  if (ta.kind === 'int' && tb.kind === 'real') l = { kind: 'builtin', name: 'toreal', args: [a] };
  return { kind: 'binop', op, left: l, right: r };
}

/** 条件位置上的那一格（CL 里"只有 `nil` 是假"—— 这一批只接本来就是布尔的那些）。 */
export function condOf(x, C) {
  const e = exprOf(x, C);
  const t = typeOf(e, C.tyCtx());
  if (t.kind === 'bool' || e.kind === 'bool') return e;
  throw new Error('sbcl->IR: 条件位置上装的不是布尔 —— CL 的"只有 nil 是假"这一批没接'
    + '（写成 `(> x 0)` 那样的比较）');
}

/** 一格 datum → IR 表达式。 */
export function exprOf(x, C) {
  switch (head(x)) {
    case 'num': {
      const t = String(text(x));
      const v = Number(t);
      if (Number.isNaN(v)) throw new Error(`sbcl->IR: 这一批还收不了这个数：${t}`);
      /* 实数看**写法**不看值（`7.0` 是实数）—— 与 chez 那份同一个坑。 */
      return (t.includes('.') || /[eE]/.test(t))
        ? { kind: 'real', value: v } : { kind: 'int', value: v };
    }
    case 'str': return { kind: 'string', value: text(x) };
    case 'sym': {
      const n = text(x);
      if (n === 't') return { kind: 'bool', value: true };
      if (n === 'nil') return { kind: 'bool', value: false };
      return { kind: 'name', name: C.ref(n) };
    }
    case 'quote': return { kind: 'string', value: `'${text(kids(x)[0]) ?? '?'}'` };
    default: break;
  }
  const items = asList(x);
  if (items === null) throw new Error(`sbcl->IR: 这一格 datum 还没接：${head(x)}`);
  if (items.length === 0) throw new Error('sbcl->IR: 空表 `()` 当值用还没接');
  const op = symName(items[0]);
  const rest = items.slice(1);

  switch (op) {
    case 'if': {
      const then = exprOf(rest[1], C);
      const els = rest[2] === undefined ? null : exprOf(rest[2], C);
      return {
        kind: 'if-expr',
        cond: condOf(rest[0], C),
        then,
        else_: els,
        type: typeOf(then, C.tyCtx()),
      };
    }
    case 'progn': return seqExpr(rest, C);
    case 'let': case 'let*': return letExpr(rest, C);
    /* `(values a b)`：多值落一格合成的记录（与 chez / go / nim 同一个落点）。 */
    case 'values': {
      const vs = rest.map((r) => exprOf(r, C));
      const ty = C.mvType(vs.map((v) => typeOf(v, C.tyCtx())));
      return {
        kind: 'new-record',
        type: ty,
        ref: false,
        fields: vs.map((v, i) => ({ name: `v${i}`, value: v })),
      };
    }
    case 'vector': {
      const its = rest.map((r) => exprOf(r, C));
      const elem = its.length === 0 ? INT : typeOf(its[0], C.tyCtx());
      const tmp = C.fresh('vec');
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
    case 'aref': case 'svref': case 'elt':
      return { kind: 'index', obj: exprOf(rest[0], C), index: exprOf(rest[1], C) };
    case 'length': {
      const v = exprOf(rest[0], C);
      const t = typeOf(v, C.tyCtx());
      return { kind: 'builtin', name: t.kind === 'string' ? 'slen' : 'alen', args: [v] };
    }
    case 'concatenate': {
      /* `(concatenate 'string a b)`：第一格是**类型的名字**（丢掉）。 */
      const parts = rest.slice(1).map((r) => exprOf(r, C));
      if (parts.length === 0) throw new Error('sbcl->IR: `concatenate` 没给要接的东西');
      return parts.reduce((a, b) => mkBin('+', a, b, C));
    }
    case 'make-hash-table': return { kind: 'builtin', name: 'dnew', args: [tyArg(dictOf(INT))] };
    /* **键在前、表在后** —— 只是记号的顺序，落的是同一格算子。 */
    case 'gethash': return {
      kind: 'builtin', name: 'dget', args: [exprOf(rest[1], C), exprOf(rest[0], C)],
    };
    case 'nth-value': {
      const inner = asList(rest[1]);
      const k = rest[0] === undefined ? null : Number(text(rest[0]));
      if (k === 1 && inner !== null && symName(inner[0]) === 'gethash') {
        return {
          kind: 'builtin', name: 'dhas', args: [exprOf(inner[2], C), exprOf(inner[1], C)],
        };
      }
      throw new Error('sbcl->IR: 这一批只接 `(nth-value 1 (gethash …))` 那一种多值取用');
    }
    /* `(subseq v 1 3)`：**上界不含、0 起**（CL 这一条与方言一样）。方言里没有"切一段"，
       所以落成"造一格空数组 + 一个 while 往里 push" —— 与 chez 的 `vector-copy` 同一手。 */
    case 'subseq': {
      const src = exprOf(rest[0], C);
      const st = typeOf(src, C.tyCtx());
      const elem = st.kind === 'arr' ? st.elem : INT;
      const from = rest[1] === undefined ? { kind: 'int', value: 0 } : exprOf(rest[1], C);
      const to = rest[2] === undefined
        ? { kind: 'builtin', name: 'alen', args: [src] }
        : exprOf(rest[2], C);
      const out = C.fresh('slice');
      const i = C.fresh('slice_i');
      C.bind(out, arrOf(elem));
      C.bind(i, INT);
      return {
        kind: 'block-expr',
        stmts: [
          {
            kind: 'let', name: out, type: arrOf(elem),
            init: { kind: 'builtin', name: 'anew', args: [tyArg(arrOf(elem)), { kind: 'int', value: 0 }] },
          },
          { kind: 'let', name: i, type: INT, init: from },
          {
            kind: 'while',
            cond: { kind: 'binop', op: '<', left: { kind: 'name', name: i }, right: to },
            body: [
              {
                kind: 'builtin-stmt',
                name: 'apush',
                args: [{ kind: 'name', name: out }, { kind: 'index', obj: src, index: { kind: 'name', name: i } }],
              },
              {
                kind: 'assign',
                target: { kind: 'name', name: i },
                value: { kind: 'binop', op: '+', left: { kind: 'name', name: i }, right: { kind: 'int', value: 1 } },
              },
            ],
          },
        ],
        value: { kind: 'name', name: out },
      };
    }
    /* 表示转换。`(truncate x)` 在 CL 里回两格值（商与余），单值上下文里就是商 ——
       与从前那条路同一个取舍。已经是那一档就什么都不发（见 chez 那份的同一处）。 */
    case 'truncate': {
      const v = exprOf(rest[0], C);
      return typeOf(v, C.tyCtx()).kind === 'int' ? v : { kind: 'builtin', name: 'toint', args: [v] };
    }
    case 'float': {
      const v = exprOf(rest[0], C);
      return typeOf(v, C.tyCtx()).kind === 'real' ? v : { kind: 'builtin', name: 'toreal', args: [v] };
    }
    case 'not': case 'null': return { kind: 'unop', op: '!', operand: condOf(rest[0], C) };
    case 'lambda':
      throw new Error('sbcl->IR: `lambda` 当值用还没接 —— 那要闭包（函数值）');
    default: break;
  }

  if (op !== null && ARITH.has(op)) {
    const o = ARITH.get(op);
    const args = rest.map((r) => exprOf(r, C));
    if (args.length === 1 && o === '-') return { kind: 'unop', op: '-', operand: args[0] };
    if (args.length < 2) throw new Error(`sbcl->IR: \`${op}\` 只给了 ${args.length} 格实参`);
    return args.reduce((a, b) => mkBin(o, a, b, C));
  }

  /* `defstruct` 生成的那两族名字：构造器（**关键字实参**）与访问器。 */
  if (op !== null && C.structs.maker.has(op)) {
    const rec = C.structs.maker.get(op);
    const fields = C.structs.fields.get(rec);
    const given = new Map();
    for (let i = 0; i + 1 < rest.length; i += 2) {
      const k = symName(rest[i]);
      if (k === null || !k.startsWith(':')) {
        throw new Error(`sbcl->IR: make-${rec} 只收关键字实参（:x 1）`);
      }
      given.set(k.slice(1), exprOf(rest[i + 1], C));
    }
    return {
      kind: 'new-record',
      type: named(C.ref(rec), true),
      ref: true,
      fields: fields.map((f) => ({ name: f, value: given.get(f) ?? { kind: 'int', value: 0 } })),
    };
  }
  if (op !== null && C.structs.access.has(op)) {
    return { kind: 'field', obj: exprOf(rest[0], C), name: C.structs.access.get(op) };
  }

  if (op === null) throw new Error('sbcl->IR: 调用的第一格不是名字（要函数值 —— 还没接）');
  return { kind: 'call', fn: { kind: 'name', name: C.ref(op) }, args: rest.map((r) => exprOf(r, C)) };
}

/** `(progn e1 … en)`：前面当语句、最后一格是值。 */
export function seqExpr(forms, C) {
  if (forms.length === 0) throw new Error('sbcl->IR: 空的 `progn` 当值用还没接');
  const last = forms[forms.length - 1];
  const stmts = forms.slice(0, -1).map((f) => C.stmtOf(f));
  const value = exprOf(last, C);
  return stmts.length === 0 ? value : { kind: 'block-expr', stmts, value };
}

/** `(let ((x 1)) body…)`：一串 `let` + 那段体，值是体的最后一格。 */
export function letExpr(rest, C) {
  const stmts = [];
  C.push();
  for (const b of (asList(rest[0]) ?? [])) {
    const pair = asList(b) ?? [];
    const name = C.ref(symName(pair[0]));
    const init = pair[1] === undefined ? { kind: 'int', value: 0 } : exprOf(pair[1], C);
    const type = typeOf(init, C.tyCtx());
    C.bind(name, type);
    stmts.push({ kind: 'let', name, type, init });
  }
  const body = rest.slice(1);
  if (body.length === 0) throw new Error('sbcl->IR: `let` 的体空着还没接');
  const value = seqExpr(body, C);
  C.pop();
  if (value.kind === 'block-expr') {
    return { kind: 'block-expr', stmts: [...stmts, ...value.stmts], value: value.value };
  }
  return { kind: 'block-expr', stmts, value };
}
