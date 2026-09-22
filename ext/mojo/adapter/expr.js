// ext/mojo/adapter/expr.js —— **Mojo 的树 → 标准 IR 的表达式**（ADR-0044）
//
// Mojo 在这一层的形状与 Python 一族相同（`(attr …)` / `(index …)` / `(call …)`），
// 类型只在**声明处**写（`n: Int` / `-> Int` / `Dict[String, Int]`），局部量靠 `var x = …`
// 从初值取 —— 那一半账走公共的 `ty-of.js`。
//
// 三处 Mojo 自己的规矩在这一份里：
//   * `Dict[String, Int]()` —— 调用的**被调方是一格下标**（泛型实例化），不是名字；
//   * `x in m` 是"字典里有这个键"（`(cmp in …)`，键在前）；
//   * `Int(x)` / `Float64(x)` 是转换 —— 与调用同形，靠名字表分。

import { tag, kids, leaf, part, unquote } from '../../../src/core/lower/cst.js';
import {
  INT, REAL, STR, BOOL, arrOf, dictOf, named, typeOf,
} from '../../../src/core/lower/ty-of.js';

/** 比较与算子：树上的写法 → 方言里那一格。 */
const OPS = new Map([
  ['+', '+'], ['-', '-'], ['*', '*'], ['/', '/'], ['//', '/'], ['%', '%'],
  ['<', '<'], ['>', '>'], ['<=', '<='], ['>=', '>='], ['==', '=='], ['!=', '!='],
  ['and', '&&'], ['or', '||'], ['&', '&'], ['|', '|'], ['<<', '<<'], ['>>', '>>'],
]);

/** 类型名 → 标准 IR 的类型（`Int` / `Float64` / `String` / `Bool`）。 */
const SCALARS = new Map([
  ['Int', INT], ['Int64', INT], ['Int32', INT], ['UInt', INT],
  ['Float64', REAL], ['Float32', REAL], ['String', STR], ['StringLiteral', STR],
  ['Bool', BOOL],
]);

/** 转换那一族（与调用同形，靠这张表分）。 */
const CONV = new Map([
  ['Int', 'toint'], ['Int64', 'toint'], ['Float64', 'toreal'], ['Float32', 'toreal'],
  ['String', 'tostr'],
]);

export const nameOf = (x) => (tag(x) === 'n' ? leaf(kids(x)[0]) : leaf(x));
/** 一格类型当实参用。 */
export const tyArg = (type) => ({ kind: 'type', type });

/**
 * 一格类型标注 → 标准 IR 的类型。
 * `(n Int)` / `(index (n List) (subs (n Int)))` / `(index (n Dict) (subs (n String) (n Int)))`。
 */
export function typeOfTok(tok, C) {
  if (tok === undefined || tok === null) return INT;
  if (tag(tok) === 'n') {
    const n = String(nameOf(tok));
    if (SCALARS.has(n)) return SCALARS.get(n);
    if (C.records.has(n)) return named(C.ref(n), true);
    throw new Error(`mojo->IR: 这个类型还没接：${n}`);
  }
  if (tag(tok) === 'index') {
    const base = String(nameOf(kids(tok)[0]));
    const subs = part(tok, 'subs');
    const args = subs === undefined ? [] : kids(subs);
    if (base === 'List') return arrOf(typeOfTok(args[0], C));
    if (base === 'Dict') return dictOf(typeOfTok(args[1], C));
    if (base === 'Tuple') return C.mvType(args.map((a) => typeOfTok(a, C)));
    throw new Error(`mojo->IR: 这个泛型类型还没接：${base}`);
  }
  throw new Error(`mojo->IR: 这一格类型标注还没接：${tag(tok)}`);
}

/** 一格二元：数值那一格要自己补转换（与前四门同一条理由）。 */
function mkBin(op, a, b, C) {
  const ta = typeOf(a, C.tyCtx());
  const tb = typeOf(b, C.tyCtx());
  let l = a;
  let r = b;
  if (ta.kind === 'real' && tb.kind === 'int') r = { kind: 'builtin', name: 'toreal', args: [b] };
  if (ta.kind === 'int' && tb.kind === 'real') l = { kind: 'builtin', name: 'toreal', args: [a] };
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
      return (t.includes('.') || /[eE]/.test(t))
        ? { kind: 'real', value: v } : { kind: 'int', value: v };
    }
    case 'str': return { kind: 'string', value: unquote(leaf(kids(x)[0])) };
    case 'n': {
      const n = String(nameOf(x));
      if (n === 'True') return { kind: 'bool', value: true };
      if (n === 'False') return { kind: 'bool', value: false };
      return { kind: 'name', name: C.ref(n) };
    }
    case 'paren': case 'expr': return exprOf(kids(x)[0], C);
    case 'attr': return { kind: 'field', obj: exprOf(kids(x)[0], C), name: String(leaf(kids(x)[1])) };
    case 'bin': case 'cmp': {
      const [op, a, b] = kids(x);
      const o = String(leaf(op));
      /* `x in m`：**字典里有这个键**（键在前、表在后）。 */
      if (o === 'in') {
        return { kind: 'builtin', name: 'dhas', args: [exprOf(b, C), exprOf(a, C)] };
      }
      const mapped = OPS.get(o);
      if (mapped === undefined) throw new Error(`mojo->IR: 这个算子还没接：${o}`);
      return mkBin(mapped, exprOf(a, C), exprOf(b, C), C);
    }
    case 'un': {
      const [op, a] = kids(x);
      const o = String(leaf(op));
      if (o === 'not') return { kind: 'unop', op: '!', operand: exprOf(a, C) };
      return { kind: 'unop', op: o, operand: exprOf(a, C) };
    }
    /* `xs[0]` / `m["a"]` / `xs[1:3]` —— 数组下标、字典的键、切一段三件事同一个形状。 */
    case 'index': {
      const obj = exprOf(kids(x)[0], C);
      const subs = part(x, 'subs');
      const first = subs === undefined ? undefined : kids(subs)[0];
      if (first !== undefined && tag(first) === 'slice') return sliceOf(obj, first, C);
      const t = typeOf(obj, C.tyCtx());
      const key = exprOf(first, C);
      if (t.kind === 'map') return { kind: 'builtin', name: 'dget', args: [obj, key] };
      return { kind: 'index', obj, index: key };
    }
    case 'list': {
      const its = kids(x).map((k) => exprOf(k, C));
      const elem = its.length === 0 ? INT : typeOf(its[0], C.tyCtx());
      const tmp = C.fresh('list');
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
    /* `(3, 7)` —— 多值落一格合成的记录（与前四门同一个落点）。 */
    case 'tuple': {
      const vs = kids(x).map((k) => exprOf(k, C));
      const ty = C.mvType(vs.map((v) => typeOf(v, C.tyCtx())));
      return {
        kind: 'new-record',
        type: ty,
        ref: false,
        fields: vs.map((v, i) => ({ name: `v${i}`, value: v })),
      };
    }
    case 'call': return callOf(x, C);
    default:
      throw new Error(`mojo->IR: 这一格表达式还没接：${tag(x)}`);
  }
}

/** `xs[1:3]`：切一段 —— 方言里没有这一格，落成"空数组 + 一个 while 往里 push"。 */
function sliceOf(src, sliceTok, C) {
  const st = typeOf(src, C.tyCtx());
  const elem = st.kind === 'arr' ? st.elem : INT;
  const parts = kids(sliceTok);
  const from = parts[0] === undefined ? { kind: 'int', value: 0 } : exprOf(parts[0], C);
  const to = parts[1] === undefined
    ? { kind: 'builtin', name: 'alen', args: [src] }
    : exprOf(parts[1], C);
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

/**
 * 一格调用。**四件事同一个形状**，按被调方分：
 *   `Dict[String, Int]()` -> 造字典（被调方是下标 = 泛型实例化）
 *   `Point(1, 2)` -> 造记录（名字登记成 struct 了）
 *   `p.total()` -> 方法（接收者是第一格实参，名字是 `<类型>_<方法>`）
 *   `Int(x)` / `len(x)` / `print(x)` -> 内建
 */
function callOf(x, C) {
  const [fn, argsTok] = kids(x);
  const args = argsTok === undefined ? [] : kids(argsTok).map((a) => exprOf(a, C));
  /* 泛型实例化：`Dict[String, Int]()` / `List[Int]()`。 */
  if (tag(fn) === 'index') {
    const t = typeOfTok(fn, C);
    if (t.kind === 'map') return { kind: 'builtin', name: 'dnew', args: [tyArg(t)] };
    if (t.kind === 'arr') {
      return { kind: 'builtin', name: 'anew', args: [tyArg(t), { kind: 'int', value: 0 }] };
    }
    throw new Error('mojo->IR: 这一格泛型调用还没接');
  }
  /* 方法：`p.total()` —— 接收者的类型决定调哪一格（`<类型>_<方法>`）。 */
  if (tag(fn) === 'attr') {
    const recv = exprOf(kids(fn)[0], C);
    const mname = String(leaf(kids(fn)[1]));
    const rt = typeOf(recv, C.tyCtx());
    if (rt.kind !== 'named') {
      throw new Error(`mojo->IR: \`.${mname}()\` 的接收者装的不是记录（是 ${rt.kind}）—— 这一格还没接`);
    }
    return { kind: 'call', fn: { kind: 'name', name: `${rt.name}_${mname}` }, args: [recv, ...args] };
  }
  const nm = String(nameOf(fn));
  if (nm === 'print') throw new Error('mojo->IR: `print` 在表达式位置上（它不交值）');
  if (CONV.has(nm) && args.length === 1) {
    const to = CONV.get(nm);
    const t = typeOf(args[0], C.tyCtx());
    if (to === 'toint' && t.kind === 'int') return args[0];
    if (to === 'toreal' && t.kind === 'real') return args[0];
    if (to === 'tostr' && t.kind === 'string') return args[0];
    return { kind: 'builtin', name: to, args };
  }
  if (nm === 'len' && args.length === 1) {
    const t = typeOf(args[0], C.tyCtx());
    return { kind: 'builtin', name: t.kind === 'string' ? 'slen' : 'alen', args };
  }
  /* `Point(1, 2)`：造一格记录（实参按声明的字段顺序）。 */
  if (C.records.has(nm)) {
    const fields = C.records.get(nm).fields;
    return {
      kind: 'new-record',
      type: named(C.ref(nm), true),
      ref: true,
      fields: fields.map((f, i) => ({
        name: f.name,
        value: args[i] === undefined ? { kind: 'int', value: 0 } : args[i],
      })),
    };
  }
  return { kind: 'call', fn: { kind: 'name', name: C.ref(nm) }, args };
}

/** 条件位置上的那一格（Mojo 的条件是布尔；`True` / `False` 也走这儿）。 */
export function condOf(x, C) {
  const e = exprOf(x, C);
  const t = typeOf(e, C.tyCtx());
  if (t.kind === 'bool' || e.kind === 'bool') return e;
  if (t.kind === 'int') {
    return { kind: 'binop', op: '!=', left: e, right: { kind: 'int', value: 0 } };
  }
  throw new Error(`mojo->IR: 这一格当条件用还没接（装的是 ${t.kind}）`);
}
