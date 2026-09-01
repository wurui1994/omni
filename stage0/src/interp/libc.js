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
// 浮点原先也在这份清单里，第十四片之后 `%f`/`%e`/`%g` 已经逐字节对上了（见 `fText`）。

import { memLoad, memStore, printRaw, memSize, memGrow } from './builtin.js';

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
      || conv === 'g' || conv === 'G') {
      /* 变参里的浮点已经被默认实参提升拉成 double（`float` 也是），所以变参区那一格
       * 就是 8 个字节的 f64 —— 按 f64 读，与写的那一侧（`vaBlock`）对上。 */
      const x = ap.real();
      if (!Number.isFinite(x)) {
        /* `inf` / `nan`：宽度照用，但**不补零**（C11 7.21.6.1 第 8 段最后一句）。
         * 大写的转换印大写。 */
        spec.numeric = false;
        const body = Number.isNaN(x) ? 'nan' : 'inf';
        const up = conv === 'F' || conv === 'E' || conv === 'G';
        const sign = x < 0 ? '-' : (spec.plus ? '+' : (spec.space ? ' ' : ''));
        out += padTo(up ? body.toUpperCase() : body, sign, spec);
        continue;
      }
      /* 负号看的是 `x < 0` 之外还有 `-0.0`：C 印 `-0.000000`，而 `-0 < 0` 是假。 */
      const neg = x < 0 || Object.is(x, -0);
      /* 浮点这一格的「精度」已经在 `fText` 里用掉了（小数位数 / 有效数字），
       * 不能再让 `padTo` 拿它去补前导零 —— 所以按非数字对待。 */
      spec.numeric = false;
      const body = fText(x, conv, spec);
      const sign = neg ? '-' : (spec.plus ? '+' : (spec.space ? ' ' : ''));
      if (spec.zero && !spec.left) {
        /* `%08.2f` 的零补在**符号之后**，而 `padTo` 的补零那一支被上面关掉了，
         * 所以这一格自己补 —— 数字部分补零是安全的（它已经有小数点了）。 */
        let n = spec.width - sign.length - body.length;
        if (n < 0) n = 0;
        out += sign + '0'.repeat(n) + body;
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
    printRaw(String.fromCharCode(Number(BigInt.asUintN(8, BigInt(a[0])))));
    return BigInt.asIntN(32, BigInt(a[0]));
  },
  puts: (a) => {
    const s = readCStr(a[0]);
    printRaw(s + '\n');
    return BigInt(s.length + 1);
  },
  printf: (a) => {
    const s = cFormat(readCStr(a[0]), a[1]);
    printRaw(s);
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
  strcat: (a) => {
    const d = readCStr(a[0]);
    writeCStr(BigInt(a[0]) + BigInt(d.length), readCStr(a[1]));
    return BigInt(a[0]);
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
  /* `exit` 与 `abort`：都不回来（见 `ExitCall`）。`abort` 的退出码照 shell 的规矩
   * 是 128 + SIGABRT(6) = 134 —— `tcc -run` 那边也是这个数。 */
  exit: (a) => { throw new ExitCall(Number(BigInt.asIntN(32, BigInt(a[0])))); },
  abort: () => { throw new ExitCall(134); },
};

/** 这个名字在 libc 里有吗（降级器**不**问这一句：链接期缺符号是运行期的错）。 */
export function hasLibc(name) { return Object.prototype.hasOwnProperty.call(LIBC, name); }

/**
 * 调一个 libc 函数。`args` 是宿主值数组。名字不认识就抛 —— 那等于链接期缺符号，
 * 而在解释器上「链接」发生在第一次调用那一刻。
 */
export function callLibc(name, args) {
  if (!hasLibc(name)) {
    throw new Error(`libc: 没有这个函数 '${name}'（第六刀的 libc 还只有一小把）`);
  }
  return LIBC[name](args);
}
