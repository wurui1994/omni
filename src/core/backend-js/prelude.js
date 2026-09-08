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
function $js_arith(op, a, b) {
  // 对象与数组先 ToPrimitive（hint number），与 js_add 那一处同一条规矩
  a = $js_prim("n", a);
  b = $js_prim("n", b);
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
    case "<": return $DW(a << (b & 63n));
    case ">": return a >> (b & 63n);
    default: $rt_error("unknown bitwise op '" + op + "'");
  }
}
// 一元 ~ 单独一个 op：ABI 里所有 op 的实参个数是定的，不做可变长
function $js_bitnot(a) {
  const t = $dynTag(a);
  if (t !== "int") $rt_error("bitwise '~' requires a bigint operand, found " + t);
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
    const num = (t) => t === "int" || t === "real";
    if (!num(ta) || !num(tb)) $rt_error("cannot compare " + ta + " with " + tb);
    // 两个 bigint 之间精确比：Number() 在 2^53 以上丢位，而 BigInt 的 < 是精确的。
    // C 侧的 int_cmp 是同一条规则 —— 两边都精确，大数上才不分叉。
    if (ta === "int" && tb === "int") {
      c = a < b ? -1 : (a > b ? 1 : 0);
    } else {
      const x = Number(a), y = Number(b);
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
function $js_eq(strict, a, b) {
  const ta = $dynTag(a), tb = $dynTag(b);
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
    const prim = (t) => t === "string" || t === "int" || t === "real" || t === "bool" || t === "symbol";
    if (ta === "object" && prim(tb)) return $js_eq(false, $js_to_prim("d", a), b);
    if (prim(ta) && tb === "object") return $js_eq(false, a, $js_to_prim("d", b));
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
function $js_str_pad_end(s, n, fill) {
  return $js_asS16(s).padEnd($js_idx(n, 0), fill === undefined ? " " : $js_asS16(fill));
}
// replaceAll 的字符串模式那一支。替换串里的 $& / $1 一律当**普通字符**：
// 宿主的 replaceAll 会认它们，所以这里不能直接转手，手写一遍才和 C 侧同样残缺。
// 空模式照 JS 的样子在每个码元之间各插一份（"abc" 上插出 -a-b-c-）。
function $js_str_replace_all(s, pat, rep) {
  const v = $js_asS16(s), p = $js_asS16(pat), r = $js_asS16(rep);
  if (p.length === 0) {
    let out = r;
    for (let i = 0; i < v.length; i++) out += v[i] + r;
    return out;
  }
  let out = "", i = 0;
  for (;;) {
    const at = v.indexOf(p, i);
    if (at < 0) break;
    out += v.slice(i, at) + r;
    i = at + p.length;
  }
  return out + v.slice(i);
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
// 第二个实参是"从哪一格往前找"（含）；缺省从末尾找。规范 22.1.3.11：位置先夹到
// [0, len]，匹配本身可以越过它往右伸。cli.js 的 inpPath 就是这么一段段往前切印记的，
// 少了这个实参，降级器会以为"这不是 ABI 那个 lastIndexOf"、退回通用取属性 ——
// 于是装好的那份读缓存时报 "string is not an object"。
function $js_str_last_index_of(s, needle, from) {
  const v = $js_asS16(s), n = $js_asS16(needle);
  return from === undefined ? v.lastIndexOf(n) : v.lastIndexOf(n, $js_idx(from, 0));
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
function $js_arr_concat(a, b) { return $js_arr_of(a).concat($js_arr_of(b)); }
function $js_arr_reverse(a) { $js_arr_of(a).reverse(); return a; }
function $js_arr_fill(a, v) { $js_arr_of(a).fill(v); return a; }
function $js_arr_is_array(v) { return $dynTag(v) === "list"; }
// Array.from：走一遍迭代（ADR-0020 P1）——数组是恒等、字符串按码点、Map/Set 给条目，
// 自定义可迭代对象走 Symbol.iterator 协议。再 slice 一份，免得把原数组交出去。
function $js_arr_from(v) { return $js_iter(v).slice(); }
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
function $js_arr_reduce_right(a, f, init) {
  const l = $js_arr_of(a);
  let i = l.length - 1, acc;
  if (init === undefined) {
    if (l.length === 0) $rt_error("reduce of empty array with no initial value");
    acc = l[i]; i--;
  } else {
    acc = init;
  }
  for (; i >= 0; i--) acc = $callFn(f, [acc, l[i], i, a]);
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
// toSorted：整段拷贝再就地排，稳定性与比较器语义完全跟着 sort 那一份
function $js_arr_to_sorted(a, f) { return $js_arr_sort($js_arr_of(a).slice(), f); }
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
    // ADR-0020 P1：真对象按**协议**迭代（Symbol.iterator + next），不按标签硬派发。
    // 收成一个数组回去：for-of 的降级现在吃的是数组，把"惰性"这一格留给 P2
    // （生成器那一刀之后，for-of 才有真正的惰性形态）。
    case "object": {
      const it = $js_iter_proto(v), out = [];
      for (;;) {
        const r = $js_iter_next(it);
        if ($js_truthy($js_getp(r, "done", undefined))) return out;
        out.push($js_getp(r, "value", undefined));
      }
    }
    default: $rt_error($dynTag(v) + " is not iterable");
  }
}
// o[k]：数组按下标、字符串按码元（只读）、普通对象按属性名。
// Map/Set 上的 o[k] 在 JS 里是属性访问而不是条目，量过的源码里没有，所以报错。
function $js_idx_get(o, k) {
  switch ($dynTag(o)) {
    // 下标是数就是元素，否则是**挂在数组身上的属性**（JS 里数组也是对象）。
    // a.foo 与 a["foo"] 于是走到同一个地方（降级器把成员赋值发成 idx_set）。
    case "list": return $js_num_key(k) ? $js_arr_get(o, k) : $js_obj_get(o, k);
    case "string": return $js_str_index(o, k);
    case "dict": return $js_obj_get(o, k);
    // 真对象（ADR-0020 P1）：o[k] 与 o.k 是同一条路 —— 沿原型链、触发访问器。
    case "object": return $js_getp(o, k, undefined);
    default: $rt_error("cannot index a " + $dynTag(o));
  }
}
function $js_num_key(k) {
  const t = $dynTag(k);
  return t === "int" || t === "real";
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
    const x = $js_xprops(o, false), key = $js_prop(k);
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
  if ($dynTag(o) === "list") { $js_xprops(o, true).set($js_prop(k), v); return o; }
  $js_dict_of(o).set($js_prop(k), v);
  return o;
}
function $js_obj_has(o, k) {
  if ($js_isobj(o)) return $js_obj_has_p(o, k);
  if ($dynTag(o) === "list") {
    const x = $js_xprops(o, false);
    return x === undefined ? false : x.has($js_prop(k));
  }
  return $js_dict_of(o).has($js_prop(k));
}
function $js_obj_delete(o, k) {
  if ($js_isobj(o)) return $js_obj_del_p(o, k);
  if ($dynTag(o) === "list") {
    const x = $js_xprops(o, false);
    return x === undefined ? true : x.delete($js_prop(k));
  }
  return $js_dict_of(o).delete($js_prop(k));
}
// Object.keys/values/entries：真对象上只算**自有、可枚举、字符串键**的（规范如此），
// dict 那一格照旧是全部键（那是 Omni 的 dict，没有描述符这一层）。
function $js_obj_keys(o) {
  if ($js_isobj(o)) return $js_own_keys(o, "e");
  return [...$js_dict_of(o).keys()];
}
function $js_obj_values(o) {
  if ($js_isobj(o)) return $js_own_keys(o, "e").map((k) => $js_getp(o, k, undefined));
  return [...$js_dict_of(o).values()];
}
function $js_obj_entries(o) {
  if ($js_isobj(o)) return $js_own_keys(o, "e").map((k) => [k, $js_getp(o, k, undefined)]);
  return [...$js_dict_of(o)].map(([k, v]) => [k, v]);
}
// { ...src, k: v } 的 src 那一步。undefined / null 当空对象（JS 就是这么规定的）。
function $js_obj_assign(dst, src) {
  if (src === undefined || src === null) return dst;
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
  }
}
function $js_isobj(v) { return v instanceof $JSObj; }
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
function $js_getp(o, k, recv) {
  const self = recv === undefined ? o : recv;
  if (!$js_isobj(o)) return $js_prim_get(o, k);
  const hit = $js_find_slot(o, $js_pkey(k));
  if (hit === null) return undefined;
  const sl = hit[1];
  if (!sl.a) return sl.v;
  if (sl.g === undefined) return undefined;
  return $callThis(sl.g, self, []);
}
// [[Set]]。原型链上的 setter 优先；只有数据属性可写、且接收者可扩展时才落自有槽。
function $js_setp(o, k, v) {
  if (!$js_isobj(o)) $rt_error("cannot set a property of " + $dynTag(o));
  const key = $js_pkey(k);
  const hit = $js_find_slot(o, key);
  if (hit !== null) {
    const sl = hit[1];
    if (sl.a) {
      if (sl.s === undefined) return v;
      $callThis(sl.s, o, [v]);
      return v;
    }
    if (hit[0] === o) {
      if (!sl.w) return v;
      sl.v = v;
      return v;
    }
    if (!sl.w) return v;
  }
  if (!o.ex) return v;
  $js_def_data(o, key, v, true, true, true);
  return v;
}
// 原始值上的取属性：查它那一族的原型（内建方法就住在那儿），外加 string 的 length 与下标。
function $js_prim_get(o, k) {
  const key = $js_pkey(k);
  if (o === undefined || o === null) $rt_error("cannot read '" + $js_key_str(key) + "' of " + $dynTag(o));
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
  const r = {
    objP, funP,
    arrP: new $JSObj(objP, "Array"),
    strP: new $JSObj(objP, "String"),
    numP: new $JSObj(objP, "Number"),
    boolP: new $JSObj(objP, "Boolean"),
    symP: new $JSObj(objP, "Symbol"),
    errP: new $JSObj(objP, "Error"),
    mapP: new $JSObj(objP, "Map"),
    setP: new $JSObj(objP, "Set"),
    reP: new $JSObj(objP, "RegExp"),
    iterP: new $JSObj(objP, "Iterator"),
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
  $natm(funP, "bind", 1, (t, a) => {
    const bt = a[0], pre = a.slice(1);
    return { fp: (self, args) => $callThis(t, bt, [...pre, ...args]), fp2: (ig, args) => $callThis(t, bt, [...pre, ...args]), $nm: "bound", $ln: 0 };
  });
  // Symbol.toStringTag 决定 [object X] 里的 X；没有就看 [[Class]]。
  $natm(r.iterP, "next", 0, () => $rt_error("Iterator.prototype.next is abstract"));
  // Symbol 的两格：description 是访问器（规范如此），toString 给 "Symbol(desc)"
  $js_def_acc(r.symP, "description", $nat("description", 0, (t) => $dynAsSym(t).d), undefined, false, true);
  $natm(r.symP, "toString", 0, (t) => $js_sym_str(t));
  return r;
}
function $js_obj_to_string(t) {
  if (t === undefined) return "[object Undefined]";
  if (t === null) return "[object Null]";
  const tag = $js_isobj(t) ? $js_getp(t, $js_sym_wk("toStringTag"), undefined) : undefined;
  if (typeof tag === "string") return "[object " + tag + "]";
  if ($js_isobj(t)) return "[object " + t.cl + "]";
  switch ($dynTag(t)) {
    case "list": return "[object Array]";
    case "string": return "[object String]";
    case "real": case "int": return "[object Number]";
    case "bool": return "[object Boolean]";
    case "function": return "[object Function]";
    default: return "[object Object]";
  }
}
// ---- 新对象那一格的 op 面（js_abi.js 里同名的那些）
function $js_obj_new_p(proto) { return new $JSObj(proto === undefined ? $realm().objP : proto); }
function $js_obj_proto_get(o) { return $js_isobj(o) ? o.pr : $js_proto_of_prim(o); }
function $js_obj_proto_set(o, p) {
  if ($js_isobj(o)) o.pr = p === undefined || p === null ? null : p;
  return o;
}
function $js_obj_has_own(o, k) { return $js_isobj(o) ? o.ps.has($js_pkey(k)) : false; }
function $js_obj_own_keys(kind, o) { return $js_isobj(o) ? $js_own_keys(o, kind) : []; }
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
function $js_obj_is_frozen(o) {
  if (!$js_isobj(o)) return true;
  if (o.ex) return false;
  for (const [, sl] of o.ps) if (sl.c || (!sl.a && sl.w)) return false;
  return true;
}
function $js_obj_is_sealed(o) {
  if (!$js_isobj(o)) return true;
  if (o.ex) return false;
  for (const [, sl] of o.ps) if (sl.c) return false;
  return true;
}
function $js_obj_prevent_ext(o) { if ($js_isobj(o)) o.ex = false; return o; }
function $js_obj_is_ext(o) { return $js_isobj(o) ? o.ex : false; }
// defineProperty。desc 是一格真对象；缺席的字段照规范取 false/undefined。
// 已有槽的时候只覆盖 desc 里**出现过**的字段（规范 ValidateAndApplyPropertyDescriptor）。
function $js_obj_def(o, k, desc) {
  if (!$js_isobj(o)) $rt_error("defineProperty on " + $dynTag(o));
  const key = $js_pkey(k);
  const has = (n) => $js_isobj(desc) && desc.ps.has(n);
  const get = (n) => $js_getp(desc, n, undefined);
  const old = o.ps.get(key);
  const isAcc = has("get") || has("set");
  if (old === undefined) {
    if (!o.ex) $rt_error("object is not extensible");
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
  if (!old.c && !(has("value") && !old.a && old.w)) {
    if (has("configurable") && $js_truthy(get("configurable"))) $rt_error("cannot redefine property");
    if (has("enumerable") && $js_truthy(get("enumerable")) !== old.e) $rt_error("cannot redefine property");
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
function $js_obj_desc(o, k) {
  if (!$js_isobj(o)) return undefined;
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
function $js_obj_del_p(o, k) {
  if (!$js_isobj(o)) return true;
  const key = $js_pkey(k), sl = o.ps.get(key);
  if (sl === undefined) return true;
  if (!sl.c) return false;
  o.ps.delete(key);
  return true;
}
function $js_obj_has_p(o, k) { return $js_isobj(o) ? $js_find_slot(o, $js_pkey(k)) !== null : $js_prim_get(o, k) !== undefined; }
// Object.fromEntries：走一遍迭代（数组、Map、自定义可迭代对象都收），每一项按 [k, v] 取。
function $js_obj_from_entries(pairs) {
  const o = $js_obj_new();
  for (const p of $js_iter(pairs)) $js_setp(o, $js_idx_get(p, 0), $js_idx_get(p, 1));
  return o;
}
function $js_realm_proto(name) {  const r = $realm();
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
    default: $rt_error("no such builtin prototype: " + name);
  }
}
// instanceof：走原型链，先问 Symbol.hasInstance。
function $js_instanceof(v, ctor) {
  const hi = $js_isobj(ctor) ? $js_getp(ctor, $js_sym_wk("hasInstance"), undefined) : undefined;
  if (hi !== undefined && hi !== null) return $js_truthy($callThis(hi, ctor, [v]));
  const proto = $js_isobj(ctor) ? $js_getp(ctor, "prototype", undefined) : undefined;
  if (!$js_isobj(proto)) $rt_error("right-hand side of 'instanceof' is not callable");
  let cur = $js_isobj(v) ? v.pr : null;
  while (cur !== null && cur !== undefined) {
    if (cur === proto) return true;
    cur = $js_isobj(cur) ? cur.pr : null;
  }
  return false;
}
// 迭代器协议。iterProto 那一格是给内建迭代器用的；这一条是"按协议驱动一个对象"。
function $js_iter_proto(v) {
  const f = $js_isobj(v) ? $js_getp(v, $js_sym_wk("iterator"), undefined) : $js_prim_get(v, $js_sym_wk("iterator"));
  if (f === undefined || f === null) $rt_error($dynTag(v) + " is not iterable");
  return $callThis(f, v, []);
}
function $js_iter_next(it) {
  const f = $js_getp(it, "next", undefined);
  const r = $callThis(f, it, []);
  if (!$js_isobj(r)) $rt_error("iterator result is not an object");
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
function $js_map_keys(m) { return [...$js_map_of(m).values()].map((p) => p[0]); }
function $js_map_values(m) { return [...$js_map_of(m).values()].map((p) => p[1]); }
function $js_map_entries(m) { return [...$js_map_of(m).values()]; }

function $js_set_new() { return new $JsSet(); }
function $js_set_size(s) { return $js_set_of(s).size; }
function $js_set_has(s, v) { return $js_set_of(s).has($js_key(v)); }
function $js_set_add(s, v) { $js_set_of(s).set($js_key(v), v); return s; }
function $js_set_delete(s, v) { return $js_set_of(s).delete($js_key(v)); }
function $js_set_items(s) { return [...$js_set_of(s).values()]; }
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
  const src = $dynTag(init) === "Set" ? $js_set_items(init) : $js_arr_of(init);
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
  if (op === "F") return Math.fround(x);
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
  // 真对象（ADR-0020 P1）：自有、可枚举、字符串键，取值走 [[Get]]（访问器要被触发）。
  // toJSON 还没接（P4 那一片）。
  if (t === "object") {
    let out = "{", first = true;
    const sep = $js_json_nl(gap, depth + 1);
    for (const k of $js_own_keys(v, "e")) {
      const s = $js_json_val($js_json_apply(rep, k, $js_getp(v, k, undefined)), rep, gap, depth + 1);
      if (s === undefined) continue;
      if (!first) out += ",";
      first = false;
      out += sep + $js_json_quote(k) + (gap > 0 ? ": " : ":") + s;
    }
    return first ? "{}" : out + $js_json_nl(gap, depth) + "}";
  }
  $rt_error("do not know how to serialize a " + t);
}
function $js_json_stringify(v, rep, indent) {
  let gap = 0;
  if ($dynTag(indent) === "real" && indent > 0) gap = Math.min(Math.trunc(indent), 10);
  return $js_json_val($js_json_apply(rep, "", v), rep, gap, 0);
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
// 解析失败是硬错（omni: runtime error），不是能 catch 的 SyntaxError：ADR-0007
// 决定 1 里 throw 是静态降级的，而这个 op 里没有用户回调可以往 pending 槽里放东西。
// 游标是 { s, i } 一个记录：这一族函数互相递归，下标要共享。
function $js_json_eoi() { $rt_error("unexpected end of JSON input"); }
function $js_json_bad(z) {
  const c = z.s.charCodeAt(z.i);
  const shown = c >= 0x20 && c < 0x7f
    ? "'" + z.s[z.i] + "'"
    : "\\u" + c.toString(16).padStart(4, "0");
  $rt_error("unexpected token " + shown + " in JSON at position " + z.i);
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
// 实参先按 JS 的口径转字符串（JSON.parse(5) 是 5，不是报错），再从头读一格值，
// 末尾除了空白不许还有东西。
function $js_json_parse(text) {
  const z = { s: $js_str(text), i: 0 };
  const v = $js_json_read(z);
  $js_json_ws(z);
  if (z.i !== z.s.length) {
    $rt_error("unexpected non-whitespace character after JSON at position " + z.i);
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
function $js_err_new(msg, cls) {
  const o = $js_obj_new();
  $js_obj_set(o, "$cls", cls);
  $js_obj_set(o, "message", msg);
  return o;
}
function $js_is_a(v, n) {
  const t = $dynTag(v);
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
function $js_re_new(src, flags) { return new $JsRe($js_asS16(src), $js_asS16(flags)); }
// 正则对象上的 exec，照 ECMA-262 22.2.7.2：带 g 才用 lastIndex，找到就把它推到匹配的末尾
// （**不加 1** —— 空匹配在 JS 里就是停在原地，那是调用方的事，这里不许自己"修好"），
// 没找到就归 0。不带 g 的一律从 0 起，也不动 lastIndex。
// 结果是一格 list：整体匹配在 0、捕获组依次在后。JS 的 exec 结果上还挂着 index / input，
// 而这个值域里 list 带不了属性（决策 18）—— 那两个取不到，是画出来的边界。
function $js_re_exec(rd, sd) {
  if ($dynTag(rd) !== "regexp") $rt_error($dynTag(rd) + " is not a regexp");
  const s = $js_asS16(sd);
  const g = rd.flags.includes("g");
  const at = g ? rd.li : 0;
  const m = at < 0 ? null : $js_re_find($js_re_get(rd.src, rd.flags), s, at);
  if (m === null) {
    if (g) rd.li = 0;
    return null;
  }
  if (g) rd.li = m.index + m[0].length;
  const out = [];
  for (let i = 0; i < m.length; i++) out.push(m[i] === undefined ? undefined : m[i]);
  return out;
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
function $js_bytes(v, who) {
  if ($dynTag(v) !== "bytes") $rt_error(who + " expects a byte buffer, found " + $dynTag(v));
  return v;
}
function $js_buf_new(n) {
  const len = $js_real(n, "new ArrayBuffer");
  if (!Number.isInteger(len) || len < 0) $rt_error("invalid byte length");
  return new $JsBytes(new Uint8Array(new ArrayBuffer(len)));
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
function $js_buf_set(dst, src) {
  const d = $js_bytes(dst, ".set").u8, s = $js_bytes(src, ".set").u8;
  if (s.byteLength > d.byteLength) $rt_error("byte-buffer .set source is too long");
  d.set(s);
  return undefined;
}
function $js_buf_fill(b, v) {
  $js_bytes(b, ".fill").u8.fill($js_real(v, ".fill") & 255);
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
