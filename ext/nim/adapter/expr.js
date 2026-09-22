// ext/nim/adapter/expr.js —— **Nim 的树 → 标准 IR 的表达式**（ADR-0044）
//
// Nim 自己的几条规矩落在这一份里：
//   * `@[10, 20, 30]` 是**序列字面量**（树上是 `(un @ (array-lit …))`）；
//   * `x[i]` / `m["a"]` / `xs[1..2]` / `initTable[string,int]` **同一个形状**（`bracket`）——
//     靠"那个名字装的是什么"与"下标是什么形状"分；
//   * `&` 是串接、`$x` 是"变成串"、`in` / `notin` 是"在不在"（数组找元素、表找键）；
//   * UFCS：`p.total()` 与 `total(p)` 是**同一个调用** —— 接收者只是第一格实参。

import { tag, kids, leaf, part, unquote } from '../../../src/core/lower/cst.js';
import {
  INT, REAL, STR, BOOL, arrOf, dictOf, named, typeOf,
} from '../../../src/core/lower/ty-of.js';

const OPS = new Map([
  ['+', '+'], ['-', '-'], ['*', '*'], ['div', '/'], ['/', '/'], ['mod', '%'],
  ['<', '<'], ['>', '>'], ['<=', '<='], ['>=', '>='], ['==', '=='], ['!=', '!='],
  ['and', '&&'], ['or', '||'], ['xor', '^'], ['shl', '<<'], ['shr', '>>'],
]);

/** 类型名 → 标准 IR 的类型。 */
const SCALARS = new Map([
  ['int', INT], ['int8', INT], ['int16', INT], ['int32', INT], ['int64', INT],
  ['uint', INT], ['uint8', INT], ['uint32', INT], ['uint64', INT], ['Natural', INT],
  ['float', REAL], ['float32', REAL], ['float64', REAL],
  ['string', STR], ['cstring', STR], ['bool', BOOL], ['char', INT],
]);

export const nameOf = (x) => {
  if (x === undefined || x === null) return '';
  const t = tag(x);
  if (t === 'name' || t === 'n') return String(leaf(kids(x)[0]));
  return String(leaf(x));
};
export const tyArg = (type) => ({ kind: 'type', type });

/**
 * 一格类型标注 → 标准 IR 的类型。
 * `(name int)` · `(none)` · `(tuple-lit (name int) (name int))` · `(bracket (name seq) …)` ·
 * `(bracket (name Table) (args (name string) (name int)))`。
 */
export function typeOfTok(tok, C) {
  if (tok === undefined || tok === null) return { kind: 'void' };
  switch (tag(tok)) {
    case 'none': return { kind: 'void' };
    case 'name': case 'n': {
      const n = nameOf(tok);
      if (SCALARS.has(n)) return SCALARS.get(n);
      if (C.records.has(n)) return named(C.ref(n), true);
      if (C.aliases.has(n)) return C.aliases.get(n);
      throw new Error(`nim->IR: 这个类型还没接：${n}`);
    }
    case 'tuple-lit': return C.mvType(kids(tok).map((k) => typeOfTok(k, C)));
    case 'bracket': {
      const base = nameOf(kids(tok)[0]);
      const args = part(tok, 'args');
      const as = args === undefined ? [] : kids(args);
      if (base === 'seq' || base === 'openArray' || base === 'array') {
        return arrOf(typeOfTok(as[as.length - 1], C));
      }
      if (base === 'Table' || base === 'TableRef' || base === 'initTable') {
        return dictOf(typeOfTok(as[1], C));
      }
      throw new Error(`nim->IR: 这个泛型类型还没接：${base}`);
    }
    default:
      throw new Error(`nim->IR: 这一格类型标注还没接：${tag(tok)}`);
  }
}

/** 一格二元（数值升实数、串接两边变串）。 */
function mkBin(op, a, b, C) {
  const ta = typeOf(a, C.tyCtx());
  const tb = typeOf(b, C.tyCtx());
  let l = a;
  let r = b;
  if (ta.kind === 'real' && tb.kind === 'int') r = { kind: 'builtin', name: 'toreal', args: [b] };
  if (ta.kind === 'int' && tb.kind === 'real') l = { kind: 'builtin', name: 'toreal', args: [a] };
  return { kind: 'binop', op, left: l, right: r };
}

/** `a & b`：串接（两边先变成串 —— Nim 的 `&` 只接串，`$` 才是转换，可这一层要显式）。 */
function concatOf(a, b, C) {
  const s = (v) => (typeOf(v, C.tyCtx()).kind === 'string' ? v : { kind: 'builtin', name: 'tostr', args: [v] });
  return { kind: 'binop', op: '+', left: s(a), right: s(b) };
}

/** 一格表达式。 */
export function exprOf(x, C) {
  switch (tag(x)) {
    case 'num': {
      const t = String(leaf(kids(x)[0]));
      const v = Number(t);
      return (t.includes('.') || /[eE]/.test(t))
        ? { kind: 'real', value: v } : { kind: 'int', value: v };
    }
    case 'str': return { kind: 'string', value: unquote(leaf(kids(x)[0])) };
    case 'char': return { kind: 'int', value: String(unquote(leaf(kids(x)[0]))).charCodeAt(0) };
    case 'nil':
      throw new Error('nim->IR: `nil` 当值用还没接');
    case 'name': case 'n': {
      const n = nameOf(x);
      if (n === 'true') return { kind: 'bool', value: true };
      if (n === 'false') return { kind: 'bool', value: false };
      return { kind: 'name', name: C.ref(n) };
    }
    case 'paren': case 'expr': return exprOf(kids(x)[0], C);
    case 'dot': return { kind: 'field', obj: exprOf(kids(x)[0], C), name: String(leaf(kids(x)[1])) };
    case 'bin': {
      const [op, a, b] = kids(x);
      const o = String(leaf(op));
      if (o === '&') return concatOf(exprOf(a, C), exprOf(b, C), C);
      /* `x in xs` / `x notin xs`：数组里找元素、表里找键。 */
      if (o === 'in' || o === 'notin') {
        const box = exprOf(b, C);
        const t = typeOf(box, C.tyCtx());
        const hit = t.kind === 'map'
          ? { kind: 'builtin', name: 'dhas', args: [box, exprOf(a, C)] }
          : containsOf(box, exprOf(a, C), C);
        return o === 'in' ? hit : { kind: 'unop', op: '!', operand: hit };
      }
      if (o === '..' || o === '..<') {
        throw new Error('nim->IR: 区间当值用只在 `case … of a .. b` 与 `xs[a..b]` 那两处接');
      }
      const mapped = OPS.get(o);
      if (mapped === undefined) throw new Error(`nim->IR: 这个算子还没接：${o}`);
      return mkBin(mapped, exprOf(a, C), exprOf(b, C), C);
    }
    case 'un': {
      const [op, a] = kids(x);
      const o = String(leaf(op));
      /* `@[…]` —— 序列字面量（`@` 是一元算子，跟着一格 `array-lit`）。 */
      if (o === '@') return seqOf(a, C);
      /* `$x` —— 变成串。 */
      if (o === '$') {
        const v = exprOf(a, C);
        return typeOf(v, C.tyCtx()).kind === 'string' ? v : { kind: 'builtin', name: 'tostr', args: [v] };
      }
      if (o === 'not') return { kind: 'unop', op: '!', operand: condOf(a, C) };
      return { kind: 'unop', op: o, operand: exprOf(a, C) };
    }
    case 'array-lit': return seqOf(x, C);
    case 'tuple-lit': {
      const vs = kids(x).map((k) => exprOf(k, C));
      const ty = C.mvType(vs.map((v) => typeOf(v, C.tyCtx())));
      return {
        kind: 'new-record',
        type: ty,
        ref: false,
        fields: vs.map((v, i) => ({ name: `v${i}`, value: v })),
      };
    }
    /* `xs[i]` / `m["a"]` / `xs[1..2]` —— 同一个形状，按类型与下标的形状分。 */
    case 'bracket': {
      const obj = exprOf(kids(x)[0], C);
      const args = part(x, 'args');
      const first = args === undefined ? undefined : kids(args)[0];
      const t = typeOf(obj, C.tyCtx());
      if (first !== undefined && tag(first) === 'bin' && ['..', '..<'].includes(String(leaf(kids(first)[0])))) {
        return sliceOf(obj, first, C);
      }
      const key = exprOf(first, C);
      if (t.kind === 'map') return { kind: 'builtin', name: 'dget', args: [obj, key] };
      return { kind: 'index', obj, index: key };
    }
    case 'call': case 'command': return callOf(x, C);
    default:
      throw new Error(`nim->IR: 这一格表达式还没接：${tag(x)}`);
  }
}

/** `@[a, b, c]` → 一格数组（造 + 逐格写）。 */
function seqOf(lit, C) {
  const items = tag(lit) === 'array-lit' ? kids(lit) : [lit];
  const its = items.map((k) => exprOf(k, C));
  const elem = its.length === 0 ? INT : typeOf(its[0], C.tyCtx());
  const tmp = C.fresh('seq');
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

/** `xs[a .. b]`：**Nim 的 `..` 含上界**（`..<` 不含）—— 落成"空数组 + 一个 while 往里 push"。 */
function sliceOf(src, rangeTok, C) {
  const st = typeOf(src, C.tyCtx());
  const elem = st.kind === 'arr' ? st.elem : INT;
  const [opTok, aTok, bTok] = kids(rangeTok);
  const inclusive = String(leaf(opTok)) === '..';
  const from = exprOf(aTok, C);
  const upper = exprOf(bTok, C);
  const to = inclusive
    ? { kind: 'binop', op: '+', left: upper, right: { kind: 'int', value: 1 } }
    : upper;
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

/** `x in xs`（数组里找元素）：落成"一个 while 扫一遍"—— 方言里没有 `contains`。 */
function containsOf(box, needle, C) {
  const t = typeOf(box, C.tyCtx());
  const found = C.fresh('has');
  const i = C.fresh('has_i');
  C.bind(found, BOOL);
  C.bind(i, INT);
  return {
    kind: 'block-expr',
    stmts: [
      { kind: 'let', name: found, type: BOOL, init: { kind: 'bool', value: false } },
      { kind: 'let', name: i, type: INT, init: { kind: 'int', value: 0 } },
      {
        kind: 'while',
        cond: {
          kind: 'binop', op: '<', left: { kind: 'name', name: i },
          right: { kind: 'builtin', name: 'alen', args: [box] },
        },
        body: [
          {
            kind: 'if',
            cond: {
              kind: 'binop', op: '==',
              left: { kind: 'index', obj: box, index: { kind: 'name', name: i } },
              right: needle,
            },
            then: [{
              kind: 'assign', target: { kind: 'name', name: found }, value: { kind: 'bool', value: true },
            }],
            else_: null,
          },
          {
            kind: 'assign',
            target: { kind: 'name', name: i },
            value: { kind: 'binop', op: '+', left: { kind: 'name', name: i }, right: { kind: 'int', value: 1 } },
          },
        ],
      },
    ],
    value: { kind: 'name', name: found },
  };
}

/**
 * 一格调用。**四件事同一个形状**：
 *   `initTable[string, int]()` -> 造字典（被调方是 `bracket`）
 *   `Point(x: 1, y: 2)` -> 造记录（**带名字的实参**，那是 Nim 的对象构造）
 *   `m.hasKey("a")` / `p.total()` -> UFCS：接收者是第一格实参
 *   `int(x)` / `len(x)` / `echo …` -> 内建
 */
function callOf(x, C) {
  const fn = kids(x)[0];
  const argsTok = part(x, 'args');
  const rawArgs = argsTok === undefined ? [] : kids(argsTok);

  if (tag(fn) === 'bracket') {
    const base = nameOf(kids(fn)[0]);
    if (base === 'initTable' || base === 'newTable') {
      const as = part(fn, 'args');
      const t = dictOf(typeOfTok(kids(as)[1], C));
      return { kind: 'builtin', name: 'dnew', args: [tyArg(t)] };
    }
    if (base === 'newSeq') {
      const as = part(fn, 'args');
      const t = arrOf(typeOfTok(kids(as)[0], C));
      return {
        kind: 'builtin',
        name: 'anew',
        args: [tyArg(t), rawArgs.length > 0 ? exprOf(rawArgs[0], C) : { kind: 'int', value: 0 }],
      };
    }
    throw new Error(`nim->IR: 这一格泛型调用还没接：${base}`);
  }

  /* UFCS：`obj.f(args)` —— 接收者是第一格实参（表的 `hasKey` / `len` 走内建）。 */
  if (tag(fn) === 'dot') {
    const recv = exprOf(kids(fn)[0], C);
    const m = String(leaf(kids(fn)[1]));
    const t = typeOf(recv, C.tyCtx());
    const args = rawArgs.map((a) => exprOf(a, C));
    if (m === 'hasKey' && t.kind === 'map') {
      return { kind: 'builtin', name: 'dhas', args: [recv, args[0]] };
    }
    if (m === 'len') {
      const name = t.kind === 'map' ? 'dlen' : (t.kind === 'string' ? 'slen' : 'alen');
      return { kind: 'builtin', name, args: [recv] };
    }
    if (m === 'add' && t.kind === 'arr') {
      return { kind: 'builtin', name: 'apush', args: [recv, args[0]] };
    }
    return { kind: 'call', fn: { kind: 'name', name: C.ref(m) }, args: [recv, ...args] };
  }

  const nm = nameOf(fn);
  if (nm === 'echo') throw new Error('nim->IR: `echo` 在表达式位置上（它不交值）');
  /* `Point(x: 1, y: 2)` —— 带名字的实参就是对象构造（那是 Nim 与别人最不同的一处）。 */
  if (C.records.has(nm)) {
    const fields = C.records.get(nm).fields;
    const given = new Map();
    rawArgs.forEach((a, i) => {
      if (tag(a) === 'kv') given.set(nameOf(kids(a)[0]), exprOf(kids(a)[1], C));
      else given.set(fields[i]?.name, exprOf(a, C));
    });
    return {
      kind: 'new-record',
      type: named(C.ref(nm), true),
      ref: true,
      fields: fields.map((f) => ({
        name: f.name,
        value: given.get(f.name) ?? { kind: 'int', value: 0 },
      })),
    };
  }
  /**
   * 命名实参（`addTo(a = 3, b = 4)`）—— **按被调者的形参表排回位置**：标准 IR 里只有位置实参。
   * 形参表不知道、名字对不上都当场报，不猜。
   * （`Point(x: 1, y: 2)` 走的是上面那一格 —— 在实参这个位置上两者**不同形**：
   *   `IDENT "=" expr` 出 `named`、`expr ":" expr` 出 `kv`。）
   */
  if (rawArgs.some((a) => tag(a) === 'named')) {
    const sig = C.fns.get(C.ref(nm));
    if (sig === undefined) throw new Error(`nim->IR: ${nm} 的形参表不知道，命名实参排不回位置`);
    const given = new Map();
    const pos = [];
    for (const a of rawArgs) {
      if (tag(a) === 'named') given.set(String(leaf(kids(a)[0])), exprOf(kids(a)[1], C));
      else pos.push(exprOf(a, C));
    }
    const ordered = sig.params.map((p, i) => {
      if (i < pos.length) return pos[i];
      const v = given.get(p.name);
      if (v === undefined) throw new Error(`nim->IR: ${nm} 的形参 ${p.name} 没给值（命名实参对不上）`);
      return v;
    });
    return { kind: 'call', fn: { kind: 'name', name: C.ref(nm) }, args: ordered };
  }
  const args = rawArgs.map((a) => (['kv', 'named'].includes(tag(a)) ? exprOf(kids(a)[1], C) : exprOf(a, C)));
  if (SCALARS.has(nm) && args.length === 1) {
    /* `int(x)` / `float(x)` / `$`那一族之外的转换。 */
    const to = SCALARS.get(nm);
    const t = typeOf(args[0], C.tyCtx());
    if (to.kind === 'int') return t.kind === 'int' ? args[0] : { kind: 'builtin', name: 'toint', args };
    if (to.kind === 'real') return t.kind === 'real' ? args[0] : { kind: 'builtin', name: 'toreal', args };
    if (to.kind === 'string') return t.kind === 'string' ? args[0] : { kind: 'builtin', name: 'tostr', args };
  }
  if (nm === 'len' && args.length === 1) {
    const t = typeOf(args[0], C.tyCtx());
    const name = t.kind === 'map' ? 'dlen' : (t.kind === 'string' ? 'slen' : 'alen');
    return { kind: 'builtin', name, args };
  }
  return { kind: 'call', fn: { kind: 'name', name: C.ref(nm) }, args };
}

/** 条件位置上的那一格。 */
export function condOf(x, C) {
  const e = exprOf(x, C);
  const t = typeOf(e, C.tyCtx());
  if (t.kind === 'bool' || e.kind === 'bool') return e;
  if (t.kind === 'int') return { kind: 'binop', op: '!=', left: e, right: { kind: 'int', value: 0 } };
  throw new Error(`nim->IR: 这一格当条件用还没接（装的是 ${t.kind}）`);
}
