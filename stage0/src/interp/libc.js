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
// **不能拿 tcc 对账的那几格**（第四片记下的那份清单在长）：
//   - `%p`：地址本身不同（我们的是线性内存偏移，tcc 的是进程地址）。
//   - 浮点的 `%f`/`%e`/`%g`：前端还没有浮点，到那一片再说。

import { memLoad, memStore, printRaw } from './builtin.js';

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
function pad(body, sign, spec) {
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
 * `printf` 的格式化。`fmt` 是格式串（已经从内存里读出来），`args` 是宿主值的数组，
 * `at` 是下一个要取的实参下标。回格式化好的字符串。
 *
 * 变参那一侧的类型信息**只在格式串里**（C 就是这么设计的），所以这儿是唯一知道
 * 「第三个实参是个指针还是个整数」的地方 —— 与真的 libc 处境完全一样。
 */
export function cFormat(fmt, args, at) {
  let out = '';
  let i = 0;
  let k = at;
  const nextArg = () => {
    if (k >= args.length) throw new Error('printf: 实参不够（格式串里的转换比实参多）');
    const v = args[k];
    k++;
    return v;
  };
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
      spec.width = Number(BigInt.asIntN(32, BigInt(nextArg())));
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
        spec.prec = Number(BigInt.asIntN(32, BigInt(nextArg())));
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
      const v = BigInt.asIntN(bits, BigInt(nextArg()));
      const neg = v < 0n;
      const body = (neg ? -v : v).toString(10);
      out += pad(body, neg ? '-' : (spec.plus ? '+' : (spec.space ? ' ' : '')), spec);
      continue;
    }
    if (conv === 'u') {
      out += pad(uText(BigInt(nextArg()), bits, 10, false), '', spec);
      continue;
    }
    if (conv === 'o') {
      const body = uText(BigInt(nextArg()), bits, 8, false);
      if (spec.alt && body[0] !== '0') spec.prefix = '0';
      out += pad(body, '', spec);
      continue;
    }
    if (conv === 'x' || conv === 'X') {
      const v = BigInt(nextArg());
      const body = uText(v, bits, 16, conv === 'X');
      if (spec.alt && v !== 0n) spec.prefix = conv === 'X' ? '0X' : '0x';
      out += pad(body, '', spec);
      continue;
    }
    if (conv === 'c') {
      spec.numeric = false;
      out += pad(String.fromCharCode(Number(BigInt.asUintN(8, BigInt(nextArg())))), '', spec);
      continue;
    }
    if (conv === 's') {
      spec.numeric = false;
      let s = readCStr(nextArg());
      if (spec.prec >= 0 && s.length > spec.prec) s = s.slice(0, spec.prec);
      out += pad(s, '', spec);
      continue;
    }
    if (conv === 'p') {
      /* 地址本身与 tcc 不同（我们的是线性内存偏移），所以这一格**不能对账**。
       * 形状照 glibc/macOS：`0x` 加小写十六进制，空指针印 `0x0`。 */
      spec.numeric = false;
      out += pad('0x' + uText(BigInt(nextArg()), 64, 16, false), '', spec);
      continue;
    }
    if (conv === 'f' || conv === 'e' || conv === 'E' || conv === 'g' || conv === 'G'
      || conv === 'a' || conv === 'A') {
      throw new Error(`第六刀：printf 的浮点转换 '%${conv}' 还没到`);
    }
    throw new Error(`printf: 不认识的转换 '%${conv}'`);
  }
  return out;
}

/**
 * libc 的那张表。键是 C 里的名字，值拿到**宿主值的实参数组**、回一个宿主值
 * （`void` 的函数回 `undefined`）。
 *
 * 只放「tinycc 的源码真的在用、而且不需要一个真的堆」的那些。`malloc` 一族要一个
 * 分配器，那是下一片的事 —— 缺的名字在运行期报「libc: 没有这个函数」，一眼能看出
 * 是进度而不是 bug（与前端那个「第六刀：」前缀同一条纪律）。
 */
const LIBC = {
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
    const s = cFormat(readCStr(a[0]), a, 1);
    printRaw(s);
    return BigInt(s.length);
  },
  sprintf: (a) => {
    const s = cFormat(readCStr(a[1]), a, 2);
    return BigInt(writeCStr(a[0], s));
  },
  snprintf: (a) => {
    /* 回的是「本来会写多少」，不是「实际写了多少」（C11 7.21.6.5）—— 这一格
     * 搞反的话「先量长度再分配」那种常见写法会静悄悄少一个字节。 */
    const s = cFormat(readCStr(a[2]), a, 3);
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
