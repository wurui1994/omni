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
  INT, REAL, STR, BOOL, DYN, arrOf, dictOf, typeOf, sameType, named,
} from '../../../src/core/lower/ty-of.js';
import {
  isDyn, boxOf, unify, dynText, dynTruthy, dynBin, noneOf, isNoneOf,
} from './dyn.js';
import { splitFString } from './fstring.js';
import { splitPercent, percentArity } from './percent.js';
import {
  sumOf, pickList, anyAllOf, sortedOf, rangeList,
  joinOf, splitOf, rsplitOf, zfillOf, splitWsOf, countOf, stripOf, replaceOf, startsEndsOf, justOf,
  containsList, indexOfList, countList, valuesList, dictPopOf, dictSetDefaultOf, dropAtStmts,
  concatList, repeatList, reversedList, stepSlice, bankRound,
  caseMapOf, charClassOf, rfindOf, copyList, copyDict, charsOf, dictOfPairs,
  sortByKeyStmts, pickByKeyOf,
  listEqOf, listCmpOf, dictEqOf, intOfStr, ordOf, expandTabsOf, splitLinesOf,
} from './builtins.js';

/** 这一格 IR 里是不是夹着几句话（`block-expr`）—— 摆在条件位上就要当心。 */
export function carriesStmts(e) {
  if (e === null || typeof e !== 'object') return false;
  if (Array.isArray(e)) return e.some(carriesStmts);
  if (e.kind === 'block-expr') return true;
  return Object.values(e).some(carriesStmts);
}

/**
 * `a and b` / `a or b` —— **右边夹着几句话时要真短路**。
 *
 * python 的 `and` / `or` 是短路的（左边定了就不算右边），而这一层把两边摆进方言的
 * `&&` / `||` 里：右边那几句（`s[i].isdigit()` 那种要现场走一趟循环）会被**提到整句
 * 前头**，于是右边照算 —— `while j < n and src[j].isdigit()` 在 j == n 那一圈当场炸
 * （`substring out of range`）。
 *
 * 落成一格临时量加一句 `if`：只有该算右边的时候才算。
 */
function andOrOf(x, C) {
  const isAnd = tag(x) === 'and';
  const l = condOf(kids(x)[0], C);
  const r = condOf(kids(x)[1], C);
  if (!carriesStmts(r)) {
    return { kind: 'binop', op: isAnd ? '&&' : '||', left: l, right: r };
  }
  const n = C.fresh(isAnd ? 'sc_a' : 'sc_o');
  C.bind(n, BOOL);
  const v = { kind: 'name', name: n };
  return {
    kind: 'block-expr',
    stmts: [
      { kind: 'let', name: n, type: BOOL, init: l },
      {
        kind: 'if',
        cond: isAnd ? v : { kind: 'unop', op: '!', operand: v },
        then: [{ kind: 'assign', target: v, value: r }],
        else_: [],
      },
    ],
    value: v,
  };
}

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

/** 一格串记号 → 它的正文。原始串（`r"…"`）不解转义；`b` / `t` 前缀这一版不接。 */
function oneString(text) {
  const { prefix, body } = splitString(text);
  if (prefix.includes('b')) throw new Error('python->IR: bytes 串（b"…"）还没接');
  if (prefix.includes('t')) throw new Error('python->IR: 模板串（t"…"）还没接');
  if (prefix.includes('f')) {
    /* f-string 走 `fstringOf`（那一侧要的是 IR，不是一段文本）。到得了这儿说明
       里头没有替换字段 —— `{{` / `}}` 仍要还原成一个花括号。 */
    return splitFString(body).map((p) => {
      if (p.lit === undefined) throw new Error('python->IR: 这一格 f-string 走错了路（内部错）');
      return p.lit;
    }).join('');
  }
  if (prefix.includes('r')) return body;
  return unescapePy(body);
}

/** python 的转义解一遍（`r` 前缀那一档不走这儿）。 */
function unescapePy(body) {
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

/** 这一格 `(str …)` 里有 f-string 而且带替换字段吗（那时要走 `fstringOf`）。 */
export function hasFields(x) {
  return kids(x).some((t) => {
    const { prefix, body } = splitString(String(leaf(t)));
    if (!prefix.includes('f')) return false;
    return splitFString(body).some((p) => p.lit === undefined);
  });
}

/**
 * 一格 `(str …)` 的 f-string 分段 —— 表达式那几段连**解析好的树**。
 *
 * **记在 C 上**（`C.fstrCache`）：推断那几趟（单态化从调用点收实例）与发射那一趟都要它，
 * 而"再解析一遍"不便宜；而且两趟拿到的必须是同一棵树，不然类型对不上。
 */
export function fstringParts(x, C) {
  const key = kids(x).map((t) => String(leaf(t))).join('\u0000');
  const hit = C.fstrCache.get(key);
  if (hit !== undefined) return hit;
  const out = [];
  for (const t of kids(x)) {
    const text = String(leaf(t));
    const { prefix, body } = splitString(text);
    if (!prefix.includes('f')) { out.push({ lit: oneString(text) }); continue; }
    for (const p of splitFString(body)) {
      if (p.lit !== undefined) {
        /* 字面那几段照普通串解转义（`f"a\tb"`）—— 原始 f-string（`rf"…"`）不解。 */
        out.push({ lit: prefix.includes('r') ? p.lit : unescapePy(p.lit) });
        continue;
      }
      out.push({ src: p.src, conv: p.conv, spec: p.spec, tree: C.exprTreeOf(p.src, 'f-string') });
    }
  }
  C.fstrCache.set(key, out);
  return out;
}

/**
 * **f-string → 一格串的 IR**：字面的几段与算出来的几段用 `+` 拼起来。
 *
 * 替换字段里那段表达式**用同一张 LR 表再解析一遍**（`C.exprTreeOf`，jnc 的
 * `jncParseExpr` 是同一条先例）—— 所以 `f"{a + b}"`、`f"{d['k']}"`、`f"{f(x)}"`
 * 这些都走得通，认的是同一门 python。
 *
 * 转换与格式说明：
 *   * 没写 → `str()` 那一侧（`pyStr`）；
 *   * `!r` → `repr()` 那一侧（`pyRepr`）；`!s` → `str()`；
 *   * `:.Nf` → `(sfix v N)`（小数点后定 N 位 —— 最常见的那一格）；
 *   * 别的格式说明**当场报**：那是一整套微语言（`Python/formatter_unicode.c`），
 *     对齐 / 填充 / 千分位 / 进制都在里头，猜一个出来就是印错。
 */
/**
 * **一段拼串先钉住**（纯的那几段不必）。
 *
 * 凡是"把几段拼成一个表达式"的地方都要走这一条：段里带的 `block-expr` 那几句会被提到
 * 整句最前头，于是**后面那一段的活儿跑在前面那一段的副作用之前**，而 python 是从左到右
 * 算的。量到的原话：`f"{xs.pop()} {xs}"` 答 `2 [1, 2]`（python 是 `2 [1]`）——
 * 转 `xs` 那趟循环跑在 `apop` 之前。与 `print` 的实参按次序钉住是同一条账。
 */
function pinPiece(v, C, pre, p = 'cc') {
  if (isPure(v)) return v;
  const t = ty(v, C);
  if (t.kind === 'void') return v;
  const n = C.fresh(p);
  C.bind(n, t);
  pre.push({ kind: 'let', name: n, type: t, init: v });
  return { kind: 'name', name: n };
}

/** 一串段按次序钉住再用 `+` 折起来（头一段不是串时先补一格空串）。 */
function concatPieces(pieces0, C, p = 'cc') {
  if (pieces0.length === 0) return { kind: 'string', value: '' };
  const pre = [];
  const pieces = pieces0.map((v) => pinPiece(v, C, pre, p));
  let out = pieces[0];
  /* 头一段不是串时先补一格空串 —— 方言的 `+` 要两边同型。 */
  if (ty(out, C).kind !== 'string') out = { kind: 'binop', op: '+', left: { kind: 'string', value: '' }, right: out };
  for (let i = 1; i < pieces.length; i += 1) out = { kind: 'binop', op: '+', left: out, right: pieces[i] };
  return pre.length === 0 ? out : { kind: 'block-expr', stmts: pre, value: out };
}

function fstringOf(x, C) {
  const pieces = fstringParts(x, C).map((p) => (p.lit !== undefined
    ? { kind: 'string', value: p.lit }
    : fmtField(exprOf(p.tree, C), p, C)));
  return concatPieces(pieces, C, 'fs_c');
}

/**
 * f-string 的**格式说明**（`:>10.3f` / `:05d` / `:^6` / `:x` / `:+.2f`）。
 *
 * python 那套微语言的形状是 `[[填充]对齐][符号][#][0][宽度][,][.精度][类型]`。
 * 这儿收的是其中一块：填充 + 对齐（`< > ^`）、符号（`+` / `-` / 空格）、`0`、
 * 宽度、`.精度`、类型（`d f s x X o b`）。收不下的**当场报** —— 猜一个出来就是印错。
 *
 * 明说没收的：`#`（`0x` 前缀）、`,`（千分位）、`=`（符号后填充）、`e` / `g` / `%` / `n`、
 * 宽度或精度写成 `{}`（从实参来）。
 */
const SPEC_RE = /^(?:(.)?([<>^]))?([+ -])?(0)?(\d+)?(?:\.(\d+))?([a-zA-Z%])?$/;

function fmtSpec(e0, spec, C) {
  const m = SPEC_RE.exec(spec);
  if (m === null) throw new Error(`python->IR: f-string 的格式说明 \`:${spec}\` 读不下来`);
  const [, fill0, align, sign, zero, widthS, precS, type] = m;
  if (type !== undefined && !'dfsxXob'.includes(type)) {
    throw new Error(`python->IR: f-string 的格式类型 \`${type}\` 还没接`
      + '（接了的是 d / f / s / x / X / o / b）');
  }
  const width = widthS === undefined ? 0 : Number(widthS);
  const prec = precS === undefined ? null : Number(precS);
  const t = ty(e0, C);
  const numeric = ['int', 'real'].includes(t.kind);

  /* 符号那一格要读两遍（判正负 + 印出来），所以先钉住。 */
  const pre = [];
  let e = e0;
  if (!isPure(e0) && (sign === '+' || sign === ' ')) {
    const n = C.fresh('fs_v');
    C.bind(n, t);
    pre.push({ kind: 'let', name: n, type: t, init: e0 });
    e = { kind: 'name', name: n };
  }

  /* 一、正文。 */
  let s;
  if (type === 'f') {
    s = { kind: 'builtin', name: 'sfix', args: [toReal(e, C), { kind: 'int', value: prec ?? 6 }] };
  } else if (type === 'x' || type === 'X' || type === 'o' || type === 'b') {
    if (t.kind !== 'int') throw new Error(`python->IR: \`:${type}\` 要整数，这里是 ${t.kind}`);
    const base = { x: 16, X: 16, o: 8, b: 2 }[type];
    s = { kind: 'builtin', name: 'sbase', args: [e, { kind: 'int', value: base }] };
    if (type === 'X') s = { kind: 'builtin', name: 'supper', args: [s] };
  } else if (type === 'd') {
    if (t.kind !== 'int') throw new Error(`python->IR: \`:d\` 要整数，这里是 ${t.kind}`);
    s = { kind: 'builtin', name: 'tostr', args: [e] };
  } else if (prec !== null && t.kind === 'real') {
    s = { kind: 'builtin', name: 'sfix', args: [e, { kind: 'int', value: prec }] };
  } else {
    s = pyStr(e, C);
    /* `:.N` 作用在串上是**截到 N 个字符**（python 的规矩）。 */
    if (prec !== null) {
      const len = { kind: 'builtin', name: 'slen', args: [s] };
      s = {
        kind: 'builtin', name: 'ssub',
        args: [s, { kind: 'int', value: 0 }, {
          kind: 'ternary', type: INT,
          cond: { kind: 'binop', op: '<', left: len, right: { kind: 'int', value: prec } },
          then: len,
          else_: { kind: 'int', value: prec },
        }],
      };
    }
  }

  /* 二、符号（只对数；`-` 就是默认的那一档，不用做）。 */
  if ((sign === '+' || sign === ' ') && numeric) {
    const lead = { kind: 'string', value: sign === '+' ? '+' : ' ' };
    s = {
      kind: 'ternary', type: STR,
      cond: {
        kind: 'binop', op: '<', left: e,
        right: t.kind === 'real' ? { kind: 'real', value: 0 } : { kind: 'int', value: 0 },
      },
      then: s,
      else_: { kind: 'binop', op: '+', left: lead, right: s },
    };
  }

  /* 三、补到宽度。**没写对齐时数右对齐、别的左对齐**（python 的规矩）。 */
  if (width > 0) {
    const fill = fill0 ?? (zero !== undefined ? '0' : ' ');
    const how = align ?? (numeric ? '>' : '<');
    if (how === '^') s = centerTo(s, width, fill, C);
    else if (fill === '0' && how === '>' && numeric) s = padTo(s, width, { left: false, zero: true }, C);
    else s = padFill(s, width, fill, how === '<', C);
  }
  return pre.length === 0 ? s : { kind: 'block-expr', stmts: pre, value: s };
}

/** 补到宽度，填充字符自己给（`padTo` 只会补空格与零）。 */
function padFill(s, width, ch, left, C) {
  const n = {
    kind: 'binop', op: '-', left: { kind: 'int', value: width },
    right: { kind: 'builtin', name: 'slen', args: [s] },
  };
  const pad = { kind: 'builtin', name: 'srep', args: [{ kind: 'string', value: ch }, n] };
  return left
    ? { kind: 'binop', op: '+', left: s, right: pad }
    : { kind: 'binop', op: '+', left: pad, right: s };
}

/**
 * 居中。**`str.center()` 与 f-string 的 `:^` 摆法不一样**（量出来的）：
 * `'ab'.center(7, '*')` 是 `***ab**`（多的那一格在**左**边），
 * 而 `f"{'ab':*^7}"` 是 `**ab***`（多的在**右**边）。所以这一格收一个 `leftHeavy`。
 */
function centerTo(s0, width, ch, C, leftHeavy = false) {
  const pre = [];
  let s = s0;
  if (!isPure(s0)) {
    const n = C.fresh('fc_s');
    C.bind(n, STR);
    pre.push({ kind: 'let', name: n, type: STR, init: s0 });
    s = { kind: 'name', name: n };
  }
  const gap = {
    kind: 'binop', op: '-', left: { kind: 'int', value: width },
    right: { kind: 'builtin', name: 'slen', args: [s] },
  };
  const rep = (cnt) => ({ kind: 'builtin', name: 'srep', args: [{ kind: 'string', value: ch }, cnt] });
  /* 两边都是 int 时方言的 `/` 就是整除，而这儿的差是非负的 —— 所以不必走 `//`
     那一套（标准 IR 里压根没有那个算符名）。 */
  const half = {
    kind: 'binop', op: '/',
    left: leftHeavy ? { kind: 'binop', op: '+', left: gap, right: { kind: 'int', value: 1 } } : gap,
    right: { kind: 'int', value: 2 },
  };
  const value = {
    kind: 'binop', op: '+',
    left: { kind: 'binop', op: '+', left: rep(half), right: s },
    right: rep({ kind: 'binop', op: '-', left: gap, right: half }),
  };
  return pre.length === 0 ? value : { kind: 'block-expr', stmts: pre, value };
}

/** 一格替换字段算出来的值 → 串（按 `conv` 与 `spec`）。 */
function fmtField(e, p, C) {
  if (p.spec !== null) {
    if (p.conv !== null) throw new Error('python->IR: f-string 里转换与格式说明一起用还没接');
    if (/[{}]/.test(p.spec)) {
      throw new Error('python->IR: f-string 的格式说明里带 `{}`（宽度/精度从实参来）还没接');
    }
    return fmtSpec(e, p.spec, C);
  }
  if (p.conv === 'a') {
    throw new Error('python->IR: f-string 的 `!a`（ascii()）还没接 —— 它要按码位转义非 ASCII');
  }
  return p.conv === 'r' ? pyRepr(e, C) : pyStr(e, C);
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
  ['repr', STR], ['hex', STR], ['oct', STR], ['bin', STR], ['isinstance', BOOL],
]);

/** 方法交出来的类型（按接收者装的东西分）。 */
function methodType(recvTy, name, argTys, C) {
  if (recvTy === null) return null;
  if (recvTy.kind === 'arr') {
    if (['append', 'clear', 'extend', 'reverse', 'insert', 'remove', 'sort'].includes(name)) return { kind: 'void' };
    if (name === 'pop') return recvTy.elem;
    if (name === 'copy') return recvTy;
    if (name === 'index' || name === 'count') return INT;
    return null;
  }
  if (recvTy.kind === 'string') {
    if (['upper', 'lower', 'casefold', 'title', 'capitalize', 'swapcase', 'strip', 'lstrip', 'rstrip',
      'replace', 'join', 'ljust', 'rjust', 'zfill', 'center', 'format', 'expandtabs',
      'removeprefix', 'removesuffix'].includes(name)) return STR;
    if (['find', 'rfind', 'count', 'index', 'rindex'].includes(name)) return INT;
    if (['startswith', 'endswith',
      'isdigit', 'isalpha', 'isalnum', 'isspace', 'isupper', 'islower'].includes(name)) return BOOL;
    if (name === 'split' || name === 'rsplit') return arrOf(STR);
    if (name === 'splitlines') return arrOf(STR);
    /* `.partition()` / `.rpartition()` —— 三格串的元组（那格记录顺手登记上）。 */
    if (name === 'partition' || name === 'rpartition') return tupleRec([STR, STR, STR], C).type;
    return null;
  }
  if (recvTy.kind === 'map') {
    /* `d.get(k)` —— 键不在时 python 交 `None`，所以**交的是一格箱子**（dyn），不是值的类型。
       `d.get(k, v)` 交"值的类型与默认值的类型合成一格"（一样就是它，不一样退到 dyn）。 */
    if (name === 'get') {
      if (argTys.length <= 1) return DYN;
      return unify([recvTy.value, argTys[1]]);
    }
    if (name === 'keys') return arrOf(recvTy.key);
    if (name === 'values') return arrOf(recvTy.value);
    /* `d.pop(k)` 键不在是 KeyError（不是 `None`）—— 所以交的是**值的类型**，
       与 `.get(k)` 那一格正相反。两格实参时与 `.get` 同：两边合成一格。 */
    if (name === 'pop') {
      if (argTys.length <= 1) return recvTy.value;
      return unify([recvTy.value, argTys[1]]);
    }
    if (name === 'setdefault') return recvTy.value;
    if (name === 'items') return arrOf(tupleRec([recvTy.key, recvTy.value], C).type);
    if (name === 'popitem') return tupleRec([recvTy.key, recvTy.value], C).type;
    if (name === 'copy') return recvTy;
    if (name === 'clear' || name === 'update') return { kind: 'void' };
    return null;
  }
  return null;
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
    /* 推导式：目标先绑上（不然元素表达式里那个 `x` 问不出类型），问完指回去。
       与 `compOf` 同一条：**自己一层作用域**（理由见那儿）。 */
    case 'listcomp': case 'genexp': case 'dictcomp': {
      const nvals = tag(x) === 'dictcomp' ? 2 : 1;
      const ks = kids(x);
      let gs;
      try {
        gs = compGroups(ks.slice(nvals));
      } catch {
        return null;
      }
      C.push();
      let back;
      try {
        back = compBind(gs, C);
      } catch {
        C.pop();
        return null;
      }
      try {
        const vs = ks.slice(0, nvals).map((v) => tyOfCst(v, C));
        if (vs.some((v) => v === null)) return null;
        return nvals === 2 ? dictOf(vs[1], vs[0]) : arrOf(vs[0]);
      } finally {
        back();
        C.pop();
      }
    }
    /* 元组：按形状生成的那一格记录（`tupleRec`）。 */
    case 'tuple': {
      const items = kids(x);
      if (items.length === 0) return null;
      const ts = items.map((it) => tyOfCst(it, C));
      if (ts.some((t) => t === null || t === undefined)) return null;
      return tupleRec(ts, C).type;
    }
    case 'index': {
      const base = tyOfCst(kids(x)[0], C);
      if (base === null) return null;
      const first = kids(part(x, 'subs') ?? { kind: 'list', items: [] })[0];
      /* 元组的那一格：下标是字面量，答的是那一格字段的类型。 */
      const tup = tupleOf(C.recOf(base));
      if (tup !== null) {
        if (first === undefined) return null;
        /* 切一段：形状是编译期算出来的（与 `tupleSlice` 用的是同一份清单）。 */
        if (tag(first) === 'slice') {
          const pick = tupleSlicePick(tup.length, kids(first), C, false);
          if (pick === null || pick.length === 0) return null;
          return tupleRec(pick.map((at) => tup[at]), C).type;
        }
        if (tag(first) !== 'num') return null;
        let at = Number(numValue(leaf(kids(first)[0])).value ?? NaN);
        if (Number.isNaN(at)) return null;
        if (at < 0) at += tup.length;
        return at >= 0 && at < tup.length ? tup[at] : null;
      }
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
  /* **`"%s=%s" % (…)` 交的是串** —— 发射那一侧早就在算右边之前拦了（`percentOf`），
     类型这一侧从前漏了：于是 `o === '%'` 落到"两边都是数"那一条上，答 real。
     症状（量出来的）：`return a.ljust(3) + ("%8.2f" % p)` 报"要返回 real，给的是 string"
     —— 返回类型是按 `tyOfCst` 推的，推错了就与真发出来那一格对不上。 */
  if (o === '%' && tag(a) === 'str') return STR;
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
  /* 命名实参先排回位置上（不然单态化那一趟按次序挑实例会挑错 —— 量出来的）。 */
  const args = kwOrder(fn, argsTok === undefined ? [] : kids(argsTok), C);
  /* 实参位置上的 `range(…)` 按一张 int 表算（发射那一侧也是铺成表，见 `callOf` 里
     那格"吃序列的那几个内建"）。 */
  const argTys = args.map((a) => (tag(a) === 'call' && tag(kids(a)[0]) === 'n'
    && String(nameOf(kids(a)[0])) === 'range' ? arrOf(INT) : tyOfCst(a, C)));
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
    return methodType(recvTy, String(leaf(kids(fn)[1])), argTys, C);
  }
  if (tag(fn) !== 'n') return null;
  const nm = String(nameOf(fn));
  /* `C(…)` —— 造一格记录，交的就是那个类。 */
  if (C.records.has(nm)) return C.records.get(nm).type;
  if (BUILTIN_RET.has(nm)) return BUILTIN_RET.get(nm);
  if (nm === 'abs') return argTys[0] ?? null;
  if (nm === 'min' || nm === 'max') {
    const t = argTys[0];
    if (t === null || t === undefined) return null;
    /* 一格实参那是一格表（`min(xs)` 交元素）；串也算（`min("abc")` 交一格串）。
       两格以上逐个挑（交的还是同一档）。 */
    /* **`key=` 不算一格实参** —— 它只管怎么比，交出来的还是元素（不看这一条会把
       `min(xs, key=…)` 的类型答成那张表）。 */
    /* 两格以上：**逐格合成**（`unify`）—— 全一样就是它，int 与 real 混着来退到箱子
       （发射那一侧也装箱，见 `min`/`max` 那一格的账）。 */
    if (args.filter((a) => tag(a) !== 'kw').length !== 1) {
      return unify(args.filter((a) => tag(a) !== 'kw').map((_, i) => argTys[i]));
    }
    if (t.kind === 'arr') return t.elem;
    /* `min(字典)` / `max(字典[, key=…])` —— 字典走的是**键**。 */
    if (t.kind === 'map') return t.key;
    return t.kind === 'string' ? STR : null;
  }
  if (nm === 'any' || nm === 'all') return BOOL;
  if (nm === 'sum') {
    const t = argTys[0];
    if (t === null || t === undefined || t.kind !== 'arr') return null;
    /* `sum(xs, start)` —— 起点与元素合成一格（int 与 real 混着来就是 real）。 */
    if (args.length >= 2) return unify([t.elem, argTys[1]]);
    return t.elem;
  }
  if (nm === 'round') return args.length >= 2 ? REAL : INT;
  /* `map(f, xs)` / `filter(f, xs)` 交的是一张**真表**（编译期铺开，见 `mapPy`）——
     `filter` 交的元素还是原来那一档，`map` 得问一声"应用一遍交什么"。 */
  if (nm === 'map' || nm === 'filter') {
    if (args.length !== 2) return null;
    const st0 = argTys[1];
    if (st0 === null || st0 === undefined) return null;
    const el = st0.kind === 'arr' ? st0.elem
      : (st0.kind === 'string' ? STR : (st0.kind === 'map' ? st0.key : null));
    if (el === null) return null;
    if (nm === 'filter') return arrOf(el);
    const rt = applyTy(args[0], el, C);
    return rt === null ? null : arrOf(rt);
  }
  if (nm === 'list' || nm === 'sorted' || nm === 'reversed') {
    const t = argTys[0];
    if (t === null || t === undefined) return null;
    /* `sorted(串)` / `list(串)` 交的是一张字符表（`reversed` 只收表）。 */
    if (t.kind === 'string' && nm !== 'reversed') return arrOf(STR);
    /* **字典走的是键**（与 `for k in d` 一条）：发射那一侧早就走 `dkeys` 了，缺的一直是
       这一格类型 —— 于是 `for k in sorted(d)` 报"用到了没赋过值的名字 'k'"（绑不上）。
       `print(sorted(d))` 看不出来：那一条路上没人问过类型。 */
    if (t.kind === 'map' && nm !== 'reversed') return arrOf(t.key);
    /* `list(元组)` —— 逐格合成一格当元素。 */
    if (nm === 'list') {
      const tup = tupleOf(C.recOf(t));
      if (tup !== null) {
        const et = unify(tup);
        return et === null ? null : arrOf(et);
      }
    }
    return t.kind === 'arr' ? t : null;
  }
  /* `zip(a, b, …)` —— **N 张表**交一张 N 格元组的表（走到最短的那一张为止）。 */
  if (nm === 'zip' && argTys.length >= 2) {
    const es = argTys.map((t) => {
      if (t == null) return null;
      return t.kind === 'arr' ? t.elem : (t.kind === 'string' ? STR : null);
    });
    return es.some((e) => e === null) ? null : arrOf(tupleRec(es, C).type);
  }
  if (nm === 'enumerate' && argTys.length >= 1) {
    const a = argTys[0];
    if (a == null) return null;
    const ea = a.kind === 'arr' ? a.elem : (a.kind === 'string' ? STR : null);
    return ea === null ? null : arrOf(tupleRec([INT, ea], C).type);
  }
  if (nm === 'pow') return argTys.length === 2 && argTys.every((t) => t != null && t.kind === 'int')
    ? INT : REAL;
  /* `divmod(a, b)` —— 两格的元组，逐格类型与 `//` / `%` 交的同一档。 */
  if (nm === 'divmod' && argTys.length === 2) {
    const [x, y] = argTys;
    if (x == null || y == null) return null;
    const one = x.kind === 'int' && y.kind === 'int' ? INT : REAL;
    return tupleRec([one, one], C).type;
  }
  /* `dict(一串两格的元组)` —— 键值类型从元组来。不接这一条的症状是
     `d = dict(pairs)` 那格名字**一直没绑上**，发到 `.sx` 那侧报"未声明的变量 'd'"。 */
  if (nm === 'dict' && argTys.length === 1) {
    const t = argTys[0];
    if (t == null || t.kind !== 'arr') return null;
    const tup = tupleOf(C.recOf(t.elem));
    return tup !== null && tup.length === 2 ? dictOf(tup[1], tup[0]) : null;
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
  if (t.kind === 'map') return dictRepr(e, t, C);
  /* 元组：`(1, 'a')`。一格的那个带尾随逗号（`(1,)`）—— python 就是这么印的。
     逐格是字面上的几段，所以不必发循环（记录的字段个数在编译期就定了）。 */
  const tup = tupleOf(C.recOf(t));
  if (tup !== null) {
    /* 逐格要读它好几遍，所以先钉住（不纯的话重复发一遍会把里头那几句也发几遍）。 */
    const pre = [];
    let v = e;
    if (!isPure(e)) {
      const n = C.fresh('tp_r');
      C.bind(n, t);
      pre.push({ kind: 'let', name: n, type: t, init: e });
      v = { kind: 'name', name: n };
    }
    const cat = (l, r) => ({ kind: 'binop', op: '+', left: l, right: r });
    let out = { kind: 'string', value: '(' };
    tup.forEach((_, i) => {
      if (i > 0) out = cat(out, { kind: 'string', value: ', ' });
      out = cat(out, pyRepr({ kind: 'field', obj: v, name: `_${i}` }, C));
    });
    if (tup.length === 1) out = cat(out, { kind: 'string', value: ',' });
    const value = cat(out, { kind: 'string', value: ')' });
    return pre.length === 0 ? value : { kind: 'block-expr', stmts: pre, value };
  }
  /* **类上的 `__str__`** —— `str(p)` 与 `print(p)` 都走这儿（python 就是这条规矩）。
     没定义 `__str__` 的类当场报：python 那时印 `<__main__.P object at 0x…>`，那串里有
     地址，**逐字节比不了**，所以不装作有。 */
  const rec = C.recOf(t);
  if (rec !== null && rec.methods.has('__str__')) {
    const inst = C.resolveMethod(rec.name, '__str__', [t]);
    if (inst === null) {
      throw new Error(`python->IR: \`${rec.name}.__str__\` 对不上那一格的形参（只该有 self）`);
    }
    return { kind: 'call', fn: { kind: 'name', name: inst.mangled }, args: [e] };
  }
  if (rec !== null) {
    throw new Error(`python->IR: \`class ${rec.name}\` 没有 \`__str__\`，转串还没接`
      + '（python 那时印的是 `<__main__.X object at 0x…>` —— 里头有地址，逐字节比不了）');
  }
  throw new Error(`python->IR: ${t.kind} 转串还没接`);

}

/**
 * `{'a': 1, 'b': 3}` —— 与 `listRepr` 同一条办法（现场发一趟循环），只是走的是
 * `(dkeys d)` 交回来的那格键表，值再用 `(dget d k)` 取。
 *
 * 次序是**插入序**（`dkeys` 那一格钉死的），与 python 3.7+ 的 dict 同一条。
 * 键与值都走 `pyRepr` —— 所以 `print({"a": 1})` 是 `{'a': 1}`（键带引号）。
 */
function dictRepr(box, t, C) {
  const pre = [];
  let src = box;
  if (!isPure(box)) {
    const n = C.fresh('dr_d');
    C.bind(n, t);
    pre.push({ kind: 'let', name: n, type: t, init: box });
    src = { kind: 'name', name: n };
  }
  const ks = C.fresh('dr_ks');
  const s = C.fresh('dr_s');
  const i = C.fresh('dr_i');
  const kt = arrOf(t.key);
  C.bind(ks, kt);
  C.bind(s, STR);
  C.bind(i, INT);
  const ksv = { kind: 'name', name: ks };
  const sv = { kind: 'name', name: s };
  const iv = { kind: 'name', name: i };
  const cat = (v) => ({ kind: 'assign', target: { kind: 'name', name: s }, value: { kind: 'binop', op: '+', left: sv, right: v } });
  const k = { kind: 'index', obj: ksv, index: iv };
  return {
    kind: 'block-expr',
    stmts: [
      ...pre,
      { kind: 'let', name: ks, type: kt, init: { kind: 'builtin', name: 'dkeys', args: [src] } },
      { kind: 'let', name: s, type: STR, init: { kind: 'string', value: '{' } },
      {
        kind: 'for',
        init: { kind: 'let', name: i, type: INT, init: { kind: 'int', value: 0 } },
        cond: { kind: 'binop', op: '<', left: iv, right: { kind: 'builtin', name: 'alen', args: [ksv] } },
        post: { kind: 'assign', target: { kind: 'name', name: i }, value: { kind: 'binop', op: '+', left: iv, right: { kind: 'int', value: 1 } } },
        body: [
          {
            kind: 'if',
            cond: { kind: 'binop', op: '>', left: iv, right: { kind: 'int', value: 0 } },
            then: [cat({ kind: 'string', value: ', ' })],
            else_: null,
          },
          cat(pyRepr(k, C)),
          cat({ kind: 'string', value: ': ' }),
          cat(pyRepr({ kind: 'builtin', name: 'dget', args: [src, k] }, C)),
        ],
      },
      cat({ kind: 'string', value: '}' }),
    ],
    value: sv,
  };
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
    case 'str': return hasFields(x) ? fstringOf(x, C) : { kind: 'string', value: strValue(x) };
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
    case 'and': case 'or': return andOrOf(x, C);
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
    /* `(a, b)` —— 按形状生成一格记录（见 `tupleRec`）。 */
    case 'tuple': return tupleLit(x, C);
    /* 推导式那三格 —— 现场发一趟循环（见 `compOf`）。生成器表达式当"立刻算完的一张表"。 */
    case 'listcomp': case 'genexp': return compOf(x, C, 'list');
    case 'dictcomp': return compOf(x, C, 'dict');
    case 'setcomp':
      throw new Error('python->IR: 集合推导式还没接（方言里 `set` 那一族没开口）');
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
  /* **元组逐格比**（python 的元组比的是内容）。不这么办的话落成"是不是同一个句柄"，
     `(1, 2) == (1, 2)` 会静默答 False —— 量到过。 */
  const tupA = tupleOf(C.recOf(ta));
  if (tupA !== null) {
    const tupB = tupleOf(C.recOf(tb));
    const same = tupB !== null && tupB.length === tupA.length
      && tupA.every((t, i) => sameType(t, tupB[i]));
    if (!same) {
      /* 形状不一样的两格元组在 python 里 `==` 恒 False（长度或元素类型不同）。 */
      if (op === '==' || op === '!=') return { kind: 'bool', value: op === '!=' };
      /* 大小就不是恒定的了：python 逐格比到第一处不同、都一样就短的那格小，而且对上的
         两格类型不同那一处会 TypeError。所以这一层要**同形状**才敢答。 */
      throw new Error(`python->IR: 形状不同的两格元组比 \`${o}\` 还没接`
        + '（python 是逐格比到第一处不同、都一样就短的那格小）');
    }
    const pre = [];
    const pin = (e, t, p) => {
      if (isPure(e)) return e;
      const n = C.fresh(p);
      C.bind(n, t);
      pre.push({ kind: 'let', name: n, type: t, init: e });
      return { kind: 'name', name: n };
    };
    const l = pin(a, ta, 'tq_a');
    const r = pin(b, tb, 'tq_b');
    const fld = (box, i) => ({ kind: 'field', obj: box, name: `_${i}` });
    let out = null;
    if (op === '==' || op === '!=') {
      tupA.forEach((_, i) => {
        const one = cmpOne(op, fld(l, i), fld(r, i), C);
        out = out === null ? one
          : { kind: 'binop', op: op === '==' ? '&&' : '||', left: out, right: one };
      });
    } else {
      /* **字典序**：第一处不同的那一格说了算。落成一棵纯表达式 ——
           `a < b`  ⇒  `a0 < b0 || (a0 == b0 && (a1 < b1 || (a1 == b1 && …)))`
         最后一格用算子本身（`<=` 只在那儿才允许"到底都相等也算真"），前面各格一律用
         严格的那一版。不用发分支：`||` / `&&` 本来就短路。 */
      const dir = op[0] === '<' ? '<' : '>';
      const lex = (i) => {
        const av = fld(l, i);
        const bv = fld(r, i);
        if (i === tupA.length - 1) return cmpOne(op, av, bv, C);
        return {
          kind: 'binop', op: '||',
          left: cmpOne(dir, av, bv, C),
          right: {
            kind: 'binop', op: '&&',
            left: cmpOne('==', av, bv, C),
            right: lex(i + 1),
          },
        };
      };
      /* 空元组（`() < ()`）：没有一格可比，`<=` / `>=` 真、`<` / `>` 假。 */
      out = tupA.length === 0 ? { kind: 'bool', value: op.length === 2 } : lex(0);
    }
    return pre.length === 0 ? out : { kind: 'block-expr', stmts: pre, value: out };
  }
  /* 表 / 字典：方言里没有"比容器"这一族算子，现场发一趟走一遍（`seqCmp`）。 */
  const seq = seqCmp(o, op, a, b, ta, tb, C);
  if (seq !== null) return seq;
  let l = a;
  let r = b;
  if (ta.kind === 'real' && tb.kind === 'int') r = toReal(b, C);
  if (ta.kind === 'int' && tb.kind === 'real') l = toReal(a, C);
  return { kind: 'binop', op, left: l, right: r };
}

/** 两格类型能不能逐格比出个结果来（`int` 与 `real` 算能 —— `cmpOne` 会提升）。 */
const numish = (t) => t.kind === 'int' || t.kind === 'real';

/**
 * **表与字典的比较** —— 方言里没有这一族算子，落下去就是**比句柄**：
 * `[1, 2] == [1, 2]` 会静默答 False（量到过，与元组那一处同一个病）。
 * 认不出来就回 `null`，由 `cmpOne` 接着往下走。
 */
function seqCmp(o, op, a, b, ta, tb, C) {
  const eq = (x, y) => cmpOne('==', x, y, C);
  if (ta.kind === 'arr' && tb.kind === 'arr') {
    const same = sameType(ta.elem, tb.elem) || (numish(ta.elem) && numish(tb.elem));
    if (op === '==' || op === '!=') {
      /* 元素类型对不上（`[1] == ["1"]`）—— python 逐格比也是 False，编译期就能定。 */
      if (!same) return { kind: 'bool', value: op === '!=' };
      return listEqOf(a, b, C, eq, op === '!=');
    }
    if (!same) {
      throw new Error(`python->IR: 元素类型不同的两张表比 \`${o}\` 还没接`
        + '（python 逐格比到第一处不同，那一处两边类型不同会 TypeError）');
    }
    needOrd(ta.elem, C, `表上的 \`${o}\``);
    return listCmpOf(a, b, C, (x, y) => cmpOne('<', x, y, C), op);
  }
  if (ta.kind === 'map' && tb.kind === 'map') {
    if (op !== '==' && op !== '!=') {
      throw new Error(`python->IR: 字典上的 \`${o}\` —— python 里字典没有大小之分（TypeError）`);
    }
    const same = sameType(ta.key, tb.key)
      && (sameType(ta.value, tb.value) || (numish(ta.value) && numish(tb.value)));
    if (!same) return { kind: 'bool', value: op === '!=' };
    return dictEqOf(a, b, C, eq, op === '!=');
  }
  return null;
}

/** 一格 `==`（`builtins.js` 那几格"找"要它 —— 元素是箱子时按标签分派）。 */
export const cmpEq = (a, b, C) => cmpOne('==', a, b, C);

/** 一格 `<`（min / max / sort 那几格要它 —— 元组走上面那棵字典序的树）。 */
export const cmpLt = (a, b, C) => cmpOne('<', a, b, C);

/**
 * "这一格类型有没有比法" —— 排序、挑大小之前先问一声。
 * 有比法的就三类标量加**同形状的元组**；别的当场报，不然落到方言里会去比句柄，
 * 静默答错（`min([(2,'b'), (1,'a')])` 从前就答 `(2, 'b')` —— 量到过）。
 */
export function needOrd(t, C, what) {
  if (['int', 'real', 'string'].includes(t.kind)) return;
  if (tupleOf(C.recOf(t)) !== null) return;
  throw new Error(`python->IR: \`${what}\` 的元素是 ${t.kind} —— 还没接（要有"怎么比"）`);
}

/**
 * **把一格"可调用的东西"按元素铺开** —— `map` / `filter` / `key=` 共用这一条。
 *
 * 只收**编译期定得下来**的三档：
 *   1. lambda 字面量（一格形参、不带默认值）—— 体就地展开；
 *   2. 这份源码里的 `def` —— 按元素类型挑那一格单态实例，落成一句调用；
 *   3. 一格内建（`str` / `int` / `len` / `abs` …）—— 走 `builtinOf` 那条老路。
 * 真把函数装进变量再传（`f = g` 之后把 `f` 递出去）要 `(asfn …)` 那一层，还没有。
 */
function applyPer(fnTok, arg, elemTy, C) {
  if (tag(fnTok) === 'lambda') {
    const ps = kids(part(fnTok, 'params') ?? { kind: 'list', items: [] });
    if (ps.length !== 1 || tag(ps[0]) !== 'p' || part(ps[0], 'default') !== undefined) {
      throw new Error('python->IR: 这一处的 lambda 收一格形参、不带默认值');
    }
    const undo = C.alias(String(nameOf(kids(ps[0])[0])), arg.name);
    try {
      return exprOf(kids(fnTok)[1], C);
    } finally {
      undo();
    }
  }
  if (tag(fnTok) !== 'n') {
    throw new Error(`python->IR: 这一处要一格 lambda / 函数名 / 内建，给的是 ${tag(fnTok)}`);
  }
  const nm = String(nameOf(fnTok));
  if (C.insts.has(nm)) {
    const inst = C.resolveFn(nm, [elemTy]);
    if (inst === null) {
      throw new Error(`python->IR: \`${nm}(${elemTy.kind})\` 没有对得上的那一格`
        + '（单态化是按调用点收的，而这一处是按元素类型调的）');
    }
    return { kind: 'call', fn: { kind: 'name', name: inst.mangled }, args: [arg] };
  }
  return builtinOf(nm, [arg], [], C);
}

/** 上面那一条的类型侧：按元素类型问"应用一遍交什么"。 */
function applyTy(fnTok, elemTy, C) {
  if (tag(fnTok) === 'lambda') {
    const ps = kids(part(fnTok, 'params') ?? { kind: 'list', items: [] });
    if (ps.length !== 1) return null;
    const pv = C.fresh('ap_t');
    C.bind(pv, elemTy);
    const undo = C.alias(String(nameOf(kids(ps[0])[0])), pv);
    try {
      return tyOfCst(kids(fnTok)[1], C);
    } finally {
      undo();
    }
  }
  if (tag(fnTok) !== 'n') return null;
  const nm = String(nameOf(fnTok));
  if (C.insts.has(nm)) return C.resolveFn(nm, [elemTy])?.ret ?? null;
  if (nm === 'abs') return elemTy;
  return BUILTIN_RET.get(nm) ?? null;
}

/**
 * `key=` 那一格 —— 键按元素算一遍、攒成一张"键表"，排序时两张表一起挪。
 *
 * 形参那个名字用 `C.alias` 临时指到一格新名上（与推导式那一处同一条办法），
 * 发完指回去 —— 于是 `key=lambda v: …` 写在一个已经有 `v` 的函数里也不会撞。
 */
function keyListOf(src, keyTok, C) {
  const st = ty(src, C);
  if (st.kind !== 'arr') throw new Error(`python->IR: \`key=\` 的接收者要是一格表（这里是 ${st.kind}）`);
  const pre = [];
  const pv = C.fresh('ky_p');
  C.bind(pv, st.elem);
  pre.push({ kind: 'let', name: pv, type: st.elem, init: null });
  const body = applyPer(keyTok, { kind: 'name', name: pv }, st.elem, C);

  const kt = arrOf(ty(body, C));
  const kn = C.fresh('ky_o');
  C.bind(kn, kt);
  pre.push({
    kind: 'let', name: kn, type: kt,
    init: { kind: 'builtin', name: 'anew', args: [{ kind: 'type', type: kt }, { kind: 'int', value: 0 }] },
  });
  const iv0 = C.fresh('ky_i');
  C.bind(iv0, INT);
  pre.push({ kind: 'let', name: iv0, type: INT, init: { kind: 'int', value: 0 } });
  const i = { kind: 'name', name: iv0 };
  const keys = { kind: 'name', name: kn };
  pre.push({
    kind: 'while',
    cond: { kind: 'binop', op: '<', left: i, right: { kind: 'builtin', name: 'alen', args: [src] } },
    body: [
      { kind: 'assign', target: { kind: 'name', name: pv }, value: { kind: 'index', obj: src, index: i } },
      { kind: 'builtin-stmt', name: 'apush', args: [keys, body] },
      { kind: 'assign', target: i, value: { kind: 'binop', op: '+', left: i, right: { kind: 'int', value: 1 } } },
    ],
  });
  return { keys, pre };
}

/** `xs.sort(key=…)` —— **就地**排：键表算一遍，两张表一起挪（`sorted` 才抄一份）。 */
export function sortByKeyPy(box, keyTok, C, desc) {
  const got = keyListOf(box, keyTok, C);
  needOrd(ty(got.keys, C).elem, C, '.sort(key=…)');
  return [...got.pre, ...sortByKeyStmts(box, got.keys, C, desc)];
}

/**
 * 走一遍的那一格**归一成一张表** —— 串一格一个字符、字典走键（与 `for k in d` 一条）。
 * `map` / `filter` / `sorted` 都按这一条看它们的第二个实参。
 */
function iterArrOf(e, C) {
  const t = ty(e, C);
  if (t.kind === 'string') return charsOf(e, C);
  if (t.kind === 'map') return { kind: 'builtin', name: 'dkeys', args: [e] };
  return e;
}

/**
 * `map(f, xs)` / `filter(f, xs)` —— **编译期铺开成一趟循环**，交的是一张**真表**。
 *
 * python 那边交的是懒的迭代器，所以有两处说不上一样，都是明说的不足：
 *   1. `print(map(f, xs))` 在 python 里印 `<map object at 0x…>`（里头有地址），我们印一张表；
 *   2. 迭代器**只能走一遍**（`m = map(…)` 之后两次 `list(m)`，第二次是空的），我们两次都满。
 * 真代码里几乎总是 `list(map(…))` / `for v in map(…)` / `sum(map(…))` 那几种写法，
 * 那几种两边逐字节相同。
 */
function mapPy(fnTok, xsTok, C, keep = false) {
  const src0 = iterArrOf(exprOf(xsTok, C), C);
  const st = ty(src0, C);
  if (st.kind !== 'arr') {
    throw new Error(`python->IR: \`${keep ? 'filter' : 'map'}(f, xs)\` 的第二格要能走一遍`
      + `（表 / 串 / 字典），这里是 ${st.kind}`);
  }
  const pre = [];
  /* 源表先钉成一格临时量：下面那趟循环要读它两次（`alen` 与逐格取），
     而它可能是一句带副作用的话（`map(f, s.split(","))`）。 */
  const sn = C.fresh('mp_s');
  C.bind(sn, st);
  pre.push({ kind: 'let', name: sn, type: st, init: src0 });
  const src = { kind: 'name', name: sn };
  const pv = C.fresh('mp_p');
  C.bind(pv, st.elem);
  pre.push({ kind: 'let', name: pv, type: st.elem, init: null });
  const arg = { kind: 'name', name: pv };
  const applied = applyPer(fnTok, arg, st.elem, C);
  /* `filter` 交的是**原元素**（f 只管留不留），`map` 交的是算出来那一格。 */
  const outT = arrOf(keep ? st.elem : ty(applied, C));
  const on = C.fresh('mp_o');
  C.bind(on, outT);
  pre.push({
    kind: 'let', name: on, type: outT,
    init: { kind: 'builtin', name: 'anew', args: [{ kind: 'type', type: outT }, { kind: 'int', value: 0 }] },
  });
  const iv = C.fresh('mp_i');
  C.bind(iv, INT);
  pre.push({ kind: 'let', name: iv, type: INT, init: { kind: 'int', value: 0 } });
  const i = { kind: 'name', name: iv };
  const out = { kind: 'name', name: on };
  const push = { kind: 'builtin-stmt', name: 'apush', args: [out, keep ? arg : applied] };
  pre.push({
    kind: 'while',
    cond: { kind: 'binop', op: '<', left: i, right: { kind: 'builtin', name: 'alen', args: [src] } },
    body: [
      { kind: 'assign', target: arg, value: { kind: 'index', obj: src, index: i } },
      ...(keep ? [{ kind: 'if', cond: condOfExpr(applied, C), then: [push], else_: [] }] : [push]),
      { kind: 'assign', target: i, value: { kind: 'binop', op: '+', left: i, right: { kind: 'int', value: 1 } } },
    ],
  });
  return { kind: 'block-expr', stmts: pre, value: out };
}

/** `filter(None, xs)` —— 留下真值那几格（python 的 `filter(None, …)` 就这一条）。 */
function filterNonePy(xsTok, C) {
  const src0 = iterArrOf(exprOf(xsTok, C), C);
  const st = ty(src0, C);
  if (st.kind !== 'arr') throw new Error(`python->IR: \`filter(None, xs)\` 的第二格要能走一遍，这里是 ${st.kind}`);
  const pre = [];
  const sn = C.fresh('fn_s');
  C.bind(sn, st);
  pre.push({ kind: 'let', name: sn, type: st, init: src0 });
  const src = { kind: 'name', name: sn };
  const on = C.fresh('fn_o');
  C.bind(on, st);
  pre.push({
    kind: 'let', name: on, type: st,
    init: { kind: 'builtin', name: 'anew', args: [{ kind: 'type', type: st }, { kind: 'int', value: 0 }] },
  });
  const iv = C.fresh('fn_i');
  C.bind(iv, INT);
  pre.push({ kind: 'let', name: iv, type: INT, init: { kind: 'int', value: 0 } });
  const i = { kind: 'name', name: iv };
  const out = { kind: 'name', name: on };
  const cell = { kind: 'index', obj: src, index: i };
  pre.push({
    kind: 'while',
    cond: { kind: 'binop', op: '<', left: i, right: { kind: 'builtin', name: 'alen', args: [src] } },
    body: [
      {
        kind: 'if',
        cond: condOfExpr(cell, C),
        then: [{ kind: 'builtin-stmt', name: 'apush', args: [out, cell] }],
        else_: [],
      },
      { kind: 'assign', target: i, value: { kind: 'binop', op: '+', left: i, right: { kind: 'int', value: 1 } } },
    ],
  });
  return { kind: 'block-expr', stmts: pre, value: out };
}

/** `sorted(xs)` —— 先问一声"元素怎么比"，再把比法递给那趟插入排序。串按一格一个字符排。 */
function sortedPy(xsE, C, desc, keyTok = null) {
  const t0 = ty(xsE, C);
  /* `sorted(串)` 一格一个字符；**`sorted(字典)` 排的是键**（与 `for k in d` 一条）。 */
  let src = xsE;
  if (t0.kind === 'string') src = charsOf(xsE, C);
  if (t0.kind === 'map') src = { kind: 'builtin', name: 'dkeys', args: [xsE] };
  const t = ty(src, C);
  if (keyTok === null) {
    if (t.kind === 'arr') needOrd(t.elem, C, 'sorted()');
    return sortedOf(src, C, desc, (x, y) => cmpOne('<', x, y, C));
  }
  /* `key=`：先抄一份（`sorted` 不动原表），再算一张键表，两张一起挪。 */
  const pre = [];
  const outN = C.fresh('sk_o');
  C.bind(outN, t);
  pre.push({ kind: 'let', name: outN, type: t, init: copyList(src, C) });
  const out = { kind: 'name', name: outN };
  const got = keyListOf(out, keyTok, C);
  pre.push(...got.pre);
  needOrd(ty(got.keys, C).elem, C, 'sorted(key=…)');
  pre.push(...sortByKeyStmts(out, got.keys, C, desc));
  return { kind: 'block-expr', stmts: pre, value: out };
}

/**
 * **元组当序列用**：逐格摆进一张新表（`for v in t` / `list(t)` / `x in t` 走它）。
 * 逐格类型要能合成一格；合不成就当场报（异质的退到 `(arr dyn)`，逐格装箱）。
 */
export function tupleToList(box0, C) {
  const t = ty(box0, C);
  const tup = tupleOf(C.recOf(t));
  if (tup === null) throw new Error(`python->IR: \`${t.kind}\` 不是元组，摆不成表`);
  const et = unify(tup);
  if (et === null) {
    throw new Error(`python->IR: 这格元组里装着 ${[...new Set(tup.map((f) => f.kind))].join(' / ')}`
      + ' —— 合不成一张表（装不进 dyn 那格箱子的那几档，见 `dyn.js`）');
  }
  const at = arrOf(et);
  const pre = [];
  let b = box0;
  if (!isPure(box0)) {
    const bn = C.fresh('tl_t');
    C.bind(bn, t);
    pre.push({ kind: 'let', name: bn, type: t, init: box0 });
    b = { kind: 'name', name: bn };
  }
  const n = C.fresh('tl_o');
  C.bind(n, at);
  pre.push({
    kind: 'let', name: n, type: at,
    init: { kind: 'builtin', name: 'anew', args: [{ kind: 'type', type: at }, { kind: 'int', value: 0 }] },
  });
  const out = { kind: 'name', name: n };
  tup.forEach((ft, i) => {
    let v = { kind: 'field', obj: b, name: `_${i}` };
    if (isDyn(et) && !isDyn(ft)) v = boxOf(v, C);
    pre.push({ kind: 'builtin-stmt', name: 'apush', args: [out, v] });
  });
  return { kind: 'block-expr', stmts: pre, value: out };
}

/** `x in 容器` —— 字典是"有这个键"、串是"找得到这一段"、表是走一遍。 */
function containsOf(box, needle, C) {
  const t = ty(box, C);
  /* 元组：**编译期逐格展开**成一串 `==`（元组的格数与逐格类型都是编译期定的）。
     类型对不上的那一格在 python 里恒 False —— 跳过它，别发一格比不了的 `==`。 */
  const tup = tupleOf(C.recOf(t));
  if (tup !== null) {
    const nt = ty(needle, C);
    const pre = [];
    const pin = (e, et, p) => {
      if (isPure(e)) return e;
      const n = C.fresh(p);
      C.bind(n, et);
      pre.push({ kind: 'let', name: n, type: et, init: e });
      return { kind: 'name', name: n };
    };
    const b = pin(box, t, 'ti_t');
    const v = pin(needle, nt, 'ti_v');
    let out = null;
    tup.forEach((ft, i) => {
      const cmpable = isDyn(ft) || isDyn(nt) || sameType(ft, nt)
        || (['int', 'real'].includes(ft.kind) && ['int', 'real'].includes(nt.kind));
      if (!cmpable) return;
      const one = cmpOne('==', v, { kind: 'field', obj: b, name: `_${i}` }, C);
      out = out === null ? one : { kind: 'binop', op: '||', left: out, right: one };
    });
    if (out === null) out = { kind: 'bool', value: false };
    return pre.length === 0 ? out : { kind: 'block-expr', stmts: pre, value: out };
  }
  if (t.kind === 'map') return { kind: 'builtin', name: 'dhas', args: [box, needle] };
  if (t.kind === 'string') {
    return {
      kind: 'binop', op: '!=',
      left: { kind: 'builtin', name: 'sfind', args: [box, needle] },
      right: { kind: 'int', value: -1 },
    };
  }
  /* 表：方言里没有这一格，所以走一遍（比法与 `==` 同一条 —— 元素是箱子时按标签分派）。 */
  if (t.kind === 'arr') return containsList(box, needle, C, (l, r) => cmpOne('==', l, r, C));
  /* 箱子那一档多说一句：走到这儿多半是**形参退到了 dyn**（没标注、调用点又推不出来），
     而不是真想在箱子上问 `in` —— 提一句标注比只报个 kind 有用。 */
  throw new Error(`python->IR: \`in\` 作用在 ${t.kind} 上还没接（表 / 字典 / 串接了）`
    + (t.kind === 'dyn' ? '—— 形参没标注、调用点又推不出来时会退到箱子，给它一格标注' : ''));
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

/**
 * 老式的 `%` 格式化（`"%d 个" % n`）。
 *
 * python 这一族照的是 C 的 printf，而方言里那几格串算子本来就是 C 的那几个转换 ——
 * 所以这儿不自己算数字的文本，只管挑算子、补符号、补宽度（切格式串在 `percent.js`）。
 * **格式串要是编译期的字面量**：转换字母决定发哪一格算子。
 */
function percentOf(aTok, bTok, C) {
  if (tag(aTok) !== 'str' || hasFields(aTok)) {
    throw new Error('python->IR: `%` 格式化的左边要是一格串字面量'
      + '（运行期的格式串要一台运行期的格式化机器 —— 那是 CPython 的 `unicodeobject.c`）');
  }
  const parts = splitPercent(strValue(aTok));
  const need = percentArity(parts);
  const argToks = tag(bTok) === 'tuple' ? kids(bTok) : [bTok];
  if (argToks.length !== need) {
    throw new Error(`python->IR: \`%\` 格式化要 ${need} 格实参，给了 ${argToks.length}`);
  }
  const pieces = [];
  let k = 0;
  for (const p of parts) {
    if (p.lit !== undefined) { pieces.push({ kind: 'string', value: p.lit }); continue; }
    pieces.push(convPiece(p, exprOf(argToks[k], C), C));
    k += 1;
  }
  return concatPieces(pieces, C, 'pc_c');
}

/** 一格转换：算出文本，再按标志补符号与宽度。 */
function convPiece(p, v, C) {
  const pre = [];
  const keep = (e, tag0) => {
    if (isPure(e)) return e;
    const n = C.fresh(tag0);
    const t = ty(e, C);
    C.bind(n, t);
    pre.push({ kind: 'let', name: n, type: t, init: e });
    return { kind: 'name', name: n };
  };
  const num = ['d', 'i', 'f', 'e', 'g', 'x', 'X', 'o'].includes(p.conv);
  const val = num || p.flags.plus ? keep(v, 'pc_v') : v;
  let s = rawConv(p, val, C);
  /* `+` —— 非负数前面补一个加号（python 的 `"%+d" % 5` 是 `+5`）。 */
  if (p.flags.plus && num) {
    s = {
      kind: 'ternary', type: STR,
      cond: { kind: 'binop', op: '>=', left: val, right: ty(val, C).kind === 'real' ? { kind: 'real', value: 0 } : { kind: 'int', value: 0 } },
      then: { kind: 'binop', op: '+', left: { kind: 'string', value: '+' }, right: s },
      else_: s,
    };
  }
  if (p.width !== null) s = padTo(keep(s, 'pc_s'), p.width, p.flags, C);
  return pre.length === 0 ? s : { kind: 'block-expr', stmts: pre, value: s };
}

/** 转换字母 → 那一格算子（宽度与符号不在这儿）。 */
function rawConv(p, v, C) {
  const t = ty(v, C);
  const prec = p.prec;
  switch (p.conv) {
    case 's': {
      const s = pyStr(v, C);
      /* `%.3s` —— 截到前 N 个字符。 */
      if (prec === null) return s;
      const n = { kind: 'int', value: prec };
      const l = { kind: 'builtin', name: 'slen', args: [s] };
      return {
        kind: 'builtin', name: 'ssub',
        args: [s, { kind: 'int', value: 0 }, {
          kind: 'ternary', type: INT, cond: { kind: 'binop', op: '<', left: l, right: n }, then: l, else_: n,
        }],
      };
    }
    case 'r': return pyRepr(v, C);
    case 'd': case 'i':
      /* `"%d" % 2.7` 是 `2` —— 向零取整，正是方言的 `toint`。 */
      return { kind: 'builtin', name: 'tostr', args: [t.kind === 'real' ? { kind: 'builtin', name: 'toint', args: [v] } : v] };
    case 'f': return { kind: 'builtin', name: 'sfix', args: [toReal(v, C), { kind: 'int', value: prec ?? 6 }] };
    case 'e': return { kind: 'builtin', name: 'ssci', args: [toReal(v, C), { kind: 'int', value: prec ?? 6 }] };
    case 'g': return { kind: 'builtin', name: 'sgen', args: [toReal(v, C), { kind: 'int', value: prec ?? 6 }] };
    case 'x': case 'X': case 'o': {
      if (t.kind !== 'int') throw new Error(`python->IR: \`%${p.conv}\` 的实参要是 int（这里是 ${t.kind}）`);
      const b = { kind: 'builtin', name: 'sbase', args: [v, { kind: 'int', value: p.conv === 'o' ? 8 : 16 }] };
      return p.conv === 'X' ? { kind: 'builtin', name: 'supper', args: [b] } : b;
    }
    default: throw new Error(`python->IR: \`%${p.conv}\` 还没接`);
  }
}

/**
 * 补到 `width` 宽。`-` 永远补空格补在右边（python 里 `-` 压过 `0`）；
 * `0` 补零而且**补在符号后头**（`"%05d" % -12` 是 `-0012`，不是 `00-12`）。
 */
function padTo(s, width, flags, C) {
  const n = {
    kind: 'binop', op: '-', left: { kind: 'int', value: width },
    right: { kind: 'builtin', name: 'slen', args: [s] },
  };
  /* `(srep S N)` 在 N <= 0 时交空串 —— 正好是"不用补"那一档。 */
  const fill = (ch) => ({ kind: 'builtin', name: 'srep', args: [{ kind: 'string', value: ch }, n] });
  if (flags.left) return { kind: 'binop', op: '+', left: s, right: fill(' ') };
  if (!flags.zero) return { kind: 'binop', op: '+', left: fill(' '), right: s };
  const head = { kind: 'builtin', name: 'ssub', args: [s, { kind: 'int', value: 0 }, { kind: 'int', value: 1 }] };
  const tail = {
    kind: 'builtin', name: 'ssub',
    args: [s, { kind: 'int', value: 1 }, { kind: 'binop', op: '-', left: { kind: 'builtin', name: 'slen', args: [s] }, right: { kind: 'int', value: 1 } }],
  };
  return {
    kind: 'ternary', type: STR,
    cond: { kind: 'binop', op: '==', left: head, right: { kind: 'string', value: '-' } },
    then: {
      kind: 'binop', op: '+',
      left: { kind: 'binop', op: '+', left: { kind: 'string', value: '-' }, right: fill('0') },
      right: tail,
    },
    else_: { kind: 'binop', op: '+', left: fill('0'), right: s },
  };
}

/** 二元算术与位运算 —— python 的四处规矩都在这儿（见文件头 1~4）。 */
function binOf(x, C) {
  const [opTok, aTok, bTok] = kids(x);
  const o = String(leaf(opTok));
  /* **串上的 `%` 要在算右边之前拦**：`"%s=%s" % (a, b)` 的右边是一格元组，
     而这一层没有元组这一档 —— 算它会当场报"这一格表达式还没接：tuple"。 */
  if (o === '%' && tag(aTok) === 'str') return percentOf(aTok, bTok, C);
  let a = exprOf(aTok, C);
  let b = exprOf(bTok, C);
  let ta = ty(a, C);
  let tb = ty(b, C);
  /* **两边都带副作用时左边先钉住** —— python 从左到右算，而这一层把两段拼成一个表达式：
     段里带的 `block-expr` 那几句会被提到整句最前头，于是右边那一段的活儿跑在左边那一段
     的副作用之前。量到的原话：`str(ys.pop()) + " " + str(ys)` 答 `4 [3, 4]`
     （python 是 `4 [3]`）。见 `pinPiece` 上头那段账。 */
  if (!isPure(a) && !isPure(b)) {
    const pre0 = [];
    a = pinPiece(a, C, pre0, 'bl_a');
    if (pre0.length > 0) a = { kind: 'block-expr', stmts: pre0, value: a };
  }

  /* python 的 bool **就是** int 的一种（`True + True` 是 2、`True * 2` 是 2）。
     方言里那是两档类型，所以这儿现折一格 `b ? 1 : 0`。只在两边都是数或布尔时折 ——
     `True + "a"` 还是当场报（python 那儿也是 TypeError）。
     **位运算不折**：python 的 `True & True` 交的是 `True` 而不是 `1`，印出来不一样。 */
  if (!BITS.has(o) && (ta.kind === 'bool' || tb.kind === 'bool')
    && (ta.kind === 'bool' || isNum(ta)) && (tb.kind === 'bool' || isNum(tb))) {
    const asInt = (e) => ({
      kind: 'ternary', type: INT, cond: e, then: { kind: 'int', value: 1 }, else_: { kind: 'int', value: 0 },
    });
    if (ta.kind === 'bool') {
      a = asInt(a);
      ta = INT;
    }
    if (tb.kind === 'bool') {
      b = asInt(b);
      tb = INT;
    }
  }

  /* 0. 有一边是箱子：按 `(dtag …)` 两边各问一次，走 `dyn.js` 那一族。
     `//` `%` `**` 的算法（python 那三条规矩）从这儿递进去 —— 静态那一侧用的是同一份。 */
  if (isDyn(ta) || isDyn(tb)) return dynBin(o, a, b, C, DYN_ARITH(C));

  /* 1. `/` 永远是浮点。 */
  if (o === '/') return { kind: 'binop', op: '/', left: toReal(a, C), right: toReal(b, C) };
  /* 2. `//` 向下取整。 */
  if (o === '//') return floorDiv(a, b, isInt(ta) && isInt(tb), C);
  /* 3. `%` 符号跟着除数；串上的 `%` 是老式格式化。 */
  if (o === '%') {
    if (ta.kind === 'string') return percentOf(aTok, bTok, C);
    return pyMod(a, b, isInt(ta) && isInt(tb), C);
  }
  if (o === '**') {
    const p = { kind: 'rmath', fn: 'pow', args: [toReal(a, C), toReal(b, C)] };
    /* 指数是**非负的整数字面量**时交 int（python 的 `2 ** 3` 是 3 而不是 3.0）。
       `True` / `False` 也算整数字面量 —— bool 就是 int 的一种，上面刚折成 0 / 1。 */
    const boolExp = tag(bTok) === 'true' || tag(bTok) === 'false';
    const wantInt = isInt(ta) && (boolExp || (tag(bTok) === 'num'
      && numValue(leaf(kids(bTok)[0])).kind === 'int'
      && numValue(leaf(kids(bTok)[0])).value >= 0n));
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
    /* `xs + ys` —— python 里是**新造一张表**。元素合不上就两边各自装箱（`(arr dyn)`）。 */
    if (o === '+') {
      if (ta.kind !== 'arr' || tb.kind !== 'arr') {
        throw new Error(`python->IR: \`表 + ${ta.kind === 'arr' ? tb.kind : ta.kind}\``
          + ' —— python 里也不成（只有表跟表能拼）');
      }
      const et = unify([ta.elem, tb.elem]);
      if (et === null) {
        throw new Error(`python->IR: \`表 + 表\` 的元素是 ${ta.elem.kind} 与 ${tb.elem.kind}`
          + ' —— 合不成一格（装不进 dyn 那格箱子的那几档，见 `dyn.js`）');
      }
      const box = (src, e) => (isDyn(et) && !isDyn(ty(src, C).elem) ? boxOf(e, C) : e);
      return concatList(a, b, et, C, box);
    }
    /* `xs * n` / `n * xs` —— 抄 n 遍；n <= 0 给空表。 */
    if (o === '*') {
      const [xs, n] = ta.kind === 'arr' ? [a, b] : [b, a];
      if (ty(n, C).kind !== 'int') {
        throw new Error(`python->IR: \`表 * ${ty(n, C).kind}\` —— python 里乘数要是整数`);
      }
      return repeatList(xs, n, C);
    }
    throw new Error(`python->IR: 表上的 '${o}' 没有这一格（python 里只有 + 与 *）`);
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

/* ─── 推导式 ──────────────────────────────────────────────────────────────── */

/**
 * 推导式的从句拆成几组：每一格 `for` 带上**跟在它后头**的那几个 `if`。
 * `[e for x in xs if p for y in ys if q]` → `[{x, xs, [p]}, {y, ys, [q]}]`。
 */
function compGroups(clauses) {
  if (clauses.length === 0 || tag(clauses[0]) !== 'for') {
    throw new Error('python->IR: 推导式的第一条从句要是 `for`');
  }
  const gs = [];
  for (const c of clauses) {
    if (tag(c) === 'afor') throw new Error('python->IR: 推导式里的 `async for` 还没接');
    if (tag(c) === 'for') gs.push({ target: kids(c)[0], iter: kids(c)[1], ifs: [] });
    else gs[gs.length - 1].ifs.push(kids(c)[0]);
  }
  return gs;
}

/** 推导式里一格可迭代交出来的元素类型（`range(…)` 出 int，表出元素，串出串，字典出键）。 */
function compElem(it, C) {
  if (tag(it) === 'call' && tag(kids(it)[0]) === 'n'
    && String(nameOf(kids(it)[0])) === 'range') return INT;
  const t = tyOfCst(it, C);
  if (t === null) return null;
  if (t.kind === 'arr') return t.elem;
  if (t.kind === 'string') return STR;
  if (t.kind === 'map') return t.key;
  /* 元组：逐格合成一格（`for v in (1, 2, 3)` 与 `[e for v in t]` 同一条）。 */
  const tup = tupleOf(C.recOf(t));
  if (tup !== null) return unify(tup);
  return null;
}

/**
 * 推导式里 `for a, b in …` 那一格：只认 `enumerate(xs[, start])` / `zip(a, b)` /
 * `d.items()` 三种 —— 与 `for` 语句那一侧（`index.js` 的 `pairIter`）同一份名单。
 *
 * 为什么只认这三种：python 里它们交的是**一串元组**，而这一层没有元组那一档；
 * 可这三种落下去都只是"一趟下标循环"，所以不必先有元组。
 */
function compPair(it, C) {
  if (tag(it) !== 'call') return null;
  const callee = kids(it)[0];
  const as = kids(part(it, 'args') ?? { kind: 'list', items: [] });
  if (tag(callee) === 'attr') {
    if (String(nameOf(kids(callee)[1])) !== 'items' || as.length !== 0) return null;
    const dt = tyOfCst(kids(callee)[0], C);
    if (dt === null || dt.kind !== 'map') return null;
    return { fn: 'items', args: [kids(callee)[0]], t0: dt.key, t1: dt.value };
  }
  if (tag(callee) !== 'n') return null;
  const fn = String(nameOf(callee));
  if (fn === 'enumerate' && (as.length === 1 || as.length === 2)) {
    const et = compElem(as[0], C);
    return et === null ? null : { fn, args: as, t0: INT, t1: et };
  }
  if (fn === 'zip' && as.length === 2) {
    const a = compElem(as[0], C);
    const b = compElem(as[1], C);
    return a === null || b === null ? null : { fn, args: as, t0: a, t1: b };
  }
  return null;
}

/**
 * 每一格目标**改名**成一格新名并登记类型；回的是"全指回去"那个函数。
 *
 * 为什么要改名：python 3 里推导式有自己的作用域 —— 里头那个 `x` 与外头同名的那一格
 * 不是一件事，也不漏出去。改名之后这两条自然都对，`[x for x in xs]` 写在一个已经有
 * `x` 的函数里也不会撞（那时同名的两格会被合成 dyn，是个真会答错的地方）。
 *
 * 次序要紧：后一格 `for` 的可迭代可能用到前一格的目标（`for row in grid for c in row`），
 * 所以是"绑一格、再问下一格的类型"。
 */
function compBind(gs, C) {
  const undo = [];
  const back = () => { for (let i = undo.length - 1; i >= 0; i -= 1) undo[i](); };
  const one = (tok, t) => {
    const nm = C.fresh('cp_');
    undo.push(C.alias(String(nameOf(tok)), nm));
    C.bind(nm, t);
    return nm;
  };
  try {
    for (const g of gs) {
      if (tag(g.target) === 'tuple') {
        const ts = kids(g.target);
        if (ts.some((t) => tag(t) !== 'n')) {
          throw new Error('python->IR: 推导式的目标要是名字（嵌套的拆包还没接）');
        }
        /* **N 格目标**：可迭代的元素是一格 N 格的元组（`zip(a, b, c)` 交的就是它）。
           走法是"按一格元素走，体开头逐格取字段" —— 所以这儿只多记一张拆包表，
           循环那一侧（`compLoop`）照着摆几句赋值。两格那一档仍走下面的专路（省一张中间表）。 */
        const et0 = compElem(g.iter, C);
        const tupN = tupleOf(C.recOf(et0));
        if (tupN !== null && tupN.length === ts.length) {
          g.elemT = et0;
          g.name = C.fresh('cp_t');
          C.bind(g.name, et0);
          g.unpack = ts.map((t, k) => ({ nm: one(t, tupN[k]), t: tupN[k] }));
          continue;
        }
        if (ts.length !== 2) {
          throw new Error('python->IR: 推导式的目标收一格名字、两格名字，'
            + '或者与一串 N 格元组对上的 N 格名字'
            + '（`for a, b in enumerate(xs) / zip(a, b) / d.items()`）');
        }
        const p = compPair(g.iter, C);
        if (p === null) {
          throw new Error('python->IR: 推导式里 `for a, b in …` 只认 '
            + '`enumerate(xs)` / `zip(a, b)` / `d.items()` 三种');
        }
        g.pair = p;
        g.elemT = p.t0;
        g.elemT1 = p.t1;
        g.name = one(ts[0], p.t0);
        g.name1 = one(ts[1], p.t1);
        continue;
      }
      if (tag(g.target) !== 'n') {
        throw new Error(`python->IR: 推导式的目标是 \`${tag(g.target)}\` —— 拆包还没接`);
      }
      const py = String(nameOf(g.target));
      const et = compElem(g.iter, C);
      if (et === null) {
        throw new Error(`python->IR: 推导式里 \`for ${py} in …\` 的可迭代推不出元素类型`);
      }
      g.elemT = et;
      g.name = one(g.target, et);
    }
  } catch (e) {
    back();
    throw e;
  }
  return back;
}

/** 推导式里那一格可迭代 —— `range(…)` 当值用没接，所以在这儿单拦一手。 */
function compIter(it, C) {
  if (tag(it) === 'call' && tag(kids(it)[0]) === 'n'
    && String(nameOf(kids(it)[0])) === 'range') return rangeListOf(it, C);
  const e = exprOf(it, C);
  /* 元组：逐格摆进一张表再走（与 `for` 语句那一侧同一条）。 */
  return tupleOf(C.recOf(ty(e, C))) !== null ? tupleToList(e, C) : e;
}

/**
 * 一格 `for` 从句落成一趟下标循环，`body` 摆在体里。
 *
 * 可迭代先落一格临时量（python 只算一次）。**那一格 `let` 摆在语句里而不是提到函数头上**：
 * 嵌套的时候里层那一格的初值用到外层的目标（`for c in row`），提出去就读到还没赋的值。
 * 字典先转键表（`dkeys`）—— 与 `for k in d` 同一条。
 */
function compLoop(g, body, C) {
  if (g.pair !== undefined) return compPairLoop(g, body, C);
  const it = compIter(g.iter, C);
  const t0 = ty(it, C);
  const init = t0.kind === 'map' ? { kind: 'builtin', name: 'dkeys', args: [it] } : it;
  const st = t0.kind === 'map' ? arrOf(t0.key) : t0;
  const src = C.fresh('cp_src');
  const i = C.fresh('cp_i');
  C.bind(src, st);
  C.bind(i, INT);
  const sv = { kind: 'name', name: src };
  const iv = { kind: 'name', name: i };
  const at = st.kind === 'string'
    ? { kind: 'builtin', name: 'ssub', args: [sv, iv, { kind: 'int', value: 1 }] }
    : { kind: 'index', obj: sv, index: iv };
  /* N 格目标：体开头把 `_0` … `_{n-1}` 逐格取出来（`compBind` 记下的那张拆包表）。 */
  const ups = g.unpack === undefined ? [] : g.unpack;
  return [
    { kind: 'let', name: g.name, type: g.elemT, init: null },
    ...ups.map((u) => ({ kind: 'let', name: u.nm, type: u.t, init: null })),
    { kind: 'let', name: src, type: st, init },
    {
      kind: 'for',
      init: { kind: 'let', name: i, type: INT, init: { kind: 'int', value: 0 } },
      cond: { kind: 'binop', op: '<', left: iv, right: lenOf(sv, C) },
      post: {
        kind: 'assign', target: iv,
        value: { kind: 'binop', op: '+', left: iv, right: { kind: 'int', value: 1 } },
      },
      body: [
        { kind: 'assign', target: { kind: 'name', name: g.name }, value: at },
        ...ups.map((u, k) => ({
          kind: 'assign',
          target: { kind: 'name', name: u.nm },
          value: { kind: 'field', obj: { kind: 'name', name: g.name }, name: `_${k}` },
        })),
        ...body,
      ],
    },
  ];
}

/**
 * `for a, b in enumerate(xs) / zip(a, b) / d.items()` 那一格 —— 同样是一趟下标循环，
 * 体开头把两格目标各算一次。与 `index.js` 的 `pairFor` 同一条口径：
 * `zip` 走到短的那一张为止，`enumerate(xs, start)` 的第一格是 `下标 + start`。
 */
function compPairLoop(g, body, C) {
  const p = g.pair;
  const i = C.fresh('cp_i');
  C.bind(i, INT);
  const iv = { kind: 'name', name: i };
  const pre = [
    { kind: 'let', name: g.name, type: g.elemT, init: null },
    { kind: 'let', name: g.name1, type: g.elemT1, init: null },
  ];
  /** 一格可迭代落成临时量（只算一次），回 `{v, t}`。 */
  const keep = (tok, prefix) => {
    const e = compIter(tok, C);
    const t = ty(e, C);
    const n = C.fresh(prefix);
    C.bind(n, t);
    pre.push({ kind: 'let', name: n, type: t, init: e });
    return { v: { kind: 'name', name: n }, t };
  };
  const at = (s) => (s.t.kind === 'string'
    ? { kind: 'builtin', name: 'ssub', args: [s.v, iv, { kind: 'int', value: 1 }] }
    : { kind: 'index', obj: s.v, index: iv });
  let cond;
  let first;
  let second;
  if (p.fn === 'enumerate') {
    const s = keep(p.args[0], 'cp_src');
    const start = p.args.length === 2 ? exprOf(p.args[1], C) : { kind: 'int', value: 0 };
    cond = { kind: 'binop', op: '<', left: iv, right: lenOf(s.v, C) };
    first = start.kind === 'int' && Number(start.value) === 0
      ? iv
      : { kind: 'binop', op: '+', left: iv, right: start };
    second = at(s);
  } else if (p.fn === 'zip') {
    const a = keep(p.args[0], 'cp_za');
    const b = keep(p.args[1], 'cp_zb');
    const la = lenOf(a.v, C);
    const lb = lenOf(b.v, C);
    cond = {
      kind: 'binop', op: '<', left: iv,
      right: {
        kind: 'ternary', type: INT,
        cond: { kind: 'binop', op: '<', left: la, right: lb }, then: la, else_: lb,
      },
    };
    first = at(a);
    second = at(b);
  } else {
    const d = keep(p.args[0], 'cp_d');
    const ksn = C.fresh('cp_ks');
    const kt = arrOf(p.t0);
    C.bind(ksn, kt);
    pre.push({
      kind: 'let', name: ksn, type: kt,
      init: { kind: 'builtin', name: 'dkeys', args: [d.v] },
    });
    const ksv = { kind: 'name', name: ksn };
    cond = {
      kind: 'binop', op: '<', left: iv,
      right: { kind: 'builtin', name: 'alen', args: [ksv] },
    };
    first = { kind: 'index', obj: ksv, index: iv };
    second = { kind: 'builtin', name: 'dget', args: [d.v, first] };
  }
  return [...pre, {
    kind: 'for',
    init: { kind: 'let', name: i, type: INT, init: { kind: 'int', value: 0 } },
    cond,
    post: {
      kind: 'assign', target: iv,
      value: { kind: 'binop', op: '+', left: iv, right: { kind: 'int', value: 1 } },
    },
    body: [
      { kind: 'assign', target: { kind: 'name', name: g.name }, value: first },
      { kind: 'assign', target: { kind: 'name', name: g.name1 }, value: second },
      ...body,
    ],
  }];
}

/**
 * `[e for x in xs if p]`（listcomp）/ `(e for x in xs)`（genexp）/ `{k: v for …}`（dictcomp）
 * —— **现场发一趟循环**，方言一格新算子都不加（`anew`/`apush`/`dnew`/`dset` 就够）。
 * 与 `builtins.js` 里那几格同一条办法。
 *
 * **明说的不足**：生成器表达式当成"立刻算完的一张表"（python 是懒的）。差别只在两处
 * 露头 —— 无穷的生成器（我们会挂住）与副作用的次序；`sum(x * x for x in xs)` 这类
 * 用法两边一样。`[*i for i in xs]`（PEP 798）与集合推导式没接。
 */
function compOf(x, C, kind) {
  const nvals = kind === 'dict' ? 2 : 1;
  const ks = kids(x);
  for (const v of ks.slice(0, nvals)) {
    if (tag(v) === 'star' || tag(v) === 'starstar') {
      throw new Error('python->IR: 推导式的元素位上的 `*` / `**` 展开还没接');
    }
  }
  const gs = compGroups(ks.slice(nvals));
  const on = C.fresh(kind === 'dict' ? 'cp_dout' : 'cp_lout');
  const out = { kind: 'name', name: on };
  let outT;
  let body;
  /* **推导式自己一层作用域**。不单开一层的症状（量出来的）：模块级那张表
     `C.globals` 是按 **python 的名字**存的（`lookup` 的兜底那一句用的是原名），
     而改名之后循环变量的名字只在 `ref` 里换了 —— 于是 `ys = [x * 2 for x in xs]`
     写在模块级时 `x` 查不到，整条推导式的类型答 null，`ys` 那格全局就没声明。 */
  C.push();
  const back = compBind(gs, C);
  try {
    /* 元素表达式**只建一次**，摆到最里头那一层的体里（它自己的 `let` 跟着进那一层的
       语句槽 —— `lowerStmt` 给每条语句各开一格槽，所以不会被提到循环外头去）。 */
    const vals = ks.slice(0, nvals).map((v) => exprOf(v, C));
    outT = kind === 'dict'
      ? dictOf(ty(vals[1], C), ty(vals[0], C))
      : arrOf(ty(vals[0], C));
    body = kind === 'dict'
      ? [{ kind: 'builtin-stmt', name: 'dset', args: [out, vals[0], vals[1]] }]
      : [{ kind: 'builtin-stmt', name: 'apush', args: [out, vals[0]] }];
    /* 从里往外包：那一格 `for` 的几个 `if` 包在它的体里头。 */
    for (let gi = gs.length - 1; gi >= 0; gi -= 1) {
      for (let j = gs[gi].ifs.length - 1; j >= 0; j -= 1) {
        body = [{ kind: 'if', cond: condOf(gs[gi].ifs[j], C), then: body, else_: null }];
      }
      body = compLoop(gs[gi], body, C);
    }
  } finally {
    back();
    C.pop();
  }
  /* 交出来那一格要绑在**外层**：调用方（`writeTo` 那一族）接着还要问它的类型。 */
  C.bind(on, outT);
  return {
    kind: 'block-expr',
    stmts: [
      {
        kind: 'let', name: on, type: outT,
        init: kind === 'dict'
          ? { kind: 'builtin', name: 'dnew', args: [tyArg(outT)] }
          : { kind: 'builtin', name: 'anew', args: [tyArg(outT), { kind: 'int', value: 0 }] },
      },
      ...body,
    ],
    value: out,
  };
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
  /* 元组：格数在**编译期**就定了（形状的一部分），所以这是一格常量。 */
  const tup = tupleOf(C.recOf(t));
  if (tup !== null) return { kind: 'int', value: tup.length };
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

/* ─── 元组 ────────────────────────────────────────────────────────────────── */

/** 一格类型的短名字（元组按形状生成记录，名字里要有它）。 */
function shapeKey(t) {
  switch (t.kind) {
    case 'arr': return `a${shapeKey(t.elem)}`;
    case 'map': return `m${shapeKey(t.key)}${shapeKey(t.value)}`;
    case 'named': return `n${t.name}`;
    default: return t.kind;
  }
}

/**
 * 元组：**按形状生成一格记录**（`Tup2_int_string`，字段 `_0` / `_1`）。
 *
 * 为什么落成记录而不给标准 IR 加一档"元组"：元组就是**定长、逐格各有自己类型**的东西，
 * 那正是记录 —— 而记录这一档从声明、字段读写到四条腿都早就通了。
 *
 * 字段名用 `_0` / `_1`：方言的字段是**名字**不是下标，所以 `t[0]` 里那个下标
 * **要写成字面量**（python 代码里几乎总是）。
 *
 * 引用语义（`cnew`）而不是值语义：python 的元组不可改，"是不是同一份存储"观察不到；
 * 而引用那一档 adapter 里已经有整套（类走的就是它）。
 */
export function tupleRec(elems, C) {
  const nm = `Tup${elems.length}_${elems.map(shapeKey).join('_')}`;
  if (!C.records.has(nm)) {
    C.records.set(nm, {
      name: nm,
      type: named(C.ref(nm), true),
      fields: elems.map((t, i) => ({ name: `_${i}`, type: t })),
      methods: new Map(),
      annots: [],
      tuple: elems,
    });
  }
  return C.records.get(nm);
}

/** 这一格记录是元组生成出来的吗（`print` 那一侧要按元组印）。 */
export const tupleOf = (rec) => (rec !== null && rec.tuple !== undefined ? rec.tuple : null);

/** `(a, b)` —— 造一格那个形状的记录，字段逐格填上。 */
function tupleLit(x, C) {
  const items = kids(x);
  if (items.length === 0) {
    throw new Error('python->IR: 空元组 `()` 还没接（记录得有至少一格字段）');
  }
  for (const it of items) {
    if (tag(it) === 'star') throw new Error('python->IR: 元组里的 `*` 展开还没接');
  }
  const vals = items.map((it) => exprOf(it, C));
  const rec = tupleRec(vals.map((v) => ty(v, C)), C);
  return {
    kind: 'new-record', type: rec.type, ref: true,
    fields: vals.map((v, i) => ({ name: `_${i}`, value: v })),
  };
}

/** `t[0]` —— 元组的下标**要写成字面量**（字段是名字，编译期就得知道是哪一格）。 */
function tupleAt(box, idxTok, rec, C) {
  const n = rec.tuple.length;
  const v = exprOf(idxTok, C);
  if (v.kind !== 'int') {
    throw new Error('python->IR: 元组的下标要写成一格整数字面量 —— '
      + '元组逐格各有自己的类型，是哪一格得在编译期知道');
  }
  let at = Number(v.value);
  if (at < 0) at += n;
  if (at < 0 || at >= n) {
    throw new Error(`python->IR: 元组只有 ${n} 格，下标 ${v.value} 越界`);
  }
  return { kind: 'field', obj: box, name: `_${at}` };
}

/**
 * `s.partition(sep)` / `s.rpartition(sep)` —— 交**三格的元组**：分隔符前、分隔符本身、
 * 分隔符后。找不到的时候两边站的位置不一样：`partition` 交 `(s, "", "")`，
 * `rpartition` 交 `("", "", s)` —— 量出来的，别照着"对称"猜。
 */
function partitionOf(s0, sep0, C, fromRight) {
  if (sep0.kind === 'string' && String(sep0.value) === '') {
    throw new Error('python->IR: `.partition("")` 空分隔符在 python 里是 ValueError');
  }
  const pre = [];
  const pin = (e, t, p) => {
    if (isPure(e)) return e;
    const n = C.fresh(p);
    C.bind(n, t);
    pre.push({ kind: 'let', name: n, type: t, init: e });
    return { kind: 'name', name: n };
  };
  const s = pin(s0, STR, 'pt_s');
  const sep = pin(sep0, STR, 'pt_d');
  const atN = C.fresh('pt_at');
  C.bind(atN, INT);
  const at = { kind: 'name', name: atN };
  pre.push({
    kind: 'let',
    name: atN,
    type: INT,
    init: fromRight ? rfindOf(s, sep, C) : { kind: 'builtin', name: 'sfind', args: [s, sep] },
  });
  const rec = tupleRec([STR, STR, STR], C);
  const empty = { kind: 'string', value: '' };
  /* 三格先各落一格临时量、再发一句 `if` —— **不用三元**：这一层的三元两支都会算，
     找不到的时候 `ssub(s, 0, -1)` 会当场炸（量到过：`"abc".partition("-")`）。 */
  const slot = (p) => {
    const n = C.fresh(p);
    C.bind(n, STR);
    pre.push({ kind: 'let', name: n, type: STR, init: empty });
    return { kind: 'name', name: n };
  };
  const p0 = slot('pt_0');
  const p1 = slot('pt_1');
  const p2 = slot('pt_2');
  const ls = { kind: 'builtin', name: 'slen', args: [s] };
  const after = { kind: 'binop', op: '+', left: at, right: { kind: 'builtin', name: 'slen', args: [sep] } };
  pre.push({
    kind: 'if',
    cond: { kind: 'binop', op: '<', left: at, right: { kind: 'int', value: 0 } },
    then: [{ kind: 'assign', target: fromRight ? p2 : p0, value: s }],
    else_: [
      { kind: 'assign', target: p0, value: { kind: 'builtin', name: 'ssub', args: [s, { kind: 'int', value: 0 }, at] } },
      { kind: 'assign', target: p1, value: sep },
      {
        kind: 'assign',
        target: p2,
        value: { kind: 'builtin', name: 'ssub', args: [s, after, { kind: 'binop', op: '-', left: ls, right: after }] },
      },
    ],
  });
  return {
    kind: 'block-expr',
    stmts: pre,
    value: {
      kind: 'new-record', type: rec.type, ref: true,
      fields: [p0, p1, p2].map((v, i) => ({ name: `_${i}`, value: v })),
    },
  };
}

/**
 * `"…{}…".format(a, b)` —— 模板**要是一格串字面量**：替换字段得在编译期拆开
 * （每一格的格式说明各是一套代码，与 f-string 同一条口径）。
 *
 * 认的写法：`{}`（顺着数）、`{0}`（指名第几格）、`{!r}` / `{!s}`、`{:说明}`、
 * `{{` / `}}` 是转义。格式说明那一套微语言直接借 f-string 那一份（`fmtSpec`）——
 * 两处本来就是同一套规矩，各写一遍必然对不上。
 */
function formatOf(tmpl, args, C) {
  const out = [];
  let auto = 0;
  let lit = '';
  let i = 0;
  const flush = () => {
    if (lit !== '') {
      out.push({ kind: 'string', value: lit });
      lit = '';
    }
  };
  while (i < tmpl.length) {
    const ch = tmpl[i];
    if ((ch === '{' || ch === '}') && tmpl[i + 1] === ch) {
      lit += ch;
      i += 2;
    } else if (ch === '}') {
      throw new Error('python->IR: `.format()` 的模板里有个落单的 `}`（要转义写 `}}`）');
    } else if (ch !== '{') {
      lit += ch;
      i += 1;
    } else {
      const end = tmpl.indexOf('}', i);
      if (end < 0) throw new Error('python->IR: `.format()` 的模板里 `{` 没有配对的 `}`');
      const field = tmpl.slice(i + 1, end);
      i = end + 1;
      flush();
      /* 一格字段拆成 `名字 ! 转换 : 说明` 三截。 */
      const ci = field.indexOf(':');
      const head = ci < 0 ? field : field.slice(0, ci);
      const spec = ci < 0 ? '' : field.slice(ci + 1);
      const bi = head.indexOf('!');
      const who = bi < 0 ? head : head.slice(0, bi);
      const conv = bi < 0 ? '' : head.slice(bi + 1);
      let at;
      if (who === '') {
        at = auto;
        auto += 1;
      } else if (/^\d+$/.test(who)) {
        at = Number(who);
      } else {
        throw new Error(`python->IR: \`.format()\` 的 \`{${who}}\` 还没接`
          + '（接了的是 `{}` 与 `{0}`；按名字取要命名实参那一档）');
      }
      if (at >= args.length) {
        throw new Error(`python->IR: \`.format()\` 要第 ${at} 格实参，可只给了 ${args.length} 格`);
      }
      const v = args[at];
      if (conv !== '' && conv !== 'r' && conv !== 's') {
        throw new Error(`python->IR: \`.format()\` 的 \`!${conv}\` 还没接（接了 !r 与 !s）`);
      }
      /* `!r` 先转成串再按说明摆；没有转换时说明直接作用在值上（数要按数摆）。 */
      const base = conv === 'r' ? pyRepr(v, C) : v;
      out.push(spec === '' ? pyStr(base, C) : fmtSpec(base, spec, C));
    }
  }
  flush();
  return concatPieces(out, C, 'ft_c');
}

/**
 * 切元组要取的**下标清单** —— 编译期就得算出来（交出来的形状由它定）。
 * 三个边界都要是整数字面量；拿不准就回 `null`（`strict` 时当场报）。
 * 算法照 python 自己那套 `slice.indices`：负的加长度再夹住，而**步长为负时两头的夹法
 * 与正的不一样** —— 照抄，别猜。
 */
function tupleSlicePick(n, parts, C, strict) {
  const lit = (at, what) => {
    const tok = parts[at];
    if (tok === undefined || tag(tok) === null) return null;
    const v = exprOf(tok, C);
    if (v.kind !== 'int') {
      if (!strict) return undefined;
      throw new Error(`python->IR: 切元组的${what}要写成一格整数字面量 ——`
        + ' 交出来的形状（几格、逐格什么类型）得在编译期定');
    }
    return Number(v.value);
  };
  const start = lit(0, '起点');
  const stop = lit(1, '终点');
  const step = lit(2, '步长');
  if (start === undefined || stop === undefined || step === undefined) return null;
  if (step === 0) {
    if (!strict) return null;
    throw new Error('python->IR: 切片的步长不能是 0');
  }
  const st = step === null ? 1 : step;
  const pick = [];
  if (st > 0) {
    let lo = start === null ? 0 : (start < 0 ? Math.max(0, start + n) : Math.min(start, n));
    const hi = stop === null ? n : (stop < 0 ? Math.max(0, stop + n) : Math.min(stop, n));
    for (; lo < hi; lo += st) pick.push(lo);
  } else {
    const clamp = (v) => (v < 0 ? (v + n < 0 ? -1 : v + n) : Math.min(v, n - 1));
    let lo = start === null ? n - 1 : clamp(start);
    const hi = stop === null ? -1 : clamp(stop);
    for (; lo > hi; lo += st) if (lo >= 0) pick.push(lo);
  }
  return pick;
}

/** `t[a:b:c]` —— **切元组是编译期的事**：按下标清单造一格新形状的记录。 */
function tupleSlice(box, sliceTok, rec, C) {
  const pick = tupleSlicePick(rec.tuple.length, kids(sliceTok), C, true);
  if (pick.length === 0) {
    throw new Error('python->IR: 这一刀切出来是空元组 `()` —— 还没接（记录得有至少一格字段）');
  }
  const pre = [];
  let b = box;
  if (!isPure(box)) {
    const nm2 = C.fresh('ts_t');
    const bt = ty(box, C);
    C.bind(nm2, bt);
    pre.push({ kind: 'let', name: nm2, type: bt, init: box });
    b = { kind: 'name', name: nm2 };
  }
  const out = tupleRec(pick.map((at) => rec.tuple[at]), C);
  const value = {
    kind: 'new-record', type: out.type, ref: true,
    fields: pick.map((at, k) => ({ name: `_${k}`, value: { kind: 'field', obj: b, name: `_${at}` } })),
  };
  return pre.length === 0 ? value : { kind: 'block-expr', stmts: pre, value };
}

/**
 * `d.popitem()` —— 拿掉**最后进来的**那一对并交出来（python 3.7 起是 LIFO，不是随便挑
 * 一格）。`dkeys` 交的是插入序，所以"最后一格键"就是它。空字典是 KeyError。
 */
function popItemOf(box0, C) {
  const t = ty(box0, C);
  const rec = tupleRec([t.key, t.value], C);
  const pre = [];
  const pin = (e, et, p) => {
    if (isPure(e)) return e;
    const n = C.fresh(p);
    C.bind(n, et);
    pre.push({ kind: 'let', name: n, type: et, init: e });
    return { kind: 'name', name: n };
  };
  const d = pin(box0, t, 'pi_d');
  const kt = arrOf(t.key);
  const ksn = C.fresh('pi_ks');
  C.bind(ksn, kt);
  pre.push({ kind: 'let', name: ksn, type: kt, init: { kind: 'builtin', name: 'dkeys', args: [d] } });
  const ks = { kind: 'name', name: ksn };
  pre.push({
    kind: 'if',
    cond: { kind: 'binop', op: '==', left: { kind: 'builtin', name: 'alen', args: [ks] }, right: { kind: 'int', value: 0 } },
    then: [{ kind: 'builtin-stmt', name: 'fail', args: [{ kind: 'string', value: "popitem(): dictionary is empty" }] }],
    else_: null,
  });
  const kn = C.fresh('pi_k');
  C.bind(kn, t.key);
  pre.push({
    kind: 'let',
    name: kn,
    type: t.key,
    init: {
      kind: 'index',
      obj: ks,
      index: {
        kind: 'binop', op: '-',
        left: { kind: 'builtin', name: 'alen', args: [ks] },
        right: { kind: 'int', value: 1 },
      },
    },
  });
  const k = { kind: 'name', name: kn };
  const vn = C.fresh('pi_v');
  C.bind(vn, t.value);
  pre.push({ kind: 'let', name: vn, type: t.value, init: { kind: 'builtin', name: 'dget', args: [d, k] } });
  const v = { kind: 'name', name: vn };
  pre.push({ kind: 'expr-stmt', expr: { kind: 'builtin', name: 'ddel', args: [d, k] } });
  return {
    kind: 'block-expr',
    stmts: pre,
    value: {
      kind: 'new-record', type: rec.type, ref: true,
      fields: [k, v].map((x, i) => ({ name: `_${i}`, value: x })),
    },
  };
}

/** `xs[i]` / `d[k]` / `s[i]` / `xs[a:b]` / `s[a:b]`。 */
function indexOf(x, C) {
  const box = exprOf(kids(x)[0], C);
  const subs = kids(part(x, 'subs') ?? { kind: 'list', items: [] });
  if (subs.length !== 1) throw new Error('python->IR: 多维下标（`a[i, j]`）还没接');
  const t = ty(box, C);
  const tup = tupleOf(C.recOf(t));
  if (tup !== null) {
    if (tag(subs[0]) === 'slice') return tupleSlice(box, subs[0], C.recOf(t), C);
    return tupleAt(box, subs[0], C.recOf(t), C);
  }
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
  const t = ty(box, C);
  if (t.kind !== 'string' && t.kind !== 'arr') throw new Error(`python->IR: 切 ${t.kind} 还没接`);
  /* 步长那一格**要写成字面量**（与 `range(a, b, step)` 同一条理由：往上走还是往下走
     得在编译期知道，收运行期的值就要发两条循环）。`s[::-1]` 是最常见的那一格。 */
  let step = 1;
  if (parts.length > 2 && parts[2] !== undefined && tag(parts[2]) !== null) {
    const sv = exprOf(parts[2], C);
    if (sv.kind !== 'int' || sv.value === 0n) {
      throw new Error('python->IR: 切片的步长要是一格非零整数字面量 —— '
        + '不然"往上还是往下"只有跑起来才知道（那要两条循环）');
    }
    step = Number(sv.value);
  }

  const pre = [];
  const keep = (e, p, kty = INT) => {
    if (isPure(e)) return e;
    const n = C.fresh(p);
    C.bind(n, kty);
    pre.push({ kind: 'let', name: n, type: kty, init: e });
    return { kind: 'name', name: n };
  };
  /* **先把被切的那一格钉住**：下面要读它好几遍（长度、逐格取），而它自己可能是个
     block-expr（表字面量就是），重复发一遍就把里头那格 `let` 发了两次。
     量到的原话：`[1, 2, 3, 4][::2]` 报 "'list81' 在这一层已经声明过了"。 */
  const src = keep(box, 'sl_x', t);
  const hi = keep(lenOf(src, C), 'sl_len');
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
    : clamp(wrapIndex(src, exprOf(parts[0], C), C), 'sl_a'), 'sl_from');
  const to = keep(parts[1] === undefined || tag(parts[1]) === null
    ? hi
    : clamp(wrapIndex(src, exprOf(parts[1], C), C), 'sl_b'), 'sl_to');
  /** `max(0, to - from)`。 */
  const count = {
    kind: 'ternary', type: INT,
    cond: { kind: 'binop', op: '>', left: to, right: from },
    then: { kind: 'binop', op: '-', left: to, right: from },
    else_: { kind: 'int', value: 0 },
  };

  /* 步长不是 1 —— 走一趟循环（`builtins.js` 的 `stepSlice`）。
     负步长这一格**只收两头都省掉的写法**（`s[::-1]` / `xs[::-2]`）：python 里负步长的
     默认两头是反过来的（从 len-1 走到 -1），而带了显式两头之后还要另一套夹法
     （`s[5:-10:-1]` 那一族），猜一个会静默给出错的一段。 */
  if (step !== 1) {
    const isStr = t.kind === 'string';
    const given = (k) => parts[k] !== undefined && tag(parts[k]) !== null;
    if (step < 0) {
      if (given(0) || given(1)) {
        throw new Error('python->IR: 负步长的切片只接两头都省掉的写法（`s[::-1]`）—— '
          + '带显式两头的那一族（`s[5:1:-1]`）还没接');
      }
      const start = { kind: 'binop', op: '-', left: hi, right: { kind: 'int', value: 1 } };
      const down = stepSlice(src, start, { kind: 'int', value: 0 }, step, isStr, C);
      return pre.length === 0 ? down : { kind: 'block-expr', stmts: pre, value: down };
    }
    const up = stepSlice(src, from, to, step, isStr, C);
    return pre.length === 0 ? up : { kind: 'block-expr', stmts: pre, value: up };
  }

  if (t.kind === 'string') {
    const value = { kind: 'builtin', name: 'ssub', args: [src, from, count] };
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
            args: [{ kind: 'name', name: out }, { kind: 'index', obj: src, index: { kind: 'name', name: i } }],
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

/**
 * 两格同型的值里挑一格（`min` / `max`）—— 不纯的先落一格临时量。
 * `cmp` 递进来就用它当"挑左边那格"的条件（元组要按字典序比）；不递就是方言的那格算子。
 */
function pickOf(a, b, op, C, cmp = null) {
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
    cond: cmp === null ? { kind: 'binop', op, left: l, right: r } : cmp(l, r),
    then: l, else_: r,
  };
  return pre.length === 0 ? value : { kind: 'block-expr', stmts: pre, value };
}

/**
 * 调用点认出被调的那棵 `def`，交它的**形参名字与默认值**（原文树）。
 * 认不出来（内建、箱子里的函数、别处来的）回 `null`。
 */
function calleeSig(fn, C) {
  let key = null;
  let label = null;
  if (tag(fn) === 'n') {
    const nm = String(nameOf(fn));
    label = nm;
    key = C.records.has(nm) ? `${nm}.__init__` : nm;
  } else if (tag(fn) === 'attr') {
    /* `recv.m(…)` —— 接收者装的是哪个类，就查那个类的那格方法。 */
    const rt = tyOfCst(kids(fn)[0], C);
    if (rt === null || rt === undefined || rt.kind !== 'named') return null;
    const rec = [...C.records.values()].find((r) => r.type.name === rt.name);
    if (rec === undefined) return null;
    label = `${rec.name}.${String(leaf(kids(fn)[1]))}`;
    key = label;
  } else {
    return null;
  }
  const def = C.fnNodes.get(key);
  if (def === undefined) return null;
  const ps = kids(part(def, 'params') ?? { kind: 'list', items: [] }).filter((p) => tag(p) === 'p');
  /* 方法（含造记录走的 `__init__`）第一格是 self —— 调用点不给它。 */
  const use = key.includes('.') ? ps.slice(1) : ps;
  return {
    label,
    names: use.map((p) => String(nameOf(kids(p)[0]))),
    defs: use.map((p) => {
      const d = part(p, 'default');
      if (d === undefined) return undefined;
      const e = kids(d)[0];
      /* 默认值写的是模块级那格常量（`def f(x=RATE)`）—— 补的是**它那棵字面量**。
         这与 python 一样：默认值 `def` 那一刻就算好了，之后再改 `RATE` 也换不动它。 */
      if (tag(e) === 'n') {
        const lit = C.constGlobals.get(String(nameOf(e)));
        if (lit !== undefined) return lit;
      }
      return e;
    }),
  };
}

/**
 * **命名实参排回位置上，缺的那几格补默认值**（`f(b=2, a=1)` / `f(1)` 而 `def f(a, b=2)`）。
 *
 * 默认值是**调用点展开**的：把 `def` 上那棵原文树摆到缺的那一格上。这么办与单态化正好
 * 合得上 —— `f(1)` 与 `f(1, 5)` 补完都是两格实参，推出来是同一格实例。
 * 代价说在 `index.js` 的 `checkDefault`：所以默认值只收字面量。
 *
 * 只对**这份源码里定义的函数、类与方法**这么办。内建各有各的规矩
 * （`print(sep=, end=)`、`sorted(reverse=)`），在各自那一处收。
 */
export function kwOrder(fn, toks, C) {
  const sig = calleeSig(fn, C);
  if (sig === null) return toks;
  const { label, names, defs } = sig;
  const hasKw = toks.some((a) => tag(a) === 'kw');
  if (!hasKw && toks.length === names.length) return toks;
  const out = toks.filter((a) => tag(a) !== 'kw');
  if (out.length > names.length) return toks;      // 个数不对，交给下游那句话去报
  for (const a of toks) {
    if (tag(a) !== 'kw') continue;
    const k = String(leaf(kids(a)[0]));
    const at = names.indexOf(k);
    if (at < 0) {
      throw new Error(`python->IR: \`${label}()\` 没有叫 \`${k}\` 的形参`
        + `（有的是 ${names.join(' / ')}）`);
    }
    if (out[at] !== undefined) throw new Error(`python->IR: \`${label}()\` 的 \`${k}\` 给了两回`);
    out[at] = kids(a)[1];
  }
  for (let i = 0; i < names.length; i += 1) {
    if (out[i] !== undefined) continue;
    if (defs[i] === undefined) {
      /* 没给值又没有默认值 —— 交给下游那句"没有对得上的那一格"去报（个数在那儿更清楚）。 */
      return toks;
    }
    out[i] = defs[i];
  }
  return out;
}

/** `isinstance(x, T)` 里那几个类型名字 → 箱子上的标签（`dtag` 交的那几个词）。 */
const PY_TY_TAG = new Map([['int', 'int'], ['float', 'real'], ['str', 'string'], ['bool', 'bool']]);

/**
 * `isinstance(x, T)` —— T 是**类型的名字**（不是一格值），所以调用点要在算实参之前拦。
 *
 * 静态的那一档在**编译期**就答得出（这一层的类型是确定的）；一格箱子那一档问
 * `(dtag …)`。`isinstance(True, int)` 在 python 里是 True（bool 是 int 的子类）——
 * 这一格照它。
 *
 * **明说的不足**：第二格收元组（`isinstance(x, (int, str))`）没接 —— 元组本身还没那一档。
 */
function isinstanceOf(valTok, tyTok, C) {
  /* **`isinstance(x, (A, B))`** —— 一格元组就是"哪一格都算"：逐格问一遍再 `or` 起来。
     值那一段会算好几遍，所以只收**纯的**那一档（名字 / 字面量）；带副作用的先落一格变量。
     python 那边这两种写法一个意思，所以不必另编规矩。 */
  if (tag(tyTok) === 'tuple') {
    const ts = kids(tyTok);
    if (ts.length === 0) return { kind: 'bool', value: false };
    if (!['n', 'num', 'str'].includes(tag(valTok))) {
      throw new Error('python->IR: `isinstance(x, (A, B))` 里的 x 要是一格名字或字面量'
        + '（那一格要问好几遍，带副作用的先落一格变量）');
    }
    return ts.map((one) => isinstanceOf(valTok, one, C))
      .reduce((l, r) => ({ kind: 'binop', op: '||', left: l, right: r }));
  }
  if (tag(tyTok) !== 'n') {
    throw new Error('python->IR: `isinstance(x, T)` 的 T 要写成一格类型的名字'
      + '（或者一格类型的元组）');
  }
  const nm = String(nameOf(tyTok));
  const v0 = exprOf(valTok, C);
  const t = ty(v0, C);
  /* 一格记录：这一层没有继承，所以就是"是不是同一个类"。 */
  if (C.records.has(nm)) {
    return { kind: 'bool', value: t.kind === 'named' && t.name === C.ref(nm) };
  }
  if (nm === 'list') return { kind: 'bool', value: t.kind === 'arr' };
  if (nm === 'dict') return { kind: 'bool', value: t.kind === 'map' };
  const want = PY_TY_TAG.get(nm);
  if (want === undefined) {
    throw new Error(`python->IR: \`isinstance(x, ${nm})\` 还没接`
      + '（接了的是 int / float / str / bool / list / dict 与这份源码里的类）');
  }
  if (t.kind !== 'dyn') {
    if (want === 'int') return { kind: 'bool', value: t.kind === 'int' || t.kind === 'bool' };
    return { kind: 'bool', value: t.kind === want };
  }
  /* 箱子：运行期问标签。`int` 那一格要问两个（bool 也算 int）—— 所以先钉住 x。 */
  const pre = [];
  let v = v0;
  if (!isPure(v0)) {
    const n = C.fresh('ii_x');
    C.bind(n, t);
    pre.push({ kind: 'let', name: n, type: t, init: v0 });
    v = { kind: 'name', name: n };
  }
  const isTag = (s) => ({
    kind: 'binop', op: '==',
    left: { kind: 'builtin', name: 'dtag', args: [v] },
    right: { kind: 'string', value: s },
  });
  const value = want === 'int'
    ? { kind: 'binop', op: '||', left: isTag('int'), right: isTag('bool') }
    : isTag(want);
  return pre.length === 0 ? value : { kind: 'block-expr', stmts: pre, value };
}

/**
 * `zip(a, b)` / `enumerate(xs[, start])` / `d.items()` **当值用** —— 交一张
 * `(arr Tup2_…)`。走一趟循环，每一圈造一格元组。
 *
 * `for a, b in …` 那一侧不走这儿（那边落成一趟下标循环，中间不造元组）——
 * 这一格是给 `list(zip(a, b))` / `sorted(d.items())` 那种"真要一张表"的写法的。
 * `zip` 走到**短的那一张**为止（python 的规矩）。
 */
function pairsList(kind, args, C) {
  const pre = [];
  const pin = (e, p) => {
    const t = ty(e, C);
    if (isPure(e)) return { v: e, t };
    const n = C.fresh(p);
    C.bind(n, t);
    pre.push({ kind: 'let', name: n, type: t, init: e });
    return { v: { kind: 'name', name: n }, t };
  };
  const i = C.fresh('pl_i');
  C.bind(i, INT);
  const iv = { kind: 'name', name: i };
  const at = (s) => (s.t.kind === 'string'
    ? { kind: 'builtin', name: 'ssub', args: [s.v, iv, { kind: 'int', value: 1 }] }
    : { kind: 'index', obj: s.v, index: iv });
  let cond;
  /** 逐格要摆进元组的那几个值（`zip` 是 **N 格**，`enumerate` / `items` 是两格）。 */
  let parts;
  if (kind === 'zip') {
    /* **N 张表一起走**，走到最短的那一张为止（python 的规矩）。 */
    const ss = args.map((a, k) => pin(a, `pl_z${k}`));
    const shortest = ss.map((s) => lenOf(s.v, C)).reduce((l, r) => ({
      kind: 'ternary', type: INT,
      cond: { kind: 'binop', op: '<', left: l, right: r }, then: l, else_: r,
    }));
    cond = { kind: 'binop', op: '<', left: iv, right: shortest };
    parts = ss.map(at);
  } else if (kind === 'enumerate') {
    const xs = pin(args[0], 'pl_x');
    const start = args.length === 2 ? args[1] : { kind: 'int', value: 0 };
    cond = { kind: 'binop', op: '<', left: iv, right: lenOf(xs.v, C) };
    parts = [
      start.kind === 'int' && Number(start.value) === 0
        ? iv
        : { kind: 'binop', op: '+', left: iv, right: start },
      at(xs),
    ];
  } else {
    const d = pin(args[0], 'pl_d');
    const ks = C.fresh('pl_ks');
    const kt = arrOf(d.t.key);
    C.bind(ks, kt);
    pre.push({
      kind: 'let', name: ks, type: kt,
      init: { kind: 'builtin', name: 'dkeys', args: [d.v] },
    });
    const ksv = { kind: 'name', name: ks };
    cond = {
      kind: 'binop', op: '<', left: iv,
      right: { kind: 'builtin', name: 'alen', args: [ksv] },
    };
    const k = { kind: 'index', obj: ksv, index: iv };
    parts = [k, { kind: 'builtin', name: 'dget', args: [d.v, k] }];
  }
  const rec = tupleRec(parts.map((p) => ty(p, C)), C);
  const outT = arrOf(rec.type);
  const on = C.fresh('pl_o');
  C.bind(on, outT);
  const out = { kind: 'name', name: on };
  return {
    kind: 'block-expr',
    stmts: [
      ...pre,
      {
        kind: 'let', name: on, type: outT,
        init: { kind: 'builtin', name: 'anew', args: [tyArg(outT), { kind: 'int', value: 0 }] },
      },
      {
        kind: 'for',
        init: { kind: 'let', name: i, type: INT, init: { kind: 'int', value: 0 } },
        cond,
        post: {
          kind: 'assign', target: iv,
          value: { kind: 'binop', op: '+', left: iv, right: { kind: 'int', value: 1 } },
        },
        body: [{
          kind: 'builtin-stmt', name: 'apush',
          args: [out, {
            kind: 'new-record', type: rec.type, ref: true,
            fields: parts.map((v, k) => ({ name: `_${k}`, value: v })),
          }],
        }],
      },
    ],
    value: out,
  };
}

/** 一格调用：内建、`math.*`、方法、用户函数。 */
export function callOf(x, C) {
  const [fn, argsTok] = kids(x);
  const argToks = kwOrder(fn, argsTok === undefined ? [] : kids(argsTok), C);
  /* `isinstance(x, T)` —— T 是类型的名字，不是一格值，要在算实参之前拦。 */
  if (tag(fn) === 'n' && String(nameOf(fn)) === 'isinstance') {
    if (argToks.length !== 2) throw new Error('python->IR: `isinstance(x, T)` 收两格实参');
    return isinstanceOf(argToks[0], argToks[1], C);
  }
  /* `min(xs, key=…)` / `max(xs, key=…)` —— 与 `sorted(key=…)` 同一条：键表算一遍，
     挑键最小/最大的那一格，**交回去的是元素**。也要在算实参之前拦。 */
  if (tag(fn) === 'n' && ['min', 'max'].includes(String(nameOf(fn)))
    && argToks.some((a) => tag(a) === 'kw')) {
    const nm0 = String(nameOf(fn));
    const pos = argToks.filter((a) => tag(a) !== 'kw');
    if (pos.length !== 1) throw new Error(`python->IR: \`${nm0}(xs, key=…)\` 的 xs 收一格表`);
    let keyTok = null;
    for (const a of argToks.filter((y) => tag(y) === 'kw')) {
      const k = String(leaf(kids(a)[0]));
      if (k !== 'key') throw new Error(`python->IR: \`${nm0}(${k}=…)\` 还没接（接了的是 key=）`);
      keyTok = kids(a)[1];
    }
    const raw0 = exprOf(pos[0], C);
    /* `max(d, key=…)` —— **字典走的是键**（与 `for k in d` / `sorted(d)` 一条）。 */
    const xs0 = ty(raw0, C).kind === 'map'
      ? { kind: 'builtin', name: 'dkeys', args: [raw0] } : raw0;
    const pre = [];
    const bn = C.fresh('pk_xs');
    const bt0 = ty(xs0, C);
    C.bind(bn, bt0);
    pre.push({ kind: 'let', name: bn, type: bt0, init: xs0 });
    const box0 = { kind: 'name', name: bn };
    const got = keyListOf(box0, keyTok, C);
    pre.push(...got.pre);
    needOrd(ty(got.keys, C).elem, C, `${nm0}(key=…)`);
    const picked = pickByKeyOf(box0, got.keys, nm0 === 'min' ? '<' : '>', nm0, C);
    return { kind: 'block-expr', stmts: pre, value: picked };
  }
  /* `sorted(xs, reverse=True)` / `sorted(xs, key=lambda v: …)` —— 要在**算实参之前**拦
     （下面那一圈见了 `kw` 就报）。`reverse` 只收布尔字面量：两种比法是两条循环，得在
     编译期定。`key=` 只收 lambda 字面量（就地展开成一张键表）。 */
  if (tag(fn) === 'n' && String(nameOf(fn)) === 'sorted'
    && argToks.some((a) => tag(a) === 'kw')) {
    const pos = argToks.filter((a) => tag(a) !== 'kw');
    if (pos.length !== 1) throw new Error('python->IR: `sorted()` 收一格表');
    let desc = false;
    let keyTok = null;
    for (const a of argToks.filter((y) => tag(y) === 'kw')) {
      const k = String(leaf(kids(a)[0]));
      const v = kids(a)[1];
      if (k === 'key') {
        keyTok = v;
        continue;
      }
      if (k !== 'reverse') {
        throw new Error(`python->IR: \`sorted(${k}=…)\` 还没接（接了的是 reverse= 与 key=）`);
      }
      if (tag(v) !== 'true' && tag(v) !== 'false') {
        throw new Error('python->IR: `sorted(reverse=…)` 要写成 True / False 字面量'
          + '（两种比法是两条循环，得在编译期定）');
      }
      desc = tag(v) === 'true';
    }
    return sortedPy(exprOf(pos[0], C), C, desc, keyTok);
  }
  for (const a of argToks) {
    if (['kw', 'star', 'starstar'].includes(tag(a))) {
      throw new Error(`python->IR: 实参里的 \`${tag(a)}\` 还没接（命名实参 / 展开）`);
    }
  }
  /* **吃序列的那几个内建：实参位置上的 `range(…)` 现场铺成一张表**。
     `range` 当值用本身没接（python 印 `range(0, 3)`，铺成表就印错了），可
     `list(range(3))` / `sorted(range(3))` / `reversed(range(4))` / `sum(range(5))` 这几种
     写法只是"要一串数"，铺开就对 —— 所以按**吃序列的那一格名单**放行，别放行 `print`。
     要在算实参**之前**拦：算它就报"range 当值用还没接"了。 */
  const SEQ_ARG = new Set(['list', 'sorted', 'reversed', 'sum', 'min', 'max', 'any', 'all',
    'len', 'tuple', 'enumerate', 'zip']);
  const isRangeCall = (a) => a !== undefined && tag(a) === 'call' && tag(kids(a)[0]) === 'n'
    && String(nameOf(kids(a)[0])) === 'range';
  if (tag(fn) === 'n' && SEQ_ARG.has(String(nameOf(fn))) && argToks.some(isRangeCall)) {
    const fixed = argToks.map((a) => (isRangeCall(a) ? { ...a, __rangeList: true } : a));
    const args0 = fixed.map((a) => (a.__rangeList === true ? rangeListOf(a, C) : exprOf(a, C)));
    const nm0 = String(nameOf(fn));
    if (C.records.has(nm0)) return newRecord(C.records.get(nm0), args0, C);
    return builtinOf(nm0, args0, argToks, C);
  }
  /* `map(f, xs)` / `filter(f, xs)` —— **也要在算实参之前拦**：第一格实参是个函数名，
     当值算它就报"把函数当值传要 `(asfn …)`"了。这两格是**编译期铺开**的（见 `mapPy`）。 */
  if (tag(fn) === 'n' && ['map', 'filter'].includes(String(nameOf(fn)))) {
    const mf = String(nameOf(fn));
    if (argToks.length !== 2) {
      throw new Error(`python->IR: \`${mf}(f, xs)\` 收两格实参（多路的 \`map\` 还没接）`);
    }
    /* `None` 在 CST 里是自己一格（`none`），不是名字。 */
    if (mf === 'filter' && tag(argToks[0]) === 'none') {
      return filterNonePy(argToks[1], C);
    }
    return mapPy(argToks[0], argToks[1], C, mf === 'filter');
  }
  const wants = paramWants(fn, argToks, C);
  const args = argToks.map((a, k) => {
    /* **实参位置上的 `[]` / `{}`**：右边答不出元素类型，**形参那一格**说了算 ——
       与 `xs = []` / `d[k] = []` 同一条（"空容器的类型从左边来"）。
       从前这一格直接报"空表 `[]` 的元素类型推不出来 —— 给它一格标注"，可实参位置上
       **压根没处写标注**：`merge([], [1])` 那种写法就此走不通。 */
    if (['list', 'dict'].includes(tag(a)) && kids(a).length === 0) {
      const want = (wants ?? [])[k];
      if (want != null && want.kind === (tag(a) === 'list' ? 'arr' : 'map')) return emptyOf(want);
    }
    return exprOf(a, C);
  });


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

/** 一格空容器（类型已经知道了）。 */
export function emptyOf(t) {
  return t.kind === 'arr'
    ? { kind: 'builtin', name: 'anew', args: [tyArg(t), { kind: 'int', value: 0 }] }
    : { kind: 'builtin', name: 'dnew', args: [tyArg(t)] };
}

/**
 * 这一处调用的**形参各是什么类型** —— 只给"实参位置上的空容器"用（`f([])`）。
 *
 * 拿得到就拿，拿不到交 null（那时空容器照旧报它自己那句）。**只在实例唯一时认**：
 * 几格实例摆在那儿说明这个函数按实参类型单态化过，那时猜哪一格都是错的。
 */
function paramWants(fn, argToks, C) {
  if (!argToks.some((a) => ['list', 'dict'].includes(tag(a)) && kids(a).length === 0)) return null;
  let list = null;
  let off = 0;                                   // `self` 占掉的那一格
  if (tag(fn) === 'n') {
    const nm = String(nameOf(fn));
    if (C.records.has(nm)) { list = C.insts.get(`${nm}.__init__`); off = 1; } else list = C.insts.get(nm);
  } else if (tag(fn) === 'attr') {
    const rt = tyOfCst(kids(fn)[0], C);
    if (rt !== null && rt.kind === 'named') {
      list = C.insts.get(`${rt.name}.${String(leaf(kids(fn)[1]))}`);
      off = 1;
    }
  }
  if (!Array.isArray(list)) return null;
  const cands = list.filter((i) => i.params.length === argToks.length + off);
  if (cands.length !== 1) return null;
  return argToks.map((_, k) => cands[0].params[k + off].type);
}

/**
 * `list(range(a, b, step))` —— 实参与 `for … in range(…)` 那一处同一条规矩
 * （1~3 格，步长要是一格非零整数字面量）。
 */function rangeListOf(callTok, C) {
  const as = kids(part(callTok, 'args') ?? { kind: 'list', items: [] });
  if (as.length === 0 || as.length > 3) throw new Error('python->IR: `range()` 收 1~3 格实参');
  const from = as.length === 1 ? { kind: 'int', value: 0 } : exprOf(as[0], C);
  const to = as.length === 1 ? exprOf(as[0], C) : exprOf(as[1], C);
  let step = 1;
  if (as.length === 3) {
    const sv = exprOf(as[2], C);
    if (sv.kind !== 'int' || sv.value === 0n || sv.value === 0) {
      throw new Error('python->IR: `range(a, b, step)` 的步长要是一格非零整数字面量 —— '
        + '往前往后是两条循环，编译期就得定下来');
    }
    step = Number(sv.value);
  }
  return rangeList(from, to, step, C);
}

/** `C(a, b)` —— `(cnew C)` 造一格，`C___init__(obj, a, b)` 填，值是那一格。 */function newRecord(rec, args, C) {
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
/** 一格 int 表达式要读**两遍**（三元的两支里各一次）时先落成临时量。 */
function keepInt(e, prefix, C) {
  if (isPure(e)) return { pre: [], v: e };
  const n = C.fresh(prefix);
  C.bind(n, INT);
  return { pre: [{ kind: 'let', name: n, type: INT, init: e }], v: { kind: 'name', name: n } };
}

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
      /* python 的 bool 就是 int 的一种：`int(True)` 是 1。 */
      if (t0.kind === 'bool') {
        return {
          kind: 'ternary', type: INT, cond: args[0], then: { kind: 'int', value: 1 }, else_: { kind: 'int', value: 0 },
        };
      }
      /* `int(s)` / `int(s, base)` —— **串转整数不用借 C**：整数逐位乘加就是精确的
         （"最短往返"那种讲究是浮点才有的）。base 要是编译期的字面量。 */
      if (t0.kind === 'string') {
        let base = 10;
        if (args.length === 2) {
          if (args[1].kind !== 'int') {
            throw new Error('python->IR: `int(s, base)` 的 base 要写成一格整数字面量'
              + '（前缀与数位表都跟着它定）');
          }
          base = Number(args[1].value);
          if (base < 2 || base > 36) {
            throw new Error(`python->IR: \`int(s, ${base})\` 的 base 收 2..36`
              + '（python 还许 0 —— 那一档"看前缀猜"还没接）');
          }
        } else if (args.length !== 1) {
          throw new Error('python->IR: `int()` 收一格或两格实参');
        }
        const msg = {
          kind: 'binop', op: '+',
          left: { kind: 'string', value: `invalid literal for int() with base ${base}: ` },
          right: pyRepr(args[0], C),
        };
        return intOfStr(args[0], base, C, msg);
      }
      throw new Error(`python->IR: \`int(${t0.kind})\` 还没接（串与数接了）`);
    case 'float':
      if (t0 !== null && t0.kind === 'string') {
        throw new Error('python->IR: `float(串)` 还没接 —— 串转浮点要"最短往返"那一档'
          + '（借来的 CPython `pystrtod`，见 SPEC 的下一刀），自己写的解析会在末位上差一点，'
          + '不装作有；`int(串)` 是另一回事（逐位乘加本来就精确）');
      }
      return t0.kind === 'real' ? args[0] : toReal(args[0], C);
    case 'str':
      return pyStr(args[0], C);
    case 'bool':
      return condOfExpr(args[0], C);
    case 'ord':
      if (args.length !== 1 || t0.kind !== 'string') {
        throw new Error('python->IR: `ord()` 收一格串');
      }
      return ordOf(args[0], C);
    case 'chr':
      return { kind: 'builtin', name: 'chr', args };
    case 'abs':
      if (t0.kind === 'real') return { kind: 'rmath', fn: 'fabs', args };
      return pickOf(args[0], { kind: 'unop', op: '-', operand: args[0] }, '>', C);
    /* `divmod(a, b)` —— 交一格两格的元组 `(a // b, a % b)`。取整与取模用的就是
       `//` / `%` 那两份（`floorDiv` / `pyMod`），所以 python 的符号规矩不用再说一遍。 */
    case 'divmod': {
      if (args.length !== 2) throw new Error('python->IR: `divmod()` 收两格实参');
      const t1 = ty(args[1], C);
      if (!isNum(t0) || !isNum(t1)) {
        throw new Error(`python->IR: \`divmod(${t0.kind}, ${t1.kind})\` 还没接（数才有这一格）`);
      }
      const pre = [];
      const pin = (e, p) => {
        if (isPure(e)) return e;
        const n = C.fresh(p);
        const t = ty(e, C);
        C.bind(n, t);
        pre.push({ kind: 'let', name: n, type: t, init: e });
        return { kind: 'name', name: n };
      };
      const x = pin(args[0], 'dm_a');
      const y = pin(args[1], 'dm_b');
      const both = isInt(t0) && isInt(t1);
      const q = floorDiv(x, y, both, C);
      const r = pyMod(x, y, both, C);
      const rec = tupleRec([ty(q, C), ty(r, C)], C);
      const value = {
        kind: 'new-record', type: rec.type, ref: true,
        fields: [q, r].map((v, i) => ({ name: `_${i}`, value: v })),
      };
      return pre.length === 0 ? value : { kind: 'block-expr', stmts: pre, value };
    }
    case 'min': case 'max': {
      const op = nm === 'min' ? '<' : '>';
      if (args.length === 0) throw new Error(`python->IR: \`${nm}()\` 至少要一格实参`);
      /* 比法递下去 —— 元组按字典序（`cmpOne`），不然落到方言里是比句柄、静默答错。 */
      const less = (x, y) => cmpOne('<', x, y, C);
      /* 一格实参：那是一格表（`min(xs)`），串也算（一格一个字符）。
         两格以上：逐个挑（`min(a, b, c)`）。 */
      if (args.length === 1) {
        /* 串一格一个字符；**字典走的是键**（与 `for k in d` / `sorted(d)` 一条）。 */
        let one = args[0];
        if (t0.kind === 'string') one = charsOf(args[0], C);
        if (t0.kind === 'map') one = { kind: 'builtin', name: 'dkeys', args: [args[0]] };
        const tOne = ty(one, C);
        if (tOne.kind === 'arr') needOrd(tOne.elem, C, `${nm}()`);
        return pickList(one, op, nm, C, less);
      }
      args.forEach((a) => needOrd(ty(a, C), C, `${nm}()`));
      /* **int 与 real 混着来：两边都装箱**（`max(1, 2.5)`）。
         方言的三目两支必须同型，不动就报"(sel …) 两支要同型：甲是 int，乙是 real"。
         而**不能把 int 提到 real**：python 的 `max(3, 2.5)` 交的是 `3`（int），印出来是
         `3` 不是 `3.0` —— 提上去就印错数。箱子那条道正是为这一格来的（印的时候按标签分派）。 */
      let vals = args;
      const tys = args.map((a) => ty(a, C));
      if (tys.some((t) => t.kind === 'real') && tys.some((t) => t.kind === 'int')
        && tys.every((t) => ['int', 'real'].includes(t.kind))) {
        vals = args.map((a) => boxOf(a, C));
      }
      /* **平手时留左边那一格** —— python 的 `min` / `max` 交的是"第一个最小/最大的"
         （`a if a <= b else b`）。平时看不出来（两格值一样），可 int 与 real 混着来那一档
         看得出：`max(2, 2.0)` 是 `2`（int），印 `2` 不是 `2.0`。所以比法要**非严格**：
         用 `!(右 < 左)` / `!(左 < 右)`，别用严格小于。
         （一格表那条路 `pickList` 本来就对：只在**严格**更好时才换 best。） */
      const not = (e) => ({ kind: 'unop', op: '!', operand: e });
      let best = vals[0];
      for (let i = 1; i < vals.length; i += 1) {
        best = pickOf(best, vals[i], op, C,
          op === '<' ? (l, r) => not(less(r, l)) : (l, r) => not(less(l, r)));
      }
      return best;
    }
    case 'sum': {
      if (args.length === 1) return sumOf(args[0], C);
      if (args.length !== 2) throw new Error('python->IR: `sum()` 收一格表或者表加一格起点');
      /* `sum(xs, start)` —— 起点加上去就是（合型那一下交给 `+`，与源码里写
         `start + sum(xs)` 逐字同一条）。 */
      const s = sumOf(args[0], C);
      const st = ty(args[1], C);
      const acc = ty(s, C);
      if (st.kind === 'real' && acc.kind === 'int') {
        return { kind: 'binop', op: '+', left: args[1], right: toReal(s, C) };
      }
      if (st.kind === 'int' && acc.kind === 'real') {
        return { kind: 'binop', op: '+', left: toReal(args[1], C), right: s };
      }
      return { kind: 'binop', op: '+', left: args[1], right: s };
    }
    /* `reversed(xs)` —— 交倒过来的**一张新表**（原表不动）。 */
    case 'reversed': {
      if (args.length !== 1) throw new Error('python->IR: `reversed()` 收一格表');
      if (t0.kind !== 'arr') throw new Error(`python->IR: \`reversed(${t0.kind})\` 还没接（表接了）`);
      return reversedList(args[0], C);
    }
    /* `repr(x)` —— `str()` 那一侧已经有了，这一格只差把串加上引号（`pyRepr`）。 */
    case 'repr': {
      if (args.length !== 1) throw new Error('python->IR: `repr()` 收一格实参');
      return pyRepr(args[0], C);
    }
    /* `hex/oct/bin` —— 方言的 `(sbase E 进制)` 就是它，只差前缀与负号。
       `sbase` 把位当**无符号 64 位**读，所以负数要自己拆成 `-` 加上取反那一格
       （量过：`hex(-255)` python 交 `-0xff`，直接 sbase 会交 16 个 f 那一串）。 */
    case 'hex': case 'oct': case 'bin': {
      if (args.length !== 1) throw new Error(`python->IR: \`${nm}()\` 收一格实参`);
      if (t0.kind !== 'int') throw new Error(`python->IR: \`${nm}(${t0.kind})\` —— python 里也要整数`);
      const base = { hex: 16, oct: 8, bin: 2 }[nm];
      const pre = { hex: '0x', oct: '0o', bin: '0b' }[nm];
      const v = keepInt(args[0], `${nm}_v`, C);
      const digits = (e) => ({ kind: 'builtin', name: 'sbase', args: [e, { kind: 'int', value: base }] });
      const cat = (l, r) => ({ kind: 'binop', op: '+', left: l, right: r });
      return {
        kind: 'block-expr', stmts: v.pre,
        value: {
          kind: 'ternary', type: STR,
          cond: { kind: 'binop', op: '<', left: v.v, right: { kind: 'int', value: 0 } },
          then: cat({ kind: 'string', value: `-${pre}` },
            digits({ kind: 'unop', op: '-', operand: v.v })),
          else_: cat({ kind: 'string', value: pre }, digits(v.v)),
        },
      };
    }
    case 'any': case 'all': {
      if (args.length !== 1) throw new Error(`python->IR: \`${nm}()\` 收一格表`);
      return anyAllOf(args[0], nm === 'all', C, condOfExpr);
    }
    /* `zip(a, b)` / `enumerate(xs[, start])` **当值用** —— 交一张元组的表。 */
    case 'zip': {
      if (args.length < 2) throw new Error('python->IR: `zip()` 至少收两格实参');
      return pairsList('zip', args, C);
    }
    case 'enumerate': {
      if (args.length !== 1 && args.length !== 2) {
        throw new Error('python->IR: `enumerate()` 收一格或两格实参');
      }
      return pairsList('enumerate', args, C);
    }
    case 'sorted': {
      if (args.length !== 1) throw new Error('python->IR: `sorted(xs, key=…)` 那几格还没接');
      return sortedPy(args[0], C, false);
    }
    case 'list': {
      /* `list(range(…))` —— range 当值用只在 `callOf` 那一处拦了（最常见的去处）。 */
      if (args.length !== 1) throw new Error('python->IR: `list()` 收一格实参');
      const t = ty(args[0], C);
      /* **`list(xs)` 要抄一份**（python 的 `list()` 是浅拷贝）—— 从前这儿直接交原表，
         `ys = list(xs); ys.append(v)` 会把 xs 也改了。 */
      if (t.kind === 'arr') return copyList(args[0], C);
      if (t.kind === 'string') return charsOf(args[0], C);
      if (t.kind === 'map') return { kind: 'builtin', name: 'dkeys', args: [args[0]] };
      /* 元组：逐格摆进一张新表（格数与逐格类型都是编译期定的）。 */
      if (tupleOf(C.recOf(t)) !== null) return tupleToList(args[0], C);
      throw new Error(`python->IR: \`list(${t.kind})\` 还没接（表 / 串 / 字典 / 元组 / range 接了）`);
    }
    /* `dict(pairs)` —— 一串两格的元组造一格字典。`dict(a=1)` 那种命名实参没接。 */
    case 'dict': {
      if (args.length !== 1) throw new Error('python->IR: `dict()` 收一格实参（一串两格的元组）');
      const t = ty(args[0], C);
      const tup = t.kind === 'arr' ? tupleOf(C.recOf(t.elem)) : null;
      if (tup === null || tup.length !== 2) {
        throw new Error('python->IR: `dict(…)` 只接一串**两格的元组**'
          + `（这里是 ${t.kind === 'arr' ? `arr<${t.elem.kind}>` : t.kind}）`);
      }
      return dictOfPairs(args[0], tup[0], tup[1], C, dictOf);
    }
    /* `pow(a, b)` 就是 `a ** b`。整数那一档要靠"指数是非负整数字面量"才敢说 int ——
       与 `**` 那一处同一条（`argToks` 手上有，所以这儿判得出来）。 */
    case 'pow': {
      if (args.length !== 2) throw new Error('python->IR: `pow()` 收两格实参（三格的模幂还没接）');
      const p = { kind: 'rmath', fn: 'pow', args: [toReal(args[0], C), toReal(args[1], C)] };
      const bTok = argToks[1];
      const wantInt = ty(args[0], C).kind === 'int' && bTok !== undefined && tag(bTok) === 'num'
        && numValue(leaf(kids(bTok)[0])).kind === 'int'
        && numValue(leaf(kids(bTok)[0])).value >= 0n;
      return wantInt ? { kind: 'builtin', name: 'toint', args: [p] } : p;
    }
    case 'type':
      throw new Error('python->IR: `type(x)` 还没接 —— 这一层没有"类型当值"那一档；'
        + '要判类型用 `isinstance(x, T)`');
    case 'round': {
      /* python 的 `round` 是**半数取偶**（`round(0.5)` 是 0、`round(2.5)` 是 2）——
         `bankRound` 用 floor / fmod 拼出来（方言的 `(rmath "round")` 是 C 的"远离零"，
         `.5` 那一档差一：量到过 `round(2.5)` 从前交 3）。 */
      if (args.length === 1) {
        return { kind: 'builtin', name: 'toint', args: [bankRound(toReal(args[0], C), C)] };
      }
      if (args.length !== 2) throw new Error('python->IR: `round()` 收一格或两格实参');
      /* `round(x, n)` —— 交的是 real（python 也是）。**n 要写成字面量**：10^n 要在
         编译期算出来（而 n 在实际代码里几乎总是字面量）。先乘上去、半数取偶、再除回来。
         **明说的不足**（量出来的）：CPython 的两参 `round` 走**十进制**那条路
         （`_Py_dg_dtoa`），这儿是二进制的乘除 —— `round(2.675, 2)` python 交 2.67、
         我们交 2.68。根子不在 `bankRound`（`2.675 * 100.0` 在双精度里**真是** 267.5，
         两边的一参 round 都把它舍成 268），而在"该不该先转十进制"。
         要对上得把借来的那份 dtoa 反过来用，那是接 `libomnipy` 那一刀的事。 */
      const n = args[1];
      if (n.kind !== 'int') {
        throw new Error('python->IR: `round(x, n)` 的 n 要写成一格整数字面量'
          + '（10^n 要在编译期算出来）');
      }
      const digits = Number(n.value);
      if (digits < 0 || digits > 15) throw new Error('python->IR: `round(x, n)` 的 n 收 0..15');
      const scale = { kind: 'real', value: 10 ** digits };
      const x = toReal(args[0], C);
      return {
        kind: 'binop', op: '/',
        left: bankRound({ kind: 'binop', op: '*', left: x, right: scale }, C),
        right: scale,
      };
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
    /* `xs.pop(i)` **当值用** —— 先把那一格读出来，再把它抽掉（`apop` 只管末尾那一格）。 */
    if (name === 'pop' && args.length === 1) {
      const pre = [];
      let box = recv;
      if (!isPure(recv)) {
        const bn = C.fresh('pp_xs');
        C.bind(bn, t);
        pre.push({ kind: 'let', name: bn, type: t, init: recv });
        box = { kind: 'name', name: bn };
      }
      const at = wrapIndex(box, args[0], C);
      const an = C.fresh('pp_at');
      C.bind(an, INT);
      pre.push({ kind: 'let', name: an, type: INT, init: at });
      const iv = { kind: 'name', name: an };
      const vn = C.fresh('pp_v');
      C.bind(vn, t.elem);
      pre.push({ kind: 'let', name: vn, type: t.elem, init: { kind: 'index', obj: box, index: iv } });
      pre.push(...dropAtStmts(box, iv, C));
      return { kind: 'block-expr', stmts: pre, value: { kind: 'name', name: vn } };
    }

    if (name === 'index' && args.length === 1) return indexOfList(recv, args[0], C, (l, r) => cmpOne('==', l, r, C));
    if (name === 'count' && args.length === 1) return countList(recv, args[0], C, (l, r) => cmpOne('==', l, r, C));
    /* `.copy()` —— 抄一张新表（浅抄，与 python 同）。 */
    if (name === 'copy' && args.length === 0) return copyList(recv, C);
    if (['append', 'reverse', 'extend', 'clear', 'insert', 'remove', 'sort'].includes(name)) {
      throw new Error(`python->IR: \`.${name}()\` 不交值（当语句用是接了的）`);
    }
    throw new Error(`python->IR: 表上的 \`.${name}()\` 还没接`
      + '（交值的接了 pop / index / count / copy；改原表的那几个当语句用）');
  }
  if (t.kind === 'string') {
    /**
     * `.upper()` / `.lower()` —— 方言的 `supper` / `slower` 是**只动 ASCII** 的
     * （那是它们四条腿能是同一个函数的前提：`toupper` 看 locale，JS 的 `toUpperCase()`
     * 是 Unicode 的、长度都会变）。
     *
     * **这是一处会答错的地方，不是"还没接"**：python 的这两个是 Unicode 的 ——
     * 量出来 `"äöü".upper()` 我们交 `äöü`（python 交 `ÄÖÜ`）、
     * `"Straße".upper()` 我们交 `STRAßE`（python 交 `STRASSE`，长度还变了）。
     * 真要对得上得借 `Objects/unicodeobject.c` 的大小写映射表（SPEC §一 的借用名单里
     * 本来就有它）—— 在那之前**只有 ASCII 那一档是对的**。
     */
    if (name === 'upper' && args.length === 0) return { kind: 'builtin', name: 'supper', args: [recv] };
    if (name === 'lower' && args.length === 0) return { kind: 'builtin', name: 'slower', args: [recv] };
    /* `.casefold()` —— **ASCII 那一档就是 `.lower()`**。真正的 casefold 与 lower 只在
       非 ASCII 上分家（`ß` → `ss`、`İ` 那一族），而非 ASCII 的大小写这一层本来就明说
       没接（要借 `unicodeobject.c`）。所以这儿走同一格，不另编一套半对的规矩。 */
    if (name === 'casefold' && args.length === 0) return { kind: 'builtin', name: 'slower', args: [recv] };
    if (name === 'find' && args.length === 1) return { kind: 'builtin', name: 'sfind', args: [recv, args[0]] };
    /* 下面这几格**现场发一趟循环**（`builtins.js`）—— 方言的串那一族只有五格算子，
       python 的这几个方法是它自己的规矩（空段算一格、去哪几个空白字符）。 */
    if (name === 'join' && args.length === 1) return joinOf(recv, args[0], C);
    /* `.split()` / `.split(None)` / `.split(None, n)` —— **不带分隔符**那一档要先拦：
       它按连续空白切、首尾的空段不算，与带分隔符是两条规矩（所以是另一趟循环）。 */
    const noSep = (a) => a !== undefined && a.kind === 'builtin' && a.name === 'dnull';
    if (name === 'split' && (args.length === 0 || noSep(args[0]))) {
      if (args.length === 2 && args[1].kind !== 'int') {
        throw new Error('python->IR: `.split(None, maxsplit)` 的 maxsplit 要写成一格整数字面量');
      }
      if (args.length > 2) throw new Error('python->IR: `.split()` 最多收两格实参');
      return splitWsOf(recv, C, args.length === 2 ? Number(args[1].value) : null);
    }
    if (name === 'split' && (args.length === 1 || args.length === 2)) {
      if (args.length === 2 && args[1].kind !== 'int') {
        throw new Error('python->IR: `.split(sep, maxsplit)` 的 maxsplit 要写成一格整数字面量');
      }
      return splitOf(recv, args[0], C, args.length === 2 ? Number(args[1].value) : null);
    }
    /* `.rsplit(sep[, maxsplit])` —— 从右往左切。**不是"先 split 再挑后几段"**：
       maxsplit 是从右数那么多次，段数一样但分界不同
       （`"a-b-c".rsplit("-", 1)` 是 `['a-b', 'c']`，split 是 `['a', 'b-c']`）。
       不带分隔符的 `.rsplit()` 与 `.split()` 同一格（按连续空白切，两头的空段不算，
       次序也一样）—— 只有带 maxsplit 时才分家，那一档还没接。 */
    if (name === 'rsplit' && (args.length === 0 || noSep(args[0]))) {
      if (args.length >= 1 && !(args.length === 1 && noSep(args[0]))) {
        throw new Error('python->IR: `.rsplit(None, maxsplit)` 还没接'
          + '（从右数那么多次与从左数不是一回事）');
      }
      return splitWsOf(recv, C, null);
    }
    if (name === 'rsplit' && (args.length === 1 || args.length === 2)) {
      if (args.length === 2 && args[1].kind !== 'int') {
        throw new Error('python->IR: `.rsplit(sep, maxsplit)` 的 maxsplit 要写成一格整数字面量');
      }
      return rsplitOf(recv, args[0], C, args.length === 2 ? Number(args[1].value) : null);
    }
    if (name === 'strip' && args.length <= 1) return stripOf(recv, true, true, C, args[0] ?? null);
    if (name === 'lstrip' && args.length <= 1) return stripOf(recv, true, false, C, args[0] ?? null);
    if (name === 'rstrip' && args.length <= 1) return stripOf(recv, false, true, C, args[0] ?? null);
    if (name === 'replace' && (args.length === 2 || args.length === 3)) {
      if (args.length === 3 && args[2].kind !== 'int') {
        throw new Error('python->IR: `.replace(a, b, count)` 的 count 要写成一格整数字面量');
      }
      return replaceOf(recv, args[0], args[1], C, args.length === 3 ? Number(args[2].value) : null);
    }
    /* `.count(sub)` / `.count(sub, start, end)` —— 数不重叠的那几段。 */
    if (name === 'count' && args.length >= 1 && args.length <= 3) {
      return countOf(recv, args[0], C, args[1] ?? null, args[2] ?? null);
    }
    /* `.partition(sep)` / `.rpartition(sep)` —— 交一格**三格的元组**。 */
    if ((name === 'partition' || name === 'rpartition') && args.length === 1) {
      return partitionOf(recv, args[0], C, name === 'rpartition');
    }
    /* `.expandtabs()` / `.splitlines()` —— 都是走一遍（制表位按列算、末尾换行不留空段）。 */
    if (name === 'expandtabs' && args.length <= 1) {
      if (args.length === 1 && args[0].kind !== 'int') {
        throw new Error('python->IR: `.expandtabs(n)` 的 n 要写成一格整数字面量');
      }
      const n = args.length === 1 ? Number(args[0].value) : 8;
      if (n <= 0) throw new Error('python->IR: `.expandtabs(n)` 的 n 要大于 0');
      return expandTabsOf(recv, n, C);
    }
    if (name === 'splitlines' && args.length === 0) return splitLinesOf(recv, C);
    /* `.format()` —— 模板要是串字面量（替换字段得在编译期拆，与 f-string 同一条）。 */
    if (name === 'format') {
      if (recv.kind !== 'string') {
        throw new Error('python->IR: `.format()` 的模板要是一格**串字面量** ——'
          + ' 替换字段得在编译期拆开（每一格的格式说明各是一套代码）');
      }
      return formatOf(String(recv.value), args, C);
    }
    if (name === 'startswith' && args.length === 1) return startsEndsOf(recv, args[0], true, C);
    if (name === 'endswith' && args.length === 1) return startsEndsOf(recv, args[0], false, C);
    /* 大小写那三格与 upper / lower 同一条口径（**只动 ASCII**，见上面那段话）。 */
    if (['title', 'capitalize', 'swapcase'].includes(name) && args.length === 0) {
      return caseMapOf(recv, name, C);
    }
    /* 判类别那几格 —— 逐格走，只认 ASCII。两套规矩别混（见 `charClassOf`）。 */
    if (['isspace', 'isdigit', 'isalpha', 'isalnum', 'isupper', 'islower'].includes(name)
      && args.length === 0) {
      return charClassOf(recv, name, C);
    }
    /* `rfind` / `rindex` —— 从后往前找（方言的 `sfind` 只从前往后）。 */
    if (name === 'rfind' && args.length === 1) return rfindOf(recv, args[0], C);
    /* `.index()` / `.rindex()` —— 与 find / rfind 只差"找不到就报"（python 是 ValueError）。 */
    if ((name === 'index' || name === 'rindex') && args.length === 1) {
      const at = name === 'index'
        ? { kind: 'builtin', name: 'sfind', args: [recv, args[0]] }
        : rfindOf(recv, args[0], C);
      const n = C.fresh('si_at');
      C.bind(n, INT);
      const v = { kind: 'name', name: n };
      return {
        kind: 'block-expr',
        stmts: [
          { kind: 'let', name: n, type: INT, init: at },
          {
            kind: 'if',
            cond: { kind: 'binop', op: '<', left: v, right: { kind: 'int', value: 0 } },
            then: [{ kind: 'builtin-stmt', name: 'fail', args: [{ kind: 'string', value: 'substring not found' }] }],
            else_: null,
          },
        ],
        value: v,
      };
    }
    /* `removeprefix` / `removesuffix` —— 有那一段就切掉，没有就原样。 */
    if ((name === 'removeprefix' || name === 'removesuffix') && args.length === 1) {
      const head = name === 'removeprefix';
      const lp = { kind: 'builtin', name: 'slen', args: [args[0]] };
      const ls = { kind: 'builtin', name: 'slen', args: [recv] };
      const cut = head
        ? { kind: 'builtin', name: 'ssub', args: [recv, lp, { kind: 'binop', op: '-', left: ls, right: lp }] }
        : { kind: 'builtin', name: 'ssub', args: [recv, { kind: 'int', value: 0 }, { kind: 'binop', op: '-', left: ls, right: lp }] };
      return {
        kind: 'ternary', type: STR,
        cond: startsEndsOf(recv, args[0], head, C),
        then: cut,
        else_: recv,
      };
    }
    /* 补宽度那三格（`ljust` / `rjust` / `zfill`）—— 不够宽就补，够了原样。 */
    if ((name === 'ljust' || name === 'rjust') && (args.length === 1 || args.length === 2)) {
      const ch = args.length === 2 ? args[1] : { kind: 'string', value: ' ' };
      return justOf(recv, args[0], ch, name === 'ljust', C);
    }
    /* `.zfill(w)` 不是 `rjust(w, "0")`：开头那一格符号要留在最前头（`"-7".zfill(4)`
       是 `-007`）—— 量出来的，从前答 `00-7`。 */
    if (name === 'zfill' && args.length === 1) return zfillOf(recv, args[0], C);
    /* `.center(w[, ch])` —— 与 f-string 的 `:^N` 同一格（余数放右边）。
       宽度要是字面量：`centerTo` 是按编译期的宽度拼的。 */
    if (name === 'center' && (args.length === 1 || args.length === 2)) {
      if (args[0].kind !== 'int') {
        throw new Error('python->IR: `.center(w)` 的 w 要写成一格整数字面量');
      }
      const ch = args.length === 2 ? args[1] : { kind: 'string', value: ' ' };
      if (ch.kind !== 'string') {
        throw new Error('python->IR: `.center(w, ch)` 的 ch 要写成一格串字面量');
      }
      return centerTo(recv, Number(args[0].value), ch.value, C, true);
    }
    throw new Error(`python->IR: 串上的 \`.${name}()\` 还没接`
      + '（接了的是 upper / lower / casefold / title / capitalize / swapcase / find / rfind / index /'
      + ' rindex / join / split / rsplit / strip / lstrip / rstrip / replace / startswith / endswith /'
      + ' removeprefix / removesuffix / ljust / rjust / zfill / center / is*）');
  }
  if (t.kind === 'map') {
    /* `d.get(k)` —— 键不在里头 python 交 `None`，所以这一格**交的是箱子**（dyn）：
       有就装进去、没有就 `(dnull)`。**方言的 `dget` 在键不在时交的是零值** ——
       直接用它会印出个 `0` 来（量到过），所以要自己先问一句 `dhas`。 */
    if (name === 'get' && args.length === 1) {
      return {
        kind: 'ternary', type: DYN,
        cond: { kind: 'builtin', name: 'dhas', args: [recv, args[0]] },
        then: boxOf({ kind: 'builtin', name: 'dget', args: [recv, args[0]] }, C),
        else_: noneOf(),
      };
    }
    /* `d.get(k, v)` —— 两边合成一格（一样就是它，不一样两边都装箱）。 */
    if (name === 'get' && args.length === 2) {
      const vt = t.value;
      const dt = ty(args[1], C);
      const both = unify([vt, dt]);
      if (both === null) {
        throw new Error(`python->IR: \`.get(k, 默认值)\` 里字典装 ${vt.kind}、默认值是 ${dt.kind}`
          + ' —— 合不成一格');
      }
      const hit = { kind: 'builtin', name: 'dget', args: [recv, args[0]] };
      return {
        kind: 'ternary', type: both,
        cond: { kind: 'builtin', name: 'dhas', args: [recv, args[0]] },
        then: isDyn(both) && !isDyn(vt) ? boxOf(hit, C) : hit,
        else_: isDyn(both) && !isDyn(dt) ? boxOf(args[1], C)
          : (both.kind === 'real' && dt.kind === 'int' ? toReal(args[1], C) : args[1]),
      };
    }
    /* `d.keys()` —— 方言的 `(dkeys d)` 就是它（交一格 `(arr K)`，插入序）。
       python 交的是个**视图**，我们交的是抄出来的一份表 —— 差别是"改字典之后视图会变"，
       这一层不接（`list(d.keys())` 那种用法两者一样）。 */
    if (name === 'keys' && args.length === 0) {
      return { kind: 'builtin', name: 'dkeys', args: [recv] };
    }
    /* `d.values()` —— 键表走一遍，逐个 `dget`（`builtins.js`）。 */
    if (name === 'values' && args.length === 0) return valuesList(recv, C);
    /* `d.pop(k)` / `d.pop(k, 默认值)` —— 取走一格。合型那一套与 `.get()` 逐字同一条。 */
    if (name === 'pop' && (args.length === 1 || args.length === 2)) {
      const vt = t.value;
      const keep = (e) => e;
      /* 键不在那句话里带上键本身（`KeyError: 'z'`，与 python 的末行同形）。 */
      const missMsg = {
        kind: 'binop', op: '+',
        left: { kind: 'string', value: 'KeyError: ' },
        right: pyRepr(args[0], C),
      };
      if (args.length === 1) {
        return dictPopOf(recv, args[0], {
          dflt: null, both: vt, boxHit: keep, boxDflt: keep, missMsg,
        }, C);
      }
      const dt = ty(args[1], C);
      const both = unify([vt, dt]);
      if (both === null) {
        throw new Error(`python->IR: \`.pop(k, 默认值)\` 里字典装 ${vt.kind}、默认值是 ${dt.kind}`
          + ' —— 合不成一格');
      }
      return dictPopOf(recv, args[0], {
        dflt: args[1], both, missMsg,
        boxHit: (e) => (isDyn(both) && !isDyn(vt) ? boxOf(e, C) : e),
        boxDflt: (e) => (isDyn(both) && !isDyn(dt) ? boxOf(e, C)
          : (both.kind === 'real' && dt.kind === 'int' ? toReal(e, C) : e)),
      }, C);
    }
    /* `d.setdefault(k, v)` —— 键在就交那一格、不在就写进去再交。合型那一套与 `.get` 同。 */
    if (name === 'setdefault' && args.length === 2) {
      const vt = t.value;
      const dt = ty(args[1], C);
      const both = unify([vt, dt]);
      if (both === null) {
        throw new Error(`python->IR: \`.setdefault(k, v)\` 里字典装 ${vt.kind}、给的是 ${dt.kind}`
          + ' —— 合不成一格');
      }
      if (!sameType(both, vt)) {
        throw new Error(`python->IR: \`.setdefault(k, v)\` 要写回字典里，所以 v 得装得进`
          + ` ${vt.kind}（这里是 ${dt.kind}）`);
      }
      return dictSetDefaultOf(
        recv, args[0], args[1], vt,
        (e) => e,
        (e) => (isDyn(vt) && !isDyn(dt) ? boxOf(e, C)
          : (vt.kind === 'real' && dt.kind === 'int' ? toReal(e, C) : e)),
        C,
      );
    }
    /* `d.items()` 当值用 —— 交一张元组的表（`for k, v in d.items()` 那一侧不走这儿）。 */
    if (name === 'items' && args.length === 0) return pairsList('items', [recv], C);
    /* `d.copy()` —— 抄一格新字典（浅抄）。 */
    if (name === 'copy' && args.length === 0) return copyDict(recv, C);
    /* `d.popitem()` —— 拿掉最后进来的那一对，交一格两格的元组。 */
    if (name === 'popitem' && args.length === 0) return popItemOf(recv, C);
    if (name === 'clear' || name === 'update') {
      throw new Error(`python->IR: \`d.${name}()\` 交 None，所以只当语句用（单独一行）`);
    }
    throw new Error(`python->IR: 字典上的 \`.${name}()\` 还没接`
      + '（接了的是 get / keys / values / pop / setdefault / clear / update；'
      + '`.items()` 只在 `for k, v in d.items():` 里接）');
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
  /* 一格对象默认是真（python 的规矩：没有 `__bool__` / `__len__` 就真）。
     元组也落这一格：非空的元组恒真，而空元组 `()` 这一层压根不收。 */
  if (t.kind === 'named') return { kind: 'bool', value: true };
  /* 一格箱子：按标签分派（`dyn.js` 的 `dynTruthy`）。 */
  if (t.kind === 'dyn') return dynTruthy(e, C);
  throw new Error(`python->IR: ${t.kind} 当条件用还没接`);
}
