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
// 直接用 JS 原生值：null / boolean / BigInt(int) / number(real) / string / Array / Map，
// 外加两个只由 JS 前端产生的标签（ADR-0011）：undefined，以及函数值（闭包记录）
function $dynTag(v) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  switch (typeof v) {
    case "boolean": return "bool";
    case "bigint": return "int";
    case "number": return "real";
    case "string": return "string";
    default:
      if (v instanceof Map) return "dict";
      if (Array.isArray(v)) return "list";
      return "function";  // 闭包记录 { fp, c_* }
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

// ------------------------------------------------------ JS 前端的运算语义（ADR-0011）
// 每一条都必须和 runtime/omni_js.c 里的 omni_js_* 逐位对应。刻意不直接用宿主的
// 加号 / 小于 / 双等：那样 C 侧就得去模仿 ToPrimitive，而两边模仿不到一起。
// dynamic 里取回函数值。JS 的函数在 Omni 侧只有一个签名 fn(list<dynamic>) -> dynamic，
// 所以取回来直接就能调用，不需要按签名分派。
function $js_asFn(v) {
  const t = $dynTag(v);
  if (t !== "function") $rt_error(t + " is not a function");
  return v;
}
function $js_truthy(v) {
  switch ($dynTag(v)) {
    case "undefined": case "null": return false;
    case "bool": return v;
    case "int": return v !== 0n;
    case "real": return !(v === 0 || Number.isNaN(v));
    case "string": return v.length !== 0;
    default: return true;
  }
}
function $js_typeof(v) {
  const t = $dynTag(v);
  if (t === "null") return "object";
  if (t === "bool") return "boolean";
  if (t === "int") return "bigint";
  if (t === "real") return "number";
  if (t === "string") return "string";
  if (t === "function") return "function";
  if (t === "undefined") return "undefined";
  return "object";
}
function $js_str(v) {
  switch ($dynTag(v)) {
    case "undefined": return "undefined";
    case "null": return "null";
    case "bool": return v ? "true" : "false";
    case "int": return v.toString();
    // JS 语义就是宿主的 Number -> String，直接用；C 侧的 js_num_str 照规范复刻它
    case "real": return String(v);
    case "string": return v;
    default: $rt_error("cannot convert " + $dynTag(v) + " to string");
  }
}
function $js_num2(op, a, b) {
  const ta = $dynTag(a), tb = $dynTag(b);
  const num = (t) => t === "int" || t === "real";
  if (!num(ta) || !num(tb)) $rt_error("cannot apply '" + op + "' to " + ta + " and " + tb);
  if (ta !== tb) $rt_error("cannot mix bigint and number in '" + op + "'");
}
function $js_add(a, b) {
  if ($dynTag(a) === "string" || $dynTag(b) === "string") return $js_str(a) + $js_str(b);
  $js_num2("+", a, b);
  return $dynTag(a) === "int" ? $W(a + b) : a + b;
}
function $js_arith(op, a, b) {
  $js_num2(op, a, b);
  const isInt = $dynTag(a) === "int";
  switch (op) {
    case "-": return isInt ? $W(a - b) : a - b;
    case "*": return isInt ? $W(a * b) : a * b;
    case "/": return isInt ? $div(a, b) : a / b;
    case "%": return isInt ? $mod(a, b) : $fmod(a, b);
    default: $rt_error("unknown arithmetic op '" + op + "'");
  }
}
function $js_neg(a) {
  const t = $dynTag(a);
  if (t === "int") return $W(-a);
  if (t === "real") return -a;
  $rt_error("cannot negate " + t);
}
function $js_bitop(op, a, b) {
  const ta = $dynTag(a), tb = $dynTag(b);
  if (ta !== "int" || tb !== "int") {
    $rt_error("bitwise '" + op + "' requires bigint operands, found " + ta + " and " + tb);
  }
  switch (op) {
    case "&": return a & b;
    case "|": return a | b;
    case "^": return a ^ b;
    case "<": return $W(a << (b & 63n));
    case ">": return a >> (b & 63n);
    default: $rt_error("unknown bitwise op '" + op + "'");
  }
}
// 一元 ~ 单独一个 op：ABI 里所有 op 的实参个数是定的，不做可变长
function $js_bitnot(a) {
  const t = $dynTag(a);
  if (t !== "int") $rt_error("bitwise '~' requires a bigint operand, found " + t);
  return $W(~a);
}
function $js_cmp(op, a, b) {
  const ta = $dynTag(a), tb = $dynTag(b);
  let c;
  if (ta === "string" && tb === "string") {
    // 与 Omni 的 string 比较走同一条规则（JS 后端一直是宿主的 < ，见 ADR-0005 的已知偏差）
    c = a < b ? -1 : (a > b ? 1 : 0);
  } else {
    const num = (t) => t === "int" || t === "real";
    if (!num(ta) || !num(tb)) $rt_error("cannot compare " + ta + " with " + tb);
    const x = Number(a), y = Number(b);
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    c = x < y ? -1 : (x > y ? 1 : 0);
  }
  switch (op) {
    case "<": return c < 0;
    case ">": return c > 0;
    case "l": return c <= 0;
    case "g": return c >= 0;
    default: $rt_error("unknown comparison op '" + op + "'");
  }
}
// 编译期常量参数排在实参前面，整张 ABI 表都是这个约定（hir/js_abi.js）
function $js_eq(strict, a, b) {
  const ta = $dynTag(a), tb = $dynTag(b);
  if (!strict) {
    const an = ta === "null" || ta === "undefined";
    const bn = tb === "null" || tb === "undefined";
    if (an || bn) return an && bn;
    const num = (t) => t === "int" || t === "real";
    if (num(ta) && num(tb)) return Number(a) === Number(b);
  }
  if (ta !== tb) return false;
  if (ta === "undefined" || ta === "null") return true;
  return a === b;
}

// ------------------------------------------------- JS 的 String 方法（ADR-0011）
// JS 后端这边宿主的 String 本来就是 UTF-16 码元序列，所以这些几乎都是一行；
// 真正的工作量在 C 侧（runtime/omni_str16.c + omni_js_str.c）。逐条对应。
function $js_asS16(v) {
  if ($dynTag(v) !== "string") $rt_error($dynTag(v) + " is not a string");
  return v;
}
// JS 的 ToIntegerOrInfinity。只收 real：字符串下标不可能是 BigInt，收到 int 是降级写错了
function $js_idx(v, dflt) {
  if (v === undefined) return dflt;
  if ($dynTag(v) !== "real") $rt_error("string index must be a number, found " + $dynTag(v));
  return Number.isNaN(v) ? 0 : Math.trunc(v);
}
function $js_println(v) { $print($js_str(v)); }
// JS 后端这边 Omni 的 string 就是宿主 string，本来就是 UTF-16 码元序列，所以是恒等
function $js_s16(s) { return s; }
function $js_str_len(s) { return $js_asS16(s).length; }
function $js_str_index(s, i) {
  const v = $js_asS16(s), k = $js_idx(i, 0);
  return k < 0 || k >= v.length ? undefined : v[k];
}
function $js_str_at(s, i) {
  const v = $js_asS16(s);
  let k = $js_idx(i, 0);
  if (k < 0) k += v.length;
  return k < 0 || k >= v.length ? undefined : v[k];
}
function $js_str_char_code_at(s, i) {
  const v = $js_asS16(s), k = $js_idx(i, 0);
  return k < 0 || k >= v.length ? NaN : v.charCodeAt(k);
}
function $js_str_code_point_at(s, i) {
  const v = $js_asS16(s), k = $js_idx(i, 0);
  return k < 0 || k >= v.length ? undefined : v.codePointAt(k);
}
function $js_str_slice(s, a, b) {
  const v = $js_asS16(s);
  return v.slice($js_idx(a, 0), $js_idx(b, v.length));
}
function $js_str_repeat(s, n) {
  const k = $js_idx(n, 0);
  if (k < 0) $rt_error("repeat count must not be negative");
  return $js_asS16(s).repeat(k);
}
function $js_str_pad_start(s, n, fill) {
  return $js_asS16(s).padStart($js_idx(n, 0), fill === undefined ? " " : $js_asS16(fill));
}
function $js_str_trim(side, s) {
  const v = $js_asS16(s);
  return side === "l" ? v.trimStart() : side === "r" ? v.trimEnd() : v.trim();
}
// 只折 ASCII：C 侧不带 Unicode 大小写表，两边必须同样残缺才不会分叉
function $js_str_lower(s) {
  return $js_asS16(s).replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}
function $js_str_upper(s) {
  return $js_asS16(s).replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));
}
function $js_str_index_of(s, needle, from) {
  return $js_asS16(s).indexOf($js_asS16(needle), $js_idx(from, 0));
}
function $js_str_last_index_of(s, needle) {
  return $js_asS16(s).lastIndexOf($js_asS16(needle));
}
function $js_str_includes(s, needle) { return $js_asS16(s).includes($js_asS16(needle)); }
// 第二个实参是起始位置：词法器的标点匹配靠它，而且在热路径上
function $js_str_starts_with(s, pre, pos) {
  return $js_asS16(s).startsWith($js_asS16(pre), $js_idx(pos, 0));
}
function $js_str_ends_with(s, suf) { return $js_asS16(s).endsWith($js_asS16(suf)); }
// 变长的 fromCharCode / fromCodePoint 由降级拆成多次 js_add，这里只收一个实参
function $js_str_of_char_code(u) { return String.fromCharCode($js_idx(u, 0)); }
function $js_str_of_code_point(cp) { return String.fromCodePoint($js_idx(cp, 0)); }

// ------------------------------------------------- JS 的 Array（ADR-0011）
// 宿主的 Array 就是 Omni 的 list<dynamic>，所以这些也几乎都是一行。
// 回调按统一签名调用：JS 函数在 Omni 里只有 fn(list<dynamic>) -> dynamic 一种。
function $js_arr_of(v) {
  if ($dynTag(v) !== "list") $rt_error($dynTag(v) + " is not an array");
  return v;
}
function $js_call3(f, x, i, self) { return $callFn(f, [x, i, self]); }
function $js_arr_new() { return []; }
function $js_arr_len(a) { return $js_arr_of(a).length; }
function $js_arr_get(a, i) {
  const l = $js_arr_of(a), k = $js_idx(i, 0);
  return k < 0 || k >= l.length ? undefined : l[k];
}
function $js_arr_set(a, i, v) {
  const l = $js_arr_of(a), k = $js_idx(i, 0);
  if (k < 0) $rt_error("negative array index " + k);
  while (l.length < k) l.push(undefined);
  l[k] = v;
}
function $js_arr_push(a, v) { return $js_arr_of(a).push(v); }
function $js_arr_pop(a) { return $js_arr_of(a).pop(); }
function $js_arr_slice(a, s, e) {
  const l = $js_arr_of(a);
  return l.slice($js_idx(s, 0), $js_idx(e, l.length));
}
function $js_arr_concat(a, b) { return $js_arr_of(a).concat($js_arr_of(b)); }
function $js_arr_reverse(a) { $js_arr_of(a).reverse(); return a; }
function $js_arr_fill(a, v) { $js_arr_of(a).fill(v); return a; }
function $js_arr_is_array(v) { return $dynTag(v) === "list"; }
function $js_arr_from(v) { return $js_arr_of(v).slice(); }
function $js_arr_index_of(a, v) { return $js_arr_of(a).findIndex((x) => $js_eq(true, x, v)); }
function $js_arr_last_index_of(a, v) {
  const l = $js_arr_of(a);
  for (let i = l.length - 1; i >= 0; i--) if ($js_eq(true, l[i], v)) return i;
  return -1;
}
function $js_arr_includes(a, v) {
  const l = $js_arr_of(a);
  const nan = typeof v === "number" && Number.isNaN(v);
  for (const x of l) {
    if (nan ? (typeof x === "number" && Number.isNaN(x)) : $js_eq(true, x, v)) return true;
  }
  return false;
}
function $js_arr_join(a, sep) {
  const s = sep === undefined ? "," : $js_asS16(sep);
  let out = "";
  const l = $js_arr_of(a);
  for (let i = 0; i < l.length; i++) {
    if (i) out += s;
    const x = l[i];
    if (x === null || x === undefined) continue;
    out += $js_str(x);
  }
  return out;
}
function $js_arr_map(a, f) { return $js_arr_of(a).map((x, i) => $js_call3(f, x, i, a)); }
function $js_arr_filter(a, f) {
  return $js_arr_of(a).filter((x, i) => $js_truthy($js_call3(f, x, i, a)));
}
function $js_arr_for_each(a, f) { $js_arr_of(a).forEach((x, i) => { $js_call3(f, x, i, a); }); }
function $js_arr_some(a, f) {
  return $js_arr_of(a).some((x, i) => $js_truthy($js_call3(f, x, i, a)));
}
function $js_arr_every(a, f) {
  return $js_arr_of(a).every((x, i) => $js_truthy($js_call3(f, x, i, a)));
}
function $js_arr_find(a, f) {
  const l = $js_arr_of(a);
  for (let i = 0; i < l.length; i++) if ($js_truthy($js_call3(f, l[i], i, a))) return l[i];
  return undefined;
}
function $js_arr_find_index(a, f) {
  const l = $js_arr_of(a);
  for (let i = 0; i < l.length; i++) if ($js_truthy($js_call3(f, l[i], i, a))) return i;
  return -1;
}
function $js_arr_reduce(a, f, init) {
  const l = $js_arr_of(a);
  let i = 0, acc;
  if (init === undefined) {
    if (l.length === 0) $rt_error("reduce of empty array with no initial value");
    acc = l[0]; i = 1;
  } else {
    acc = init;
  }
  for (; i < l.length; i++) acc = $callFn(f, [acc, l[i], i, a]);
  return acc;
}
function $js_arr_flat_map(a, f) {
  const out = [];
  const l = $js_arr_of(a);
  for (let i = 0; i < l.length; i++) {
    const r = $js_call3(f, l[i], i, a);
    if ($dynTag(r) === "list") out.push(...r); else out.push(r);
  }
  return out;
}
// 不给比较器时按字符串形式比码元（[10,9] 排出来还是 [10,9]），这是 JS 的规定。
// 宿主的 sort 自 ES2019 起保证稳定，C 侧用的是归并，两边都稳定。
function $js_arr_cmp(f, x, y) {
  if (f === undefined) {
    const a = $js_str(x), b = $js_str(y);
    return a < b ? -1 : (a > b ? 1 : 0);
  }
  const r = $callFn(f, [x, y]);
  const d = $dynTag(r) === "real" ? r : ($dynTag(r) === "int" ? Number(r) : 0);
  return Number.isNaN(d) ? 0 : (d < 0 ? -1 : (d > 0 ? 1 : 0));
}
function $js_arr_sort(a, f) { $js_arr_of(a).sort((x, y) => $js_arr_cmp(f, x, y)); return a; }

// ------------------------------------------- 普通对象 / Map / Set（ADR-0011）
// 刻意不用宿主 Map 的任意键能力：C 侧只有 dict<string, dynamic>，键得规范化成带标签的
// 字符串。两边必须同样地绕这一圈，否则键碰撞的边角行为会不一样。
function $js_dict_of(v) {
  if ($dynTag(v) !== "dict") $rt_error($dynTag(v) + " is not an object");
  return v;
}
function $js_key(k) {
  switch ($dynTag(k)) {
    case "string": return "s" + k;
    case "int": return "i" + k.toString();
    case "real": return "n" + $js_str(k);
    case "bool": return "b" + (k ? 1 : 0);
    case "null": return "z";
    case "undefined": return "u";
    default: $rt_error("cannot use a " + $dynTag(k) + " as a Map/Set key");
  }
}
function $js_prop(k) { return $js_asS16(k); }
function $js_obj_new() { return new Map(); }
function $js_obj_get(o, k) {
  const d = $js_dict_of(o), key = $js_prop(k);
  return d.has(key) ? d.get(key) : undefined;
}
// set 返回对象本身，这样对象字面量可以降级成一串链式调用，不需要临时变量
function $js_obj_set(o, k, v) { $js_dict_of(o).set($js_prop(k), v); return o; }
function $js_obj_has(o, k) { return $js_dict_of(o).has($js_prop(k)); }
function $js_obj_delete(o, k) { return $js_dict_of(o).delete($js_prop(k)); }
function $js_obj_keys(o) { return [...$js_dict_of(o).keys()]; }
function $js_obj_values(o) { return [...$js_dict_of(o).values()]; }
function $js_obj_entries(o) { return [...$js_dict_of(o)].map(([k, v]) => [k, v]); }

function $js_map_new() { return new Map(); }
function $js_map_size(m) { return $js_dict_of(m).size; }
function $js_map_has(m, k) { return $js_dict_of(m).has($js_key(k)); }
function $js_map_get(m, k) {
  const d = $js_dict_of(m), key = $js_key(k);
  return d.has(key) ? d.get(key)[1] : undefined;
}
function $js_map_set(m, k, v) { $js_dict_of(m).set($js_key(k), [k, v]); return m; }
function $js_map_delete(m, k) { return $js_dict_of(m).delete($js_key(k)); }
function $js_map_keys(m) { return [...$js_dict_of(m).values()].map((p) => p[0]); }
function $js_map_values(m) { return [...$js_dict_of(m).values()].map((p) => p[1]); }
function $js_map_entries(m) { return [...$js_dict_of(m).values()]; }

function $js_set_new() { return new Map(); }
function $js_set_size(s) { return $js_dict_of(s).size; }
function $js_set_has(s, v) { return $js_dict_of(s).has($js_key(v)); }
function $js_set_add(s, v) { $js_dict_of(s).set($js_key(v), v); return s; }
function $js_set_delete(s, v) { return $js_dict_of(s).delete($js_key(v)); }
function $js_set_items(s) { return [...$js_dict_of(s).values()]; }



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

// 整个 prelude 是一个 String.raw 模板字面量：注释里出现反引号会提前把它闭合，
// 于是 JS_PRELUDE 变成某个表达式的值（栽过两次，第二次是布尔）。当场炸掉比让
// emit 抛 "trim is not a function" 好找。
if (typeof JS_PRELUDE !== 'string') {
  throw new Error('prelude.js 里出现了未转义的反引号，模板字面量被提前闭合了');
}
