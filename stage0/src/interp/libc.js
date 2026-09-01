// Omni stage0 — 解释器这条腿上的 libc（ADR-0017 第六刀第五片）
//
// ## 为什么要有这一份，而不是「转手宿主的 libc」
//
// C 前端的终点是能编译 tinycc 自己的源码，而那份源码从第一行起就在用 `printf`、
// `strlen`、`memcpy`。这些函数的实参**大半是指向线性内存的指针** —— 而线性内存是我们
// 自己的一块 ArrayBuffer，宿主的 libc 看不见它。所以「按名字查一张函数指针表、把参数
// 原样转过去」这条路在解释器上根本走不通（`interp.js` 的 CCALL 分支本来就是这么写的：
// 解释执行是 oracle，它不该假装能做 FFI）。
//
// 走通的路是**照 wasm 的办法**：宿主提供一个模块，它的每个函数都知道怎么读写那块线性
// 内存。wasi-libc 与 emscripten 的 JS 库都是这个结构。这一份就是它的最小版：
// 参数进来是宿主值（整数是 BigInt、浮点是 Number），指针参数是**字节偏移**，
// 函数自己去线性内存里读写。
//
// ## 与真的 libc 的关系
//
// 自带后端那条路（第 9-11 步）会去链接真的 libc，那时这一份就只剩「解释器专用」的身份。
// 两条腿必须给出**逐字节相同的 stdout** —— 这也正是第六刀从这一片起的 oracle：
// 之前只比 `tcc -run` 的退出码（一个字节），从这里起比 stdout 的每一个字节。
// 所以 `%d`/`%s`/宽度/精度这些格式规则必须照 C 的规矩来，不能照 JS 的习惯。
//
// **不能拿 tcc 对账的那一格**（第四片记下的那份清单在长）：
//   - `%p`：地址本身不同（我们的是线性内存偏移，tcc 的是进程地址）。
// 浮点原先也在这份清单里，第十四片之后 `%f`/`%e`/`%g` 已经逐字节对上了（见 `fText`），
// 第二十一片补上了 `%a`（见 `aText`）—— 于是这份清单只剩 `%p` 一格。

import { memLoad, memStore, printBytes, flushOut, memSize, memGrow } from './builtin.js';
import { stderrBytes as hostStderr, readBinary, writeBinary } from '../host/native.js';

/**
 * `exit` 抛的那个信号（第六刀第十七片）。
 *
 * C 的 `exit` 是「从任意深处一路退出去」，而这条腿上的控制流是**结构化**的
 * （BLOCK/LOOP/IF + 往外数几层的 BR，ADR-0017 第六刀的四条偏离之一）—— 没有哪个 `BR`
 * 能跨过函数边界。所以退出这件事不走 MIR，走宿主：libc 抛，跑模块的那一层收
 * （`mir/interp.js` 的 `runMirModule`）。wasm 那边是同一个形状（wasi 的 `proc_exit`
 * 也是宿主 trap 掉整个实例）；自带后端那条路上它就是真的 `exit` 系统调用。
 *
 * 它**不是** `InterpFail`：那一类是「程序错了」（退出码 70），而 `exit(3)` 是程序
 * 正常地要求退出码 3。所以 CCALL 那层的 try/catch 必须把它原样放过去。
 */
export class ExitCall extends Error {
  constructor(code) {
    super(`exit(${code})`);
    this.code = code;
  }
}

/** 从线性内存里读一个 C 字符串（读到 0 为止）。回 JS 字符串，一个字符一个字节。 */
export function readCStr(addr) {
  let s = '';
  let p = BigInt(addr);
  for (;;) {
    const b = Number(memLoad('i8u', p, 0));
    if (b === 0) break;
    s += String.fromCharCode(b);
    p += 1n;
  }
  return s;
}

/** 把一个 JS 字符串（每个字符一个字节）写进线性内存，补一个 0。回写了多少字节（不含 0）。 */
function writeCStr(addr, s) {
  let p = BigInt(addr);
  for (let i = 0; i < s.length; i++) {
    memStore('i8', p, 0, BigInt(s.charCodeAt(i) % 256));
    p += 1n;
  }
  memStore('i8', p, 0, 0n);
  return s.length;
}

/** 无符号的十进制/八进制/十六进制。`bits` 是那一格的宽度（32 或 64）。 */
function uText(v, bits, base, upper) {
  const u = BigInt.asUintN(bits, v);
  const s = u.toString(base);
  return upper ? s.toUpperCase() : s;
}

/**
 * 一个转换说明的宽度与精度处理（C11 7.21.6.1）。顺序有讲究：
 *   1. 精度先作用在**数字或字符串本身**上（`%.3d` 是「至少 3 位数字」，`%.3s` 是「最多 3 个字符」）；
 *   2. 符号/前缀（`+`、`-`、`0x`）加在精度之后；
 *   3. `0` 标志把零填在**符号之后**，`-` 与空格填在两侧。
 * 反过来做会让 `%+05d` 印成 `00+42` 而不是 `+0042`。
 */
function padTo(body, sign, spec) {
  let s = body;
  if (spec.prec >= 0 && spec.numeric) {
    while (s.length < spec.prec) s = '0' + s;
  }
  const head = sign + spec.prefix;
  let n = spec.width - head.length - s.length;
  if (n < 0) n = 0;
  if (spec.left) return head + s + ' '.repeat(n);
  // `0` 标志对字符串无效，而且给了精度的整数也不再补零（C11 7.21.6.1 第 5 段）
  if (spec.zero && spec.numeric && spec.prec < 0) return head + '0'.repeat(n) + s;
  return ' '.repeat(n) + head + s;
}

/**
 * 浮点转换的指数部分：`e+05` 那一段。C 要求**至少两位**（C11 7.21.6.1 第 8 段），
 * 而 JS 的 `toExponential` 印的是一位（`1.5e+0`）—— 差的就是这个补零。
 */
function expText(e, upper) {
  const s = (e < 0 ? -e : e).toString(10);
  return (upper ? 'E' : 'e') + (e < 0 ? '-' : '+') + (s.length < 2 ? '0' + s : s);
}

/** 去掉小数部分末尾的零，全没了就连小数点一起去掉（`%g` 的规则）。 */
function trimZeros(s) {
  if (s.indexOf('.') < 0) return s;
  let t = s;
  while (t.length > 0 && t[t.length - 1] === '0') t = t.slice(0, t.length - 1);
  if (t[t.length - 1] === '.') t = t.slice(0, t.length - 1);
  return t;
}

/**
 * `%f` / `%e` / `%g` 的**数字部分**（不带符号，符号由 `padTo` 那一步加）。
 *
 * 骨架借宿主的 `toFixed` / `toExponential`：它们的舍入是「在这个 double 的**精确**
 * 十进制值上取最近」，与 C 的 printf 同一件事。三处要自己补：
 *   1. 指数至少两位（`expText`）；
 *   2. `%g` 挑形态的规则（指数 < -4 或 >= 精度走 `%e`，否则走 `%f`），
 *      而且精度是**有效数字**位数，不是小数位数；
 *   3. `%g` 去掉末尾的零（`#` 标志时不去）。
 *
 * 有一格与 C 有分歧、而且**不打算**追平：正好落在两个十进制数正中间的那些值
 * （`%.2f` 的 0.125）。C 按当前舍入模式（默认「向偶数」）给 0.12，宿主的 `toFixed`
 * 给 0.13。这种值要求「double 的精确值在切点上恰好终止」，测试里避开它；
 * 真要追平得自己写一份任意精度的十进制展开，那是浮点自己那一片的事。
 */
function fText(x, conv, spec) {
  const upper = conv === 'F' || conv === 'E' || conv === 'G';
  const kind = conv === 'F' ? 'f' : (conv === 'E' ? 'e' : (conv === 'G' ? 'g' : conv));
  const prec = spec.prec < 0 ? 6 : spec.prec;
  const v = x < 0 ? -x : x;
  if (kind === 'f') {
    let s = v.toFixed(prec);
    if (spec.alt && prec === 0) s += '.';
    return s;
  }
  if (kind === 'e') {
    const t = v.toExponential(prec);
    const at = t.indexOf('e');
    let mant = t.slice(0, at);
    if (spec.alt && prec === 0) mant += '.';
    return mant + expText(Number(t.slice(at + 1)), upper);
  }
  // `%g`：精度 0 当 1（C11 7.21.6.1 第 8 段）
  const p = prec === 0 ? 1 : prec;
  /* 指数要在**已经舍到 p 位有效数字之后**再读 —— 9.99 按 2 位有效数字是 1.0e+01，
   * 指数从 0 变成了 1，而 `%g` 挑形态看的正是这个变化之后的指数。 */
  const t = v.toExponential(p - 1);
  const e = Number(t.slice(t.indexOf('e') + 1));
  if (e < -4 || e >= p) {
    const at = t.indexOf('e');
    let mant = t.slice(0, at);
    if (!spec.alt) mant = trimZeros(mant);
    return mant + expText(e, upper);
  }
  const s = v.toFixed(p - 1 - e);
  return spec.alt ? s : trimZeros(s);
}

/**
 * 变参区上的游标（第六刀第十六片的 ABI）：一格 8 字节，读的宽度按**要的类型**。
 *
 * 这就是真的 varargs：类型信息只在格式串里，而格子等宽 —— 写的那一侧
 * （`tccgen.js` 的 `vaBlock`）只写它自己那几个字节，读的这一侧按转换说明去读。
 * 从前这一格是「CCALL 的实参数组」，那等于假装宿主能看见 C 的实参表；
 * 换成变参区之后，`printf` 与它在真的 ABI 上做的事一模一样。
 */
/**
 * `%a` / `%A` 的数字部分（不带符号、也不带 `0x`）：把 double 的**位模式**印成
 * `1.8p+0` 这种形状。它与 `%f/%e/%g` 不是一条路 —— 那三种是十进制、靠宿主的
 * `toFixed`/`toExponential`；这一种是二进制的直读，宿主没有现成函数，得自己拆。
 *
 * 规则（C11 7.21.6.1 第 8 段，细节按 oracle 量出来的）：
 *   - 首位数字是 1，**次正规数也规格化**（`5e-324` 印 `0x1p-1074`，不是 `0x0.0…1p-1022`）。
 *   - 不给精度就印「够用的位数」：13 个十六进制位去掉末尾的零。
 *   - 给了精度就round到那么多位，**半值向偶**（`%.0a`：1.5 是 `0x1p+0`、1.75 是 `0x2p+0`）。
 *     进位落在**首位数字**上（于是有 `0x2.0p+0`），指数不跟着动。
 *   - 指数是十进制带符号、**不补两位**（`p+0`，与 `%e` 的 `e+00` 不同）。
 *   - 零是 `0x0p+0`；`#` 要求小数点即使没有小数位也留着。
 */
function aText(x, upper, spec) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x, true);
  const bits = dv.getBigUint64(0, true);
  const rawExp = Number((bits >> 52n) & 0x7ffn);
  let man = bits & 0xfffffffffffffn;      // 52 位小数部分
  let lead = 1n;
  let e = rawExp - 1023;
  if (rawExp === 0) {
    if (man === 0n) {
      lead = 0n;
      e = 0;
    } else {
      /* 次正规：把最高位挪上去当首位。man = 2^p + r，值 = 2^(p-1074) * (1 + r/2^p)。 */
      let p = 51;
      while ((man & (1n << BigInt(p))) === 0n) p--;
      e = p - 1074;
      man = (man ^ (1n << BigInt(p))) << BigInt(52 - p);
    }
  }
  let digits;
  if (spec.prec < 0) {
    digits = man.toString(16).padStart(13, '0').replace(/0+$/, '');
  } else if (spec.prec >= 13) {
    digits = man.toString(16).padStart(13, '0').padEnd(spec.prec, '0');
  } else {
    const drop = BigInt((13 - spec.prec) * 4);
    let kept = man >> drop;
    const rem = man & ((1n << drop) - 1n);
    const half = 1n << (drop - 1n);
    if (rem > half || (rem === half && (kept & 1n) === 1n)) {
      kept++;
      if (kept === 1n << BigInt(spec.prec * 4)) {   // 进位溢出到首位数字上
        kept = 0n;
        lead++;
      }
    }
    digits = spec.prec === 0 ? '' : kept.toString(16).padStart(spec.prec, '0');
  }
  const point = digits.length > 0 || spec.alt ? '.' : '';
  const body = `${lead.toString(16)}${point}${digits}p${e < 0 ? '-' : '+'}${e < 0 ? -e : e}`;
  return upper ? body.toUpperCase() : body;
}

function vaCursor(addr) {
  let p = BigInt(addr);
  const take = (kind) => {
    const v = memLoad(kind, p, 0);
    p += 8n;
    return v;
  };
  return {
    // 整数一格：32 位的按 i32 读（`int` 只写了 4 个字节），64 位的按 i64
    int: (bits) => take(bits === 64 ? 'i64' : 'i32s'),
    ptr: () => take('i64'),
    real: () => take('f64'),
  };
}

/**
 * `printf` 的格式化。`fmt` 是格式串（已经从内存里读出来），`va` 是**变参区的地址**。
 * 回格式化好的字符串。
 *
 * 变参那一侧的类型信息**只在格式串里**（C 就是这么设计的），所以这儿是唯一知道
 * 「下一格是个指针还是个整数」的地方 —— 与真的 libc 处境完全一样。
 */
export function cFormat(fmt, va) {
  let out = '';
  let i = 0;
  const ap = vaCursor(va);

  while (i < fmt.length) {
    const c = fmt.charCodeAt(i);
    if (c !== 37) { out += fmt[i]; i++; continue; }  // '%'
    i++;
    if (i >= fmt.length) throw new Error('printf: 格式串末尾的 %');
    if (fmt.charCodeAt(i) === 37) { out += '%'; i++; continue; }

    const spec = { left: false, zero: false, plus: false, space: false, alt: false,
      width: 0, prec: -1, prefix: '', numeric: true };
    // 标志
    for (;;) {
      const f = fmt[i];
      if (f === '-') { spec.left = true; i++; continue; }
      if (f === '0') { spec.zero = true; i++; continue; }
      if (f === '+') { spec.plus = true; i++; continue; }
      if (f === ' ') { spec.space = true; i++; continue; }
      if (f === '#') { spec.alt = true; i++; continue; }
      break;
    }
    // 宽度
    if (fmt[i] === '*') {
      spec.width = Number(ap.int(32));
      if (spec.width < 0) { spec.left = true; spec.width = -spec.width; }
      i++;
    } else {
      while (i < fmt.length && fmt.charCodeAt(i) >= 48 && fmt.charCodeAt(i) <= 57) {
        spec.width = spec.width * 10 + (fmt.charCodeAt(i) - 48);
        i++;
      }
    }
    // 精度
    if (fmt[i] === '.') {
      i++;
      spec.prec = 0;
      if (fmt[i] === '*') {
        spec.prec = Number(ap.int(32));
        i++;
      } else {
        while (i < fmt.length && fmt.charCodeAt(i) >= 48 && fmt.charCodeAt(i) <= 57) {
          spec.prec = spec.prec * 10 + (fmt.charCodeAt(i) - 48);
          i++;
        }
      }
    }
    /* 长度修饰符。**只影响宽度**（32 位还是 64 位）—— `hh`/`h` 在变参里已经被默认实参
     * 提升拉成 int 了，所以它们与不写一样；`l`/`ll`/`z`/`j`/`t` 是 64 位。 */
    let bits = 32;
    for (;;) {
      const f = fmt[i];
      if (f === 'h') { i++; continue; }
      if (f === 'l' || f === 'z' || f === 'j' || f === 't') { bits = 64; i++; continue; }
      if (f === 'L') { i++; continue; }
      break;
    }

    const conv = fmt[i];
    i++;
    if (conv === 'd' || conv === 'i') {
      const v = BigInt.asIntN(bits, ap.int(bits));
      const neg = v < 0n;
      const body = (neg ? -v : v).toString(10);
      out += padTo(body, neg ? '-' : (spec.plus ? '+' : (spec.space ? ' ' : '')), spec);
      continue;
    }
    if (conv === 'u') {
      out += padTo(uText(ap.int(bits), bits, 10, false), '', spec);
      continue;
    }
    if (conv === 'o') {
      const body = uText(ap.int(bits), bits, 8, false);
      if (spec.alt && body[0] !== '0') spec.prefix = '0';
      out += padTo(body, '', spec);
      continue;
    }
    if (conv === 'x' || conv === 'X') {
      const v = ap.int(bits);
      const body = uText(v, bits, 16, conv === 'X');
      if (spec.alt && v !== 0n) spec.prefix = conv === 'X' ? '0X' : '0x';
      out += padTo(body, '', spec);
      continue;
    }
    if (conv === 'c') {
      spec.numeric = false;
      out += padTo(String.fromCharCode(Number(BigInt.asUintN(8, ap.int(32)))), '', spec);
      continue;
    }
    if (conv === 's') {
      spec.numeric = false;
      let s = readCStr(ap.ptr());
      if (spec.prec >= 0 && s.length > spec.prec) s = s.slice(0, spec.prec);
      out += padTo(s, '', spec);
      continue;
    }
    if (conv === 'p') {
      /* 地址本身与 tcc 不同（我们的是线性内存偏移），所以这一格**不能对账**。
       * 形状照 glibc/macOS：`0x` 加小写十六进制，空指针印 `0x0`。 */
      spec.numeric = false;
      out += padTo('0x' + uText(ap.ptr(), 64, 16, false), '', spec);
      continue;
    }
    if (conv === 'f' || conv === 'F' || conv === 'e' || conv === 'E'
      || conv === 'g' || conv === 'G' || conv === 'a' || conv === 'A') {
      /* 变参里的浮点已经被默认实参提升拉成 double（`float` 也是），所以变参区那一格
       * 就是 8 个字节的 f64 —— 按 f64 读，与写的那一侧（`vaBlock`）对上。 */
      const x = ap.real();
      const hex = conv === 'a' || conv === 'A';
      if (!Number.isFinite(x)) {
        /* `inf` / `nan`：宽度照用，但**不补零**（C11 7.21.6.1 第 8 段最后一句）。
         * 大写的转换印大写 —— `%A` 也算大写，而且它连 `0x` 都不印。 */
        spec.numeric = false;
        const body = Number.isNaN(x) ? 'nan' : 'inf';
        const up = conv === 'F' || conv === 'E' || conv === 'G' || conv === 'A';
        const sign = x < 0 ? '-' : (spec.plus ? '+' : (spec.space ? ' ' : ''));
        out += padTo(up ? body.toUpperCase() : body, sign, spec);
        continue;
      }
      /* 负号看的是 `x < 0` 之外还有 `-0.0`：C 印 `-0.000000`，而 `-0 < 0` 是假。 */
      const neg = x < 0 || Object.is(x, -0);
      /* 浮点这一格的「精度」已经在 `fText`/`aText` 里用掉了（小数位数 / 有效数字 /
       * 十六进制位数），不能再让 `padTo` 拿它去补前导零 —— 所以按非数字对待。 */
      spec.numeric = false;
      const v = neg ? -x : x;
      const body = hex ? aText(v, conv === 'A', spec) : fText(x, conv, spec);
      /* `%a` 的 `0x` 是**前缀**（与 `%#x` 同一格）：补空格在它左边、补零在它右边。 */
      const pfx = hex ? (conv === 'A' ? '0X' : '0x') : '';
      spec.prefix = pfx;
      const sign = neg ? '-' : (spec.plus ? '+' : (spec.space ? ' ' : ''));
      if (spec.zero && !spec.left) {
        /* `%08.2f` 的零补在**符号之后**，而 `padTo` 的补零那一支被上面关掉了，
         * 所以这一格自己补 —— 数字部分补零是安全的（它已经有小数点了）。 */
        let n = spec.width - sign.length - pfx.length - body.length;
        if (n < 0) n = 0;
        out += sign + pfx + '0'.repeat(n) + body;
        continue;
      }
      out += padTo(body, sign, spec);
      continue;
    }
    if (conv === 'a' || conv === 'A') {
      throw new Error(`第六刀：printf 的十六进制浮点 '%${conv}' 还没到`);
    }
    throw new Error(`printf: 不认识的转换 '%${conv}'`);
  }
  return out;
}

/* ------------------------------------------------------------------ 堆
 *
 * `malloc` 一族（第六刀第十五片）。**所有簿记都在线性内存里**，宿主这边一个字节的状态
 * 都不留 —— 于是「换成真的 malloc」是把这几个函数换掉，版图与不变量一个字都不用改，
 * 而「上一次运行留下的堆」也不可能漏到下一次（内存每次 `memInit` 都是新的）。
 *
 * 版图（前端定的，见 tccgen.js 末尾那张表）：堆从影子栈之上的**下一个页边界**起。
 *   [heapBase, +8)      brk：已经用掉的那一段的末尾
 *   [heapBase+8, +16)   留空（让块头落在 16 的整数倍上）
 *   [heapBase+16, brk)  一串块：每块 16 字节块头 + 载荷
 * 块头：`[+0] i64 载荷字节数（16 的整数倍）`、`[+8] i64 在用吗`。
 * 隐式空闲链表（块头就是链表 —— 顺着走就能找到下一块），首次适配，free 之后合并相邻的
 * 空闲块。这是 K&R 那一版的形状：够 tinycc 用，而且每一步都看得懂。
 *
 * `heapBase` 由入口函数在 `main` 之前用一条 CCALL 交过来（`__omni_heap_init`）——
 * 宿主这边不猜版图。没用到堆的模块连这条 CCALL 都不发。 */

const HEAP_HDR = 16n;    // 块头字节数（也是对齐粒度）
let heapBase = 0n;       // 0 = 还没初始化（也就是这个模块没用到堆）

function heapNeed(n) {
  /* `malloc(0)` 也给一块真地址（C11 7.22.3 允许两种，glibc 与 tcc 的 libc 都给地址）——
   * 回 NULL 会让「分配了就往里写」的常见写法在这一格上崩，而那不是它的错。 */
  const w = n < 16n ? 16n : n;
  return (w + 15n) / 16n * 16n;
}

function brkGet() { return memLoad('i64', heapBase, 0); }
function brkSet(v) { memStore('i64', heapBase, 0, v); }

/** 相邻的空闲块并成一块。free 之后走一遍 —— O(块数)，但没有它碎片会一路长。 */
function heapCoalesce() {
  const end = brkGet();
  let p = heapBase + HEAP_HDR;
  while (p < end) {
    if (memLoad('i64', p, 8) === 0n) {
      for (;;) {
        const nxt = p + HEAP_HDR + memLoad('i64', p, 0);
        if (nxt >= end || memLoad('i64', nxt, 8) !== 0n) break;
        memStore('i64', p, 0, memLoad('i64', p, 0) + HEAP_HDR + memLoad('i64', nxt, 0));
      }
    }
    // 大小要**当场再读一遍**：上面那个循环可能刚把它改大了
    p = p + HEAP_HDR + memLoad('i64', p, 0);
  }
}

function heapAlloc(bytes) {
  if (heapBase === 0n) {
    throw new Error('libc: malloc 之前堆没有初始化（入口那条 __omni_heap_init 没发？）');
  }
  const need = heapNeed(bytes);
  const end = brkGet();
  /* 首次适配。够大就用，**多得下一整块**才切开 —— 切出一个装不下块头的碎片
   * 等于把它永久丢掉。 */
  let p = heapBase + HEAP_HDR;
  while (p < end) {
    const size = memLoad('i64', p, 0);
    if (memLoad('i64', p, 8) === 0n && size >= need) {
      if (size >= need + HEAP_HDR + 16n) {
        const rest = p + HEAP_HDR + need;
        memStore('i64', rest, 0, size - need - HEAP_HDR);
        memStore('i64', rest, 8, 0n);
        memStore('i64', p, 0, need);
      }
      memStore('i64', p, 8, 1n);
      return p + HEAP_HDR;
    }
    p = p + HEAP_HDR + size;
  }
  // 往上推 brk。不够就 MGROW（页数向上取整；wasm 的 memory.grow 是同一个形状）
  const want = end + HEAP_HDR + need;
  const have = memSize() * 65536n;
  if (want > have) {
    const pages = (want - have + 65535n) / 65536n;
    if (memGrow(pages) === -1n) return 0n;   // 真的没内存了：回 NULL，与 C 一致
  }
  memStore('i64', end, 0, need);
  memStore('i64', end, 8, 1n);
  brkSet(want);
  return end + HEAP_HDR;
}

function heapFree(p) {
  if (p === 0n) return;      // `free(NULL)` 什么都不做（C11 7.22.3.3 第 2 段）
  memStore('i64', p - HEAP_HDR, 8, 0n);
  heapCoalesce();
}

/* ------------------------------------------------------------------ 字符串到数
 *
 * `strtol` 一族（第八刀第四片）。选它们的理由是 tinycc 的源码在用，而那份源码是
 * 这一刀的终点。
 *
 * **不能拿 tcc 对账的一格**：溢出。C 说溢出时回 `LONG_MAX`/`LONG_MIN`（或
 * `ULONG_MAX`）并把 `errno` 设成 `ERANGE`；我们回同样的值，但**没有 `errno`** ——
 * 那要一个每线程的变量与一份 `<errno.h>`，独立一格。所以用例避开溢出的输入。
 */

const SPACE = ' \t\n\v\f\r';

/** 一位十六进制以内的数字的值，不是就回 -1（`0`-`9`、`a`-`z`、`A`-`Z`）。 */
function digitVal(ch) {
  const c = ch.charCodeAt(0);
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 122) return c - 97 + 10;
  if (c >= 65 && c <= 90) return c - 65 + 10;
  return -1;
}

/**
 * `strtol` / `strtoul` 共用的那一遍（C11 7.22.1.4）。回 `{ v, used }`：
 * `v` 是**还没截断的**真值（带符号），`used` 是吃掉了多少个字符
 * （一个有效数字都没有的时候是 0 —— 那时 `endptr` 要回原地址）。
 */
function scanInt(s, base) {
  let i = 0;
  while (i < s.length && SPACE.indexOf(s[i]) >= 0) i++;
  let neg = false;
  if (s[i] === '+' || s[i] === '-') {
    neg = s[i] === '-';
    i++;
  }
  let b = base;
  if (b === 0) {
    if (s[i] === '0' && (s[i + 1] === 'x' || s[i + 1] === 'X')) { b = 16; i += 2; }
    else if (s[i] === '0') { b = 8; i++; }        // 这个 `0` 本身就是一位有效数字
    else b = 10;
  } else if (b === 16 && s[i] === '0' && (s[i + 1] === 'x' || s[i + 1] === 'X')) {
    i += 2;
  }
  /* 上面那两处 `0x` 是**试探性**的：`"0xz"` 里的 `0` 算一位有效数字、`x` 不算，
   * 于是回的是 0 而 `endptr` 指着 `x`。所以数字从哪儿开始要单独记。 */
  const digitsFrom = i;
  let v = 0n;
  const bb = BigInt(b);
  while (i < s.length) {
    const d = digitVal(s[i]);
    if (d < 0 || d >= b) break;
    v = v * bb + BigInt(d);
    i++;
  }
  if (i === digitsFrom) {
    /* 一位有效数字都没有。`"0x"` 这种：退回到那个 `0` 上（它是有效的）。 */
    if (digitsFrom >= 2 && (s[digitsFrom - 1] === 'x' || s[digitsFrom - 1] === 'X')) {
      return { v: 0n, used: digitsFrom - 1 };
    }
    return { v: 0n, used: 0 };
  }
  return { v: neg ? -v : v, used: i };
}

/** `endptr` 非空就写「停在哪儿」（`used` 是 0 时写原地址，C 就是这么说的）。 */
function putEnd(endp, addr, used) {
  if (endp === 0n) return;
  memStore('i64', endp, 0, BigInt(addr) + BigInt(used));
}

const LONG_MAX = (1n << 63n) - 1n;
const LONG_MIN = -(1n << 63n);
const ULONG_MAX = (1n << 64n) - 1n;

/* ------------------------------------------------------------------ errno
 *
 * `errno`（第八刀第八片）。C 要求它是一个**可改的左值**（`errno = 0` 得能写），
 * 所以宿主这边放一个 JS 变量是不行的 —— 函数回不出左值。
 *
 * 走的是 glibc 的形状：`errno` 是宏，展开成 `(*__omni_errno_location())`，
 * 那个函数回一个指进**线性内存**的 `int *`。那一格由**前端**在 data 段里留
 * （版图是前端定的，见 tccgen.js 末尾那张表），开跑前用一条 `__omni_errno_init`
 * 把地址交过来 —— 与第十五片的 `__omni_heap_init` 完全同一个形状：
 * 宿主不猜版图，没用到的模块连那条 CCALL 都不发。
 *
 * 出生时是 0：线性内存出生全是 0，而 C 正好要求「程序启动时 errno 是 0」
 * （C11 7.5 第 3 段）。所以那一格不写一个字节 data。
 */
let errnoAddr = 0n;

/** libc 里出错的地方写它。**没装上就什么都不做** —— 那说明这个程序没用 errno。 */
function setErrno(v) {
  if (errnoAddr !== 0n) memStore('i32', errnoAddr, 0, BigInt(v));
}

/* ------------------------------------------------------------------ 回头的那扇门
 *
 * `qsort` / `bsearch`（第八刀第五片）与前面每一条都不同：它们**回头调 MIR**。
 * 到这一片之前 CCALL 是一扇单向门（MIR 调宿主），而比较器是 C 里的一个函数指针。
 *
 * 门开在这儿而不是在 `interp.js` 里，理由是方向：libc 是被调的一方，它需要一个
 * 「拿函数指针值 + 实参数组，回返回值」的回调。跑模块的那一层（`runMirModule`）
 * 在开跑前把它装上 —— 那一层认得函数表，而这一份不认得（也不该认得：
 * 函数指针值的编码是 MIR 的事，定在 `ir.js` 的 `CALLI` 上）。
 *
 * wasm 那边是同一个形状：宿主模块通过 `table` 回头调实例里的函数。
 */
let callFnPtr = null;

/**
 * 装上「回头调 MIR」的那条路。`fn(ptr, args)`：`ptr` 是函数指针值（宿主的 BigInt），
 * `args` 是宿主值数组，回返回值。跑模块的那一层在开跑前调一次。
 */
export function setFnPtrCaller(fn) { callFnPtr = fn; }

/** 调一次 C 的回调。门没装上就抛 —— 那是装配错了，不是程序错了。 */
function callback(ptr, args) {
  if (callFnPtr === null) throw new Error('libc: 回调那扇门没装上（setFnPtrCaller）');
  return callFnPtr(ptr, args);
}

/** 线性内存上两块**不重叠**的 `n` 字节对调。给 `qsort` 用。 */
function swapBytes(p, q, n) {
  for (let i = 0n; i < n; i++) {
    const x = memLoad('i8u', p + i, 0);
    memStore('i8', p + i, 0, memLoad('i8u', q + i, 0));
    memStore('i8', q + i, 0, x);
  }
}

/* ------------------------------------------------------------------ 三条标准流
 *
 * `FILE` 与 `stdout` / `stderr`（第八刀第九片）。这一片**只有那三条标准流**，
 * 真的文件（`fopen`）是下一片。
 *
 * `FILE` 在 C 里是**不透明**的，所以它不必是线性内存上的一个对象 —— 一个小整数就够。
 * 我们取 1 / 2 / 3（stdin / stdout / stderr）：它们落在**页 0** 里，而页 0 整页留空
 * （版图的第一条，见 tccgen.js），于是这几个句柄不可能与任何真的指针撞上。
 * `NULL` 是 0，所以 `f == NULL` 也照旧对。
 *
 * `stdout` / `stderr` 在头文件里是宏，展开成 `__omni_stdout()` —— C 只要求它们是
 * **`FILE *` 类型的表达式**（C11 7.21.1），不要求是可改的左值，所以函数调用够了。
 * 这与 `errno` 那一片不同：那个必须是左值，所以只能是内存。
 *
 * stdout 走解释器自己那个缓冲（`printBytes`，与 `printf` 同一个 —— 它按**字节**
 * 落盘，见第十二片），stderr **直写**
 * —— C 的 stderr 就是不带缓冲的（C11 7.21.3 第 7 段）。两条流在测试轴上分开对账，
 * 所以它们之间的交错不进入 oracle。
 */
const F_STDIN = 1n;
const F_STDOUT = 2n;
const F_STDERR = 3n;

/* ------------------------------------------------------------------ 真的文件
 *
 * `fopen` 一族（第八刀第十片）。句柄从 4 起，宿主这边一张表：
 *   `{ path, data, pos, write, eof, err }`
 *
 * **一处刻意的简化，不是忘了**：打开时就把整份文件读进宿主的一个字符串
 * （一个字符一个字节），`fread` / `fgets` / `fseek` 都在那份**快照**上走；
 * 写模式攒在同一个字符串里，`fclose` / `fflush` 时整份落盘。
 *
 * 于是不成立的有两件事：**很大的文件**（整份进内存）、以及**边写边被别人读**
 * （别人看到的是落盘那一刻的样子）。选它的理由是 tinycc 的源码读源文件正是
 * 「整份读进来」，而真的 fd 级 IO 要给 `host/native.js` 加一套 open/read/seek/close ——
 * 那是后端那几步真的要跑 `tcc -run` 时才必须的一格。
 */
const files = new Map();      // 句柄 -> 那张表里的一行
let nextFile = 4n;            // 1/2/3 是三条标准流

/** `fopen` 的模式串：C 只认那几个字母，多的（`b`、`x`、`+`）在这一片按主字母算。 */
function openMode(m) {
  if (m.indexOf('r') >= 0) return 'r';
  if (m.indexOf('w') >= 0) return 'w';
  if (m.indexOf('a') >= 0) return 'a';
  return null;
}

/** 把一份还没落盘的写入落到盘上。只读的流上是空操作。 */
function fileSync(e) {
  if (!e.write || !e.dirty) return;
  writeBinary(e.path, e.data);
  e.dirty = false;
}

/** 往一条流上写一段文字。认不出的句柄当场抛 —— 那是程序把野指针当 FILE* 用了。 */
function streamWrite(f, s) {
  if (f === F_STDOUT) { printBytes(s); return; }
  if (f === F_STDERR) {
    /* 先把 stdout 攒着的那些落盘：C 的 stderr 不带缓冲，而我们的 stdout 带 ——
     * 不先冲的话同一个终端上两条流的先后会与 tcc 那边相反。 */
    flushOut();
    hostStderr(s);
    return;
  }
  if (f === F_STDIN) throw new Error('libc: 往 stdin 上写');
  const e = files.get(f);
  if (e === undefined) throw new Error(`libc: 不是一条流的句柄（${f}）`);
  if (!e.write) { e.err = true; return; }   // 只读的流上写：置错误标志，不抛
  /* 写在 `pos` 那儿（`fseek` 之后可能不在末尾）。落盘要等 `fclose`/`fflush`。 */
  const head = e.data.slice(0, e.pos);
  const pad = e.pos > e.data.length ? '\0'.repeat(e.pos - e.data.length) : '';
  e.data = head + pad + s + e.data.slice(e.pos + s.length);
  e.pos += s.length;
  e.dirty = true;
}

/* ------------------------------------------------------------------ ctype
 *
 * `<ctype.h>` 的那十几条（第八刀第七片）。三件事值得写下来：
 *
 * 1. **收的是 `int`，而且 `EOF`（-1）是合法的输入**（C11 7.4 第 1 段：实参要么是
 *    `unsigned char` 能表示的值，要么是 `EOF`）。所以不能先 `asUintN(8)` ——
 *    那会把 -1 变成 255（`ÿ`）。范围外的一概回 0。
 * 2. 回的只保证是**非零**，不保证是 1。本机（macOS）回的是 1，我们也回 1；
 *    要逐字节对账的用例照 C 的保证写（`!= 0`），于是换一台机器也仍然成立。
 * 3. 只做 **"C" locale**。C 说 `isalpha` 在别的 locale 下可以更宽 —— 那要一整套
 *    locale，而 tinycc 的源码只用 C locale。
 */

/** `c` 在 `unsigned char` 的范围里吗（`EOF` 与别的负数都不在）。 */
function ctypeOk(c) { return c >= 0 && c <= 255; }

const isDigit = (c) => c >= 48 && c <= 57;
const isUpper = (c) => c >= 65 && c <= 90;
const isLower = (c) => c >= 97 && c <= 122;
const isAlpha = (c) => isUpper(c) || isLower(c);
const isSpace = (c) => c === 32 || (c >= 9 && c <= 13);
const isXdigit = (c) => isDigit(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
/** 可打印且不是空格也不是字母数字（C11 7.4.1.10）。 */
const isPunct = (c) => c >= 33 && c <= 126 && !isDigit(c) && !isAlpha(c);

/** 一条谓词包成 libc 的入口：范围外回 0，范围内回 0/1。 */
function ctypeFn(pred) {
  return (a) => {
    const c = Number(BigInt.asIntN(32, BigInt(a[0])));
    return ctypeOk(c) && pred(c) ? 1n : 0n;
  };
}

/* ------------------------------------------------------------------ str 一族
 *
 * `strncpy` / `strchr` / `strstr` 那几条（第八刀第四片）。它们都只要「在线性内存上
 * 数字节」，所以实现是一句话；写在这儿的理由是**它们的边角**：`strncpy` 不一定补 0、
 * `strchr` 要认那个终止的 0、`strncat` 的 n 不算那个 0。这三条搞错的代码到处都是。
 */

/**
 * libc 的那张表。键是 C 里的名字，值拿到**宿主值的实参数组**、回一个宿主值
 * （`void` 的函数回 `undefined`）。
 *
 * 只放「tinycc 的源码真的在用」的那些。缺的名字在运行期报「libc: 没有这个函数」，
 * 一眼能看出是进度而不是 bug（与前端那个「第六刀：」前缀同一条纪律）。
 */
const LIBC = {
  /* 入口函数在 `main` 之前发的那一条：把堆的起点交过来。宿主这边不猜版图 ——
   * 版图是前端定的（tccgen.js 末尾那张表）。名字带 `__omni_` 前缀，
   * 因为它不是 C 标准里的东西，而 C 程序不该撞上它。 */
  __omni_heap_init: (a) => {
    heapBase = BigInt(a[0]);
    brkSet(heapBase + HEAP_HDR);
    return undefined;
  },
  /* `errno` 那一格的地址（第八刀第八片）。与上面那条同一个形状。 */
  __omni_errno_init: (a) => {
    errnoAddr = BigInt(a[0]);
    return undefined;
  },
  __omni_errno_location: () => {
    if (errnoAddr === 0n) throw new Error('libc: errno 那一格没交过来（__omni_errno_init 没发？）');
    return errnoAddr;
  },
  malloc: (a) => heapAlloc(BigInt(a[0])),
  calloc: (a) => {
    /* `nmemb * size` 会溢出 —— C 里那是 UB，这里在 BigInt 上算所以先算出真值再判：
     * 装不下就回 NULL，而不是分配一小块然后让调用方写出界。 */
    const n = BigInt(a[0]) * BigInt(a[1]);
    const p = heapAlloc(n);
    if (p === 0n) return 0n;
    for (let i = 0n; i < n; i++) memStore('i8', p + i, 0, 0n);
    return p;
  },
  realloc: (a) => {
    const p = BigInt(a[0]);
    const n = BigInt(a[1]);
    if (p === 0n) return heapAlloc(n);
    if (n === 0n) { heapFree(p); return 0n; }
    const old = memLoad('i64', p - HEAP_HDR, 0);
    // 原地够用就原地 —— C 只保证「内容保留到两者较小的那个长度」，地址允许不变
    if (heapNeed(n) <= old) return p;
    const q = heapAlloc(n);
    if (q === 0n) return 0n;
    for (let i = 0n; i < old; i++) memStore('i8', q + i, 0, memLoad('i8u', p + i, 0));
    heapFree(p);
    return q;
  },
  free: (a) => { heapFree(BigInt(a[0])); return undefined; },
  strdup: (a) => {
    const s = readCStr(a[0]);
    const p = heapAlloc(BigInt(s.length + 1));
    if (p === 0n) return 0n;
    writeCStr(p, s);
    return p;
  },

  putchar: (a) => {
    printBytes(String.fromCharCode(Number(BigInt.asUintN(8, BigInt(a[0])))));
    return BigInt.asIntN(32, BigInt(a[0]));
  },
  puts: (a) => {
    const s = readCStr(a[0]);
    printBytes(s + '\n');
    return BigInt(s.length + 1);
  },
  printf: (a) => {
    const s = cFormat(readCStr(a[0]), a[1]);
    printBytes(s);
    return BigInt(s.length);
  },
  /* `v` 那一族（第八刀第六片）：`va_list` 在这个目标上**就是**变参区的地址
   * （`tccgen.js` 把 `__builtin_va_list` 定成 `void *`），而 `cFormat` 拿的正是
   * 那个地址 —— 所以这三条与上面三条**共用同一个游标**，区别只在实参从哪儿来：
   * `printf` 那条是编译器在调用点摊出来的变参区，这条是调用方传进来的一个指针。
   * 也就是说 `printf(fmt, ...)` 与 `vprintf(fmt, ap)` 在这一层是同一件事。 */
  vprintf: (a) => {
    const s = cFormat(readCStr(a[0]), a[1]);
    printBytes(s);
    return BigInt(s.length);
  },
  sprintf: (a) => {
    const s = cFormat(readCStr(a[1]), a[2]);
    return BigInt(writeCStr(a[0], s));
  },
  snprintf: (a) => {
    /* 回的是「本来会写多少」，不是「实际写了多少」（C11 7.21.6.5）—— 这一格
     * 搞反的话「先量长度再分配」那种常见写法会静悄悄少一个字节。 */
    const s = cFormat(readCStr(a[2]), a[3]);
    const n = Number(BigInt(a[1]));
    if (n > 0) writeCStr(a[0], s.slice(0, n - 1));
    return BigInt(s.length);
  },
  vsprintf: (a) => BigInt(writeCStr(a[0], cFormat(readCStr(a[1]), a[2]))),
  vsnprintf: (a) => {
    const s = cFormat(readCStr(a[2]), a[3]);
    const n = Number(BigInt(a[1]));
    if (n > 0) writeCStr(a[0], s.slice(0, n - 1));
    return BigInt(s.length);
  },

  /* 三条标准流（第八刀第九片）。头文件里 `stdout` / `stderr` 是宏，展开成这几个调用 ——
   * C 只要求它们是 `FILE *` 类型的**表达式**，不要求是左值。 */
  __omni_stdin: () => F_STDIN,
  __omni_stdout: () => F_STDOUT,
  __omni_stderr: () => F_STDERR,
  fprintf: (a) => {
    const s = cFormat(readCStr(a[1]), a[2]);
    streamWrite(BigInt(a[0]), s);
    return BigInt(s.length);
  },
  vfprintf: (a) => {
    const s = cFormat(readCStr(a[1]), a[2]);
    streamWrite(BigInt(a[0]), s);
    return BigInt(s.length);
  },
  fputs: (a) => {
    /* 与 `puts` 不同：**不补换行**（C11 7.21.7.4），而且回的只是「非负」。
     * 本机回的是 0，我们也回 0 —— 用例照 C 的保证写（`>= 0`）。 */
    streamWrite(BigInt(a[1]), readCStr(a[0]));
    return 0n;
  },
  fputc: (a) => {
    const c = BigInt.asUintN(8, BigInt(a[0]));
    streamWrite(BigInt(a[1]), String.fromCharCode(Number(c)));
    return c;
  },
  fwrite: (a) => {
    /* 回的是**写成功了几个成员**，不是几个字节（C11 7.21.8.2）。
     * 而 `size` 或 `nmemb` 是 0 时**回 0**（同一段最后一句）—— 不是回 nmemb。
     * 量过：本机的 libc 回 0，我们一开始回了 4。 */
    const size = BigInt(a[1]);
    const n = BigInt(a[2]);
    if (size === 0n || n === 0n) return 0n;
    let s = '';
    const total = Number(size * n);
    for (let i = 0; i < total; i++) {
      s += String.fromCharCode(Number(memLoad('i8u', BigInt(a[0]) + BigInt(i), 0)));
    }
    streamWrite(BigInt(a[3]), s);
    return n;
  },
  fflush: (a) => {
    /* `fflush(NULL)` 是「所有流一起冲」（C11 7.21.5.2）。stdout 那条冲缓冲，
     * 文件那条**落盘** —— 也就是说「冲」在两种流上是两件不同的事，但对调用方一样。 */
    flushOut();
    const f = BigInt(a[0]);
    if (f === 0n) {
      for (const e of files.values()) fileSync(e);
      return 0n;
    }
    const e = files.get(f);
    if (e !== undefined) fileSync(e);
    return 0n;
  },

  /* ---- 真的文件（第八刀第十片）。整份快照，见上面那一节。 */
  fopen: (a) => {
    const path = readCStr(a[0]);
    const mode = openMode(readCStr(a[1]));
    if (mode === null) return 0n;
    let data = '';
    if (mode === 'r' || mode === 'a') {
      try {
        data = readBinary(path);
      } catch {
        // `r` 打不开就是 NULL（而且该设 errno = ENOENT）；`a` 打不开当空文件
        if (mode === 'r') { setErrno(2); return 0n; }
      }
    }
    const h = nextFile;
    nextFile += 1n;
    files.set(h, {
      path,
      data,
      pos: mode === 'a' ? data.length : 0,
      write: mode !== 'r',
      eof: false,
      err: false,
      dirty: mode === 'w',      // `w` 要清空原文件，所以哪怕一个字节没写也得落盘
    });
    return h;
  },
  fclose: (a) => {
    const f = BigInt(a[0]);
    const e = files.get(f);
    if (e === undefined) return -1n;
    fileSync(e);
    files.delete(f);
    return 0n;
  },
  fread: (a) => {
    /* 回**成员个数**（C11 7.21.8.1）。读到一半停下的那个成员**不算** ——
     * 这一格搞错的话「读满一块就继续」的循环会多走一轮。 */
    const size = BigInt(a[1]);
    const n = BigInt(a[2]);
    const e = files.get(BigInt(a[3]));
    if (e === undefined || size === 0n || n === 0n) return 0n;
    const want = Number(size * n);
    const have = e.data.length - e.pos;
    const got = want < have ? want : have;
    for (let i = 0; i < got; i++) {
      memStore('i8', BigInt(a[0]) + BigInt(i), 0, BigInt(e.data.charCodeAt(e.pos + i)));
    }
    e.pos += got;
    if (got < want) e.eof = true;
    return BigInt(Math.floor(got / Number(size)));
  },
  fgets: (a) => {
    /* 读到换行**为止（含它）**，最多 n-1 个字节，末尾补 0（C11 7.21.7.2）。
     * 一个字节都没读到就回 NULL —— 而不是回一个空串。 */
    const n = Number(BigInt(a[1]));
    const e = files.get(BigInt(a[2]));
    if (e === undefined || n <= 0) return 0n;
    if (e.pos >= e.data.length) { e.eof = true; return 0n; }
    let s = '';
    while (s.length < n - 1 && e.pos < e.data.length) {
      const ch = e.data[e.pos];
      e.pos++;
      s += ch;
      if (ch === '\n') break;
    }
    writeCStr(a[0], s);
    return BigInt(a[0]);
  },
  fgetc: (a) => {
    const e = files.get(BigInt(a[0]));
    if (e === undefined || e.pos >= e.data.length) {
      if (e !== undefined) e.eof = true;
      return -1n;                       // EOF
    }
    const c = BigInt(e.data.charCodeAt(e.pos));
    e.pos++;
    return c;
  },
  fseek: (a) => {
    /* `whence`：SEEK_SET 0 / SEEK_CUR 1 / SEEK_END 2（本机的 `<stdio.h>` 量过）。
     * **成功时要清掉 eof 标志**（C11 7.21.9.2）—— 这一格漏了的话
     * 「seek 回开头再读一遍」的循环会立刻以为又到头了。 */
    const e = files.get(BigInt(a[0]));
    if (e === undefined) return -1n;
    const off = Number(BigInt.asIntN(64, BigInt(a[1])));
    const whence = Number(BigInt(a[2]));
    let p = off;
    if (whence === 1) p = e.pos + off;
    else if (whence === 2) p = e.data.length + off;
    if (p < 0) return -1n;
    e.pos = p;
    e.eof = false;
    return 0n;
  },
  ftell: (a) => {
    const e = files.get(BigInt(a[0]));
    return e === undefined ? -1n : BigInt(e.pos);
  },
  rewind: (a) => {
    const e = files.get(BigInt(a[0]));
    if (e !== undefined) { e.pos = 0; e.eof = false; e.err = false; }
    return undefined;
  },
  feof: (a) => {
    /* `feof` 说的是「**上一次读**撞到了末尾」，不是「现在在末尾」（C11 7.21.10.2）。
     * 所以它由 `fread`/`fgets`/`fgetc` 置，而不是在这儿现算。 */
    const e = files.get(BigInt(a[0]));
    return e !== undefined && e.eof ? 1n : 0n;
  },
  ferror: (a) => {
    const e = files.get(BigInt(a[0]));
    return e !== undefined && e.err ? 1n : 0n;
  },
  remove: (a) => {
    /* 这一片没有真的 unlink（`host/native.js` 里也没有）。只把还开着的那份忘掉 ——
     * 于是「写出去、读回来、删掉」这条链在同一次运行里成立，但盘上的文件还在。
     * 这是上面那处简化的一部分，将来接真的 fd 级 IO 时一起补。 */
    const path = readCStr(a[0]);
    for (const [h, e] of files) if (e.path === path) files.delete(h);
    return 0n;
  },
  strlen: (a) => BigInt(readCStr(a[0]).length),
  strcmp: (a) => {
    const x = readCStr(a[0]);
    const y = readCStr(a[1]);
    /* C 只保证符号，但 tcc 用的是宿主 libc，而宿主回的是**字节差**。要逐字节对账
     * 就得跟着回字节差 —— 只回 -1/0/1 的话 `printf("%d", strcmp(…))` 两边就不同。 */
    const n = x.length < y.length ? x.length : y.length;
    for (let i = 0; i < n; i++) {
      const d = x.charCodeAt(i) - y.charCodeAt(i);
      if (d !== 0) return BigInt(d);
    }
    return BigInt(x.length - y.length);
  },
  strcpy: (a) => { writeCStr(a[0], readCStr(a[1])); return BigInt(a[0]); },
  strncpy: (a) => {
    /* 两处边角：源短了要**用 0 填满 n 个字节**，源长了**不补终止的 0**
     * （C11 7.24.2.4）。所以它不是「安全的 strcpy」，写错的人比写对的多。 */
    const s = readCStr(a[1]);
    const n = Number(BigInt(a[2]));
    const d = BigInt(a[0]);
    for (let i = 0; i < n; i++) {
      memStore('i8', d + BigInt(i), 0, i < s.length ? BigInt(s.charCodeAt(i)) : 0n);
    }
    return d;
  },
  strcat: (a) => {
    const d = readCStr(a[0]);
    writeCStr(BigInt(a[0]) + BigInt(d.length), readCStr(a[1]));
    return BigInt(a[0]);
  },
  strncat: (a) => {
    /* n 说的是**从源那边最多取几个**，终止的 0 不算在里头（C11 7.24.3.2）——
     * 与 `strncpy` 的 n 不是同一个意思。 */
    const d = readCStr(a[0]);
    let s = readCStr(a[1]);
    const n = Number(BigInt(a[2]));
    if (s.length > n) s = s.slice(0, n);
    writeCStr(BigInt(a[0]) + BigInt(d.length), s);
    return BigInt(a[0]);
  },
  strncmp: (a) => {
    /* 与 `strcmp` 一样回**字节差**（宿主的 libc 就是这样，要逐字节对账就得跟着），
     * 而且遇到 0 就停 —— 不是「比满 n 个字节」。 */
    const n = Number(BigInt(a[2]));
    for (let i = 0; i < n; i++) {
      const x = Number(memLoad('i8u', BigInt(a[0]) + BigInt(i), 0));
      const y = Number(memLoad('i8u', BigInt(a[1]) + BigInt(i), 0));
      if (x !== y) return BigInt(x - y);
      if (x === 0) return 0n;
    }
    return 0n;
  },
  strchr: (a) => {
    /* `c` 按 `char` 转换，**0 也算**（`strchr(s, 0)` 回的是那个终止符的地址，
     * C11 7.24.5.2 明说终止的 0 算这个字符串的一部分）。 */
    const s = readCStr(a[0]);
    const c = String.fromCharCode(Number(BigInt.asUintN(8, BigInt(a[1]))));
    const i = (c === '\0' ? s.length : s.indexOf(c));
    return i < 0 ? 0n : BigInt(a[0]) + BigInt(i);
  },
  strrchr: (a) => {
    const s = readCStr(a[0]);
    const c = String.fromCharCode(Number(BigInt.asUintN(8, BigInt(a[1]))));
    const i = (c === '\0' ? s.length : s.lastIndexOf(c));
    return i < 0 ? 0n : BigInt(a[0]) + BigInt(i);
  },
  strstr: (a) => {
    /* 空的针在任何草堆里都在最前面（C11 7.24.5.7）—— `indexOf('')` 正好回 0。 */
    const h = readCStr(a[0]);
    const i = h.indexOf(readCStr(a[1]));
    return i < 0 ? 0n : BigInt(a[0]) + BigInt(i);
  },
  memcpy: (a) => {
    const n = Number(BigInt(a[2]));
    for (let i = 0; i < n; i++) {
      memStore('i8', BigInt(a[0]) + BigInt(i), 0, memLoad('i8u', BigInt(a[1]) + BigInt(i), 0));
    }
    return BigInt(a[0]);
  },
  memmove: (a) => {
    /* 区间可能重叠，所以方向要挑（C11 7.24.2.2 明说 memmove 允许重叠）。 */
    const n = Number(BigInt(a[2]));
    const d = BigInt(a[0]);
    const s = BigInt(a[1]);
    if (d < s) {
      for (let i = 0; i < n; i++) memStore('i8', d + BigInt(i), 0, memLoad('i8u', s + BigInt(i), 0));
    } else {
      for (let i = n - 1; i >= 0; i--) memStore('i8', d + BigInt(i), 0, memLoad('i8u', s + BigInt(i), 0));
    }
    return d;
  },
  memset: (a) => {
    const n = Number(BigInt(a[2]));
    const b = BigInt.asUintN(8, BigInt(a[1]));
    for (let i = 0; i < n; i++) memStore('i8', BigInt(a[0]) + BigInt(i), 0, b);
    return BigInt(a[0]);
  },
  memcmp: (a) => {
    const n = Number(BigInt(a[2]));
    for (let i = 0; i < n; i++) {
      const x = Number(memLoad('i8u', BigInt(a[0]) + BigInt(i), 0));
      const y = Number(memLoad('i8u', BigInt(a[1]) + BigInt(i), 0));
      if (x !== y) return BigInt(x - y);
    }
    return 0n;
  },
  abs: (a) => {
    const v = BigInt.asIntN(32, BigInt(a[0]));
    return v < 0n ? -v : v;
  },
  labs: (a) => {
    const v = BigInt.asIntN(64, BigInt(a[0]));
    return v < 0n ? -v : v;
  },
  /* `atoi` / `atol`：就是 base 10 的 `strtol`，只是**不报错也不给 endptr**
   * （C11 7.22.1.2：等价于 `strtol(s, NULL, 10)`，除了出错时的行为没规定）。 */
  atoi: (a) => BigInt.asIntN(32, scanInt(readCStr(a[0]), 10).v),
  atol: (a) => BigInt.asIntN(64, scanInt(readCStr(a[0]), 10).v),
  strtol: (a) => {
    const s = readCStr(a[0]);
    const r = scanInt(s, Number(BigInt(a[2])));
    putEnd(BigInt(a[1]), a[0], r.used);
    /* 溢出：回端点值并把 `errno` 设成 `ERANGE`（34 —— 本机的 `<sys/errno.h>` 量过）。
     * 第四片欠下的这一格由第八刀第八片补上，于是这一条现在能与 tcc 对上账了。 */
    if (r.v > LONG_MAX) { setErrno(34); return LONG_MAX; }
    if (r.v < LONG_MIN) { setErrno(34); return LONG_MIN; }
    return r.v;
  },
  strtoul: (a) => {
    const s = readCStr(a[0]);
    const r = scanInt(s, Number(BigInt(a[2])));
    putEnd(BigInt(a[1]), a[0], r.used);
    if (r.v > ULONG_MAX) { setErrno(34); return ULONG_MAX; }
    /* 负号是**合法**的（C11 7.22.1.4 第 5 段：按无符号取负），`strtoul("-1")`
     * 回的是 ULONG_MAX 而不是错误 —— 而且**不设 errno**。 */
    return BigInt.asUintN(64, r.v);
  },
  /* `exit` 与 `abort`：都不回来（见 `ExitCall`）。`abort` 的退出码照 shell 的规矩
   * 是 128 + SIGABRT(6) = 134 —— `tcc -run` 那边也是这个数。 */
  exit: (a) => { throw new ExitCall(Number(BigInt.asIntN(32, BigInt(a[0])))); },
  abort: () => { throw new ExitCall(134); },

  isalpha: ctypeFn(isAlpha),
  isdigit: ctypeFn(isDigit),
  isalnum: ctypeFn((c) => isAlpha(c) || isDigit(c)),
  isspace: ctypeFn(isSpace),
  isupper: ctypeFn(isUpper),
  islower: ctypeFn(isLower),
  isxdigit: ctypeFn(isXdigit),
  ispunct: ctypeFn(isPunct),
  isprint: ctypeFn((c) => c >= 32 && c <= 126),
  isgraph: ctypeFn((c) => c >= 33 && c <= 126),
  iscntrl: ctypeFn((c) => c < 32 || c === 127),
  /* `toupper` / `tolower`：**不认识的一概原样回**（C11 7.4.2）——
   * 包括 `EOF` 与非字母。 */
  toupper: (a) => {
    const c = BigInt.asIntN(32, BigInt(a[0]));
    return isLower(Number(c)) ? c - 32n : c;
  },
  tolower: (a) => {
    const c = BigInt.asIntN(32, BigInt(a[0]));
    return isUpper(Number(c)) ? c + 32n : c;
  },

  /* `qsort`：插入排序。比较器拿到的是**真的元素地址**（C 要求如此），
   * 所以这一份不需要临时缓冲区、也不碰堆 —— 交换就地做。
   *
   * 选插入排序而不是快排：C 只要求「排好」，不要求稳定也不要求 O(n log n)
   * （C11 7.22.5.2）。**相等元素之间的次序是未规定的**，宿主的 libc 与我们大概率
   * 不同 —— 所以拿 tcc 对账的用例里不能有比较相等的元素。这一格记在
   * stage0/include/stdlib.h 上。 */
  qsort: (a) => {
    const base = BigInt(a[0]);
    const n = Number(BigInt(a[1]));
    const sz = BigInt(a[2]);
    const cmp = BigInt(a[3]);
    for (let i = 1; i < n; i++) {
      for (let j = i; j > 0; j--) {
        const l = base + BigInt(j - 1) * sz;
        const r = base + BigInt(j) * sz;
        if (BigInt.asIntN(32, BigInt(callback(cmp, [l, r]))) <= 0n) break;
        swapBytes(l, r, sz);
      }
    }
    return undefined;
  },
  bsearch: (a) => {
    /* 比较器的两个实参有次序：**key 在前**，数组元素在后（C11 7.22.5.1）。 */
    const key = BigInt(a[0]);
    const base = BigInt(a[1]);
    const sz = BigInt(a[3]);
    const cmp = BigInt(a[4]);
    let lo = 0;
    let hi = Number(BigInt(a[2])) - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = base + BigInt(mid) * sz;
      const d = BigInt.asIntN(32, BigInt(callback(cmp, [key, p])));
      if (d === 0n) return p;
      if (d < 0n) hi = mid - 1;
      else lo = mid + 1;
    }
    return 0n;
  },
};

/** 这个名字在 libc 里有吗（降级器**不**问这一句：链接期缺符号是运行期的错）。 */
export function hasLibc(name) { return Object.prototype.hasOwnProperty.call(LIBC, name); }

/**
 * 程序结束时要做的事（第八刀第十片）：还开着的流一律落盘。
 *
 * C 的 `exit` 会冲刷并关掉所有流（C11 7.22.4.4 第 2 段），而**从 `main` 返回等价于
 * `exit`**（5.1.2.2.3）—— 所以没写 `fclose` 的程序也该看到文件里有东西。
 * 跑模块的那一层在两条出去的路上（正常返回与 `ExitCall`）都调它。
 */
export function libcAtExit() {
  for (const e of files.values()) fileSync(e);
  files.clear();
  /* 下一次运行是新的一遍：句柄从 4 重新开始，errno 那一格与堆也都会重新交过来。
   * 同一个进程里跑两个模块时不清就会把上一遍的状态漏过去。 */
  nextFile = 4n;
  errnoAddr = 0n;
  heapBase = 0n;
}

/**
 * 调一个 libc 函数。`args` 是宿主值数组。名字不认识就抛 —— 那等于链接期缺符号，
 * 而在解释器上「链接」发生在第一次调用那一刻。
 *
 * 出口处**归一到有符号 64 位**：这条腿上整数一律以有符号 BigInt 表示
 * （`builtin.js` 的 `W`），而 libc 里算出来的东西天然是无符号的（`strtoul`、
 * `ULONG_MAX`）。不归一的话 `strtoul("-1", …) == 18446744073709551615UL`
 * 会是假 —— 两边印出来都是 18446744073709551615，比起来一个是 `-1n`
 * 一个是 `2n**64n-1n`。第八刀第四片踩过这一格。
 */
export function callLibc(name, args) {
  if (!hasLibc(name)) {
    throw new Error(`libc: 没有这个函数 '${name}'（第六刀的 libc 还只有一小把）`);
  }
  const v = LIBC[name](args);
  return typeof v === 'bigint' ? BigInt.asIntN(64, v) : v;
}
