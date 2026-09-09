// Omni stage0 — JS 后端运行时前奏（prelude）
//
// 这里的每个函数都必须和 C 运行时（runtime/c_runtime.js）逐位等价，包括**错误消息文本**，
// 否则四后端差分测试立刻会红。数值/打印/字符串规格见 docs/adr/0005-value-semantics.md。

export const JS_PRELUDE = String.raw`
// ---------------------------------------------------------------- int 的表示
// 方言的 int 是 **i64**（回绕、精确），而 JS 只有 number（安全到 2^53-1）与 BigInt。
// 从前一律用 BigInt，量出来是最大的一块成本：同一个内核换成 number 快 3 倍
// （再去掉下标那两道检查还有 2.4 倍，见 ADR-0014 的"天花板"那一节）。
//
// 现在的表示是**规范化的 number|BigInt**：
//   |v| <= 2^53-1  ->  number（整数值）
//   否则            ->  BigInt
// 两种表示的取值范围**不重叠**，所以规范形唯一 —— 三等号仍然对（不会同时存在 1 与 1n）、
// Map 的键仍然唯一（SameValueZero 下 -0 与 0 同键）、印出来的字仍然一样。
// 规范化的唯一入口是 $CN；每个会越界的运算算完都过它一次。
// （这一整份是 String.raw 模板的正文：注释里也不许出现反引号。）
const $ISAFE = 9007199254740991;          // 2^53-1
const $ISAFEn = 9007199254740991n;
const $CN = (v) => (typeof v === "bigint"
  ? (v <= $ISAFEn && v >= -$ISAFEn ? Number(v) : v) : v);
const $B = (x) => (typeof x === "bigint" ? x : BigInt(x));
const $INT_MIN = -(2n ** 63n);

// + - * 的快路：两个 number 时直接算，结果落在安全范围里就是**精确**的
// （IEEE 是正确舍入的：真值 >= 2^53+1 时算出来必然 >= 2^53，所以这一查是充分的）。
// 不过关就回 BigInt 重算一遍再规范化。
function $iadd(a, b) {
  if (typeof a === "number" && typeof b === "number") {
    const r = a + b;
    if (r <= $ISAFE && r >= -$ISAFE) return r;
  }
  return $CN(BigInt.asIntN(64, $B(a) + $B(b)));
}
function $isub(a, b) {
  if (typeof a === "number" && typeof b === "number") {
    const r = a - b;
    if (r <= $ISAFE && r >= -$ISAFE) return r;
  }
  return $CN(BigInt.asIntN(64, $B(a) - $B(b)));
}
function $imul(a, b) {
  if (typeof a === "number" && typeof b === "number") {
    const r = a * b;
    if (r <= $ISAFE && r >= -$ISAFE) return r;
  }
  return $CN(BigInt.asIntN(64, $B(a) * $B(b)));
}
function $ineg(a) {
  if (typeof a === "number") return a === 0 ? 0 : -a;
  return $CN(BigInt.asIntN(64, -a));
}
// 位运算一律走 BigInt：JS 的 & | ^ << >> 会把操作数截成 int32，number 那条路直接是错的。
// asy 那边位运算是 nope（builtins.tab 里 AND/OR/XOR 都还没做），所以这一档不在热路上。
function $ishl(a, b) { return $CN(BigInt.asIntN(64, $B(a) << ($B(b) & 63n))); }
function $ishr(a, b) { return $CN($B(a) >> ($B(b) & 63n)); }
function $iushr(a, b) { return $CN(BigInt.asIntN(64, BigInt.asUintN(64, $B(a)) >> ($B(b) & 63n))); }
function $iand(a, b) { return $CN($B(a) & $B(b)); }
function $ior(a, b) { return $CN($B(a) | $B(b)); }
function $ixor(a, b) { return $CN($B(a) ^ $B(b)); }
function $inot(a) { return $CN(BigInt.asIntN(64, ~$B(a))); }

// 运行期错误的去处：默认是"打一行、退 70"（与 C 侧 omni_error 逐字对齐）。
// REPL 的 js 引擎会装一个钩子进来 —— 它 throw，于是一批跑挂了只掀翻那一批，不掀翻会话。
// 钩子存在这一份运行时模块自己的槽里（不是 globalThis）：prelude 内部那些函数引用的是
// 这个词法绑定，改 globalThis 上的同名副本对它们无效。
let $onRtError = null;
function $js_set_error_hook(f) { $onRtError = f; }
function $rt_error(msg) {
  $flush();  // 先冲刷 stdout，和 C 运行时里 omni_error 的 fflush(stdout) 对齐
  // OMNI_RT_TRACE=1 时连 JS 栈一起印（只调试用）：运行期的错只有一句话，
  // 而 base 里出错的地方常常离入口十几层，光看那句话定不了位。
  if (process.env.OMNI_RT_TRACE === "1") {
    process.stderr.write(new Error("omni rt: " + msg).stack + "\n");
  }
  if ($onRtError !== null) $onRtError(msg);
  process.stderr.write("omni: runtime error: " + msg + "\n");
  process.exit(70);
}

/* 宿主抛出来的、**能 catch** 的错（ADR-0020）。规范里 JSON.parse 的语法错、
   decodeURIComponent 的畸形输入、toFixed 的越界位数都是普通的 JS 异常，不是"进程完了" ——
   try / catch 把它围起来是真实代码里最常见的一格写法。
   实现的形状：出错点抛一格 $HostBad（这只是**信号**，不是 JS 可见的值），入口那一层收下来
   翻成 pending 的 Error 值。为什么不在出错点直接 $js_throw：那一族函数往往互相递归、错误点
   十几处，靠宿主自己的 throw 把栈剥到入口最省事，也不必给每个中间返回补一次 pending 检查。
   前提是那个 op 在 ABI 表里标了 throws: true —— 调用点的 pending 检查由它发。 */
function $HostBad(m, k) { this.m = m; this.k = k === undefined ? "SyntaxError" : k; }
function $js_host_err(e) {
  if (!(e instanceof $HostBad)) throw e;
  $js_throw($js_err_new(e.m, [e.k, "Error"], undefined));
  return undefined;
}
// 值域越界那一族（toFixed / toExponential / toString 的位数与进制）：错误点就在入口那一句，
// 不必绕信号，直接放一格 pending 的 RangeError。
function $js_range_err(msg) { return $js_host_err(new $HostBad(msg, "RangeError")); }
// 规范明写"抛 TypeError"的那些（描述符校验那一族）：能 catch。**我们自己**"表达不出来"的
// 拒绝不走这一格 —— 那是硬错（见 $js_arr_def），两者刻意分开。
function $js_type_err(msg) { return $js_host_err(new $HostBad(msg, "TypeError")); }

// 截断除（C 的 /）。两个 number 的快路借取模走：a % b 在整数上是**精确**的（fmod
// 对整数操作数不丢位），a - r 是 b 的整数倍，于是 (a-r)/b 的商正好可表示、除法精确。
// 直接写 Math.trunc(a/b) 不行：a/b 是先舍入的浮点商，贴着整数边界时会被舍到隔壁。
// 上界那一查保证 a - r 不越过 2^53-1（|a-r| <= |a|+|b|）。
function $div(a, b) {
  if (typeof a === "number" && typeof b === "number") {
    if (b === 0) $rt_error("division by zero");
    if (Math.abs(a) + Math.abs(b) <= $ISAFE) {
      const q = (a - (a % b)) / b;
      return q === 0 ? 0 : q;
    }
  }
  const A = $B(a), B2 = $B(b);
  if (B2 === 0n) $rt_error("division by zero");
  if (A === $INT_MIN && B2 === -1n) return $CN($INT_MIN);  // 与 C 的溢出行为对齐
  return $CN(A / B2);
}

function $mod(a, b) {
  if (typeof a === "number" && typeof b === "number") {
    if (b === 0) $rt_error("division by zero");
    const r = a % b;
    return r === 0 ? 0 : r;
  }
  const A = $B(a), B2 = $B(b);
  if (B2 === 0n) $rt_error("division by zero");
  if (A === $INT_MIN && B2 === -1n) return 0;
  return $CN(A % B2);
}

// dynamic 那一格里的 int **一律 BigInt**（$dynTag 靠 typeof 分 int 与 real，
// 1 与 1.0 在 number 上分不开），所以那半边有自己的三个：回卷、除、取余，都不规范化。
// 静态那半边的入口是 $iadd/$div/$mod，两半在装箱边界（emit 的 Box -> $B）上接。
const $DW = (x) => BigInt.asIntN(64, x);
function $ddiv(a, b) {
  if (b === 0n) $rt_error("division by zero");
  if (a === $INT_MIN && b === -1n) return $INT_MIN;
  return a / b;
}
function $dmod(a, b) {
  if (b === 0n) $rt_error("division by zero");
  if (a === $INT_MIN && b === -1n) return 0n;
  return a % b;
}

// 无符号那三个（ADR-0016 第六十一刀）。位是同一份，只是当无符号 64 位读：
// $U 把那一格的位读成 0..2^64-1，算完再回卷成有符号 64 位、规范化。
// 除零那句话与有符号那两个一模一样：五条腿上是同一句。
// $INT_MIN / -1 那道特例这儿不需要 —— 无符号除法没有溢出。
// （这段里不能出现反引号：整份 prelude 是一个 String.raw 模板。）
const $U = (x) => BigInt.asUintN(64, $B(x));

function $udiv(a, b) {
  if ($B(b) === 0n) $rt_error("division by zero");
  return $CN(BigInt.asIntN(64, $U(a) / $U(b)));
}

function $umod(a, b) {
  if ($B(b) === 0n) $rt_error("division by zero");
  return $CN(BigInt.asIntN(64, $U(a) % $U(b)));
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
function $pload_i(a) { return $CN($mdv.getBigInt64(a, true)); }
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
function $pstore_i(a, v) { $mdv.setBigInt64(a, BigInt.asIntN(64, $B(v)), true); }
function $pstore_r(a, v) { $mdv.setFloat64(a, v, true); }
function $pstore_b(a, v) { $mdv.setUint8(a, v ? 1 : 0); }
function $pstore_p(a, p) {
  $mdv.setBigInt64(a, BigInt(p[0]), true);
  $mdv.setBigInt64(a + 8, BigInt(p[1]), true);
  $mdv.setBigInt64(a + 16, BigInt(p[2]), true);
  return p;
}
function $pstore_t(a, v) { $mdv.setBigInt64(a, BigInt(v), true); return v; }

/* 线性内存（ADR-0017 第二刀）。与上面那块 arena（$mem/$mtop，指针用的）是**两块**内存：
   arena 是"分配出来的块"，这一块是"一整片可寻址的字节"。名字全带 lin 前缀，别混。
   算法与 interp/builtin.js 里那一份逐条相同（那份是宿主函数、这份是拼进产物的文本），
   越界那句话也与 omni_linmem.c 逐字节相同 —— tests/sexpr 五条腿的判据在盯这件事。
   字节序固定小端：每次 DataView 调用都显式传 true。 */
let $linMem = null;
let $linDv = null;
let $linBy = null;
let $linMax = 0;
function $lin_init(minPages, maxPages) {
  $linMem = new ArrayBuffer(minPages * 65536);
  $linDv = new DataView($linMem);
  $linBy = new Uint8Array($linMem);
  $linMax = maxPages;
}
function $lin_data(off, bytes) {
  if ($linMem === null) $rt_error("memory access without a memory");
  if (off < 0 || off + bytes.length > $linMem.byteLength) {
    $rt_error("data segment does not fit in memory: " + off + "+" + bytes.length
      + " (size " + $linMem.byteLength + ")");
  }
  $linBy.set(bytes, off);
}
function $lin_size() { return $linMem === null ? 0 : $linMem.byteLength / 65536; }
function $lin_grow(n) {
  if ($linMem === null) $rt_error("memory access without a memory");
  const add = Number(n);
  const old = $linMem.byteLength / 65536;
  if (add < 0) return -1;
  const want = old + add;
  if (want > 65536) return -1;
  if ($linMax !== 0 && want > $linMax) return -1;
  if (add === 0) return old;
  const nb = new ArrayBuffer(want * 65536);
  new Uint8Array(nb).set($linBy);
  $linMem = nb;
  $linDv = new DataView($linMem);
  $linBy = new Uint8Array($linMem);
  return old;
}
function $lin_at(addr, off, bytes) {
  if ($linMem === null) $rt_error("memory access without a memory");
  const a = Number(addr) + off;
  if (a < 0 || a + bytes > $linMem.byteLength) {
    $rt_error("memory access out of bounds: " + a + "+" + bytes
      + " (size " + $linMem.byteLength + ")");
  }
  return a;
}
function $lin_ld_i8s(a, o) { return $linDv.getInt8($lin_at(a, o, 1)); }
function $lin_ld_i8u(a, o) { return $linDv.getUint8($lin_at(a, o, 1)); }
function $lin_ld_i16s(a, o) { return $linDv.getInt16($lin_at(a, o, 2), true); }
function $lin_ld_i16u(a, o) { return $linDv.getUint16($lin_at(a, o, 2), true); }
function $lin_ld_i32s(a, o) { return $linDv.getInt32($lin_at(a, o, 4), true); }
function $lin_ld_i32u(a, o) { return $linDv.getUint32($lin_at(a, o, 4), true); }
function $lin_ld_i64(a, o) { return $CN($linDv.getBigInt64($lin_at(a, o, 8), true)); }
function $lin_ld_f32(a, o) { return $linDv.getFloat32($lin_at(a, o, 4), true); }
function $lin_ld_f64(a, o) { return $linDv.getFloat64($lin_at(a, o, 8), true); }
function $lin_st_i8(a, o, v) { $linDv.setUint8($lin_at(a, o, 1), Number(BigInt.asUintN(8, $B(v)))); return v; }
function $lin_st_i16(a, o, v) { $linDv.setUint16($lin_at(a, o, 2), Number(BigInt.asUintN(16, $B(v))), true); return v; }
function $lin_st_i32(a, o, v) { $linDv.setUint32($lin_at(a, o, 4), Number(BigInt.asUintN(32, $B(v))), true); return v; }
function $lin_st_i64(a, o, v) { $linDv.setBigInt64($lin_at(a, o, 8), BigInt.asIntN(64, $B(v)), true); return v; }
function $lin_st_f32(a, o, v) { $linDv.setFloat32($lin_at(a, o, 4), v, true); return v; }
function $lin_st_f64(a, o, v) { $linDv.setFloat64($lin_at(a, o, 8), v, true); return v; }

function $psub(p, q, size) {
  if (p[1] !== q[1] || p[2] !== q[2]) $rt_error("pointer difference across different blocks");  return (p[0] - q[0]) / size;
}
// 走到块外**不报错**（只有解引用才报）：jancy 的 p += i 是合法的，*p 才是那句
// out-of-bounds（type_ptr_data.rst 里的例子就是先加再解引用）。
function $padd(p, k, size) { return [p[0] + Number(k) * size, p[1], p[2]]; }

// 缓冲（ADR-0014 门槛 7 第一阶段）：一段连续的 int/real + 一个长度，引用语义。
// 越界的消息与 list 那句同一个形状 —— 那句已经在三份实现里对齐过，照它写就不必再对一次。
// int 换成规范化的 number|BigInt 之后（见文件头）两种元素的零值都是 0，所以不再问元素类型。
function $bnew(n) {
  const len = Number(n);
  if (len < 0) $rt_error("buffer length cannot be negative: " + len);
  const o = [];
  for (let i = 0; i < len; i++) o.push(0);
  return o;
}
// 下标那两个与 $aget/$aset 同一条快路（undefined 当哨兵，见下面数组那一段的长注释）：
// 缓冲的元素只有 int / real 两种，零值都是 0，所以"读回来是 undefined"就是"不在界内"。
function $bget(a, i) {
  const v = a[i];
  return v === undefined ? $bslow(a, i) : v;
}
function $bslow(a, i) {
  const n = typeof i === "number" ? i : Number(i);
  if (n < 0 || n >= a.length) $rt_error("buffer index out of range: " + n + " (length " + a.length + ")");
  return a[n];
}
function $bset(a, i, v) {
  if (a[i] === undefined) {
    const n = typeof i === "number" ? i : Number(i);
    if (n < 0 || n >= a.length) $rt_error("buffer index out of range: " + n + " (length " + a.length + ")");
    a[n] = v;
    return v;
  }
  a[i] = v;
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
// int 换成规范化的 number|BigInt 之后（见文件头）：$alen 直接回 a.length（不再造 BigInt）。
//
// 边界检查用 **undefined 当哨兵**：数组是密的（$anew 一个个 push 出来），而方言的每种
// 元素类型都有零值，所以"读回来是 undefined"等价于"这个下标不在界内"。于是热路上只剩
// 一次读 + 一次比。三种情形落到慢路，那儿照老规矩重算一遍 —— **消息一个字不变**：
//   下标越界 / 负数        a[i] 是 undefined -> 慢路报那句话
//   下标是 BigInt          a[5n] 取的是属性 "5"，值对；大到印不成下标时是 undefined -> 慢路
//   元素真的是 undefined   只有 arr<dynamic> 装得进（JS 前端的 js_undef）-> 慢路照样交出去
// 量出来的（三对角消元内核，best of 5）：94.9ms -> 34.6ms，手写 a[i] 的天花板是 31.3ms。
// （注意这一整份是 String.raw 里的正文 —— 反引号会把它截断，注释里也不能写。）
function $alen(a) { if (a === null) $rt_error("null reference"); return a.length; }
function $aget(a, i) {
  if (a === null) $rt_error("null reference");
  const v = a[i];
  return v === undefined ? $agetslow(a, i) : v;
}
function $agetslow(a, i) {
  const n = typeof i === "number" ? i : Number(i);
  if (n < 0 || n >= a.length) $rt_error("array index out of range: " + n + " (length " + a.length + ")");
  return a[n];
}
function $aset(a, i, v, cp) {
  if (a === null) $rt_error("null reference");
  if (a[i] === undefined) return $asetslow(a, i, v, cp);
  a[i] = cp === true && Array.isArray(v) ? v.slice() : v;
  return v;
}
function $asetslow(a, i, v, cp) {
  const n = typeof i === "number" ? i : Number(i);
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
  // 整数快路。位数不超过 P 时 exp < P，%.*g 于是走定点那一支，而整数没有小数部分可去 ——
  // 结果就是 String(x)。1e21 那道界是因为再大 String 会印成指数形式。
  // 与下面那条慢路差分对过：整数 -2000..2000、10 的各次幂附近、2^53 两侧，
  // 加上一批非整数，P 取 1/2/3/4/5/6/7/9/15/17 —— 40610 组**一处不差**。
  // 出图时每个坐标都过这儿（profile 里 $fmt_g 占 6.7%），而坐标里整数是常客。
  if (Number.isInteger(x) && Math.abs(x) < 1e21) {
    const s = String(x);
    if (s.length - (x < 0 ? 1 : 0) <= P) return s;
  }
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
function $str_base(v, b) { return $U(v).toString(Number(b)); }

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
  // t 已经是整数值：安全范围内直接就是规范形（顺手把 -0 归成 0），否则过一趟 BigInt
  if (t >= -$ISAFE && t <= $ISAFE) return t === 0 ? 0 : t;
  return $CN(BigInt(t));
};

// 位重解释（ADR-0019 路 1）：位不动，只换一种读法。getBigInt64/setBigInt64 正好就是
// int64 那一格，所以两个方向都不用再截 —— 只在出口过一次 $CN、入口过一次 $B（见文件头）。
// **不是** $trunc 那种转换：这儿没有范围检查，因为每个 f64 的位模式都是一个合法 int64。
const $realbits = (x) => {
  const bdv = new DataView(new ArrayBuffer(8));
  bdv.setFloat64(0, x);
  return $CN(bdv.getBigInt64(0));
};
const $bitsreal = (i) => {
  const bdv = new DataView(new ArrayBuffer(8));
  bdv.setBigInt64(0, $B(i));
  return bdv.getFloat64(0);
};

// 引用的身份整数（方言的 refid）。JS 这边没有指针，所以拿一张 WeakMap **发号**：
// 第一次问才给号（从 1 起），空引用是 0。与 C 那条腿的"指针值"不是同一批数 ——
// 语义只承诺"同一次运行里同一个引用同一个数、不同引用不同数"，两边都满足；
// 唯一的用处（asy 那本 cyclic 登记册的散列桶下标）也只要这一条。
const $refids = new WeakMap();
let $refidn = 0;
const $refid = (o) => {
  if (o === null || o === undefined) return 0;
  let v = $refids.get(o);
  if (v === undefined) { v = ++$refidn; $refids.set(o, v); }
  return v;
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
function $slen(s) { return $bytes(s).length; }
function $byteAt(s, i) {
  const b = $bytes(s), n = typeof i === "number" ? i : Number(i);
  if (n < 0 || n >= b.length) $rt_error("string index out of range: " + n + " (length " + b.length + ")");
  return b[n];
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
    return i;
  }
  return -1;
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
  return $CN(v);
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
// (getenv E)：读宿主的一格环境设置，没设就是空串（与 omni_get_env 一一对应）。
// 这一格是"运行期才定的值"的唯一入口 —— asy 的输出格式走它（ADR-0015）。
function $get_env(n) {
  var v = process.env[n];
  return v === undefined || v === null ? "" : v;
}
// (writetext P E)：整份写一份文本文件，回写进去的字节数。与 omni_write_text 一一对应。
function $write_text(p, t) {
  try {
    $node("node:fs").writeFileSync(p, t);
  } catch (e) {
    $rt_error("cannot write '" + p + "': " + (e && e.code ? e.code : String(e)));
  }
  return $node("node:buffer").Buffer.byteLength(t, "utf8");
}
// (runproc CMD)：/bin/sh -c CMD，回退出码。两个流全捕获后丢掉 —— 这一层的 stdout 是
// 图本身，被调程序的絮絮叨叨混进去就把图弄坏了。跑不起来也回非 0，不抛。
function $run_proc(cmd) {
  try {
    var r = $node("node:child_process").spawnSync("/bin/sh", ["-c", cmd],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });
    if (r.error) return 127;
    return r.status === null ? 128 : r.status;
  } catch (e) {
    return 127;
  }
}
// (r3render PATH)：三维那一档的光栅化。权威在 C（runtime/omni_r3.c，照 reference 的
// glrender.cc/renderBase.cc 与两份 glsl 转写）。这条腿回空串 = "这儿没有光栅化器"，
// 调用方会走 gs 那条旧路。等 C 那份定稿再照抄成 JS，届时两边要逐字节对上。
function $r3_render(p, nums) { return ""; }
// ---------------------------------------------------------------- 容器
// list -> Array，dict -> Map（插入序，ADR-0006 的硬约束），set -> Set
// 键的显示形式（只在 "key not found" 那句里用，冷路径）要**按静态类型**给：int 换成
// 规范化的 number|BigInt 之后，宿主的 typeof 分不开 int 与 real 了（1 与 1.0 都是 number），
// 而 C 侧 omni_kstr_int 走 %lld、omni_kstr_real 走 %g —— 10000000000 两边一个是
// "10000000000" 一个是 "1e+10"。所以 kk 由发射方按 dict 的键类型填。
function $keyStr(k, kk) {
  if (kk === "int") return k.toString();
  if (kk === "real") return $fmt_real(k);
  if (kk === "bool") return k ? "true" : "false";
  return '"' + k + '"';
}
function $listGet(a, i) {
  const n = typeof i === "number" ? i : Number(i);
  if (n < 0 || n >= a.length) $rt_error("list index out of range: " + n + " (length " + a.length + ")");
  return a[n];
}
function $listSet(a, i, v) {
  const n = typeof i === "number" ? i : Number(i);
  if (n < 0 || n >= a.length) $rt_error("list index out of range: " + n + " (length " + a.length + ")");
  a[n] = v;
  return v;
}
function $listPop(a) {
  if (!a.length) $rt_error("pop from empty list");
  return a.pop();
}
function $dictGet(m, k, kk) {
  if (!m.has(k)) $rt_error("key not found: " + $keyStr(k, kk));
  return m.get(k);
}
function $dictSet(m, k, v) { m.set(k, v); return v; }
// 深装箱（ADR-0008）里 dict 那一支：键照抄，值逐个换表示。见 backend-js/emit.js 的 boxDeepJs。
function $mapVals(m, f) {
  const o = new Map();
  for (const kv of m) o.set(kv[0], f(kv[1]));
  return o;
}

// ---------------------------------------------------------------- dynamic
// 直接用 JS 原生值：null / boolean / BigInt(int) / number(real) / string / Array / Map，
// 外加两个只由 JS 前端产生的标签（ADR-0011）：undefined，以及函数值（闭包记录）
//
// Map 与 Set 的底子也是 Map（键都规范化成带标签的字符串，和 C 侧一样），但标签必须
// 和普通对象分开 —— o.has(k) 这种成员派发只有标签能区分。所以造两个子类。
class $JsMap extends Map {}
class $JsSet extends Map {}
// 正则对象（ADR-0011 决策 10 的第二半）。刻意**不用宿主的 RegExp 当这一格的载体**：
// lastIndex 的推进要与 C 侧逐字对应，靠宿主自己那份状态两边就分叉了。编译产物也不存在
// 这里 —— exec 每次照旧问 $js_re_get 要，缓存键就是 (src, flags)，与 C 侧同一个口径。
class $JsRe {
  constructor(src, flags) {
    this.src = src;
    this.flags = flags;
    this.li = 0;
  }
}
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
      if (v instanceof $JsRe) return "regexp";
      if (v instanceof $JsBytes) return "bytes";
      if (v instanceof $JsTextEnc) return "TextEncoder";
      // ADR-0020 P1 的两格新值：真对象与 Symbol。摆在 "function" 兜底**之前** ——
      // 兜底认的是闭包记录 { fp, … }，而这两格都不是可调用的东西。
      if (v instanceof $JSObj) return "object";
      if (v instanceof $JSSym) return "symbol";
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
// 「具名函数当值用」那一份**单件**（(fnref f) 的薄适配器，见 sexpr/lower.js 的 fnRef）。
// 为什么要按名字进这张全局表、而不是把缓存挂在造它的那个小函数上：一个程序由**多份产物**
// 拼起来（ESM 多模块），而这个薄适配器是"谁取地址谁发一份"——同一个具名函数在 graph 那份
// 产物里发一次、在例子那份里又发一次，各自的缓存于是两个不同对象，f == g 还是假。
// 量出来的：graph.asy:1922 的 if(T == identity) 走错分支，Log 轴的取样从"对数均匀"
// 变成"线性均匀"（alignedaxis 792 处数值差）。这张表在运行时那一份模块里，全程只有一份。
const $fnOnes = new Map();
function $fnOne(key, mk) {
  let o = $fnOnes.get(key);
  if (o === undefined) { o = mk(); $fnOnes.set(key, o); }
  return o;
}
// 成员派发的兜底（ADR-0011 决策 12）：派发器的形参个数是表里的最大值，末尾多出来的
// undefined 等于没给 —— 削掉再调，C 侧的 omni_js_call_n 是同一套。
function $js_call_n(f, args) {
  return $js_call_n_this(f, undefined, args);
}
/* 带接收者的那一份（ADR-0020 P1）：o.m(x) 落到兜底上时，this **就是 o** ——
   原型上的方法、类的方法全靠这一格。从前这儿丢掉了接收者，于是 b.get() 里的
   this 是 undefined（量出来的：REPL 那条 js 会话印 "cannot read 'v' of undefined"）。 */
function $js_call_n_this(f, recv, args) {
  let n = args.length;
  while (n > 0 && args[n - 1] === undefined) n--;
  return $callThis($js_asFn(f), recv, args.slice(0, n));
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
  if (t === "symbol") return "symbol";
  if (t === "undefined") return "undefined";
  /* 类对象在这个值域里是一格**真对象**（原型 + $init 那格闭包，见降级器的 classInitKey），
     不是函数值 —— 可 typeof 得说 "function"，不然 typeof A === "function" 这类最常见的
     鸭子判断会静静地走错。判据取**自有**的 classInit 槽：不走 [[Get]]，所以不会碰上取值器。
     C 那条腿上没有类对象（ADR-0020 P1-c），这一支在那儿到不了。 */
  if (t === "object" && v.ps !== undefined && v.ps.has($js_pkey($js_sym_wk("omni.classInit")))) {
    return "function";
  }
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
    // String(/x/g) 是 "/x/g"
    case "regexp": return "/" + v.src + "/" + v.flags;
    // ADR-0020 P1：真对象走 ToPrimitive（hint string），Symbol 只有显式 String() 才给字
    // —— 这一格与 JS 一致：模板与 "+" 上碰到 Symbol 是 TypeError，那两处不经过这里。
    case "object": return $js_str($js_to_prim("s", v));
    // 数组的 String() 就是 join(",")（Array.prototype.toString），ADR-0020 P1
    case "list": return $js_arr_prim(v);
    case "symbol": return $js_sym_str(v);
    /* String(new Map()) 是 "[object Map]"：规范里它走 Object.prototype.toString，
       而那一格看的是 Symbol.toStringTag（Map / Set 各有一格）。照标签直说，
       与 C 的 to_s16 对着写。 */
    case "Map": return "[object Map]";
    case "Set": return "[object Set]";
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
  // 对象与数组先 ToPrimitive（规范 ApplyStringOrNumericBinaryOperator 第 1 步）。
  // 从前这个值域里没有"能转成原始值的东西"，所以这一格空着（ADR-0020 P1）。
  a = $js_prim("d", a);
  b = $js_prim("d", b);
  if ($dynTag(a) === "string" || $dynTag(b) === "string") return $js_str(a) + $js_str(b);
  a = $js_tonum(a);
  b = $js_tonum(b);
  $js_num2("+", a, b);
  return $dynTag(a) === "int" ? $DW(a + b) : a + b;
}
/* 算术/比较之前把对象与数组摊成原始值。数组那一条是 Array.prototype.toString ——
   规范里它就是 join(",")（null 与 undefined 变空串），所以 [1,2] + "" 是 "1,2"。 */
function $js_prim(hint, v) {
  const t = $dynTag(v);
  if (t === "object") return $js_to_prim(hint, v);
  if (t === "list") return $js_arr_prim(v);
  return v;
}
function $js_arr_prim(v) {
  let s = "";
  for (let i = 0; i < v.length; i++) {
    if (i) s += ",";
    const x = v[i];
    if (x === undefined || x === null) continue;
    s += $js_asS16($js_str(x));
  }
  return s;
}
// 幂的 int 那一支：平方求幂，每一步都回卷。回卷是模 2^64 的环同态，所以这与
// "先算精确值再回卷"逐位相同，而且不会为了 2n ** 1000000n 去开一块天文数字的内存。
function $js_ipow(a, b) {
  if (b < 0n) $rt_error("exponent must not be negative in '**' with bigint operands");
  let r = 1n;
  let x = $DW(a);
  let n = b;
  while (n > 0n) {
    if ((n & 1n) === 1n) r = $DW(r * x);
    x = $DW(x * x);
    n >>= 1n;
  }
  return r;
}
/* 非数的原始值先 ToNumber（规范 ApplyStringOrNumericBinaryOperator 第 3 步的 ToNumeric）：
   "3" * "4" 是 12、true + true 是 2、null + 1 是 1、undefined - 1 是 NaN。bigint 不转
   —— 混着算在 JS 里是 TypeError，这儿由 $js_num2 当场报。Symbol 也照旧由 $js_num_of 报。
   从前这两处一律报 "cannot apply '*' to string and string"（loud，而两把尺子都给答案）。 */
function $js_tonum(v) {
  const t = $dynTag(v);
  return t === "int" || t === "real" ? v : $js_num_of(v);
}
function $js_arith(op, a, b) {
  // 对象与数组先 ToPrimitive（hint number），与 js_add 那一处同一条规矩
  a = $js_tonum($js_prim("n", a));
  b = $js_tonum($js_prim("n", b));
  $js_num2(op, a, b);
  const isInt = $dynTag(a) === "int";
  switch (op) {
    case "-": return isInt ? $DW(a - b) : a - b;
    case "*": return isInt ? $DW(a * b) : a * b;
    case "/": return isInt ? $ddiv(a, b) : a / b;
    case "%": return isInt ? $dmod(a, b) : $fmod(a, b);
    case "p": return isInt ? $js_ipow(a, b) : a ** b;
    default: $rt_error("unknown arithmetic op '" + op + "'");
  }
}
function $js_neg(a) {
  const t = $dynTag(a);
  if (t === "int") return $DW(-a);
  if (t === "real") return -a;
  /* 别的一律先 ToNumber（规范 13.5.5 的一元负号先 ToNumeric）：-"3" 是 -3、-true 是 -1、
     -[] 是 -0、-{} 是 NaN。从前这儿直接报"cannot negate string"（loud，但两把尺子都给
     答案）。bigint 已经在上面那两支里了，所以这儿转的都是 Number。 */
  return -$js_num_of(a);
}
/* Number 上的位运算（规范 7.1.6 ToInt32）：先截成 int32，结果是 Number。
   int（= BigInt / 方言的 int64）这一支不走这儿 —— JS 里 bigint 与 number 混着做位运算是
   TypeError，而这个值域里两者同一个标签，所以判据只能是"两边都 int 才按 64 位算"。 */
function $js_toi32(v) {
  if ($dynTag(v) === "int") return Number(BigInt.asIntN(32, v));
  return Number($js_num_of(v)) | 0;   // NaN / Infinity 都是 0
}
function $js_bitop(op, a, b) {
  const ta = $dynTag(a), tb = $dynTag(b);
  if (ta !== "int" || tb !== "int") {
    const x = $js_toi32(a), y = $js_toi32(b);
    switch (op) {
      case "&": return x & y;
      case "|": return x | y;
      case "^": return x ^ y;
      case "<": return x << (y & 31);
      case ">": return x >> (y & 31);
      default: $rt_error("unknown bitwise op '" + op + "'");
    }
  }
  switch (op) {
    case "&": return a & b;
    case "|": return a | b;
    case "^": return a ^ b;
    case "<": return $DW(a << (b & 63n));
    case ">": return a >> (b & 63n);
    default: $rt_error("unknown bitwise op '" + op + "'");
  }
}
// 一元 ~ 单独一个 op：ABI 里所有 op 的实参个数是定的，不做可变长
function $js_bitnot(a) {
  if ($dynTag(a) !== "int") return ~$js_toi32(a);
  return $DW(~a);
}
function $js_cmp(op, a, b) {
  // 关系运算也先 ToPrimitive（hint number），规范 IsLessThan 第 1 步
  a = $js_prim("n", a);
  b = $js_prim("n", b);
  const ta = $dynTag(a), tb = $dynTag(b);
  let c;
  if (ta === "string" && tb === "string") {
    // 与 Omni 的 string 比较走同一条规则（JS 后端一直是宿主的 < ，见 ADR-0005 的已知偏差）
    c = a < b ? -1 : (a > b ? 1 : 0);
  } else {
    /* 混着比（"2" > 1、[2] > 1、null >= 0、undefined > 0）：规范 7.2.13 —— 只有两边都是
       串才按串比，否则**两边都 ToNumber**。串解析不动就是 NaN，NaN 上一切关系比较都 false。
       从前这儿是当场报错，于是这一族写法整条腿走不通（qjs 与 node 都照上面那条给答案）。 */
    if ($dynTag(a) === "int" && $dynTag(b) === "int") {
      // 两个 bigint 之间精确比：Number() 在 2^53 以上丢位，而 BigInt 的 < 是精确的。
      // C 侧的 int_cmp 是同一条规则 —— 两边都精确，大数上才不分叉。
      c = a < b ? -1 : (a > b ? 1 : 0);
    } else {
      const x = Number($js_num_of(a)), y = Number($js_num_of(b));
      if (Number.isNaN(x) || Number.isNaN(y)) return false;
      c = x < y ? -1 : (x > y ? 1 : 0);
    }
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
/* Object.is（SameValue，规范 7.2.11）：与 === 只差两格 —— NaN 与自己相同、+0 与 -0 不同。
   剩下的转手严格相等（C 那份一样的分工）。 */
function $js_same_value(a, b) {
  if ($dynTag(a) === "real" && $dynTag(b) === "real") {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    if (a === 0 && b === 0) return (1 / a) === (1 / b);
  }
  return $js_eq(true, a, b);
}
function $js_eq(strict, a, b) {  const ta = $dynTag(a), tb = $dynTag(b);
  if (!strict) {
    const an = ta === "null" || ta === "undefined";
    const bn = tb === "null" || tb === "undefined";
    if (an || bn) return an && bn;
    const num = (t) => t === "int" || t === "real";
    // 两个 bigint 之间精确比（Number() 在 2^53 以上丢位，C 侧的 int_cmp 也是精确的）
    if (ta === "int" && tb === "int") return a === b;
    if (num(ta) && num(tb)) return Number(a) === Number(b);
    // 对象 == 原始值：先把对象 ToPrimitive（规范 IsLooselyEqual 第 10、11 步），再比一次。
    // ADR-0020 P1 —— 从前这个值域里没有"能转成原始值的对象"，所以这一格不存在。
    // **数组也算**（[] == false 与 [1] == 1 都是 true）：从前只看了真对象那一支，
    // 于是数组那一格静静地给 false。$js_prim 认得 list（摊成 join(",")）与真对象两种。
    const prim = (t) => t === "string" || t === "int" || t === "real" || t === "bool" || t === "symbol";
    const objish = (t) => t === "object" || t === "list";
    if (objish(ta) && prim(tb)) return $js_eq(false, $js_prim("d", a), b);
    if (prim(ta) && objish(tb)) return $js_eq(false, a, $js_prim("d", b));
    // 字符串与数、布尔与别的：照规范都先转成数（这一格从前也不在，补齐）
    if (ta === "string" && num(tb)) return $js_num_of(a) === Number(b);
    if (num(ta) && tb === "string") return Number(a) === $js_num_of(b);
    if (ta === "bool") return $js_eq(false, a ? 1 : 0, b);
    if (tb === "bool") return $js_eq(false, a, b ? 1 : 0);
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
/* 下标那一族的实参照规范走 **ToIntegerOrInfinity**（7.1.5）：先 ToNumber，NaN 当 0，其余截尾。
   所以 "1" / true / null 都收得下 —— indexOf 的第二格给串，两把尺子上是 1，从前这儿
   当场报 "string index must be a number"（量出来的）。 */
function $js_idx(v, dflt) {
  if (v === undefined) return dflt;
  const n = $js_num_of(v);
  return Number.isNaN(n) ? 0 : Math.trunc(n);
}
/* console.log 印一格值：与 ToString 只差一处 —— **-0 印成 "-0"**。String(-0) 是 "0"，
   而 qjs 与 node 的 console.log 都印 -0（量过），所以印这条路上单独一格 op。
   bigint **不补 n**（两把尺子都印 30n，这里是有意的分叉）：C 那条腿上 JS 的 bigint 与
   方言的 int64 是同一个标签，分不开 "30n" 与"方言里的 int 30"，补了 n 方言的 println
   就全错（量出来的：tests/oir 的 whole program 印成 77n）。数组/对象/Map/Set/函数/Symbol
   的**检视**格式也不在这儿追：两把尺子自己就不一致（node 印 [ 'a' ]、qjs 印 [ "a" ]，
   嵌套深了 qjs 还印 [Array]），照 String() 走。见 ADR-0020 的口径那一节。 */
function $js_disp(v) {
  return typeof v === "number" && Object.is(v, -0) ? "-0" : $js_str(v);
}
function $js_println(v) { $print($js_disp(v)); }
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
function $js_str_char_at(s, i) {
  const v = $js_asS16(s), k = $js_idx(i, 0);
  // 越界是**空串**（规范 22.1.3.1）；也不认负下标 —— 那是 .at() 的事
  return k < 0 || k >= v.length ? "" : v[k];
}
function $js_str_char_code_at(s, i) {
  const v = $js_asS16(s), k = $js_idx(i, 0);
  return k < 0 || k >= v.length ? NaN : v.charCodeAt(k);
}
function $js_str_code_point_at(s, i) {
  const v = $js_asS16(s), k = $js_idx(i, 0);
  return k < 0 || k >= v.length ? undefined : v.codePointAt(k);
}
/* localeCompare（规范 22.1.3.12 的口径是"实现定义但一致"）。没有 ICU，所以照 qjs 那份：
   按**码点**比（代理对要先拼起来），第一处不同给两个码点的差，一个是另一个的前缀就给
   码点个数的差。量过 qjs："é".localeCompare("e") 是 132（0xE9 - 0x65）、
   "\u{1F600}".localeCompare("\uFFFF") 是 62977（0x1F600 - 0xFFFF）—— 后一格证明它比的是
   码点而不是码元（按码元的话头一格是 0xD83D，差会是负的）。
   node 带 ICU，所以只有**符号**在两把尺子上一致（非 ASCII 的次序更是不一样）。
   C 那份（omni_js_str_locale_cmp）逐行对着写。 */
function $js_str_locale_cmp(a, b) {
  const x = $js_asS16(a), y = $js_asS16($js_str(b));
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    const cx = x.codePointAt(i), cy = y.codePointAt(j);
    if (cx !== cy) return cx - cy;
    i += cx > 0xFFFF ? 2 : 1;
    j += cy > 0xFFFF ? 2 : 1;
  }
  return $js_cp_count(x, i) - $js_cp_count(y, j);
}
// 从 from 起还有几个**码点**（代理对算一个）
function $js_cp_count(v, from) {
  let n = 0;
  let k = from;
  while (k < v.length) {
    k += v.codePointAt(k) > 0xFFFF ? 2 : 1;
    n++;
  }
  return n;
}
function $js_str_slice(s, a, b) {  const v = $js_asS16(s);
  return v.slice($js_idx(a, 0), $js_idx(b, v.length));
}
function $js_str_repeat(s, n) {
  const k = $js_idx(n, 0);
  if (k < 0) $rt_error("repeat count must not be negative");
  return $js_asS16(s).repeat(k);
}
/* String.raw 的**普通调用**形态：String.raw({ raw: [...] }, ...subs)。tag 形态在降级器
   那儿就折成字面量了，这一份只管手写的调用。规范 22.1.2.6：段数看 raw.length，最后一段
   后面不再拼插值；插值不够就当没有（不是拼 "undefined"）。 */
function $js_str_raw(strs, subs) {
  const raw = $js_obj_get(strs, "raw");
  const n = $js_arr_len(raw), vs = $js_arr_of(subs);
  let out = "";
  for (let i = 0; i < n; i++) {
    out = out + $js_str($js_arr_get(raw, i));
    if (i + 1 < n && i < vs.length) out = out + $js_str(vs[i]);
  }
  return out;
}
/* 四个 URI 全局函数（规范 19.2.6）。op 码：'e' encodeURIComponent / 'E' encodeURI /
   'd' decodeURIComponent / 'D' decodeURI。手划 UTF-8 编解码（不转手宿主的同名函数）——
   宿主在畸形输入上抛的是 URIError，这个值域里没有"宿主抛的错"，所以自己先查一遍，
   两条腿的报错文本才逐字相同。encodeURI 多留一族保留字符，decodeURI 反过来**不换**
   那一族（原样留着 %XX 的三个字符）。 */
const $JS_URI_KEEP = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()";
const $JS_URI_RESERVED = ";/?:@&=+$,#";
const $JS_URI_HEX = "0123456789ABCDEF";
function $js_uri_pct(b) { return "%" + $JS_URI_HEX[(b >> 4) & 15] + $JS_URI_HEX[b & 15]; }
// s[i] 是 '%'：读出那一组两位十六进制的字节值
function $js_uri_byte(s, i) {
  if (i + 2 >= s.length) throw new $HostBad("URI malformed", "URIError");
  const h = $JS_URI_HEX.indexOf(s[i + 1].toUpperCase());
  const l = $JS_URI_HEX.indexOf(s[i + 2].toUpperCase());
  if (h < 0 || l < 0) throw new $HostBad("URI malformed", "URIError");
  return h * 16 + l;
}
function $js_uri_enc(s, keep) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (keep.indexOf(c) >= 0) { out = out + c; continue; }
    // 落单的代理项在这儿就是畸形：配好对的 codePointAt 给的是 > 0xFFFF 的码点
    const cp = s.codePointAt(i);
    if (cp >= 0xD800 && cp <= 0xDFFF) throw new $HostBad("URI malformed", "URIError");
    if (cp > 0xFFFF) i++;
    if (cp < 0x80) out = out + $js_uri_pct(cp);
    else if (cp < 0x800) out = out + $js_uri_pct(0xC0 | (cp >> 6)) + $js_uri_pct(0x80 | (cp & 63));
    else if (cp < 0x10000) {
      out = out + $js_uri_pct(0xE0 | (cp >> 12)) + $js_uri_pct(0x80 | ((cp >> 6) & 63))
        + $js_uri_pct(0x80 | (cp & 63));
    } else {
      out = out + $js_uri_pct(0xF0 | (cp >> 18)) + $js_uri_pct(0x80 | ((cp >> 12) & 63))
        + $js_uri_pct(0x80 | ((cp >> 6) & 63)) + $js_uri_pct(0x80 | (cp & 63));
    }
  }
  return out;
}
function $js_uri_dec(s, keep) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "%") { out = out + s[i]; continue; }
    const start = i;
    const b0 = $js_uri_byte(s, i);
    i += 2;
    if (b0 < 0x80) {
      const c = String.fromCharCode(b0);
      out = out + (keep.indexOf(c) >= 0 ? s.slice(start, i + 1) : c);
      continue;
    }
    // 首字节定长度：C2..DF 两字节、E0..EF 三字节、F0..F4 四字节（C0/C1 是过长编码）
    let n = 0;
    if (b0 >= 0xC2 && b0 <= 0xDF) n = 1;
    else if (b0 >= 0xE0 && b0 <= 0xEF) n = 2;
    else if (b0 >= 0xF0 && b0 <= 0xF4) n = 3;
    else throw new $HostBad("URI malformed", "URIError");
    let cp = b0 & (n === 1 ? 31 : n === 2 ? 15 : 7);
    for (let k = 0; k < n; k++) {
      i++;
      if (i >= s.length || s[i] !== "%") throw new $HostBad("URI malformed", "URIError");
      const b = $js_uri_byte(s, i);
      i += 2;
      if (b < 0x80 || b > 0xBF) throw new $HostBad("URI malformed", "URIError");
      cp = (cp << 6) | (b & 63);
    }
    // 过长编码、代理项区间、超出 10FFFF 一律算畸形
    if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) throw new $HostBad("URI malformed", "URIError");
    if (n === 2 && cp < 0x800) throw new $HostBad("URI malformed", "URIError");
    if (n === 3 && cp < 0x10000) throw new $HostBad("URI malformed", "URIError");
    out = out + String.fromCodePoint(cp);
  }
  return out;
}
function $js_uri(op, x) {
  const s = $js_asS16($js_str(x));
  /* 畸形输入是**能 catch 的 URIError**（ADR-0020）：enc / dec 那两段里错误点有九处，
     所以出错点抛信号、在这儿收一次（见文件开头的 $HostBad 那一段）。 */
  try {
    if (op === "e") return $js_uri_enc(s, $JS_URI_KEEP);
    if (op === "E") return $js_uri_enc(s, $JS_URI_KEEP + $JS_URI_RESERVED);
    if (op === "d") return $js_uri_dec(s, "");
    return $js_uri_dec(s, $JS_URI_RESERVED);
  } catch (e) {
    return $js_host_err(e);
  }
}

// isWellFormed / toWellFormed（ES2024）：落单的代理项（没配对的 D800..DFFF）算"不良",// toWellFormed 把每个落单的替成 U+FFFD。C 那份是手划码元的同一套判据。
function $js_str_is_well_formed(s) { return $js_asS16(s).isWellFormed(); }
function $js_str_to_well_formed(s) { return $js_asS16(s).toWellFormed(); }
function $js_str_pad_start(s, n, fill) {
  return $js_asS16(s).padStart($js_idx(n, 0), fill === undefined ? " " : $js_asS16(fill));
}
function $js_str_pad_end(s, n, fill) {
  return $js_asS16(s).padEnd($js_idx(n, 0), fill === undefined ? " " : $js_asS16(fill));
}
// replaceAll 的字符串模式那一支。替换串里的 $& / $1 一律当**普通字符**：
// 宿主的 replaceAll 会认它们，所以这里不能直接转手，手写一遍才和 C 侧同样残缺。
// 空模式照 JS 的样子在每个码元之间各插一份（"abc" 上插出 -a-b-c-）。
function $js_str_replace_all(s, pat, rep) {
  // 运行期的正则（存进变量的 new RegExp(...)）：转给正则那一支，语义一字不差
  if ($dynTag(pat) === "regexp") return $js_re_replace($js_re_source(pat), $js_re_flags(pat), s, rep);
  const v = $js_asS16(s), p = $js_asS16(pat);
  /* 替换可以是**函数**（收 (match, offset, string)）或带 $ 的串（$$ / $& / 前后文那两个
     —— 串模式没有编号组）。从前这儿一律 $js_asS16(rep)：函数当场报"function is not a
     string"，而 $& 那些被当普通字符抄了过去（两处都量出来了）。replace 那一支早就是
     这套判据，两格现在共用同一段。 */
  const isFn = $dynTag(rep) === "function";
  const rs = isFn ? "" : $js_asS16(rep);
  const sub = (at) => {
    if (isFn) return $js_str($callFn(rep, [p, at, v]));
    const m = [p];
    m.index = at;
    return $js_re_sub(rs, v, m);
  };
  if (p.length === 0) {
    let out = sub(0);
    for (let i = 0; i < v.length; i++) out += v[i] + sub(i + 1);
    return out;
  }
  let out = "", i = 0;
  for (;;) {
    const at = v.indexOf(p, i);
    if (at < 0) break;
    out += v.slice(i, at) + sub(at);
    i = at + p.length;
  }
  return out + v.slice(i);
}
/* replace(串, 替换)：只换**第一处**（规范 22.1.3.19 的非全局那一支）。替换可以是函数
   （收 (match, offset, string)）或带 $ 的串（$$ / $& / 前后文那两个 —— 串模式没有编号组）。
   正则那一支不走这儿：降级器把它发成 js_re_replace（regexCall）。 */
function $js_str_replace(s, pat, rep) {
  // 运行期的正则（new RegExp(...) 存进变量再用）：转给正则那一支，语义一字不差
  if ($dynTag(pat) === "regexp") return $js_re_replace($js_re_source(pat), $js_re_flags(pat), s, rep);
  const v = $js_asS16(s), p = $js_asS16(pat);
  const at = v.indexOf(p);
  if (at < 0) return v;
  const m = [p];
  m.index = at;
  const r = $dynTag(rep) === "function"
    ? $js_str($callFn(rep, [p, at, v]))
    : $js_re_sub($js_asS16(rep), v, m);
  return v.slice(0, at) + r + v.slice(at + p.length);
}
function $js_str_trim(side, s) {
  const v = $js_asS16(s);
  return side === "l" ? v.trimStart() : side === "r" ? v.trimEnd() : v.trim();
}
/* 只折 ASCII：C 侧不带 Unicode 大小写表（整个运行时的口径都是 ASCII-only —— 正则那边
   连 u 标志与 \p{...} 都是当场拒掉的）。碰上非 ASCII **当场报错**，不再悄悄按 ASCII 折：
   量出来的静默分叉是 "Straße".toUpperCase() 给 "STRAßE"（两把尺子都给 "STRASSE"）、
   "é".toUpperCase() 原样不动、"ΣΟΦΟΣ".toLowerCase() 也不动。这一族要么整张表要么拒掉，
   半张表只会在别处再撒一次谎。 */
/* 有大小写映射的码点（0x80 以上那一段）。表是从宿主量出来的 —— 判据就一行：
     String.fromCodePoint(cp).toLowerCase() !== ch || .toUpperCase() !== ch
   node 与 qjs 在这上面一致。C 那份是同一批数字（omni_js_str.c 的 CASED）。
   落在这些范围里的字符要真表才折得对（ß -> SS 这种还会变长），所以**当场报错**；
   不在表里的非 ASCII（CJK、标点、emoji）照原样留着 —— 那才是两把尺子的答案。 */
const $JS_CASED = "b5,c0-d6,d8-f6,f8-137,139-18c,18e-1a9,1ac-1b9,1bc-1bd,1bf,1c4-220,222-233,23a-254,256-257,259,25b-25"
  + "c,260-261,263-266,268-26c,26f,271-272,275,27d,280,282-283,287-28c,292,29d-29e,345,370-373,376-377,37"
  + "b-37d,37f,386,388-38a,38c,38e-3a1,3a3-3d1,3d5-3f5,3f7-3fb,3fd-481,48a-52f,531-556,561-587,10a0-10c5,"
  + "10c7,10cd,10d0-10fa,10fd-10ff,13a0-13f5,13f8-13fd,1c80-1c8a,1c90-1cba,1cbd-1cbf,1d79,1d7d,1d8e,1e00-"
  + "1e9b,1e9e,1ea0-1f15,1f18-1f1d,1f20-1f45,1f48-1f4d,1f50-1f57,1f59,1f5b,1f5d,1f5f-1f7d,1f80-1fb4,1fb6-"
  + "1fbc,1fbe,1fc2-1fc4,1fc6-1fcc,1fd0-1fd3,1fd6-1fdb,1fe0-1fec,1ff2-1ff4,1ff6-1ffc,2126,212a-212b,2132,"
  + "214e,2160-217f,2183-2184,24b6-24e9,2c00-2c70,2c72-2c73,2c75-2c76,2c7e-2ce3,2ceb-2cee,2cf2-2cf3,2d00-"
  + "2d25,2d27,2d2d,a640-a66d,a680-a69b,a722-a72f,a732-a76f,a779-a787,a78b-a78d,a790-a794,a796-a7ae,a7b0-"
  + "a7dc,a7f5-a7f6,ab53,ab70-abbf,fb00-fb06,fb13-fb17,ff21-ff3a,ff41-ff5a,10400-1044f,104b0-104d3,104d8-"
  + "104fb,10570-1057a,1057c-1058a,1058c-10592,10594-10595,10597-105a1,105a3-105b1,105b3-105b9,105bb-105b"
  + "c,10c80-10cb2,10cc0-10cf2,10d50-10d65,10d70-10d85,118a0-118df,16e40-16e7f,16ea0-16eb8,16ebb-16ed3,1e"
  + "900-1e943";
let $jsCased = null;
function $js_cased(cp) {
  if ($jsCased === null) {
    $jsCased = [];
    for (const part of $JS_CASED.split(",")) {
      const k = part.indexOf("-");
      const a = parseInt(k < 0 ? part : part.slice(0, k), 16);
      $jsCased.push(a, k < 0 ? a : parseInt(part.slice(k + 1), 16));
    }
  }
  for (let i = 0; i < $jsCased.length; i += 2) {
    if (cp >= $jsCased[i] && cp <= $jsCased[i + 1]) return true;
  }
  return false;
}
function $js_str_case_ascii(v, what) {
  for (let i = 0; i < v.length; i++) {
    const cp = v.codePointAt(i);
    if (cp > 0xffff) i++;
    if (cp > 0x7f && $js_cased(cp)) {
      $rt_error(what + ": no Unicode case table for U+" + cp.toString(16).toUpperCase() + " (ADR-0020)");
    }
  }
  return v;
}
function $js_str_lower(s) {
  const v = $js_str_case_ascii($js_asS16(s), "toLowerCase");
  return v.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}
function $js_str_upper(s) {
  const v = $js_str_case_ascii($js_asS16(s), "toUpperCase");
  return v.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));
}
function $js_str_index_of(s, needle, from) {
  return $js_asS16(s).indexOf($js_asS16(needle), $js_idx(from, 0));
}
// 第二个实参是"从哪一格往前找"（含）；缺省从末尾找。规范 22.1.3.11：位置先夹到
// [0, len]，匹配本身可以越过它往右伸。cli.js 的 inpPath 就是这么一段段往前切印记的，
// 少了这个实参，降级器会以为"这不是 ABI 那个 lastIndexOf"、退回通用取属性 ——
// 于是装好的那份读缓存时报 "string is not an object"。
function $js_str_last_index_of(s, needle, from) {
  const v = $js_asS16(s), n = $js_asS16(needle);
  return from === undefined ? v.lastIndexOf(n) : v.lastIndexOf(n, $js_idx(from, 0));
}
function $js_str_includes(s, needle, pos) { return $js_asS16(s).includes($js_asS16(needle), $js_idx(pos, 0)); }
// 第二个实参是起始位置：词法器的标点匹配靠它，而且在热路径上
function $js_str_starts_with(s, pre, pos) {
  return $js_asS16(s).startsWith($js_asS16(pre), $js_idx(pos, 0));
}
// endsWith 的第二个实参是**终点**（不给就是长度）
function $js_str_ends_with(s, suf, end) {
  const v = $js_asS16(s);
  return v.endsWith($js_asS16(suf), $js_idx(end, v.length));
}
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
// new Array(n)。刻意不留洞：宿主的洞会让 map/forEach 跳格，C 侧的 list 是密的，
// 那样两个后端就分叉了。长度的合法范围照 JS（整数、0..2^32-1），越界是 RangeError。
function $js_arr_new_n(n) {
  if ($dynTag(n) !== "real") return [n];
  if (!Number.isInteger(n) || n < 0 || n > 4294967295) $rt_error("invalid array length");
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = undefined;
  return a;
}
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
// x.push(…) 的派发器：接收者不是 list 就退回"取属性、当函数调"—— 与成员派发器表外
// 那一支同一条路（决策 12）。用户自己的方法也可以叫 push（asy 前端的 AsyLower.push()
// 就是压一层作用域），而这两种形状（零实参、带展开）降级时走的是定长 op，静态分不出接收者。
function $js_arr_push_dyn(a, items) {
  if ($dynTag(a) === "list") return $js_arr_push_all(a, items);
  // 接收者要传下去（ADR-0020 P1）：sc.push() 里的 this 就是 sc
  return $js_call_n_this($js_obj_get(a, "push"), a, $js_arr_of(items));
}
function $js_arr_pop(a) { return $js_arr_of(a).pop(); }
function $js_arr_unshift(a, v) { return $js_arr_of(a).unshift(v); }
// shift：摘掉头一格并交出来（空数组给 undefined）
function $js_arr_shift(a) { return $js_arr_of(a).shift(); }
// a.at(i)：负下标从尾部数，越界 undefined（a[-1] 是取属性，不是这一条）
function $js_arr_at(a, i) {
  const l = $js_arr_of(a);
  let k = $js_idx(i, 0);
  if (k < 0) k += l.length;
  return k < 0 || k >= l.length ? undefined : l[k];
}
function $js_arr_slice(a, s, e) {
  const l = $js_arr_of(a);
  return l.slice($js_idx(s, 0), $js_idx(e, l.length));
}
/* concat 的实参**不是数组**时当一格元素追上去（规范 23.1.3.1 的 IsConcatSpreadable）：
   [1].concat([2], 3) 是 [1,2,3]。从前这儿一律 $js_arr_of，非数组当场报错（量出来的）。 */
function $js_arr_concat(a, b) {
  return $js_arr_of(a).concat($dynTag(b) === "list" ? $js_arr_of(b) : [b]);
}
function $js_arr_reverse(a) { $js_arr_of(a).reverse(); return a; }
function $js_arr_fill(a, v, s, e) {
  const l = $js_arr_of(a);
  l.fill(v, $js_idx(s, 0), $js_idx(e, l.length));
  return a;
}
/* copyWithin：同一格数组里把 [s, e) 挪到 t 起（区间会重叠，宿主的 copyWithin 自己
   处理挪的向；C 那份是先拷一份再写的等价实现）。 */
function $js_arr_copy_within(a, t, s, e) {
  const l = $js_arr_of(a);
  l.copyWithin($js_idx(t, 0), $js_idx(s, 0), $js_idx(e, l.length));
  return a;
}
function $js_arr_is_array(v) {
  if ($dynTag(v) === "list") return true;
  /* Array.prototype 在规范里**自己就是一格数组**（exotic array）。这个值域里它是一格真对象
     （内建方法住在上头），所以单独认一下 —— 不然 Array.isArray(Array.prototype) 静静地给
     false。realm 还没建起来就不必建：那时候手里绝不可能有 arrP。 */
  return $R !== null && v === $R.arrP;
}
// Array.from：走一遍迭代（ADR-0020 P1）——数组是恒等、字符串按码点、Map/Set 给条目，
// 自定义可迭代对象走 Symbol.iterator 协议。再 slice 一份，免得把原数组交出去。
// 第二个实参是 mapFn，收 (value, index)（规范 23.1.2.1）。**类数组**（有 length、
// 没有 Symbol.iterator）也认：按 0..length-1 取下标，那是 Array.from({length:n}, f) 的用法。
function $js_arr_from(v, f) {
  const xs = $js_arr_from_src(v).slice();
  return f === undefined ? xs : xs.map((x, i) => $callFn(f, [x, i]));
}
function $js_arr_from_src(v) {
  if ($dynTag(v) === "object" && !$js_has_iter(v)) {
    const n = Math.trunc($js_real($js_getp(v, "length", undefined) ?? 0, "Array.from"));
    const out = [];
    for (let i = 0; i < n; i++) out.push($js_getp(v, $js_str(i), undefined));
    return out;
  }
  return $js_iter(v);
}
function $js_has_iter(v) {
  return $js_getp(v, $js_sym_wk("iterator"), undefined) !== undefined;
}
/* 第三格是 fromIndex（规范 23.1.3.17 / .21 / .16）：负数从末尾数，越界就夹住。
   从前这一格被丢掉了 —— [1,2,3,2].indexOf(2, 2) 给 1（该是 3），silent 的错答案。 */
function $js_arr_from_idx(len, from, dflt) {
  if (from === undefined) return dflt;
  // 照规范 ToIntegerOrInfinity（"1" / true / null 都收得下），与 $js_idx 同一条口径
  const i = $js_idx(from, dflt);
  return i < 0 ? len + i : i;
}
function $js_arr_index_of(a, v, from) {
  const l = $js_arr_of(a);
  let i = $js_arr_from_idx(l.length, from, 0);
  if (i < 0) i = 0;
  for (; i < l.length; i++) if ($js_eq(true, l[i], v)) return i;
  return -1;
}
function $js_arr_last_index_of(a, v, from) {
  const l = $js_arr_of(a);
  let i = $js_arr_from_idx(l.length, from, l.length - 1);
  if (i >= l.length) i = l.length - 1;
  for (; i >= 0; i--) if ($js_eq(true, l[i], v)) return i;
  return -1;
}
function $js_arr_includes(a, v, from) {
  const l = $js_arr_of(a);
  const nan = typeof v === "number" && Number.isNaN(v);
  let i = $js_arr_from_idx(l.length, from, 0);
  if (i < 0) i = 0;
  for (; i < l.length; i++) {
    const x = l[i];
    if (nan ? (typeof x === "number" && Number.isNaN(x)) : $js_eq(true, x, v)) return true;
  }
  return false;
}
function $js_arr_join(a, sep) {
  // 分隔符照规范 ToString（22.1.3.18 第 4 步）：缺席才是 ","，null 是 "null" 而不是报错
  const s = sep === undefined ? "," : $js_asS16($js_str(sep));
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
/* 迭代方法的第二个实参 thisArg（map / filter / forEach / some / every / find… 都收）：
   把回调裹成一格"this 定住了"的函数，形状与 bind 出来的那一格相同（fp / fp2 / $nm / $ln）。
   不给就原样交回去 —— 免得白包一层。这条只在 JS 那条腿上：C 还没有真函数对象。 */
function $js_bind_this(f, t) {
  if (t === undefined) return f;
  const call = (args) => $callThis(f, t, args);
  return { fp: (self, args) => call(args), fp2: (ig, args) => call(args), $nm: $js_fn_name(f), $ln: $js_fn_len(f) };
}
/* 回调里 throw 了要**立刻停**。这个值域里 throw 是"放一格 pending 再跳"（ADR-0007 决定 1），
   所以每调一次回调之后都得问一句 $js_pending() —— 不问就是**静默**多跑几圈：量出来的
   [1,2,3].forEach(x => { seen.push(x); if (x === 2) throw … }) 在 node 上 seen 是 1,2，
   我们从前是 1,2,3。宿主的 .map / .filter / .forEach / .some / .every 因此全换成手写循环 ——
   它们没有"半路停下来"这一格。抛了之后返回值没人看，随便给个形状对的。
   C 那份（omni_js_arr.h）是同一套判据，两边逐行对着写。 */
function $js_arr_map(a, f) {
  const l = $js_arr_of(a), out = [];
  for (let i = 0; i < l.length; i++) {
    out.push($js_call3(f, l[i], i, a));
    if ($js_pending()) return out;
  }
  return out;
}
function $js_arr_filter(a, f) {
  const l = $js_arr_of(a), out = [];
  for (let i = 0; i < l.length; i++) {
    const keep = $js_truthy($js_call3(f, l[i], i, a));
    if ($js_pending()) return out;
    if (keep) out.push(l[i]);
  }
  return out;
}
function $js_arr_for_each(a, f) {
  const l = $js_arr_of(a);
  for (let i = 0; i < l.length; i++) {
    $js_call3(f, l[i], i, a);
    if ($js_pending()) return;
  }
}
function $js_arr_some(a, f) {
  const l = $js_arr_of(a);
  for (let i = 0; i < l.length; i++) {
    const hit = $js_truthy($js_call3(f, l[i], i, a));
    if ($js_pending()) return false;
    if (hit) return true;
  }
  return false;
}
function $js_arr_every(a, f) {
  const l = $js_arr_of(a);
  for (let i = 0; i < l.length; i++) {
    const ok = $js_truthy($js_call3(f, l[i], i, a));
    if ($js_pending()) return false;
    if (!ok) return false;
  }
  return true;
}
function $js_arr_find(a, f) {
  const l = $js_arr_of(a);
  for (let i = 0; i < l.length; i++) {
    const hit = $js_truthy($js_call3(f, l[i], i, a));
    if ($js_pending()) return undefined;
    if (hit) return l[i];
  }
  return undefined;
}
function $js_arr_find_index(a, f) {
  const l = $js_arr_of(a);
  for (let i = 0; i < l.length; i++) {
    const hit = $js_truthy($js_call3(f, l[i], i, a));
    if ($js_pending()) return -1;
    if (hit) return i;
  }
  return -1;
}
// 从后往前那两格（ES2023）：谓词照旧收 (v, i, arr)，只是走的方向反过来
function $js_arr_find_last(a, f) {
  const l = $js_arr_of(a);
  for (let i = l.length - 1; i >= 0; i--) {
    const hit = $js_truthy($js_call3(f, l[i], i, a));
    if ($js_pending()) return undefined;
    if (hit) return l[i];
  }
  return undefined;
}
function $js_arr_find_last_index(a, f) {
  const l = $js_arr_of(a);
  for (let i = l.length - 1; i >= 0; i--) {
    const hit = $js_truthy($js_call3(f, l[i], i, a));
    if ($js_pending()) return -1;
    if (hit) return i;
  }
  return -1;
}
function $js_arr_reduce(a, f, init) {
  const l = $js_arr_of(a);
  let i = 0, acc;
  if (init === undefined) {
    // 空表 + 没给初值是 TypeError（规范 23.1.3.24 第 3 步 / .25），能 catch
    if (l.length === 0) return $js_type_err("reduce of empty array with no initial value");
    acc = l[0]; i = 1;
  } else {
    acc = init;
  }
  for (; i < l.length; i++) {
    acc = $callFn(f, [acc, l[i], i, a]);
    if ($js_pending()) return undefined;
  }
  return acc;
}
function $js_arr_reduce_right(a, f, init) {
  const l = $js_arr_of(a);
  let i = l.length - 1, acc;
  if (init === undefined) {
    // 空表 + 没给初值是 TypeError（规范 23.1.3.24 第 3 步 / .25），能 catch
    if (l.length === 0) return $js_type_err("reduce of empty array with no initial value");
    acc = l[i]; i--;
  } else {
    acc = init;
  }
  for (; i >= 0; i--) {
    acc = $callFn(f, [acc, l[i], i, a]);
    if ($js_pending()) return undefined;
  }
  return acc;
}
// flat：深度是个计数，一层一层摊（不递归 —— 深数组会把 C 侧的栈捅穿）。
// 某一层里已经没有数组就提前收工，所以 Infinity 也能收。
function $js_arr_flat(a, d) {
  const depth = d === undefined ? 1 : $js_idx(d, 1);
  let out = $js_arr_of(a).slice();
  for (let k = 0; k < depth; k++) {
    let nested = false;
    const next = [];
    for (let i = 0; i < out.length; i++) {
      const x = out[i];
      if ($dynTag(x) === "list") {
        nested = true;
        for (let j = 0; j < x.length; j++) next.push(x[j]);
      } else {
        next.push(x);
      }
    }
    out = next;
    if (!nested) break;
  }
  return out;
}
function $js_arr_flat_map(a, f) {
  const out = [];
  const l = $js_arr_of(a);
  for (let i = 0; i < l.length; i++) {
    const r = $js_call3(f, l[i], i, a);
    if ($js_pending()) return out;
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
  /* 比较器交出来的东西先 ToNumber（规范 23.1.3.30.2 第 3 步）—— 不是"只认数、别的当 0"。
     差别就在 (x, y) => x > y 这种常见的写错上：那给的是布尔，规范里 true 是 1、false 是 0，
     于是它**排得对**；从前那一支当 0，于是一格都不动、静静地交回原来的次序。 */
  const r = $callFn(f, [x, y]);
  const d = $js_num_of(r);
  return Number.isNaN(d) ? 0 : (d < 0 ? -1 : (d > 0 ? 1 : 0));
}
function $js_arr_sort(a, f) { $js_arr_of(a).sort((x, y) => $js_arr_cmp(f, x, y)); return a; }
// toSorted：整段拷贝再就地排，稳定性与比较器语义完全跟着 sort 那一份
function $js_arr_to_sorted(a, f) { return $js_arr_sort($js_arr_of(a).slice(), f); }
// toReversed / with：同一族的另外两格 —— 拷一份再改，原数组不动
function $js_arr_to_reversed(a) { return $js_arr_of(a).slice().reverse(); }
/* splice / toSpliced：第二格是**整串实参**摊成的一格 list（实参个数是语义的一部分 ——
   splice(1) 删到底，splice(1, undefined) 一格都不删）。这条腿上直接把那串实参
   apply 给宿主的 splice，夹取与"删到底"那些边界就是宿主的；C 那份是手划的同一套。 */
function $js_arr_splice(a, args) {
  const l = $js_arr_of(a);
  return l.splice.apply(l, $js_arr_of(args));
}
function $js_arr_to_spliced(a, args) {
  const l = $js_arr_of(a).slice();
  l.splice.apply(l, $js_arr_of(args));
  return l;
}
function $js_arr_with(a, i, v) {
  const l = $js_arr_of(a).slice();
  let k = $js_idx(i, 0);
  if (k < 0) k += l.length;
  // 规范里这儿是 RangeError；这个值域里没有"宿主抛的错"，所以当场报错（两条腿逐字相同）
  if (k < 0 || k >= l.length) $rt_error("index out of range in with()");
  l[k] = v;
  return l;
}
function $js_arr_entries(a) { return $js_arr_of(a).map((v, i) => [i, v]); }
// keys / values（数组那一支）：迭代器在这个值域里就是一格 list，与 entries 同一个口径
function $js_arr_keys(a) { return $js_arr_of(a).map((v, i) => i); }
function $js_arr_values(a) { return $js_arr_of(a).slice(); }
// split 的字符串分隔符形式（正则形式是 $js_re_split）。空分隔符按码元切，不按码点。
// 第三个实参是 limit：结果长度的上界（规范 22.1.3.23）—— 从前这一格被丢掉了，
// "a-b-c".split("-", 2) 于是给出三段（silent 的错答案，量出来的）。
// 分隔符不给（undefined）时整串是一格：'abc'.split() 是 ["abc"]（规范 22.1.3.23 第 3 步）。
function $js_str_split(s, sep, limit) {
  const v = $js_asS16(s);
  if (sep === undefined) return [v];
  // 运行期的正则（new RegExp(...) 存进变量再用）：转给正则那一支，与 $js_str_replace 同办法
  if ($dynTag(sep) === "regexp") return $js_re_split($js_re_source(sep), $js_re_flags(sep), s, limit);
  const p = $js_asS16(sep);
  const parts = p.length === 0 ? [...v.split("")] : v.split(p);
  if (limit === undefined) return parts;
  // limit 照规范先 ToNumber 再截尾（22.1.3.23 那儿是 ToUint32）：串 / 布尔都收得下
  const n = $js_idx(limit, 0);
  return n < 0 ? parts : parts.slice(0, n);
}
// substr（Annex B，但到处都还在用）：起点认负数（从末尾数），第二格是**长度**不是终点
function $js_str_substr(s, a, n) {
  const v = $js_asS16(s);
  let st = $js_idx(a, 0);
  if (st < 0) st = Math.max(v.length + st, 0);
  const len = n === undefined ? v.length - st : $js_idx(n, 0);
  return len <= 0 ? "" : v.slice(st, st + len);
}
// substring：两头都夹到 [0, len]，start > end 就换过来（规范 22.1.3.24）——
// 与 slice 的差别是它**不认负下标**（负的一律当 0）
function $js_str_substring(s, a, b) {
  const v = $js_asS16(s);
  return v.substring($js_idx(a, 0), b === undefined ? v.length : $js_idx(b, v.length));
}
// Buffer.from(s, "utf8") 的替身：只要"UTF-8 字节的数组"这一个形状。
// 落单的代理项两侧都替成 U+FFFD（TextEncoder 与 omni_s16_to_utf8 一致）。
function $js_utf8_bytes(s) { return [...new TextEncoder().encode($js_asS16(s))]; }
function $js_num_parse_int(s, radix) {
  return parseInt($js_asS16(s), radix === undefined ? undefined : Math.trunc(radix));
}
// parseFloat：吃最长的合法前缀。C 那份手划前缀再 strtod（strtod 认 0x / inf / nan，
// JS 的 parseFloat 只认十进制字面量加 Infinity），两边因此在 "0x10" 上同样给 0。
function $js_num_parse_float(s) { return parseFloat($js_asS16(s)); }
// for-of 的取值面：数组原样返回（所以下标迭代是活的），字符串按**码点**切，
// Map 给 [k, v] 对，Set 给元素。普通对象不可迭代 —— JS 也是这样。
// for-in 的那一串键（ADR-0020 P3）：自有 + 继承来的**可枚举字符串键**，按"先自己、
// 再原型"的次序去重。数组给下标（字符串形态）加挂在它身上的那些属性；dict 给它的全部键
// （Omni 的 dict 没有描述符那一层）；原始值与 null/undefined 一个都不给（JS 就是这样）。
function $js_for_in_keys(o) {
  const out = [], seen = new Set();
  const t = $dynTag(o);
  if (t === "list") {
    for (let i = 0; i < o.length; i++) out.push($js_str(i));
    const x = $js_xprops(o, false);
    if (x !== undefined) for (const k of x.keys()) out.push(k);
    return out;
  }
  if (t === "dict") return [...o.keys()];
  if (t === "string") {
    for (let i = 0; i < o.length; i++) out.push($js_str(i));
    return out;
  }
  let cur = o;
  while ($js_isobj(cur)) {
    for (const k of $js_own_keys(cur, "e")) {
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
    cur = cur.pr;
  }
  return out;
}
function $js_iter(v) {
  switch ($dynTag(v)) {
    case "list": return v;
    case "Map": return $js_map_entries(v);
    case "Set": return $js_set_items(v);
    case "string": return [...v];
    // Uint8Array 也可迭代（[...u8] / for-of / Array.from）：一格一个字节的数
    case "bytes": return [...$js_bytes(v, "iteration").u8];
    // ADR-0020 P1：真对象按**协议**迭代（Symbol.iterator + next），不按标签硬派发。
    // 收成一个数组回去：for-of 的降级现在吃的是数组，把"惰性"这一格留给 P2
    // （生成器那一刀之后，for-of 才有真正的惰性形态）。
    case "object": {
      const it = $js_iter_proto(v), out = [];
      // 取把手就报了（没有 Symbol.iterator）：接住就收场，别再拿 undefined 去问 next
      if ($js_pending()) return out;
      for (;;) {
        const r = $js_iter_next(it);
        // 协议里报的错（不可迭代 / next 交出来的不是对象）是**能 catch** 的，接住就收场
        if ($js_pending()) return out;
        if ($js_truthy($js_getp(r, "done", undefined))) return out;
        out.push($js_getp(r, "value", undefined));
      }
    }
    /* 不可迭代（规范 7.4.2 的 GetIterator）是 **TypeError**，能 catch —— 展开一个 null、
       for-of 一个数，两把尺子上都是 catch 得住的。从前是硬错，整个进程就停在那儿。
       报过之后交一格空表回去：调用点（js_iter_open 那一族都带 throws）紧跟着的 pending
       检查会接着退，中间这一格不会被真的用到。消息不带标签名 —— 要与 C 那条腿一字一样，
       而两边的标签名对不齐（普通对象在 C 那侧是 dict、这侧是 object）。 */
    default: { $js_type_err("value is not iterable"); return []; }
  }
}
/* for-of 的惰性形态（ADR-0020）：一格迭代把手 —— 真迭代器（生成器、带 Symbol.iterator 的
   对象）才需要它，内建容器照旧摊成 list（它们本来就是抽干的语义，而且是热路径）。
   v 是"当前那一格"，d 是"已经完了"。 */
class $JsIterH {
  constructor(it) {
    this.it = it;
    this.v = undefined;
    this.d = false;
  }
}
function $js_iter_open(v) {
  return $dynTag(v) === "object" ? new $JsIterH($js_iter_proto(v)) : $js_iter(v);
}
// 每轮**恰好一次** next（cond 在体之前跑，continue 也走 step 再 cond）
function $js_iter_done(h, i) {
  if (!(h instanceof $JsIterH)) return $js_idx(i, 0) >= h.length;
  if (h.d) return true;
  const r = $js_iter_next(h.it);
  // 协议里报的错（next 交出来的不是对象）能 catch：接住就当 done，调用点的检查接着退
  if ($js_pending()) { h.d = true; return true; }
  if ($js_truthy($js_getp(r, "done", undefined))) { h.d = true; h.v = undefined; return true; }
  h.v = $js_getp(r, "value", undefined);
  return false;
}
function $js_iter_cur(h, i) {
  return h instanceof $JsIterH ? h.v : $js_idx_get(h, i);
}
/* 循环出口补一次 return()：正常跑完时迭代器已经 done，这一格就是空操作；break 出来才真调
   （带 finally 的生成器于是跑得到清理）。从 for-of 里 return / 带标签跳到外层去还是漏掉 ——
   那要给循环出口挂一格清理协议，记在 ADR-0020 里。 */
function $js_iter_close(h) {
  if (!(h instanceof $JsIterH) || h.d) return;
  h.d = true;
  const rf = $js_getp(h.it, "return", undefined);
  if ($dynTag(rf) === "function") $callThis(rf, h.it, []);
}
/* 数组解构的 rest：从第 i 格起收成一个 list。list 那一支是 slice，真迭代器那一支抽到 done */
function $js_iter_rest(h, i) {
  if (!(h instanceof $JsIterH)) return $js_arr_of(h).slice($js_idx(i, 0));
  const out = [];
  for (;;) {
    if (h.d) return out;
    const r = $js_iter_next(h.it);
    if ($js_pending()) { h.d = true; return out; }
    if ($js_truthy($js_getp(r, "done", undefined))) { h.d = true; return out; }
    out.push($js_getp(r, "value", undefined));
  }
}
// o[k]：数组按下标、字符串按码元（只读）、普通对象按属性名。
// Map/Set 上的 o[k] 在 JS 里是属性访问而不是条目，量过的源码里没有，所以报错。
function $js_idx_get(o, k) {
  switch ($dynTag(o)) {
    // 下标是数就是元素，否则是**挂在数组身上的属性**（JS 里数组也是对象）。
    // a.foo 与 a["foo"] 于是走到同一个地方（降级器把成员赋值发成 idx_set）。
    case "list": return $js_num_key(k) ? $js_arr_get(o, k) : $js_obj_get(o, k);
    // 串上的 s[k]：下标是数才按码元，否则是**串身上的属性**（s[Symbol.iterator] /
    // s["length"]）—— 落到那一族的原型上去找，别当成下标错。
    case "string": return $js_num_key(k) ? $js_str_index(o, k) : $js_prim_get(o, k);
    case "dict": return $js_obj_get(o, k);
    // 真对象（ADR-0020 P1）：o[k] 与 o.k 是同一条路 —— 沿原型链、触发访问器。
    case "object": return $js_getp(o, k, undefined);
    // Uint8Array 的 t[i]（ADR-0020 P4）。这个值域里 ArrayBuffer/Uint8Array/DataView 是
    // 同一种值，所以 DataView 上也能下标读 —— JS 里那是普通属性（undefined）。越界照
    // .getUint8 那条路报错，不像 JS 给 undefined：两条腿一致比像 JS 更重要。
    case "bytes": return $js_buf_get_u8(o, k);
    /* 函数值上的 f[k]（t[k] 在代理陷阱里最常见）：落到 Function.prototype 那张面上 ——
       name / length / call / apply / bind 都在那儿，别的键给 undefined（JS 里也是）。
       理由与上面 "string" 那一支同一条：这不是"把它当容器下标取"，是取属性。 */
    case "function": return $js_prim_get(o, k);
    // Map/Set 上的 o[k] 照旧当场报（那在 JS 里是属性访问而不是条目，容易看错），
    // 只放**符号键**过去 —— m[Symbol.iterator] 是协议本身，不是"把条目当下标取"。
    default:
      if ($dynTag(k) === "symbol") return $js_prim_get(o, k);
      $rt_error("cannot index a " + $dynTag(o));
  }
}
function $js_num_key(k) {
  const t = $dynTag(k);
  if (t !== "int" && t !== "real") return false;
  /* 只有**规范的数组下标**（非负整数）才是"那一格元素"（规范 10.4.2.1 的
     CanonicalNumericIndexString）；负数与带小数的一律是**挂在数组身上的属性** ——
     a[-1] = 7 在 JS 里不动 length、JSON 也看不见它。从前这儿把它们都当下标，
     a[-1] = 7 撞在 "negative array index" 上。 */
  const n = Number(k);
  return Number.isInteger(n) && n >= 0;
}
// idx_set 的结果是**被赋的值**（JS 里赋值表达式的值就是右边），不是容器本身 ——
// 和 obj_set 那个"返回对象好串成字面量"的约定不一样，别混。
function $js_idx_set(o, k, v) {
  switch ($dynTag(o)) {
    case "list": {
      if ($js_num_key(k)) $js_arr_set(o, k, v);
      else $js_obj_set(o, k, v);
      return v;
    }
    case "dict": $js_obj_set(o, k, v); return v;
    case "object": $js_setp(o, k, v); return v;
    // t[i] = x：写进那一格字节（低 8 位），值仍是右边那个数（JS 的赋值表达式语义）
    case "bytes": $js_buf_set_u8(o, k, v); return v;
    // 正则上只有 lastIndex 可写（ADR-0020 P4）：别的名字照旧当场报，"成员表缺一格"
    // 这件事要留在明处
    case "regexp": {
      if ($js_str(k) !== "lastIndex") $rt_error("cannot assign to '" + $js_str(k) + "' of a regexp");
      o.li = $js_idx(v, 0);
      return v;
    }
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
// 引用值当 Map/Set 键：按**同一性**认（JS 就是这么规定的，两个内容相同的对象是两个键）。
// 这个值域里键必须规范化成一个字符串，所以给每个对象发一个号。号只在内部当键用 ——
// 不进迭代（键与值都是原样存的）、不被打印，所以两侧各自发号就行：JS 这边是个计数器，
// C 那边直接拿地址（那个运行时不搬对象、也不回收，地址在一趟里就是同一性）。
const $IDS = new WeakMap();
let $idNext = 1;
function $js_ident(o) {
  let n = $IDS.get(o);
  if (n === undefined) { n = $idNext; $idNext = $idNext + 1; $IDS.set(o, n); }
  return "o" + n;
}
function $js_key(k) {
  switch ($dynTag(k)) {
    case "string": return "s" + k;
    case "int": return "i" + k.toString();
    case "real": return "n" + $js_str(k);
    case "bool": return "b" + (k ? 1 : 0);
    case "null": return "z";
    case "undefined": return "u";
    default: return $js_ident(k);
  }
}
function $js_prop(k) { return $js_asS16(k); }
// 对象字面量与 new Object 那一格：**现在造的是真对象**（ADR-0020 P1）。
// dict（宿主 Map）那一格留着 —— Omni 自己的 dict<string,dynamic> 还是它，而 Map/Set
// 也躺在同一个标签上；这一族 op 因此两种都收，见下面每个函数头一句。
function $js_obj_new() { return new $JSObj($realm().objP); }
// JS 里数组也是对象，身上可以挂字段（asy 前端的 do-while 就往那一格更新列表上挂一个 dw）。
// 这个值域里 list 只是一个数组、没有属性槽，所以额外属性放在**一张按同一性索引的旁表**里：
// 键就是 $js_key 给引用值发的那个号。list 本身于是不为此多一个字段，没挂过属性的
// list 一分钱不付。刻意只对 list 开这条路 —— 字符串、Map 上取不到的成员照旧当场报，
// 那句话是"成员表缺一格"的固定签名，不能让它变成静悄悄的 undefined。
const $XPROPS = new Map();
function $js_xprops(o, make) {
  const k = $js_ident(o);
  let d = $XPROPS.get(k);
  if (d === undefined && make) { d = new Map(); $XPROPS.set(k, d); }
  return d;
}
function $js_obj_get(o, k) {
  if ($js_isobj(o)) return $js_getp(o, k, undefined);
  if ($dynTag(o) === "list") {
    // 键用 $js_pkey 而不是 $js_prop：符号键（a[Symbol.iterator]）也要能问，
    // 旁表里找不到就落到 Array.prototype 上（那儿现在挂着 Symbol.iterator 那一格）
    const x = $js_xprops(o, false), key = $js_pkey(k);
    if (x !== undefined && x.has(key)) return x.get(key);
    // 数组身上没挂过这个名字：去 Array.prototype 上找（length/下标由 prim_get 管）
    return $js_prim_get(o, k);
  }
  if ($dynTag(o) !== "dict") {
    // 原始值与函数值上的取属性：内建方法住在它那一族的原型上（ADR-0020 P1）。
    // 从前这儿是一句"X is not an object" —— f.call / f.bind 这些于是根本没有落点。
    return $js_prim_get(o, k);
  }
  const d = o, key = $js_prop(k);
  return d.has(key) ? d.get(key) : undefined;
}
// set 返回对象本身，这样对象字面量可以降级成一串链式调用，不需要临时变量
function $js_obj_set(o, k, v) {
  if ($js_isobj(o)) { $js_setp(o, k, v); return o; }
  if ($dynTag(o) === "list") {
    const key = $js_hkey(k);
    /* a.length = n 是**改长度**，不是往旁表里挂一个叫 length 的字段（从前是后者，
       于是 a.length = 0 静静地什么也没做）。短了截掉，长了补 undefined —— 规范 10.4.2.4。 */
    if (key === "length") { $js_arr_set_len(o, v); return o; }
    /* 下标形状的**字符串**键就是下标：往 "1" 上写与往 1 上写是同一格（规范里数组的
       [[Set]] 先把键 ToString，再看它是不是数组下标）。从前这一支落进旁表，于是那次写
       静静地丢了（读那一边一直是对的 —— 所以更藏得住）。 */
    if ($js_isidx(key)) { $js_arr_set(o, Number(key), v); return o; }
    $js_xprops(o, true).set(key, v);
    return o;
  }
  $js_dict_of(o).set($js_prop(k), v);
  return o;
}
function $js_arr_set_len(o, v) {
  const l = $js_arr_of(o), n = Math.trunc($js_real(v, "length"));
  if (!Number.isFinite(n) || n < 0) $rt_error("invalid array length");
  if (n < l.length) { l.length = n; return; }
  while (l.length < n) l.push(undefined);
}
function $js_obj_has(o, k) {
  if ($js_isobj(o)) return $js_obj_has_p(o, k);
  if ($dynTag(o) === "list") return $js_arr_has_key(o, $js_hkey(k));
  return $js_dict_of(o).has($js_hkey(k));
}
/* in / hasOwn 的键：规范先 ToPropertyKey，**数要按串形算**（0 in a 里左边就是个数）。
   取属性那条路上的 $js_prop 照旧只收串 —— 那句报错是"降级发错了"的固定签名。 */
function $js_hkey(k) { return $dynTag(k) === "real" ? $js_str(k) : $js_prop(k); }
/* 数组身上的"有没有这个键"（0 in a / Object.hasOwn(a, 0)）：**元素那几格算键** ——
   下标在 0..len-1 里就有（从前这儿只问了旁表，于是 0 in [1,2] 静静地给 false）。
   length 也是一格自有属性。别的名字才去旁表（js 里数组也是对象，见 xprops）。 */
function $js_arr_has_key(o, key) {
  if ($js_isidx(key)) return Number(key) < $js_arr_of(o).length;
  if (key === "length") return true;
  const x = $js_xprops(o, false);
  return x === undefined ? false : x.has(key);
}
function $js_obj_delete(o, k) {
  if ($js_isobj(o)) return $js_obj_del_p(o, k);
  if ($dynTag(o) === "list") {
    /* delete a[i]（i 在长度里）在 JS 里造一格**洞**：长度不变、i in a 为假、JSON 里
       那一格是 null、forEach / map / Object.keys 全都跳过它。这个值域里的 list 是一排
       稠密的 dyn，表达不出洞 —— 写 undefined 进去只对得上一半（i in a 变成真、
       forEach 不跳），那是**悄悄的错答案**。所以这一格当场报，不假装删掉了。
       想"去掉一格"照旧写 a.splice(i, 1)。 */
    const ix = $js_hkey(k);
    if ($js_isidx(ix) && Number(ix) < $js_arr_of(o).length) {
      $rt_error("delete of an array index would leave a hole; use splice(" + ix + ", 1)");
    }
    const x = $js_xprops(o, false);
    return x === undefined ? true : x.delete(ix);
  }
  return $js_dict_of(o).delete($js_hkey(k));
}
// Object.keys/values/entries：真对象上只算**自有、可枚举、字符串键**的（规范如此），
// dict 那一格照旧是全部键（那是 Omni 的 dict，没有描述符这一层）。
/* Object.keys / values / entries 也认**串**（规范里它先 ToObject，串于是成了类数组）：
   键是下标的十进制串、值是一个个码元。量过：qjs 的 Object.keys("ab") 是 ["0","1"]。 */
function $js_str_idx_keys(s) {
  const v = $js_asS16(s), out = [];
  for (let i = 0; i < v.length; i++) out.push($js_str(i));
  return out;
}
/* Object.keys / values / entries 的 list 那一支：下标先按数值升序，再是**旁表**里那些
   字符串键（JS 里数组也是对象，见 $js_xprops）。从前这一支落到 $js_dict_of 上、当场报
   "list is not an object"（量出来的：Object.entries([7]) 该给 [["0",7]]）。 */
function $js_arr_own_keys(a) {
  const out = [];
  for (let i = 0; i < a.length; i++) out.push($js_str(i));
  const x = $js_xprops(a, false);
  if (x !== undefined) {
    for (const k of x.keys()) if (typeof k === "string" && !$js_isidx(k)) out.push(k);
  }
  return out;
}
function $js_obj_keys(o) {
  if ($js_isobj(o)) return $js_own_keys(o, "e");
  if ($dynTag(o) === "string") return $js_str_idx_keys(o);
  if ($dynTag(o) === "list") return $js_arr_own_keys(o);
  return [...$js_dict_of(o).keys()];
}
function $js_obj_values(o) {
  if ($js_isobj(o)) return $js_own_keys(o, "e").map((k) => $js_getp(o, k, undefined));
  if ($dynTag(o) === "string") return [...$js_asS16(o)].map((c) => c);
  if ($dynTag(o) === "list") return $js_arr_own_keys(o).map((k) => $js_idx_get(o, k));
  return [...$js_dict_of(o).values()];
}
function $js_obj_entries(o) {
  if ($js_isobj(o)) return $js_own_keys(o, "e").map((k) => [k, $js_getp(o, k, undefined)]);
  if ($dynTag(o) === "string") return $js_str_idx_keys(o).map((k, i) => [k, $js_asS16(o)[i]]);
  if ($dynTag(o) === "list") return $js_arr_own_keys(o).map((k) => [k, $js_idx_get(o, k)]);
  return [...$js_dict_of(o)].map(([k, v]) => [k, v]);
}
/* Object.getOwnPropertyDescriptors（复数）：每一格自有属性一份描述符，装进一格新对象。
   单数那一格是 js_obj_desc，这儿只是把它按 own_keys 走一遍。 */
function $js_obj_descs(o) {
  const out = $js_obj_new();
  if (!$js_isobj(o)) return out;
  for (const k of $js_own_keys(o, "a")) $js_setp(out, k, $js_obj_desc(o, k), undefined);
  return out;
}
// { ...src, k: v } 的 src 那一步。undefined / null 当空对象（JS 就是这么规定的）。
function $js_obj_assign(dst, src) {
  if (src === undefined || src === null) return dst;
  /* 源是数组或字符串：抄的是它的**自有可枚举键**（下标那几格，数组还有旁表里那些名字）——
     { ...[1,2] } 是 {"0":1,"1":2}、{ ..."ab" } 是 {"0":"a","1":"b"}。从前这一支落到
     $js_dict_of 上、当场报 "list is not an object"（量出来的）。 */
  const ts = $dynTag(src);
  if (ts === "list" || ts === "string") {
    for (const kv of $js_obj_entries(src)) $js_obj_set(dst, kv[0], kv[1]);
    return dst;
  }
  /* 别的原始值当源：**什么都不抄**（规范 20.1.2.1 第 4 步 a-ii 是 ToObject 之后走自有可枚举
     键，数 / 布尔 / bigint / symbol 包起来一格键都没有）。从前落到 $js_dict_of 上、当场报
     "real is not an object" —— Object.assign({}, x) 里 x 是数是很常见的一格写法。 */
  if (ts === "real" || ts === "int" || ts === "bool" || ts === "symbol") return dst;
  if ($js_isobj(dst) || $js_isobj(src)) {
    const ks = $js_isobj(src) ? $js_own_keys(src, "e") : [...$js_dict_of(src).keys()];
    for (const k of ks) $js_obj_set(dst, k, $js_obj_get(src, k));
    // Symbol 键也抄（Object.assign 抄自有可枚举的**所有**键，含 Symbol）
    if ($js_isobj(src)) for (const s of $js_own_keys(src, "y")) $js_obj_set(dst, s, $js_obj_get(src, s));
    return dst;
  }
  const d = $js_dict_of(dst);
  for (const [k, v] of $js_dict_of(src)) d.set(k, v);
  return dst;
}

// ---------------------------------------------------------------- 真对象（ADR-0020 P1）
// ADR-0011 那一档的"对象"是 dict<string,dynamic>：没有原型、没有描述符、没有 Symbol 键，
// 于是 getter/setter、Object.defineProperty、instanceof 的原型链、迭代器协议全都做不出来。
// 这一节是新的那一格 —— $JSObj。它与 runtime/omni_js_object.c 必须同样地绕圈：
// 键序、描述符的默认值、访问器的接收者是谁，都是 test262 会逐条盯的地方。
//
// 迁移期两格并存：老的 Map 照旧走 $js_obj_*（一个字节都不动，编译器自己的源码跑在那上面），
// 新的走 $js_getp / $js_setp。lower.js 把对象字面量与类翻到这一格之后，Map 那格就只剩
// Map/Set 自己用了。
class $JSSym {
  constructor(d) { this.d = d; }
}
// 属性槽。数据属性用 v/w，访问器用 g/s，a 是"我是访问器"那一位 ——
// 不靠 "g === undefined" 判断：{ set f(x){} } 是合法的只写访问器，它的 get 就是 undefined。
class $Slot {
  constructor(a, v, g, s, w, e, c) {
    this.a = a; this.v = v; this.g = g; this.s = s;
    this.w = w; this.e = e; this.c = c;
  }
}
class $JSObj {
  constructor(proto, cls) {
    this.pr = proto === undefined ? null : proto;
    this.ps = new Map();
    this.ex = true;
    this.cl = cls === undefined ? "Object" : cls;
    // Proxy（ADR-0020 P4）：不是 undefined 就说明这一格是代理，px = { t: 目标, h: 处理器 }。
    // 代理与普通对象是**同一种值**（$dynTag 都给 "object"），差别只在五个入口上多问一句。
    this.px = undefined;
  }
}
function $js_isobj(v) { return v instanceof $JSObj; }
/* 规范意义上的"Type(v) is Object"：不是那七格原始值就算。用处只有构造器的 return ——
   返回数组、返回函数也算对象，所以判据不能只认 $JSObj。 */
const $JS_PRIMS = new Set(["null", "undefined", "bool", "int", "real", "string", "symbol"]);
function $js_is_object(v) { return !$JS_PRIMS.has($dynTag(v)); }
// 属性键规范成两种：字符串（UTF-16 码元）或 $JSSym（按同一性）。数字键走 ToString ——
// o[1] 与 o["1"] 是同一格属性，这一条不做对齐后面数组索引全错。
function $js_pkey(k) {
  if (k instanceof $JSSym) return k;
  if (typeof k === "string") return k;
  return $js_asS16($js_str(k));
}
// 是不是数组下标形式的键（0 .. 2^32-2 的规范十进制）。own keys 的次序要它。
function $js_isidx(k) {
  if (typeof k !== "string" || k === "") return false;
  if (k === "0") return true;
  if (k.charCodeAt(0) < 49 || k.charCodeAt(0) > 57) return false;
  for (let i = 1; i < k.length; i++) {
    const c = k.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return k.length < 11 && Number(k) < 4294967295;
}
function $js_def_data(o, k, v, w, e, c) {
  o.ps.set($js_pkey(k), new $Slot(false, v, undefined, undefined, w, e, c));
  return o;
}
function $js_def_acc(o, k, g, s, e, c) {
  o.ps.set($js_pkey(k), new $Slot(true, undefined, g, s, false, e, c));
  return o;
}
// 自有属性的次序（规范 OrdinaryOwnPropertyKeys）：下标键按数值升序，然后是别的字符串键
// 按插入序，最后是 Symbol 键按插入序。kind: 's' 只要字符串 / 'y' 只要 Symbol /
// 'a' 全要 / 'e' 只要可枚举的字符串键（Object.keys 那一档）。
function $js_own_keys(o, kind) {
  const idx = [], str = [], sym = [];
  if (o.px !== undefined) {
    const f = $js_px_trap(o, "ownKeys");
    if (f === undefined) return $js_own_keys(o.px.t, kind);
    // 陷阱交回来的是一串键；按 kind 过一遍（'y' 只要 Symbol，'s' 只要字符串）。
    // 'e'（Object.keys 那一档）还要照规范再问一遍**目标**的描述符：陷阱报了、但目标上
    // 没有或不可枚举的键不算。别的不变量校验不做。
    const ks = $js_arr_of($callThis(f, o.px.h, [o.px.t]));
    const out = [];
    for (let i = 0; i < ks.length; i++) {
      const isSym = ks[i] instanceof $JSSym;
      if (kind === "y" && !isSym) continue;
      if ((kind === "s" || kind === "e") && isSym) continue;
      if (kind === "e") {
        /* Object.keys 那一档：陷阱报了的键还要问一遍描述符（**走 gOPD 陷阱**，不是直接
           翻目标）—— 陷阱说"有、可枚举"就算，与规范一致。 */
        const d = $js_obj_desc(o, ks[i]);
        if (d === undefined || !$js_truthy($js_getp(d, "enumerable", undefined))) continue;
      }
      out.push(ks[i]);
    }
    return out;
  }
  for (const [k, sl] of o.ps) {
    if (k instanceof $JSSym) { sym.push(k); continue; }
    if (kind === "e" && !sl.e) continue;
    if ($js_isidx(k)) idx.push(k); else str.push(k);
  }
  idx.sort((a, b) => Number(a) - Number(b));
  if (kind === "y") return sym;
  const out = [...idx, ...str];
  if (kind === "s" || kind === "e") return out;
  return [...out, ...sym];
}
// 沿原型链找槽。返回 [宿主对象, 槽] 或 null —— 调用方要知道"在谁身上找到的"（访问器
// 的接收者是最初那个对象，不是原型）。
function $js_find_slot(o, key) {
  let cur = o;
  while (cur !== null && cur !== undefined) {
    if (!$js_isobj(cur)) return null;
    const sl = cur.ps.get(key);
    if (sl !== undefined) return [cur, sl];
    cur = cur.pr;
  }
  return null;
}
// [[Get]]。recv 是接收者（访问器的 this）；不给就是 o 自己。
// Proxy 的陷阱（ADR-0020 P4）：处理器上有这一格就调它，没有就落到目标身上。
// 做了五个：get / set / has / deleteProperty / ownKeys —— 它们正好是属性访问的五个入口。
// 不做的写在明处：apply / construct（代理还不能当函数调）、getPrototypeOf、
// defineProperty、getOwnPropertyDescriptor、以及规范里那一整套"不变量校验"。
function $js_px_trap(o, name) {
  if (o.px === undefined) return undefined;
  const f = $js_getp(o.px.h, name, undefined);
  return f === undefined || f === null ? undefined : f;
}
/* 可调用的代理（ADR-0020 P4）：目标是函数（或类对象）时，代理自己也得是**可调用的** ——
   typeof 给 "function"、p(1,2) 走 apply 陷阱、new p() 走 construct 陷阱。所以这一支
   不造 $JSObj（那一格 dynTag 给 "object"），造一格**闭包记录**并把 px 挂在它身上：
   dynTag 的兜底认的正是 { fp, … }，于是 typeof 就对上了。
   px 那一格两种形状共用，$js_px_trap 只问 o.px.h，不在乎宿主是对象还是闭包记录。
   画出来的边界：可调用代理身上的 get 陷阱只在**取属性**那条路上生效（见 $js_prim_get），
   own_keys / defineProperty 那几格还是落到函数那张面上 —— 函数在这个值域里不是真对象。 */
function $js_proxy_new(t, h) {
  if (!$js_isobj(h)) $rt_error("new Proxy takes an object target and handler");
  if ($dynTag(t) === "function") {
    const p = {
      px: { t, h },
      fp: (self, args) => $js_px_call(self, undefined, args),
      fp2: (thisv, args) => $js_px_call(p, thisv, args),
      $nm: $js_fn_name(t),
      $ln: $js_fn_len(t),
    };
    return p;
  }
  if (!$js_isobj(t)) $rt_error("new Proxy takes an object target and handler");
  const o = new $JSObj(null, "Object");
  o.px = { t, h };
  return o;
}
// 调一格可调用代理：有 apply 陷阱就 trap(target, thisArg, argsList)，没有就落到目标上。
// 实参表本身就是一格 list（这个值域里 list 就是一条 JS 数组），原样交给陷阱。
function $js_px_call(p, thisv, args) {
  const f = $js_px_trap(p, "apply");
  if (f === undefined) return $callThis(p.px.t, thisv, args);
  return $callThis(f, p.px.h, [p.px.t, thisv, args]);
}
function $js_getp(o, k, recv) {
  const self = recv === undefined ? o : recv;
  if (!$js_isobj(o)) return $js_prim_get(o, k);
  if (o.px !== undefined) {
    const f = $js_px_trap(o, "get");
    return f === undefined ? $js_getp(o.px.t, k, self)
      : $callThis(f, o.px.h, [o.px.t, $js_pkey(k), self]);
  }
  const hit = $js_find_slot(o, $js_pkey(k));
  if (hit === null) return undefined;
  const sl = hit[1];
  if (!sl.a) return sl.v;
  if (sl.g === undefined) return undefined;
  return $callThis(sl.g, self, []);
}
// [[Set]]。原型链上的 setter 优先；只有数据属性可写、且接收者可扩展时才落自有槽。
/* Reflect.set 与赋值的差别只在**答案**上：赋值的值是 v（JS 的赋值表达式如此），而
   Reflect.set 交出一个布尔 —— 写不进去（不可写、没有 setter、接收者不可扩展）时是 false。
   所以它先照 OrdinarySet 的判据看一眼，再把活交给 $js_setp。 */
function $js_reflect_set(o, k, v, recv) {
  if (!$js_isobj(o)) $rt_error("cannot set a property of " + $dynTag(o));
  const self = recv === undefined ? o : recv;
  const hit = o.px !== undefined ? null : $js_find_slot(o, $js_pkey(k));
  if (hit !== null) {
    const sl = hit[1];
    if (sl.a) {
      if (sl.s === undefined) return false;
      $js_setp(o, k, v, self);
      return true;
    }
    if (!sl.w) return false;
  }
  if (o.px === undefined && (!$js_isobj(self) || (!self.ps.has($js_pkey(k)) && !self.ex))) return false;
  $js_setp(o, k, v, self);
  return true;
}
/* 写属性。**第四格是接收者**（规范的 OrdinarySet 那个 Receiver）：super.x = v 与
   Reflect.set(t, k, v, recv) 靠它 —— 访问器的 this 是接收者，而数据格要写在**接收者**
   身上（不是找到那一格的对象上）。缺席就是 o 自己。 */
function $js_setp(o, k, v, recv) {
  if (!$js_isobj(o)) $rt_error("cannot set a property of " + $dynTag(o));
  const self = recv === undefined ? o : recv;
  if (o.px !== undefined) {
    const f = $js_px_trap(o, "set");
    if (f === undefined) return $js_setp(o.px.t, k, v, self);
    $callThis(f, o.px.h, [o.px.t, $js_pkey(k), v, self]);
    return v;
  }
  const key = $js_pkey(k);
  const hit = $js_find_slot(o, key);
  if (hit !== null) {
    const sl = hit[1];
    if (sl.a) {
      if (sl.s === undefined) return v;
      $callThis(sl.s, self, [v]);
      return v;
    }
    if (hit[0] === o && self === o) {
      if (!sl.w) return v;
      sl.v = v;
      return v;
    }
    if (!sl.w) return v;
  }
  if (!$js_isobj(self)) $rt_error("cannot set a property of " + $dynTag(self));
  /* 接收者是代理就落到它的目标上（没有 defineProperty 陷阱时规范就是这么转的）——
     不这么做的话 p.w = 8 会把那一格写在代理对象自己身上，读回来又走陷阱到目标，
     于是变成 undefined（量出来的：proxy-traps 的空处理器那一段）。 */
  let tgt = self;
  while ($js_isobj(tgt) && tgt.px !== undefined) tgt = tgt.px.t;
  if (!$js_isobj(tgt)) $rt_error("cannot set a property of " + $dynTag(tgt));
  // 接收者身上已经有这一格自有数据属性就原地写，否则新建一格
  const own = tgt.ps.get(key);
  if (own !== undefined && !own.a) {
    if (!own.w) return v;
    own.v = v;
    return v;
  }
  if (!tgt.ex) return v;
  $js_def_data(tgt, key, v, true, true, true);
  return v;
}
// 原始值上的取属性：查它那一族的原型（内建方法就住在那儿），外加 string 的 length 与下标。
function $js_prim_get(o, k) {
  const key = $js_pkey(k);
  if (o === undefined || o === null) $rt_error("cannot read '" + $js_key_str(key) + "' of " + $dynTag(o));
  /* 可调用代理（目标是函数的那一支）：它是一格闭包记录而不是 $JSObj，所以取属性走这儿。
     get 陷阱要在函数那张面（name / length / call / apply / bind）之前问。 */
  if (typeof o === "object" && o.px !== undefined && o.fp !== undefined) {
    const f = $js_px_trap(o, "get");
    if (f !== undefined) return $callThis(f, o.px.h, [o.px.t, key, o]);
    return $js_getp(o.px.t, key, o.px.t);
  }
  if (typeof o === "string") {
    if (key === "length") return o.length;
    if ($js_isidx(key)) return $js_str_index(o, Number(key));
  }
  if (Array.isArray(o)) {
    if (key === "length") return o.length;
    if ($js_isidx(key)) return $js_arr_get(o, Number(key));
  }
  const p = $js_proto_of_prim(o);
  if (p === null) return undefined;
  const hit = $js_find_slot(p, key);
  if (hit === null) return undefined;
  const sl = hit[1];
  if (!sl.a) return sl.v;
  if (sl.g === undefined) return undefined;
  return $callThis(sl.g, o, []);
}
function $js_key_str(key) { return key instanceof $JSSym ? "Symbol(" + (key.d === undefined ? "" : key.d) + ")" : key; }
function $js_proto_of_prim(o) {
  const r = $realm();
  switch ($dynTag(o)) {
    case "string": return r.strP;
    case "real": case "int": return r.numP;
    case "bool": return r.boolP;
    case "symbol": return r.symP;
    case "list": return r.arrP;
    case "function": return r.funP;
    case "Map": return r.mapP;
    case "Set": return r.setP;
    case "regexp": return r.reP;
    case "dict": return r.objP;
    default: return r.objP;
  }
}
// 带接收者的调用。函数值现在有两个入口：fp（老的，没有 this）与 fp2（带 this）。
// 迁移期这样安排的理由：ADR-0011 那一代的 this 是**捕获的 cell**，传接收者对它是空操作；
// 而原型上的内建方法必须拿到接收者。lower.js 把 this 改成真接收者之后，编译出来的函数
// 也会带 fp2，$callThis 就不必再分岔。
// 带接收者的调用。函数值现在有两个入口：fp（老的，没有 this）与 fp2（带 this）。
// 迁移期这样安排的理由：ADR-0011 那一代的 this 是**捕获的 cell**，传接收者对它是空操作；
// 而原型上的内建方法必须拿到接收者（prelude 里那一格 fp2）。
//
// this 怎么传（ADR-0020 P1）：这个值域里的函数签名是 fn(list<dynamic>) -> dynamic，
// **没有 this 槽**，而改签名要动闭包记录、MakeClosure 与两个后端的调用约定。所以接收者
// 走一格运行期的槽：调用前放进去，被调函数入口的 js_this_take 取走并清空。规矩两条 ——
//   1. 只有这一条路会往槽里放东西，而且**返回之后一律把槽清成 undefined**；
//   2. 取的人是函数入口，读一次就清。
// 于是"没有接收者的那些调用"看到的一定是 undefined，不管上一趟留下过什么。
let $js_this_slot = undefined;
function $js_this_take() {
  const v = $js_this_slot;
  $js_this_slot = undefined;
  return v;
}
function $callThis(f, thisv, args) {
  const g = $js_asFn(f);
  $js_this_slot = thisv;
  const r = g.fp2 !== undefined ? g.fp2(thisv, args) : $callFn(g, args);
  $js_this_slot = undefined;
  return r;
}
// op 面的那一层皮：实参是一格 list 值，取出来再转发。
function $js_call_this(f, thisv, args) { return $callThis(f, thisv, $js_arr_of(args)); }
// 内建方法值。$nm/$ln 是 name 与 length（Function.prototype.name/length 要它们）。
function $nat(name, len, fn) {
  return { fp: (self, args) => fn(undefined, args), fp2: (t, args) => fn(t, args), $nm: name, $ln: len };
}
/* fn.name / fn.length（ADR-0020）：函数在这个值域里还不是**真对象**，所以这两格不是
   自有属性，而是 Function.prototype 上的两个访问器 —— 接收者是闭包记录（{fp, $nm, $ln, …}），
   记录里那两格由降级器与发射器一起填（lower.js 的 closureOf / emit.js 的 closureMake）。
   没填的（比如箭头，规范里它的 name 来自赋值目标）给 "" 与 0。 */
function $js_fn_name(f) {
  const g = $js_asFn(f);
  return typeof g.$nm === "string" ? g.$nm : "";
}
function $js_fn_len(f) {
  const g = $js_asFn(f);
  return typeof g.$ln === "number" ? g.$ln : 0;
}
/* 普通函数当构造器（ADR-0020）：new f()。函数不是真对象，所以 f.prototype 那一格
   放在一张 side table 上（$FNPROTO），funP 上的访问器读它 —— 于是 f.prototype.m = …
   与 x instanceof f 都成立。第一次问起才建，建的时候把 constructor 挂上去。 */
const $FNPROTO = new WeakMap();
function $js_fn_proto(f) {
  const g = $js_asFn(f);
  let p = $FNPROTO.get(g);
  if (p === undefined) {
    p = $js_obj_new();
    $js_def_data(p, "constructor", g, true, false, true);
    $FNPROTO.set(g, p);
  }
  return p;
}
/* new.target：走一格运行期的槽，与 this 同一个路子（js_this_take 那一段的说明）。
   放的人是 js_fn_construct 与 js_nt_put（类的构造走 $init 那格闭包，不经过前者），
   取的人是**函数入口**（读一次就清）。已知的窄口：
   一个用 new 调起来、自己**不提** new.target 的函数，在它体内直接调另一个提 new.target
   的普通函数时，那一格还没被清掉 —— 量过的源码里没有这种写法，先记在这儿。 */
let $js_nt_slot = undefined;
function $js_nt_take() {
  const v = $js_nt_slot;
  $js_nt_slot = undefined;
  return v;
}
function $js_nt_put(v) {
  $js_nt_slot = v;
  return undefined;
}
function $js_fn_construct(f, args) {
  /* 代理身上的 construct 陷阱最先问（规范 10.5.13）：目标是函数还是类对象都算，所以
     这一问要在下面那两条之前 —— 类对象那条会去读 classInit，而读属性本身会过 get 陷阱。
     陷阱不给对象时规范抛 TypeError；这个值域里 new 的值一律是对象，所以照旧当场报。 */
  if (f !== null && typeof f === "object" && f.px !== undefined) {
    const c = $js_px_trap(f, "construct");
    if (c !== undefined) {
      const r = $callThis(c, f.px.h, [f.px.t, $js_arr_of(args), f]);
      if ($js_pending()) return undefined;
      if (!$js_isobj(r)) $rt_error("a proxy construct trap must return an object");
      return r;
    }
    // 没有陷阱就落到目标上（可调用代理的 fp 只管 apply 那一侧）
    if (!$js_isobj(f)) return $js_fn_construct(f.px.t, args);
  }
  /* 右边是一格**类对象**（new this() / new ctorFromMap()）：类对象不是函数值，
     构造要走它身上那两格 —— prototype 当原型、初始化实例那格闭包（键是符号
     Symbol.omni.classInit，见降级器的 classInitKey）。
     形状与 newExpr 里静态那条路一样，只是这儿的类是运行期拿到的。 */
  if ($js_isobj(f)) {
    const init = $js_getp(f, $js_sym_wk("omni.classInit"), undefined);
    if ($dynTag(init) === "function") {
      const o = $js_obj_new_p($js_getp(f, "prototype", undefined));
      // new.target 是**被 new 的那一格类对象**（规范 10.2.2）—— 子类里它是子类
      $js_nt_slot = f;
      const r0 = $callThis(init, o, $js_arr_of(args));
      $js_nt_slot = undefined;
      if ($js_pending()) return undefined;
      return $js_isobj(r0) ? r0 : o;
    }
  }
  const g = $js_asFn(f);
  /* 内建构造器当值用（$js_mk_ctors 里标了 $ctor 的那批）：new A(3) 与 A(3) 同一件事，
     交出来的东西（数组、串、正则…）不一定是"真对象"，所以不能落到下面那句
     "不是对象就还给新造的那格"上 —— 那会把数组悄悄换成一格空对象。 */
  if (g.$ctor === true) {
    const rc = $callThis(g, undefined, $js_arr_of(args));
    return $js_pending() ? undefined : rc;
  }
  const o = $js_obj_new_p($js_fn_proto(g));
  $js_nt_slot = g;
  const r = $callThis(g, o, $js_arr_of(args));
  $js_nt_slot = undefined;
  if ($js_pending()) return undefined;
  // 构造器返回一格对象就用它，别的（包括 undefined）一律给新造的那一格（规范如此）
  return $js_isobj(r) ? r : o;
}
/* eval 与 Function(src)（ADR-0020 P6）：这两样要**编译器在运行期在场**。
   产物自己是自洽的一份 JS，里面没有编译器 —— 所以在本进程里跑的时候（omni run 与 REPL）
   由宿主装一格钩子（host/src_eval.js），这儿顺着宿主全局找它。装不上的场合
   （build 出来的产物、C 那条腿）当场报错，不假装能跑。
   作用域：编出来的是一段**独立的模块**，看不见调用者的局部量 —— 认下来的是"全局 eval"
   那一档（规范里的 indirect eval），拿不到的名字在编译期就报，冒出去是一格 SyntaxError。 */
function $js_src_eval(src) {
  const h = globalThis.$OMNI_SRC_EVAL;
  if (typeof h !== "function") {
    $rt_error("eval needs the compiler at run time; only 'omni run' and the REPL have it (ADR-0020 P6)");
  }
  try {
    return h($js_asS16($js_str(src)));
  } catch (e) {
    const m = e !== null && e !== undefined && e.message !== undefined ? e.message : String(e);
    const msg = String(m);
    // 名字查不到是 ReferenceError，别的编译期毛病算 SyntaxError —— 与 qjs 对得上
    const cls = msg.indexOf("unresolved") >= 0 ? "ReferenceError" : "SyntaxError";
    $js_throw($js_err_new(msg, [cls, "Error"], undefined));
    return undefined;
  }
}
function $js_src_fn(args, body) {
  const ps = [];
  for (const a of $js_arr_of(args)) ps.push($js_asS16($js_str(a)));
  return $js_src_eval("(function (" + ps.join(", ") + ") {\n" + $js_asS16($js_str(body)) + "\n})");
}
function $natm(o, name, len, fn) {
  $js_def_data(o, name, $nat(name, len, fn), true, false, true);
  return o;
}
// Symbol 的两张表：Symbol.for 的注册表，与 well-known 那一族。
const $SYMREG = new Map();
const $WKSYM = new Map();
function $js_sym_wk(name) {
  let s = $WKSYM.get(name);
  if (s === undefined) { s = new $JSSym("Symbol." + name); $WKSYM.set(name, s); }
  return s;
}
function $js_sym_new(desc) { return new $JSSym(desc === undefined ? undefined : $js_asS16($js_str(desc))); }
function $js_sym_for(k) {
  const key = $js_asS16($js_str(k));
  let s = $SYMREG.get(key);
  if (s === undefined) { s = new $JSSym(key); $SYMREG.set(key, s); }
  return s;
}
function $js_sym_key_for(s) {
  for (const [k, v] of $SYMREG) if (v === s) return k;
  return undefined;
}
function $js_sym_desc(s) { return $dynAsSym(s).d; }
function $js_sym_str(s) { const d = $dynAsSym(s).d; return "Symbol(" + (d === undefined ? "" : d) + ")"; }
function $dynAsSym(s) {
  if (!(s instanceof $JSSym)) $rt_error($dynTag(s) + " is not a symbol");
  return s;
}
// 领域（realm）：内建原型都是真对象，内建方法就住在上面。懒建一次 ——
// 不是每个程序都会碰到原型链，而建这一圈要几十次 defineProperty。
let $R = null;
function $realm() {
  if ($R === null) $R = $mkRealm();
  return $R;
}
function $mkRealm() {
  const objP = new $JSObj(null, "Object");
  const funP = new $JSObj(objP, "Function");
  const iterP = new $JSObj(objP, "Iterator");
  const r = {
    objP, funP, iterP,
    arrP: new $JSObj(objP, "Array"),
    strP: new $JSObj(objP, "String"),
    numP: new $JSObj(objP, "Number"),
    boolP: new $JSObj(objP, "Boolean"),
    symP: new $JSObj(objP, "Symbol"),
    errP: new $JSObj(objP, "Error"),
    mapP: new $JSObj(objP, "Map"),
    setP: new $JSObj(objP, "Set"),
    reP: new $JSObj(objP, "RegExp"),
    dateP: new $JSObj(objP, "Date"),
    promP: new $JSObj(objP, "Promise"),
    /* 生成器的原型链上有 Iterator.prototype（规范如此）—— ES2025 的那批 helper
       （take / map / filter …）就住在那儿，所以这一格不能是 objP。
       helper 自己交出来的迭代器另有一格原型（%IteratorHelperPrototype%），
       它的原型又是 Iterator.prototype，于是 helper 可以接着往下链。 */
    genP: new $JSObj(iterP, "Generator"),
    iterHelpP: new $JSObj(iterP, "Iterator Helper"),
    agenP: new $JSObj(objP, "AsyncGenerator"),
    // globalThis（ADR-0020 P4）：这个值域里没有全局环境记录（模块的顶层名字是模块局部的），
    // 所以它就是**一格普通的真对象**，每个 realm 一份。挂上去的东西读得回来，
    // 内建（Math / JSON …）不在它身上 —— 那是画出来的边界。
    gt: new $JSObj(objP, "Object"),
  };
  $R = r;
  $natm(objP, "hasOwnProperty", 1, (t, a) => $js_isobj(t) && t.ps.has($js_pkey(a[0])));
  $natm(objP, "isPrototypeOf", 1, (t, a) => {
    let cur = $js_isobj(a[0]) ? a[0].pr : null;
    while (cur !== null && cur !== undefined) { if (cur === t) return true; cur = $js_isobj(cur) ? cur.pr : null; }
    return false;
  });
  $natm(objP, "propertyIsEnumerable", 1, (t, a) => {
    if (!$js_isobj(t)) return false;
    const sl = t.ps.get($js_pkey(a[0]));
    return sl !== undefined && sl.e;
  });
  $natm(objP, "valueOf", 0, (t) => t);
  $natm(objP, "toString", 0, (t) => $js_obj_to_string(t));
  $natm(objP, "toLocaleString", 0, (t) => $js_str(t));
  $natm(funP, "call", 1, (t, a) => $callThis(t, a[0], a.slice(1)));
  $natm(funP, "apply", 2, (t, a) => $callThis(t, a[0], a[1] === undefined || a[1] === null ? [] : $js_arr_of(a[1])));
  // name / length：函数还不是真对象，这两格住在 Function.prototype 上（见 $js_fn_name）
  $js_def_acc(funP, "name", $nat("name", 0, (t) => $js_fn_name(t)), undefined, false, true);
  $js_def_acc(funP, "length", $nat("length", 0, (t) => $js_fn_len(t)), undefined, false, true);
  // prototype：函数不是真对象，这一格从 side table 上取（第一次问起才建）
  $js_def_acc(funP, "prototype", $nat("prototype", 0, (t) => $js_fn_proto(t)), undefined, false, false);
  /* Function.prototype.toString：规范要的是**源文本**，而这个值域里的产物不带它。
     从前这一格落到 Object.prototype.toString 上，交出 "[object Function]" —— 一格
     静静的谎（f.toString().includes("named") 为假），而且与 String(f) 自相矛盾
     （那边是硬错 "cannot convert function to string"）。现在两条路一样地响。 */
  $natm(funP, "toString", 0, () => $rt_error(
    "Function.prototype.toString needs the source text, which this value domain does not keep"));
  $natm(funP, "bind", 1, (t, a) => {
    /* bind 出来的那一格：name 是 "bound " 加原来的名字、length 是原来的减掉预先绑上的实参
       个数（不小于 0）—— 规范 20.2.3.2。量过 qjs 与 node 都是这样。 */
    const bt = a[0], pre = a.slice(1);
    const nm = "bound " + $js_str($js_fn_name(t));
    const ln = Math.max(0, $js_real($js_fn_len(t), "bind") - pre.length);
    return { fp: (self, args) => $callThis(t, bt, [...pre, ...args]), fp2: (ig, args) => $callThis(t, bt, [...pre, ...args]), $nm: nm, $ln: ln };
  });
  // Symbol.toStringTag 决定 [object X] 里的 X；没有就看 [[Class]]。
  /* "借内建方法"那一格（ADR-0020）：Array.prototype.join.call(a, "|")。数组的方法平时是
     **按标签派发**的（JS_METHODS，编译期就展开成 $js_arr_join），所以原型上本来一个都没有。
     这儿把借得最多的那几个摆上去 —— 整张表要等"派发器生成一份注册表"那一步，现在
     摆的是量到过的这些；表外的名字还是 undefined（借它就会当场报"不是函数"）。 */
  $natm(r.arrP, "join", 1, (t, a) => $js_arr_join(t, a[0]));
  /* Array.prototype.toString（规范 23.1.3.36）：就是 join(",")。少了它的话
     [1,2].toString() 落到 Object.prototype 上、印出 [object Array]（量出来的分叉）。 */
  $natm(r.arrP, "toString", 0, (t) => $js_arr_join(t, undefined));
  $natm(r.arrP, "slice", 2, (t, a) => $js_arr_slice(t, a[0], a[1]));
  /* sort / toSorted 当值用（[].sort.length、Array.prototype.sort.call(xs, cmp)）：
     成员位上走的是定长 op，这儿补的是原型上那一格函数值 —— 从前 [].sort 是 undefined，
     于是 .length 当场报。比较器照旧那一份（$js_arr_cmp），两条路语义同一格。 */
  $natm(r.arrP, "sort", 1, (t, a) => $js_arr_sort(t, a[0]));
  $natm(r.arrP, "toSorted", 1, (t, a) => $js_arr_to_sorted(t, a[0]));
  $natm(r.arrP, "concat", 1, (t, a) => $js_arr_concat(t, a[0]));
  // splice / toSpliced 收可变实参，而且**实参个数是语义的一部分**，所以整串传下去
  $natm(r.arrP, "splice", 2, (t, a) => $js_arr_splice(t, a));
  $natm(r.arrP, "toSpliced", 2, (t, a) => $js_arr_to_spliced(t, a));
  $natm(r.arrP, "indexOf", 1, (t, a) => $js_arr_index_of(t, a[0], a[1]));
  $natm(r.arrP, "includes", 1, (t, a) => $js_arr_includes(t, a[0], a[1]));
  /* 迭代方法的第二个实参是 thisArg（规范 23.1.3.*）：回调先裹一层把 this 定住。
     从前这一格被丢掉 —— [1,2,3].map(cb, {k:2}) 里 cb 的 this 是 undefined。 */
  $natm(r.arrP, "map", 1, (t, a) => $js_arr_map(t, $js_bind_this(a[0], a[1])));
  $natm(r.arrP, "filter", 1, (t, a) => $js_arr_filter(t, $js_bind_this(a[0], a[1])));
  $natm(r.arrP, "forEach", 1, (t, a) => $js_arr_for_each(t, $js_bind_this(a[0], a[1])));
  $natm(r.arrP, "some", 1, (t, a) => $js_arr_some(t, $js_bind_this(a[0], a[1])));
  $natm(r.arrP, "every", 1, (t, a) => $js_arr_every(t, $js_bind_this(a[0], a[1])));
  $natm(r.arrP, "find", 1, (t, a) => $js_arr_find(t, $js_bind_this(a[0], a[1])));
  $natm(r.arrP, "findIndex", 1, (t, a) => $js_arr_find_index(t, $js_bind_this(a[0], a[1])));
  $natm(r.arrP, "findLast", 1, (t, a) => $js_arr_find_last(t, $js_bind_this(a[0], a[1])));
  $natm(r.arrP, "findLastIndex", 1, (t, a) => $js_arr_find_last_index(t, $js_bind_this(a[0], a[1])));
  $natm(r.arrP, "flatMap", 1, (t, a) => $js_arr_flat_map(t, $js_bind_this(a[0], a[1])));
  // 字符串那边同理（String.prototype.slice.call(s, 1)）。trim 的 lit 排在实参前面。
  $natm(r.strP, "slice", 2, (t, a) => $js_str_slice(t, a[0], a[1]));
  $natm(r.strP, "indexOf", 1, (t, a) => $js_str_index_of(t, a[0], undefined));
  $natm(r.strP, "includes", 1, (t, a) => $js_str_includes(t, a[0], a[1]));
  $natm(r.strP, "startsWith", 1, (t, a) => $js_str_starts_with(t, a[0], a[1]));
  $natm(r.strP, "endsWith", 1, (t, a) => $js_str_ends_with(t, a[0], a[1]));
  $natm(r.strP, "split", 1, (t, a) => $js_str_split(t, a[0]));
  $natm(r.strP, "trim", 0, (t) => $js_str_trim("b", t));
  $natm(r.strP, "toUpperCase", 0, (t) => $js_str_upper(t));
  $natm(r.strP, "toLowerCase", 0, (t) => $js_str_lower(t));
  $natm(r.strP, "charAt", 1, (t, a) => $js_str_char_at(t, a[0]));
  $natm(r.strP, "charCodeAt", 1, (t, a) => $js_str_char_code_at(t, a[0]));
  $natm(r.strP, "repeat", 1, (t, a) => $js_str_repeat(t, a[0]));
  $natm(r.iterP, "next", 0, () => $rt_error("Iterator.prototype.next is abstract"));
  /* ES2025 的那批 helper 就摆在这儿 —— 生成器与 helper 自己造的迭代器都从原型链上拿到它。
     Symbol.iterator 给 this 自己（规范如此），for-of 与展开于是也能吃 helper 的结果。 */
  $natm(r.iterP, "take", 1, (t, a) => $js_it_take(t, a[0]));
  $natm(r.iterP, "drop", 1, (t, a) => $js_it_drop(t, a[0]));
  $natm(r.iterP, "map", 1, (t, a) => $js_it_map(t, a[0]));
  $natm(r.iterP, "filter", 1, (t, a) => $js_it_filter(t, a[0]));
  $natm(r.iterP, "flatMap", 1, (t, a) => $js_it_flat_map(t, a[0]));
  $natm(r.iterP, "toArray", 0, (t) => $js_it_to_array(t));
  $natm(r.iterP, "forEach", 1, (t, a) => $js_it_for_each(t, a[0]));
  $natm(r.iterP, "reduce", 1, (t, a) => $js_it_reduce(t, a[0], a[1]));
  $natm(r.iterP, "some", 1, (t, a) => $js_it_some(t, a[0]));
  $natm(r.iterP, "every", 1, (t, a) => $js_it_every(t, a[0]));
  $natm(r.iterP, "find", 1, (t, a) => $js_it_find(t, a[0]));
  $js_def_data(r.iterP, $js_sym_wk("iterator"), $nat("[Symbol.iterator]", 0, (t) => t), true, false, true);
  // Symbol 的两格：description 是访问器（规范如此），toString 给 "Symbol(desc)"
  $js_def_acc(r.symP, "description", $nat("description", 0, (t) => $dynAsSym(t).d), undefined, false, true);
  $natm(r.symP, "toString", 0, (t) => $js_sym_str(t));
  /* 正则对象的 toString（规范 22.2.6.13）：/源/旗标。它住在原型上，所以借方法那条路
     （RegExp.prototype.toString.call(re)）与 String(re) 都落到这一格。 */
  $natm(r.reP, "toString", 0, (t) => "/" + $js_re_source(t) + "/" + $js_re_flags(t));
  /* Error.prototype.toString（规范 20.5.3.4）：name、有 message 时再接 ": " 与 message。
     name / message 从**实例**上读（子类会盖掉 name），两格都缺时给 "Error"。 */
  $natm(r.errP, "toString", 0, (t) => {
    const n = $js_getp(t, "name", undefined);
    const m = $js_getp(t, "message", undefined);
    const ns = n === undefined ? "Error" : $js_str(n);
    const ms = m === undefined ? "" : $js_str(m);
    if (ms === "") return ns;
    return ns === "" ? ms : ns + ": " + ms;
  });
  /* Error.prototype.name：规范里 name 住在**原型**上，不是实例的自有属性。取值顺着 $cls
     那条链找第一个**内建**错误名 —— class A extends Error {} 的实例，name 是 "Error"
     而不是 "A"（量出来的静默分叉：从前给的是链头，于是 String(a) 印 "A: m"）。
     赋值走 setter，在实例上定一格**自有可枚举**的数据属性 —— 与规范里"给继承来的数据
     属性赋值"的结果一致，this.name = "MyErr" 于是进得了 JSON.stringify 与 Object.keys。 */
  $js_def_acc(r.errP, "name", $nat("get name", 0, (t) => $js_err_bname(t)),
    $nat("set name", 1, (t, a) => { $js_def_data(t, "name", a[0], true, true, true); return undefined; }),
    false, true);
  /* Date（ADR-0020 P4）：一格真对象，毫秒存在隐藏槽 $ms 里（不可枚举，所以
     Object.keys / JSON.stringify 看不见它）。取值面**转手宿主 Date** —— 本地时区那几格
     因此与宿主一致（qjs 也用本地时区）。只有 JS 那条腿有：C 侧还没有真对象（P1-c），
     用到 Date 的程序编不成 C，tests/js-exec 会把它的 C 腿标成 skip-c。 */
  $natm(r.dateP, "getTime", 0, (t) => $js_date_ms(t));
  $natm(r.dateP, "valueOf", 0, (t) => $js_date_ms(t));
  $natm(r.dateP, "toISOString", 0, (t) => new Date($js_date_ms(t)).toISOString());
  $natm(r.dateP, "toJSON", 1, (t) => new Date($js_date_ms(t)).toISOString());
  $natm(r.dateP, "toString", 0, (t) => new Date($js_date_ms(t)).toString());
  /* Date.prototype[Symbol.toPrimitive]（规范 21.4.4.45）：隐式强转那条路早就对
     （d2 - d1 走 valueOf、模板串走 toString），缺的只是**显式取那一格函数**。
     口径照规范："number" 给毫秒，"string" 与 "default" 都给 toString —— Date 是
     唯一一个 default 走串的内建。 */
  $js_def_data(r.dateP, $js_sym_wk("toPrimitive"),
    $nat("[Symbol.toPrimitive]", 1, (t, args) => (args[0] === "number"
      ? $js_date_ms(t)
      : new Date($js_date_ms(t)).toString())), true, false, true);
  $natm(r.dateP, "getFullYear", 0, (t) => new Date($js_date_ms(t)).getFullYear());
  $natm(r.dateP, "getMonth", 0, (t) => new Date($js_date_ms(t)).getMonth());
  $natm(r.dateP, "getDate", 0, (t) => new Date($js_date_ms(t)).getDate());
  $natm(r.dateP, "getDay", 0, (t) => new Date($js_date_ms(t)).getDay());
  $natm(r.dateP, "getHours", 0, (t) => new Date($js_date_ms(t)).getHours());
  $natm(r.dateP, "getMinutes", 0, (t) => new Date($js_date_ms(t)).getMinutes());
  $natm(r.dateP, "getSeconds", 0, (t) => new Date($js_date_ms(t)).getSeconds());
  $natm(r.dateP, "getMilliseconds", 0, (t) => new Date($js_date_ms(t)).getMilliseconds());
  $natm(r.dateP, "getTimezoneOffset", 0, (t) => new Date($js_date_ms(t)).getTimezoneOffset());
  $natm(r.dateP, "getUTCFullYear", 0, (t) => new Date($js_date_ms(t)).getUTCFullYear());
  $natm(r.dateP, "getUTCMonth", 0, (t) => new Date($js_date_ms(t)).getUTCMonth());
  $natm(r.dateP, "getUTCDate", 0, (t) => new Date($js_date_ms(t)).getUTCDate());
  $natm(r.dateP, "getUTCDay", 0, (t) => new Date($js_date_ms(t)).getUTCDay());
  $natm(r.dateP, "getUTCHours", 0, (t) => new Date($js_date_ms(t)).getUTCHours());
  $natm(r.dateP, "getUTCMinutes", 0, (t) => new Date($js_date_ms(t)).getUTCMinutes());
  $natm(r.dateP, "getUTCSeconds", 0, (t) => new Date($js_date_ms(t)).getUTCSeconds());
  $natm(r.dateP, "getUTCMilliseconds", 0, (t) => new Date($js_date_ms(t)).getUTCMilliseconds());
  /* 写的那一族（setFullYear / setMonth / … / setTime）：Date 在这个值域里是"一格真对象 +
     隐藏槽 $ms"，所以每一格都是"现搭一个宿主 Date、改完再把毫秒写回槽里"，交出新的毫秒
     （规范如此）。从前整族缺失，d.setFullYear(2000) 在运行期是 "undefined is not a function"。 */
  const dset = (name, hostName, argc) => {
    $natm(r.dateP, name, argc, (t, a) => {
      const d = new Date($js_date_ms(t));
      const as = [];
      for (let i = 0; i < argc; i++) {
        if (a[i] === undefined) break;
        as.push(Math.trunc($js_real($js_num_of(a[i]), name)));
      }
      d[hostName](...as);
      const ms = d.getTime();
      $js_setp(t, "$ms", ms, t);
      return ms;
    });
  };
  dset("setTime", "setTime", 1);
  dset("setFullYear", "setFullYear", 3);
  dset("setMonth", "setMonth", 2);
  dset("setDate", "setDate", 1);
  dset("setHours", "setHours", 4);
  dset("setMinutes", "setMinutes", 3);
  dset("setSeconds", "setSeconds", 2);
  dset("setMilliseconds", "setMilliseconds", 1);
  dset("setUTCFullYear", "setUTCFullYear", 3);
  dset("setUTCMonth", "setUTCMonth", 2);
  dset("setUTCDate", "setUTCDate", 1);
  dset("setUTCHours", "setUTCHours", 4);
  dset("setUTCMinutes", "setUTCMinutes", 3);
  dset("setUTCSeconds", "setUTCSeconds", 2);
  dset("setUTCMilliseconds", "setUTCMilliseconds", 1);
  /* Promise（ADR-0020 P2 的前半）：状态与回调表都在隐藏槽里（$st / $val / $cbs）。
     then / catch / finally 住在 promP 上，所以 p.then(f) 走的是普通的"取属性 + 带
     接收者调用"那条路，不必进成员表。await 与 async 函数还没有 —— 那要状态机改写。 */
  $natm(r.promP, "then", 2, (t, a) => $js_prom_react(t, a[0], a[1]));
  $natm(r.promP, "catch", 1, (t, a) => $js_prom_react(t, undefined, a[0]));
  $natm(r.promP, "finally", 1, (t, a) => {
    /* 规范的 finally 不是"调一下就完"：onFinally 的结果要先 resolve 一遍，再把原来的
       值/异常接回去（22.2.6.3 的 thenFinally / catchFinally）—— 于是它比 then 多两拍。
       少了这两拍，两条独立链的交错次序就与 qjs 不同。 */
    const f = a[0];
    return $js_prom_react(t,
      $nat("", 1, (tt, aa) => {
        const v = aa[0];
        return $js_prom_react($js_promise_resolved($callThis(f, undefined, [])),
          $nat("", 1, () => v), undefined);
      }),
      $nat("", 1, (tt, aa) => {
        const e = aa[0];
        return $js_prom_react($js_promise_resolved($callThis(f, undefined, [])),
          $nat("", 1, () => { $js_throw(e); return undefined; }), undefined);
      }));
  });
  /* 生成器对象的原型（ADR-0020 P2）：next / return / throw 都转给同一格状态机，
     Symbol.iterator 返回自己 —— 于是 for-of 与展开走的是通用的迭代器协议那条路。 */
  $natm(r.genP, "next", 1, (t, a) => $js_gen_step(t, a[0], 0));
  $natm(r.genP, "return", 1, (t, a) => $js_gen_step(t, a[0], 1));
  $natm(r.genP, "throw", 1, (t, a) => $js_gen_step(t, a[0], 2));
  $js_def_data(r.genP, $js_sym_wk("iterator"), $nat("[Symbol.iterator]", 0, (t) => t), true, false, true);
  // async 生成器：next/return/throw 都返回 promise，Symbol.asyncIterator 返回自己
  $natm(r.agenP, "next", 1, (t, a) => $js_agen_step(t, a[0], 0));
  $natm(r.agenP, "return", 1, (t, a) => $js_agen_step(t, a[0], 1));
  $natm(r.agenP, "throw", 1, (t, a) => $js_agen_step(t, a[0], 2));
  $js_def_data(r.agenP, $js_sym_wk("asyncIterator"), $nat("[Symbol.asyncIterator]", 0, (t) => t), true, false, true);
  /* 原始值那一族的 Symbol.iterator（数组 / 串 / Map / Set）：交出一格**真的迭代器对象**
     （$js_it_src 先收成数组再按下标喂）。for-of 与展开走的是 js_iter 那条快路，不经过这里；
     手写协议（a[Symbol.iterator]().next()）与 yield* 要拿返回值时才落到这一格。 */
  for (const p of [r.arrP, r.strP, r.mapP, r.setP]) {
    $js_def_data(p, $js_sym_wk("iterator"), $nat("[Symbol.iterator]", 0, (t) => $js_it_src(t)), true, false, true);
  }
  $js_mk_ctors(r);
  return r;
}
/* 内建构造器**当值用**（ADR-0020 P1-f 的第二半）：const A = Array、[].constructor === Array。
   与 $js_realm_proto 同一个路子 —— 名字是编译期常量，每个 realm 一份，取两次是同一个值，
   所以 === 为真。它是一格**闭包记录**而不是真对象：函数在这个值域里还不是真对象，
   于是静态面（Array.isArray / Object.keys）挂不上去 —— 那些名字只能从**成员写法**取
   （Array.isArray(x) 那条静态路），从值上取（A.isArray）是运行期
   "undefined is not a function"。响，且写在 ADR 里。
   prototype 那一格靠 $FNPROTO 预先坐好，于是 A.prototype 与 x instanceof A 都对；
   $ctor 那格标记给 $js_fn_construct 看：内建构造器交出来的东西（数组、串…）不一定是
   "真对象"，不能被那句"不是对象就还给新造的那格"吞掉。 */
function $js_mk_ctors(r) {
  r.ctors = new Map();
  const mk = (name, len, proto, fn) => {
    const c = $nat(name, len, fn);
    c.$ctor = true;
    $FNPROTO.set(c, proto);
    $js_def_data(proto, "constructor", c, true, false, true);
    r.ctors.set(name, c);
  };
  /* 收不了的那几个：Function 要编译器在场（见 $js_src_eval），Map / Set / Date 的实参面
     （可迭代物 / 七个时间格）还没有运行期那一格。一律当场报，不给半对的值。 */
  const no = (name) => () => $rt_error("'" + name + "' as a value cannot be called here; call it by name instead");
  mk("Object", 1, r.objP, (t, a) => {
    if (a[0] === undefined || a[0] === null) return $js_obj_new();
    if ($js_isobj(a[0]) || Array.isArray(a[0])) return a[0];
    return $rt_error("Object(primitive) would need a wrapper object; not supported");
  });
  mk("Array", 1, r.arrP, (t, a) => (a.length === 1 ? $js_arr_new_n(a[0]) : a.slice()));
  mk("String", 1, r.strP, (t, a) => (a.length === 0 ? "" : $js_str(a[0])));
  mk("Number", 1, r.numP, (t, a) => (a.length === 0 ? 0 : $js_num_of(a[0])));
  mk("Boolean", 1, r.boolP, (t, a) => $js_truthy(a[0]));
  mk("Symbol", 0, r.symP, (t, a) => $js_sym_new(a[0]));
  mk("RegExp", 2, r.reP, (t, a) => $js_re_new(a[0], a[1]));
  mk("Function", 1, r.funP, no("Function"));
  mk("Map", 0, r.mapP, no("Map"));
  mk("Set", 0, r.setP, no("Set"));
  mk("Date", 7, r.dateP, no("Date"));
}
function $js_realm_ctor(name) {
  const c = $realm().ctors.get(name);
  if (c === undefined) $rt_error("no such builtin constructor: " + name);
  return c;
}
/* x.constructor：就是一次普通的属性读（原型链上那一格 constructor）。
   自己占一格 op 的**唯一**理由是 C 那条腿：realm 与真对象是 JS 独有的（P1_JS_ONLY），
   走 js_obj_get 的话 C 会静静地给 undefined 而 JS 给构造器 —— 两条腿的答案不一样。
   现在 C 在**发射期**就拒。计算写法 o["constructor"] 不走这儿，那是留着的一格窄口。 */
function $js_ctor_get(o) {
  return $js_isobj(o) ? $js_getp(o, "constructor", o) : $js_prim_get(o, "constructor");
}
/* ---------------------------------------- 作业队列（微任务）与 Promise
   这个值域里**没有事件循环**：队列是一格数组，降级器在 main 末尾补一句 js_jobs_run
   把它排空 —— "调用栈空了"这件事只有那一处可观测。所以 setTimeout 那一族不在这一档里，
   只有微任务；而"程序结束时还没结算的 promise"就静静地留在那儿（与 node 一样）。 */
const $JOBS = [];
function $js_job(f) { $JOBS.push(f); }
function $js_jobs_run() {
  while ($JOBS.length > 0) {
    const f = $JOBS.shift();
    f();
    // 作业里抛出来的东西没人接手（JS 里那是 unhandledRejection）：清掉槽，
    // 别让它冒到下一个作业上
    if ($js_pending()) $js_take_pending();
  }
  return undefined;
}
function $js_prom_new() {
  const p = $js_obj_new_p($realm().promP);
  $js_def_data(p, "$st", 0, true, false, true);
  $js_def_data(p, "$val", undefined, true, false, true);
  // $cbs 是**宿主数组**（不进 JS 域）：每一项是 { f, r, child }
  $js_def_data(p, "$cbs", [], true, false, true);
  return p;
}
function $js_prom_is(v) { return $js_isobj(v) && v.ps.has("$st"); }
function $js_prom_get(p, k) { return p.ps.get(k).v; }
function $js_prom_put(p, k, v) { p.ps.get(k).v = v; }
function $js_prom_schedule(p, cb) {
  $js_job(() => {
    const st = $js_prom_get(p, "$st"), val = $js_prom_get(p, "$val");
    const h = st === 1 ? cb.f : cb.r;
    if (h === undefined || h === null) { $js_prom_settle(cb.child, st, val); return; }
    const out = $callThis(h, undefined, [val]);
    if ($js_pending()) { $js_prom_settle(cb.child, 2, $js_take_pending()); return; }
    $js_prom_settle(cb.child, 1, out);
  });
}
// 注册一对处理器，返回子 promise。已经结算的也要**排队**，不能当场调 —— 微任务的次序
// （先把同步代码跑完）就是靠这一条。
function $js_prom_react(p, f, r) {
  if (!$js_prom_is(p)) $rt_error("this is not a Promise");
  const child = $js_prom_new();
  const cb = { f, r, child };
  if ($js_prom_get(p, "$st") === 0) $js_prom_get(p, "$cbs").push(cb);
  else $js_prom_schedule(p, cb);
  return child;
}
function $js_prom_settle(p, st, val) {
  if ($js_prom_get(p, "$st") !== 0) return;
  /* resolve 收到一格 promise 就跟着它走（thenable 只认我们自己这一族）。
     规范里这一步**多花一拍**（NewPromiseResolveThenableJob）：先排一个作业，
     在作业里才去注册。少了这一拍，两条独立链的交错次序就与 qjs 不同 —— 量出来过。 */
  if (st === 1 && $js_prom_is(val)) {
    $js_job(() => {
      $js_prom_react(val,
        $nat("", 1, (t, a) => { $js_prom_settle(p, 1, a[0]); return undefined; }),
        $nat("", 1, (t, a) => { $js_prom_settle(p, 2, a[0]); return undefined; }));
    });
    return;
  }
  $js_prom_put(p, "$st", st);
  $js_prom_put(p, "$val", val);
  const cbs = $js_prom_get(p, "$cbs");
  for (let i = 0; i < cbs.length; i++) $js_prom_schedule(p, cbs[i]);
  $js_prom_put(p, "$cbs", []);
}
function $js_promise_new(exec) {
  const p = $js_prom_new();
  const res = $nat("resolve", 1, (t, a) => { $js_prom_settle(p, 1, a[0]); return undefined; });
  const rej = $nat("reject", 1, (t, a) => { $js_prom_settle(p, 2, a[0]); return undefined; });
  $callThis(exec, undefined, [res, rej]);
  // executor 自己抛了：照规范当作 reject
  if ($js_pending()) $js_prom_settle(p, 2, $js_take_pending());
  return p;
}
function $js_promise_resolved(v) {
  if ($js_prom_is(v)) return v;
  const p = $js_prom_new();
  $js_prom_settle(p, 1, v);
  return p;
}
function $js_promise_rejected(e) {
  const p = $js_prom_new();
  $js_prom_settle(p, 2, e);
  return p;
}
// Promise.all：不是 promise 的元素当已结算的值收下；任何一格 reject 就整体 reject。
function $js_promise_all(items) {
  const xs = [...$js_iter(items)];
  const out = $js_promise_new($nat("", 2, (t, a) => {
    const res = a[0], rej = a[1];
    const vals = [];
    let left = xs.length;
    if (left === 0) { $callThis(res, undefined, [vals]); return undefined; }
    for (let i = 0; i < xs.length; i++) vals.push(undefined);
    for (let i = 0; i < xs.length; i++) {
      const at = i;
      $js_prom_react($js_promise_resolved(xs[at]),
        $nat("", 1, (tt, aa) => {
          vals[at] = aa[0];
          left--;
          if (left === 0) $callThis(res, undefined, [vals]);
          return undefined;
        }),
        $nat("", 1, (tt, aa) => { $callThis(rej, undefined, [aa[0]]); return undefined; }));
    }
    return undefined;
  }));
  return out;
}
/* allSettled / any / race（ES2020 / ES2021）：与 all 同一个骨架 —— 每个元素先过一遍
   PromiseResolve，再挂一对反应，计数器决定谁落地。三者的差别只在"什么算落地"：
     allSettled 从不 reject，结果按**原顺序**排（不是完成顺序）
     any 头一个 fulfill 就成，全 reject 才 reject（AggregateError；qjs 的 message 是空串）
     race 头一个 settle 就跟着它 —— 空数组于是永远不落地（规范如此，不是漏了一支） */
function $js_promise_all_settled(items) {
  const xs = [...$js_iter(items)];
  return $js_promise_new($nat("", 2, (t, a) => {
    const res = a[0];
    const vals = [];
    let left = xs.length;
    if (left === 0) { $callThis(res, undefined, [vals]); return undefined; }
    for (let i = 0; i < xs.length; i++) vals.push(undefined);
    for (let i = 0; i < xs.length; i++) {
      const at = i;
      const settle = (status, key, v) => {
        const o = $js_obj_new();
        $js_obj_set(o, "status", status);
        $js_obj_set(o, key, v);
        vals[at] = o;
        left--;
        if (left === 0) $callThis(res, undefined, [vals]);
      };
      $js_prom_react($js_promise_resolved(xs[at]),
        $nat("", 1, (tt, aa) => { settle("fulfilled", "value", aa[0]); return undefined; }),
        $nat("", 1, (tt, aa) => { settle("rejected", "reason", aa[0]); return undefined; }));
    }
    return undefined;
  }));
}
function $js_promise_any(items) {
  const xs = [...$js_iter(items)];
  return $js_promise_new($nat("", 2, (t, a) => {
    const res = a[0], rej = a[1];
    const errs = [];
    let left = xs.length;
    const fail = () => {
      const e = $js_err_new("", ["AggregateError", "Error"], undefined);
      $js_obj_set(e, "errors", errs);
      $callThis(rej, undefined, [e]);
    };
    if (left === 0) { fail(); return undefined; }
    for (let i = 0; i < xs.length; i++) errs.push(undefined);
    for (let i = 0; i < xs.length; i++) {
      const at = i;
      $js_prom_react($js_promise_resolved(xs[at]),
        $nat("", 1, (tt, aa) => { $callThis(res, undefined, [aa[0]]); return undefined; }),
        $nat("", 1, (tt, aa) => {
          errs[at] = aa[0];
          left--;
          if (left === 0) fail();
          return undefined;
        }));
    }
    return undefined;
  }));
}
function $js_promise_race(items) {
  const xs = [...$js_iter(items)];
  return $js_promise_new($nat("", 2, (t, a) => {
    const res = a[0], rej = a[1];
    for (let i = 0; i < xs.length; i++) {
      $js_prom_react($js_promise_resolved(xs[i]),
        $nat("", 1, (tt, aa) => { $callThis(res, undefined, [aa[0]]); return undefined; }),
        $nat("", 1, (tt, aa) => { $callThis(rej, undefined, [aa[0]]); return undefined; }));
    }
    return undefined;
  }));
}
/* groupBy（ES2024）：走一遍迭代，回调收 (value, index)，每组按**原顺序**攒成一个数组。
   两处差别照规范：Object.groupBy 交出来的是一格 **null 原型**的对象、键过一遍
   ToPropertyKey（符号照原样，别的转串）；Map.groupBy 的键按 SameValueZero 比。 */
function $js_obj_group_by(items, f) {
  const out = $js_obj_new_p(null);
  const xs = $js_iter(items);
  for (let i = 0; i < xs.length; i++) {
    const kv = $callFn(f, [xs[i], i]);
    const k = $dynTag(kv) === "symbol" ? kv : $js_str(kv);
    let g = $js_getp(out, k);
    if (g === undefined) { g = []; $js_setp(out, k, g); }
    g.push(xs[i]);
  }
  return out;
}
function $js_map_group_by(items, f) {
  const m = $js_map_new();
  const xs = $js_iter(items);
  for (let i = 0; i < xs.length; i++) {
    const k = $callFn(f, [xs[i], i]);
    let g = $js_map_get(m, k);
    if (g === undefined) { g = []; $js_map_set(m, k, g); }
    g.push(xs[i]);
  }
  return m;
}
/* Promise.try（ES2025）：f 立刻同步跑 —— 正常返回就 resolve、抛出来的东西当 reject。
   与 new Promise(executor) 里的那一格是同一条规矩（pending 槽，ADR-0007）。 */
function $js_promise_try(f) {
  const p = $js_prom_new();
  const v = $callFn(f, []);
  if ($js_pending()) { $js_prom_settle(p, 2, $js_take_pending()); return p; }
  // 返回的是 promise 就跟着它走（规范里这一格走 PromiseResolve）
  $js_prom_settle(p, 1, v);
  return p;
}
/* 生成器（ADR-0020 P2 的后半）：函数体已经被 genfn.js 改写成一台状态机，这儿只剩
   "包装成迭代器对象"这一层皮。step 是那台状态机（一格普通的 JS 函数值），约定：
     step(v, 0) -> 下一步（v 是 next(v) 送进去的值）
     step(v, 1) -> it.return(v)：跑该跑的 finally，然后完
     step(v, 2) -> it.throw(v)：同上，跑完把异常接回去
   返回的都是 js_gen_res 造的 { value, done }。状态存两格隐藏槽：
   $stp（那台状态机）与 $gst（0 还没开始 / 1 挂起 / 2 完）。 */
function $js_gen_res(v, done) {
  const o = $js_obj_new();
  $js_def_data(o, "value", v, true, true, true);
  $js_def_data(o, "done", done === true, true, true, true);
  return o;
}
/* Iterator helpers（ES2025）：住在 Iterator.prototype 上，所以生成器（原型链上有它）与
   helper 自己造出来的迭代器都接得下去。惰性的那五格（take / drop / map / filter / flatMap）
   各造一格新迭代器，next 才去拉上游；终结的那几格就地把上游拉完或短路。短路时**关掉上游**
   （调它的 return）—— 规范如此，而且量得出来：带 finally 的生成器在 take(3) 拉完之后就
   该跑 finally。两处边界：空 reduce 与负的 take/drop 在规范里是 TypeError / RangeError，
   这个值域里是当场报错（没有"可 catch 的宿主错"这一格）。 */
function $js_it_close(t) {
  const f = $js_getp(t, "return", undefined);
  if (f !== undefined && f !== null) $callThis(f, t, []);
}
function $js_it_pull(t) { return $js_iter_next(t); }
function $js_it_done(r) { return $js_truthy($js_getp(r, "done", undefined)); }
function $js_it_val(r) { return $js_getp(r, "value", undefined); }
/* helper 交出来的迭代器：next 拉一格，return 把**上游**也关掉（规范里 return 就是这么
   一层层链下去的 —— 少了这一格，g().map(f).take(3) 拉完之后生成器的 finally 不会跑，
   量出来过）。关掉之后 next 一律 done。 */
function $js_it_new(next, up) {
  let closed = false;
  const o = $js_obj_new_p($realm().iterHelpP);
  $js_def_data(o, "next", $nat("next", 0, () => (closed ? $js_gen_res(undefined, true) : next())),
    true, false, true);
  $js_def_data(o, "return", $nat("return", 0, () => {
    if (!closed) {
      closed = true;
      if (up !== undefined) $js_it_close(up);
    }
    return $js_gen_res(undefined, true);
  }), true, false, true);
  return o;
}
// 上游是真对象就按协议拿它的迭代器（惰性）；数组 / 串那些先收成数组，再按下标喂
function $js_it_src(v) {
  if ($dynTag(v) === "object") return $js_iter_proto(v);
  const xs = $js_iter(v);
  let k = 0;
  return $js_it_new(() => (k < xs.length ? $js_gen_res(xs[k++], false) : $js_gen_res(undefined, true)));
}
function $js_it_count(n, who) {
  const k = Math.trunc($js_real(n, who));
  if (!(k >= 0)) $rt_error(who + " count must not be negative");
  return k;
}
function $js_it_take(t, n) {
  let left = $js_it_count(n, "take");
  let fin = false;
  return $js_it_new(() => {
    if (fin) return $js_gen_res(undefined, true);
    if (left <= 0) { fin = true; $js_it_close(t); return $js_gen_res(undefined, true); }
    left--;
    const r = $js_it_pull(t);
    if ($js_it_done(r)) { fin = true; return $js_gen_res(undefined, true); }
    return $js_gen_res($js_it_val(r), false);
  }, t);
}
function $js_it_drop(t, n) {
  let left = $js_it_count(n, "drop");
  let fin = false;
  return $js_it_new(() => {
    if (fin) return $js_gen_res(undefined, true);
    while (left > 0) {
      left--;
      if ($js_it_done($js_it_pull(t))) { fin = true; return $js_gen_res(undefined, true); }
    }
    const r = $js_it_pull(t);
    if ($js_it_done(r)) { fin = true; return $js_gen_res(undefined, true); }
    return $js_gen_res($js_it_val(r), false);
  }, t);
}
function $js_gen_new(step) {
  const g = $js_obj_new_p($realm().genP);
  $js_def_data(g, "$stp", step, true, false, true);
  $js_def_data(g, "$gst", 0, true, false, true);
  return g;
}
function $js_gen_is(v) { return $js_isobj(v) && v.ps.has("$stp"); }
// 惰性的另外三格：回调收 (value, counter)（counter 从 0 起，与 map/filter 那批同一约定）
function $js_it_map(t, f) {
  let i = 0, fin = false;
  return $js_it_new(() => {
    if (fin) return $js_gen_res(undefined, true);
    const r = $js_it_pull(t);
    if ($js_it_done(r)) { fin = true; return $js_gen_res(undefined, true); }
    const v = $callFn(f, [$js_it_val(r), i]);
    i++;
    return $js_gen_res(v, false);
  }, t);
}
function $js_it_filter(t, f) {
  let i = 0, fin = false;
  return $js_it_new(() => {
    while (!fin) {
      const r = $js_it_pull(t);
      if ($js_it_done(r)) { fin = true; break; }
      const v = $js_it_val(r);
      const keep = $js_truthy($callFn(f, [v, i]));
      i++;
      if (keep) return $js_gen_res(v, false);
    }
    return $js_gen_res(undefined, true);
  }, t);
}
function $js_it_flat_map(t, f) {
  let i = 0, fin = false, inner = null;
  return $js_it_new(() => {
    for (;;) {
      if (fin) return $js_gen_res(undefined, true);
      if (inner !== null) {
        const ir = $js_it_pull(inner);
        if (!$js_it_done(ir)) return $js_gen_res($js_it_val(ir), false);
        inner = null;
      }
      const r = $js_it_pull(t);
      if ($js_it_done(r)) { fin = true; return $js_gen_res(undefined, true); }
      inner = $js_it_src($callFn(f, [$js_it_val(r), i]));
      i++;
    }
  }, t);
}
// 终结的那几格：就地把上游拉完，或短路（短路时关掉上游）
function $js_it_to_array(t) {
  const out = [];
  for (;;) {
    const r = $js_it_pull(t);
    if ($js_it_done(r)) return out;
    out.push($js_it_val(r));
  }
}
function $js_it_for_each(t, f) {
  let i = 0;
  for (;;) {
    const r = $js_it_pull(t);
    if ($js_it_done(r)) return undefined;
    $callFn(f, [$js_it_val(r), i]);
    i++;
  }
}
function $js_it_reduce(t, f, init) {
  let acc = init, i = 0;
  // 缺初值就拿头一个当初值（counter 于是从 1 起）；空的在规范里是 TypeError
  if (init === undefined) {
    const r0 = $js_it_pull(t);
    if ($js_it_done(r0)) $rt_error("reduce of empty iterator with no initial value");
    acc = $js_it_val(r0);
    i = 1;
  }
  for (;;) {
    const r = $js_it_pull(t);
    if ($js_it_done(r)) return acc;
    acc = $callFn(f, [acc, $js_it_val(r), i]);
    i++;
  }
}
function $js_it_some(t, f) {
  let i = 0;
  for (;;) {
    const r = $js_it_pull(t);
    if ($js_it_done(r)) return false;
    if ($js_truthy($callFn(f, [$js_it_val(r), i]))) { $js_it_close(t); return true; }
    i++;
  }
}
function $js_it_every(t, f) {
  let i = 0;
  for (;;) {
    const r = $js_it_pull(t);
    if ($js_it_done(r)) return true;
    if (!$js_truthy($callFn(f, [$js_it_val(r), i]))) { $js_it_close(t); return false; }
    i++;
  }
}
function $js_it_find(t, f) {
  let i = 0;
  for (;;) {
    const r = $js_it_pull(t);
    if ($js_it_done(r)) return undefined;
    const v = $js_it_val(r);
    if ($js_truthy($callFn(f, [v, i]))) { $js_it_close(t); return v; }
    i++;
  }
}
function $js_gen_step(g, v, mode) {
  if (!$js_gen_is(g)) $rt_error("this is not a generator");
  const st = g.ps.get("$gst").v;
  /* 没开始就 return/throw，或者已经跑完了：不进体（规范如此）。
     it.throw 在这两种情况下就是"从这儿抛出去"。 */
  if (st === 2 || (st === 0 && mode !== 0)) {
    g.ps.get("$gst").v = 2;
    if (mode === 2) { $js_throw(v); return undefined; }
    return $js_gen_res(mode === 1 ? v : undefined, true);
  }
  g.ps.get("$gst").v = 1;
  let r = $callThis(g.ps.get("$stp").v, undefined, [v, mode]);
  /* 体里抛出来的东西在挂起槽里（ADR-0007）：机器里有活着的 catch 的话，把那一格送回去
     接着跑（mode 3，见 genfn.js 的 tryCatch）。没有的话机器原样抛回来 —— 挂起槽还是满的，
     生成器就此完，让它继续往调用者那边冒。 */
  if ($js_pending()) {
    r = $callThis(g.ps.get("$stp").v, undefined, [$js_take_pending(), 2]);
    if ($js_pending()) { g.ps.get("$gst").v = 2; return undefined; }
  }
  if ($js_truthy($js_getp(r, "done", undefined))) g.ps.get("$gst").v = 2;
  return r;
}
/* async 那一半（ADR-0020 P2）：状态机是同一台，换的只是"谁来恢复它"。
   await 那一步收尾时发的是 $js_gen_awt 造的结果（多一格 $aw 标记），驱动看见它就把
   resumption 挂到 promise 的 then 上 —— 于是恢复者是**微任务**。规范里 await 花一拍
   （PromiseResolve + PerformPromiseThen），这儿正好也是一拍。 */
function $js_gen_awt(v) {
  const o = $js_gen_res(v, false);
  $js_def_data(o, "$aw", true, true, false, true);
  return o;
}
function $js_gen_is_awt(r) { return $js_isobj(r) && r.ps.has("$aw"); }
// 把一格 await 的结果接回状态机：兑现走 mode 0，拒绝走 mode 2（在体里就是抛出来）
function $js_await_then(v, resume) {
  $js_prom_react($js_promise_resolved(v),
    $nat("", 1, (t, a) => { resume(a[0], 0); return undefined; }),
    $nat("", 1, (t, a) => { resume(a[0], 2); return undefined; }));
  return undefined;
}
function $js_async_run(step) {
  const p = $js_prom_new();
  const tick = (v, mode) => {
    let r = $callThis(step, undefined, [v, mode]);
    // 体里抛出来的：有 catch / finally 接手就送回去（mode 2），没有就成了这格 promise 的 reject
    if ($js_pending()) {
      r = $callThis(step, undefined, [$js_take_pending(), 2]);
      if ($js_pending()) { $js_prom_settle(p, 2, $js_take_pending()); return undefined; }
    }
    if ($js_truthy($js_getp(r, "done", undefined))) {
      $js_prom_settle(p, 1, $js_getp(r, "value", undefined));
      return undefined;
    }
    return $js_await_then($js_getp(r, "value", undefined), tick);
  };
  // 第一段是**同步**跑的（规范如此：async 函数体一直跑到第一个 await）
  tick(undefined, 0);
  return p;
}
/* async 生成器：next() 返回一格 promise。段里两种收尾都可能出现 ——
   await 就继续驱动（不结算），yield / return 才结算这一次 next 的 promise。 */
function $js_agen_new(step) {
  const g = $js_obj_new_p($realm().agenP);
  $js_def_data(g, "$stp", step, true, false, true);
  $js_def_data(g, "$gst", 0, true, false, true);
  return g;
}
function $js_agen_step(g, v, mode) {
  if (!$js_isobj(g) || !g.ps.has("$stp")) $rt_error("this is not an async generator");
  const p = $js_prom_new();
  const st = g.ps.get("$gst").v;
  if (st === 2 || (st === 0 && mode !== 0)) {
    g.ps.get("$gst").v = 2;
    if (mode === 2) $js_prom_settle(p, 2, v);
    else $js_prom_settle(p, 1, $js_gen_res(mode === 1 ? v : undefined, true));
    return p;
  }
  g.ps.get("$gst").v = 1;
  const tick = (sv, sm) => {
    let r = $callThis(g.ps.get("$stp").v, undefined, [sv, sm]);
    // 体里抛出来的：有活着的 catch 就送回去接手，没有就成了这一次 next 的 reject
    if ($js_pending()) {
      r = $callThis(g.ps.get("$stp").v, undefined, [$js_take_pending(), 2]);
      if ($js_pending()) {
        g.ps.get("$gst").v = 2;
        $js_prom_settle(p, 2, $js_take_pending());
        return undefined;
      }
    }
    if ($js_gen_is_awt(r)) return $js_await_then($js_getp(r, "value", undefined), tick);
    const done = $js_truthy($js_getp(r, "done", undefined));
    const val = $js_getp(r, "value", undefined);
    if (done) {
      g.ps.get("$gst").v = 2;
      $js_prom_settle(p, 1, $js_gen_res(val, true));
      return undefined;
    }
    /* 规范的 AsyncGeneratorYield 先 Await 一遍让出去的值，才结算这一次 next 的 promise
       （27.6.3.8）—— 于是 async 生成器的每一圈比同步生成器**多一拍**。量出来的：
       少了这一拍，for await 的循环体会比 qjs 早两拍跑。 */
    $js_prom_react($js_promise_resolved(val),
      $nat("", 1, (t, a) => { $js_prom_settle(p, 1, $js_gen_res(a[0], false)); return undefined; }),
      $nat("", 1, (t, a) => {
        g.ps.get("$gst").v = 2;
        $js_prom_settle(p, 2, a[0]);
        return undefined;
      }));
    return undefined;
  };
  tick(v, mode);
  return p;
}
/* for await 的异步迭代协议。Symbol.asyncIterator 有就用它；没有就把同步迭代包一层
   （规范的 CreateAsyncFromSyncIterator）—— 那一层里**元素的值也要 await 一遍**，
   所以 for await (const v of [Promise.resolve(1)]) 拿到的是 1 而不是那格 promise。 */
function $js_aiter(v) {
  const f = $js_isobj(v) ? $js_getp(v, $js_sym_wk("asyncIterator"), undefined) : undefined;
  if (f !== undefined && f !== null) return $callThis(f, v, []);
  const xs = $js_iter(v);
  let i = 0;
  const o = $js_obj_new();
  $natm(o, "next", 0, () => {
    if (i >= xs.length) return $js_promise_resolved($js_gen_res(undefined, true));
    const x = xs[i];
    i += 1;
    return $js_prom_react($js_promise_resolved(x),
      $nat("", 1, (t, a) => $js_gen_res(a[0], false)), undefined);
  });
  return o;
}
function $js_aiter_next(it) {
  const f = $js_getp(it, "next", undefined);
  return $js_promise_resolved($callThis(f, it, []));
}
// Date 的隐藏槽。取到的不是数就说明接收者不是这一族的对象 —— 报一句，别悄悄算出 NaN。
function $js_date_ms(t) {
  const v = $js_isobj(t) ? $js_getp(t, "$ms", t) : undefined;
  if (typeof v !== "number") $rt_error("this is not a Date");
  return v;
}
/* new Date(v)：v 是串就**解析**（规范 21.4.2.1 第 4 步 —— ISO 那一套与宿主认的那些），
   别的先 ToNumber。从前只收毫秒数，串形态在降级那儿当场报。 */
/* TimeClip（规范 21.4.1.31）：时间值只在 ±8.64e15 毫秒之内，出了界是 NaN，不是"很大的数"。
   从前 new Date(8.64e15 + 1).getTime() 静静地把那个数原样交了出去。
   取整用 trunc（规范是 ToIntegerOrInfinity，负数往零走），-0 归 0。 */
function $js_time_clip(ms) {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return NaN;
  const t = Math.trunc(ms);
  return t === 0 ? 0 : t;
}
function $js_date_new(v) {
  const o = $js_obj_new_p($realm().dateP);
  const ms = $dynTag(v) === "string" ? Date.parse($js_asS16(v))
    : $js_time_clip($js_real($js_num_of(v), "new Date"));
  $js_def_data(o, "$ms", ms, true, false, true);
  return o;
}
/* new Date(y, mo[, d, h, mi, s, ms])：**本地时区**的那一族（规范 21.4.2.1 第 3 步）。
   缺席的格子照规范补：日是 1，别的是 0。年份 0..99 会被当 19xx（宿主如此，两把尺子一致）。 */
function $js_date_parts(y, mo, d, h, mi, s, ms) {
  const num = (v, dflt) => (v === undefined ? dflt : Math.trunc($js_real($js_num_of(v), "new Date")));
  return new Date(num(y, 1970), num(mo, 0), num(d, 1), num(h, 0), num(mi, 0), num(s, 0), num(ms, 0)).getTime();
}
// Date.parse(串)：交出毫秒（认不出来就是 NaN）
function $js_date_parse(s) { return Date.parse($js_asS16($js_str(s))); }
/* Date.UTC(y[, mo, d, h, mi, s, ms])：与 $js_date_parts 同一族，只是按 UTC 算。
   年缺席就是 NaN（规范：ToNumber(undefined) 是 NaN），别的缺席按 0/1 补。
   0..99 的年份映到 1900+y 那一条由宿主的 Date.UTC 自己管（规范 MakeFullYear）。 */
function $js_date_utc(y, mo, d, h, mi, s, ms) {
  if (y === undefined) return NaN;
  const num = (v, dflt) => (v === undefined ? dflt : Math.trunc($js_real($js_num_of(v), "Date.UTC")));
  return Date.UTC(num(y, 1970), num(mo, 0), num(d, 1), num(h, 0), num(mi, 0), num(s, 0), num(ms, 0));
}
function $js_obj_to_string(t) {
  if (t === undefined) return "[object Undefined]";
  if (t === null) return "[object Null]";
  const tag = $js_isobj(t) ? $js_getp(t, $js_sym_wk("toStringTag"), undefined) : undefined;
  if (typeof tag === "string") return "[object " + tag + "]";
  /* 规范 20.1.3.6 的 builtinTag 看的是**内部槽**；这个值域里的替身是原型链 —— Date /
     Error / Promise 造出来的那格对象自己没有 cl（都是 "Object"），认它们的原型。
     realm 还没建起来就不必建：那时候手里绝不可能有这几格原型。 */
  if ($js_isobj(t) && $R !== null) {
    for (let cur = t.pr; $js_isobj(cur); cur = cur.pr) {
      if (cur === $R.dateP) return "[object Date]";
      if (cur === $R.errP) return "[object Error]";
      if (cur === $R.promP) return "[object Promise]";
      if (cur === $R.reP) return "[object RegExp]";
    }
  }
  if ($js_isobj(t)) return "[object " + t.cl + "]";
  switch ($dynTag(t)) {
    case "list": return "[object Array]";
    case "string": return "[object String]";
    case "real": case "int": return "[object Number]";
    case "bool": return "[object Boolean]";
    case "function": return "[object Function]";
    /* 这几格在 JS 里都是对象，可在这个值域里不是"真对象"，所以照标签直说。
       WeakMap / WeakSet 就是 Map / Set（ADR-0020 P4 画的边界），因此也报 Map / Set。 */
    case "Map": return "[object Map]";
    case "Set": return "[object Set]";
    case "regexp": return "[object RegExp]";
    case "symbol": return "[object Symbol]";
    default: return "[object Object]";
  }
}
// ---- 新对象那一格的 op 面（js_abi.js 里同名的那些）
function $js_obj_new_p(proto) { return new $JSObj(proto === undefined ? $realm().objP : proto); }
/* Object.create(proto[, descs])：第二个实参那一支等于"造完再 defineProperty 一遍"（规范
   20.1.2.2 就是这么说的：ObjectDefineProperties）。descs 上只算**自有可枚举**的键，
   Symbol 键也算。从前第二个实参在降级那儿当场报 "takes at most 1 argument(s)"。 */
function $js_obj_create(proto, descs) {
  return $js_obj_defs($js_obj_new_p(proto), descs);
}
// Object.defineProperties(o, descs)：descs 上只算**自有可枚举**的键（Symbol 键也算）
function $js_obj_defs(o, descs) {
  if (descs === undefined || descs === null) return o;
  for (const k of $js_obj_own_keys("e", descs)) $js_obj_def(o, k, $js_getp(descs, k, undefined));
  for (const k of $js_obj_own_keys("y", descs)) {
    const d = $js_obj_desc(descs, k);
    if (d !== undefined && $js_truthy($js_getp(d, "enumerable", undefined))) {
      $js_obj_def(o, k, $js_getp(descs, k, undefined));
    }
  }
  return o;
}
/* [[GetPrototypeOf]]（规范 10.5.1）：代理身上先问 getPrototypeOf 陷阱。从前不问 ——
   Object.getPrototypeOf(proxy) 静静地交出**目标**的原型，陷阱一次也没被叫到。 */
function $js_obj_proto_get(o) {
  if (o !== null && typeof o === "object" && o.px !== undefined) {
    const f = $js_px_trap(o, "getPrototypeOf");
    if (f !== undefined) return $callThis(f, o.px.h, [o.px.t]);
    return $js_obj_proto_get(o.px.t);
  }
  return $js_isobj(o) ? o.pr : $js_proto_of_prim(o);
}
/* [[SetPrototypeOf]]（规范 10.1.2 / 10.5.2）：代理身上先问 setPrototypeOf 陷阱；
   不可扩展的对象上换原型是 TypeError（**能 catch**）—— 换成同一格原型不算换，
   照规范先放过。从前这儿静静地换成了。
   非对象（数与串这些）照 Object.setPrototypeOf 的规矩原样交回去，不报错。 */
function $js_obj_proto_set(o, p) {
  if (o !== null && typeof o === "object" && o.px !== undefined) {
    const f = $js_px_trap(o, "setPrototypeOf");
    if (f !== undefined) { $callThis(f, o.px.h, [o.px.t, p === undefined ? null : p]); return o; }
    $js_obj_proto_set(o.px.t, p);
    return o;
  }
  if (!$js_isobj(o)) return o;
  const want = p === undefined || p === null ? null : p;
  if (o.pr === want) return o;
  if (o.ex === false) return $js_type_err("cannot set the prototype of a non-extensible object");
  o.pr = want;
  return o;
}
/* Reflect 那三格与 Object 同名的不一样：它们交出**布尔**，而且"做不到"是 false 而不是抛
   （规范 28.1.3 / 28.1.10 / 28.1.9）。所以这儿把底下那一格的 pending 接住换成 false ——
   Object.defineProperty 那条路照旧抛。 */
function $js_reflect_def(o, k, d) {
  $js_obj_def(o, k, d);
  if ($js_pending()) { $js_take_pending(); return false; }
  return true;
}
function $js_reflect_proto_set(o, p) {
  $js_obj_proto_set(o, p);
  if ($js_pending()) { $js_take_pending(); return false; }
  return true;
}
function $js_reflect_prevent_ext(o) {
  $js_obj_prevent_ext(o);
  if ($js_pending()) { $js_take_pending(); return false; }
  return true;
}
function $js_obj_has_own(o, k) {
  if ($js_isobj(o)) return o.ps.has($js_pkey(k));
  // 数组与 dict 上也要认（Object.hasOwn(a, 0) / Object.hasOwn({1:"a"}, 1)）
  if ($dynTag(o) === "list") return $js_arr_has_key(o, $js_hkey(k));
  if ($dynTag(o) === "dict") return $js_dict_of(o).has($js_hkey(k));
  return false;
}
/* Object.getOwnPropertyNames / getOwnPropertySymbols（'s' / 'y'）。真对象以外的那几格也要
   认：数组与串在 JS 里都是对象，length 是它们的一格**自有属性**（不可枚举），下标也是。
   从前非真对象一律给空表 —— 那是悄悄的错答案（量出来的：getOwnPropertyNames([1,2,3])
   该给 0,1,2,length）。次序照规范：整数下标升序在前，然后是别的字符串键（length 是建得
   最早的那一格，所以排在旁表那些前面）。
   Symbol 那一档（'y'）在这几格上确实是空的：旁表只收字符串键。 */
function $js_obj_own_keys(kind, o) {
  if ($js_isobj(o)) return $js_own_keys(o, kind);
  if (kind !== "s") return [];
  const t = $dynTag(o);
  if (t === "list") {
    const out = $js_arr_idx_keys(o);
    out.push("length");
    const x = $js_xprops(o, false);
    if (x !== undefined) for (const k of x.keys()) if (typeof k === "string" && !$js_isidx(k)) out.push(k);
    return out;
  }
  if (t === "string") {
    const out = $js_str_idx_keys(o);
    out.push("length");
    return out;
  }
  return [];
}
// 数组的下标键（十进制串，升序）—— 与 $js_arr_own_keys 的头一段同一套
function $js_arr_idx_keys(a) {
  const l = $js_arr_of(a), out = [];
  for (let i = 0; i < l.length; i++) out.push($js_str(i));
  return out;
}
function $js_obj_freeze(o) {
  if ($js_isobj(o)) {
    o.ex = false;
    for (const [, sl] of o.ps) { sl.c = false; if (!sl.a) sl.w = false; }
  }
  return o;
}
function $js_obj_seal(o) {
  if ($js_isobj(o)) { o.ex = false; for (const [, sl] of o.ps) sl.c = false; }
  return o;
}
/* isFrozen / isSealed 只对**真对象**有意义。数组在这个值域里还不是真对象（P4 的
   array exotic 那一片），Object.freeze(数组) 是空操作 —— 所以这儿照实说"没冻住"，
   而不是跟着"不是对象就算冻住"那条走（那会让代码以为改不动了，是更危险的一边）。
   原始值照规范：冻住、封住都算。 */
function $js_obj_frozenish(o) {
  const t = $dynTag(o);
  return !(t === "list" || t === "dict" || t === "Map" || t === "Set" || t === "bytes");
}
function $js_obj_is_frozen(o) {
  if (!$js_isobj(o)) return $js_obj_frozenish(o);
  if (o.ex) return false;
  for (const [, sl] of o.ps) if (sl.c || (!sl.a && sl.w)) return false;
  return true;
}
function $js_obj_is_sealed(o) {
  if (!$js_isobj(o)) return $js_obj_frozenish(o);
  if (o.ex) return false;
  for (const [, sl] of o.ps) if (sl.c) return false;
  return true;
}
/* isExtensible / preventExtensions（规范 10.5.3 / 10.5.4）：代理身上先问陷阱。
   从前不问 —— Object.isExtensible(proxy) 静静地报的是**目标**那一格。 */
function $js_obj_prevent_ext(o) {
  if (o !== null && typeof o === "object" && o.px !== undefined) {
    const f = $js_px_trap(o, "preventExtensions");
    if (f !== undefined) { $callThis(f, o.px.h, [o.px.t]); return o; }
    $js_obj_prevent_ext(o.px.t);
    return o;
  }
  if ($js_isobj(o)) o.ex = false;
  return o;
}
// 数组 / Map / Set 还不是真对象，但它们**确实**还能往上加东西 —— 照实说"可扩展"
// （与 isFrozen / isSealed 那两格同一口径，见 $js_obj_frozenish）
function $js_obj_is_ext(o) {
  if (o !== null && typeof o === "object" && o.px !== undefined) {
    const f = $js_px_trap(o, "isExtensible");
    if (f !== undefined) return $js_truthy($callThis(f, o.px.h, [o.px.t]));
    return $js_obj_is_ext(o.px.t);
  }
  return $js_isobj(o) ? o.ex : !$js_obj_frozenish(o);
}
// defineProperty。desc 是一格真对象；缺席的字段照规范取 false/undefined。
// 已有槽的时候只覆盖 desc 里**出现过**的字段（规范 ValidateAndApplyPropertyDescriptor）。
/* 数组上的 defineProperty，只收能原样表达的那一种（理由见 $js_obj_def 的第一段注）。
   要留神**新键的默认是 false**：Object.defineProperty(a, "tag", { value: v }) 建出来的那一格
   在 JS 里是不可枚举的（qjs 的 Object.keys(a) 因此看不见它），而旁表没有这一层 ——
   所以新键必须把 enumerable 明写成 true 才收，否则当场报。已有的键则是"缺的字段保持原样"，
   旁表那一格本来就是可枚举的，于是 { value } 一种就够。 */
function $js_arr_def(a, k, desc) {
  const has = (n) => $js_isobj(desc) && desc.ps.has(n);
  const bad = (n) => has(n) && !$js_truthy($js_getp(desc, n, undefined));
  if (has("get") || has("set")) {
    $rt_error("defineProperty: an accessor on an array needs a real object");
  }
  if (bad("writable") || bad("enumerable") || bad("configurable")) {
    $rt_error("defineProperty: a non-default writable/enumerable/configurable on an array"
      + " cannot be represented");
  }
  const key = $js_hkey(k);
  const v = has("value") ? $js_getp(desc, "value", undefined) : undefined;
  if ($js_isidx(key)) {
    const i = Number(key);
    if (i >= $js_arr_of(a).length) {
      $rt_error("defineProperty: index " + i + " is past the end of the array; push instead");
    }
    if (has("value")) $js_arr_set(a, i, v);
    return a;
  }
  // length 是"截断/加长"，不是旁表里的一格 —— 写过去只会造一格看不见的影子
  if (key === "length") $rt_error("defineProperty: 'length' of an array is not settable here");
  if (!$js_obj_has(a, key) && !(has("enumerable") && $js_truthy($js_getp(desc, "enumerable", undefined)))) {
    $rt_error("defineProperty: a new non-enumerable key on an array cannot be represented"
      + " (pass enumerable: true, or assign it)");
  }
  $js_obj_set(a, key, v);
  return a;
}
function $js_obj_def(o, k, desc) {
  /* 数组上的 defineProperty（ADR-0020）：list 是一排稠密的 dyn + 一张旁表，**没有描述符
     这一层**，所以只收"能原样表达出来"的那一种形状：下标在长度里、数据描述符、三个位
     都是 true（缺省就按已有那一格算 —— 数组元素本来就是可写可枚举可配置的）。
     那一种正好就是 a[i] = v。别的（writable/enumerable/configurable 里有 false、访问器、
     下标越过长度）**当场报**：写进去只能对上一半，那是悄悄的错答案。
     从前整支落在 "defineProperty on list" 上，连 { value } 这一种也不收。 */
  if ($dynTag(o) === "list") return $js_arr_def(o, k, desc);
  if (!$js_isobj(o)) $rt_error("defineProperty on " + $dynTag(o));
  /* defineProperty 陷阱（ADR-0020）：没有陷阱就落到目标上 —— 不这么做的话
     Object.defineProperty(代理, …) 会把那一格写在代理对象自己身上，读回来又走陷阱到目标。 */
  if (o.px !== undefined) {
    const f = $js_px_trap(o, "defineProperty");
    if (f === undefined) return $js_obj_def(o.px.t, k, desc);
    $callThis(f, o.px.h, [o.px.t, $js_pkey(k), desc]);
    return o;
  }
  const key = $js_pkey(k);
  const has = (n) => $js_isobj(desc) && desc.ps.has(n);
  const get = (n) => $js_getp(desc, n, undefined);
  const old = o.ps.get(key);
  const isAcc = has("get") || has("set");
  if (old === undefined) {
    if (!o.ex) return $js_type_err("object is not extensible");
    if (isAcc) {
      o.ps.set(key, new $Slot(true, undefined, has("get") ? get("get") : undefined,
        has("set") ? get("set") : undefined, false, has("enumerable") ? $js_truthy(get("enumerable")) : false,
        has("configurable") ? $js_truthy(get("configurable")) : false));
    } else {
      o.ps.set(key, new $Slot(false, has("value") ? get("value") : undefined, undefined, undefined,
        has("writable") ? $js_truthy(get("writable")) : false,
        has("enumerable") ? $js_truthy(get("enumerable")) : false,
        has("configurable") ? $js_truthy(get("configurable")) : false));
    }
    return o;
  }
  /* 不可配置的槽上能改什么（规范 10.1.6.3 ValidateAndApplyPropertyDescriptor）：
     只有"可写的数据属性改 value / 把 writable 降成 false"这两样。别的一律 TypeError ——
     从前这儿只挡了 configurable 与 enumerable 两格，于是 defineProperty 在一个
     不可配置不可写的属性上改 value **静静地改成了**（量出来的：qjs 抛 TypeError）。 */
  if (!old.c) {
    if (has("configurable") && $js_truthy(get("configurable"))) {
      return $js_type_err("cannot redefine property");
    }
    if (has("enumerable") && $js_truthy(get("enumerable")) !== old.e) {
      return $js_type_err("cannot redefine property");
    }
    // 数据 <-> 访问器的互换在不可配置的槽上不许
    if (isAcc !== old.a && (isAcc || has("value") || has("writable"))) {
      return $js_type_err("cannot redefine property");
    }
    if (!old.a && !old.w) {
      if (has("writable") && $js_truthy(get("writable"))) {
        return $js_type_err("cannot redefine property");
      }
      if (has("value") && !Object.is(get("value"), old.v)) {
        return $js_type_err("cannot redefine property");
      }
    }
    if (old.a) {
      if (has("get") && !Object.is(get("get"), old.g)) return $js_type_err("cannot redefine property");
      if (has("set") && !Object.is(get("set"), old.s)) return $js_type_err("cannot redefine property");
    }
  }
  if (isAcc) {
    old.a = true;
    old.v = undefined;
    if (has("get")) old.g = get("get");
    if (has("set")) old.s = get("set");
  } else if (has("value") || has("writable")) {
    old.a = false;
    old.g = undefined;
    old.s = undefined;
    if (has("value")) old.v = get("value");
    if (has("writable")) old.w = $js_truthy(get("writable"));
  }
  if (has("enumerable")) old.e = $js_truthy(get("enumerable"));
  if (has("configurable")) old.c = $js_truthy(get("configurable"));
  return o;
}
/* 陷阱交回来的描述符补齐（规范 6.2.6.6 CompletePropertyDescriptor）：不是对象就当"没有"；
   有 get/set 的是访问器描述符（补另一格），否则是数据描述符（补 value / writable）；
   两边都补 enumerable / configurable，缺的一律 false。 */
function $js_desc_complete(d) {
  if (!$js_isobj(d)) return undefined;
  const g = $js_getp(d, "get", undefined), s = $js_getp(d, "set", undefined);
  const out = $js_obj_new_p(undefined);
  if (g !== undefined || s !== undefined) {
    $js_def_data(out, "get", g, true, true, true);
    $js_def_data(out, "set", s, true, true, true);
  } else {
    $js_def_data(out, "value", $js_getp(d, "value", undefined), true, true, true);
    $js_def_data(out, "writable", $js_truthy($js_getp(d, "writable", undefined)), true, true, true);
  }
  $js_def_data(out, "enumerable", $js_truthy($js_getp(d, "enumerable", undefined)), true, true, true);
  $js_def_data(out, "configurable", $js_truthy($js_getp(d, "configurable", undefined)), true, true, true);
  return out;
}
function $js_obj_desc(o, k) {
  /* 数组与字符串上的描述符：下标那几格是"可写、可枚举、可配置"的数据属性，length 是
     可写但**不可枚举、不可配置**（规范 10.4.2.1；字符串上下标与 length 都是只读、
     不可配置）。旁表里挂的名字算普通数据属性。从前这一支一律给 undefined，于是
     Object.getOwnPropertyDescriptor([1], "0").value 当场炸（量出来的）。 */
  const t = $dynTag(o);
  if (t === "list" || t === "string") {
    const key = $js_pkey(k);
    const len = t === "list" ? o.length : $js_asS16(o).length;
    const mk = (v, w, e, c) => {
      const d = $js_obj_new_p(undefined);
      $js_def_data(d, "value", v, true, true, true);
      $js_def_data(d, "writable", w, true, true, true);
      $js_def_data(d, "enumerable", e, true, true, true);
      $js_def_data(d, "configurable", c, true, true, true);
      return d;
    };
    if (key === "length") return mk(len, t === "list", false, false);
    if (typeof key === "string" && $js_isidx(key)) {
      const i = Number(key);
      if (i >= len) return undefined;
      return t === "list" ? mk(o[i], true, true, true) : mk($js_asS16(o)[i], false, true, false);
    }
    if (t === "list") {
      const x = $js_xprops(o, false);
      if (x !== undefined && x.has(key)) return mk(x.get(key), true, true, true);
    }
    return undefined;
  }
  if (!$js_isobj(o)) return undefined;
  /* getOwnPropertyDescriptor 陷阱（ADR-0020）：陷阱交回来的描述符还要**补齐**
     （规范 6.2.6.6 CompletePropertyDescriptor：数据描述符补 value/writable、访问器补
     get/set，两边都补 enumerable/configurable，缺的都当 false）。从前这一格不问陷阱，
     于是 Object.getOwnPropertyDescriptor(代理, k) 悄悄给出目标上的那一格（或 undefined）。 */
  if (o.px !== undefined) {
    const f = $js_px_trap(o, "getOwnPropertyDescriptor");
    if (f === undefined) return $js_obj_desc(o.px.t, k);
    return $js_desc_complete($callThis(f, o.px.h, [o.px.t, $js_pkey(k)]));
  }
  const sl = o.ps.get($js_pkey(k));
  if (sl === undefined) return undefined;
  const d = $js_obj_new_p(undefined);
  if (sl.a) {
    $js_def_data(d, "get", sl.g, true, true, true);
    $js_def_data(d, "set", sl.s, true, true, true);
  } else {
    $js_def_data(d, "value", sl.v, true, true, true);
    $js_def_data(d, "writable", sl.w, true, true, true);
  }
  $js_def_data(d, "enumerable", sl.e, true, true, true);
  $js_def_data(d, "configurable", sl.c, true, true, true);
  return d;
}
function $js_obj_del_p(o, k) {  if (!$js_isobj(o)) return true;
  if (o.px !== undefined) {
    const f = $js_px_trap(o, "deleteProperty");
    return f === undefined ? $js_obj_del_p(o.px.t, k)
      : $js_truthy($callThis(f, o.px.h, [o.px.t, $js_pkey(k)]));
  }
  const key = $js_pkey(k), sl = o.ps.get(key);
  if (sl === undefined) return true;
  if (!sl.c) return false;
  o.ps.delete(key);
  return true;
}
function $js_obj_has_p(o, k) {
  if (!$js_isobj(o)) return $js_prim_get(o, k) !== undefined;
  if (o.px !== undefined) {
    const f = $js_px_trap(o, "has");
    return f === undefined ? $js_obj_has_p(o.px.t, k)
      : $js_truthy($callThis(f, o.px.h, [o.px.t, $js_pkey(k)]));
  }
  return $js_find_slot(o, $js_pkey(k)) !== null;
}
// Object.fromEntries：走一遍迭代（数组、Map、自定义可迭代对象都收），每一项按 [k, v] 取。
function $js_obj_from_entries(pairs) {
  const o = $js_obj_new();
  for (const p of $js_iter(pairs)) $js_setp(o, $js_idx_get(p, 0), $js_idx_get(p, 1));
  return o;
}
function $js_global_this() { return $realm().gt; }
function $js_realm_proto(name) {
  const r = $realm();
  switch (name) {
    case "Object": return r.objP;
    case "Function": return r.funP;
    case "Array": return r.arrP;
    case "String": return r.strP;
    case "Number": return r.numP;
    case "Boolean": return r.boolP;
    case "Symbol": return r.symP;
    case "Error": return r.errP;
    case "Map": return r.mapP;
    case "Set": return r.setP;
    case "RegExp": return r.reP;
    case "Iterator": return r.iterP;
    case "Date": return r.dateP;
    default: $rt_error("no such builtin prototype: " + name);
  }
}
// instanceof：走原型链，先问 Symbol.hasInstance。
function $js_instanceof(v, ctor) {
  const hi = $js_isobj(ctor) ? $js_getp(ctor, $js_sym_wk("hasInstance"), undefined) : undefined;
  if (hi !== undefined && hi !== null) return $js_truthy($callThis(hi, ctor, [v]));
  // 普通函数当构造器（ADR-0020）：它的 prototype 在 side table 上，不在属性表里
  const proto = $js_isobj(ctor) ? $js_getp(ctor, "prototype", undefined)
    : ($dynTag(ctor) === "function" ? $js_fn_proto(ctor) : undefined);
  if (!$js_isobj(proto)) $rt_error("right-hand side of 'instanceof' is not callable");
  /* 走链那一步与静态那条路（js_instanceof_p）共用一份 —— 数组 / Map / Set / 正则这些在 JS
     里都是对象，可在这个值域里不是"真对象"，起点得从 $js_proto_of_prim 取。从前这儿只认
     真对象，于是 [] instanceof A（A 是取出来的 Array 构造器）静静地给 false。 */
  return $js_instanceof_p(v, proto);
}
/* x instanceof Object / Array / …（ADR-0020）：右边给的是 realm 上那一格 prototype 本身
   （那些构造器在这个值域里取不出函数值来）。原始值一律为假 —— 规范如此：
   1 instanceof Number 是 false。数组、Map、正则那些"不是 $JSObj 但有原型"的值从
   $js_proto_of_prim 起步走链，所以 [] instanceof Array / Object 都是真。 */
function $js_instanceof_p(v, proto) {
  const t = $dynTag(v);
  let cur = null;
  if (t === "object") cur = $js_obj_proto_get(v);
  else if (t === "list" || t === "dict" || t === "Map" || t === "Set" || t === "regexp"
    || t === "bytes" || t === "function" || t === "TextEncoder") cur = $js_proto_of_prim(v);
  else return false;
  /* 每一跳都走 $js_obj_proto_get，代理身上的 getPrototypeOf 陷阱才算得上 ——
     从前直接读 .pr，带 getPrototypeOf 陷阱的代理 instanceof Array 静静地给 false。 */
  while (cur !== null && cur !== undefined) {
    if (cur === proto) return true;
    cur = $js_isobj(cur) ? $js_obj_proto_get(cur) : null;
  }
  return false;
}
// 迭代器协议。iterProto 那一格是给内建迭代器用的；这一条是"按协议驱动一个对象"。
function $js_iter_proto(v) {
  const f = $js_isobj(v) ? $js_getp(v, $js_sym_wk("iterator"), undefined) : $js_prim_get(v, $js_sym_wk("iterator"));
  // 规范 7.4.2：没有 Symbol.iterator 是 TypeError，能 catch（从前是硬错）
  if (f === undefined || f === null) return $js_type_err("value is not iterable");
  return $callThis(f, v, []);
}
function $js_iter_next(it) {
  const f = $js_getp(it, "next", undefined);
  const r = $callThis(f, it, []);
  // 规范 7.4.4：next 交出来的不是对象是 TypeError，能 catch（从前是硬错）
  if (!$js_isobj(r)) return $js_type_err("iterator result is not an object");
  return r;
}
// ToPrimitive（hint: 'n' number / 's' string / 'd' default）。Symbol.toPrimitive 优先，
// 然后按 hint 试 valueOf/toString 两轮 —— 次序就是规范 OrdinaryToPrimitive。
function $js_to_prim(hint, v) {
  if (!$js_isobj(v)) return v;
  const f = $js_getp(v, $js_sym_wk("toPrimitive"), undefined);
  if (f !== undefined && f !== null) {
    const h = hint === "n" ? "number" : hint === "s" ? "string" : "default";
    const r = $callThis(f, v, [h]);
    if (!$js_isobj(r)) return r;
    $rt_error("Symbol.toPrimitive returned an object");
  }
  const names = hint === "s" ? ["toString", "valueOf"] : ["valueOf", "toString"];
  for (const n of names) {
    const m = $js_getp(v, n, undefined);
    if (m === undefined || m === null) continue;
    const r = $callThis(m, v, []);
    if (!$js_isobj(r)) return r;
  }
  $rt_error("cannot convert an object to a primitive value");
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
// clear：整格清空，交出 undefined（规范 24.1.3.1）
function $js_map_clear(m) { $js_map_of(m).clear(); }
function $js_map_keys(m) { return [...$js_map_of(m).values()].map((p) => p[0]); }
function $js_map_values(m) { return [...$js_map_of(m).values()].map((p) => p[1]); }
/* Map 的 entries（也是 for-of / 展开走的那一条）：交出来的每一格都是**新的**两元数组 ——
   内部存的那一格不能漏出去，不然往那一格上写会改到 Map 自己（量出来的：两把尺子上
   两次展开取到的第一格互不相等，我们从前是同一格）。 */
function $js_map_entries(m) { return [...$js_map_of(m).values()].map((p) => [p[0], p[1]]); }
/* Map / Set 的 forEach：回调收 (value, key, map) 与 (value, value, set)（规范 24.1.3.5
   与 24.2.3.6 —— Set 那边两格都是元素本身）。从前整族缺失，m.forEach(...) 在运行期
   报 "undefined is not a function"。 */
function $js_map_for_each(m, f) {
  for (const e of [...$js_map_of(m).values()]) $js_call3(f, e[1], e[0], m);
}

function $js_set_new() { return new $JsSet(); }
function $js_set_size(s) { return $js_set_of(s).size; }
function $js_set_has(s, v) { return $js_set_of(s).has($js_key(v)); }
function $js_set_add(s, v) { $js_set_of(s).set($js_key(v), v); return s; }
function $js_set_delete(s, v) { return $js_set_of(s).delete($js_key(v)); }
// clear：整格清空，交出 undefined（规范 24.2.3.2）
function $js_set_clear(s) { $js_set_of(s).clear(); }
function $js_set_items(s) { return [...$js_set_of(s).values()]; }
function $js_set_for_each(s, f) {
  for (const v of [...$js_set_of(s).values()]) $js_call3(f, v, v, s);
}
// Set 的 entries()：每格是 [v, v]（规范 24.2.3.5 —— 键与值都是元素本身）
function $js_set_entries(s) { return [...$js_set_of(s).values()].map((v) => [v, v]); }
/* Set 的集合运算（ES2025）。实参只认**真 Set**（qjs 那边非 set-like 是 TypeError，
   这个值域里没有可 catch 的错，所以由 $js_set_of 当场报）。次序照规范量过的那样：
     union            先 this 的次序，再把 other 里新的接在后面
     intersection     走**小的那个**，结果次序跟着它（所以 a∩b 与 b∩a 次序一致）
     difference       this 的次序减去 other 里有的
     symmetricDifference  先 this 独有的（this 次序），再 other 独有的（other 次序） */
function $js_set_union(a, b) {
  const out = $js_set_of_list($js_set_items(a));
  const ys = $js_set_items(b);
  for (let i = 0; i < ys.length; i++) $js_set_add(out, ys[i]);
  return out;
}
function $js_set_intersection(a, b) {
  const aFirst = $js_set_size(a) <= $js_set_size(b);
  const xs = $js_set_items(aFirst ? a : b);
  const other = aFirst ? b : a;
  const out = $js_set_new();
  for (let i = 0; i < xs.length; i++) if ($js_set_has(other, xs[i])) $js_set_add(out, xs[i]);
  return out;
}
function $js_set_difference(a, b) {
  const xs = $js_set_items(a);
  const out = $js_set_new();
  for (let i = 0; i < xs.length; i++) if (!$js_set_has(b, xs[i])) $js_set_add(out, xs[i]);
  return out;
}
function $js_set_sym_difference(a, b) {
  const out = $js_set_difference(a, b);
  const ys = $js_set_items(b);
  for (let i = 0; i < ys.length; i++) if (!$js_set_has(a, ys[i])) $js_set_add(out, ys[i]);
  return out;
}
function $js_set_is_subset(a, b) {
  if ($js_set_size(a) > $js_set_size(b)) return false;
  const xs = $js_set_items(a);
  for (let i = 0; i < xs.length; i++) if (!$js_set_has(b, xs[i])) return false;
  return true;
}
function $js_set_is_superset(a, b) { return $js_set_is_subset(b, a); }
function $js_set_is_disjoint(a, b) {
  const aFirst = $js_set_size(a) <= $js_set_size(b);
  const xs = $js_set_items(aFirst ? a : b);
  const other = aFirst ? b : a;
  for (let i = 0; i < xs.length; i++) if ($js_set_has(other, xs[i])) return false;
  return true;
}
// new Map(pairs) / new Set(items)。初值收 list，**也收同类容器**—— new Map(m)
// 与 new Set(s) 是这套编译器自己最常用的浅拷贝（量到三十多处），不能不认。
// JS 的可迭代协议整体不在这个值域里，所以别的类型仍然报错；缺参数就是空容器。
function $js_map_of_pairs(init) {
  const m = $js_map_new();
  if (init === undefined) return m;
  const src = $dynTag(init) === "Map" ? $js_map_entries(init) : $js_arr_of(init);
  for (const p of src) $js_map_set(m, $js_arr_get(p, 0), $js_arr_get(p, 1));
  return m;
}
function $js_set_of_list(init) {
  const s = $js_set_new();
  if (init === undefined) return s;
  // 初值收任何可迭代的东西（规范 24.2.1.1）：字符串按码点、Set / Map 按它们的次序
  const src = $js_iter(init);
  for (const v of src) $js_set_add(s, v);
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
// isSafeInteger：整数**且**绝对值不超过 2^53-1（超出那一档 double 上相邻两数差 2）
function $js_num_is_safe_integer(v) { return $dynTag(v) === "real" && Number.isSafeInteger(v); }
/* **全局的** isNaN / isFinite：先 ToNumber，再问那一格（isNaN("x") 是 true、
   isFinite("3") 是 true）。与 Number 上那两格不是一回事，所以各占一格 op。 */
function $js_global_is_nan(v) { return $js_num_is_nan($js_num_of(v)); }
function $js_global_is_finite(v) { return $js_num_is_finite($js_num_of(v)); }
function $js_num_of(v) {
  switch ($dynTag(v)) {
    case "real": return v;
    case "int": return Number(v);
    case "bool": return v ? 1 : 0;
    case "null": return 0;
    case "undefined": return NaN;
    case "string": return Number(v);
    // 对象与数组：先 ToPrimitive（hint number）再转（ADR-0020 P1）。一元加号走的就是这儿。
    case "object": case "list": return $js_num_of($js_prim("n", v));
    default: $rt_error("cannot convert " + $dynTag(v) + " to a number");
  }
}
// JS 的 StringToBigInt。刻意**不**走 $int_of_string：那是 Omni 的 int(string) 语义
// （只认十进制），而 BigInt("0xf0") 在 JS 里是 240n —— 编译器自己的 js 词法器就靠它
// 读十六进制的 bigint 字面量。收的范围是 [INT64_MIN, UINT64_MAX]：正的那半超过
// INT64_MAX 就落到无符号那一格（决策 19），jancy 的 0xffffffffffffffff 要能读出来；
// 再往外报错。
function $js_str_to_int(s) {
  const t = $js_asS16(s).trim();
  if (!/^([+-]?[0-9]+|0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+)$/.test(t)) {
    $rt_error('invalid integer: "' + s + '"');
  }
  const v = BigInt(t);
  if (v < $INT_MIN || v > 18446744073709551615n) $rt_error('invalid integer: "' + s + '"');
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
// BigInt.asIntN / BigInt.asUintN。宽度收 0..64：这个值域里的 int 是 int64
// （ADR-0005），宽度超过 64 的结果装不下，当场报错比悄悄算错好。
// asUintN 在 JS 这边直接就是宿主的那一个（BigInt 无界）；C 侧结果落在
// [2^63, 2^64) 时用 OMNI_DYN_UINT 那个标签装。错误文本两侧逐字相同。
function $js_bits(bits, who) {
  const n = $js_real(bits, who);
  if (!Number.isInteger(n) || n < 0 || n > 64) {
    $rt_error(who + ": width must be an integer in 0..64, got " + n);
  }
  return n;
}
function $js_bigint_as_int_n(bits, v) {
  const n = $js_bits(bits, "BigInt.asIntN");
  if ($dynTag(v) !== "int") $rt_error("BigInt.asIntN expects a bigint, found " + $dynTag(v));
  return BigInt.asIntN(n, v);
}
function $js_bigint_as_uint_n(bits, v) {
  const n = $js_bits(bits, "BigInt.asUintN");
  if ($dynTag(v) !== "int") $rt_error("BigInt.asUintN expects a bigint, found " + $dynTag(v));
  return BigInt.asUintN(n, v);
}
function $js_num_to_precision(v, digits) {
  const p = $js_real(digits, "toPrecision");
  if (p < 1 || p > 100) return $js_range_err("toPrecision() argument must be between 1 and 100, got " + p);
  return $js_real(v, "toPrecision").toPrecision(p);
}
/* toFixed / toExponential：转手宿主的同名方法即是规范。**只有 JS 这一侧** —— 它们在
   恰好一半上进位（1.5.toFixed(0) 是 "2"、2.5 是 "3"），而 C 的 %.Nf 就近取偶（2.5 给
   "2"），要在 C 里对上得走十进制那条路（见 interp/libc.js 里那段量口）。所以这两格
   进 P1_JS_ONLY：C 那条腿当场报错，不给一个"多数时候对"的答案。 */
function $js_num_to_fixed(v, digits) {
  const d = digits === undefined ? 0 : $js_real(digits, "toFixed");
  if (d < 0 || d > 100) return $js_range_err("toFixed() argument must be between 0 and 100, got " + d);
  return $js_real(v, "toFixed").toFixed(d);
}
function $js_num_to_exp(v, digits) {
  const x = $js_real(v, "toExponential");
  if (digits === undefined) return x.toExponential();
  const d = $js_real(digits, "toExponential");
  if (d < 0 || d > 100) return $js_range_err("toExponential() argument must be between 0 and 100, got " + d);
  return x.toExponential(d);
}
function $js_num_to_string(v, radix) {
  const r = radix === undefined ? 10 : $js_real(radix, "toString");
  if (r < 2 || r > 36) return $js_range_err("toString() radix must be between 2 and 36, got " + r);
  /* 接收者也可能是 int（这个值域里的 bigint）或 bool。int 不先转 double：2^53 之上的
     int64 转过去要掉精度，而 bigint 自己就会按位印。 */
  const t = $dynTag(v);
  if (t === "bool") return $js_str(v);
  if (t === "int") return r === 10 ? $js_str(v) : v.toString(r);
  const x = $js_real(v, "toString");
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
  /* JS 的 Math.round（'R'）：floor(x) 再看小数部分够不够 0.5 —— **不写 floor(x + 0.5)**，
     那一条在 0.49999999999999994 上会给 1（加法先舍到了 0.5）。结果是 0 而 x 又是负数
     （含 -0）时要给 **-0**，规范如此，量过：Math.round(-0.5) 是 -0。 */
  if (op === "R") {
    if (!Number.isFinite(x)) return x;
    const fl = Math.floor(x);
    const r = x - fl < 0.5 ? fl : fl + 1;
    return r === 0 && (x < 0 || Object.is(x, -0)) ? -0 : r;
  }
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
  if (op === "w") return Math.log2(x);
  if (op === "P") return Math.log1p(x);
  /* sign：NaN 给 NaN、-0 给 -0、0 给 0 —— 所以不能写 x > 0 ? 1 : -1，零那一格要原样送回 */
  if (op === "g") return Math.sign(x);
  if (op === "B") return Math.cbrt(x);
  if (op === "F") return Math.fround(x);
  // clz32：先 ToUint32 再数前导零（Math.clz32 自己就做这一步转换）
  if (op === "Z") return Math.clz32(x);
  const y = $js_real(b, "Math");
  if (op === "M") return Math.max(x, y);
  if (op === "m") return Math.min(x, y);
  if (op === "p") return Math.pow(x, y);
  if (op === "o") return x % y;   // JS 的 % 在 number 上就是 C 的 fmod
  if (op === "2") return Math.atan2(x, y);
  if (op === "Y") return Math.hypot(x, y);
  /* nextafter（ADR-0019 路 2）—— Math.* 里**没有**它，所以这一处是手写的，不是像上面
     那些一样转手宿主。权威是 C 的 nextafter（omni_math.c 与 omni_js_num.c 的 'W'），
     这一份要与它逐字节对上；能这么要求是因为它是**精确运算**（IEEE-754 5.3.1 的
     nextUp/nextDown），与超越函数那一档（只保证容差）不同。

     位模式的把戏：把 f64 当**有符号** i64 读。x > 0 时位模式加一就是往 +inf 挪一格；
     x < 0 时符号位已经置上，位模式加一是 |x| 变大、也就是往 -inf 挪。于是方向是
     (y > x) === (x > 0) ? +1 : -1。x 是 0 要单列 —— ±0 往两侧都跳到最小非正规数。

     注意：这个文件整体是一段**模板字面量**，所以注释里一个反引号都不能有。 */
  if (op === "W") {
    if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
    if (x === y) return y;
    if (x === 0) return y > 0 ? 5e-324 : -5e-324;
    const ndv = new DataView(new ArrayBuffer(8));
    ndv.setFloat64(0, x);
    ndv.setBigInt64(0, ndv.getBigInt64(0) + (((y > x) === (x > 0)) ? 1n : -1n));
    return ndv.getFloat64(0);
  }
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
const $r_nextafter = (x, y) => $js_math("W", x, y);
/* fma —— 交集的第二条例外（ADR-0014 第十五节）。Math.* 里没有它，所以这一份是手写的，
   不像上面那些转手宿主。权威是 C 的 omni_r_fma（libm，一条 fmadd）；能要求逐字节是因为
   fma 是精确运算（IEEE-754 5.4.1 只舍一次）。
   做法：Dekker 拆分求准确积（p + e == a*b），再 two-sum 收回 p+c 的尾巴 t，
   最后 s + (t + e) 只舍一次。
   **溢出那一档退回朴素式** a*b + c：Dekker 的拆分在 |a*b| 溢出时算的是 inf - inf = nan，
   而真 fma 是"先精确、再舍一次"，1e400 舍出来就是 inf。踩过的原形：abs((1e200,1e200))
   （asy__pabs = sqrt(fma(y,y,x*x))）在 asy 与 run-c/run-llvm 上都是 inf，这条腿从前出 nan
   （tests/asy/cases/10-pairs）。朴素式在这一档是对的：|a*b| 已经超出 realMax，
   再加一个有限的 c 也还在那之上，舍出来仍是 inf。
   次正规上 e 会损失那一条照旧留着（与硬件 fma 不一致，要它的场合都在正常量级里）。
   这份文件是 String.raw 模板，注释里**不许出现反引号**。 */
const $r_fma = (a, b, c) => {
  const p = a * b;
  if (!Number.isFinite(p) || !Number.isFinite(c)) return p + c;
  const SPLIT = 134217729;
  const ca = SPLIT * a, ah = ca - (ca - a), al = a - ah;
  const cb = SPLIT * b, bh = cb - (cb - b), bl = b - bh;
  const e = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
  const s = p + c, bs = s - p;
  const t = (p - (s - bs)) + (c - bs);
  const r = s + (t + e);
  // SPLIT * a 在 |a| 接近 realMax 时也会溢出（真积却可能是有限的），那时 e 是 nan、
  // 结果被污染。这一档同样退回朴素式 —— 精度差一位，但不会把有限值变成 nan。
  return Number.isNaN(r) && !Number.isNaN(s) ? s : r;
};

// ------------------------------------------------- JSON.stringify（ADR-0011）
// 不能直接用宿主的 JSON.stringify：这边的对象是 Map、int 是 BigInt，宿主会当成
// 普通对象序列化成 {} 并且在 BigInt 上抛 TypeError。所以照 C 侧同一套走一遍。
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
  // replacer 只有**函数**形态才调；null 与 undefined 都是"没给"（JSON.stringify(o, null, 2)
  // 是最常见的写法，从前 null 会掉进 $callFn 里报 "call of a null function value"）。
  return $dynTag(rep) === "function" ? $callFn(rep, [key, v]) : v;
}
/* replacer 的**数组**形态（白名单，规范 25.5.2.2 的 PropertyList）：只留名单里的键，
   而且**按名单的次序**输出 —— 两把尺子量过都是这样。数字条目按它的串形算，重复的只留
   第一次，别的类型（null / true / 对象）忽略；数组接收者不受影响。 */
function $js_json_list(rep) {
  if ($dynTag(rep) !== "list") return undefined;
  const src = $js_arr_of(rep), out = [];
  for (let i = 0; i < src.length; i++) {
    const x = src[i], t = $dynTag(x);
    if (t !== "string" && t !== "real") continue;
    const k = $js_str(x);
    if (!out.includes(k)) out.push(k);
  }
  return out;
}
function $js_json_nl(gap, depth) { return gap === "" ? "" : "\n" + gap.repeat(depth); }
// undefined 与函数值"该省略"：在对象里跳过、在数组里变成 null。用 undefined 当哨兵。
// toJSON（规范 SerializeJSONProperty 第 2 步）：对象身上有可调用的 toJSON 就先换成它的
// 返回值 —— Date 的序列化就是这么来的。与规范差的一格：规范里 toJSON 在 replacer
// **之前**，这里在之后（replacer 在调用方那一层），两样都给的时候次序不同。
function $js_json_val(v, rep, gap, depth, seen) {
  if ($js_isobj(v)) {
    const tj = $js_getp(v, "toJSON", undefined);
    if ($dynTag(tj) === "function") v = $callThis(tj, v, []);
  } else if ($dynTag(v) === "dict") {
    const tj = $js_obj_get(v, "toJSON");
    if ($dynTag(tj) === "function") v = $callThis(tj, v, []);
  }
  const t = $dynTag(v);
  // undefined / 函数 / Symbol 都"不产生任何文本"：在对象里是**跳过这一格**，
  // 在数组里落成 null，顶层就是 undefined（规范 25.5.2.2 第 11 步）
  if (t === "undefined" || t === "function" || t === "symbol") return undefined;
  /* 类对象在 JS 里**是函数**，JSON.stringify(SomeClass) 于是是 undefined。这个值域里类是
     一格真对象，靠它身上那格符号键（omni.classInit，见 lower.js 的 classInitKey）认出来 ——
     从前印的是 {}（量出来的静默分叉）。 */
  if (t === "object" && $js_getp(v, $js_sym_wk("omni.classInit"), undefined) !== undefined) {
    return undefined;
  }
  if (t === "null") return "null";
  if (t === "bool") return v ? "true" : "false";
  if (t === "real") return Number.isFinite(v) ? $js_str(v) : "null";
  if (t === "string") return $js_json_quote(v);
  if (t === "int") throw new $HostBad("do not know how to serialize a bigint", "TypeError");
  /* 环（o.self = o）：规范抛 TypeError。从前这儿一路递归下去，把**宿主的栈**撑爆 ——
     那是崩，比错答案还糟。seen 是一条**当前路径上的**容器栈（不是"见过的全部"）：
     同一格对象出现在兄弟位置上是合法的（{a: x, b: x}），只有出现在自己的祖先里才是环。 */
  if (t === "list" || t === "dict" || t === "object" || t === "Map" || t === "Set") {
    if (seen.indexOf(v) >= 0) throw new $HostBad("circular structure in JSON", "TypeError");
    seen.push(v);
    const s = $js_json_body(v, t, rep, gap, depth, seen);
    seen.pop();
    return s;
  }
  // 剩下的（regexp / bytes / TextEncoder…）照旧当场报：照 JS 那样给 {} 会撒谎
  throw new $HostBad("do not know how to serialize a " + t, "TypeError");
}
// 容器那几支的正文（拆出来只为了让 seen 的 push/pop 成对，不必在每条 return 前手写 pop）
function $js_json_body(v, t, rep, gap, depth, seen) {
  if (t === "list") {
    if (v.length === 0) return "[]";
    const sep = $js_json_nl(gap, depth + 1);
    let out = "[";
    for (let i = 0; i < v.length; i++) {
      if (i) out += ",";
      out += sep;
      const s = $js_json_val($js_json_apply(rep, $js_str(i), v[i]), rep, gap, depth + 1, seen);
      out += s === undefined ? "null" : s;
    }
    return out + $js_json_nl(gap, depth) + "]";
  }
  if (t === "dict") {
    const only = $js_json_list(rep);
    let out = "{", first = true;
    const sep = $js_json_nl(gap, depth + 1);
    if (only !== undefined) {
      for (const k of only) {
        const s = $js_json_val($js_json_apply(rep, k, $js_obj_get(v, k)), rep, gap, depth + 1, seen);
        if (s === undefined) continue;
        if (!first) out += ",";
        first = false;
        out += sep + $js_json_quote(k) + (gap === "" ? ":" : ": ") + s;
      }
      return first ? "{}" : out + $js_json_nl(gap, depth) + "}";
    }
    for (const [k, val] of v) {
      const s = $js_json_val($js_json_apply(rep, k, val), rep, gap, depth + 1, seen);
      if (s === undefined) continue;
      if (!first) out += ",";
      first = false;
      out += sep + $js_json_quote(k) + (gap === "" ? ":" : ": ") + s;
    }
    return first ? "{}" : out + $js_json_nl(gap, depth) + "}";
  }
  if (t === "Map" || t === "Set") return "{}";
  // 真对象（ADR-0020 P1）：自有、可枚举、字符串键，取值走 [[Get]]（访问器要被触发）。
  // toJSON 还没接（P4 那一片）。
  if (t === "object") {
    const only = $js_json_list(rep);
    // 白名单给了就按**名单的次序**走，键从名单来（规范 25.5.2.2：K 是 PropertyList，
    // 取值照旧是 [[Get]]，所以名单里点到原型上的数据属性也算）
    const ks = only === undefined ? $js_own_keys(v, "e") : only;
    let out = "{", first = true;
    const sep = $js_json_nl(gap, depth + 1);
    for (const k of ks) {
      const s = $js_json_val($js_json_apply(rep, k, $js_getp(v, k, undefined)), rep, gap, depth + 1, seen);
      if (s === undefined) continue;
      if (!first) out += ",";
      first = false;
      out += sep + $js_json_quote(k) + (gap === "" ? ":" : ": ") + s;
    }
    return first ? "{}" : out + $js_json_nl(gap, depth) + "}";
  }
  throw new $HostBad("do not know how to serialize a " + t, "TypeError");
}
/* 缩进那一格照规范 25.5.2 第 4-6 步：**数**是那么多个空格（最多 10），**串**是它自己
   （最多前 10 个码元），别的一律没有缩进。从前只认数，JSON.stringify(x, null, "\t")
   静静地印成一行 —— 所以 gap 一路是个串，不是"几个空格"。 */
function $js_json_stringify(v, rep, indent) {
  let gap = "";
  const t = $dynTag(indent);
  if (t === "real" || t === "int") {
    const n = Math.min(Math.trunc($js_real($js_num_of(indent), "JSON.stringify")), 10);
    if (n > 0) gap = " ".repeat(n);
  } else if (t === "string") {
    gap = $js_asS16(indent).slice(0, 10);
  }
  try {
    return $js_json_val($js_json_apply(rep, "", v), rep, gap, 0, []);
  } catch (e) {
    return $js_host_err(e);
  }
}

// ----------------------------------------------------- JSON.parse（ADR-0011）
// 读那一半也不能转手宿主：宿主吐出来的对象是普通对象，这边的对象是 Map；而且报错
// 文本必须两侧逐字相同，宿主的 SyntaxError 文本各引擎不一样。所以照 C 侧同一套
// 算法走一遍 —— 两边都是按 UTF-16 码元扫，位置数（position N）也就一定相同。
//
// 只认 RFC 8259 那一份：不收注释、单引号、尾逗号、NaN/Infinity。数一律出 real
// （宿主 JSON.parse 也没有 BigInt 那一支）。重复的键后来的赢、位置留在第一次
// 出现的地方 —— Map.set 与 C 侧 dict_set 都是这个语义。没有 reviver。
//
// 解析失败是**能 catch 的 SyntaxError**（ADR-0020，见文件开头的 $HostBad 那一段）：
// 出错点抛信号，$js_json_parse 那一层收下来翻成 pending 的 Error 值。
// 游标是 { s, i } 一个记录：这一族函数互相递归，下标要共享。
function $js_json_eoi() { throw new $HostBad("unexpected end of JSON input"); }
function $js_json_bad(z) {
  const c = z.s.charCodeAt(z.i);
  const shown = c >= 0x20 && c < 0x7f
    ? "'" + z.s[z.i] + "'"
    : "\\u" + c.toString(16).padStart(4, "0");
  throw new $HostBad("unexpected token " + shown + " in JSON at position " + z.i);
}
function $js_json_at(z) { if (z.i >= z.s.length) $js_json_eoi(); return z.s.charCodeAt(z.i); }
function $js_json_ws(z) {
  while (z.i < z.s.length) {
    const c = z.s.charCodeAt(z.i);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
    z.i++;
  }
}
function $js_json_digit(c) { return c >= 48 && c <= 57; }
// 定字：true / false / null 三个。逐码元比，比 startsWith 更容易和 C 侧对齐。
function $js_json_word(z, w) {
  if (z.i + w.length > z.s.length) return false;
  for (let k = 0; k < w.length; k++) if (z.s.charCodeAt(z.i + k) !== w.charCodeAt(k)) return false;
  z.i += w.length;
  return true;
}
// 字符串：进来时游标一定停在开引号上（调用点已经看过了）。
// 生的控制字符（< U+0020）在 JSON 里非法 —— 这一格必须报错，不然 stringify 转义了、
// parse 又收生的，来回一趟就不是同一份文本了。
function $js_json_str(z) {
  z.i++;
  let out = "";
  for (;;) {
    const c = $js_json_at(z);
    if (c === 0x22) { z.i++; return out; }
    if (c < 0x20) $js_json_bad(z);
    if (c !== 0x5c) { out += z.s[z.i]; z.i++; continue; }
    z.i++;
    const e = $js_json_at(z);
    if (e === 0x22 || e === 0x5c || e === 0x2f) { out += z.s[z.i]; z.i++; continue; }
    if (e === 98) { out += "\b"; z.i++; continue; }
    if (e === 102) { out += "\f"; z.i++; continue; }
    if (e === 110) { out += "\n"; z.i++; continue; }
    if (e === 114) { out += "\r"; z.i++; continue; }
    if (e === 116) { out += "\t"; z.i++; continue; }
    if (e !== 117) $js_json_bad(z);
    z.i++;
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const h = $js_json_at(z);
      const d = h >= 48 && h <= 57 ? h - 48
        : h >= 97 && h <= 102 ? h - 87
          : h >= 65 && h <= 70 ? h - 55 : -1;
      if (d < 0) $js_json_bad(z);
      v = v * 16 + d;
      z.i++;
    }
    // 孤立的代理项照收：宿主 JSON.parse 也照收，s16 存的本来就是码元
    out += String.fromCharCode(v);
  }
}
// 数：JSON 的语法是 -? (0 | [1-9]数字*) (.数字+)? ([eE][+-]?数字+)? 。先按这个语法把
// 一段切准（前导零、光一个点、光一个 e 都得当场报错），再交给 Number / strtod ——
// 两边都是正确舍入的十进制转二进制，所以同一段文本出同一个 double。
function $js_json_num(z) {
  const start = z.i;
  if ($js_json_at(z) === 45) z.i++;
  const c = $js_json_at(z);
  if (c === 48) z.i++;
  else if (c >= 49 && c <= 57) { while (z.i < z.s.length && $js_json_digit(z.s.charCodeAt(z.i))) z.i++; }
  else $js_json_bad(z);
  if (z.i < z.s.length && z.s.charCodeAt(z.i) === 46) {
    z.i++;
    if (!$js_json_digit($js_json_at(z))) $js_json_bad(z);
    while (z.i < z.s.length && $js_json_digit(z.s.charCodeAt(z.i))) z.i++;
  }
  if (z.i < z.s.length && (z.s.charCodeAt(z.i) === 101 || z.s.charCodeAt(z.i) === 69)) {
    z.i++;
    if (z.i < z.s.length && (z.s.charCodeAt(z.i) === 43 || z.s.charCodeAt(z.i) === 45)) z.i++;
    if (!$js_json_digit($js_json_at(z))) $js_json_bad(z);
    while (z.i < z.s.length && $js_json_digit(z.s.charCodeAt(z.i))) z.i++;
  }
  return Number(z.s.slice(start, z.i));
}
function $js_json_read(z) {
  $js_json_ws(z);
  const c = $js_json_at(z);
  if (c === 0x22) return $js_json_str(z);
  if (c === 0x7b) {
    z.i++;
    const o = new Map();
    $js_json_ws(z);
    if ($js_json_at(z) === 0x7d) { z.i++; return o; }
    for (;;) {
      $js_json_ws(z);
      if ($js_json_at(z) !== 0x22) $js_json_bad(z);
      const k = $js_json_str(z);
      $js_json_ws(z);
      if ($js_json_at(z) !== 0x3a) $js_json_bad(z);
      z.i++;
      o.set(k, $js_json_read(z));
      $js_json_ws(z);
      const d = $js_json_at(z);
      if (d === 0x2c) { z.i++; continue; }
      if (d !== 0x7d) $js_json_bad(z);
      z.i++;
      return o;
    }
  }
  if (c === 0x5b) {
    z.i++;
    const a = [];
    $js_json_ws(z);
    if ($js_json_at(z) === 0x5d) { z.i++; return a; }
    for (;;) {
      a.push($js_json_read(z));
      $js_json_ws(z);
      const d = $js_json_at(z);
      if (d === 0x2c) { z.i++; continue; }
      if (d !== 0x5d) $js_json_bad(z);
      z.i++;
      return a;
    }
  }
  if ($js_json_word(z, "true")) return true;
  if ($js_json_word(z, "false")) return false;
  if ($js_json_word(z, "null")) return null;
  if (c === 45 || $js_json_digit(c)) return $js_json_num(z);
  $js_json_bad(z);
}
// reviver（ADR-0020 P4）：自底向上走一遍，每一格调一次 (key, value)，this 是持有者。
// 键在数组里是下标的字符串形式；回调返回 undefined 就把那一格删掉（数组里留成 undefined）。
// 根那一格的持有者是个只有 "" 这一个键的临时对象 —— 规范就是这么规定的。
function $js_json_revive(rep, holder, key, val) {
  if ($dynTag(val) === "list") {
    for (let i = 0; i < val.length; i++) {
      val[i] = $js_json_revive(rep, val, $js_str(i), val[i]);
    }
  } else if ($dynTag(val) === "dict") {
    const ks = $js_obj_keys(val);
    for (let i = 0; i < ks.length; i++) {
      const k = ks[i];
      const r = $js_json_revive(rep, val, k, $js_obj_get(val, k));
      if (r === undefined) $js_obj_delete(val, k);
      else $js_obj_set(val, k, r);
    }
  }
  return $js_call_this(rep, holder, [key, val]);
}
// 实参先按 JS 的口径转字符串（JSON.parse(5) 是 5，不是报错），再从头读一格值，
// 末尾除了空白不许还有东西。
function $js_json_parse(text, rep) {
  const z = { s: $js_str(text), i: 0 };
  let v;
  try {
    v = $js_json_read(z);
    $js_json_ws(z);
    if (z.i !== z.s.length) {
      throw new $HostBad("unexpected non-whitespace character after JSON at position " + z.i);
    }
  } catch (e) {
    return $js_host_err(e);
  }
  if ($dynTag(rep) === "function") {
    const root = $js_obj_new();
    $js_obj_set(root, "", v);
    return $js_json_revive(rep, root, "", v);
  }
  return v;
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
// 抛出来的值文本化。异常对象是 { $cls: [类名…], message } 的普通对象（决策 15），而
// js_str 收不了 dict —— 所以这里按 JS 自己的 String(new Error(m)) === "Cls: m" 拼。
// 不是 ABI op，是 prelude 自己的助手：REPL 的 js 引擎与整程序的 uncaught 检查共用它，
// 两条路因此说同一句话（解释器那边对应 interp/builtin.js 的 jsErrText）。
function $js_err_text(v) {
  const t = $dynTag(v);
  if (t === "dict" || t === "object") {
    const cls = $js_obj_get(v, "$cls");
    if ($dynTag(cls) === "list" && cls.length > 0) {
      const msg = $js_obj_get(v, "message");
      return cls[0] + ": " + (msg === undefined ? "" : $js_asS16($js_str(msg)));
    }
  }
  return $js_asS16($js_str(v));
}
// 未捕获：宿主会打栈回溯，C 侧打不出同样的东西，所以两侧一律只打这一行
function $js_check_uncaught() {
  if (!$pendingSet) return;
  $flush();
  process.stderr.write("omni: uncaught: " + $js_err_text($pending) + "\n");
  process.exit(70);
}
// 异常对象就是普通对象：{ $cls: [类名…，最派生的在前], message }（ADR-0011 决策 15）
// 原型是 **Error.prototype**（errP）：String(err) 与模板里的 err 要落到它身上的 toString，
// 不然走的是 Object.prototype 那一格、印出 [object Object]（量出来的分叉）。
function $js_err_new(msg, cls, opts) {
  const o = $js_obj_new_p($realm().errP);
  /* $cls 与 message 都是**不可枚举**的（w/e/c = true/false/true）：JS 里 message 是 own
     但不可枚举、name 在原型上，所以 Object.keys(err) 是空的、JSON.stringify(new Error("x"))
     是 {}。从前这儿走的是普通的 obj_set，于是 $cls 这个内部标记也跟着漏进 JSON 与 keys 里
     （量出来的静默分叉：印出 {"$cls":["Error"],"name":"Error","message":"zero"}）。
     name 不在这儿定：它是 errP 上的一对存取器（见 $realm 里那一处）。 */
  $js_def_data(o, "$cls", cls, true, false, true);
  // message 缺席（new Error() / new Error(undefined)）就是空串 —— 规范里那一格只在
  // 给了非 undefined 时才设，而取不到时读出来的是原型上的 ""
  $js_def_data(o, "message", msg === undefined ? "" : msg, true, false, true);
  // { cause } 那一格（ES2022）：只有真给了才挂 —— 没给时 JS 里连这个属性都没有。
  // 两种载体都收：这条腿上的对象字面量是真对象（P1），C 那条腿上还是 dict。
  const ot = $dynTag(opts);
  if ((ot === "dict" || ot === "object") && $js_obj_has(opts, "cause")) {
    // cause 在规范里也是不可枚举的（JSON.stringify(new Error("c", {cause:7})) 是 {}）
    $js_def_data(o, "cause", $js_obj_get(opts, "cause"), true, false, true);
  }
  return o;
}
// 内建错误名那一族：$cls 那条链里第一个落在这里面的就是 name 该给的值（子类不算）
const $JS_ERR_NAMES = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError",
  "URIError", "AggregateError",
]);
function $js_err_bname(t) {
  const c = $js_getp(t, "$cls", undefined);
  if ($dynTag(c) === "list") {
    for (let i = 0; i < c.length; i++) {
      const s = $js_asS16($js_str(c[i]));
      if ($JS_ERR_NAMES.has(s)) return s;
    }
  }
  return "Error";
}
function $js_is_a(v, n) {  const t = $dynTag(v);
  if (t !== "dict" && t !== "object") return false;
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
function $js_fs_is_dir(p) {
  const fs = $node("node:fs"), s = $js_asS16(p);
  if (!fs.existsSync(s)) return false;
  return fs.statSync(s).isDirectory();
}
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
/* 删一个文件。不在就抛 —— 与 unlink(2) 一样，「不在」是错，不是成功
 * （C 侧 omni_js_fs_remove 同一个立场，消息也对齐）。 */
function $js_fs_remove(p) {
  $node("node:fs").unlinkSync($js_asS16(p));
  return undefined;
}
/* 字节口径那四条（ADR-0017 第八刀）：一个字符一个字节，也就是 node 的 latin1。
 * 与 read_text/write_text/stdout_write 的区别只在**不编解码** —— 这条腿要写出
 * 可执行文件，也要让 printf("%c", 0xff) 落一个 0xff 字节而不是两个。 */
function $js_fs_read_bytes(p) {
  return $node("node:fs").readFileSync($js_asS16(p), "latin1");
}
function $js_fs_write_bytes(p, body, mode) {
  const opts = mode === undefined ? undefined : { mode: Number(mode) };
  $node("node:fs").writeFileSync($js_asS16(p), Buffer.from($js_asS16(body), "latin1"), opts);
  return undefined;
}
function $js_proc_stdout_bytes(s) {
  $flush();
  process.stdout.write(Buffer.from($js_asS16(s), "latin1"));
  return undefined;
}
/* i32 的运算三条（ADR-0013 第三刀）。与 host/native.js 那一份逐条相同 ——
 * 它们是同一个 op 的两代实现，分叉了就是两套语义。 */
function $js_i32_op(op, a, b) {
  switch ($js_asS16(op)) {
    case "+": return (a + b) | 0;
    case "-": return (a - b) | 0;
    case "*": return Math.imul(a, b);
    case "/": return (a / b) | 0;
    case "%": return (a % b) | 0;
    case "u/": return ((a >>> 0) / (b >>> 0)) | 0;
    case "u%": return ((a >>> 0) % (b >>> 0)) | 0;
    case "&": return a & b;
    case "|": return a | b;
    case "^": return a ^ b;
    case "<<": return a << (b & 31);
    case ">>": return a >> (b & 31);
    case "u>>": return (a >>> (b & 31)) | 0;
    default: $rt_error("i32Op: 不认识的运算 " + $js_asS16(op));
  }
  return 0;
}
function $js_i32_tou(x) { return x >>> 0; }
function $js_i32_wrap(x) { return x | 0; }
function $js_proc_stderr_bytes(s) {
  $flush();
  process.stderr.write(Buffer.from($js_asS16(s), "latin1"));
  return undefined;
}
function $js_fs_realpath(p) { return $node("node:fs").realpathSync($js_asS16(p)); }
function $js_proc_args() { return process.argv.slice(2); }
function $js_proc_cwd() { return process.cwd(); }
function $js_proc_env(n) { return process.env[$js_asS16(n)]; }
// 写宿主的一格环境（ADR-0015）：-f svg 设的就是它，子进程继承。
function $js_proc_set_env(n, v) { process.env[$js_asS16(n)] = $js_asS16(v); return undefined; }
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
function $js_proc_spawn(cmd, args, mode) { return $js_spawn_run(cmd, args, mode, null); }
/* 与上面那条只差一格：把第 4 个参数那段文本喂进子进程的 stdin（空串 = 不喂）。
   ADR-0019 决策八：IR 走 stdin，磁盘上一个字节都不写。
   先写完 input 再读 stdout —— 被调那侧要先把 stdin 读干（glsl_host.c 的 slurp_stdin
   正是这样），不然两个方向都超过一个管道缓冲（64 KB）时会死锁。 */
function $js_proc_spawn_in(cmd, args, mode, input) {
  const s = $js_asS16(input);
  return $js_spawn_run(cmd, args, mode, s === "" ? null : s);
}
function $js_spawn_run(cmd, args, mode, feed) {
  const m = $js_asS16(mode);
  const stdio = m === "c" ? ["ignore", "pipe", "pipe"]
    : m === "o" ? ["ignore", "inherit", "pipe"]
      : ["inherit", "inherit", "inherit"];
  if (feed !== null) stdio[0] = "pipe";
  // maxBuffer 必须显式给：node 的默认是 1 MiB，而 C 侧的实现没有这个上限。
  // omni bootstrap 要收下另一代编译器 1.7 MB 的 stdout，默认值会 ENOBUFS。
  const opts = { encoding: "utf8", stdio, maxBuffer: 1 << 28 };
  if (feed !== null) opts.input = feed;
  // 时限是剩下的那一段（run 在 spawn 之前还编了一趟）。到点回 124，见 $js_run_timeout。
  if ($js_deadline_ms > 0) {
    const left = $js_deadline_ms - Date.now();
    opts.timeout = left > 0 ? left : 1;
    opts.killSignal = "SIGKILL";
  }
  const r = $node("node:child_process").spawnSync(
    $js_asS16(cmd), $js_arr_of(args).map((x) => $js_asS16(x)), opts);
  if (r.error !== undefined && r.error !== null) {
    if (r.error.code === "ETIMEDOUT") {
      return [124, r.stdout === null || r.stdout === undefined ? "" : r.stdout,
        r.stderr === null || r.stderr === undefined ? "" : r.stderr];
    }
    $rt_error("cannot spawn: " + r.error.message);
  }
  return [r.status === null ? 128 : r.status, r.stdout === null ? "" : r.stdout, r.stderr === null ? "" : r.stderr];
}
/* 一趟"跑"的墙上时限（omni run --timeout）。ms <= 0 = 撤掉时限。
   两种"跑"要两套手段，而且两种只有宿主能中断（与 host/native.js 的 runTimeout 逐字对齐）：
   子进程那一路是 spawnSync 的 timeout（到点杀孩子、回 124）；本进程那一路（evalJs、
   解释器）在同一根线程上同步跑完，事件循环一格都不转 —— 只有 worker 那根线程能开枪，
   所以它自己把那句话写进 fd 2 再 SIGKILL（退出码 137，被杀的进程没机会再设退出码）。
   worker 那把枪晚 500ms：子进程那一路到点先返回，那段窗口留给上面那层印字与退出。 */
let $js_deadline_ms = 0;
function $js_run_timeout(ms, msg) {
  const m = Number(ms);
  if (!(m > 0)) { $js_deadline_ms = 0; return undefined; }
  $js_deadline_ms = Date.now() + m;
  const src = "const d = process.getBuiltinModule('node:worker_threads').workerData;"
    + "setTimeout(() => {"
    + "process.getBuiltinModule('node:fs').writeSync(2, d.msg);"
    + "process.kill(process.pid, 'SIGKILL');"
    + "}, d.ms);";
  const w = new ($node("node:worker_threads").Worker)(src,
    { eval: true, workerData: { ms: m + 500, msg: $js_asS16(msg) } });
  w.unref();
  return undefined;
}
function $js_os_tmpdir() { return $node("node:os").tmpdir(); }
function $js_now_ms() { return Date.now(); }
// 本地时间的日历字段，14 位数字 YYYYMMDDHHMMSS。与 host/native.js 的 localStamp 逐字对齐
// （那份是 node 上的真实现，这份是拼进产物的）。C 侧是 omni_js_local_stamp 的 strftime。
function $js_local_stamp() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  return "" + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate())
    + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
}
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
      if (v instanceof $JsRe) return "regexp";
      if (v instanceof $JsBytes) return "bytes";
      if (v instanceof $JsTextEnc) return "TextEncoder";
      return "function";
  }
}
// real 的两种文本化，给解释器用（ADR-0013）。刻意就是 print / repr 自己用的那两个函数 ——
// 解释器不再写第三份浮点格式化，于是"同一个 double 打印成同一串字符"是构造性的。
function $js_fmt_real(x) { return $fmt_real(x); }
function $js_fmt_real_g(x, p) { return $str_real_g(x, p); }
// %f / %e / %g 那三种排版，同一条纪律：用的就是这条腿自己那三份
//（sfix / ssci / sgen 降下来调的正是它们）。这几行在一段模板字面量里，所以注释里不写反引号。
function $js_fmt_fixed(x, p) { return $str_fixed(x, p); }
function $js_fmt_sci(x, p) { return $str_sci(x, p); }
function $js_fmt_gen(x, p, keep) { return keep ? $str_genk(x, p) : $str_gen(x, p); }
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
// 间接 eval 而不是 new Function：后者的函数体是一层函数作用域，片段里的函数声明与
// var 都关在里面，下一次调用看不见。REPL 的 js 引擎要的正相反 —— 一批输入编出一段
// 片段，装进同一个全局作用域，于是上一批的函数与全局量这一批还在（增量）。
function $js_eval(code) {
  $flush();
  const indirect = eval;
  return indirect($js_asS16(code));
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
// 正则当值：造一格与 C 侧同形的三元组（source / flags / lastIndex）
/* 三条规范细节（22.2.4.1）：实参本身是正则就**照抄**它的源（旗标缺席时连旗标一起抄），
   模式缺席（new RegExp() / new RegExp(undefined)）是空模式，不是 "undefined"，
   旗标缺席是无旗标。抄的是没 escape 过的原样源 —— .source 那一格自己会 escape。 */
function $js_re_new(src, flags) {
  if ($dynTag(src) === "regexp") {
    return new $JsRe(src.src, flags === undefined ? src.flags : $js_asS16($js_str(flags)));
  }
  return new $JsRe(
    src === undefined ? "" : $js_asS16($js_str(src)),
    flags === undefined ? "" : $js_asS16($js_str(flags)),
  );
}
function $js_re_last_index(r) {
  if ($dynTag(r) !== "regexp") $rt_error($dynTag(r) + " is not a regexp");
  return r.li;
}
// source / flags：正则对象身上那两格只读属性（new RegExp(src, flags) 也从它们回读）
/* 这两格有两个身份：re.source / re.flags 的取值面（接收者一定是正则，成员派发按标签走），
   以及"把**运行期**的那一格实参摊成 (源, 旗标)"—— 后者是 $js_str_replace 那一族早就在用的
   办法，match / matchAll / search 收非字面量正则时也走它（见 lower.js 的 regexCall）。
   所以非正则不报错，照规范 ToString 当**模式**收下（"abc".match("b") 就是这个意思），
   undefined 当空模式（不是 "undefined"）。 */
/* EscapeRegExpPattern（规范 22.2.6.13.1）：.source 交出去的那一格要能塞回 /…/ 里再读一遍，
   所以裸 / 得写成 \/，换行得写成两个字符的 \n，空模式得写成 (?:)。
   两条要点：反斜杠后头那一格照抄（已经写成 \/ 的字面量不能再escape一遍），
   字符组 [...] 里的 / 不用管（qjs 与 V8 都不动它）。
   \u2028 / \u2029 qjs 不escape，跟着 qjs。
   这一格escape过的模式塞回引擎还是同一个正则，所以内部那条"摊成 (源, 旗标)"的路照用不误。 */
function $js_re_esc_src(p) {
  if (p.length === 0) return "(?:)";
  let out = "";
  let cls = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\") { out += c; i++; if (i < p.length) out += p[i]; continue; }
    if (c === "\n") { out += "\\n"; continue; }
    if (c === "\r") { out += "\\r"; continue; }
    if (c === "[") cls = true;
    else if (c === "]") cls = false;
    else if (c === "/" && !cls) { out += "\\/"; continue; }
    out += c;
  }
  return out;
}
function $js_re_source(r) {
  if ($dynTag(r) === "regexp") return $js_re_esc_src(r.src);
  return r === undefined ? "" : $js_str(r);
}
function $js_re_flags(r) {
  if ($dynTag(r) === "regexp") return r.flags;
  return "";
}
/* 旗标那一族的布尔属性（规范 22.2.6.4 起的 global / ignoreCase / … ）：就是问 flags 串里
   有没有那个字母。不是正则的接收者一律 false —— 派发器只把 regexp 这一支路到这儿，别的标签
   照旧走普通属性读。从前这一族根本不在属性表里，r.global 静静地给 undefined。 */
function $js_re_has_flag(r, ch) {
  return $dynTag(r) === "regexp" && r.flags.includes(ch);
}
function $js_re_global(r) { return $js_re_has_flag(r, "g"); }
function $js_re_ignore_case(r) { return $js_re_has_flag(r, "i"); }
function $js_re_multiline(r) { return $js_re_has_flag(r, "m"); }
function $js_re_dot_all(r) { return $js_re_has_flag(r, "s"); }
function $js_re_unicode(r) { return $js_re_has_flag(r, "u"); }
function $js_re_sticky(r) { return $js_re_has_flag(r, "y"); }
function $js_re_has_indices(r) { return $js_re_has_flag(r, "d"); }
/* matchAll 那一支专用：非正则实参照规范补 g（22.1.3.14 第 3 步 c 的 RegExpCreate(R, "g")），
   所以 "aXbX".matchAll("X") 是两处。真正则照旧读它自己的旗标 —— 不带 g 的真正则该报错，
   这一格不替它补。 */
function $js_re_flags_g(r) {
  return $dynTag(r) === "regexp" ? r.flags : "g";
}
// search：头一处匹配的下标，找不到给 -1。**不动 lastIndex**（规范 22.1.3.22 存了再复原），
// 所以 /g 与不带 g 的答案一样
function $js_re_search(pat, flags, s) {
  const m = $js_re_find($js_re_get(pat, $js_asS16(flags)), $js_asS16(s), 0);
  return m === null ? -1 : m.index;
}
// 正则对象上的 test：与 exec 共用那套 lastIndex 行为
function $js_re_test_o(rd, sd) { return $js_re_exec(rd, sd) !== null; }
// 具名组那一格对象（$js_re_result 与 replace 的函数替换共用）
function $js_re_groups(m) {
  const g = $js_obj_new();
  const names = Object.keys(m.groups);
  for (let i = 0; i < names.length; i++) $js_obj_set(g, names[i], m.groups[names[i]]);
  return g;
}
// exec / .match（不带 g）的结果：一格 list，外加 index / input / groups 三格**属性**
// （list 上挂属性走旁表，见 $js_xprops —— 所以"list 带不了属性"那句注释已经过时了）。
// groups 只在模式里有具名组时才有，没有就整格 undefined（JS 就是这样）。
function $js_re_result(m, str) {
  const out = [];
  for (let i = 0; i < m.length; i++) out.push(m[i] === undefined ? undefined : m[i]);
  $js_obj_set(out, "index", m.index);
  $js_obj_set(out, "input", str);
  if (m.groups !== undefined) $js_obj_set(out, "groups", $js_re_groups(m));
  /* d 旗标（ES2022 hasIndices）：每一格是 [起, 止]，没参与匹配的组是 undefined。
     只有 JS 这条腿有 —— C 的引擎当场拒 'd'（与 s / u / v 同一档，见 omni_js_re.c）。 */
  if (m.indices !== undefined) {
    const ix = [];
    for (let i = 0; i < m.indices.length; i++) {
      const p = m.indices[i];
      ix.push(p === undefined ? undefined : [p[0], p[1]]);
    }
    if (m.indices.groups !== undefined) {
      const ig = $js_obj_new();
      const gn = Object.keys(m.indices.groups);
      for (let i = 0; i < gn.length; i++) {
        const p = m.indices.groups[gn[i]];
        $js_obj_set(ig, gn[i], p === undefined ? undefined : [p[0], p[1]]);
      }
      $js_obj_set(ix, "groups", ig);
    }
    $js_obj_set(out, "indices", ix);
  }
  return out;
}
/* matchAll（ES2020）：从 0 起一趟趟找，每一趟给一格与 exec 同形的结果（整体匹配在 0、
   捕获组依次在后，外加 index / input / groups）。**交出来的是一个数组**而不是迭代器对象
   —— 展开、for-of、Array.from 都成，next() 那一面不在这个值域里（画出来的边界）。
   空匹配往前挪一格，不然在原地打转；不动接收者那格 lastIndex（规范里 matchAll 用克隆）。
   这一格只有 JS 侧：结果上的 index / input / groups 靠 list 的旁表，C 那侧没有（P1-c）。 */
/* matchAll 交出来的是**一格迭代器**（规范 22.2.6.9 的 %RegExpStringIterator%），不是数组 ——
   于是 .next() 与"惰性"两格都成立，而展开与 for-of 照旧。
   从前这儿一次扫完交一条 list：展开与 for-of 看不出差别，.next 却是 undefined（量出来的）。
   简化的一格写在明处：规范给它一格共享的原型（%RegExpStringIteratorPrototype%），这儿把
   next 与 Symbol.iterator 那两格**直接挂在对象上**（不可枚举）—— 两格方法因此不共享，
   it1.next === it2.next 是假。 */
function $js_re_match_all(body, flags, sd) {
  // 不带 g 的真正则：规范 22.1.3.14 第 3 步 b 明写 TypeError —— **能 catch** 的那一种
  if (!flags.includes("g")) return $js_type_err("matchAll must be called with a global RegExp");
  const s = $js_asS16(sd);
  const re = $js_re_get(body, flags);
  let at = 0;
  let done = false;
  const it = $js_obj_new_p($realm().objP);
  $js_def_data(it, "next", $nat("next", 0, () => {
    const r = $js_obj_new_p($realm().objP);
    const m = done ? null : $js_re_find(re, s, at);
    if (m === null) {
      done = true;
      $js_obj_set(r, "value", undefined);
      $js_obj_set(r, "done", true);
      return r;
    }
    at = m.index + (m[0].length === 0 ? 1 : m[0].length);
    if (at > s.length) done = true;
    $js_obj_set(r, "value", $js_re_result(m, s));
    $js_obj_set(r, "done", false);
    return r;
  }), true, false, true);
  $js_def_data(it, $js_sym_wk("iterator"), $nat("[Symbol.iterator]", 0, (t) => t), true, false, true);
  return it;
}
// 正则对象上的 exec，照 ECMA-262 22.2.7.2：带 g 才用 lastIndex，找到就把它推到匹配的末尾
// （**不加 1** —— 空匹配在 JS 里就是停在原地，那是调用方的事，这里不许自己"修好"），
// 没找到就归 0。不带 g 的一律从 0 起，也不动 lastIndex。
// 结果是一格 list（整体匹配在 0、捕获组依次在后），外加 index / input / groups 三格属性。
function $js_re_exec(rd, sd) {
  if ($dynTag(rd) !== "regexp") $rt_error($dynTag(rd) + " is not a regexp");
  const s = $js_asS16(sd);
  /* lastIndex 那一格：**g 与 y 都用**（规范 22.2.7.2 第 4 步）。差别在"从哪儿起"：
     y 要求恰好从 lastIndex 起匹配（宿主的 y 旗标自己会锚住），g 是从那儿往后找。
     从前只看 g，于是 /ab/y 的 test 每次都从 0 起、lastIndex 一直是 0 —— 静默分叉。 */
  const g = rd.flags.includes("g") || rd.flags.includes("y");
  const at = g ? rd.li : 0;
  const m = at < 0 ? null : $js_re_find($js_re_get(rd.src, rd.flags), s, at);
  if (m === null) {
    if (g) rd.li = 0;
    return null;
  }
  if (g) rd.li = m.index + m[0].length;
  return $js_re_result(m, s);
}

// ------------------------- 字节缓冲：ArrayBuffer / Uint8Array / DataView（ADR-0011）
// 三者在这一格里是**同一种值**：一个 {u8, dv} 视图。ArrayBuffer 与它上面的视图共享同一
// 块内存，别名关系天然成立 —— interp/builtin.js 模拟指针内存靠的正是这个（ADR-0016）。
// 越界一律先自己查一遍再动手：宿主抛的是 RangeError，文本各引擎不同，两侧要逐字相同。
class $JsBytes {
  constructor(u8) {
    this.u8 = u8;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  }
}
class $JsTextEnc {}
/* Uint8Array 上的几格数组方法：先摊成字节的数组，再走 list 那一格。只收**结果是原始值**
   的那几个（join / at / indexOf / includes）—— map / filter / slice 在 JS 里交出的是
   TypedArray，摊成 list 会在打印与 JSON 上撒谎，所以照旧当场报错。 */
function $js_buf_join(b, sep) { return $js_arr_join($js_iter(b), sep); }
function $js_buf_elem_at(b, i) { return $js_arr_at($js_iter(b), i); }
function $js_buf_index_of(b, v) { return $js_arr_index_of($js_iter(b), v); }
function $js_buf_includes(b, v) { return $js_arr_includes($js_iter(b), v); }
function $js_bytes(v, who) {
  if ($dynTag(v) !== "bytes") $rt_error(who + " expects a byte buffer, found " + $dynTag(v));
  return v;
}
function $js_buf_new(n) {
  const len = $js_real(n, "new ArrayBuffer");
  if (!Number.isInteger(len) || len < 0) $rt_error("invalid byte length");
  return new $JsBytes(new Uint8Array(new ArrayBuffer(len)));
}
/* new Uint8Array([…]) 那一支：实参是一格 list 就按元素填字节。每一格照规范 ToNumber 再
   ToUint8（宿主的 u[i] = x 就是这一步：截零、模 256、NaN 归 0），所以 "3" / true / null
   都收得下。降级器按运行期标签在这一格与 js_buf_view 之间挑（见 lower.js）。 */
function $js_buf_of_list(a) {
  const l = $js_arr_of(a);
  const u = new Uint8Array(l.length);
  for (let i = 0; i < l.length; i++) u[i] = $js_real($js_num_of(l[i]), "new Uint8Array");
  return new $JsBytes(u);
}
function $js_buf_view(b, off, len) {
  // new Uint8Array(n) 那一支：实参是个数就是"新开 n 字节"，不是开视图
  if ($dynTag(b) === "real") return $js_buf_new(b);
  const src = $js_bytes(b, "a byte-buffer view").u8;
  const o = off === undefined ? 0 : $js_real(off, "a byte-buffer view");
  const n = len === undefined ? src.byteLength - o : $js_real(len, "a byte-buffer view");
  if (!Number.isInteger(o) || !Number.isInteger(n) || o < 0 || n < 0 || o + n > src.byteLength) {
    $rt_error("byte-buffer view out of range");
  }
  return new $JsBytes(new Uint8Array(src.buffer, src.byteOffset + o, n));
}
function $js_buf_len(b) { return $js_bytes(b, ".length").u8.byteLength; }
/* .set(src[, offset])（规范 23.2.3.26）与 .fill(v[, start[, end]])（23.2.3.9）：
   从前这两格的 op 少一/两个形参，成员派发器把多出来的实参**静静地丢了** ——
   d.set(src, 2) 写到 0 去、f.fill(9, 1, 3) 把整格填满。两处都是静悄悄的错值。
   下标照数组那一族的规矩：负数从末尾数，夹到 [0, len]。 */
function $js_buf_set(dst, src, off) {
  const d = $js_bytes(dst, ".set").u8, s = $js_bytes(src, ".set").u8;
  const o = off === undefined ? 0 : $js_real($js_num_of(off), ".set");
  if (!Number.isInteger(o) || o < 0) $rt_error("byte-buffer .set offset is out of range");
  if (s.byteLength + o > d.byteLength) $rt_error("byte-buffer .set source is too long");
  d.set(s, o);
  return undefined;
}
function $js_buf_fill(b, v, start, end) {
  const u = $js_bytes(b, ".fill").u8;
  const a = $js_idx(start, 0), z = $js_idx(end, u.byteLength);
  u.fill($js_real($js_num_of(v), ".fill") & 255,
    Math.min(Math.max(a < 0 ? u.byteLength + a : a, 0), u.byteLength),
    Math.min(Math.max(z < 0 ? u.byteLength + z : z, 0), u.byteLength));
  return b;
}
function $js_buf_at(v, at, size, who) {
  const o = $js_real(at, who);
  if (!Number.isInteger(o) || o < 0 || o + size > v.u8.byteLength) {
    $rt_error(who + " offset is outside the bounds of the buffer");
  }
  return o;
}
function $js_buf_get_u8(b, at) {
  const v = $js_bytes(b, ".getUint8");
  return v.dv.getUint8($js_buf_at(v, at, 1, ".getUint8"));
}
// 定宽整数与 float32（ADR-0020 P4）：宽度在 sel 里，见 hir/js_abi.js 的 js_buf_getn。
// 转手宿主的 DataView —— 存整数时的取整与截断照规范（C 那份自己算一遍同样的模）。
function $js_buf_wname(sel) {
  if (sel === "b") return "Int8";
  if (sel === "B") return "Uint8";
  if (sel === "h") return "Int16";
  if (sel === "H") return "Uint16";
  if (sel === "i") return "Int32";
  if (sel === "I") return "Uint32";
  return "Float32";
}
function $js_buf_wsize(sel) {
  if (sel === "b" || sel === "B") return 1;
  if (sel === "h" || sel === "H") return 2;
  return 4;
}
function $js_buf_getn(sel, b, at, le) {
  const who = ".get" + $js_buf_wname(sel);
  const v = $js_bytes(b, who);
  const o = $js_buf_at(v, at, $js_buf_wsize(sel), who);
  const l = $js_truthy(le);
  if (sel === "b") return v.dv.getInt8(o);
  if (sel === "B") return v.dv.getUint8(o);
  if (sel === "h") return v.dv.getInt16(o, l);
  if (sel === "H") return v.dv.getUint16(o, l);
  if (sel === "i") return v.dv.getInt32(o, l);
  if (sel === "I") return v.dv.getUint32(o, l);
  return v.dv.getFloat32(o, l);
}
function $js_buf_setn(sel, b, at, x, le) {
  const who = ".set" + $js_buf_wname(sel);
  const v = $js_bytes(b, who);
  const o = $js_buf_at(v, at, $js_buf_wsize(sel), who);
  const d = $js_real(x, who), l = $js_truthy(le);
  if (sel === "b") v.dv.setInt8(o, d);
  else if (sel === "B") v.dv.setUint8(o, d);
  else if (sel === "h") v.dv.setInt16(o, d, l);
  else if (sel === "H") v.dv.setUint16(o, d, l);
  else if (sel === "i") v.dv.setInt32(o, d, l);
  else if (sel === "I") v.dv.setUint32(o, d, l);
  else v.dv.setFloat32(o, d, l);
  return undefined;
}
function $js_buf_set_u8(b, at, x) {
  const v = $js_bytes(b, ".setUint8");
  v.dv.setUint8($js_buf_at(v, at, 1, ".setUint8"), $js_real(x, ".setUint8") & 255);
  return undefined;
}
function $js_buf_get_i64(b, at, le) {
  const v = $js_bytes(b, ".getBigInt64");
  return v.dv.getBigInt64($js_buf_at(v, at, 8, ".getBigInt64"), $js_truthy(le));
}
function $js_buf_set_i64(b, at, x, le) {
  const v = $js_bytes(b, ".setBigInt64");
  if ($dynTag(x) !== "int") $rt_error(".setBigInt64 expects a bigint, found " + $dynTag(x));
  v.dv.setBigInt64($js_buf_at(v, at, 8, ".setBigInt64"), $DW(x), $js_truthy(le));
  return undefined;
}
function $js_buf_get_f64(b, at, le) {
  const v = $js_bytes(b, ".getFloat64");
  return v.dv.getFloat64($js_buf_at(v, at, 8, ".getFloat64"), $js_truthy(le));
}
function $js_buf_set_f64(b, at, x, le) {
  const v = $js_bytes(b, ".setFloat64");
  v.dv.setFloat64($js_buf_at(v, at, 8, ".setFloat64"), $js_real(x, ".setFloat64"), $js_truthy(le));
  return undefined;
}
// TextEncoder 是无状态的，但 new TextEncoder().encode(t) 是两步，所以那一格也得有个值
function $js_text_enc_new() { return new $JsTextEnc(); }
function $js_text_encode(e, s) {
  if ($dynTag(e) !== "TextEncoder") {
    $rt_error(".encode expects a TextEncoder, found " + $dynTag(e));
  }
  return new $JsBytes(new TextEncoder().encode($js_asS16(s)));
}
function $js_re_test(pat, flags_, s) {
  const flags = $js_asS16(flags_);
  if (flags.includes("g")) $rt_error("regexp: .test on a /g/ regexp is not supported (lastIndex has no home here)");
  return $js_re_find($js_re_get(pat, flags), $js_asS16(s), 0) !== null;
}
// .match：带 g 是"所有整体匹配的字符串"，不带 g 就是一次 exec（结果上挂着
// index / input / groups —— 见 $js_re_result）
function $js_re_match(pat, flags_, s) {
  const flags = $js_asS16(flags_);
  const re = $js_re_get(pat, flags), str = $js_asS16(s);
  if (!flags.includes("g")) {
    const m = $js_re_find(re, str, 0);
    return m === null ? null : $js_re_result(m, str);
  }
  const out = [];
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
    /* $<name>：具名组（规范 22.1.3.19 表 22 的最后一行）。**只有这个正则有具名组时**
       才特殊 —— 没有 groups 那一格的话 $< 是普通字符，量过两把尺子都是这样。 */
    else if (d === "<" && m.groups !== undefined) {
      const end = repl.indexOf(">", i + 2);
      if (end < 0) { out += c; continue; }
      const v = m.groups[repl.slice(i + 2, end)];
      out += v === undefined ? "" : v;
      i = end;
    }
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
      ? $js_str($callFn(repl, m.groups === undefined
        // 有具名组时，回调的**最后一格**是那格 groups 对象（规范 22.1.3.19 第 14 步）
        ? [...m, m.index, str]
        : [...m, m.index, str, $js_re_groups(m)]))
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
  if (t === "string") return BigInt($slen(v));
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
    if (op === "+") return $DW(a + b);
    if (op === "-") return $DW(a - b);
    if (op === "*") return $DW(a * b);
    if (op === "/") return $ddiv(a, b);
    return $dmod(a, b);
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
  if (t === "int") return $DW(-a);
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
