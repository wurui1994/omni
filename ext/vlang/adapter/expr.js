// ext/vlang/adapter/expr.js —— **V 的树 → 标准 IR 的表达式**（ADR-0044）
//
// V 与 go 的树几乎同形，可它在表达式这一侧多出四族别人没有的东西，四族都落在这一份里：
//
//   1. **Option / Result**（`?int` / `!int` / `none` / `x or { … }` / `f()!` / `if v := f()`）。
//      落的口径与图那条路**一模一样**：**"零值就是 none"** —— `return none` 发零值、
//      `x or { alt }` 发"等于零值就换成 alt"。这是一笔**明说的近似**（真值域里 0 也是个值），
//      不是这一刀引进来的：图那条路上 30 份例子的答案就是这么来的，判据也是那些答案。
//   2. **函数值**（`fn (x int) int { … }` 当值用）——**提升**成顶层函数，用处发 `(fnref …)`，
//      通过变量调的那一格发 `(callfn …)`。这一格与 Scheme 的 lambda 是同一件事，
//      所以 `fn-ref` / `call-value` 两格加在**公共**降级器里，不在这一门里。
//   3. **`<<` 是追加还是移位**：左边装数组就是 `apush`（语句），别的才是移位 ——
//      靠类型分，不靠写法。
//   4. **编译期常量**（`@FN` / `@MOD` / `@STRUCT` / `@METHOD`）—— 现在这格函数是谁，
//      adapter 自己知道（`C.cur`），所以它们就是几格字符串。

import { tag, kids, leaf, part, unquote } from '../../../src/core/lower/cst.js';
import {
  INT, REAL, STR, BOOL, arrOf, dictOf, named, typeOf,
} from '../../../src/core/lower/ty-of.js';

/** V 的算符 → 方言的算符。**`^` 是 xor**（V 没有幂算符）。 */
const OPS = new Map([
  ['+', '+'], ['-', '-'], ['*', '*'], ['/', '/'], ['%', '%'],
  ['<', '<'], ['>', '>'], ['<=', '<='], ['>=', '>='], ['==', '=='], ['!=', '!='],
  ['&&', '&&'], ['||', '||'], ['&', '&'], ['|', '|'], ['^', '^'], ['>>', '>>'],
]);

const SCALARS = new Map([
  ['int', INT], ['i8', INT], ['i16', INT], ['i32', INT], ['i64', INT], ['isize', INT],
  ['u8', INT], ['u16', INT], ['u32', INT], ['u64', INT], ['usize', INT], ['byte', INT],
  ['rune', INT], ['char', INT], ['f32', REAL], ['f64', REAL], ['float', REAL],
  ['string', STR], ['bool', BOOL], ['voidptr', INT],
]);

export const tyArg = (type) => ({ kind: 'type', type });
export const nameOf = (x) => {
  if (x === undefined || x === null) return '';
  const t = tag(x);
  if (t === 'name' || t === 'n') return String(leaf(kids(x)[0]));
  if (t === 'tname') return kids(x).map(leaf).join('.');
  return String(leaf(x));
};

/**
 * 一格类型标注 → 标准 IR 的类型。
 * `?T` / `!T`（Option / Result）**剥成 T** —— 见文件头第 1 条那笔明说的近似。
 */
export function typeOfTok(tok, C) {
  if (tok === undefined || tok === null) return { kind: 'void' };
  switch (tag(tok)) {
    case 'none': return { kind: 'void' };
    case 'option': case 'result': case 'ref': case 'ptr': case 'shared': case 'atomic':
      return typeOfTok(kids(tok)[0], C);
    case 'tname': {
      const n = nameOf(tok);
      const short = n.includes('.') ? n.split('.').pop() : n;
      if (SCALARS.has(n)) return SCALARS.get(n);
      if (C.records.has(short)) return named(C.ref(short), true);
      if (C.aliases.has(short)) return C.aliases.get(short);
      if (C.enumNames.has(short)) return INT;
      throw new Error(`vlang->IR: 这个类型还没接：${n}`);
    }
    case 'array': case 'array-fixed': return arrOf(typeOfTok(kids(tok)[0], C));
    case 'map': return dictOf(typeOfTok(kids(tok)[1], C));
    case 'tuple': return C.mvType(kids(tok).map((k) => typeOfTok(k, C)));
    case 'fntype': {
      const ps = part(tok, 'params');
      const params = (ps === undefined ? [] : kids(ps))
        .map((p) => typeOfTok(kids(p).find((y) => tag(y) !== null && tag(y) !== 'name'), C));
      const ret = kids(tok).find((y) => tag(y) !== 'params');
      return { kind: 'fn-type', params, ret: typeOfTok(ret, C) };
    }
    default:
      throw new Error(`vlang->IR: 这一格类型标注还没接：${tag(tok)}`);
  }
}

/** 一格类型的**零值**（Option 的"没有"就是它 —— 见文件头第 1 条）。 */
export function zeroExpr(type) {
  switch (type.kind) {
    case 'real': return { kind: 'real', value: 0 };
    case 'string': return { kind: 'string', value: '' };
    case 'bool': return { kind: 'bool', value: false };
    default: return { kind: 'int', value: 0 };
  }
}

/** 数值升实数（一边是实数另一边就跟上）。 */
function mkBin(op, a, b, C) {
  const ta = typeOf(a, C.tyCtx());
  const tb = typeOf(b, C.tyCtx());
  let l = a;
  let r = b;
  if (ta.kind === 'real' && tb.kind === 'int') r = { kind: 'builtin', name: 'toreal', args: [b] };
  if (ta.kind === 'int' && tb.kind === 'real') l = { kind: 'builtin', name: 'toreal', args: [a] };
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
    /* **char 落成一格串**（`` `x` `` → `"x"`）：V 的 char 是数，可 `println(`x`)` 印的是字符，
       而方言里没有 char 那一格 —— 图那条路上也是这么落的，30 份例子的答案就是它。 */
    case 'char': {
      const t = String(leaf(kids(x)[0]));
      return { kind: 'string', value: t.replace(/^`|`$/g, '') };
    }
    case 'bool': return { kind: 'bool', value: String(leaf(kids(x)[0])) === 'true' };
    case 'none': return { kind: 'int', value: 0 };
    case 'paren': case 'mut': case 'addr': return exprOf(kids(x)[0], C);
    case 'name': {
      const n = nameOf(x);
      if (n === 'true') return { kind: 'bool', value: true };
      if (n === 'false') return { kind: 'bool', value: false };
      /* `const` 是编译期常量 —— 用处直接换成那个值（见 index.js 里那段账）。 */
      const k = C.consts.get(C.ref(n));
      if (k !== undefined) return k;
      return { kind: 'name', name: C.ref(n) };
    }
    /* `@FN` / `@MOD` / `@STRUCT` / `@METHOD` —— 现在这格函数是谁，adapter 自己知道。 */
    case 'ctconst': return { kind: 'string', value: ctConst(String(leaf(kids(x)[0])), C) };
    /* `.red` —— 变体名不带枚举名（类型从上下文来，而这一层看不见上下文）：
       名字在整份文件里唯一就用它，撞了当场报。 */
    case 'evariant': {
      const n = nameOf(kids(x)[0]) || String(leaf(kids(x)[0]));
      const v = C.variants.get(n);
      if (v === undefined) throw new Error(`vlang->IR: \`.${n}\` 不是登记过的枚举变体`);
      if (v === null) throw new Error(`vlang->IR: \`.${n}\` 在几个枚举里都有 —— 这一层看不见上下文，不猜`);
      return { kind: 'int', value: v };
    }
    /* `Color.green`（枚举的值）与 `p.x`（取字段）在树上同形 —— 按"那个名字是什么"分。 */
    case 'sel': {
      const objTok = kids(x)[0];
      const fname = String(leaf(kids(x)[1]));
      if (tag(objTok) === 'name') {
        const on = nameOf(objTok);
        if (C.enumNames.has(on)) {
          const v = C.enums.get(`${on}.${fname}`);
          if (v === undefined) throw new Error(`vlang->IR: 枚举 ${on} 里没有 ${fname}`);
          return { kind: 'int', value: v };
        }
      }
      const obj = exprOf(objTok, C);
      const t = typeOf(obj, C.tyCtx());
      if (fname === 'len') {
        const nm = t.kind === 'map' ? 'dlen' : (t.kind === 'string' ? 'slen' : 'alen');
        return { kind: 'builtin', name: nm, args: [obj] };
      }
      return { kind: 'field', obj, name: fname };
    }
    case 'index': {
      const obj = exprOf(kids(x)[0], C);
      const key = exprOf(kids(x)[1], C);
      const t = typeOf(obj, C.tyCtx());
      if (t.kind === 'map') return { kind: 'builtin', name: 'dget', args: [obj, key] };
      return { kind: 'index', obj, index: key };
    }
    case 'bin': {
      const [opTok, aTok, bTok] = kids(x);
      const o = String(leaf(opTok));
      /* **`<<` 是追加还是移位**：左边装数组就是追加（那是语句 —— 见 index.js 的 `expr`）。 */
      if (o === '<<') {
        const box = exprOf(aTok, C);
        if (typeOf(box, C.tyCtx()).kind === 'arr') {
          return { kind: 'builtin', name: 'apush', args: [box, exprOf(bTok, C)], isStmt: true };
        }
        return { kind: 'binop', op: '<<', left: box, right: exprOf(bTok, C) };
      }
      const mapped = OPS.get(o);
      if (mapped === undefined) throw new Error(`vlang->IR: 这个算子还没接：${o}`);
      return mkBin(mapped, exprOf(aTok, C), exprOf(bTok, C), C);
    }
    case 'un': {
      const o = String(leaf(kids(x)[0]));
      const a = kids(x)[1];
      if (o === '!') return { kind: 'unop', op: '!', operand: condOf(a, C) };
      /* **`~x` 方言里没有**（一元算符只有 `-` 与 `!`）—— 按定义落成 `x ^ -1`。
         判据是 `bits.v` 那一行：`~12` 要是 -13。 */
      if (o === '~') {
        return {
          kind: 'binop', op: '^', left: exprOf(a, C), right: { kind: 'int', value: -1 },
        };
      }
      return { kind: 'unop', op: o, operand: exprOf(a, C) };
    }
    /* `x in xs` / `x !in xs`：表里问键（`dhas`）、数组里找元素（扫一遍）。 */
    case 'in': case 'not-in': {
      const box = exprOf(kids(x)[1], C);
      const t = typeOf(box, C.tyCtx());
      const hit = t.kind === 'map'
        ? { kind: 'builtin', name: 'dhas', args: [box, exprOf(kids(x)[0], C)] }
        : containsOf(box, exprOf(kids(x)[0], C), C);
      return tag(x) === 'in' ? hit : { kind: 'unop', op: '!', operand: hit };
    }
    case 'array': case 'array-fixed': return arrayOf(kids(x), C);
    case 'map': return dictOf2(kids(x), C);
    case 'lit': return litOf(x, C);
    case 'cast': return castOf(x, C);
    case 'call': return callOf(x, C);
    case 'fnlit': return { kind: 'fn-ref', name: C.lift(x, null) };
    case 'slice': return sliceOf(x, C);
    case 'if': return ifExprOf(x, C);
    case 'match': return matchExprOf(x, C);
    case 'or-block': return orBlockOf(x, C);
    case 'propagate-err': return propagateOf(x, C);
    case 'if-bind': return ifBindOf(x, C, true);
    default:
      throw new Error(`vlang->IR: 这一格表达式还没接：${tag(x)}`);
  }
}

/** `@FN` 那一族 —— 现在这格函数/方法/结构/模块叫什么。 */
function ctConst(which, C) {
  const cur = C.cur;
  switch (which) {
    case '@FN': return cur.fn ?? '';
    case '@MOD': return C.mod;
    case '@STRUCT': return cur.struct ?? '';
    case '@METHOD': return cur.struct === null ? (cur.fn ?? '') : `${cur.struct}.${cur.fn}`;
    case '@FILE': case '@LINE': case '@COLUMN':
      throw new Error(`vlang->IR: ${which} 要源码位置 —— adapter 这一层不带位置，不猜`);
    default:
      throw new Error(`vlang->IR: 这一格编译期常量还没接：${which}`);
  }
}

/** 条件位置上的那一格。 */
export function condOf(x, C) {
  const e = exprOf(x, C);
  const t = typeOf(e, C.tyCtx());
  if (t.kind === 'bool' || e.kind === 'bool') return e;
  if (t.kind === 'int') return { kind: 'binop', op: '!=', left: e, right: { kind: 'int', value: 0 } };
  throw new Error(`vlang->IR: 这一格当条件用还没接（装的是 ${t.kind}）`);
}

const nameRef = (n) => ({ kind: 'name', name: n });
const plus1 = (e) => ({ kind: 'binop', op: '+', left: e, right: { kind: 'int', value: 1 } });

/** `[10, 20, 30]` / `[10, 20, 30]!` —— 造一格数组再逐格写。 */
function arrayOf(items, C) {
  const its = items.map((k) => exprOf(k, C));
  const elem = its.length === 0 ? INT : typeOf(its[0], C.tyCtx());
  const t = arrOf(elem);
  const tmp = C.fresh('arr');
  C.bind(tmp, t);
  const stmts = [{
    kind: 'let', name: tmp, type: t,
    init: { kind: 'builtin', name: 'anew', args: [tyArg(t), { kind: 'int', value: its.length }] },
  }];
  its.forEach((v, i) => stmts.push({
    kind: 'assign',
    target: { kind: 'index', obj: nameRef(tmp), index: { kind: 'int', value: i } },
    value: v,
  }));
  return { kind: 'block-expr', stmts, value: nameRef(tmp) };
}

/** `{'a': 1, 'b': 2}` / `map[string]int{}` —— 造一格字典再逐格写。 */
function dictOf2(entries, C) {
  const kvs = entries.filter((e) => tag(e) === 'kv')
    .map((e) => [exprOf(kids(e)[0], C), exprOf(kids(e)[1], C)]);
  const valT = kvs.length === 0 ? INT : typeOf(kvs[0][1], C.tyCtx());
  const t = dictOf(valT);
  const tmp = C.fresh('dict');
  C.bind(tmp, t);
  const stmts = [{
    kind: 'let', name: tmp, type: t, init: { kind: 'builtin', name: 'dnew', args: [tyArg(t)] },
  }];
  for (const [k, v] of kvs) {
    stmts.push({ kind: 'builtin-stmt', name: 'dset', args: [nameRef(tmp), k, v] });
  }
  return { kind: 'block-expr', stmts, value: nameRef(tmp) };
}

/** `T{…}`（具名字段 / 位置型）与 `map[K]V{…}` 在树上同形 —— 第一格是类型。 */
function litOf(x, C) {
  const tyTok = kids(x)[0];
  if (tag(tyTok) === 'map') return dictOf2(kids(x).slice(1), C);
  const short = nameOf(tyTok).split('.').pop();
  const rec = C.records.get(short);
  if (rec === undefined) throw new Error(`vlang->IR: ${short} 不是登记过的 struct`);
  const given = new Map();
  let pos = 0;
  for (const f of kids(x).slice(1)) {
    if (tag(f) === 'f') { given.set(String(leaf(kids(f)[0])), exprOf(kids(f)[1], C)); continue; }
    if (tag(f) === 'positional') {
      /* **位置型构造的字段名与顺序从声明来**（值里没有名字）。 */
      const fd = rec.fields[pos];
      pos += 1;
      if (fd === undefined) throw new Error(`vlang->IR: ${short}{…} 给的值比声明的字段还多`);
      given.set(fd.name, exprOf(kids(f)[0], C));
      continue;
    }
    throw new Error(`vlang->IR: ${short}{…} 里这一格还没接：${tag(f)}`);
  }
  return {
    kind: 'new-record',
    type: named(C.ref(short), true),
    ref: true,
    fields: rec.fields.map((f) => ({ name: f.name, value: given.get(f.name) ?? zeroExpr(f.type) })),
  };
}

/** `int(x)` / `f64(x)` / `?int(7)` / `?int(none)` —— 同一条产生式。 */
function castOf(x, C) {
  const to = typeOfTok(kids(x)[0], C);
  const args = part(x, 'args');
  const a = args === undefined ? undefined : kids(args)[0];
  if (a === undefined || tag(a) === 'none') return zeroExpr(to);
  const v = exprOf(a, C);
  return convTo(to, v, C);
}

/** 一格转换（已经是那一档就原样交回 —— `(toint (toint …))` 那侧会报）。 */
function convTo(to, v, C) {
  const t = typeOf(v, C.tyCtx());
  if (to.kind === 'int' && t.kind !== 'int') return { kind: 'builtin', name: 'toint', args: [v] };
  if (to.kind === 'real' && t.kind !== 'real') return { kind: 'builtin', name: 'toreal', args: [v] };
  if (to.kind === 'string' && t.kind !== 'string') return { kind: 'builtin', name: 'tostr', args: [v] };
  return v;
}

/** `xs[a..b]`（上界**不含**）—— 空数组 + 一个 while 往里 push。 */
function sliceOf(x, C) {
  const [srcTok, fromTok, toTok] = kids(x);
  const src = exprOf(srcTok, C);
  const st = typeOf(src, C.tyCtx());
  const elem = st.kind === 'arr' ? st.elem : INT;
  const out = C.fresh('slice');
  const i = C.fresh('slice_i');
  C.bind(out, arrOf(elem));
  C.bind(i, INT);
  const from = fromTok === undefined || tag(fromTok) === 'none'
    ? { kind: 'int', value: 0 } : exprOf(fromTok, C);
  const to = toTok === undefined || tag(toTok) === 'none'
    ? { kind: 'builtin', name: 'alen', args: [src] } : exprOf(toTok, C);
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
        cond: { kind: 'binop', op: '<', left: nameRef(i), right: to },
        body: [
          {
            kind: 'builtin-stmt', name: 'apush',
            args: [nameRef(out), { kind: 'index', obj: src, index: nameRef(i) }],
          },
          { kind: 'assign', target: nameRef(i), value: plus1(nameRef(i)) },
        ],
      },
    ],
    value: nameRef(out),
  };
}

/** `x in 数组` —— 扫一遍（方言里没有 `contains`）。 */
function containsOf(box, needle, C) {
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
          kind: 'binop', op: '<', left: nameRef(i),
          right: { kind: 'builtin', name: 'alen', args: [box] },
        },
        body: [
          {
            kind: 'if',
            cond: {
              kind: 'binop', op: '==',
              left: { kind: 'index', obj: box, index: nameRef(i) },
              right: needle,
            },
            then: [{ kind: 'assign', target: nameRef(found), value: { kind: 'bool', value: true } }],
            else_: null,
          },
          { kind: 'assign', target: nameRef(i), value: plus1(nameRef(i)) },
        ],
      },
    ],
    value: nameRef(found),
  };
}

/** 印那一族（它们不交值 —— 在 `index.js` 的语句里接）。 */
export const PRINTS = new Set(['println', 'print', 'eprintln', 'dump']);

/**
 * 一格调用。四件事同一条产生式：
 *   `int(x)` / `f64(x)`        -> 转换
 *   `p.total()`                -> 方法（接收者的类型决定调谁，接收者是第一格实参）
 *   `f(v)`（f 装着函数）       -> `(callfn …)`
 *   `total(x: 2, y: 3)`        -> **单个 struct 形参的具名构造**（V 特有的那一格）
 */
function callOf(x, C) {
  const fnTok = kids(x)[0];
  const argsTok = part(x, 'args');
  const rawArgs = argsTok === undefined ? [] : kids(argsTok);

  if (tag(fnTok) === 'sel') {
    const m = String(leaf(kids(fnTok)[1]));
    const recv = exprOf(kids(fnTok)[0], C);
    const t = typeOf(recv, C.tyCtx());
    if (t.kind === 'named') {
      const sig = C.methods.get(`${t.name}.${m}`);
      if (sig === undefined) {
        throw new Error(`vlang->IR: ${t.name} 上没有登记过的方法 ${m} —— 这一层不猜（字段里装函数那一档也没接）`);
      }
      return {
        kind: 'call', fn: nameRef(sig.name), args: [recv, ...rawArgs.map((a) => exprOf(a, C))],
      };
    }
    if (m === 'str') return { kind: 'builtin', name: 'tostr', args: [recv] };
    throw new Error(`vlang->IR: \`.${m}()\` 这一格方法还没接（接收者装的是 ${t.kind}）`);
  }

  const nm = nameOf(fnTok);
  if (PRINTS.has(nm)) throw new Error(`vlang->IR: \`${nm}\` 在表达式位置上（它不交值）`);
  if (nm === 'panic') throw new Error('vlang->IR: `panic` 在表达式位置上 —— 它只在语句与 `or {}` 里接');
  /* `error('no')` —— Result 的"错"那一格就是零值（见文件头第 1 条）。 */
  if (nm === 'error') return { kind: 'int', value: 0 };
  if (SCALARS.has(nm) && rawArgs.length === 1) {
    return convTo(SCALARS.get(nm), exprOf(rawArgs[0], C), C);
  }
  /* 形参/局部量里装着函数 -> 通过值调。 */
  const local = C.tyCtx().env.get(C.ref(nm));
  if (local !== undefined && local.kind === 'fn-type') {
    return { kind: 'call-value', fn: nameRef(C.ref(nm)), args: rawArgs.map((a) => exprOf(a, C)) };
  }
  const sig = C.fns.get(C.ref(nm));
  /* **具名实参**：单个 struct 形参的那一格是构造（`total(x: 2, y: 3)`）。 */
  if (rawArgs.some((a) => tag(a) === 'named')) {
    if (sig === undefined) throw new Error(`vlang->IR: ${nm} 的形参表不知道，具名实参排不回位置`);
    if (sig.params.length === 1 && sig.params[0].type.kind === 'named') {
      const recName = sig.params[0].type.name;
      const rec = C.records.get(recName);
      if (rec === undefined) throw new Error(`vlang->IR: ${recName} 不是登记过的 struct`);
      const given = new Map(rawArgs.map((a) => [String(leaf(kids(a)[0])), exprOf(kids(a)[1], C)]));
      return {
        kind: 'call',
        fn: nameRef(C.ref(nm)),
        args: [{
          kind: 'new-record',
          type: named(recName, true),
          ref: true,
          fields: rec.fields.map((f) => ({ name: f.name, value: given.get(f.name) ?? zeroExpr(f.type) })),
        }],
      };
    }
    const given = new Map(rawArgs.map((a) => [String(leaf(kids(a)[0])), exprOf(kids(a)[1], C)]));
    return {
      kind: 'call',
      fn: nameRef(C.ref(nm)),
      args: sig.params.map((p) => {
        const v = given.get(p.name);
        if (v === undefined) throw new Error(`vlang->IR: ${nm} 的形参 ${p.name} 没给值`);
        return v;
      }),
    };
  }
  if (sig === undefined) {
    throw new Error(`vlang->IR: ${nm} 没有登记过 —— 这一层不猜（标准库那一族要"真的编 stdlib"那一层）`);
  }
  return { kind: 'call', fn: nameRef(C.ref(nm)), args: rawArgs.map((a) => exprOf(a, C)) };
}

/**
 * `x or { alt }` —— **等于零值就换成 alt**（Option 的口径见文件头第 1 条）。
 * `alt` 那一段是**语句**（里头可以 `panic('…')`），末尾那格表达式写回同一格临时量。
 */
function orBlockOf(x, C) {
  const [valTok, blockTok] = kids(x);
  const v = exprOf(valTok, C);
  const t = typeOf(v, C.tyCtx());
  const tmp = C.fresh('opt');
  C.bind(tmp, t);
  return {
    kind: 'block-expr',
    stmts: [
      { kind: 'let', name: tmp, type: t, init: v },
      {
        kind: 'if',
        cond: { kind: 'binop', op: '==', left: nameRef(tmp), right: zeroExpr(t) },
        then: C.valueBlock(blockTok, tmp),
        else_: null,
      },
    ],
    value: nameRef(tmp),
  };
}

/** `f()!` —— 出错就**从这格函数返回**（错的那一格是零值）。 */
function propagateOf(x, C) {
  const v = exprOf(kids(x)[0], C);
  const t = typeOf(v, C.tyCtx());
  const tmp = C.fresh('res');
  C.bind(tmp, t);
  const ret = C.cur.ret.kind === 'void'
    ? { kind: 'return', values: [] }
    : { kind: 'return', values: [zeroExpr(C.cur.ret)] };
  return {
    kind: 'block-expr',
    stmts: [
      { kind: 'let', name: tmp, type: t, init: v },
      {
        kind: 'if',
        cond: { kind: 'binop', op: '==', left: nameRef(tmp), right: zeroExpr(t) },
        then: [ret],
        else_: null,
      },
    ],
    value: nameRef(tmp),
  };
}

function ifBindOf() {
  throw new Error('vlang->IR: `if v := f() {}` 交值那一档还没接（语句那一档在 index.js 里）');
}

/** 一段 `("block" … ("expr" 值))` 末尾那格表达式的类型（只看形状，不落语句）。 */
export function tailType(blockTok, C) {
  const last = kids(blockTok)[kids(blockTok).length - 1];
  if (last === undefined || tag(last) !== 'expr') return INT;
  return typeOf(exprOf(kids(last)[0], C), C.tyCtx());
}

/** `match` 的几支：主语 + 每一支的条件与体（语句那一档与交值那一档共用这一格）。 */
export function matchParts(x, C) {
  const pre = [];
  let subj = exprOf(kids(x)[0], C);
  if (subj.kind !== 'name') {
    const tmp = C.fresh('sub');
    const t = typeOf(subj, C.tyCtx());
    C.bind(tmp, t);
    pre.push({ kind: 'let', name: tmp, type: t, init: subj });
    subj = nameRef(tmp);
  }
  const arms = [];
  let elseBlock = null;
  for (const a of kids(x).slice(1)) {
    if (tag(a) === 'else') { elseBlock = part(a, 'block') ?? kids(a)[0]; continue; }
    if (tag(a) !== 'arm') throw new Error(`vlang->IR: match 里这一格还没接：${tag(a)}`);
    const items = part(a, 'items');
    const cond = kids(items).map((v) => ({
      kind: 'binop', op: '==', left: subj, right: exprOf(v, C),
    })).reduce((acc, c) => ({ kind: 'binop', op: '||', left: acc, right: c }));
    arms.push({ cond, block: part(a, 'block') ?? kids(a)[kids(a).length - 1] });
  }
  return { pre, arms, elseBlock };
}

/** 交值的 `match`：一格临时量 + 每一支写一次。 */
function matchExprOf(x, C) {
  const { pre, arms, elseBlock } = matchParts(x, C);
  const t = elseBlock !== null ? tailType(elseBlock, C) : tailType(arms[0].block, C);
  const tmp = C.fresh('match');
  C.bind(tmp, t);
  let els = elseBlock === null ? null : C.valueBlock(elseBlock, tmp);
  for (let i = arms.length - 1; i >= 0; i--) {
    els = [{
      kind: 'if', cond: arms[i].cond, then: C.valueBlock(arms[i].block, tmp), else_: els,
    }];
  }
  return {
    kind: 'block-expr',
    stmts: [...pre, { kind: 'let', name: tmp, type: t, init: zeroExpr(t) }, ...(els ?? [])],
    value: nameRef(tmp),
  };
}

/** 交值的 `if`（V 里 `if` 也能交值）。 */
function ifExprOf(x, C) {
  const cond = condOf(kids(x)[0], C);
  const thenB = kids(x)[1];
  const elseTok = part(x, 'else');
  const elseB = elseTok === undefined ? null : (part(elseTok, 'block') ?? kids(elseTok)[0]);
  const t = tailType(thenB, C);
  const tmp = C.fresh('ifv');
  C.bind(tmp, t);
  return {
    kind: 'block-expr',
    stmts: [
      { kind: 'let', name: tmp, type: t, init: zeroExpr(t) },
      {
        kind: 'if',
        cond,
        then: C.valueBlock(thenB, tmp),
        else_: elseB === null ? null : C.valueBlock(elseB, tmp),
      },
    ],
    value: nameRef(tmp),
  };
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. **Option / Result 是"零值就是 none"**（文件头第 1 条）：真值域里 0 也是个值，
//      所以 `?int` 装 0 与"没有"这一层分不开。图那条路上也是这一条口径。
//   2. 闭包（捕获外层变量的 `fn`）没接 —— 提升出来的函数只收形参。
//   3. 泛型（`fn f[T]`）、`interface` 的动态分派、`sumtype` 都没接。
//   4. struct 一律落成方言的 `(class …)`（引用语义）：V 的 `&T` 与 `mut` 因此天然对上，
//      而"值语义的整格拷贝"（`q := p` 之后改 q 不动 p）这一批**故意不接** ——
//      `pointer.v` 那五行答案要的正是引用语义。

