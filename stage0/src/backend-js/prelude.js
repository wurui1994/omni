// Omni stage0 — JS 后端运行时前奏（prelude）
//
// 这里的每个函数都必须和 C 运行时（runtime/c_runtime.js）逐位等价，包括**错误消息文本**，
// 否则四后端差分测试立刻会红。数值/打印/字符串规格见 docs/adr/0005-value-semantics.md。

export const JS_PRELUDE = String.raw`
const $W = (x) => BigInt.asIntN(64, x);
const $INT_MIN = -(2n ** 63n);

function $rt_error(msg) {
  $flush();  // 先冲刷 stdout，和 C 运行时里 omni_error 的 fflush(stdout) 对齐
  // OMNI_RT_TRACE=1 时连 JS 栈一起印（只调试用）：运行期的错只有一句话，
  // 而 base 里出错的地方常常离入口十几层，光看那句话定不了位。
  if (process.env.OMNI_RT_TRACE === "1") {
    process.stderr.write(new Error("omni rt: " + msg).stack + "\n");
  }
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

// 无符号那三个（ADR-0016 第六十一刀）。位是同一份，只是当无符号 64 位读：
// $U 把那一格的位读成 0..2^64-1，算完再 $W 回规范形（有符号 64 位）。
// 除零那句话与有符号那两个一模一样：五条腿上是同一句。
// $INT_MIN / -1 那道特例这儿不需要 —— 无符号除法没有溢出。
// （这段里不能出现反引号：整份 prelude 是一个 String.raw 模板。）
const $U = (x) => BigInt.asUintN(64, x);

function $udiv(a, b) {
  if (b === 0n) $rt_error("division by zero");
  return $W($U(a) / $U(b));
}

function $umod(a, b) {
  if (b === 0n) $rt_error("division by zero");
  return $W($U(a) % $U(b));
}

function $fmod(a, b) { return a % b; }

// 向量（ADR-0014 决策 6）：一条长度 = 宽度的普通数组，每道一个标量。
// 逐道的运算刻意**不在这里写死**：道上的语义就是标量语义（int 的回绕、除零的消息文本），
// 后端把标量那份表达式包成一个 lane 函数传进来，这里只负责走遍每一道 ——
// 这样"向量道上的 int"和"标量 int"用的是同一份发射代码，不可能分叉。
function $vsplat(x, n) { const o = []; for (let i = 0; i < n; i++) o.push(x); return o; }
const $vcopy = (v) => v.slice();
function $vbin(a, b, f) { const o = []; for (let i = 0; i < a.length; i++) o.push(f(a[i], b[i])); return o; }
// 水平求和，**严格左到右**：((v0+v1)+v2)+v3。浮点加法不结合，所以这个顺序就是规格本身
// （门槛 6 的「固定求值顺序」），六个执行器都得发这一棵树。
function $vhsum(v, f) { let acc = v[0]; for (let i = 1; i < v.length; i++) acc = f(acc, v[i]); return acc; }

// 指针（ADR-0016）。JS 这条腿是 **arena 模拟**：一整块 ArrayBuffer，地址是字节偏移，
// 0 是 null（所以真正的分配从 8 开始，顺手保住 8 对齐）。字节序**固定小端** ——
// 不跟宿主走，否则这条腿与 C 那条腿看到的不是同一件事。
// fat 指针是三个字 [addr, base, end]（end 是右开界，字节）；thin 就是一个 addr。
// 每个产出指针的操作都**新造一个三元组**（padd/pfield/pnew 都回新的），所以 let 那种别名
// 无害：指针本身从来不被就地改写。这就是 ADR-0016 里"值语义"那一格的落地方式。
let $mem = new ArrayBuffer(1 << 16);
let $mdv = new DataView($mem);
let $mtop = 8;
function $mgrow(need) {
  let cap = $mem.byteLength;
  while (cap < need) cap = cap * 2;
  if (cap === $mem.byteLength) return;
  const nb = new ArrayBuffer(cap);
  new Uint8Array(nb).set(new Uint8Array($mem));
  $mem = nb;
  $mdv = new DataView($mem);
}
function $pnew(count, size) {
  const n = Number(count);
  if (n < 0) $rt_error("pointer allocation count cannot be negative: " + n);
  const bytes = n * size;
  $mgrow($mtop + bytes);
  const a = $mtop;
  $mtop = $mtop + bytes;
  if ($mtop % 8 !== 0) $mtop = $mtop + (8 - $mtop % 8);
  new Uint8Array($mem, a, bytes).fill(0);
  return [a, a, a + bytes];
}
// 范围检查回的是**地址**，于是 load/store 那几条是 $pload_i($pchk(p, 8)) 这种一行。
// 越界的消息里印的是"块内偏移 + 块长"，不是裸地址 —— ADR-0016 的纪律：地址在两套实现里
// 不一样，印出来的东西不许依赖它。
function $pchk(p, size) {
  if (p[0] === 0) $rt_error("null pointer dereference");
  if (p[0] < p[1] || p[0] + size > p[2]) {
    $rt_error("pointer out of bounds: " + Math.floor((p[0] - p[1]) / size)
      + " (range " + Math.floor((p[2] - p[1]) / size) + ")");
  }
  return p[0];
}
function $tchk(a) {
  if (a === 0) $rt_error("null pointer dereference");
  return a;
}
function $pload_i(a) { return $mdv.getBigInt64(a, true); }
function $pload_r(a) { return $mdv.getFloat64(a, true); }
function $pload_b(a) { return $mdv.getUint8(a) !== 0; }
// 指针自己落进内存（ADR-0016 第十六刀）：fat 是三个字 {addr, base, end}，次序与
// hir/types.js 那段注释里定的一样；thin 是一个字。存的是 arena 里的偏移，所以读回来
// 要转成 Number —— 这条腿的三元组里放的就是 Number。
function $pload_p(a) {
  return [Number($mdv.getBigInt64(a, true)), Number($mdv.getBigInt64(a + 8, true)),
    Number($mdv.getBigInt64(a + 16, true))];
}
function $pload_t(a) { return Number($mdv.getBigInt64(a, true)); }
function $pstore_i(a, v) { $mdv.setBigInt64(a, $W(v), true); }
function $pstore_r(a, v) { $mdv.setFloat64(a, v, true); }
function $pstore_b(a, v) { $mdv.setUint8(a, v ? 1 : 0); }
function $pstore_p(a, p) {
  $mdv.setBigInt64(a, BigInt(p[0]), true);
  $mdv.setBigInt64(a + 8, BigInt(p[1]), true);
  $mdv.setBigInt64(a + 16, BigInt(p[2]), true);
  return p;
}
function $pstore_t(a, v) { $mdv.setBigInt64(a, BigInt(v), true); return v; }

function $psub(p, q, size) {
  if (p[1] !== q[1] || p[2] !== q[2]) $rt_error("pointer difference across different blocks");
  return BigInt((p[0] - q[0]) / size);
}
// 走到块外**不报错**（只有解引用才报）：jancy 的 p += i 是合法的，*p 才是那句
// out-of-bounds（type_ptr_data.rst 里的例子就是先加再解引用）。
function $padd(p, k, size) { return [p[0] + Number(k) * size, p[1], p[2]]; }

// 缓冲（ADR-0014 门槛 7 第一阶段）：一段连续的 int/real + 一个长度，引用语义。
// 越界的消息与 list 那句同一个形状 —— 那句已经在三份实现里对齐过，照它写就不必再对一次。
function $bnew(n, isInt) {
  const len = Number(n);
  if (len < 0) $rt_error("buffer length cannot be negative: " + len);
  const z = isInt ? 0n : 0;
  const o = [];
  for (let i = 0; i < len; i++) o.push(z);
  return o;
}
function $bget(a, i) {
  const n = Number(i);
  if (n < 0 || n >= a.length) $rt_error("buffer index out of range: " + n + " (length " + a.length + ")");
  return a[n];
}
function $bset(a, i, v) {
  const n = Number(i);
  if (n < 0 || n >= a.length) $rt_error("buffer index out of range: " + n + " (length " + a.length + ")");
  a[n] = v;
  return v;
}

// 可增长数组（门槛 2 第四刀）：JS 侧就是一个 JS 数组 —— 引用语义、push/pop 都是现成的。
// 越界与空 pop 的消息照 C 那份（omni_arr.c）逐字抄，那边只有一份实现，这边只有一份字符串。
// 零值是**参数**传进来的，不在这里按类型猜：int 是 0n、real 是 0、string 是 ""，
// 那是各前端的事，运行时不掺和（C 那条腿的签名也是这样）。
//
// 元素是**向量**（asy 的 pair[]，第八刀）时要拷一份再存：向量是值类型，C 与 LLVM 两条腿
// 存进数组的是 16 字节的**副本**，JS 这边一个向量是一个 JS 数组，直接存进去就成了别名。
//
// 拷不拷由**调用方按元素的静态类型**给（末位那个 cp），不在这里问 Array.isArray：
// 多维数组那一刀之后"元素在 JS 侧是数组"有两种意思了 —— 向量（值语义，要拷）与**行**
// （引用语义，不能拷）。量过：按 Array.isArray 猜的话 a.push(row) 会存进一份副本，
// 于是 C/LLVM 说"两处是同一条"、JS 说"两条"，一句静默的分叉。
function $acopy(v, cp) { return cp === true && Array.isArray(v) ? v.slice() : v; }
function $anew(n, zero, cp) {
  const len = Number(n);
  if (len < 0) $rt_error("array length cannot be negative: " + len);
  const o = [];
  for (let i = 0; i < len; i++) o.push($acopy(zero, cp));
  return o;
}
// 数组句柄可以是 null（多维数组的行：new real[3][] 之后每行都还没构造），所以
// 长度/下标/push/pop 都要先查 —— C 侧那四份单态实现与 blob 实现开头是同一句 omni_nullck。
// 不查的话 JS 这边冒的是 TypeError（Cannot read properties of null），C 那边直接段错误。
//
// 这四个是**最热的一格**：量过 interpolate1.asy（标签尺寸都命中缓存的那一趟），
// $aget 9.2%、$anew 3.8%、$aset 3.7%、$alen 2.7%、$acopy 1.8%，加上 $nullCheck 1.1%
// 一共占掉近四分之一。所以 null 检查与 $acopy 都在这儿**手展开**，不再多跳一层函数。
// （真正的大头是 int 在 JS 侧是 BigInt：量过 a[Number(bigint)] 比 a[number] 慢 12 倍，
//  BigInt 的加法带回绕比 Number 慢 3.2 倍。那是另一刀的事，见 ADR-0014。
//  注意这一整份是 String.raw 里的正文 —— 反引号会把它截断，注释里也不能写。）
function $alen(a) { if (a === null) $rt_error("null reference"); return BigInt(a.length); }
function $aget(a, i) {
  if (a === null) $rt_error("null reference");
  const n = Number(i);
  if (n < 0 || n >= a.length) $rt_error("array index out of range: " + n + " (length " + a.length + ")");
  return a[n];
}
function $aset(a, i, v, cp) {
  if (a === null) $rt_error("null reference");
  const n = Number(i);
  if (n < 0 || n >= a.length) $rt_error("array index out of range: " + n + " (length " + a.length + ")");
  a[n] = cp === true && Array.isArray(v) ? v.slice() : v;
  return v;
}
function $apush(a, v, cp) {
  if (a === null) $rt_error("null reference");
  a.push(cp === true && Array.isArray(v) ? v.slice() : v);
  return v;
}

function $apop(a) {
  $nullCheck(a);
  if (a.length === 0) $rt_error("pop from empty array");
  return a.pop();
}

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

// (sfix E N)：C 的 %.Nf（ADR-0016 第八刀）。**不能用 toFixed** —— 两者只在恰好一半上
// 不一样，而那不是罕见情形：0.125 到两位，C 给 0.12（就近取偶，IEEE-754 的默认舍入），
// JS 给 0.13（ECMA-262 规定取较大的 n）。挑的是 C 那一边（jancy 的 printf 底下就是它）。
// 所以按精确值算：double 是 m * 2^e，于是 |x| * 10^N 是精确的有理数，用 BigInt 取整。
function $str_fixed(x, p) {
  if (p < 0n || p > 30n) $rt_error("sfix precision out of range: " + p + " (0..30)");
  return $fmt_fixed_n(x, Number(p));
}

// 位数按**普通数**收、且不查范围的那一层。$str_gen 要它 —— %g 选中 %f 那一支时位数
// 能到 N-1-X（X 最小 -4），也就是 33，比方言给 sfix 的上界 30 还大。
function $fmt_fixed_n(x, f) {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  var neg = x < 0 || Object.is(x, -0);
  var dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, Math.abs(x));
  var hi = dv.getUint32(0);
  var m = (BigInt(hi & 0xfffff) << 32n) | BigInt(dv.getUint32(4));
  var be = (hi >>> 20) & 0x7ff;
  var e;
  if (be === 0) { e = -1074; } else { m |= 1n << 52n; e = be - 1075; }
  var k;
  if (e >= 0) {
    k = m * (1n << BigInt(e)) * 10n ** BigInt(f);
  } else {
    var den = 1n << BigInt(-e);
    var num = m * 10n ** BigInt(f);
    k = num / den;
    var r2 = (num % den) * 2n;
    if (r2 > den || (r2 === den && (k & 1n) === 1n)) k += 1n;
  }
  var s = k.toString();
  if (f > 0) {
    if (s.length <= f) s = s.padStart(f + 1, "0");
    s = s.slice(0, s.length - f) + "." + s.slice(s.length - f);
  }
  return neg ? "-" + s : s;
}

// (ssci E N)：C 的 %.Ne（ADR-0016 第三十刀）。与 $str_fixed 同一条纪律（精确值 + 就近
// 取偶），只是整数部分正好一位：先精确地数出十进制那一位在哪（不走 Math.log10，10 的
// 整数次幂附近它会差一格），再对 |x| / 10^(k-N) 取整。进位能把 N+1 位顶成 N+2 位
//（%.2e 的 9.999 是 1.00e+01），那时指数加一。
function $str_sci(x, p) {
  if (p < 0n || p > 30n) $rt_error("ssci precision out of range: " + p + " (0..30)");
  return $fmt_sci_n(x, Number(p));
}

function $fmt_sci_n(x, f) {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  var neg = x < 0 || Object.is(x, -0);
  var a = Math.abs(x);
  var ds;
  var k = 0;
  if (a === 0) { ds = "0".repeat(f + 1); } else {
    var dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, a);
    var hi = dv.getUint32(0);
    var m = (BigInt(hi & 0xfffff) << 32n) | BigInt(dv.getUint32(4));
    var be = (hi >>> 20) & 0x7ff;
    var e;
    if (be === 0) { e = -1074; } else { m |= 1n << 52n; e = be - 1075; }
    if (e >= 0) { k = (m << BigInt(e)).toString().length - 1; } else {
      k = (m * 5n ** BigInt(-e)).toString().length - 1 + e;
    }
    var s2 = k - f;
    var num = m;
    var den = 1n;
    if (e >= 0) { num *= 1n << BigInt(e); } else { den = 1n << BigInt(-e); }
    if (s2 >= 0) { den *= 10n ** BigInt(s2); } else { num *= 10n ** BigInt(-s2); }
    var q = num / den;
    var r2 = (num % den) * 2n;
    if (r2 > den || (r2 === den && (q & 1n) === 1n)) q += 1n;
    if (q >= 10n ** BigInt(f + 1)) { q /= 10n; k += 1; }
    ds = q.toString();
  }
  var s = f > 0 ? ds.slice(0, 1) + "." + ds.slice(1) : ds;
  var ae = k < 0 ? -k : k;
  s += "e" + (k < 0 ? "-" : "+") + (ae < 10 ? "0" + ae : "" + ae);
  return neg ? "-" + s : s;
}

// (sgen E N) / (sgenk E N)：C 的 %.Ng / %#.Ng（ADR-0016 第三十一刀）。C99 7.19.6.1 把 %g
// 定义在 %e 与 %f 之上，所以这里照那个次序搭：P = N==0 ? 1 : N；X 是"按 %.{P-1}e 印会用的
// 指数"（**舍入之后**那个 —— %.2g 的 99.9 舍成 1.0e+02，X 是 2 不是 1）；-4 <= X < P 时用
// %.{P-1-X}f，否则用 %.{P-1}e；没写 # 时去掉小数部分的尾随零（点后空了连点一起去）。
// # 那一支还带着 %f / %e 上"小数点一定印"那条：%#.0g 印 1.5 是 2.、%#.1g 印 100 是 1.e+02。
function $fmt_gen_n(x, p, keep) {
  var P = Number(p) === 0 ? 1 : Number(p);
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  var es = $fmt_sci_n(x, P - 1);
  var X = Number(es.slice(es.indexOf("e") + 1));
  var s = (X >= -4 && X < P) ? $fmt_fixed_n(x, P - 1 - X) : es;
  var ei = s.indexOf("e");
  var m = ei < 0 ? s : s.slice(0, ei);
  if (keep) {
    if (m.indexOf(".") < 0) return ei < 0 ? m + "." : m + "." + s.slice(ei);
    return s;
  }
  if (m.indexOf(".") >= 0) {
    while (m.endsWith("0")) m = m.slice(0, -1);
    if (m.endsWith(".")) m = m.slice(0, -1);
  }
  return ei < 0 ? m : m + s.slice(ei);
}

function $str_gen(x, p) {
  if (p < 0n || p > 30n) $rt_error("sgen precision out of range: " + p + " (0..30)");
  return $fmt_gen_n(x, p, false);
}

function $str_genk(x, p) {
  if (p < 0n || p > 30n) $rt_error("sgenk precision out of range: " + p + " (0..30)");
  return $fmt_gen_n(x, p, true);
}

// (tostr E N)：按 N 位有效数字。位数在 Omni 里是 int，也就是 BigInt，$fmt_g 要的是
// 普通数，所以这里转一下 —— 别的地方谁都别再自己转。
const $str_real_g = (x, p) => $fmt_g(x, Number(p));

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
// 不补换行的那一路（process.stdout.write 的落点）。必须和 $print 共用同一个缓冲区，
// 否则直写的那段会插到已经缓冲、还没落盘的输出前面去。
function $print_raw(s) {
  $out += s;
  if ($out.length > 8192) { process.stdout.write($out); $out = ""; }
}
function $flush() { if ($out.length) { process.stdout.write($out); $out = ""; } }

// (srep S N)（ADR-0016 第五刀，printf 的宽度要它）。n <= 0 回空串而不是抛异常：
// 宽度就是"补到至少 N 个字符"，max(0, N - 长度) 常常是 0 或负数，那是正常情形。
// 与 omni_str_repeat 同一套语义（那边也在 n <= 0 时回空串）。
function $str_repeat(s, n) { return Number(n) <= 0 ? "" : s.repeat(Number(n)); }

// (sbase E 进制) —— E 的位当**无符号 64 位**读（C 的 %x 的规矩），数字小写。
// BigInt.toString(radix) 给的就是 0-9a-z，与 omni_str_base 的那张表同一套。
function $str_base(v, b) { return (v < 0n ? v + 18446744073709551616n : v).toString(Number(b)); }

// (supper S) —— **只动 ASCII 的 a-z**。刻意不用 toUpperCase()：那是 Unicode 的
// （德文 sharp s 会变成两个字符），而 C 那侧的 toupper 还看 locale，两条路对不上。
function $str_upper(s) {
  var out = "";
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    out += (c >= 97 && c <= 122) ? String.fromCharCode(c - 32) : s[i];
  }
  return out;
}

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
// (readtext E)：整份读一份文本文件。与 C 那边的 omni_read_text 一一对应 ——
// 读不到就是运行期错误（不回空串：分不清"空文件"与"没这个文件"）。
function $read_text(p) {
  try {
    return $node("node:fs").readFileSync(p, "utf8");
  } catch (e) {
    $rt_error("cannot read '" + p + "': " + (e && e.code ? e.code : String(e)));
  }
}
// (writetext P E)：整份写一份文本文件，回写进去的字节数。与 omni_write_text 一一对应。
function $write_text(p, t) {
  try {
    $node("node:fs").writeFileSync(p, t);
  } catch (e) {
    $rt_error("cannot write '" + p + "': " + (e && e.code ? e.code : String(e)));
  }
  return BigInt($node("node:buffer").Buffer.byteLength(t, "utf8"));
}
// (runproc CMD)：/bin/sh -c CMD，回退出码。两个流全捕获后丢掉 —— 这一层的 stdout 是
// 图本身，被调程序的絮絮叨叨混进去就把图弄坏了。跑不起来也回非 0，不抛。
function $run_proc(cmd) {
  try {
    var r = $node("node:child_process").spawnSync("/bin/sh", ["-c", cmd],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });
    if (r.error) return 127n;
    return BigInt(r.status === null ? 128 : r.status);
  } catch (e) {
    return 127n;
  }
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
//
// Map 与 Set 的底子也是 Map（键都规范化成带标签的字符串，和 C 侧一样），但标签必须
// 和普通对象分开 —— o.has(k) 这种成员派发只有标签能区分。所以造两个子类。
class $JsMap extends Map {}
class $JsSet extends Map {}
function $dynTag(v) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  switch (typeof v) {
    case "boolean": return "bool";
    case "bigint": return "int";
    case "number": return "real";
    case "string": return "string";
    default:
      if (v instanceof $JsMap) return "Map";
      if (v instanceof $JsSet) return "Set";
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
// 成员派发的兜底（ADR-0011 决策 12）：派发器的形参个数是表里的最大值，末尾多出来的
// undefined 等于没给 —— 削掉再调，C 侧的 omni_js_call_n 是同一套。
function $js_call_n(f, args) {
  let n = args.length;
  while (n > 0 && args[n - 1] === undefined) n--;
  return $callFn($js_asFn(f), args.slice(0, n));
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
// a.push(x, ...ys)：实参先被拼成一个 list，这里整段追加（定长的 op 表达不了可变实参）
function $js_arr_push_all(a, items) {
  const l = $js_arr_of(a);
  for (const v of $js_arr_of(items)) l.push(v);
  return l.length;
}
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
function $js_arr_entries(a) { return $js_arr_of(a).map((v, i) => [i, v]); }
// split 的字符串分隔符形式（正则形式是 $js_re_split）。空分隔符按码元切，不按码点。
function $js_str_split(s, sep) { return $js_asS16(s).split($js_asS16(sep)); }
// Buffer.from(s, "utf8") 的替身：只要"UTF-8 字节的数组"这一个形状。
// 落单的代理项两侧都替成 U+FFFD（TextEncoder 与 omni_s16_to_utf8 一致）。
function $js_utf8_bytes(s) { return [...new TextEncoder().encode($js_asS16(s))]; }
function $js_num_parse_int(s, radix) {
  return parseInt($js_asS16(s), radix === undefined ? undefined : Math.trunc(radix));
}
// for-of 的取值面：数组原样返回（所以下标迭代是活的），字符串按**码点**切，
// Map 给 [k, v] 对，Set 给元素。普通对象不可迭代 —— JS 也是这样。
function $js_iter(v) {
  switch ($dynTag(v)) {
    case "list": return v;
    case "Map": return $js_map_entries(v);
    case "Set": return $js_set_items(v);
    case "string": return [...v];
    default: $rt_error($dynTag(v) + " is not iterable");
  }
}
// o[k]：数组按下标、字符串按码元（只读）、普通对象按属性名。
// Map/Set 上的 o[k] 在 JS 里是属性访问而不是条目，量过的源码里没有，所以报错。
function $js_idx_get(o, k) {
  switch ($dynTag(o)) {
    case "list": return $js_arr_get(o, k);
    case "string": return $js_str_index(o, k);
    case "dict": return $js_obj_get(o, k);
    default: $rt_error("cannot index a " + $dynTag(o));
  }
}
// idx_set 的结果是**被赋的值**（JS 里赋值表达式的值就是右边），不是容器本身 ——
// 和 obj_set 那个"返回对象好串成字面量"的约定不一样，别混。
function $js_idx_set(o, k, v) {
  switch ($dynTag(o)) {
    case "list": $js_arr_set(o, k, v); return v;
    case "dict": $js_obj_set(o, k, v); return v;
    default: $rt_error("cannot assign to an index of a " + $dynTag(o));
  }
}

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
// { ...src, k: v } 的 src 那一步。undefined / null 当空对象（JS 就是这么规定的）。
function $js_obj_assign(dst, src) {
  if (src === undefined || src === null) return dst;
  const d = $js_dict_of(dst);
  for (const [k, v] of $js_dict_of(src)) d.set(k, v);
  return dst;
}

function $js_map_of(v) {
  if ($dynTag(v) !== "Map") $rt_error($dynTag(v) + " is not a Map");
  return v;
}
function $js_set_of(v) {
  if ($dynTag(v) !== "Set") $rt_error($dynTag(v) + " is not a Set");
  return v;
}
function $js_map_new() { return new $JsMap(); }
function $js_map_size(m) { return $js_map_of(m).size; }
function $js_map_has(m, k) { return $js_map_of(m).has($js_key(k)); }
function $js_map_get(m, k) {
  const d = $js_map_of(m), key = $js_key(k);
  return d.has(key) ? d.get(key)[1] : undefined;
}
function $js_map_set(m, k, v) { $js_map_of(m).set($js_key(k), [k, v]); return m; }
function $js_map_delete(m, k) { return $js_map_of(m).delete($js_key(k)); }
function $js_map_keys(m) { return [...$js_map_of(m).values()].map((p) => p[0]); }
function $js_map_values(m) { return [...$js_map_of(m).values()].map((p) => p[1]); }
function $js_map_entries(m) { return [...$js_map_of(m).values()]; }

function $js_set_new() { return new $JsSet(); }
function $js_set_size(s) { return $js_set_of(s).size; }
function $js_set_has(s, v) { return $js_set_of(s).has($js_key(v)); }
function $js_set_add(s, v) { $js_set_of(s).set($js_key(v), v); return s; }
function $js_set_delete(s, v) { return $js_set_of(s).delete($js_key(v)); }
function $js_set_items(s) { return [...$js_set_of(s).values()]; }
// new Map(pairs) / new Set(items)。初值只收 list（JS 的可迭代协议不在这个值域里）；
// 缺参数就是空容器，和 new Map() 一样。
function $js_map_of_pairs(init) {
  const m = $js_map_new();
  if (init === undefined) return m;
  for (const p of $js_arr_of(init)) $js_map_set(m, $js_arr_get(p, 0), $js_arr_get(p, 1));
  return m;
}
function $js_set_of_list(init) {
  const s = $js_set_new();
  if (init === undefined) return s;
  for (const v of $js_arr_of(init)) $js_set_add(s, v);
  return s;
}

// ------------------------------------------- Number / Math / BigInt（ADR-0011）
// toPrecision 与 toString(radix) 用宿主的即是规范；C 侧照规范复刻了一遍。
function $js_real(v, who) {
  const t = $dynTag(v);
  if (t === "real") return v;
  if (t === "int") return Number(v);
  $rt_error(who + " expects a number, found " + t);
}
function $js_num_is_nan(v) { return $dynTag(v) === "real" && Number.isNaN(v); }
function $js_num_is_finite(v) { return $dynTag(v) === "real" && Number.isFinite(v); }
function $js_num_is_integer(v) { return $dynTag(v) === "real" && Number.isInteger(v); }
function $js_num_of(v) {
  switch ($dynTag(v)) {
    case "real": return v;
    case "int": return Number(v);
    case "bool": return v ? 1 : 0;
    case "null": return 0;
    case "undefined": return NaN;
    case "string": return Number(v);
    default: $rt_error("cannot convert " + $dynTag(v) + " to a number");
  }
}
// JS 的 StringToBigInt。刻意**不**走 $int_of_string：那是 Omni 的 int(string) 语义
// （只认十进制），而 BigInt("0xf0") 在 JS 里是 240n —— 编译器自己的 js 词法器就靠它
// 读十六进制的 bigint 字面量。超出 int64 报错（这个值域的 int 就是 int64）。
function $js_str_to_int(s) {
  const t = $js_asS16(s).trim();
  if (!/^([+-]?[0-9]+|0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+)$/.test(t)) {
    $rt_error('invalid integer: "' + s + '"');
  }
  const v = BigInt(t);
  if (v < $INT_MIN || v > 9223372036854775807n) $rt_error('invalid integer: "' + s + '"');
  return v;
}
function $js_bigint_of(v) {
  const t = $dynTag(v);
  if (t === "int") return v;
  if (t === "bool") return v ? 1n : 0n;
  if (t === "real") {
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      $rt_error("cannot convert a non-integer number to a bigint");
    }
    return BigInt(v);
  }
  if (t === "string") return $js_str_to_int(v);
  $rt_error("cannot convert " + t + " to a bigint");
}
function $js_bigint_as_int_n(bits, v) {
  const n = $js_real(bits, "BigInt.asIntN");
  if (n !== 64) $rt_error("only BigInt.asIntN(64, ..) is supported, got " + n);
  if ($dynTag(v) !== "int") $rt_error("BigInt.asIntN expects a bigint, found " + $dynTag(v));
  return v;
}
function $js_num_to_precision(v, digits) {
  const p = $js_real(digits, "toPrecision");
  if (p < 1 || p > 100) $rt_error("toPrecision() argument must be between 1 and 100, got " + p);
  return $js_real(v, "toPrecision").toPrecision(p);
}
function $js_num_to_string(v, radix) {
  const x = $js_real(v, "toString");
  const r = radix === undefined ? 10 : $js_real(radix, "toString");
  if (r < 2 || r > 36) $rt_error("toString() radix must be between 2 and 36, got " + r);
  if (r === 10) return $js_str(x);
  if (!Number.isFinite(x) || !Number.isInteger(x)) {
    $rt_error("toString(radix) with a non-integer value is not supported");
  }
  return x.toString(r);
}
function $js_math(op, a, b) {
  const x = $js_real(a, "Math");
  if (op === "a") return Math.abs(x);
  if (op === "t") return Math.trunc(x);
  if (op === "f") return Math.floor(x);
  if (op === "c") return Math.ceil(x);
  if (op === "s") return Math.sqrt(x);
  // C 的 round 是"离零舍入"（round(-2.5) = -3），JS 的 Math.round 是"向 +inf 舍入"
  // （-2.5 -> -2）。核心方言的 (rmath "round" …) 要的是 C 那一条。
  if (op === "r") return x < 0 ? -Math.round(-x) : Math.round(x);
  // 超越函数：转手 Math.*（C 那边转手 libm）。op 码见 hir/js_abi.js 的注释。
  if (op === "S") return Math.sin(x);
  if (op === "C") return Math.cos(x);
  if (op === "T") return Math.tan(x);
  if (op === "I") return Math.asin(x);
  if (op === "A") return Math.acos(x);
  if (op === "N") return Math.atan(x);
  if (op === "H") return Math.sinh(x);
  if (op === "D") return Math.cosh(x);
  if (op === "G") return Math.tanh(x);
  if (op === "J") return Math.asinh(x);
  if (op === "K") return Math.acosh(x);
  if (op === "L") return Math.atanh(x);
  if (op === "E") return Math.exp(x);
  if (op === "X") return Math.expm1(x);
  if (op === "O") return Math.log(x);
  if (op === "Q") return Math.log10(x);
  if (op === "P") return Math.log1p(x);
  if (op === "B") return Math.cbrt(x);
  const y = $js_real(b, "Math");
  if (op === "M") return Math.max(x, y);
  if (op === "m") return Math.min(x, y);
  if (op === "p") return Math.pow(x, y);
  if (op === "o") return x % y;   // JS 的 % 在 number 上就是 C 的 fmod
  if (op === "2") return Math.atan2(x, y);
  if (op === "Y") return Math.hypot(x, y);
  $rt_error("unknown Math op '" + op + "'");
}

// real 上的数学函数（核心方言的 (rmath "NAME" …)）。生成的代码走这几个，解释器走
// $js_math 的同名 op —— 两条路同一份算法，不是两份碰巧一致的实现。
const $r_sqrt = (x) => $js_math("s", x, 0);
const $r_pow = (x, y) => $js_math("p", x, y);
const $r_fabs = (x) => $js_math("a", x, 0);
const $r_floor = (x) => $js_math("f", x, 0);
const $r_ceil = (x) => $js_math("c", x, 0);
const $r_round = (x) => $js_math("r", x, 0);
const $r_fmod = (x, y) => $js_math("o", x, y);
const $r_sin = (x) => $js_math("S", x, 0);
const $r_cos = (x) => $js_math("C", x, 0);
const $r_tan = (x) => $js_math("T", x, 0);
const $r_asin = (x) => $js_math("I", x, 0);
const $r_acos = (x) => $js_math("A", x, 0);
const $r_atan = (x) => $js_math("N", x, 0);
const $r_atan2 = (y, x) => $js_math("2", y, x);
const $r_sinh = (x) => $js_math("H", x, 0);
const $r_cosh = (x) => $js_math("D", x, 0);
const $r_tanh = (x) => $js_math("G", x, 0);
const $r_asinh = (x) => $js_math("J", x, 0);
const $r_acosh = (x) => $js_math("K", x, 0);
const $r_atanh = (x) => $js_math("L", x, 0);
const $r_exp = (x) => $js_math("E", x, 0);
const $r_expm1 = (x) => $js_math("X", x, 0);
const $r_log = (x) => $js_math("O", x, 0);
const $r_log10 = (x) => $js_math("Q", x, 0);
const $r_log1p = (x) => $js_math("P", x, 0);
const $r_cbrt = (x) => $js_math("B", x, 0);
const $r_hypot = (x, y) => $js_math("Y", x, y);

// ------------------------------------------------- JSON.stringify（ADR-0011）
// 不能直接用宿主的 JSON.stringify：这边的对象是 Map、int 是 BigInt，宿主会当成
// 普通对象序列化成 {} 并且在 BigInt 上抛 TypeError。所以照 C 侧同一套走一遍。
// 只有 stringify —— 量过，JSON.parse 全仓库 0 处用到。
function $js_json_quote(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // 低位代理只有在前一个码元不是高位代理时才算孤立，否则成对的低位也会被转义
    const lone = c >= 0xd800 && c <= 0xdbff
      ? !(i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff)
      : c >= 0xdc00 && c <= 0xdfff
        ? !(i > 0 && s.charCodeAt(i - 1) >= 0xd800 && s.charCodeAt(i - 1) <= 0xdbff)
        : false;
    if (c === 0x22 || c === 0x5c) out += "\\" + s[i];
    else if (c === 8) out += "\\b";
    else if (c === 12) out += "\\f";
    else if (c === 10) out += "\\n";
    else if (c === 13) out += "\\r";
    else if (c === 9) out += "\\t";
    else if (c < 0x20 || lone) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += s[i];
  }
  return out + '"';
}
function $js_json_apply(rep, key, v) {
  return rep === undefined ? v : $callFn(rep, [key, v]);
}
function $js_json_nl(gap, depth) { return gap > 0 ? "\n" + " ".repeat(gap * depth) : ""; }
// undefined 与函数值"该省略"：在对象里跳过、在数组里变成 null。用 undefined 当哨兵。
function $js_json_val(v, rep, gap, depth) {
  const t = $dynTag(v);
  if (t === "undefined" || t === "function") return undefined;
  if (t === "null") return "null";
  if (t === "bool") return v ? "true" : "false";
  if (t === "real") return Number.isFinite(v) ? $js_str(v) : "null";
  if (t === "string") return $js_json_quote(v);
  if (t === "int") $rt_error("do not know how to serialize a bigint");
  if (t === "list") {
    if (v.length === 0) return "[]";
    const sep = $js_json_nl(gap, depth + 1);
    let out = "[";
    for (let i = 0; i < v.length; i++) {
      if (i) out += ",";
      out += sep;
      const s = $js_json_val($js_json_apply(rep, $js_str(i), v[i]), rep, gap, depth + 1);
      out += s === undefined ? "null" : s;
    }
    return out + $js_json_nl(gap, depth) + "]";
  }
  if (t === "dict") {
    let out = "{", first = true;
    const sep = $js_json_nl(gap, depth + 1);
    for (const [k, val] of v) {
      const s = $js_json_val($js_json_apply(rep, k, val), rep, gap, depth + 1);
      if (s === undefined) continue;
      if (!first) out += ",";
      first = false;
      out += sep + $js_json_quote(k) + (gap > 0 ? ": " : ":") + s;
    }
    return first ? "{}" : out + $js_json_nl(gap, depth) + "}";
  }
  if (t === "Map" || t === "Set") return "{}";
  $rt_error("do not know how to serialize a " + t);
}
function $js_json_stringify(v, rep, indent) {
  let gap = 0;
  if ($dynTag(indent) === "real" && indent > 0) gap = Math.min(Math.trunc(indent), 10);
  return $js_json_val($js_json_apply(rep, "", v), rep, gap, 0);
}

// ------------------------------------------- throw / try（ADR-0007 决定 1）
// 静态降级：不映射到宿主的 throw（那会污染栈、让两个后端的行为分叉）。
// 运行时只有一个"待处理错误"的槽，跳转由 lower.js 发成普通控制流。
let $pending = undefined, $pendingSet = false;
function $js_throw(v) { $pending = v; $pendingSet = true; return undefined; }
function $js_pending() { return $pendingSet; }
function $js_take_pending() {
  if (!$pendingSet) return undefined;
  $pendingSet = false;
  return $pending;
}
// 未捕获：宿主会打栈回溯，C 侧打不出同样的东西，所以两侧一律只打这一行
function $js_check_uncaught() {
  if (!$pendingSet) return;
  $flush();
  process.stderr.write("omni: uncaught: " + $js_asS16($js_str($pending)) + "\n");
  process.exit(70);
}
// 异常对象就是普通对象：{ $cls: [类名…，最派生的在前], message }（ADR-0011 决策 15）
function $js_err_new(msg, cls) {
  const o = $js_obj_new();
  $js_obj_set(o, "$cls", cls);
  $js_obj_set(o, "message", msg);
  return o;
}
function $js_is_a(v, n) {
  if ($dynTag(v) !== "dict") return false;
  const c = $js_obj_get(v, "$cls");
  if ($dynTag(c) !== "list") return false;
  for (let i = 0; i < c.length; i++) if ($js_eq(true, c[i], n)) return true;
  return false;
}

// ---------------------------------------------- node 宿主面（ADR-0011 第 4 步）
// 不能在这里写 import：整个 prelude 也会被 cli.js 用 new Function(code)() 跑
// （omni run 的快路径），而 new Function 的函数体里 import 是语法错误。
// process.getBuiltinModule 是同步的、不需要 import，两条路都能用。
function $node(name) { return process.getBuiltinModule(name); }
function $js_fs_read_text(p) { return $node("node:fs").readFileSync($js_asS16(p), "utf8"); }
function $js_fs_write_text(p, t) {
  $node("node:fs").writeFileSync($js_asS16(p), $js_asS16(t));
  return undefined;
}
function $js_fs_exists(p) { return $node("node:fs").existsSync($js_asS16(p)); }
function $js_fs_readdir(p) { return $node("node:fs").readdirSync($js_asS16(p)); }
function $js_fs_mtime_ms(p) { return $node("node:fs").statSync($js_asS16(p)).mtimeMs; }
function $js_fs_size(p) { return $node("node:fs").statSync($js_asS16(p)).size; }
function $js_fs_mkdtemp(pre) { return $node("node:fs").mkdtempSync($js_asS16(pre)); }
function $js_fs_mkdir_all(p) {
  $node("node:fs").mkdirSync($js_asS16(p), { recursive: true });
  return undefined;
}
function $js_fs_rename(a, b) {
  $node("node:fs").renameSync($js_asS16(a), $js_asS16(b));
  return undefined;
}
function $js_fs_realpath(p) { return $node("node:fs").realpathSync($js_asS16(p)); }
function $js_proc_args() { return process.argv.slice(2); }
function $js_proc_cwd() { return process.cwd(); }
function $js_proc_env(n) { return process.env[$js_asS16(n)]; }
function $js_proc_stdout_write(s) { $print_raw($js_asS16(s)); return undefined; }
function $js_proc_stderr_write(s) {
  // stdout 先落盘：诊断与正常输出的相对次序在快照测试里是要对上的（C 侧同样先 fflush）
  $flush();
  process.stderr.write($js_asS16(s));
  return undefined;
}
function $js_proc_exit_code(n) {
  process.exitCode = n === undefined ? 0 : Math.trunc(n);
  return undefined;
}
function $js_proc_stdin_is_tty() { return process.stdin.isTTY === true; }
// 阻塞读一行：C 侧只有阻塞读，所以这边也用 readSync 而不是 readline 的事件。
// 一次一个字节够用 —— 用它的只有 REPL，那是等人打字的地方。
function $js_proc_read_line() {
  const fs = $node("node:fs"), one = Buffer.alloc(1), bytes = [];
  let sawEof = false;
  for (;;) {
    let n = 0;
    try { n = fs.readSync(0, one, 0, 1, null); }
    catch (e) {
      if (e.code === "EAGAIN") continue;
      if (e.code === "EOF") { sawEof = true; break; }
      throw e;
    }
    if (n === 0) { sawEof = true; break; }
    if (one[0] === 10) break;
    bytes.push(one[0]);
  }
  if (sawEof && bytes.length === 0) return undefined;
  const s = new TextDecoder().decode(new Uint8Array(bytes));
  return s.endsWith("\r") ? s.slice(0, -1) : s;
}
function $js_proc_spawn(cmd, args, mode) {
  const m = $js_asS16(mode);
  const stdio = m === "c" ? ["ignore", "pipe", "pipe"]
    : m === "o" ? ["ignore", "inherit", "pipe"]
      : "inherit";
  // maxBuffer 必须显式给：node 的默认是 1 MiB，而 C 侧的实现没有这个上限。
  // omni bootstrap 要收下另一代编译器 1.7 MB 的 stdout，默认值会 ENOBUFS。
  const r = $node("node:child_process").spawnSync(
    $js_asS16(cmd), $js_arr_of(args).map((x) => $js_asS16(x)),
    { encoding: "utf8", stdio, maxBuffer: 1 << 28 });
  if (r.error !== undefined && r.error !== null) $rt_error("cannot spawn: " + r.error.message);
  return [r.status === null ? 128 : r.status, r.stdout === null ? "" : r.stdout, r.stderr === null ? "" : r.stderr];
}
function $js_os_tmpdir() { return $node("node:os").tmpdir(); }
function $js_now_ms() { return Date.now(); }
// "运行中的程序镜像所在目录"。JS 侧是脚本所在目录，C 侧是可执行文件所在目录 ——
// 从这里怎么走到 runtime/ 与 lib/ 是调用方的事（两代的布局本来就不同）。
function $js_install_dir() {
  const p = process.argv[1];
  if (p === undefined) return ".";
  const i = p.lastIndexOf("/");
  return i < 0 ? "." : (i === 0 ? "/" : p.slice(0, i));
}
// 这个宿主有没有 JS 引擎。node 上有，原生构建上没有 —— omni run 靠它决定走进程内
// eval 还是走 C 路径，而不是撞上 $js_eval 那句错误。
function $js_has_engine() {
  return true;
}
// dynamic 的运行期标签名。解释器靠它认出装的是什么（ADR-0013）。
// 与 host/native.js 的 typeTag 和 runtime 的 omni_js_type_tag 逐字一致 —— 这些名字会进
// 错误消息。JS 域的 Map/Set 与 Omni 的 dict/set 在这里是**不同**的标签。
function $js_type_tag(v) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  switch (typeof v) {
    case "boolean": return "bool";
    case "bigint": return "int";
    case "number": return "real";
    case "string": return "string";
    case "function": return "function";
    default:
      if (v instanceof $JsMap) return "Map";
      if (v instanceof $JsSet) return "Set";
      if (v instanceof Map) return "dict";
      if (v instanceof Set) return "set";
      if (Array.isArray(v)) return "list";
      return "function";
  }
}
// real 的两种文本化，给解释器用（ADR-0013）。刻意就是 print / repr 自己用的那两个函数 ——
// 解释器不再写第三份浮点格式化，于是"同一个 double 打印成同一串字符"是构造性的。
function $js_fmt_real(x) { return $fmt_real(x); }
function $js_fmt_real_g(x, p) { return $str_real_g(x, p); }
function $js_repr_real(x) { return $repr_real(x); }
// 解释器的函数值（ADR-0013 决策 3）。传进来的 f 是解释器自己那个两形参的 lambda，降级后
// 它的实参是**一条表**（JS 域的唯一签名），所以这里要造一条转接记录：宿主按 fp(self, args)
// 调这个值，转接把 (self, args) 装成那条表再调 f。恒等是不行的 —— 那样 f 会把 args[0]
// 当 self、args[1] 当实参表。
function $js_wrap_fn(f) {
  return { fp: (self, args) => $callFn($js_asFn(f), [self, args]) };
}
function $js_call_fn(f, args) { return $callFn($js_asFn(f), args); }
// 外部 C 符号在 JS 后端上不存在（ADR-0014 决策 4）：C-ABI 只活在原生构建里。
// 报错而不是给个错答案 —— 这份 JS 仍然要能被发出来（自举的不动点依赖它），
// 只是真去调 C 的那一刻当场停下。
function $js_cabi_unavailable(sym) {
  throw new Error("C ABI symbol '" + sym + "' is only available in a native build (ADR-0014 decision 4)");
}
// 宿主里跑一段生成的 JS（omni run 与 REPL 的进程内快路径）。原生构建里没有 JS
// 引擎，C 侧那两个同名函数只会报错 —— 这是宿主面唯一"只有一代能做"的能力。
function $js_eval(code) {
  $flush();
  new Function($js_asS16(code))();
  return undefined;
}
// 同上，但把 stdout/stderr 收进字符串，结果是 [out, err, failed]。REPL 要靠它算
// "这次输入多打出来的那一段"，而且被跑的代码里 $rt_error 会 process.exit(70)，
// 那在 REPL 里不能真的退出，所以 exit 也一起截住。
function $js_eval_captured(code) {
  $flush();
  const out = [], err = [];
  const so = process.stdout.write, se = process.stderr.write, ex = process.exit;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = (s) => { err.push(String(s)); return true; };
  process.exit = (c) => { const e = new Error("exit"); e.$exit = c === undefined ? 0 : c; throw e; };
  let failed = false;
  try {
    new Function($js_asS16(code))();
  } catch (e) {
    failed = true;
    // $exit 是被跑的程序自己的运行期错误（消息已经在 err 里了）；其它异常说明后端生成了坏代码
    if (e === null || e === undefined || e.$exit === undefined) {
      err.push("omni: internal error: generated JS threw " + (e && e.stack ? e.stack : String(e)) + "\n");
    }
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
    process.exit = ex;
  }
  return [out.join(""), err.join(""), failed];
}

// ------------------------------------------------------- RegExp（ADR-0011）
// 只借宿主 RegExp 的 exec 当"从某个下标起找最左匹配"这一个原语，match / split /
// replace 的算法自己走一遍 —— C 侧只有同一个原语（omni_re_search），把边角
// （空匹配推进、$ 替换、split 插捕获组、limit）交给宿主实现就等于放两套语义进来。
// 已知的不完整：i 在宿主这边是完整 Unicode 折叠，C 侧只折 ASCII。两边都只在
// ASCII 上用 i（量过），真越界时 tests/oir 会先炸。
const $RE_CACHE = new Map();
function $js_re_get(pat_, flags_) {
  // 模式与 flags 是 JS 域的字符串（正则字面量降下来是个带 source/flags 的对象），
  // 所以两侧都按内容做缓存键，不按字面量身份
  const pat = $js_asS16(pat_), flags = $js_asS16(flags_);
  const key = pat + "\u0000" + flags;
  let re = $RE_CACHE.get(key);
  if (re === undefined) {
    // 一律加 g：lastIndex 是"从下标起找"的唯一入口，是否真的全局由 flags 自己说
    re = new RegExp(pat, flags.includes("g") ? flags : flags + "g");
    $RE_CACHE.set(key, re);
  }
  return re;
}
function $js_re_find(re, s, start) {
  if (start > s.length) return null;
  re.lastIndex = start;
  return re.exec(s);
}
function $js_re_test(pat, flags_, s) {
  const flags = $js_asS16(flags_);
  if (flags.includes("g")) $rt_error("regexp: .test on a /g/ regexp is not supported (lastIndex has no home here)");
  return $js_re_find($js_re_get(pat, flags), $js_asS16(s), 0) !== null;
}
function $js_re_match(pat, flags_, s) {
  const flags = $js_asS16(flags_);
  if (!flags.includes("g")) {
    $rt_error("regexp: .match without /g/ is not supported (the result object has index/input on it)");
  }
  const re = $js_re_get(pat, flags), str = $js_asS16(s), out = [];
  let at = 0;
  for (;;) {
    const m = $js_re_find(re, str, at);
    if (m === null) break;
    out.push(m[0]);
    at = m[0].length > 0 ? m.index + m[0].length : m.index + 1;
  }
  return out.length === 0 ? null : out;
}
// $ 记号照 ECMA-262 的 GetSubstitution：$$ / $& / 前缀 / 后缀 / $n / $nn，越界的 $n 原样留着
// （这里不能写出反引号：整个 prelude 是一个 String.raw 模板，反引号会当场把它截断）
function $js_re_sub(repl, s, m) {
  const ng = m.length - 1;
  let out = "";
  for (let i = 0; i < repl.length; i++) {
    const c = repl[i];
    if (c !== "$" || i + 1 >= repl.length) { out += c; continue; }
    const d = repl[i + 1];
    if (d === "$") { out += "$"; i++; }
    else if (d === "&") { out += m[0]; i++; }
    else if (d === "\u0060") { out += s.slice(0, m.index); i++; }
    else if (d === "'") { out += s.slice(m.index + m[0].length); i++; }
    else if (d >= "0" && d <= "9") {
      let n = +d, used = 1;
      if (i + 2 < repl.length && repl[i + 2] >= "0" && repl[i + 2] <= "9" && n * 10 + +repl[i + 2] <= ng) {
        n = n * 10 + +repl[i + 2];
        used = 2;
      }
      if (n >= 1 && n <= ng) { out += m[n] === undefined ? "" : m[n]; i += used; }
      else out += c;
    } else out += c;
  }
  return out;
}
function $js_re_replace(pat, flags_, s, repl) {
  const flags = $js_asS16(flags_);
  const re = $js_re_get(pat, flags), str = $js_asS16(s);
  const g = flags.includes("g"), isFn = $dynTag(repl) === "function";
  let out = "", copied = 0, at = 0;
  for (;;) {
    const m = $js_re_find(re, str, at);
    if (m === null) break;
    out += str.slice(copied, m.index);
    out += isFn
      ? $js_str($callFn(repl, [...m, m.index, str]))
      : $js_re_sub($js_asS16(repl), str, m);
    copied = m.index + m[0].length;
    at = m[0].length > 0 ? copied : copied + 1;
    if (!g) break;
  }
  return out + str.slice(copied);
}
// split 照 ECMA-262 22.1.3.23：捕获组要插进结果，limit 是结果长度的上界，
// 空匹配不许停在当前段的起点（否则会切出无穷多个空串），末尾那段总要补上。
function $js_re_split(pat, flags, s, limit) {
  const re = $js_re_get(pat, flags), str = $js_asS16(s);
  let lim = Infinity;
  if ($dynTag(limit) === "real") lim = Number.isNaN(limit) || limit < 0 ? 0 : Math.trunc(limit);
  else if (limit !== undefined) $rt_error("split limit must be a number, found " + $dynTag(limit));
  const out = [];
  if (lim === 0) return out;
  if (str.length === 0) {
    if ($js_re_find(re, str, 0) === null) out.push(str);
    return out;
  }
  let p = 0, q = 0;
  while (q < str.length) {
    const m = $js_re_find(re, str, q);
    if (m === null || m.index >= str.length) break;
    const e = m.index + m[0].length;
    if (e === p) { q = m.index + 1; continue; }
    out.push(str.slice(p, m.index));
    if (out.length >= lim) return out;
    for (let i = 1; i < m.length; i++) {
      out.push(m[i]);
      if (out.length >= lim) return out;
    }
    p = e;
    q = e;
  }
  out.push(str.slice(p));
  return out;
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

// dynamic 上的算术。标签严格，**不做** JS 那套强制转换 —— dynamic 是 Omni 的动态通道，
// 不是 any："1" + 1 在这里是错误，不是 "11"。规则与静态那半边逐条对齐：
// 两个 int 是 int64 回绕，掺进 real 就都按 real 算，两个 string 只有 '+' 是拼接。
// 其余组合是运行期错误，消息点名两边的标签 —— 与 runtime/omni_dyn.c 逐字一致。
function $dynArith(op, a, b) {
  const ta = $dynTag(a), tb = $dynTag(b);
  if (ta === "int" && tb === "int") {
    if (op === "+") return $W(a + b);
    if (op === "-") return $W(a - b);
    if (op === "*") return $W(a * b);
    if (op === "/") return $div(a, b);
    return $mod(a, b);
  }
  if ((ta === "int" || ta === "real") && (tb === "int" || tb === "real")) {
    const x = ta === "int" ? Number(a) : a;
    const y = tb === "int" ? Number(b) : b;
    if (op === "+") return x + y;
    if (op === "-") return x - y;
    if (op === "*") return x * y;
    if (op === "/") return x / y;
    return $fmod(x, y);
  }
  if (op === "+" && ta === "string" && tb === "string") return a + b;
  $rt_error("cannot apply '" + op + "' to " + ta + " and " + tb);
}
function $dynAdd(a, b) { return $dynArith("+", a, b); }
function $dynSub(a, b) { return $dynArith("-", a, b); }
function $dynMul(a, b) { return $dynArith("*", a, b); }
function $dynDiv(a, b) { return $dynArith("/", a, b); }
function $dynMod(a, b) { return $dynArith("%", a, b); }
function $dynNeg(a) {
  const t = $dynTag(a);
  if (t === "int") return $W(-a);
  if (t === "real") return -a;
  $rt_error("cannot apply unary '-' to " + t);
}

`;

// 整个 prelude 是一个 String.raw 模板字面量：注释里出现反引号会提前把它闭合，
// 于是 JS_PRELUDE 变成某个表达式的值（栽过两次，第二次是布尔）。当场炸掉比让
// emit 抛 "trim is not a function" 好找。
if (typeof JS_PRELUDE !== 'string') {
  throw new Error('prelude.js 里出现了未转义的反引号，模板字面量被提前闭合了');
}
