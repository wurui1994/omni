// Omni stage0 — 解释器的内建与运算（ADR-0013 阶段 1）
//
// 这是**第三份**语义实现（JS 后端、C 后端、解释器）。刻意如此：三份互相对照，任何一份写错
// 都会在四方逐字节比对里当场暴露（tests/interp）。代价是加一个 op 要动三处 —— 和封闭 ABI
// 的既有纪律一致。
//
// 每一条都必须和 backend-js/prelude.js 里的同名函数逐位一致，**包括错误消息文本**。
// 规格见 docs/adr/0005-value-semantics.md。
//
// 这份文件本身也要能被 JS 前端降级、被 C 后端编译（原生构建里解释器是 C），所以只用
// 语言子集里的东西：不用 TextEncoder（自己按 UTF-8 编）、不用 new Function、不用正则字面量
// 以外的正则。

import { stdout, typeTag, fmtReal, reprReal } from '../host/native.js';
import { OmniError } from '../source/diag.js';

// int64 的下界。写成 "最大负数再减一"：`**` 不在语言子集里，而 -9223372036854775808n
// 这个写法会先读到一个越界的正字面量（一元负号是后加的），词法器当场就报 invalid integer
const INT_MIN = -9223372036854775807n - 1n;

/**
 * 解释出来的程序自己的运行期错误。**不是** OmniError：编译器的错误退 1 并原样打印，
 * 而被解释的程序的运行期错误必须和编译出来的程序一模一样 —— `omni: runtime error: ...`
 * 走 stderr，退出码 70（ADR-0005）。所以单独一个类，在 interpret() 的边界上收住。
 */
export class InterpFail extends Error {}

/** 64 位回绕。int 的 + - * << 都要过它（ADR-0005） */
function W(x) {
  return BigInt.asIntN(64, x);
}

/** 和 prelude 的 $rt_error 同一套：先冲刷 stdout（对齐 C 侧 omni_error 的 fflush） */
function rtError(msg) {
  flushOut();
  throw new InterpFail(msg);
}

/** 给 eval.js 用的同一条路（空引用、空函数值这些检查在那边） */
export function failRt(msg) {
  rtError(msg);
}

function idiv(a, b) {
  if (b === 0n) rtError('division by zero');
  if (a === INT_MIN && b === -1n) return INT_MIN;
  return a / b;
}

function imod(a, b) {
  if (b === 0n) rtError('division by zero');
  if (a === INT_MIN && b === -1n) return 0n;
  return a % b;
}

/* ---------------------------------------------------------------- 输出
 * 缓冲到 8192 再落盘，和 prelude 的 $print / $print_raw 共用一个缓冲区的做法一致：
 * 直写的那一路不能插到已缓冲、还没落盘的输出前面去。
 */
let outBuf = '';

function printLine(s) {
  outBuf = outBuf + s + '\n';
  if (outBuf.length > 8192) { stdout(outBuf); outBuf = ''; }
}

export function printRaw(s) {
  outBuf = outBuf + s;
  if (outBuf.length > 8192) { stdout(outBuf); outBuf = ''; }
}

export function flushOut() {
  if (outBuf.length > 0) { stdout(outBuf); outBuf = ''; }
}

/* ------------------------------------------------------------ 实数的格式化
 * 不在这里实现。%.6g 与 repr 的 15/16/17 位往返在两代产物里各自已经有一份
 * （prelude 的 $fmt_real/$repr_real、runtime 的 omni_str_real/omni_repr_real），
 * 解释器再写第三份就是给"同一个 double 打印成同一串字符"多开一条会分叉的路 ——
 * 收成两条宿主 op（ADR-0013、js_abi.js 的 js_fmt_real/js_repr_real），在哪个宿主上
 * 就用那个宿主的那一份，和后端逐字节一致于是是构造性的。
 */

/** repr：非有限的先在这里报错，而不是让 op 里的 omni_error 直接 exit ——
 *  那样解释器缓冲里还没落盘的输出会丢，node 上却不会丢，两个宿主就分叉了。 */
function reprOf(x) {
  if (!Number.isFinite(x)) rtError('cannot represent non-finite real');
  return reprReal(x);
}

function truncReal(x) {
  if (!Number.isFinite(x)) rtError('cannot convert non-finite real to int');
  const t = Math.trunc(x);
  // 超范围报错而不回绕：C 侧的 (int64_t) 是 UB，两个后端只有都报错才对得上。
  // 边界写成 real 字面量（带 .0）：整数写法会让词法器读到越界的 int 字面量
  if (t < -9223372036854775808.0 || t >= 9223372036854775808.0) {
    rtError('real ' + fmtReal(x) + ' is out of int range');
  }
  return BigInt(t);
}

/* ---------------------------------------------------------------- 字符串
 * Omni 的 string 是 **UTF-8 字节序列**（ADR-0005）：len / byteAt / substr 都按字节。
 * 宿主的字符串是 UTF-16，所以过一层编码。刻意不用 TextEncoder —— 这份文件要能被降级成 C，
 * 而 TextEncoder 不在封闭 ABI 里；手写编码在两个宿主上是同一份代码。
 */
function encodeUtf8(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    // 代理对：合成成一个码点再编，否则会编出 CESU-8
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i = i + 1;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else if (c < 0x10000) { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    else {
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

function decodeUtf8(b) {
  let s = '';
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    let cp = c;
    let n = 1;
    if (c >= 0xf0) { cp = c & 0x07; n = 4; } else if (c >= 0xe0) { cp = c & 0x0f; n = 3; } else if (c >= 0xc0) { cp = c & 0x1f; n = 2; }
    for (let k = 1; k < n; k++) cp = (cp << 6) | (b[i + k] & 0x3f);
    i = i + n;
    if (cp >= 0x10000) {
      const v = cp - 0x10000;
      // fromCharCode 在这里只传一个实参：多实参不在语言子集里
      s = s + String.fromCharCode(0xd800 + (v >> 10)) + String.fromCharCode(0xdc00 + (v & 0x3ff));
    } else {
      s = s + String.fromCharCode(cp);
    }
  }
  return s;
}

// 单条 memo：循环里反复扫同一个字符串时保持 O(1) 摊还（prelude 是同一招）
let memoS = null;
let memoB = null;

function bytesOf(s) {
  if (s !== memoS) { memoS = s; memoB = encodeUtf8(s); }
  return memoB;
}

function slen(s) {
  return BigInt(bytesOf(s).length);
}

function byteAt(s, i) {
  const b = bytesOf(s);
  const n = Number(i);
  if (n < 0 || n >= b.length) {
    rtError('string index out of range: ' + n + ' (length ' + b.length + ')');
  }
  return BigInt(b[n]);
}

function substr(s, start, len) {
  const b = bytesOf(s);
  const st = Number(start);
  const ln = Number(len);
  if (st < 0 || ln < 0 || st + ln > b.length) {
    rtError('substring out of range: start ' + st + ', length ' + ln
      + ' (string length ' + b.length + ')');
  }
  return decodeUtf8(b.slice(st, st + ln));
}

function indexOfStr(s, needle) {
  const b = bytesOf(s);
  const nb = encodeUtf8(needle);
  for (let i = 0; i + nb.length <= b.length; i++) {
    let hit = true;
    for (let k = 0; k < nb.length; k++) {
      if (b[i + k] !== nb[k]) { hit = false; break; }
    }
    if (hit) return BigInt(i);
  }
  return -1n;
}

function chrOf(code) {
  const n = Number(code);
  if (n < 0 || n > 0x10ffff) rtError('chr: code point out of range: ' + n);
  return decodeUtf8(encodeUtf8(String.fromCharCode(n)));
}

/* ---------------------------------------------------------------- 容器与 dynamic */

function keyStr(k) {
  // String() 而不是 k.toString()：封闭 ABI 里 toString 只挂在 real 上（js_abi.js 的
  // JS_METHODS），int 上会退化成"取 dynamic 的 toString 属性"，原生构建当场报
  // "dynamic value is int, expected dict"。String() 是 js_str，两个宿主都认。
  if (typeof k === 'bigint') return String(k);
  if (typeof k === 'number') return fmtReal(k);
  if (typeof k === 'boolean') return k ? 'true' : 'false';
  return '"' + k + '"';
}

function listGet(a, i) {
  const n = Number(i);
  if (n < 0 || n >= a.length) {
    rtError('list index out of range: ' + n + ' (length ' + a.length + ')');
  }
  return a[n];
}

function listSet(a, i, v) {
  const n = Number(i);
  if (n < 0 || n >= a.length) {
    rtError('list index out of range: ' + n + ' (length ' + a.length + ')');
  }
  a[n] = v;
  return v;
}

function dictGet(m, k) {
  if (!m.has(k)) rtError('key not found: ' + keyStr(k));
  return m.get(k);
}

/** dynamic 的标签名。这一条是封闭 ABI 里的 js_type_tag —— `instanceof Map` 不在语言
 *  子集里（ADR-0011 决策 15），而 C 侧本来就有标签，所以只能走宿主 op。
 *
 *  Map/Set 要翻一下：解释器自己的容器在 node 上就是宿主的 Map/Set，降级成 C 之后带的是
 *  **JS 域**的 Map/Set 标签；而被解释的程序看到的必须是 Omni 域的 dict/set。不翻的话
 *  同一个程序在两个宿主上会走进不同分支（实测：原生构建上 dict 被认成 Map 而报错）。 */
function dynTag(v) {
  const t = typeTag(v);
  if (t === 'Map') return 'dict';
  if (t === 'Set') return 'set';
  return t;
}

function dynAs(v, want) {
  const t = dynTag(v);
  if (t !== want) rtError('dynamic value is ' + t + ', expected ' + want);
  return v;
}

function dynGet(v, k) {
  const t = dynTag(v);
  if (t === 'list') {
    if (typeof k !== 'bigint') rtError('list index must be int, found ' + dynTag(k));
    return listGet(v, k);
  }
  if (t === 'dict') {
    if (typeof k !== 'string') rtError('dict key must be string, found ' + dynTag(k));
    return dictGet(v, k);
  }
  rtError('cannot index a dynamic value of tag ' + t);
  return undefined;
}

function dynSet(v, k, x) {
  const t = dynTag(v);
  if (t === 'list') {
    if (typeof k !== 'bigint') rtError('list index must be int, found ' + dynTag(k));
    return listSet(v, k, x);
  }
  if (t === 'dict') {
    if (typeof k !== 'string') rtError('dict key must be string, found ' + dynTag(k));
    v.set(k, x);
    return x;
  }
  rtError('cannot index a dynamic value of tag ' + t);
  return undefined;
}

/**
 * dynamic 上的算术。标签严格，**不做** JS 那套强制转换 —— dynamic 是 Omni 的动态通道，
 * 不是 any：`"1" + 1` 在这里是错误，不是 "11"。消息与 prelude / omni_dyn.c 逐字一致。
 */
function dynArith(op, a, b) {
  const ta = dynTag(a);
  const tb = dynTag(b);
  if (ta === 'int' && tb === 'int') {
    if (op === '+') return W(a + b);
    if (op === '-') return W(a - b);
    if (op === '*') return W(a * b);
    if (op === '/') return idiv(a, b);
    return imod(a, b);
  }
  if ((ta === 'int' || ta === 'real') && (tb === 'int' || tb === 'real')) {
    const x = ta === 'int' ? Number(a) : a;
    const y = tb === 'int' ? Number(b) : b;
    if (op === '+') return x + y;
    if (op === '-') return x - y;
    if (op === '*') return x * y;
    if (op === '/') return x / y;
    return x % y;
  }
  if (op === '+' && ta === 'string' && tb === 'string') return a + b;
  rtError("cannot apply '" + op + "' to " + ta + ' and ' + tb);
  return undefined;
}


/** 类型的零值。与 backend-js/emit.js 的 zero() 逐条对应（class 的零值是 null） */
export function zeroOf(t, I) {
  switch (t.k) {
    case 'int': return 0n;
    case 'real': return 0;
    case 'bool': return false;
    case 'string': return '';
    case 'list': return [];
    case 'dict': return new Map();
    case 'set': return new Set();
    case 'struct': {
      const def = I.structs.get(t.name);
      const out = {};
      for (const f of def.fields) out[f.name] = zeroOf(f.type, I);
      return out;
    }
    case 'enum': {
      const def = I.enums.get(t.name);
      const out = { $t: 0n };
      for (const f of def.variants[0].fields) out[f.name] = zeroOf(f.type, I);
      return out;
    }
    default: return null;
  }
}

/** `new C()`：类是引用类型，字段按类型取零值 */
export function newInstance(t, I) {
  const def = I.classes.get(t.name);
  if (def === undefined) throw new OmniError(`interp: no such class '${t.name}'`);
  const out = {};
  for (const f of def.fields) out[f.name] = zeroOf(f.type, I);
  return out;
}

/** JS 的 truthiness（ADR-0011）。降级器会在条件位置插 js_truthy，这里是它的实现 */
export function jsTruthy(v) {
  if (v === null || v === undefined || v === false) return false;
  if (v === 0n) return false;
  if (typeof v === 'number') return !(v === 0 || Number.isNaN(v));
  if (typeof v === 'string') return v.length > 0;
  return true;
}

/* ---------------------------------------------------------------- 运算与内建
 * eval() 里没有单列的那几类都落到这里：Bin / Un / Cmp / IndexGet / IndexSet / Builtin。
 */

export function callBuiltin(I, e, env, frame) {
  switch (e.kind) {
    case 'Bin': return binOp(e.op, e.opType.k, I.eval(e.left, env, frame), I.eval(e.right, env, frame));
    case 'Un': {
      const v = I.eval(e.operand, env, frame);
      // 一元负号也会溢出：-INT64_MIN == INT64_MIN，必须回绕
      if (e.op === '-') return e.type.k === 'int' ? W(-v) : -v;
      if (e.op === '!') return !v;
      if (e.op === '~') return W(~v);
      throw new OmniError(`interp.un: ${e.op}`);
    }
    case 'Cmp': {
      const a = I.eval(e.left, env, frame);
      const b = I.eval(e.right, env, frame);
      if (e.opType.k === 'dynamic') {
        const eq = dynTag(a) === dynTag(b) && a === b;
        return e.op === '==' ? eq : !eq;
      }
      return cmpOp(e.op, a, b);
    }
    case 'IndexGet': {
      const o = I.eval(e.obj, env, frame);
      const i = I.eval(e.index, env, frame);
      return e.recvType.k === 'list' ? listGet(o, i) : dictGet(o, i);
    }
    case 'IndexSet': {
      const o = I.eval(e.obj, env, frame);
      const i = I.eval(e.index, env, frame);
      const v = I.rvalue(e.value, e.type, env, frame);
      if (e.recvType.k === 'list') return listSet(o, i, v);
      o.set(i, v);
      return v;
    }
    case 'Builtin': return builtinOp(I, e, env, frame);
    default: throw new OmniError(`interp.expr: ${e.kind}`);
  }
}

/** 比较。静态那半边的类型已经定好了，所以宿主的 === / < 就是对的语义 */
function cmpOp(op, a, b) {
  switch (op) {
    case '==': return a === b;
    case '!=': return a !== b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    default: throw new OmniError(`interp.cmp: ${op}`);
  }
}

function binOp(op, kind, a, b) {
  if (kind === 'int') {
    switch (op) {
      case '+': return W(a + b);
      case '-': return W(a - b);
      case '*': return W(a * b);
      case '/': return idiv(a, b);
      case '%': return imod(a, b);
      case '<<': return W(a << (b & 63n));
      case '>>': return a >> (b & 63n);
      case '&': return a & b;
      case '|': return a | b;
      case '^': return a ^ b;
      default: throw new OmniError(`interp.bin int: ${op}`);
    }
  }
  if (kind === 'real') {
    switch (op) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return a / b;
      case '%': return a % b;
      default: throw new OmniError(`interp.bin real: ${op}`);
    }
  }
  if (kind === 'string' && op === '+') return a + b;
  throw new OmniError(`interp.bin: ${op} on ${kind}`);
}

/** to_string / print 的四种标量。容器与 dynamic 不到这里 —— 检查器把它们改写成
 *  "深装箱 + 走 std 的序列化器"，那份代码本身也是被解释执行的（check.js 的 print 分支）。 */
function strOf(kind, v) {
  if (kind === 'int') return String(v);  // 不是 v.toString()，见 keyStr 的注释
  if (kind === 'real') return fmtReal(v);
  if (kind === 'bool') return v ? 'true' : 'false';
  if (kind === 'string') return v;
  throw new OmniError(`interp.to_string: ${kind}`);
}

function builtinOp(I, e, env, frame) {
  const a = e.args.map((x) => I.eval(x, env, frame));
  const recv = e.recvType;
  switch (e.name) {
    case 'print': printLine(strOf(e.argType.k, a[0])); return undefined;
    case 'to_string': return strOf(e.argType.k, a[0]);
    case 'trunc': return truncReal(a[0]);
    case 'chr': return chrOf(a[0]);
    case 'fail': rtError(a[0]); return undefined;
    case 'repr': return reprOf(a[0]);
    case 'int_of_string': return intOfString(a[0]);
    case 'real_of_string': return realOfString(a[0]);
    case 'len':
      if (recv.k === 'string') return slen(a[0]);
      return recv.k === 'list' ? BigInt(a[0].length) : BigInt(a[0].size);
    case 'push': a[0].push(a[1]); return undefined;
    case 'add': a[0].add(a[1]); return undefined;
    case 'pop':
      if (a[0].length === 0) rtError('pop from empty list');
      return a[0].pop();
    // `xs.length = 0` 不行：封闭 ABI 里 length 只可读（js_abi.js 的 JS_PROPS），
    // 写它会降级成"往 list 里按 str16 下标写"，原生构建当场报 array index must be a number
    case 'clear': while (a[0].length > 0) { a[0].pop(); } return undefined;
    case 'contains': return recv.k === 'list' ? a[0].includes(a[1]) : a[0].has(a[1]);
    case 'dictGet': return dictGet(a[0], a[1]);
    case 'dictSet': a[0].set(a[1], a[2]); return a[2];
    case 'remove': return a[0].delete(a[1]);
    case 'keys': return [...a[0].keys()];
    case 'items': return [...a[0]];
    case 'byteAt': return byteAt(a[0], a[1]);
    case 'substr': return substr(a[0], a[1], a[2]);
    case 'indexOf': return indexOfStr(a[0], a[1]);
    case 'join': return a[0].join(a[1]);
    case 'tag': return dynTag(a[0]);
    case 'asInt': return dynAs(a[0], 'int');
    case 'asReal': return dynAs(a[0], 'real');
    case 'asBool': return dynAs(a[0], 'bool');
    case 'asString': return dynAs(a[0], 'string');
    case 'asList': return dynAs(a[0], 'list');
    case 'asDict': return dynAs(a[0], 'dict');
    // 深装箱在这里是恒等：dynamic 就是原生值，list<int> 本来就是一个数组（ADR-0008）
    case 'boxDeep': return a[0];
    case 'dynGet': return dynGet(a[0], a[1]);
    case 'dynSet': return dynSet(a[0], a[1], a[2]);
    case 'dynLen': {
      const t = dynTag(a[0]);
      if (t === 'list') return BigInt(a[0].length);
      if (t === 'dict') return BigInt(a[0].size);
      if (t === 'string') return slen(a[0]);
      rtError('dynamic value of tag ' + t + ' has no length');
      return undefined;
    }
    case 'dynIter': {
      const t = dynTag(a[0]);
      if (t === 'list') return a[0];
      if (t === 'dict') return [...a[0].keys()];
      rtError('cannot iterate a dynamic value of tag ' + t);
      return undefined;
    }
    case 'dynPush': dynAs(a[0], 'list').push(a[1]); return undefined;
    case 'dynHas': return dynAs(a[0], 'dict').has(dynAs(a[1], 'string'));
    case 'dynKeys': return [...dynAs(a[0], 'dict').keys()];
    case 'dynAdd': return dynArith('+', a[0], a[1]);
    case 'dynSub': return dynArith('-', a[0], a[1]);
    case 'dynMul': return dynArith('*', a[0], a[1]);
    case 'dynDiv': return dynArith('/', a[0], a[1]);
    case 'dynMod': return dynArith('%', a[0], a[1]);
    case 'dynNeg': {
      const t = dynTag(a[0]);
      if (t === 'int') return W(-a[0]);
      if (t === 'real') return -a[0];
      rtError("cannot apply unary '-' to " + t);
      return undefined;
    }
    case 'js_undef': return undefined;
    case 'js_ofFn': return a[0];
    default:
      // 阶段 1 的边界（ADR-0013）：JS 宿主库那 139 个 op 与 dynamic 上的运算还没接进来。
      // 刻意报错而不是给个错答案 —— 错答案会在四方比对里变成一次难查的分叉。
      throw new OmniError(`interp: builtin '${e.name}' is not in the interpreter yet `
        + '(ADR-0013 stage 1); use `omni run --via-c` for now');
  }
}

function intOfString(s) {
  if (!/^[+-]?[0-9]+$/.test(s)) rtError(`cannot parse int from '${s}'`);
  return W(BigInt(s));
}

function realOfString(s) {
  const v = Number(s);
  if (s.trim() === '' || Number.isNaN(v)) rtError(`cannot parse real from '${s}'`);
  return v;
}








