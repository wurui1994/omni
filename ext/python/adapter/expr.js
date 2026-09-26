// ext/python/adapter/expr.js —— **Python 的树 → 标准 IR 的表达式**（ADR-0044）
//
// 这一份里只有 python 自己的规矩，公共的那一半（一格 IR 表达式装的是什么）走 `ty-of.js`。
//
// ## 这一门与 mojo 那一门的**语义**差别（不是改名字）——每一处都是"答得准不准"
//
//   1. **`/` 永远是浮点**（`7 / 2` 是 `3.5`，不是 `3`）。所以两边都先 `toreal`。
//   2. **`//` 是向下取整**（`-7 // 2` 是 `-4`，C 的截断给 `-3`）。落成 `floor(a/b)`。
//   3. **`%` 的符号跟着除数**（`-7 % 2` 是 `1`，C 给 `-1`）。落成 `a - b*floor(a/b)`，
//      两个操作数各先落一格临时量 —— 不然 `f() % g()` 会把它们各算两遍。
//   4. **`str + 非串`当场报**（python 是 TypeError，不隐式转）—— mojo 那份自动补 `tostr`。
//   5. **`print(a, b)` 是一行**（空格连、末尾一个换行）。mojo 那份一格值一行 —— 那是它的规矩。
//   6. **`str(True)` 是 `"True"`**（首字母大写）。所以布尔转串单开一格 `(sel b "True" "False")`，
//      不走方言的 `tostr`（那一格出 `true`）。
//   7. **真值**：空表 / 空串 / `0` / `0.0` 都是假 —— `if xs:` 落成 `(!= (alen xs) 0)`。

import {
  tag, kids, leaf, part,
} from '../../../src/core/lower/cst.js';
import {
  INT, REAL, STR, BOOL, DYN, arrOf, dictOf, typeOf, sameType,
} from '../../../src/core/lower/ty-of.js';
import {
  isDyn, boxOf, unify, dynText, dynTruthy, dynBin, noneOf, isNoneOf,
} from './dyn.js';

/** 一格名字节点（`(n x)`）的文本；也收裸记号。 */
export const nameOf = (x) => (tag(x) === 'n' ? leaf(kids(x)[0]) : leaf(x));

/** 一格类型当实参用（`(anew (arr int) N)` 的第一格）。 */
export const tyArg = (type) => ({ kind: 'type', type });

const isInt = (t) => t !== null && t.kind === 'int';
const isNum = (t) => t !== null && (t.kind === 'int' || t.kind === 'real');

/** 比较与位运算：python 的写法 → 方言里那一格。算术那几个各有自己的规矩，不在这张表里。 */
const CMP = new Map([
  ['<', '<'], ['>', '>'], ['<=', '<='], ['>=', '>='], ['==', '=='], ['!=', '!='],
]);
const BITS = new Map([['&', '&'], ['|', '|'], ['^', '^'], ['<<', '<<'], ['>>', '>>']]);

/** 标注里认得的类型名（`def f(x: int) -> str`、`xs: list[int]`）。 */
const SCALARS = new Map([
  ['int', INT], ['float', REAL], ['str', STR], ['bool', BOOL],
]);

/**
 * 一格类型标注 → 标准 IR 的类型。认不出来回 `null`（由调用方决定报不报）。
 * `(n int)` / `(index (n list) (subs (n int)))` / `(index (n dict) (subs (n str) (n int)))`
 */
export function typeOfAnnot(tok, C) {
  if (tok === undefined || tok === null) return null;
  if (tag(tok) === 'paren') return typeOfAnnot(kids(tok)[0], C);
  /* `"int"` —— 前向引用那一种标注（字符串里写类型）。剥一层引号再问。 */
  if (tag(tok) === 'str') {
    const s = strValue(tok, C);
    return s === null ? null : (SCALARS.get(s) ?? null);
  }
  if (tag(tok) === 'n') {
    const n = String(nameOf(tok));
    if (SCALARS.has(n)) return SCALARS.get(n);
    if (C.records.has(n)) return C.records.get(n).type;
    return null;
  }
  if (tag(tok) === 'index') {
    const base = tag(kids(tok)[0]) === 'n' ? String(nameOf(kids(tok)[0])) : null;
    const args = kids(part(tok, 'subs') ?? { kind: 'list', items: [] });
    if (base === 'list' && args.length === 1) {
      const e = typeOfAnnot(args[0], C);
      return e === null ? null : arrOf(e);
    }
    if (base === 'dict' && args.length === 2) {
      const k = typeOfAnnot(args[0], C);
      const v = typeOfAnnot(args[1], C);
      return k === null || v === null ? null : dictOf(v, k);
    }
    return null;
  }
  return null;
}

/* ─── 字面量：串与数 ──────────────────────────────────────────────────────── */

/** 一格串记号拆成 `{ prefix, body }`（前缀最多两字母，正文不含引号）。 */
function splitString(text) {
  const m = /^([A-Za-z]{0,2})('''|"""|'|")([\s\S]*)\2$/.exec(text);
  if (m === null) throw new Error(`python->IR: 这个串记号读不开：${text.slice(0, 24)}`);
  return { prefix: m[1].toLowerCase(), body: m[3] };
}

/** python 的转义（`Lib/codecs` 那一套里 `unicode_escape` 的常用子集）。 */
const ESC = new Map([
  ['\\', '\\'], ["'", "'"], ['"', '"'], ['a', '\u0007'], ['b', '\b'], ['f', '\f'],
  ['n', '\n'], ['r', '\r'], ['t', '\t'], ['v', '\v'], ['0', '\0'],
]);

/** 一格串记号 → 它的正文。原始串（`r"…"`）不解转义；`b` / `f` / `t` 前缀这一版不接。 */
function oneString(text) {
  const { prefix, body } = splitString(text);
  if (prefix.includes('b')) throw new Error('python->IR: bytes 串（b"…"）还没接');
  if (prefix.includes('f')) {
    if (/[{}]/.test(body)) {
      throw new Error('python->IR: f-string 里那段表达式还没接（PEP 701 那一刀）—— '
        + '现在整份 f-string 是一个记号');
    }
    return body;
  }
  if (prefix.includes('t')) throw new Error('python->IR: 模板串（t"…"）还没接');
  if (prefix.includes('r')) return body;
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '\\') { out += body[i]; continue; }
    const c = body[i + 1];
    if (c === '\n') { i += 1; continue; }            // 续行：整个吃掉
    if (ESC.has(c)) { out += ESC.get(c); i += 1; continue; }
    if (c === 'x') { out += String.fromCodePoint(parseInt(body.slice(i + 2, i + 4), 16)); i += 3; continue; }
    if (c === 'u') { out += String.fromCodePoint(parseInt(body.slice(i + 2, i + 6), 16)); i += 5; continue; }
    if (c === 'U') { out += String.fromCodePoint(parseInt(body.slice(i + 2, i + 10), 16)); i += 9; continue; }
    /* python 里不认识的转义**照原样留着反斜杠**（不报错，`Parser/string_parser.c`）。 */
    out += body[i];
  }
  return out;
}

/** `(str T1 T2 …)` —— 相邻串自动拼接。 */
export function strValue(x) {
  return kids(x).map((t) => oneString(String(leaf(t)))).join('');
}

/** 一格数记号 → `{ kind: 'int' | 'real', value }`。 */
export function numValue(text) {
  const t = String(text).replace(/_/g, '');
  if (/[jJ]$/.test(t)) throw new Error('python->IR: 复数（1j）还没接');
  if (/^0[xX]/.test(t)) return { kind: 'int', value: BigInt(t) };
  if (/^0[oO]/.test(t)) return { kind: 'int', value: BigInt(parseInt(t.slice(2), 8)) };
  if (/^0[bB]/.test(t)) return { kind: 'int', value: BigInt(parseInt(t.slice(2), 2)) };
  if (/[.eE]/.test(t)) return { kind: 'real', value: Number(t) };
  return { kind: 'int', value: BigInt(t) };
}

/* ─── 推断：一格 CST 表达式装的是什么 ─────────────────────────────────────── */
//
// 这一格**不建 IR**（所以没有副作用，可以反复跑）。推不出来回 `null` —— 推断那几轮靠它
// 收敛：第一轮里"形参还不知道装什么"的地方回 null，等下一轮再问。
//
// 为什么不直接 `typeOf(exprOf(x))`：`exprOf` 会开临时量、会往语句槽里塞句子。
// 推断要跑三轮，那三轮会留下一堆垃圾（mojo 那门没这个问题 —— 它的类型全写在声明上）。

/** 内建函数交出来的类型。`null` = 要看实参。 */
const BUILTIN_RET = new Map([
  ['len', INT], ['int', INT], ['float', REAL], ['str', STR], ['bool', BOOL],
  ['ord', INT], ['chr', STR], ['input', STR], ['print', null],
]);

/** 方法交出来的类型（按接收者装的东西分）。 */
function methodType(recvTy, name, argTys) {
  if (recvTy === null) return null;
  if (recvTy.kind === 'arr') {
    if (name === 'append' || name === 'clear' || name === 'extend') return { kind: 'void' };
    if (name === 'pop') return recvTy.elem;
    if (name === 'index' || name === 'count') return INT;
    return null;
  }
  if (recvTy.kind === 'string') {
    if (['upper', 'lower', 'strip', 'lstrip', 'rstrip', 'replace', 'join'].includes(name)) return STR;
    if (['find', 'rfind', 'count', 'index'].includes(name)) return INT;
    if (['startswith', 'endswith', 'isdigit', 'isalpha'].includes(name)) return BOOL;
    if (name === 'split') return arrOf(STR);
    return null;
  }
  if (recvTy.kind === 'map') {
    if (name === 'get') return recvTy.value;
    if (name === 'keys') return arrOf(recvTy.key);
    if (name === 'values') return arrOf(recvTy.value);
    return null;
  }
  return argTys === undefined ? null : null;
}

/** 一格 CST 表达式装的是什么（推不出来回 `null`）。 */
export function tyOfCst(x, C) {
  if (x === null || x === undefined) return null;
  switch (tag(x)) {
    case 'num': return numValue(leaf(kids(x)[0])).kind === 'real' ? REAL : INT;
    case 'str': return STR;
    case 'true': case 'false': return BOOL;
    /* `None` 就是一格箱子（标签 `"null"`）—— 所以 `x = None` 之后 `x = 1` 自然合成 dyn。 */
    case 'none': return DYN;
    case 'paren': case 'expr': return tyOfCst(kids(x)[0], C);
    case 'n': return C.lookup(String(nameOf(x)));
    case 'walrus': return tyOfCst(kids(x)[1], C);
    case 'not': case 'and': case 'or': return BOOL;
    case 'cmp': return BOOL;
    case 'un': {
      const o = String(leaf(kids(x)[0]));
      return o === 'not' ? BOOL : tyOfCst(kids(x)[1], C);
    }
    case 'cond': {
      const t = tyOfCst(kids(x)[1], C);
      return t !== null ? t : tyOfCst(kids(x)[2], C);
    }
    case 'bin': return tyOfBin(x, C);
    case 'list': {
      const ts = kids(x).map((k) => tyOfCst(k, C));
      /* 异质的表退到 `(arr dyn)` —— 与 `listOf` 那一侧同一条口径（`unify`）。 */
      const elem = unify(ts);
      return elem === null ? null : arrOf(elem);
    }
    case 'dict': {
      const items = kids(x);
      if (items.length === 0 || items.some((it) => tag(it) !== 'kv')) return null;
      const k = unify(items.map((it) => tyOfCst(kids(it)[0], C)));
      /* 值不同型退到 dyn —— 与 `dictLit` 那一侧同一条口径。 */
      const v = unify(items.map((it) => tyOfCst(kids(it)[1], C)));
      return k === null || v === null ? null : dictOf(v, k);
    }
    case 'listcomp': {
      const e = tyOfCst(kids(x)[0], C);
      return e === null ? null : arrOf(e);
    }
    case 'index': {
      const base = tyOfCst(kids(x)[0], C);
      if (base === null) return null;
      const first = kids(part(x, 'subs') ?? { kind: 'list', items: [] })[0];
      if (first !== undefined && tag(first) === 'slice') return base;   // 切一段：同型
      if (base.kind === 'arr') return base.elem;
      if (base.kind === 'map') return base.value;
      if (base.kind === 'string') return STR;                          // `s[i]` 是一格串
      return null;
    }
    /* `p.x` —— 记录的字段。 */
    case 'attr': {
      const rec = C.recOf(tyOfCst(kids(x)[0], C));
      if (rec === null) return null;
      const f = rec.fields.find((y) => y.name === String(leaf(kids(x)[1])));
      return f === undefined ? null : f.type;
    }
    case 'call': return tyOfCall(x, C);
    default: return null;
  }
}

/** 二元那一格装的是什么 —— **python 的规矩**（`/` 出浮点、`//` 跟着操作数、串 `*` 出串）。 */
function tyOfBin(x, C) {
  const [opTok, a, b] = kids(x);
  const o = String(leaf(opTok));
  if (CMP.has(o)) return BOOL;
  const taD = tyOfCst(a, C);
  const tbD = tyOfCst(b, C);
  /* 有一边是箱子：算出来的还是一格箱子（`dynBin` 每一支都装回去 —— 那几支的类型不一样，
     方言里三目两支必须同型）。 */
  if (isDyn(taD) || isDyn(tbD)) return DYN;
  if (o === '/') return REAL;
  const ta = taD;
  const tb = tbD;
  if (BITS.has(o)) return ta ?? tb;
  if (o === '**') {
    if (ta === null || tb === null) return null;
    /* `2 ** 3` 是 int，`2 ** -1` 是 float，`2 ** 0.5` 是 float —— 指数是**非负整数字面量**
       才敢说是 int，别的一律 float（跑起来才知道指数的符号）。 */
    if (isInt(ta) && tag(b) === 'num' && numValue(leaf(kids(b)[0])).kind === 'int') return INT;
    return REAL;
  }
  if (ta === null || tb === null) return null;
  /* `"ab" * 3` / `3 * "ab"` 出串；`[1] * 3` 出表。 */
  if (o === '*') {
    if (ta.kind === 'string' || tb.kind === 'string') return STR;
    if (ta.kind === 'arr') return ta;
    if (tb.kind === 'arr') return tb;
  }
  if (o === '+' && ta.kind === 'string' && tb.kind === 'string') return STR;
  if (o === '+' && ta.kind === 'arr') return ta;
  if (ta.kind === 'real' || tb.kind === 'real') return REAL;
  return ta.kind === 'bool' && tb.kind === 'bool' ? INT : ta;   // `True + True` 是 2
}

/** 一格调用装的是什么。 */
function tyOfCall(x, C) {
  const [fn, argsTok] = kids(x);
  const args = argsTok === undefined ? [] : kids(argsTok);
  const argTys = args.map((a) => tyOfCst(a, C));
  if (tag(fn) === 'attr') {
    /* `math.*` 先答 —— `math` 不是一格值，问它装什么会回 null。 */
    if (tag(kids(fn)[0]) === 'n' && String(nameOf(kids(fn)[0])) === 'math') {
      const f = String(leaf(kids(fn)[1]));
      return MATH_INT.has(f) ? INT : (MATH.has(f) ? REAL : null);
    }
    const recvTy = tyOfCst(kids(fn)[0], C);
    /* 方法：接收者装的是一格记录。 */
    const rec = C.recOf(recvTy);
    if (rec !== null) {
      const inst = C.resolveMethod(rec.name, String(leaf(kids(fn)[1])), [recvTy, ...argTys]);
      return inst === null ? null : inst.ret;
    }
    return methodType(recvTy, String(leaf(kids(fn)[1])), argTys);
  }
  if (tag(fn) !== 'n') return null;
  const nm = String(nameOf(fn));
  /* `C(…)` —— 造一格记录，交的就是那个类。 */
  if (C.records.has(nm)) return C.records.get(nm).type;
  if (BUILTIN_RET.has(nm)) return BUILTIN_RET.get(nm);
  if (nm === 'abs' || nm === 'min' || nm === 'max') return argTys[0] ?? null;
  if (nm === 'sum') {
    const t = argTys[0];
    return t === null || t === undefined ? null : (t.kind === 'arr' ? t.elem : null);
  }
  if (nm === 'round') return args.length >= 2 ? REAL : INT;
  if (nm === 'list' || nm === 'sorted') {
    const t = argTys[0];
    return t === null || t === undefined ? null : (t.kind === 'arr' ? t : null);
  }
  if (nm === 'range') return arrOf(INT);
  const inst = C.resolveFn(nm, argTys);
  return inst === null ? null : inst.ret;
}

/* ─── 建 IR ───────────────────────────────────────────────────────────────── */

const ty = (e, C) => typeOf(e, C.tyCtx());
const toReal = (e, C) => (ty(e, C).kind === 'real' ? e : { kind: 'builtin', name: 'toreal', args: [e] });
/** 这一格算它一遍要不要钱（要就得先落一格临时量 —— `%` 那一格两边各用两次）。 */
const isPure = (e) => ['int', 'real', 'string', 'bool', 'name'].includes(e.kind);

/**
 * **python 的转串**。三格与方言的 `tostr` 不一样，一格一格说：
 *   * 布尔是 `True` / `False`（首字母大写），方言的 `tostr` 出 `true`；
 *   * 浮点是**最短往返**（`str(4.0)` 是 `"4.0"`、`str(0.1)` 是 `"0.1"`），方言的 `tostr`
 *     是 `%.6g`（出 `4` 与 `0.1`）—— 所以走 `(srepr E)` 那一格；
 *   * 整数两边一样。
 *
 * `srepr` 与 CPython 逐字节相同（`tests/python/examples/floatrepr.py` 三条腿都量过）：
 * 数字取最短往返，排版的门槛是"定点当且仅当 `-4 < decpt <= 16`" —— 与
 * `Python/pystrtod.c` 的 `format_float_short` 同一条。**不是** `%g` 那一族的门槛
 * （那个跟着有效位数走，`1e15` 会印成 `1e+15`）。
 */
export function pyStr(e, C) {
  const t = ty(e, C);
  if (t.kind === 'string') return e;
  /* 箱子在 `str()` 这一侧不给串加引号（`print(x)` 里 x 装着 `"a"` 印的是 `a`）。 */
  if (t.kind === 'dyn') return dynText(e, C, false);
  return pyRepr(e, C);
}

/**
 * **`repr()` 那一侧**。与 `str()` 只差一处：串带引号（`['a']` 里那个 `'a'`）。
 * 容器的 `str()` 用的是元素的 `repr()` —— 所以 `print([1.0])` 是 `[1.0]`。
 *
 * **明说的不足**：串的 repr 只加一对单引号，里头的 `'` / `\n` / `\\` 没转义
 * （方言里没有"替换一段"那一格算子，转义只能在运行期做）。
 */
export function pyRepr(e, C) {
  const t = ty(e, C);
  /* 一格箱子：按 `(dtag …)` 逐档分派（`dyn.js`）—— 运行期才知道装的是什么，
     这一层不必也不该在编译期定死它。 */
  if (t.kind === 'dyn') return dynText(e, C, true);
  if (t.kind === 'bool') {
    return {
      kind: 'ternary', type: STR, cond: e,
      then: { kind: 'string', value: 'True' },
      else_: { kind: 'string', value: 'False' },
    };
  }
  if (t.kind === 'real') return { kind: 'builtin', name: 'srepr', args: [e] };
  if (t.kind === 'int') return { kind: 'builtin', name: 'tostr', args: [e] };
  if (t.kind === 'string') {
    return {
      kind: 'binop', op: '+',
      left: { kind: 'binop', op: '+', left: { kind: 'string', value: "'" }, right: e },
      right: { kind: 'string', value: "'" },
    };
  }
  if (t.kind === 'arr') return listRepr(e, t, C);
  if (t.kind === 'map') {
    throw new Error('python->IR: 字典转串还没接 —— 方言里没有"走一遍字典的键"那一格算子');
  }
  throw new Error(`python->IR: ${t.kind} 转串还没接`);
}

/** `[1, 4, 9]` —— 方言里没有"表转串"，所以现场发一趟循环拼出来。 */
function listRepr(box, t, C) {
  const pre = [];
  let src = box;
  if (!isPure(box)) {
    const n = C.fresh('rp_xs');
    C.bind(n, t);
    pre.push({ kind: 'let', name: n, type: t, init: box });
    src = { kind: 'name', name: n };
  }
  const s = C.fresh('rp_s');
  const i = C.fresh('rp_i');
  C.bind(s, STR);
  C.bind(i, INT);
  const sv = { kind: 'name', name: s };
  const iv = { kind: 'name', name: i };
  const cat = (v) => ({ kind: 'assign', target: { kind: 'name', name: s }, value: { kind: 'binop', op: '+', left: sv, right: v } });
  return {
    kind: 'block-expr',
    stmts: [
      ...pre,
      { kind: 'let', name: s, type: STR, init: { kind: 'string', value: '[' } },
      {
        kind: 'for',
        init: { kind: 'let', name: i, type: INT, init: { kind: 'int', value: 0 } },
        cond: { kind: 'binop', op: '<', left: iv, right: lenOf(src, C) },
        post: { kind: 'assign', target: { kind: 'name', name: i }, value: { kind: 'binop', op: '+', left: iv, right: { kind: 'int', value: 1 } } },
        body: [
          {
            kind: 'if',
            cond: { kind: 'binop', op: '>', left: iv, right: { kind: 'int', value: 0 } },
            then: [cat({ kind: 'string', value: ', ' })],
            else_: null,
          },
          cat(pyRepr({ kind: 'index', obj: src, index: iv }, C)),
        ],
      },
      cat({ kind: 'string', value: ']' }),
    ],
    value: sv,
  };
}

/** `floor(a / b)` —— python 的 `//`。回的类型跟着操作数（两边都是 int 就 int）。 */
function floorDiv(a, b, wantInt, C) {
  const q = { kind: 'rmath', fn: 'floor', args: [{ kind: 'binop', op: '/', left: toReal(a, C), right: toReal(b, C) }] };
  return wantInt ? { kind: 'builtin', name: 'toint', args: [q] } : q;
}

/**
 * python 的 `%` —— **符号跟着除数**（`-7 % 2` 是 1，C 给 -1）。
 * 落成 `a - b * floor(a/b)`；a / b 各用两次，所以不纯的先落一格临时量。
 * 出浮点那一档**两边都要先提到 real**（方言的 `*` 要两边同型）。
 */
function pyMod(a, b, wantInt, C) {
  const pre = [];
  const keep = (e, p) => {
    if (isPure(e)) return e;
    const n = C.fresh(p);
    const t = ty(e, C);
    C.bind(n, t);
    pre.push({ kind: 'let', name: n, type: t, init: e });
    return { kind: 'name', name: n };
  };
  let l = keep(a, 'mod_a');
  let r = keep(b, 'mod_b');
  if (!wantInt) {
    l = toReal(l, C);
    r = toReal(r, C);
  }
  const value = {
    kind: 'binop', op: '-', left: l,
    right: { kind: 'binop', op: '*', left: r, right: floorDiv(l, r, wantInt, C) },
  };
  return pre.length === 0 ? value : { kind: 'block-expr', stmts: pre, value };
}

/** 一格表达式 → 标准 IR。 */
export function exprOf(x, C) {
  switch (tag(x)) {
    case 'num': {
      const v = numValue(leaf(kids(x)[0]));
      return v.kind === 'real'
        ? { kind: 'real', value: v.value }
        : { kind: 'int', value: v.value };
    }
    case 'str': return { kind: 'string', value: strValue(x) };
    case 'true': return { kind: 'bool', value: true };
    case 'false': return { kind: 'bool', value: false };
    case 'none': return noneOf();
    case 'paren': case 'expr': return exprOf(kids(x)[0], C);
    case 'n': {
      const n = String(nameOf(x));
      if (C.lookup(n) === null) throw new Error(`python->IR: 用到了没赋过值的名字 '${n}'`);
      return { kind: 'name', name: C.ref(n) };
    }
    case 'not': return { kind: 'unop', op: '!', operand: condOf(kids(x)[0], C) };
    case 'and': return { kind: 'binop', op: '&&', left: condOf(kids(x)[0], C), right: condOf(kids(x)[1], C) };
    case 'or': return { kind: 'binop', op: '||', left: condOf(kids(x)[0], C), right: condOf(kids(x)[1], C) };
    case 'un': {
      const o = String(leaf(kids(x)[0]));
      if (o === '+') return exprOf(kids(x)[1], C);
      /* **负的字面量当场折**（`-1` / `-1.5`）：`range(3, 0, -1)` 的步长与 `xs[-1]` 的
         负下标都要"这一格是不是字面量"答得出来，不折的话那两处都退档。
         `-0.0` **不折** —— 折了符号就丢了（`(real -0)` 发出来是 `0`），而 python 印 `-0.0`。 */
      if (o === '-' && tag(kids(x)[1]) === 'num') {
        const v = numValue(leaf(kids(kids(x)[1])[0]));
        if (v.value !== 0 && v.value !== 0n) {
          return v.kind === 'real'
            ? { kind: 'real', value: -v.value }
            : { kind: 'int', value: -v.value };
        }
      }
      if (o === '-') return { kind: 'unop', op: '-', operand: exprOf(kids(x)[1], C) };
      /* `~x` —— 方言里没有按位取反，照它的定义落成 `-x - 1`（两个补码上逐位相同）。 */
      if (o === '~') {
        const v = exprOf(kids(x)[1], C);
        if (ty(v, C).kind !== 'int') throw new Error('python->IR: `~` 只对 int 成立');
        return {
          kind: 'binop', op: '-',
          left: { kind: 'unop', op: '-', operand: v },
          right: { kind: 'int', value: 1 },
        };
      }
      throw new Error(`python->IR: 这个一元算子还没接：${o}`);
    }
    /* `a if c else b` —— 两支要同型（方言里 `(sel c a b)` 那一格不做提升）。 */
    case 'cond': {
      const [c, a, b] = kids(x);
      const then = exprOf(a, C);
      const els = exprOf(b, C);
      const ta = ty(then, C);
      const tb = ty(els, C);
      if (!sameType(ta, tb)) {
        throw new Error(`python->IR: \`a if c else b\` 的两支不同型（${ta.kind} / ${tb.kind}）—— 还没接`);
      }
      return { kind: 'ternary', type: ta, cond: condOf(c, C), then, else_: els };
    }
    case 'cmp': return cmpOf(x, C);
    case 'bin': return binOf(x, C);
    case 'walrus': {
      const name = C.ref(String(leaf(kids(x)[0])));
      const v = exprOf(kids(x)[1], C);
      const t = ty(v, C);
      if (C.lookup(name) === null) C.bind(name, t);
      return {
        kind: 'block-expr',
        stmts: [{ kind: 'assign', target: { kind: 'name', name }, value: v }],
        value: { kind: 'name', name },
      };
    }
    case 'list': return listOf(kids(x), C);
    case 'dict': return dictLit(x, C);
    case 'index': return indexOf(x, C);
    /* `p.x` —— 记录的字段。 */
    case 'attr': {
      const obj = exprOf(kids(x)[0], C);
      const name = String(leaf(kids(x)[1]));
      const rec = C.recOf(ty(obj, C));
      if (rec === null) {
        throw new Error(`python->IR: \`.${name}\` 的接收者装的是 ${ty(obj, C).kind} —— 还没接`
          + '（模块属性没接；记录的字段接了）');
      }
      if (!rec.fields.some((f) => f.name === name)) {
        throw new Error(`python->IR: \`${rec.name}\` 没有字段 \`${name}\``
          + `（有的是 ${rec.fields.map((f) => f.name).join(' ') || '（一格都没有）'}）`
          + ' —— 字段只从类级标注与 `__init__` 顶层那几句 `self.x = …` 认');
      }
      return { kind: 'field', obj, name };
    }
    case 'call': return callOf(x, C);
    default:
      throw new Error(`python->IR: 这一格表达式还没接：${tag(x)}`);
  }
}

/** 比较。`in` / `not in` / `is` 各有自己的规矩；链式比较（`a < b < c`）在这儿摊开。 */
function cmpOf(x, C) {
  const [opTok, aTok, bTok] = kids(x);
  const o = tag(opTok) === null && opTok.kind === 'atom' ? String(leaf(opTok)) : String(leaf(opTok));
  /* **链式**：左边又是一格比较（`a < b < c` 读成 `(cmp < (cmp < a b) c)`）。
     python 的规矩是 `a<b and b<c`，而且 **b 只算一遍** —— 所以 b 必须是纯的，
     不纯的当场报（不敢悄悄算两遍）。 */
  if (tag(aTok) === 'cmp') {
    const mid = kids(aTok)[2];
    const midE = exprOf(mid, C);
    if (!isPure(midE)) {
      throw new Error('python->IR: 链式比较里中间那一格算它一遍要钱（python 只算一遍）—— 还没接');
    }
    return {
      kind: 'binop', op: '&&',
      left: cmpOf(aTok, C),
      right: cmpOne(o, midE, exprOf(bTok, C), C),
    };
  }
  if (o === 'in' || o === 'notin') {
    const inner = containsOf(exprOf(bTok, C), exprOf(aTok, C), C);
    return o === 'in' ? inner : { kind: 'unop', op: '!', operand: inner };
  }
  if (o === 'is' || o === 'isnot') {
    /* 这个值域里"同一性"只有一格可问的：**是不是那格空**（`x is None`）。
       别的 `is`（两个对象是不是同一格）要方言那一层有"比引用"那一格算子，还没有。 */
    if (tag(bTok) === 'none') return isNoneOf(exprOf(aTok, C), C, o === 'isnot');
    if (tag(aTok) === 'none') return isNoneOf(exprOf(bTok, C), C, o === 'isnot');
    throw new Error('python->IR: `is` / `is not` 只接了与 `None` 比那一格'
      + '（两个对象的同一性要方言里有"比引用"那一格算子）');
  }
  return cmpOne(o, exprOf(aTok, C), exprOf(bTok, C), C);
}

/** 一格比较：数值那一侧两边要同型（方言不提升）。 */
function cmpOne(o, a, b, C) {
  const op = CMP.get(o);
  if (op === undefined) throw new Error(`python->IR: 这个比较算子还没接：${o}`);
  const ta = ty(a, C);
  const tb = ty(b, C);
  /* 有一边是箱子：标签一样才比值，不一样 `==` 是 False（python 的 `1 == "1"`）。 */
  if (isDyn(ta) || isDyn(tb)) return dynBin(op, a, b, C);
  let l = a;
  let r = b;
  if (ta.kind === 'real' && tb.kind === 'int') r = toReal(b, C);
  if (ta.kind === 'int' && tb.kind === 'real') l = toReal(a, C);
  return { kind: 'binop', op, left: l, right: r };
}

/** `x in 容器` —— 字典是"有这个键"、串是"找得到这一段"、表是走一遍。 */
function containsOf(box, needle, C) {
  const t = ty(box, C);
  if (t.kind === 'map') return { kind: 'builtin', name: 'dhas', args: [box, needle] };
  if (t.kind === 'string') {
    return {
      kind: 'binop', op: '!=',
      left: { kind: 'builtin', name: 'sfind', args: [box, needle] },
      right: { kind: 'int', value: -1 },
    };
  }
  throw new Error(`python->IR: \`in\` 作用在 ${t.kind} 上还没接（字典与串接了）`);
}

/**
 * 箱子上那三格要的算法（`dyn.js` 只管按标签分派，规矩在这儿）。
 *
 * `**` 的整数那一支：python 里 `2 ** -1` 是 0.5，而这儿只知道"两边都是整数"、
 * **不知道指数的符号** —— 所以整数那一支也按 real 算完再 `toint`，负指数会答错
 * （静态那一侧靠"指数是非负整数字面量"才敢说 int，箱子上没有那个信息）。
 * 这一条**明说**：真要准得在运行期再分一支 `指数 < 0`，那一支还没接。
 */
const DYN_ARITH = (C) => ({
  '//': (l, r, wantInt) => floorDiv(l, r, wantInt, C),
  '%': (l, r, wantInt) => pyMod(l, r, wantInt, C),
  '**': (l, r, wantInt) => {
    const p = { kind: 'rmath', fn: 'pow', args: [toReal(l, C), toReal(r, C)] };
    return wantInt ? { kind: 'builtin', name: 'toint', args: [p] } : p;
  },
});

/** 二元算术与位运算 —— python 的四处规矩都在这儿（见文件头 1~4）。 */
function binOf(x, C) {
  const [opTok, aTok, bTok] = kids(x);
  const o = String(leaf(opTok));
  const a = exprOf(aTok, C);
  const b = exprOf(bTok, C);
  const ta = ty(a, C);
  const tb = ty(b, C);

  /* 0. 有一边是箱子：按 `(dtag …)` 两边各问一次，走 `dyn.js` 那一族。
     `//` `%` `**` 的算法（python 那三条规矩）从这儿递进去 —— 静态那一侧用的是同一份。 */
  if (isDyn(ta) || isDyn(tb)) return dynBin(o, a, b, C, DYN_ARITH(C));

  /* 1. `/` 永远是浮点。 */
  if (o === '/') return { kind: 'binop', op: '/', left: toReal(a, C), right: toReal(b, C) };
  /* 2. `//` 向下取整。 */
  if (o === '//') return floorDiv(a, b, isInt(ta) && isInt(tb), C);
  /* 3. `%` 符号跟着除数；串上的 `%` 是老式格式化（没接）。 */
  if (o === '%') {
    if (ta.kind === 'string') throw new Error('python->IR: 串上的 `%` 格式化还没接');
    return pyMod(a, b, isInt(ta) && isInt(tb), C);
  }
  if (o === '**') {
    const p = { kind: 'rmath', fn: 'pow', args: [toReal(a, C), toReal(b, C)] };
    const wantInt = isInt(ta) && tag(bTok) === 'num'
      && numValue(leaf(kids(bTok)[0])).kind === 'int'
      && numValue(leaf(kids(bTok)[0])).value >= 0n;
    return wantInt ? { kind: 'builtin', name: 'toint', args: [p] } : p;
  }
  if (BITS.has(o)) {
    if (!isInt(ta) || !isInt(tb)) {
      throw new Error(`python->IR: 位运算 '${o}' 的两边要都是 int（这里是 ${ta.kind} / ${tb.kind}）`);
    }
    return { kind: 'binop', op: BITS.get(o), left: a, right: b };
  }
  /* 串那一族：`+` 拼接、`*` 重复。**`str + 非串` 当场报** —— python 是 TypeError。 */
  if (ta.kind === 'string' || tb.kind === 'string') {
    if (o === '+') {
      if (ta.kind !== 'string' || tb.kind !== 'string') {
        throw new Error(`python->IR: \`str + ${ta.kind === 'string' ? tb.kind : ta.kind}\` —— `
          + 'python 这儿是 TypeError，不隐式转（要转就写 str(…)）');
      }
      return { kind: 'binop', op: '+', left: a, right: b };
    }
    if (o === '*') {
      const [s, n] = ta.kind === 'string' ? [a, b] : [b, a];
      return { kind: 'builtin', name: 'srep', args: [s, n] };
    }
    throw new Error(`python->IR: 串上的 '${o}' 没有这一格（python 里只有 + 与 *）`);
  }
  if (ta.kind === 'arr' || tb.kind === 'arr') {
    throw new Error(`python->IR: 表上的 '${o}' 还没接（拼接与重复都要走一遍循环）`);
  }
  if (ta.kind === 'bool' || tb.kind === 'bool') {
    throw new Error(`python->IR: 布尔当数用（\`True + 1\`）还没接`);
  }
  if (!isNum(ta) || !isNum(tb)) {
    throw new Error(`python->IR: '${o}' 的两边装的是 ${ta.kind} / ${tb.kind} —— 还没接`);
  }
  /* 混着来的先提到 real（方言那一层不提升）。 */
  const l = ta.kind === 'int' && tb.kind === 'real' ? toReal(a, C) : a;
  const r = tb.kind === 'int' && ta.kind === 'real' ? toReal(b, C) : b;
  return { kind: 'binop', op: o, left: l, right: r };
}

/**
 * `[a, b, c]` —— 方言里"造"与"填"是两件事，所以落成临时量 + 逐格 aset。
 *
 * **异质的表退到 `(arr dyn)`**（`[1, "a", 2.5]` 在 python 里天经地义）：表本身还是静态的
 * 一格数组，动态的是元素。装不进箱子的那几档（表里套表、记录）才报 —— 见 `dyn.js` 文件头。
 */
function listOf(items, C) {
  const vs = items.map((k) => exprOf(k, C));
  if (vs.length === 0) throw new Error('python->IR: 空表 `[]` 的元素类型推不出来 —— 给它一格标注（`xs: list[int] = []`）');
  const elem = unify(vs.map((v) => ty(v, C)));
  if (elem === null) {
    const ks = vs.map((v) => ty(v, C).kind).join(' / ');
    throw new Error(`python->IR: 这张表里装着 ${ks} —— 合不成一格`
      + '（异质的表退到 `(arr dyn)`，但表与记录装不进那格箱子）');
  }
  const tmp = C.fresh('list');
  const t = arrOf(elem);
  C.bind(tmp, t);
  const stmts = [{
    kind: 'let', name: tmp, type: t,
    init: { kind: 'builtin', name: 'anew', args: [tyArg(t), { kind: 'int', value: vs.length }] },
  }];
  vs.forEach((v, i) => stmts.push({
    kind: 'assign',
    target: { kind: 'index', obj: { kind: 'name', name: tmp }, index: { kind: 'int', value: i } },
    value: isDyn(elem) ? boxOf(v, C) : v,
  }));
  return { kind: 'block-expr', stmts, value: { kind: 'name', name: tmp } };
}

/** `{"a": 1, …}` —— 同上：`(dnew 类型)` 造，`(dset …)` 是语句。 */
function dictLit(x, C) {
  const items = kids(x);
  for (const it of items) {
    if (tag(it) !== 'kv') throw new Error(`python->IR: 字典里的 \`${tag(it)}\` 还没接（** 展开那一格）`);
  }
  if (items.length === 0) {
    throw new Error('python->IR: 空字典 `{}` 的键值类型推不出来 —— 给它一格标注（`d: dict[str, int] = {}`）');
  }
  const pairs = items.map((it) => [exprOf(kids(it)[0], C), exprOf(kids(it)[1], C)]);
  /* **值不同型就退到 dyn**（`{"n": 1, "s": "two"}` —— python 里的配置字典多是这个样）。
     键那一侧不退：方言的字典键只有 int 与 string 两档，而"键有时是数有时是串"
     在真代码里基本不出现 —— 撞上了当场说清，比悄悄合成一格好。 */
  const keyT = unify(pairs.map((p) => ty(p[0], C)));
  if (keyT === null || (keyT.kind !== 'int' && keyT.kind !== 'string')) {
    const ks = [...new Set(pairs.map((p) => ty(p[0], C).kind))].join(' / ');
    throw new Error(`python->IR: 这张字典的键装着 ${ks} —— 方言的字典键只有 int 与 str 两档`);
  }
  const valT = unify(pairs.map((p) => ty(p[1], C)));
  if (valT === null) {
    const vs2 = [...new Set(pairs.map((p) => ty(p[1], C).kind))].join(' / ');
    throw new Error(`python->IR: 这张字典的值装着 ${vs2} —— 合不成一格`
      + '（异质的值退到 dyn，但表与记录装不进那格箱子）');
  }
  const t = dictOf(valT, keyT);
  const tmp = C.fresh('dict');
  C.bind(tmp, t);
  const stmts = [{ kind: 'let', name: tmp, type: t, init: { kind: 'builtin', name: 'dnew', args: [tyArg(t)] } }];
  for (const [k, v] of pairs) {
    stmts.push({
      kind: 'builtin-stmt',
      name: 'dset',
      args: [{ kind: 'name', name: tmp }, k, isDyn(valT) ? boxOf(v, C) : v],
    });
  }
  return { kind: 'block-expr', stmts, value: { kind: 'name', name: tmp } };
}

/** 一格容器的长度（表 / 串 / 字典各一格算子）。 */
export function lenOf(box, C) {
  const t = ty(box, C);
  if (t.kind === 'arr') return { kind: 'builtin', name: 'alen', args: [box] };
  if (t.kind === 'string') return { kind: 'builtin', name: 'slen', args: [box] };
  if (t.kind === 'map') return { kind: 'builtin', name: 'dlen', args: [box] };
  throw new Error(`python->IR: \`len()\` 作用在 ${t.kind} 上没有这一格`);
}

/**
 * **负下标**（`xs[-1]` 是最后一格）。python 的规矩，方言里没有 —— 所以这儿补出来：
 *   * 字面量：编译期就折成 `len + k`；
 *   * 别的：`(sel (< i 0) (+ (len box) i) i)`，i 不纯的先落一格临时量。
 * 这一格**不能省**：省了 `xs[-1]` 会读到越界（症状是印出垃圾或者当场崩）。
 */
function wrapIndex(box, i, C) {
  if (i.kind === 'int') {
    return i.value < 0n
      ? { kind: 'binop', op: '+', left: lenOf(box, C), right: i }
      : i;
  }
  const pre = [];
  let idx = i;
  if (!isPure(i)) {
    const n = C.fresh('idx');
    C.bind(n, INT);
    pre.push({ kind: 'let', name: n, type: INT, init: i });
    idx = { kind: 'name', name: n };
  }
  const value = {
    kind: 'ternary', type: INT,
    cond: { kind: 'binop', op: '<', left: idx, right: { kind: 'int', value: 0 } },
    then: { kind: 'binop', op: '+', left: lenOf(box, C), right: idx },
    else_: idx,
  };
  return pre.length === 0 ? value : { kind: 'block-expr', stmts: pre, value };
}

/** `xs[i]` / `d[k]` / `s[i]` / `xs[a:b]` / `s[a:b]`。 */
function indexOf(x, C) {
  const box = exprOf(kids(x)[0], C);
  const subs = kids(part(x, 'subs') ?? { kind: 'list', items: [] });
  if (subs.length !== 1) throw new Error('python->IR: 多维下标（`a[i, j]`）还没接');
  const t = ty(box, C);
  if (tag(subs[0]) === 'slice') return sliceOf(box, subs[0], C);
  const key = exprOf(subs[0], C);
  if (t.kind === 'map') return { kind: 'builtin', name: 'dget', args: [box, key] };
  if (t.kind === 'string') {
    const i = wrapIndex(box, key, C);
    /* `(ssub E I N)` 是"从 I 起、取 N 个"（**不是** I..J）—— 方言那一侧的口径。 */
    return { kind: 'builtin', name: 'ssub', args: [box, i, { kind: 'int', value: 1 }] };
  }
  if (t.kind !== 'arr') throw new Error(`python->IR: 下标作用在 ${t.kind} 上还没接`);
  return { kind: 'index', obj: box, index: wrapIndex(box, key, C) };
}

/**
 * `xs[a:b]` / `s[a:b]`。步长没接。
 *
 * **python 的切片从不越界**：`s[0:100]` 给整条、`s[5:2]` 给空串。方言的 `ssub` 越界是
 * 当场报错，所以两头都要**夹到 [0, len]**，长度再夹到 >= 0。不夹的症状是
 * `s[1:100]` 直接崩（量到过：`substring out of range`）。
 */
function sliceOf(box, sliceTok, C) {
  const parts = kids(sliceTok);
  if (parts.length > 2) throw new Error('python->IR: 带步长的切片（`xs[::2]`）还没接');
  const t = ty(box, C);
  if (t.kind !== 'string' && t.kind !== 'arr') throw new Error(`python->IR: 切 ${t.kind} 还没接`);

  const pre = [];
  const keep = (e, p, kty = INT) => {
    if (isPure(e)) return e;
    const n = C.fresh(p);
    C.bind(n, kty);
    pre.push({ kind: 'let', name: n, type: kty, init: e });
    return { kind: 'name', name: n };
  };
  const hi = keep(lenOf(box, C), 'sl_len');
  /** `max(0, min(e, hi))` —— e 要用三遍，所以先落一格。 */
  const clamp = (e, p) => {
    const v = keep(e, p);
    return {
      kind: 'ternary', type: INT,
      cond: { kind: 'binop', op: '<', left: v, right: { kind: 'int', value: 0 } },
      then: { kind: 'int', value: 0 },
      else_: {
        kind: 'ternary', type: INT,
        cond: { kind: 'binop', op: '>', left: v, right: hi },
        then: hi,
        else_: v,
      },
    };
  };
  const from = keep(parts[0] === undefined || tag(parts[0]) === null
    ? { kind: 'int', value: 0 }
    : clamp(wrapIndex(box, exprOf(parts[0], C), C), 'sl_a'), 'sl_from');
  const to = keep(parts[1] === undefined || tag(parts[1]) === null
    ? hi
    : clamp(wrapIndex(box, exprOf(parts[1], C), C), 'sl_b'), 'sl_to');
  /** `max(0, to - from)`。 */
  const count = {
    kind: 'ternary', type: INT,
    cond: { kind: 'binop', op: '>', left: to, right: from },
    then: { kind: 'binop', op: '-', left: to, right: from },
    else_: { kind: 'int', value: 0 },
  };

  if (t.kind === 'string') {
    const value = { kind: 'builtin', name: 'ssub', args: [box, from, count] };
    return pre.length === 0 ? value : { kind: 'block-expr', stmts: pre, value };
  }
  const out = C.fresh('slice');
  const i = C.fresh('slice_i');
  C.bind(out, t);
  C.bind(i, INT);
  return {
    kind: 'block-expr',
    stmts: [
      ...pre,
      {
        kind: 'let', name: out, type: t,
        init: { kind: 'builtin', name: 'anew', args: [tyArg(t), { kind: 'int', value: 0 }] },
      },
      { kind: 'let', name: i, type: INT, init: from },
      {
        kind: 'while',
        cond: { kind: 'binop', op: '<', left: { kind: 'name', name: i }, right: to },
        body: [
          {
            kind: 'builtin-stmt', name: 'apush',
            args: [{ kind: 'name', name: out }, { kind: 'index', obj: box, index: { kind: 'name', name: i } }],
          },
          {
            kind: 'assign', target: { kind: 'name', name: i },
            value: { kind: 'binop', op: '+', left: { kind: 'name', name: i }, right: { kind: 'int', value: 1 } },
          },
        ],
      },
    ],
    value: { kind: 'name', name: out },
  };
}

/** `math.<f>` → 方言的 `(rmath "f" …)`。名单是 python 的 `math` 与那格算子的交集。 */
const MATH = new Map([
  ['sqrt', 'sqrt'], ['floor', 'floor'], ['ceil', 'ceil'], ['fabs', 'fabs'], ['pow', 'pow'],
  ['fmod', 'fmod'], ['sin', 'sin'], ['cos', 'cos'], ['tan', 'tan'], ['asin', 'asin'],
  ['acos', 'acos'], ['atan', 'atan'], ['atan2', 'atan2'], ['sinh', 'sinh'], ['cosh', 'cosh'],
  ['tanh', 'tanh'], ['asinh', 'asinh'], ['acosh', 'acosh'], ['atanh', 'atanh'],
  ['exp', 'exp'], ['expm1', 'expm1'], ['log10', 'log10'], ['log1p', 'log1p'],
  ['cbrt', 'cbrt'], ['hypot', 'hypot'],
]);

/** 这几格 `math.*` 在 python 里交的是 **int**（不是 float）。 */
const MATH_INT = new Set(['floor', 'ceil']);

/** 两格同型的值里挑一格（`min` / `max`）—— 不纯的先落一格临时量。 */
function pickOf(a, b, op, C) {
  const pre = [];
  const keep = (e, p) => {
    if (isPure(e)) return e;
    const n = C.fresh(p);
    const t = ty(e, C);
    C.bind(n, t);
    pre.push({ kind: 'let', name: n, type: t, init: e });
    return { kind: 'name', name: n };
  };
  const l = keep(a, 'pick_a');
  const r = keep(b, 'pick_b');
  const value = {
    kind: 'ternary', type: ty(l, C),
    cond: { kind: 'binop', op, left: l, right: r },
    then: l, else_: r,
  };
  return pre.length === 0 ? value : { kind: 'block-expr', stmts: pre, value };
}

/** 一格调用：内建、`math.*`、方法、用户函数。 */
export function callOf(x, C) {
  const [fn, argsTok] = kids(x);
  const argToks = argsTok === undefined ? [] : kids(argsTok);
  for (const a of argToks) {
    if (['kw', 'star', 'starstar', 'genexp'].includes(tag(a))) {
      throw new Error(`python->IR: 实参里的 \`${tag(a)}\` 还没接（命名实参 / 展开 / 生成器）`);
    }
  }
  const args = argToks.map((a) => exprOf(a, C));

  /* `math.sqrt(x)` 那一族 —— 先看它，再看方法（`math` 不是一格值）。 */
  if (tag(fn) === 'attr' && tag(kids(fn)[0]) === 'n' && String(nameOf(kids(fn)[0])) === 'math') {
    const f = String(leaf(kids(fn)[1]));
    if (!MATH.has(f)) throw new Error(`python->IR: \`math.${f}\` 还没接`);
    const call = { kind: 'rmath', fn: MATH.get(f), args: args.map((a) => toReal(a, C)) };
    /* **`math.floor` / `math.ceil` 在 python 里交的是 int**（3.0 起），不是 float ——
       漏掉这一格的症状是印 `2.0` 而 python 印 `2`。 */
    return MATH_INT.has(f) ? { kind: 'builtin', name: 'toint', args: [call] } : call;
  }
  if (tag(fn) === 'attr') return methodOf(kids(fn)[0], String(leaf(kids(fn)[1])), args, C);
  if (tag(fn) !== 'n') throw new Error(`python->IR: 被调的那一格是 ${tag(fn)} —— 还没接`);
  const nm = String(nameOf(fn));
  /* `C(a, b)` —— **造一格记录再调 `__init__`**（python 那边就是这两步）。 */
  if (C.records.has(nm)) return newRecord(C.records.get(nm), args, C);
  return builtinOf(nm, args, argToks, C);
}

/** `C(a, b)` —— `(cnew C)` 造一格，`C___init__(obj, a, b)` 填，值是那一格。 */
function newRecord(rec, args, C) {
  const tmp = C.fresh('obj');
  C.bind(tmp, rec.type);
  const obj = { kind: 'name', name: tmp };
  const stmts = [{
    kind: 'let', name: tmp, type: rec.type, init: { kind: 'new-record', type: rec.type, ref: true, fields: [] },
  }];
  const inst = C.resolveMethod(rec.name, '__init__', [rec.type, ...args.map((a) => ty(a, C))]);
  if (rec.methods.has('__init__')) {
    if (inst === null) {
      throw new Error(`python->IR: \`${rec.name}(…)\` 对不上 \`__init__\` 的形参`
        + '（个数或类型）—— 默认值与命名实参都还没接');
    }
    const fixed = args.map((a, i) => {
      const want = inst.params[i + 1].type;
      return want.kind === 'real' && ty(a, C).kind === 'int' ? toReal(a, C) : a;
    });
    stmts.push({
      kind: 'expr-stmt',
      expr: { kind: 'call', fn: { kind: 'name', name: inst.mangled }, args: [obj, ...fixed] },
    });
  } else if (args.length > 0) {
    throw new Error(`python->IR: \`class ${rec.name}\` 没有 \`__init__\`，可 \`${rec.name}(…)\` 递了实参`);
  }
  return { kind: 'block-expr', stmts, value: obj };
}

/** 内建函数与用户函数。 */
function builtinOf(nm, args, argToks, C) {
  const t0 = args.length > 0 ? ty(args[0], C) : null;
  switch (nm) {
    case 'print':
      throw new Error('python->IR: `print` 在表达式位置上（它不交值）');
    case 'len':
      return lenOf(args[0], C);
    case 'int':
      if (t0.kind === 'int') return args[0];
      /* **`int(3.7)` 是向零取整**（`int(-3.7)` 是 -3）—— 方言的 `toint` 正是这一格。 */
      if (t0.kind === 'real') return { kind: 'builtin', name: 'toint', args };
      throw new Error(`python->IR: \`int(${t0.kind})\` 还没接（串转数要走 CPython 那份 C）`);
    case 'float':
      return t0.kind === 'real' ? args[0] : toReal(args[0], C);
    case 'str':
      return pyStr(args[0], C);
    case 'bool':
      return condOfExpr(args[0], C);
    case 'ord':
      throw new Error('python->IR: `ord()` 还没接（方言里没有"串 → 码位"那一格）');
    case 'chr':
      return { kind: 'builtin', name: 'chr', args };
    case 'abs':
      if (t0.kind === 'real') return { kind: 'rmath', fn: 'fabs', args };
      return pickOf(args[0], { kind: 'unop', op: '-', operand: args[0] }, '>', C);
    case 'min': case 'max': {
      if (args.length !== 2) throw new Error(`python->IR: \`${nm}()\` 只接两格实参`);
      return pickOf(args[0], args[1], nm === 'min' ? '<' : '>', C);
    }
    case 'round': {
      /* python 的 `round` 是**银行家舍入**（`round(0.5)` 是 0，`round(1.5)` 是 2）——
         方言的 `(rmath "round")` 是 C 的 round（远离零）。两者在 .5 上不一样，明说记着。 */
      if (args.length !== 1) throw new Error('python->IR: `round(x, n)` 还没接');
      return { kind: 'builtin', name: 'toint', args: [{ kind: 'rmath', fn: 'round', args: [toReal(args[0], C)] }] };
    }
    case 'range':
      throw new Error('python->IR: `range()` 只在 `for … in range(…)` 里接了（当值用还没接）');
    default: {
      /* 用户函数。**单态化**：按实参类型挑一格实例（`add__int_int` / `add__float_float`）。 */
      const argTys = args.map((a) => ty(a, C));
      const inst = C.resolveFn(nm, argTys);
      if (inst === null) {
        if (!C.insts.has(nm)) {
          throw new Error(`python->IR: 不认识 \`${nm}()\` —— 内建里没有，这份源码里也没定义`);
        }
        const have = C.insts.get(nm).map((i) => `(${i.key})`).join(' ');
        throw new Error(`python->IR: \`${nm}(${argTys.map((t) => t.kind).join(', ')})\` 没有对得上的那一格`
          + `（这份源码里生成的是 ${have}）—— 实参个数或类型对不上`);
      }
      const fixed = args.map((a, i) => {
        const want = inst.params[i].type;
        const got = ty(a, C);
        if (want.kind === 'real' && got.kind === 'int') return toReal(a, C);
        return a;
      });
      return { kind: 'call', fn: { kind: 'name', name: inst.mangled }, args: fixed };
    }
  }
}

/** 方法调用（接收者装的东西决定调哪一格）。 */
function methodOf(recvTok, name, args, C) {
  const recv = exprOf(recvTok, C);
  const t = ty(recv, C);
  /* 记录：`<类名>_<方法名>`，接收者是第一格实参（mojo 那一门同一个落点）。 */
  const rec = C.recOf(t);
  if (rec !== null) {
    const inst = C.resolveMethod(rec.name, name, [t, ...args.map((a) => ty(a, C))]);
    if (inst === null) {
      if (!rec.methods.has(name)) {
        throw new Error(`python->IR: \`${rec.name}\` 没有方法 \`${name}\``
          + `（有的是 ${[...rec.methods.keys()].join(' ')}）`);
      }
      throw new Error(`python->IR: \`${rec.name}.${name}(…)\` 对不上那一格的形参（个数或类型）`);
    }
    const fixed = args.map((a, i) => {
      const want = inst.params[i + 1].type;
      return want.kind === 'real' && ty(a, C).kind === 'int' ? toReal(a, C) : a;
    });
    return { kind: 'call', fn: { kind: 'name', name: inst.mangled }, args: [recv, ...fixed] };
  }
  if (t.kind === 'arr') {
    if (name === 'pop' && args.length === 0) return { kind: 'builtin', name: 'apop', args: [recv] };
    if (name === 'append') throw new Error('python->IR: `.append()` 不交值（当语句用是接了的）');
    throw new Error(`python->IR: 表上的 \`.${name}()\` 还没接`);
  }
  if (t.kind === 'string') {
    if (name === 'upper' && args.length === 0) return { kind: 'builtin', name: 'supper', args: [recv] };
    if (name === 'find' && args.length === 1) return { kind: 'builtin', name: 'sfind', args: [recv, args[0]] };
    throw new Error(`python->IR: 串上的 \`.${name}()\` 还没接`
      + '（方言里串那一族只有 slen / sfind / ssub / srep / supper）');
  }
  if (t.kind === 'map') {
    if (name === 'get' && args.length === 1) return { kind: 'builtin', name: 'dget', args: [recv, args[0]] };
    throw new Error(`python->IR: 字典上的 \`.${name}()\` 还没接`);
  }
  throw new Error(`python->IR: \`.${name}()\` 的接收者装的是 ${t.kind} —— 还没接`);
}

/**
 * **真值**（`if xs:` / `while s:` / `not x`）。python 的规矩：
 * 空表、空串、空字典、`0`、`0.0` 都是假。
 */
export function condOf(x, C) {
  return condOfExpr(exprOf(x, C), C);
}

export function condOfExpr(e, C) {
  const t = ty(e, C);
  if (t.kind === 'bool') return e;
  if (t.kind === 'int') return { kind: 'binop', op: '!=', left: e, right: { kind: 'int', value: 0 } };
  if (t.kind === 'real') return { kind: 'binop', op: '!=', left: e, right: { kind: 'real', value: 0 } };
  if (t.kind === 'arr' || t.kind === 'string' || t.kind === 'map') {
    return { kind: 'binop', op: '!=', left: lenOf(e, C), right: { kind: 'int', value: 0 } };
  }
  /* 一格对象默认是真（python 的规矩：没有 `__bool__` / `__len__` 就真）。 */
  if (t.kind === 'named') return { kind: 'bool', value: true };
  /* 一格箱子：按标签分派（`dyn.js` 的 `dynTruthy`）。 */
  if (t.kind === 'dyn') return dynTruthy(e, C);
  throw new Error(`python->IR: ${t.kind} 当条件用还没接`);
}
