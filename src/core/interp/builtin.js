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

import { stdout, stdoutBytes, typeTag, fmtReal, fmtRealG, fmtFixed, fmtSci, fmtGen, reprReal, callJsOp, readText, writeText, spawn, env } from '../host/native.js';
import { JS_ABI, JS_MEMBERS } from '../hir/js_abi.js';
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

/** 被解释程序里没被 catch 住的 throw。前缀和 runtime error 不一样，所以单独一个类 */
export class InterpUncaught extends Error {}

/** 64 位回绕。int 的 + - * << 都要过它（ADR-0005） */
export function W(x) {
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

/** 位当无符号 64 位读（第六十一刀）。与 JS 后端的 `$U`、C 那侧的 `(uint64_t)` 同一件事。 */
export function U(x) {
  return BigInt.asUintN(64, x);
}

function biUdiv(a, b) {
  if (b === 0n) rtError('division by zero');
  return W(U(a) / U(b));
}

function umod(a, b) {
  if (b === 0n) rtError('division by zero');
  return W(U(a) % U(b));
}

/* ---------------------------------------------------------------- 输出
 * 缓冲到 8192 再落盘，和 prelude 的 $print / $print_raw 共用一个缓冲区的做法一致：
 * 直写的那一路不能插到已缓冲、还没落盘的输出前面去。
 *
 * 一个缓冲区**两种口径**（ADR-0017 第八刀第十二片）：asy/jancy 那一路的串是真的
 * JS 串，按 UTF-8 写；C 那一路的串是**一串字节**（一个字符一个字节），按 latin1 写。
 * 混着来的时候切换口径要先把攒着的落盘 —— 顺序比省一次 write 重要。
 * 实际上一次运行只会是其中一种，这几行只是让「万一」也是对的。
 */
let outBuf = '';
let outIsBytes = false;

function outMode(bytes) {
  if (outBuf.length > 0 && bytes !== outIsBytes) flushOut();
  outIsBytes = bytes;
}

function outPut(s) {
  outBuf = outBuf + s;
  if (outBuf.length > 8192) flushOut();
}

function printLine(s) {
  outMode(false);
  outPut(s + '\n');
}

export function printRaw(s) {
  outMode(false);
  outPut(s);
}

/** C 的 `printf` 一族走这儿：攒的是**字节**，落盘时按 latin1 写。 */
export function printBytes(s) {
  outMode(true);
  outPut(s);
}

export function flushOut() {
  if (outBuf.length === 0) return;
  const s = outBuf;
  outBuf = '';
  if (outIsBytes) stdoutBytes(s);
  else stdout(s);
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
        c = 0x10000 + (c - 0xd800) * 1024 + (lo - 0xdc00);
        i = i + 1;
      }
    }
    // 全程乘除取模，一处位运算都没有：码点在 JS 子集里是 real，而封闭 ABI 的 js_bitop
    // 只对 bigint 成立（ADR-0011 决策 2）。写成 `c >> 6` 在 node 上照跑，原生构建里报错 ——
    // 而这一段只有非 ASCII 才走到，所以那种错会藏得很深。
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(0xc0 + bitsAbove(c, 64), 0x80 + c % 64); }
    else if (c < 0x10000) {
      out.push(0xe0 + bitsAbove(c, 4096), 0x80 + bitsAbove(c, 64) % 64, 0x80 + c % 64);
    } else {
      out.push(0xf0 + bitsAbove(c, 262144), 0x80 + bitsAbove(c, 4096) % 64,
        0x80 + bitsAbove(c, 64) % 64, 0x80 + c % 64);
    }
  }
  return out;
}

/** `v >> log2(span)`：整数右移，写成除法。 */
function bitsAbove(v, span) {
  return (v - (v % span)) / span;
}

/**
 * UTF-8 -> 宿主字符串。非法字节按 **WHATWG 的「最大子部分」规则**换成一个 U+FFFD，
 * 而不是一个字节换一个。
 *
 * 为什么要抄这条规则：JS 后端那条腿用的是 `TextDecoder`（见 backend-js/prelude.js 的
 * `$substr`），而解释器要跟它**逐字节相同** —— 那是 js-exec 与主轴上的门槛。
 * 这门语言的 string 是 UTF-8 字节序列、`substr` 按字节，所以「从多字节字符中间切一刀」
 * 是合法操作，非法序列的落法因此不是边角情况，是要对齐的语义。
 *
 * 量过一次：原来这里没有校验，`"中".substr(0,2)` 在解释器上会打印成一个 NUL
 * （`undefined % 64` 是 NaN，`fromCharCode(NaN)` 是 `\0`）—— 既不是 node 的答案，
 * 也不是 C 的答案。C 后端那条腿是第三种：它的字符串就是字节，原样打印出去。
 */
function decodeUtf8(b) {
  let s = '';
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    if (c < 0x80) { s = s + String.fromCharCode(c); i = i + 1; continue; }
    // 起头字节决定长度，也决定**第一个续字节的合法区间**（超长形式、代理项、
    // 超过 U+10FFFF 都靠这张表挡掉，与 TextDecoder 一致）
    let n = 0;
    let cp = 0;
    let lo = 0x80;
    let hi = 0xbf;
    if (c >= 0xc2 && c <= 0xdf) { n = 2; cp = c - 0xc0; }
    else if (c >= 0xe0 && c <= 0xef) {
      n = 3;
      cp = c - 0xe0;
      if (c === 0xe0) lo = 0xa0;
      if (c === 0xed) hi = 0x9f;
    } else if (c >= 0xf0 && c <= 0xf4) {
      n = 4;
      cp = c - 0xf0;
      if (c === 0xf0) lo = 0x90;
      if (c === 0xf4) hi = 0x8f;
    }
    if (n === 0) { s = s + String.fromCharCode(0xfffd); i = i + 1; continue; }
    // 走到哪断在哪：非法子部分整段算一个 U+FFFD，下一轮从断点继续
    let k = 1;
    let bad = false;
    while (k < n && !bad) {
      const x = i + k < b.length ? b[i + k] : -1;
      if (x < lo || x > hi) bad = true;
      else { cp = cp * 64 + x % 64; lo = 0x80; hi = 0xbf; k++; }
    }
    if (bad) { s = s + String.fromCharCode(0xfffd); i = i + k; continue; }
    i = i + n;
    if (cp >= 0x10000) {
      const v = cp - 0x10000;
      // fromCharCode 在这里只传一个实参：多实参不在语言子集里
      s = s + String.fromCharCode(0xd800 + bitsAbove(v, 1024)) + String.fromCharCode(0xdc00 + v % 1024);
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

/** `(supper S)`：**只**把 ASCII 的 a-z 换成大写。与 omni_str_upper / $str_upper 同一份。 */
function asciiUpper(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += (c >= 97 && c <= 122) ? String.fromCharCode(c - 32) : s[i];
  }
  return out;
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

export function listGet(a, i) {
  const n = Number(i);
  if (n < 0 || n >= a.length) {
    rtError('list index out of range: ' + n + ' (length ' + a.length + ')');
  }
  return a[n];
}

export function listSet(a, i, v) {
  const n = Number(i);
  if (n < 0 || n >= a.length) {
    rtError('list index out of range: ' + n + ' (length ' + a.length + ')');
  }
  a[n] = v;
  return v;
}

export function dictGet(m, k) {
  if (!m.has(k)) rtError('key not found: ' + keyStr(k));
  return m.get(k);
}

/* ---------------------------------------------------------------- 缓冲
 * 门槛 7 第一阶段：一段连续的 int/real + 一个长度。宿主表示是普通数组。
 * 越界的消息与 list 同一个形状 —— 六条腿要逐字节一致，而 list 那句已经在
 * 三份实现里对齐过了，照它写就不必再对一次。
 * GPU 上没有这条错误路径（约定是 kernel 自己用 blen 守门），所以 CPU 这几条腿
 * 报错正是想要的：越界要在 CPU 上暴露，而不是在设备上变成随机内存。
 */
export function bufNew(kind, n) {
  const len = Number(n);
  if (len < 0) rtError('buffer length cannot be negative: ' + len);
  const zero = kind === 'int' ? 0n : 0;
  const out = [];
  for (let i = 0; i < len; i++) out.push(zero);
  return out;
}

export function bufGet(a, i) {
  const n = Number(i);
  if (n < 0 || n >= a.length) {
    rtError('buffer index out of range: ' + n + ' (length ' + a.length + ')');
  }
  return a[n];
}

export function bufSet(a, i, v) {
  const n = Number(i);
  if (n < 0 || n >= a.length) {
    rtError('buffer index out of range: ' + n + ' (length ' + a.length + ')');
  }
  a[n] = v;
  return v;
}

/* ---------------------------------------------------------------- 指针
 * ADR-0016。这条腿是**模拟指针**：一个 ArrayBuffer 当 arena，"地址"就是里面的偏移。
 * 与 backend-js 的 prelude 是**同一套算法**（同样从 8 起、同样按 8 对齐、同样倍增），
 * 但那份是拼进产物里的字符串、这份是宿主函数，没法共用一份代码 —— 所以四条错误消息
 * 逐字节抄过来，tests/sexpr 那一轴的判据（五条腿逐字节相同）就是在盯这件事。
 *
 * 地址从 8 而不是 0 起：0 留给空指针，这样 `p == null` 只是比一个数。
 *
 * fat 指针的宿主表示是三元数组 `[addr, base, end]`（end 右开）。它是值类型，
 * 但 copyOf 不拷它 —— 因为这里任何操作（padd/pfield）都**产生新数组**、从不原地改，
 * 共享同一个数组和拷一份不可区分。thin 指针就是一个数。
 */
let ptrMem = null;
let ptrDv = null;
let ptrTop = 8;

function ptrGrow(need) {
  let cap = ptrMem.byteLength;
  while (cap < need) cap *= 2;
  if (cap === ptrMem.byteLength) return;
  const nb = new ArrayBuffer(cap);
  new Uint8Array(nb).set(new Uint8Array(ptrMem));
  ptrMem = nb;
  ptrDv = new DataView(ptrMem);
}

export function ptrNew(count, size) {
  const n = Number(count);
  if (n < 0) rtError('pointer allocation count cannot be negative: ' + n);
  if (ptrMem === null) { ptrMem = new ArrayBuffer(1 << 16); ptrDv = new DataView(ptrMem); }
  const bytes = n * size;
  ptrGrow(ptrTop + bytes);
  const a = ptrTop;
  ptrTop += bytes;
  if (ptrTop % 8 !== 0) ptrTop += 8 - ptrTop % 8;
  new Uint8Array(ptrMem, a, bytes).fill(0);  /* 用户代码碰到之前每一格都是零 */
  return [a, a, a + bytes];
}

/** fat 的解引用检查：查空、查范围，回地址。越界按**元素**报（裸地址在两套实现里不同）。 */
export function ptrChk(p, size) {
  if (p[0] === 0) rtError('null pointer dereference');
  if (p[0] < p[1] || p[0] + size > p[2]) {
    rtError('pointer out of bounds: ' + Math.floor((p[0] - p[1]) / size)
      + ' (range ' + Math.floor((p[2] - p[1]) / size) + ')');
  }
  return p[0];
}

/** thin 的解引用检查：只有查空 —— 范围已经丢了，这就是它要写在 (unsafe …) 里的理由。 */
export function ptrTChk(a) {
  if (a === 0) rtError('null pointer dereference');
  return a;
}

// kind 是**目标类型**的 k。指针自己也能当目标（ADR-0016 第十六刀）：fat 是三个字
// {addr, base, end}、thin 是一个字，次序与 hir/types.js 那段注释里定的一样。
export function ptrLoad(kind, a) {
  if (kind === 'int') return ptrDv.getBigInt64(a, true);
  if (kind === 'real') return ptrDv.getFloat64(a, true);
  if (kind === 'ptr') {
    return [Number(ptrDv.getBigInt64(a, true)), Number(ptrDv.getBigInt64(a + 8, true)),
      Number(ptrDv.getBigInt64(a + 16, true))];
  }
  if (kind === 'tptr') return Number(ptrDv.getBigInt64(a, true));
  return ptrDv.getUint8(a) !== 0;
}

export function ptrStore(kind, a, v) {
  if (kind === 'int') ptrDv.setBigInt64(a, W(v), true);
  else if (kind === 'real') ptrDv.setFloat64(a, v, true);
  else if (kind === 'ptr') {
    ptrDv.setBigInt64(a, BigInt(v[0]), true);
    ptrDv.setBigInt64(a + 8, BigInt(v[1]), true);
    ptrDv.setBigInt64(a + 16, BigInt(v[2]), true);
  } else if (kind === 'tptr') ptrDv.setBigInt64(a, BigInt(v), true);
  else ptrDv.setUint8(a, v ? 1 : 0);
  return v;
}

export function ptrAdd(p, k, size) {
  return [p[0] + Number(k) * size, p[1], p[2]];
}

export function ptrSub(p, q, size) {
  if (p[1] !== q[1] || p[2] !== q[2]) rtError('pointer difference across different blocks');
  return BigInt((p[0] - q[0]) / size);
}

/* ------------------------------------------------------------ 线性内存
 * ADR-0017 第二刀。**一个模块一块**，按字节寻址，长度是 64KB 页的整数倍 —— 形状照
 * wasm 规范。这一份是两个解释器共用的实现（backend-js 的 prelude 里另有一份同算法的
 * 文本，backend-c/LLVM 走 omni_mem.c）；三份的判据是 tests/sexpr 那一轴：同一段 sx
 * 在五条腿上输出逐字节相同，越界的那句话也逐字节相同。
 *
 * 字节序**固定小端**，不跟宿主走：DataView 的每次调用都显式传 `true`。wasm 规定小端，
 * 而 C 那条腿上是 memcpy 到本机字节序 —— 本机是大端的机器上这两条会分叉，所以那一天
 * 到来时要改的是 C 那边（做一次字节翻转），不是这里。
 *
 * 地址与偏移分两个参数收（不是加好了再传）：静态偏移是描述符里的常量，越界检查要按
 * `addr + off` 算，而"是 addr 太大还是 off 太大"在报错文本里要能分辨。
 */
let linMem = null;
let linDv = null;
let linBy = null;
let linMaxPages = 0;     // 0 = 不设上界（实际天花板是 wasm32 的 65536 页 = 4GB）

/** 一页 64KB。与 mir/ir.js 的 MEM_PAGE 是同一个数 —— 这一份不从那儿 import，
 *  因为 OIR 这一层不许依赖 MIR（两个解释器一个在 MIR 上、一个在 OIR 上）。 */
const LIN_PAGE = 65536;

/** 声明内存。`(memory MIN MAX)` 在模块的入口处调一次；重复调是降级器的 bug。 */
export function memInit(minPages, maxPages) {
  linMem = new ArrayBuffer(minPages * LIN_PAGE);
  linDv = new DataView(linMem);
  linBy = new Uint8Array(linMem);
  linMaxPages = maxPages;
}

/** 拷一段 data 段进去。越界是编译期就能算出来的错，所以这里冒的是运行期错误兜底。 */
export function memData(off, bytes) {
  if (linMem === null) rtError('memory access without a memory');
  if (off < 0 || off + bytes.length > linMem.byteLength) {
    rtError('data segment does not fit in memory: ' + off + '+' + bytes.length
      + ' (size ' + linMem.byteLength + ')');
  }
  linBy.set(bytes, off);
}

export function memSize() { return BigInt(linMem === null ? 0 : linMem.byteLength / LIN_PAGE); }

/** 只增不减，回**旧**页数；加不了回 -1（wasm 的约定 —— 不抛错，让调用方查）。 */
export function memGrow(n) {
  if (linMem === null) rtError('memory access without a memory');
  const add = Number(n);
  const old = linMem.byteLength / LIN_PAGE;
  if (add < 0) return -1n;
  const want = old + add;
  if (want > 65536) return -1n;
  if (linMaxPages !== 0 && want > linMaxPages) return -1n;
  if (add === 0) return BigInt(old);
  const nb = new ArrayBuffer(want * LIN_PAGE);
  new Uint8Array(nb).set(linBy);
  linMem = nb;
  linDv = new DataView(linMem);
  linBy = new Uint8Array(linMem);
  return BigInt(old);
}

/** 越界检查。回的是**算好的字节地址**，于是每条访问只算一次加法。 */
function memChk(addr, off, bytes) {
  if (linMem === null) rtError('memory access without a memory');
  const a = Number(addr) + off;
  if (a < 0 || a + bytes > linMem.byteLength) {
    rtError('memory access out of bounds: ' + a + '+' + bytes
      + ' (size ' + linMem.byteLength + ')');
  }
  return a;
}

/* 读侧九种、写侧六种，名字与 mir/ir.js 的 MLOAD_KINDS / MSTORE_KINDS 逐字相同。
 * 整数一律以 **i64 的宿主表示（BigInt）** 出入：方言只有一格整数，`i8s` 是"读一个字节、
 * 符号扩展到 64 位"，`i8u` 是"读一个字节、零扩展"。浮点是 Number；`f32` 读出来是那个
 * 单精度值在 double 里的精确表示（getFloat32 已经做到了），写进去按单精度舍入。 */
const MEM_LD = {
  i8s: (a, o) => BigInt(linDv.getInt8(memChk(a, o, 1))),
  i8u: (a, o) => BigInt(linDv.getUint8(memChk(a, o, 1))),
  i16s: (a, o) => BigInt(linDv.getInt16(memChk(a, o, 2), true)),
  i16u: (a, o) => BigInt(linDv.getUint16(memChk(a, o, 2), true)),
  i32s: (a, o) => BigInt(linDv.getInt32(memChk(a, o, 4), true)),
  i32u: (a, o) => BigInt(linDv.getUint32(memChk(a, o, 4), true)),
  i64: (a, o) => linDv.getBigInt64(memChk(a, o, 8), true),
  f32: (a, o) => linDv.getFloat32(memChk(a, o, 4), true),
  f64: (a, o) => linDv.getFloat64(memChk(a, o, 8), true),
};
const MEM_ST = {
  i8: (a, o, v) => { linDv.setUint8(memChk(a, o, 1), Number(BigInt.asUintN(8, v))); },
  i16: (a, o, v) => { linDv.setUint16(memChk(a, o, 2), Number(BigInt.asUintN(16, v)), true); },
  i32: (a, o, v) => { linDv.setUint32(memChk(a, o, 4), Number(BigInt.asUintN(32, v)), true); },
  i64: (a, o, v) => { linDv.setBigInt64(memChk(a, o, 8), BigInt.asIntN(64, v), true); },
  f32: (a, o, v) => { linDv.setFloat32(memChk(a, o, 4), v, true); },
  f64: (a, o, v) => { linDv.setFloat64(memChk(a, o, 8), v, true); },
};

/** 编译期选一次的入口：MIR 那条腿在造闭包时调它，于是每次访问不再查表。 */
export function memLoadFn(kind) {
  const f = MEM_LD[kind];
  if (f === undefined) throw new Error(`memLoadFn: 不认识的访问 ${kind}`);
  return f;
}
export function memStoreFn(kind) {
  const f = MEM_ST[kind];
  if (f === undefined) throw new Error(`memStoreFn: 不认识的访问 ${kind}`);
  return f;
}

/* -------------------------------------------- **number 口径**的那一组（ADR-0013）
 * 同一块内存、同一个 `memChk`、同一个字节序，只差「整数以什么装出入」：上面那两张表
 * 一律 BigInt（方言只有一格整数，i64），这两张按 **JS number** 收发。
 *
 * 为什么要加这一组而不是在调用点换算：`emit_js.js` 发出来的 JS 里 i32 是 number
 * （那是 ADR-0013 量出来的量级来源），而 `BigInt(v)` / `Number(v)` 每次访问都要一次
 * 转换 —— 内存密集的程序里那就是主要成本，加这一组正是为了把它去掉。
 *
 * 边界划在哪儿：**只有 32 位及以下**（i8/i16/i32）进这一组，i64 仍旧只有 BigInt 那一份
 * （number 装不下 64 位）。浮点两条本来就是 number，这里不重复列 —— 调用方直接用上面那张。
 */
const MEM_LD_N = {
  i8s: (a, o) => linDv.getInt8(memChk(a, o, 1)),
  i8u: (a, o) => linDv.getUint8(memChk(a, o, 1)),
  i16s: (a, o) => linDv.getInt16(memChk(a, o, 2), true),
  i16u: (a, o) => linDv.getUint16(memChk(a, o, 2), true),
  i32s: (a, o) => linDv.getInt32(memChk(a, o, 4), true),
  /* `i32u` 的结果类型是 i32（规范形是符号扩展过的），所以读回来要折成有符号 ——
   * 与 BigInt 那张表里 `asIntN(32)` 收尾是同一件事。**不用 `| 0` / `>>> 0`**：
   * 那两个运算符不在封闭子集里（编译器自己的源码要能被自己编译），而算术等价。 */
  i32u: (a, o) => {
    const x = linDv.getUint32(memChk(a, o, 4), true);
    return x > 2147483647 ? x - 4294967296 : x;
  },
};
const MEM_ST_N = {
  i8: (a, o, v) => { linDv.setUint8(memChk(a, o, 1), v & 0xff); },
  i16: (a, o, v) => { linDv.setUint16(memChk(a, o, 2), v & 0xffff, true); },
  /* `setUint32` 收的是无符号，而 i32 的规范形是有符号 —— 这一句是那次换算
   * （与 BigInt 那张的 `asUintN(32)` 对应）。同样不用 `>>> 0`。 */
  i32: (a, o, v) => { linDv.setUint32(memChk(a, o, 4), v < 0 ? v + 4294967296 : v, true); },
};

/** number 口径的读；不在这一组里（i64/f32/f64/f80）回 null，让调用方退回 BigInt 那张。 */
export function memLoadFnN(kind) {
  const f = MEM_LD_N[kind];
  return f === undefined ? null : f;
}
export function memStoreFnN(kind) {
  const f = MEM_ST_N[kind];
  return f === undefined ? null : f;
}
/** 树遍历那条腿（interp/eval.js）的入口：一次调用一次查表。 */
export function memLoad(kind, addr, off) { return memLoadFn(kind)(addr, off); }
export function memStore(kind, addr, off, v) { memStoreFn(kind)(addr, off, v); return v; }

/* ---------------------------------------------------------------- 数组
 * 门槛 2 第四刀：可增长的引用语义数组（asy 的 `T[]`）。宿主表示同样是普通数组 ——
 * push/pop 都是现成的，别名天然共享。零值由**调用方**给（OIR 的 ArrNew 挂着一个零值
 * 子节点），这里不按类型猜：那样这份代码就得知道四种元素各自的零长什么样，
 * 而 C 那条腿的签名本来就是"零值当参数"。
 * 越界与空 pop 的消息与 omni_arr.c 逐字相同 —— 五条腿要逐字节一致。
 */
export function arrNew(n, zero, cp) {
  const len = Number(n);
  if (len < 0) rtError('array length cannot be negative: ' + len);
  const out = [];
  for (let i = 0; i < len; i++) out.push(arrCopy(zero, cp));
  return out;
}

/** 向量元素存进数组前要拷一份：向量是值类型，C/LLVM 那两条腿存的是 16 字节副本，
 *  而 JS 侧一个向量就是一个 JS 数组，直接存进去是别名。
 *  拷不拷由**调用方按元素的静态类型**给（`cp`）—— 多维数组那一刀之后"元素在 JS 侧是数组"
 *  有两种意思了：向量（值语义，要拷）与行（引用语义，拷了就与 C/LLVM 分叉）。
 *  名字带 arr 前缀：模块级名字全仓唯一。 */
export function arrCopy(v, cp) { return cp === true && Array.isArray(v) ? v.slice() : v; }

/** 数组句柄可以是 null —— 多维数组的行（`(anew (arr (arr T)) 3)` 之后每行都还没构造）。
 *  五条腿都要在这里冒同一句话：C 侧是 omni_arr.c 每个操作开头的 omni_nullck，
 *  JS 后端是 prelude 的 $nullCheck。不查的话宿主自己会冒 TypeError / 段错误。 */
export function arrNullck(a) {
  if (a === null || a === undefined) rtError('null reference');
  return a;
}

export function arrLen(a) {
  arrNullck(a);
  return BigInt(a.length);
}

export function arrGet(a, i) {
  arrNullck(a);
  const n = Number(i);
  if (n < 0 || n >= a.length) {
    rtError('array index out of range: ' + n + ' (length ' + a.length + ')');
  }
  return a[n];
}

export function arrSet(a, i, v, cp) {
  arrNullck(a);
  const n = Number(i);
  if (n < 0 || n >= a.length) {
    rtError('array index out of range: ' + n + ' (length ' + a.length + ')');
  }
  a[n] = arrCopy(v, cp);
  return v;
}

export function arrPush(a, v, cp) { arrNullck(a); a.push(arrCopy(v, cp)); return v; }

export function arrPop(a) {
  arrNullck(a);
  if (a.length === 0) rtError('pop from empty array');
  return a.pop();
}

/** dynamic 的标签名。这一条是封闭 ABI 里的 js_type_tag —— `instanceof Map` 不在语言
 *  子集里（ADR-0011 决策 15），而 C 侧本来就有标签，所以只能走宿主 op。
 *
 *  Map/Set 要翻一下：解释器自己的容器在 node 上就是宿主的 Map/Set，降级成 C 之后带的是
 *  **JS 域**的 Map/Set 标签；而被解释的程序看到的必须是 Omni 域的 dict/set。不翻的话
 *  同一个程序在两个宿主上会走进不同分支（实测：原生构建上 dict 被认成 Map 而报错）。 */
export function dynTag(v) {
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
    // 向量：每道一个标量的普通数组（与 VecSplat 的求值结果同一种东西）。
    // 这一条是结构体的向量字段（第十五刀）逼出来的 —— 零值要能一层层递归下去。
    case 'vec': {
      const out = [];
      for (let i = 0; i < t.lanes; i++) out.push(zeroOf(t.elem, I));
      return out;
    }
    // 数组：**空数组**，不是空引用（与 hir/types.js 的 ArrNew 零值同一条规矩：
    // alen/apush 在任何数组上都得能用）。第十六刀的结构体数组字段走这里。
    case 'arr': return [];
    case 'dict': return new Map();
    case 'set': return new Set();
    // 指针的零值是空指针（ADR-0016）。fat 是三个零，thin 是一个零 —— 这一条是
    // 结构体的指针字段要的：`p == null` 在两条腿上都得是"比一个数"。
    case 'ptr': return [0, 0, 0];
    case 'tptr': return 0;
    // 定长内存的字段（第二十二刀）。与 JS 后端那一格同一句话：观察不到 —— 结构体整块读写
    // 方言不给，`(fld …)` / `(fldset …)` 在 blk 字段上当场拒，内嵌那 N 格只能经
    // `(pfield …)` 在 arena 的字节里碰。留一格 N 个零，是为了"逐字段铺零"处处有东西可写。
    case 'blk': {
      const out = [];
      for (let i = 0; i < t.n; i++) out.push(zeroOf(t.el, I));
      return out;
    }
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
    case 'Bin': {
      const a = I.eval(e.left, env, frame);
      const b = I.eval(e.right, env, frame);
      // 向量是逐道做同一条标量运算（ADR-0014 决策 6）。刻意复用 binOp 而不另写一份
      // int/real 的语义：回绕、除零的消息、`%` 的符号 —— 那些必须和标量**同一份代码**，
      // 否则「向量道上的 int」和「标量 int」会在某个边界上分叉。
      if (e.opType.k === 'vec') return vecBinOp(e.op, e.opType, a, b);
      return binOp(e.op, e.opType.k, a, b);
    }
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
    // 外部 C 符号（ADR-0014 决策 4）：解释器里过不去。名字要到运行期才知道，
    // 而按名字查一张 C 函数指针表需要每条 op 的签名都一样 —— C_ABI 的签名恰恰各不相同
    // （这和 js_asFn 过不了 dynamic 边界是同一类问题，见 ADR-0013 决策 5）。
    // 报错而不是给个错答案：解释执行是 oracle，它不该假装能做 FFI。
    case 'CCall':
      failRt(`interp: C ABI call '${e.entry}' is not supported by the interpreter`);
      return undefined;
    default: throw new OmniError(`interp.expr: ${e.kind}`);
  }
}

/** 比较。静态那半边的类型已经定好了，所以宿主的 === / < 就是对的语义。
 *  `u<` 那四个是无符号那一版（第六十一刀）：两边的位当无符号 64 位读，比法照旧。 */
export function cmpOp(op, a, b) {
  switch (op) {
    case 'u<': return U(a) < U(b);
    case 'u<=': return U(a) <= U(b);
    case 'u>': return U(a) > U(b);
    case 'u>=': return U(a) >= U(b);
    case '==': return a === b;
    case '!=': return a !== b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    default: throw new OmniError(`interp.cmp: ${op}`);
  }
}

export function binOp(op, kind, a, b) {
  if (kind === 'int') {
    switch (op) {
      case '+': return W(a + b);
      case '-': return W(a - b);
      case '*': return W(a * b);
      case '/': return idiv(a, b);
      case '%': return imod(a, b);
      case '<<': return W(a << (b & 63n));
      case '>>': return a >> (b & 63n);
      // 无符号那三个（第六十一刀）
      case 'u/': return biUdiv(a, b);
      case 'u%': return umod(a, b);
      case 'u>>': return W(U(a) >> (b & 63n));
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

/**
 * 向量的逐元素运算。宿主表示是一条长度 = 宽度的普通数组，每道一个标量 ——
 * 解释器是 oracle，要的是「每道的答案和标量运算逐位相同」，不是速度。
 */
export function vecBinOp(op, t, a, b) {
  const out = [];
  for (let i = 0; i < t.lanes; i++) out.push(binOp(op, t.elem.k, a[i], b[i]));
  return out;
}

/**
 * 水平求和，**严格左到右**：((v0+v1)+v2)+v3。浮点加法不结合，所以这条顺序是
 * ADR-0014 门槛 6 的落点：六个执行器都得发这一棵树，谁改成两两配对就会被
 * tests/sexpr/cases/03-simd.sx 最后一行抓住。
 */
export function vecHsum(t, v) {
  let acc = v[0];
  for (let i = 1; i < t.lanes; i++) acc = binOp('+', t.elem.k, acc, v[i]);
  return acc;
}

/** 核心方言的 `(rmath "NAME" …)` -> js_math 的 op 码（js_abi.js 那张表里注着） */
const RMATH_OP = new Map([
  ['rmath_sqrt', 's'], ['rmath_fabs', 'a'], ['rmath_floor', 'f'], ['rmath_ceil', 'c'],
  ['rmath_round', 'r'], ['rmath_pow', 'p'], ['rmath_fmod', 'o'],
  ['rmath_sin', 'S'], ['rmath_cos', 'C'], ['rmath_tan', 'T'], ['rmath_asin', 'I'],
  ['rmath_acos', 'A'], ['rmath_atan', 'N'], ['rmath_atan2', '2'],
  ['rmath_sinh', 'H'], ['rmath_cosh', 'D'], ['rmath_tanh', 'G'],
  ['rmath_asinh', 'J'], ['rmath_acosh', 'K'], ['rmath_atanh', 'L'],
  ['rmath_exp', 'E'], ['rmath_expm1', 'X'], ['rmath_log', 'O'],
  ['rmath_log10', 'Q'], ['rmath_log1p', 'P'], ['rmath_cbrt', 'B'], ['rmath_hypot', 'Y'],
  /* 那个「C99 ∩ Math.*」交集的例外（ADR-0019 路 2）：'W' 那一支在 prelude 里是手写的。 */
  ['rmath_nextafter', 'W'],
]);

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
  return applyBuiltin(I, e, a);
}

/**
 * 内建的**值层**入口：实参已经求好了，节点只当描述符用（读 name / recvType / argType /
 * lit 字段，以及把解析结果缓存回去）。
 *
 * 拆出来是给 MIR 解释器用的（ADR-0014 决策 7）：它手里没有 OIR 节点，但可以在**装载期**
 * 为每条 `CALLOP` 造一个一次性的描述符对象，于是下面那些挂在节点上的负缓存照样成立 ——
 * 「分派只付一次」这条对两个解释器同时生效。语义只有这一份，不会分叉。
 */
export function applyBuiltin(I, e, a) {
  // 负缓存（第一次落到默认支时打上）。JS 程序里几乎每条 Builtin 都是 JS 域的 op，而下面
  // 这个 switch 是顺着比字符串比过去的 —— 每次都白比一百来次才到默认支。量过：原生构建上
  // builtinOp 自己就占 22%。节点是可写的（OIR 在两代产物里都是普通对象/dict），缓存就挂在
  // 节点上，一个节点只解析一次。
  if (e.jsop === true) return jsOp(I, e, a);
  const recv = e.recvType;
  // real 上的数学函数。刻意走 js_math 那条宿主 op（prelude 的 $js_math / runtime 的
  // omni_js_math），而不是在这里再写一份：`round` 的舍入方向、`fmod` 的符号这些
  // 差别只该在一处定下来。名单由核心方言把关（sexpr/lower.js 的 RMATH）。
  if (RMATH_OP.has(e.name)) {
    return callJsOp('js_math', [RMATH_OP.get(e.name), a[0], a.length > 1 ? a[1] : 0]);
  }
  switch (e.name) {
    case 'print': printLine(strOf(e.argType.k, a[0])); return undefined;
    // `(write E)` —— 不补换行（ADR-0016 第四刀）。与 print 共用同一个缓冲区，
    // 否则直写的那段会插到已经缓冲、还没落盘的输出前面去。
    case 'write': printRaw(a[0]); return undefined;
    // `(srep S N)` —— 重复（ADR-0016 第五刀）。n <= 0 回空串：JS 的 String.repeat 在
    // 负数上抛异常，而"宽度补到至少 N 个字符"里 max(0, N - 长度) 常常是 0 或负数，
    // 那是正常情形。夹在这里，与 omni_str_repeat 同一套语义。
    case 'str_repeat': return Number(a[1]) <= 0 ? '' : a[0].repeat(Number(a[1]));
    // `(sbase E 进制)` —— **E 的位当无符号 64 位读**（C 的 `%x` 的规矩），数字小写。
    // BigInt.toString(radix) 给的就是 `0-9a-z`，与 omni_str_base 的那张表同一套。
    case 'str_base': return (a[0] < 0n ? a[0] + (1n << 64n) : a[0]).toString(Number(a[1]));
    // `(supper S)` —— **只动 ASCII 的 a-z**。不用 toUpperCase()：那是 Unicode 的
    // （"ß" 会变成两个字符），C 那侧的 toupper 还看 locale，两条路对不上。
    case 'str_upper': return asciiUpper(a[0]);
    // `(sfix E N)` —— C 的 `%.Nf`，**就近取偶**（不是 JS 的 toFixed，那在恰好一半上进位）。
    // 位数不必是字面量（第二十八刀），所以范围这一条落在这儿查：五条腿同一句话。
    case 'str_fixed':
      if (a[1] < 0n || a[1] > 30n) rtError(`sfix precision out of range: ${a[1]} (0..30)`);
      return fmtFixed(a[0], a[1]);
    // `(ssci E N)` —— C 的 `%.Ne`（第三十刀）。范围与舍入同上，只是小数点固定在第一位后面。
    case 'str_sci':
      if (a[1] < 0n || a[1] > 30n) rtError(`ssci precision out of range: ${a[1]} (0..30)`);
      return fmtSci(a[0], a[1]);
    // `(sgen E N)` / `(sgenk E N)` —— C 的 `%.Ng` / `%#.Ng`（第三十一刀）。差别是那个 `#`：
    // 后者**不去尾随零**。范围与上面两条同 0..30，两个名字各报自己那一句。
    case 'str_gen':
      if (a[1] < 0n || a[1] > 30n) rtError(`sgen precision out of range: ${a[1]} (0..30)`);
      return fmtGen(a[0], a[1], false);
    case 'str_genk':
      if (a[1] < 0n || a[1] > 30n) rtError(`sgenk precision out of range: ${a[1]} (0..30)`);
      return fmtGen(a[0], a[1], true);
    case 'to_string': return strOf(e.argType.k, a[0]);
    case 'to_string_g': return fmtRealG(a[0], a[1]);
    case 'trunc': return truncReal(a[0]);
    /* 位重解释（ADR-0019 路 1）：位不动，只换一种读法。int 在这条腿上是 BigInt，
     * getBigInt64/setBigInt64 正好是 int64 那一格 —— 两个方向都不用再截，也不用查范围
     * （每个 f64 的位模式都是一个合法 int64）。 */
    case 'realbits': {
      const rbv = new DataView(new ArrayBuffer(8));
      rbv.setFloat64(0, a[0]);
      return rbv.getBigInt64(0);
    }
    case 'bitsreal': {
      const rbv = new DataView(new ArrayBuffer(8));
      rbv.setBigInt64(0, a[0]);
      return rbv.getFloat64(0);
    }

    case 'chr': return chrOf(a[0]);
    case 'fail': rtError(a[0]); return undefined;
    case 'repr': return reprOf(a[0]);
    case 'int_of_string': return intOfString(a[0]);
    case 'real_of_string': return realOfString(a[0]);
    // `(readtext E)`：整份读一份文本文件。三条腿一份语义（JS 那边 $read_text、
    // C 那边 omni_read_text）—— 读不到就是运行期错误，不回空串。
    case 'read_text': return readTextOrFail(a[0]);
    // `(r3render PATH)`：三维那一档的光栅化。**权威在 C**（runtime/omni_r3.c，照
    // reference 的 glrender.cc/renderBase.cc 与两份 glsl 转写）。这条腿（JS 宿主）暂时
    // 回空串 = "这儿没有光栅化器"，调用方（asy 侧的 asy__r3hexfn）会走 gs 那条旧路。
    // 等 C 那份定稿再照抄成 JS，届时两边要逐字节对上。
    case 'r3_render': return '';
    // `(getenv E)`：读宿主的一格环境设置。没设就是空串 —— 三条腿一份语义
    // （$get_env / omni_get_env）。asy 的输出格式走的是这一格（ADR-0015）。
    case 'get_env': {
      const ev = env(a[0]);
      return ev === undefined || ev === null ? '' : ev;
    }
    // `(writetext P E)` / `(runproc CMD)`：另外两个"对外面"的口子。语义与 JS/C 两侧一字不差。
    case 'write_text': return writeTextOrFail(a[0], a[1]);
    case 'run_proc': return runProc(a[0]);
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
      // 降级后的 JS 用的是宿主库那批 op（ADR-0011）。不在这里重新实现 —— 按名字调到宿主
      // 自己的那一份去（js_call_op），见下面 jsOp 与 ADR-0013 决策 5。
      e.jsop = true;
      return jsOp(I, e, a);
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

/** `(readtext E)`：读不到就是运行期错误（与 $read_text / omni_read_text 同一条语义） */
function readTextOrFail(p) {
  try {
    return readText(p);
  } catch (e) {
    rtError(`cannot read '${p}': ${e && e.code !== undefined ? e.code : String(e)}`);
    return '';
  }
}

/** `(writetext P E)`：写不下去就是运行期错误。回写进去的字节数（UTF-8 的字节数，不是码点数） */
function writeTextOrFail(p, t) {
  try {
    writeText(p, t);
  } catch (e) {
    rtError(`cannot write '${p}': ${e && e.code !== undefined ? e.code : String(e)}`);
  }
  return BigInt(new TextEncoder().encode(t).length);
}

/**
 * `(runproc CMD)`：`/bin/sh -c CMD`，回退出码。子进程的两个流**全捕获后丢掉** ——
 * 这一层的 stdout 是图本身（asy 的 EPS 就在上面），latex 的絮絮叨叨混进去会把图弄坏。
 * 跑不起来（没这个程序）也回非 0，不抛 —— 调用方要能"试一下，不行就走别的路"。
 */
function runProc(cmd) {
  try {
    return BigInt(spawn('/bin/sh', ['-c', cmd], 'c')[0]);
  } catch (e) {
    return 127n;
  }
}

/* ------------------------------------------------------ JS 域的 op（ADR-0013 决策 5）
 * 降级后的 JS 用的是宿主库那批 op（ADR-0011）。这里一条都**不重新实现**：按名字调到
 * 宿主自己的那一份去（js_call_op），于是"解释执行"与"编译成 JS/C 再执行"用的是同一份
 * 代码，往 JS_ABI 表里加一条 op 自动就进了解释器。
 */

// 被解释程序的待决错误（ADR-0007 的那套：标志 + 普通跳转）。刻意**不**用宿主那一个 ——
// 原生构建里解释器自己就是编译出来的代码，它的 throw 用的正是宿主那个全局标志，共用会让
// 被解释程序的一次 throw 把解释器自己的控制流也带走。
let pendingVal = undefined;
let pendingSet = false;

function jsOp(I, e, a) {
  // 解析结果挂在节点上（imem：成员描述符，null 表示"不是成员"；iabi/ilits：直调那一路）。
  // 表查询本身在原生构建上是带哈希的 dict 取值，每次 op 调用查三次就成了热点。
  const cached = e.imem;
  if (cached !== undefined) {
    if (cached !== null) return memberOp(cached, a);
    return invoke(e.name, e.iabi, e.ilits.length > 0 ? e.ilits.concat(a) : a);
  }
  switch (e.name) {
    case 'js_throw': pendingVal = a[0]; pendingSet = true; return undefined;
    case 'js_pending': return pendingSet;
    case 'js_take_pending': return takePending();
    case 'js_check_uncaught': {
      if (!pendingSet) return undefined;
      const v = takePending();
      flushOut();
      throw new InterpUncaught(jsErrText(v));
    }
    // 输出的两条 op 落在解释器自己的缓冲上，不走宿主的那一份。宿主的缓冲和这边的是
    // 两个缓冲区，谁先落盘由冲刷时机决定 —— 交错就分叉了。字符串化仍然只有一份（js_str）。
    case 'js_println': printLine(callJsOp('js_str', [a[0]])); return undefined;
    case 'js_proc_stdout_write': printRaw(callJsOp('js_str', [a[0]])); return undefined;
    default: break;
  }
  const mem = JS_MEMBERS[e.name];
  if (mem !== undefined) {
    e.imem = mem;
    return memberOp(mem, a);
  }
  const abi = JS_ABI[e.name];
  if (abi === undefined) throw new OmniError(`interp: no such op '${e.name}'`);
  if (abi.raw === true) throw new OmniError(`interp: op '${e.name}' is not callable by name`);
  // lit 是编译期常量，排在实参前面 —— 和两个后端的发射器同一套（emit.js 的 builtin）
  const lits = [];
  for (const k of abi.lit ?? []) lits.push(e[k]);
  e.iabi = abi;
  e.ilits = lits;
  e.imem = null;
  return invoke(e.name, abi, lits.length > 0 ? lits.concat(a) : a);
}

function takePending() {
  if (!pendingSet) return undefined;
  pendingSet = false;
  const v = pendingVal;
  pendingVal = undefined;
  return v;
}

/**
 * 抛出来的值文本化。异常对象是 { $cls: [类名…], message } 的普通对象（ADR-0011 决策 15），
 * 而 js_str 收不了 dict —— 按 JS 自己的 String(new Error(m)) === "Cls: m" 拼。
 * prelude 里那份同名的是 $js_err_text，两边必须说同一句话。
 */
export function jsErrText(v) {
  // 标签用 typeTag 问，不用 instanceof —— 后者只对 Error 开（ADR-0011 决策 15），
  // 这份源码自己也要被降级
  if (typeTag(v) === 'dict') {
    const cls = v.get('$cls');
    if (typeTag(cls) === 'list' && cls.length > 0) {
      const msg = v.get('message');
      return `${cls[0]}: ${msg === undefined ? '' : callJsOp('js_str', [msg])}`;
    }
  }
  return callJsOp('js_str', [v]);
}

/**
 * REPL 用：一批跑完之后待决槽里还有东西，就是这一批没人接的 throw。
 * 整程序那条路上做这件事的是 js_check_uncaught（后端在入口之后发一句），
 * 而 REPL 的 chunk 里没有那一句 —— 不查的话一批的 throw 就被悄悄吃掉了。
 */
export function jsPendingText() {
  if (!pendingSet) return null;
  return jsErrText(takePending());
}

/**
 * JS 的动态调用（eval.js 的 CallFn 走 js_asFn 那一支）。args 已经是**一条实参表**，
 * 按 ABI 直接交给宿主的 js_call_fn —— 函数值不是函数时的检查和消息都在宿主那一份里。
 */
export function jsCallFn(f, args) {
  flushOut();
  return callJsOp('js_call_fn', [f, args]);
}

/** op 里的运行期错误会直接退出，所以缓冲要先落盘 —— 不然错误消息会跑到正常输出前面 */
function invoke(name, abi, args) {
  flushOut();
  const r = callJsOp(name, args);
  return abi.ret === 'void' ? undefined : r;
}

/**
 * 成员派发（ADR-0011 第 9 节）。表在 hir/js_abi.js，两个后端各自**生成**一份派发器，
 * 解释器这一份是同一张表的第三个读者 —— 是同一套规则的第三次应用，不是第三份语义。
 * 标签口径必须是 JS 域的（Map/Set 而不是 dict/set），所以问的是 js_type_tag 这条 op。
 *
 * 单态内联缓存挂在**描述符**上（不是节点上）：同一个成员名收到的接收者标签几乎总是同一个
 * （`xs.push` 的 xs 一直是 list），命中了就省掉 m.on 与 JS_ABI 两次表查询。标签不同就
 * 重新查一遍再换掉缓存 —— 只是缓存，答案仍然由表决定。
 */
function memberOp(d, a) {
  const m = d.member;
  const tag = callJsOp('js_type_tag', [a[0]]);
  if (tag === d.ctag) {
    const cabi = d.cabi;
    if (cabi === null) return memberFallback(d, m, a);
    const args = d.clits.length > 0 ? d.clits.slice(0) : [];
    for (let i = 0; i < cabi.arity; i++) args.push(a[i]);
    return invoke(d.cop, cabi, args);
  }
  const op = m.on[tag];
  d.ctag = tag;
  if (op !== undefined) {
    const abi = JS_ABI[op];
    const lits = [];
    for (const v of Object.values(m.lit ?? {})) lits.push(v);
    d.cop = op;
    d.cabi = abi;
    d.clits = lits;
    const args = lits.slice(0);
    for (let i = 0; i < abi.arity; i++) args.push(a[i]);
    return invoke(op, abi, args);
  }
  d.cabi = null;
  return memberFallback(d, m, a);
}

/** 表外的接收者：属性就是普通属性，方法就是"取属性再当函数调"（ADR-0011 决策 12） */
function memberFallback(d, m, a) {
  flushOut();
  const got = callJsOp('js_obj_get', [a[0], m.name]);
  if (m.kind === 'prop') return got;
  // 派发器的形参个数是表里的最大值，末尾多出来的 undefined 等于没给 —— 削掉再调
  let n = a.length;
  while (n > 1 && a[n - 1] === undefined) n--;
  const r = callJsOp('js_call_fn', [got, a.slice(1, n)]);
  return d.ret === 'bool' ? callJsOp('js_truthy', [r]) : r;
}








