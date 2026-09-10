/* 把一个 C 的**常量表达式**（文本）求出值来 —— `#define GL_COLOR_BUFFER_BIT 0x00004000`
 * 里的那个 `0x00004000`，以及 `#define GLFW_KEY_LAST GLFW_KEY_MENU` 那种转手的名字。
 *
 * 为什么不复用现成的两个求值器：
 *   - `Cpp.exprPreprocess` 是 `#if` 那一套。它只有整数（标准如此），而且**没定义的名字
 *     一律当 0** —— 那正好是这里最不能要的行为：`FOO` 拼错了要报"不知道"，不是 0。
 *   - `CGen.constExpr` 要一个正在解析中的记号流，而这里手上只有一段文本，
 *     而且要在 `unit()` 跑完**之后**、按名字一条条地问。
 *
 * 所以自带一个。范围就是宏体里真会出现的那些：整数/浮点/字符/字符串字面量、
 * 一元 `+ - ~ !`、二元算术与位运算与比较、`&&`/`||`、`?:`、括号，以及别的常量名
 * （由调用方给的 `lookup` 解析，于是 `A` 引用 `B` 这条链自然work）。
 *
 * 整数一律 64 位有符号（与 `enumDecl` 收枚举值同一个宽度），浮点是 f64。
 * **求不出来不猜**：回 `{ kind: 'no', why }`，理由要能直接印给人看。
 */

const CC_OPS = [
  '<<=', '>>=', '...',
  '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
  '(', ')', '+', '-', '*', '/', '%', '&', '|', '^', '~', '!', '<', '>', '?', ':', ',',
];

/** 二元运算符的优先级（越大越紧）。`?:` 与一元的不在表里，单独处理。 */
const CC_PREC = new Map([
  ['||', 1], ['&&', 2], ['|', 3], ['^', 4], ['&', 5],
  ['==', 6], ['!=', 6],
  ['<', 7], ['>', 7], ['<=', 7], ['>=', 7],
  ['<<', 8], ['>>', 8],
  ['+', 9], ['-', 9],
  ['*', 10], ['/', 10], ['%', 10],
]);

const ccIsDigit = (c) => c >= '0' && c <= '9';
const ccIsIdent0 = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
const ccIsIdent = (c) => ccIsIdent0(c) || ccIsDigit(c);

/** 一个记号：`{ k, v }`，k ∈ ident|int|real|str|op|end */
function ccLex(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (ccIsIdent0(c) && !(c === 'L' && (text[i + 1] === '"' || text[i + 1] === "'"))) {
      let j = i;
      while (j < text.length && ccIsIdent(text[j])) j++;
      out.push({ k: 'ident', v: text.slice(i, j) });
      i = j;
      continue;
    }
    if (ccIsDigit(c) || (c === '.' && ccIsDigit(text[i + 1] ?? ''))) {
      const n = ccLexNumber(text, i);
      if (n === null) return null;
      out.push(n.tok);
      i = n.end;
      continue;
    }
    if (c === '"' || c === "'" || (c === 'L' && (text[i + 1] === '"' || text[i + 1] === "'"))) {
      const s = ccLexQuoted(text, i);
      if (s === null) return null;
      out.push(s.tok);
      i = s.end;
      continue;
    }
    let op = null;
    for (const o of CC_OPS) {
      if (text.slice(i, i + o.length) === o) { op = o; break; }
    }
    if (op === null) return null;      // 不认得的字符：整条按"求不出来"处理
    out.push({ k: 'op', v: op });
    i += op.length;
  }
  out.push({ k: 'end', v: '' });
  return out;
}

/** 数字字面量。整数带 `u/U/l/L` 后缀，浮点带 `f/F/l/L`；十六进制浮点（`0x1p3`）也认。 */
function ccLexNumber(text, i) {
  let j = i;
  const hex = text[i] === '0' && (text[i + 1] === 'x' || text[i + 1] === 'X');
  if (hex) j += 2;
  const digits = hex ? '0123456789abcdefABCDEF' : '0123456789';
  while (j < text.length && digits.indexOf(text[j]) >= 0) j++;
  let real = false;
  if (text[j] === '.') {
    real = true;
    j++;
    while (j < text.length && digits.indexOf(text[j]) >= 0) j++;
  }
  const e = text[j];
  if ((hex && (e === 'p' || e === 'P')) || (!hex && (e === 'e' || e === 'E'))) {
    real = true;
    j++;
    if (text[j] === '+' || text[j] === '-') j++;
    if (!ccIsDigit(text[j] ?? '')) return null;
    while (j < text.length && ccIsDigit(text[j] ?? '')) j++;
  }
  const body = text.slice(i, j);
  // 后缀
  let sfx = '';
  while (j < text.length && 'uUlLfF'.indexOf(text[j]) >= 0) { sfx += text[j]; j++; }
  if (j < text.length && ccIsIdent(text[j])) return null;   // `0x10FOO` 之类：不是数
  if (sfx.indexOf('f') >= 0 || sfx.indexOf('F') >= 0) real = true;
  if (real) {
    const x = Number(body);
    if (!(x > -1e308 * 10 && x < 1e308 * 10)) return null;   // NaN / Infinity 都落在这儿
    return { tok: { k: 'real', v: x }, end: j };
  }
  let n;
  if (hex) n = BigInt(body);
  else if (body.length > 1 && body[0] === '0') {
    /* 八进制自己攒 —— `BigInt("0o…")` 认不认由宿主说，这一条不值得赌。 */
    n = 0n;
    for (let k = 1; k < body.length; k++) {
      const d = BigInt(body.charCodeAt(k) - 48);
      if (d < 0n || d > 7n) return null;
      n = n * 8n + d;
    }
  } else n = BigInt(body);
  return { tok: { k: 'int', v: BigInt.asIntN(64, n) }, end: j };
}

/** 转义字符一格。认不出来的回 null —— 这一层的规矩是"不猜"。 */
function ccUnescape1(e) {
  if (e === 'n') return '\n';
  if (e === 't') return '\t';
  if (e === 'r') return '\r';
  if (e === '0') return '\0';
  if (e === '\\') return '\\';
  if (e === "'") return "'";
  if (e === '"') return '"';
  return null;
}

/** 字符串与字符字面量。转义只认最常见那几个 —— 认不出来就回 null（"求不出来"）。 */
function ccLexQuoted(text, i) {
  let j = i;
  if (text[j] === 'L') j++;
  const q = text[j];
  j++;
  let s = '';
  while (j < text.length && text[j] !== q) {
    if (text[j] === '\\') {
      const e = ccUnescape1(text[j + 1]);
      if (e === null) return null;
      s += e;
      j += 2;
      continue;
    }
    s += text[j];
    j++;
  }
  if (j >= text.length) return null;
  j++;
  if (q === '"') return { tok: { k: 'str', v: s }, end: j };
  if (s.length !== 1) return null;
  return { tok: { k: 'int', v: BigInt(s.charCodeAt(0)) }, end: j };
}

/* ---------------------------------------------------------------- 求值

   值有三格：`{ k: 'int', v: BigInt }` / `{ k: 'real', v: number }` /
   `{ k: 'str', v: string }`。整数一律 64 位有符号（溢出就绕回来 —— 与 C 在这个宽度上
   一致）；一边是浮点就整条按浮点算；字符串只能整体，参与运算就是"求不出来"。

   出错的方式是 `throw new CConstNo(why)`：这一层的递归有七八层深，一路往回传
   null 只会让每一格都要判一次。外面 `evalCConst` 一处接住。 */

class CConstNo {
  constructor(why) { this.why = why; }
}

const ccNo = (why) => { throw new CConstNo(why); };

const ccAsNum = (a) => (a.k === 'int' ? Number(a.v) : a.v);

function ccWrapInt(x) { return { k: 'int', v: BigInt.asIntN(64, x) }; }

/** 两边都是整数才是整数运算 —— 别处一律转 f64。字符串在任何运算里都不合法。 */
function ccBinOp(op, a, b) {
  if (a.k === 'str' || b.k === 'str') ccNo(`字符串不能参与 \`${op}\``);
  const bothInt = a.k === 'int' && b.k === 'int';
  if (op === '+') return bothInt ? ccWrapInt(a.v + b.v) : { k: 'real', v: ccAsNum(a) + ccAsNum(b) };
  if (op === '-') return bothInt ? ccWrapInt(a.v - b.v) : { k: 'real', v: ccAsNum(a) - ccAsNum(b) };
  if (op === '*') return bothInt ? ccWrapInt(a.v * b.v) : { k: 'real', v: ccAsNum(a) * ccAsNum(b) };
  if (op === '/') {
    if (bothInt) {
      if (b.v === 0n) ccNo('除以 0');
      return ccWrapInt(a.v / b.v);          // BigInt 的 `/` 就是向零截断，与 C 一致
    }
    return { k: 'real', v: ccAsNum(a) / ccAsNum(b) };
  }
  if (op === '%') {
    if (!bothInt) ccNo('`%` 的两边必须是整数');
    if (b.v === 0n) ccNo('模 0');
    return ccWrapInt(a.v % b.v);
  }
  if (op === '<<' || op === '>>' || op === '&' || op === '|' || op === '^') {
    if (!bothInt) ccNo(`\`${op}\` 的两边必须是整数`);
    if (op === '&') return ccWrapInt(a.v & b.v);
    if (op === '|') return ccWrapInt(a.v | b.v);
    if (op === '^') return ccWrapInt(a.v ^ b.v);
    if (b.v < 0n || b.v > 63n) ccNo(`移位量 ${b.v} 不在 0..63 里`);
    return ccWrapInt(op === '<<' ? a.v << b.v : a.v >> b.v);
  }
  const l = bothInt ? a.v : ccAsNum(a);
  const r = bothInt ? b.v : ccAsNum(b);
  let t;
  if (op === '==') t = l === r;
  else if (op === '!=') t = l !== r;
  else if (op === '<') t = l < r;
  else if (op === '>') t = l > r;
  else if (op === '<=') t = l <= r;
  else if (op === '>=') t = l >= r;
  else if (op === '&&') t = ccTruthy(a) && ccTruthy(b);
  else if (op === '||') t = ccTruthy(a) || ccTruthy(b);
  else ccNo(`不认得运算符 \`${op}\``);
  return { k: 'int', v: t ? 1n : 0n };
}

function ccTruthy(a) {
  if (a.k === 'int') return a.v !== 0n;
  if (a.k === 'real') return a.v !== 0;
  return a.v.length > 0;
}

/** 优先级爬升。`lookup(name)` 回一个值或 null；`depth` 拦住 `#define A A` 那种圈。 */
class CConstParser {
  constructor(toks, lookup, depth) {
    this.toks = toks;
    this.i = 0;
    this.lookup = lookup;
    this.depth = depth;
  }

  cur() { return this.toks[this.i]; }

  isOp(v) {
    const t = this.cur();
    return t.k === 'op' && t.v === v;
  }

  eat(v) {
    if (!this.isOp(v)) ccNo(`要一个 \`${v}\``);
    this.i++;
  }

  /* 一元。**类型转换（`(unsigned)x`）不认** —— 认它就要一份类型解析，而它在宏体里
     并不常见。碰上了就报"求不出来"，需要的时候再往这儿加。 */
  unary() {
    const t = this.cur();
    if (t.k === 'op') {
      if (t.v === '(') {
        this.i++;
        const v = this.cond();
        this.eat(')');
        return v;
      }
      if (t.v === '+' || t.v === '-' || t.v === '~' || t.v === '!') {
        this.i++;
        const v = this.unary();
        if (v.k === 'str') ccNo(`字符串不能做一元 \`${t.v}\``);
        if (t.v === '+') return v;
        if (t.v === '-') return v.k === 'int' ? ccWrapInt(-v.v) : { k: 'real', v: -v.v };
        if (t.v === '~') {
          if (v.k !== 'int') ccNo('`~` 要一个整数');
          return ccWrapInt(~v.v);
        }
        return { k: 'int', v: ccTruthy(v) ? 0n : 1n };
      }
      ccNo(`不该在这儿出现的 \`${t.v}\``);
    }
    if (t.k === 'int' || t.k === 'real' || t.k === 'str') {
      this.i++;
      return { k: t.k, v: t.v };
    }
    if (t.k === 'ident') {
      this.i++;
      if (this.isOp('(')) ccNo(`\`${t.v}(…)\` 是一次调用，不是常量`);
      if (this.depth > 16) ccNo('常量之间引用成了圈（或者太深）');
      const v = this.lookup(t.v, this.depth + 1);
      if (v === null || v === undefined) ccNo(`\`${t.v}\` 不是一个已知的常量`);
      return v;
    }
    ccNo('表达式不完整');
    return null;
  }

  binary(minPrec) {
    let lhs = this.unary();
    for (;;) {
      const t = this.cur();
      if (t.k !== 'op') break;
      const p = CC_PREC.get(t.v);
      if (p === undefined || p < minPrec) break;
      this.i++;
      const rhs = this.binary(p + 1);
      lhs = ccBinOp(t.v, lhs, rhs);
    }
    return lhs;
  }

  cond() {
    const c = this.binary(1);
    if (!this.isOp('?')) return c;
    this.i++;
    const a = this.cond();
    this.eat(':');
    const b = this.cond();
    return ccTruthy(c) ? a : b;
  }
}

/**
 * 求一段 C 常量表达式的值。
 *
 * @param {string} text 表达式的文本（宏体、枚举值都走这儿）
 * @param {function} lookup `(name, depth) => 值 | null`，用来解析里面引用的别的常量
 * @param {number} depth 递归深度（外面第一次给 0）
 * @returns `{ kind: 'int'|'real'|'str', value }`，或 `{ kind: 'no', why }`
 */
export function evalCConst(text, lookup, depth) {
  const body = (text ?? '').trim();
  if (body === '') return { kind: 'no', why: '宏体是空的' };
  const toks = ccLex(body);
  if (toks === null) return { kind: 'no', why: `切不成记号：\`${body}\`` };
  const p = new CConstParser(toks, lookup ?? (() => null), depth ?? 0);
  try {
    const v = p.cond();
    if (p.cur().k !== 'end') return { kind: 'no', why: `\`${body}\` 后面还剩东西` };
    return { kind: v.k, value: v.v };
  } catch (e) {
    if (e instanceof CConstNo) return { kind: 'no', why: e.why };
    throw e;
  }
}


