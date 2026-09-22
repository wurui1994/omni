// ext/chez/adapter/expr.js —— **Scheme 的 datum → 标准 IR 的表达式**（ADR-0044）
//
// Scheme 在这一层最省也最费：语法只有 datum 一层（`ext/chez/chez.grammar` 12 条产生式），
// 所以"哪个 datum 是 `if`、哪个是调用"全在这一份里说（与真 Scheme 一样：那些是特殊形式）。
// 费的地方是**它什么都是表达式**：`if` 交一个值、`let` 交一个值、函数体的最后一格是返回值。
// 方言那一侧 `if` 是语句 —— 那道坎由公共降级器的 `if-expr` / `block-expr` 接
// （一格临时量 + 语句槽，见 `src/core/lower/lower-expr.js`）。

import { head, kids, text, symName, asList } from '../../../src/core/lower/cst.js';
import {
  INT, REAL, STR, BOOL, arrOf, dictOf, named, typeOf,
} from '../../../src/core/lower/ty-of.js';

/** 内建名字：Scheme 写法 → 方言里那一格（或"算子"这一类）。 */
const ARITH = new Map([
  ['+', '+'], ['-', '-'], ['*', '*'], ['/', '/'],
  ['<', '<'], ['>', '>'], ['<=', '<='], ['>=', '>='], ['=', '=='],
]);

/** 数：`1` / `-2` / `1.5`。这一批只收十进制（`#x1f` 那一族见文件尾的不足）。 */
function numOf(t) {
  const v = Number(t);
  if (Number.isNaN(v)) throw new Error(`chez->IR: 这一批还收不了这个数：${t}`);
  return v;
}

/**
 * 一格二元。**数值那一格要自己补转换**：方言的 `(bin …)` 两边类型必须一样，
 * 而 Scheme 里 `(/ (exact->inexact 7) 2)` 两边一个实数一个整数 —— 谁升谁降是**这门语言**
 * 的规矩（Scheme：整数升成实数），所以这一手在 adapter 里，不在公共降级器里。
 */
function mkBin(op, a, b, C) {
  const ta = typeOf(a, C.tyCtx());
  const tb = typeOf(b, C.tyCtx());
  let l = a;
  let r = b;
  if (ta.kind === 'real' && tb.kind === 'int') r = { kind: 'builtin', name: 'toreal', args: [b] };
  if (ta.kind === 'int' && tb.kind === 'real') l = { kind: 'builtin', name: 'toreal', args: [a] };
  return { kind: 'binop', op, left: l, right: r };
}

/** 一格 datum → IR 表达式。`C` 是 adapter 的上下文（见 index.js）。 */
export function exprOf(x, C) {
  switch (head(x)) {
    case 'num': {
      const t = String(text(x));
      const v = numOf(t);
      /* **实数看写法，不看值**：`7.0` 是实数（Scheme 的"非精确"），`7` 是整数 ——
         按 `Number.isInteger` 判会把 `7.0` 当整数，于是 `(/ 7.0 3.0)` 变成整数除法
         （`conv.ss` 就是这么错的：`(toint (bin "/" (int 7) (int 3)))` 说"要 real"）。 */
      const isReal = t.includes('.') || /[eE]/.test(t);
      return isReal ? { kind: 'real', value: v } : { kind: 'int', value: v };
    }
    case 'str': return { kind: 'string', value: text(x) };
    case 'bool': return { kind: 'bool', value: text(x) === '#t' || text(x) === '#true' };
    case 'sym': return { kind: 'name', name: C.ref(text(x)) };
    /* `'a` 这一批只当一格**串常量**收（真的 datum 值要另一格能力，见文件尾）。 */
    case 'quote': return { kind: 'string', value: `'${text(kids(x)[0]) ?? '?'}'` };
    default: break;
  }
  const items = asList(x);
  if (items === null) throw new Error(`chez->IR: 这一格 datum 还没接：${head(x)}`);
  if (items.length === 0) throw new Error('chez->IR: 空表 `()` 当值用还没接');
  const op = symName(items[0]);
  const rest = items.slice(1);

  /* ---- 特殊形式（求值那一层的事，不是语法的事）------------------------------ */
  switch (op) {
    case 'if': {
      const then = exprOf(rest[1], C);
      const els = rest[2] === undefined ? null : exprOf(rest[2], C);
      const t = typeOf(then, C.tyCtx());
      return {
        kind: 'if-expr', cond: condOf(rest[0], C), then, else_: els, type: t,
      };
    }
    case 'begin': return seqExpr(rest, C);
    case 'let': case 'let*': return letExpr(rest, C);
    /* `(values 3 7)`：多值落**一格合成的记录**（值语义的 struct）—— 与 go 的多返回、
       nim 的元组同一个落点。记录是按"几个值 + 各自类型"去重的（见 index.js 的 mvType）。 */
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
      /* 向量字面量：造一格数组再逐格写 —— `anew` 只给长度，值要 `aset`（都是语句）。
         这一格回的是"一段要先跑的语句 + 一格值"，所以走 `block-expr`。 */
      const items2 = rest.map((r) => exprOf(r, C));
      const elem = items2.length === 0 ? INT : typeOf(items2[0], C.tyCtx());
      const tmp = C.fresh('vec');
      const stmts = [{
        kind: 'let', name: tmp, type: arrOf(elem),
        init: { kind: 'builtin', name: 'anew', args: [tyArg(arrOf(elem)), { kind: 'int', value: items2.length }] },
      }];
      C.bind(tmp, arrOf(elem));
      items2.forEach((v, i) => stmts.push({
        kind: 'assign',
        target: { kind: 'index', obj: { kind: 'name', name: tmp }, index: { kind: 'int', value: i } },
        value: v,
      }));
      return { kind: 'block-expr', stmts, value: { kind: 'name', name: tmp } };
    }
    case 'make-eqv-hashtable': case 'make-eq-hashtable':
    case 'make-equal-hashtable': case 'make-hashtable':
      return { kind: 'builtin', name: 'dnew', args: [tyArg(dictOf(INT))] };
    case 'hashtable-ref': return {
      kind: 'builtin', name: 'dget', args: [exprOf(rest[0], C), exprOf(rest[1], C)],
    };
    case 'hashtable-contains?': return {
      kind: 'builtin', name: 'dhas', args: [exprOf(rest[0], C), exprOf(rest[1], C)],
    };
    case 'vector-ref': return {
      kind: 'index', obj: exprOf(rest[0], C), index: exprOf(rest[1], C),
    };
    case 'vector-length': return { kind: 'builtin', name: 'alen', args: [exprOf(rest[0], C)] };
    case 'string-length': return { kind: 'builtin', name: 'slen', args: [exprOf(rest[0], C)] };
    case 'string-append': {
      const parts = rest.map((r) => exprOf(r, C));
      return parts.reduce((a, b) => mkBin('+', a, b, C));
    }
    /* `(vector-copy v 1 3)` / `(subvector v 1 3)`：**上界不含、0 起**（R6RS/R7RS 与方言一致）。
       方言里没有"切一段"这一格，所以落成"造一格空数组 + 一个 while 往里 push" ——
       与从前那条路上 `slice` 那格节点在 backend-core 里被摊开成的形状相同。 */
    case 'vector-copy': case 'subvector': {
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
    /* 表示转换：**图上（与方言里）没有"精确/非精确"这一格**，只有整数与实数，
       所以 `exact` / `truncate` 落 `toint`、`inexact` 那一族落 `toreal`。 */
    /* **已经是那一档就什么都不发**：`(exact (truncate x))` 里 `truncate` 已经落成 `toint` 了，
       再来一格 `toint` 那侧当场报"要 real"（量出来的）—— 那两个词在 Scheme 里说的是
       "精确性"，而这一层只有类型。 */
    case 'exact': case 'inexact->exact': case 'truncate': {
      const v = exprOf(rest[0], C);
      return typeOf(v, C.tyCtx()).kind === 'int' ? v : { kind: 'builtin', name: 'toint', args: [v] };
    }
    case 'inexact': case 'exact->inexact': {
      const v = exprOf(rest[0], C);
      return typeOf(v, C.tyCtx()).kind === 'real' ? v : { kind: 'builtin', name: 'toreal', args: [v] };
    }
    case 'not': return { kind: 'unop', op: '!', operand: condOf(rest[0], C) };
    case 'lambda':
      throw new Error('chez->IR: `lambda` 当值用还没接 —— 那要闭包（函数值），'
        + '这一批只接具名的 `define`（与从前那条路同一个范围）');
    default: break;
  }

  /* ---- 算术与比较：**算子不是调用** ---------------------------------------- */
  if (op !== null && ARITH.has(op)) {
    const o = ARITH.get(op);
    const args = rest.map((r) => exprOf(r, C));
    if (args.length === 1 && o === '-') return { kind: 'unop', op: '-', operand: args[0] };
    if (args.length < 2) throw new Error(`chez->IR: \`${op}\` 只给了 ${args.length} 格实参`);
    /* Scheme 的算子是变长的：`(+ a b c)` 折成两两一串（左结合）。 */
    return args.reduce((a, b) => mkBin(o, a, b, C));
  }

  /* ---- `define-record-type` 生成的那三族名字 ------------------------------- */
  if (op !== null && C.records.maker.has(op)) {
    const rec = C.records.maker.get(op);
    const fields = C.records.fields.get(rec);
    return {
      kind: 'new-record',
      type: named(C.ref(rec), true),
      ref: true,
      fields: fields.map((f, i) => ({
        name: f,
        value: rest[i] === undefined ? { kind: 'int', value: 0 } : exprOf(rest[i], C),
      })),
    };
  }
  if (op !== null && C.records.access.has(op)) {
    return { kind: 'field', obj: exprOf(rest[0], C), name: C.records.access.get(op) };
  }

  /* ---- 别的都是调用 ------------------------------------------------------- */
  if (op === null) throw new Error('chez->IR: 调用的第一格不是名字（要函数值 —— 还没接）');
  const args = rest.map((r) => exprOf(r, C));
  /* **被提升的那几格要补上捕获的实参**（见 index.js 的 lift）。 */
  const extra = C.captures.get(op) ?? [];
  for (const n of extra) args.push({ kind: 'name', name: C.ref(n) });
  return { kind: 'call', fn: { kind: 'name', name: C.ref(op) }, args };
}

/** 一格类型当实参用（`(anew (arr int) N)` 的第一格）。 */
export const tyArg = (type) => ({ kind: 'type', type });

/**
 * 条件位置上的那一格。Scheme 的真值观是"只有 `#f` 是假" —— 这一批只接
 * **本来就是布尔**的那些（比较、`not`、`hashtable-contains?`）与字面量；
 * 别的（数当条件）当场报，不替这门语言猜（图那条路上也没有这一格）。
 */
export function condOf(x, C) {
  const e = exprOf(x, C);
  const t = typeOf(e, C.tyCtx());
  if (t.kind === 'bool') return e;
  if (e.kind === 'bool') return e;
  throw new Error('chez->IR: 条件位置上装的不是布尔 —— Scheme 的"只有 #f 是假"这一批没接'
    + '（写成 `(> x 0)` 那样的比较）');
}

/** `(begin e1 e2 … en)`：前面的当语句、最后一格是值。 */
export function seqExpr(forms, C) {
  if (forms.length === 0) throw new Error('chez->IR: 空的 `begin` 当值用还没接');
  const last = forms[forms.length - 1];
  const stmts = forms.slice(0, -1).map((f) => C.stmtOf(f));
  const value = exprOf(last, C);
  return stmts.length === 0 ? value : { kind: 'block-expr', stmts, value };
}

/** `(let ((x 1) (y 2)) body…)`：一串 `let` + 那段体，值是体的最后一格。 */
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
  if (body.length === 0) throw new Error('chez->IR: `let` 的体空着还没接');
  const value = seqExpr(body, C);
  C.pop();
  if (value.kind === 'block-expr') return { kind: 'block-expr', stmts: [...stmts, ...value.stmts], value: value.value };
  return { kind: 'block-expr', stmts, value };
}
