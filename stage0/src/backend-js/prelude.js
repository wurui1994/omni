// Omni stage0 — JS 后端运行时前奏（prelude）
//
// 这里的每个函数都必须和 C 运行时（runtime/c_runtime.js）逐位等价，包括**错误消息文本**，
// 否则四后端差分测试立刻会红。数值/打印/字符串规格见 docs/adr/0005-value-semantics.md。

export const JS_PRELUDE = String.raw`
const $W = (x) => BigInt.asIntN(64, x);
const $INT_MIN = -(2n ** 63n);

function $rt_error(msg) {
  $flush();  // 先冲刷 stdout，和 C 运行时里 omni_error 的 fflush(stdout) 对齐
  process.stderr.write("omni: runtime error: " + msg + "\n");
  process.exit(70);
}

function $div(a, b) {
  if (b === 0n) $rt_error("division by zero");
  if (a === $INT_MIN && b === -1n) return $INT_MIN;  // 与 C 的溢出行为对齐
  return a / b;
}

function $mod(a, b) {
  if (b === 0n) $rt_error("division by zero");
  if (a === $INT_MIN && b === -1n) return 0n;
  return a % b;
}

function $fmod(a, b) { return a % b; }

// C 的 %.6g，逐字符复刻：-4 <= exp < P 用定点，否则用指数形式；去掉尾随零。
function $fmt_g(x, P) {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const exp = Number(x.toExponential(P - 1).split("e")[1]);
  if (exp >= -4 && exp < P) {
    let s = x.toFixed(Math.max(0, P - 1 - exp));
    if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s;
  }
  const parts = x.toExponential(P - 1).split("e");
  let m = parts[0];
  if (m.indexOf(".") >= 0) m = m.replace(/0+$/, "").replace(/\.$/, "");
  const sign = parts[1][0] === "-" ? "-" : "+";
  const digits = parts[1].replace(/^[+-]/, "").padStart(2, "0");
  return m + "e" + sign + digits;
}

const $fmt_real = (x) => $fmt_g(x, 6);

// 序列化用：取 15/16/17 位里第一个能往返的，两个后端都做同一件事，结果逐位一致。
// 末尾补 ".0"：否则整数值的 real 序列化成 "1000"，再解析回来就变成 int 了 —— 类型往返也要无损。
function $repr_real(x) {
  if (!Number.isFinite(x)) $rt_error("cannot represent non-finite real");
  for (let p = 15; p <= 17; p++) {
    const s = $fmt_g(x, p);
    if (Number(s) === x) return $reprTail(s);
  }
  return $reprTail($fmt_g(x, 17));
}
function $reprTail(s) {
  return (s.indexOf(".") >= 0 || s.indexOf("e") >= 0) ? s : s + ".0";
}

const $str_int = (x) => x.toString();
const $str_real = (x) => $fmt_real(x);
const $str_bool = (x) => (x ? "true" : "false");
const $str_string = (x) => x;

let $out = "";
function $print(s) {
  $out += s + "\n";
  if ($out.length > 8192) { process.stdout.write($out); $out = ""; }
}
function $flush() { if ($out.length) { process.stdout.write($out); $out = ""; } }

const $trunc = (x) => {
  if (!Number.isFinite(x)) $rt_error("cannot convert non-finite real to int");
  const t = Math.trunc(x);
  // 超范围报错，不回绕：C 侧那边 (int64_t) 转换本来就是 UB，而这边 asIntN 会静默回绕，
  // 两个后端只有都报错才对得上。理由见 c_runtime 的 omni_trunc。
  if (t < -9223372036854775808 || t >= 9223372036854775808) {
    $rt_error("real " + $fmt_real(x) + " is out of int range");
  }
  return BigInt(t);
};

// ---------------------------------------------------------------- 字符串
// Omni 的 string 是 **UTF-8 字节序列**：length / byteAt / substr 都按字节。
// JS 里字符串是 UTF-16，所以这里过一层编码，用单条 memo 让循环扫描保持 O(1) 摊还。
const $enc = new TextEncoder();
const $dec = new TextDecoder();
let $memoS = null, $memoB = null;
function $bytes(s) {
  if (s !== $memoS) { $memoS = s; $memoB = $enc.encode(s); }
  return $memoB;
}
function $slen(s) { return BigInt($bytes(s).length); }
function $byteAt(s, i) {
  const b = $bytes(s), n = Number(i);
  if (n < 0 || n >= b.length) $rt_error("string index out of range: " + n + " (length " + b.length + ")");
  return BigInt(b[n]);
}
function $substr(s, start, len) {
  const b = $bytes(s), st = Number(start), ln = Number(len);
  if (st < 0 || ln < 0 || st + ln > b.length) {
    $rt_error("substring out of range: start " + st + ", length " + ln + " (string length " + b.length + ")");
  }
  return $dec.decode(b.slice(st, st + ln));
}
function $indexOf(s, needle) {
  const b = $bytes(s), nb = $enc.encode(needle);
  outer: for (let i = 0; i + nb.length <= b.length; i++) {
    for (let j = 0; j < nb.length; j++) if (b[i + j] !== nb[j]) continue outer;
    return BigInt(i);
  }
  return -1n;
}
function $chr(n) {
  const c = Number(n);
  if (c < 0 || c > 0x10ffff) $rt_error("chr(): code point out of range: " + c);
  return String.fromCodePoint(c);
}
function $int_of_string(s) {
  if (!/^[+-]?[0-9]+$/.test(s)) $rt_error('invalid integer: "' + s + '"');
  const v = BigInt(s);
  if (v < $INT_MIN || v > 0x7fffffffffffffffn) $rt_error('invalid integer: "' + s + '"');
  return v;
}
function $real_of_string(s) {
  if (!/^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(s)) $rt_error('invalid real: "' + s + '"');
  return Number(s);
}
// ---------------------------------------------------------------- 容器
// list -> Array，dict -> Map（插入序，ADR-0006 的硬约束），set -> Set
function $keyStr(k) {
  if (typeof k === "bigint") return k.toString();
  if (typeof k === "number") return $fmt_real(k);
  if (typeof k === "boolean") return k ? "true" : "false";
  return '"' + k + '"';
}
function $listGet(a, i) {
  const n = Number(i);
  if (n < 0 || n >= a.length) $rt_error("list index out of range: " + n + " (length " + a.length + ")");
  return a[n];
}
function $listSet(a, i, v) {
  const n = Number(i);
  if (n < 0 || n >= a.length) $rt_error("list index out of range: " + n + " (length " + a.length + ")");
  a[n] = v;
  return v;
}
function $listPop(a) {
  if (!a.length) $rt_error("pop from empty list");
  return a.pop();
}
function $dictGet(m, k) {
  if (!m.has(k)) $rt_error("key not found: " + $keyStr(k));
  return m.get(k);
}
function $dictSet(m, k, v) { m.set(k, v); return v; }

// ---------------------------------------------------------------- dynamic
// 直接用 JS 原生值：null / boolean / BigInt(int) / number(real) / string / Array / Map
function $dynTag(v) {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean": return "bool";
    case "bigint": return "int";
    case "number": return "real";
    case "string": return "string";
    default: return v instanceof Map ? "dict" : "list";
  }
}
function $dynAs(v, want) {
  const t = $dynTag(v);
  if (t !== want) $rt_error("dynamic value is " + t + ", expected " + want);
  return v;
}
function $dynEq(a, b) {
  const ta = $dynTag(a), tb = $dynTag(b);
  if (ta !== tb) return false;
  if (ta === "list" || ta === "dict") return a === b;  // 引用相等
  return a === b;
}
function $nullCheck(o) {
  if (o === null) $rt_error("null reference");
  return o;
}

// 函数值（ADR-0010）：{ fp, c_* }。fp 是被调函数，c_* 是**按值**捕获的变量。
// 记录自己当第一个实参传进去，与 C 侧的 omni_fn self 是同一套调用约定；
// 捕获绝不依赖 JS 的词法作用域 —— JS 按引用捕获，Omni 按值，靠宿主会两边分叉。
function $callFn(f, ...args) {
  if (f === null) $rt_error("call of a null function value");
  return f.fp(f, ...args);
}

// dynamic 的运行期分派面（ADR-0008 第 5 节的封闭清单）。
// 有了这些，读写 JSON 不需要先 asList()/asDict()，源码里也不需要出现 dyn()。
function $dynGet(v, k) {
  const t = $dynTag(v);
  if (t === "list") {
    if (typeof k !== "bigint") $rt_error("list index must be int, found " + $dynTag(k));
    return $listGet(v, k);
  }
  if (t === "dict") {
    if (typeof k !== "string") $rt_error("dict key must be string, found " + $dynTag(k));
    return $dictGet(v, k);
  }
  $rt_error("cannot index a dynamic value of tag " + t);
}
function $dynSet(v, k, x) {
  const t = $dynTag(v);
  if (t === "list") {
    if (typeof k !== "bigint") $rt_error("list index must be int, found " + $dynTag(k));
    return $listSet(v, k, x);
  }
  if (t === "dict") {
    if (typeof k !== "string") $rt_error("dict key must be string, found " + $dynTag(k));
    return $dictSet(v, k, x);
  }
  $rt_error("cannot index a dynamic value of tag " + t);
}
function $dynLen(v) {
  const t = $dynTag(v);
  if (t === "list") return BigInt(v.length);
  if (t === "dict") return BigInt(v.size);
  if (t === "string") return $slen(v);
  $rt_error("dynamic value of tag " + t + " has no length");
}
function $dynIter(v) {
  const t = $dynTag(v);
  if (t === "list") return v;
  if (t === "dict") return [...v.keys()];
  $rt_error("cannot iterate a dynamic value of tag " + t);
}
function $dynPush(v, x) { $dynAs(v, "list").push(x); }
function $dynHas(v, k) { return $dynAs(v, "dict").has($dynAs(k, "string")); }
function $dynKeys(v) { return [...$dynAs(v, "dict").keys()]; }

`;
