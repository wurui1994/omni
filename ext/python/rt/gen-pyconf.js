#!/usr/bin/env node
// ext/python/rt/gen-pyconf.js —— **探本机 -> `omni_pyconf.h`**（借来的那几份 CPython 的 C 要的配置宏）
//
//   node ext/python/rt/gen-pyconf.js --src <cpython> --out <…/include/omni_pyconf.h> --cc clang
//
// ## 名单是量出来的，不是猜的
//
// CPython 的 `pyconfig.h.in` 能定义 **727** 个宏。借来的那几份 `.c`（现在是
// `Python/dtoa.c` + `Python/pystrtod.c`，连它们包的那几份头）真读到的只有 **6 个**：
//
//   DOUBLE_IS_LITTLE_ENDIAN_IEEE754  DOUBLE_IS_BIG_ENDIAN_IEEE754
//   WORDS_BIGENDIAN  X87_DOUBLE_ROUNDING
//   HAVE_GCC_ASM_FOR_X87  HAVE_GCC_ASM_FOR_MC68881
//
// 这一份**自己算那个交集**（"pyconfig.h.in 能定义的" ∩ "这几份源码真测到的"），
// 于是往后多借一份 `.c`、或者那棵树多读一个宏，名单自己跟着长。
// **算出来的名字里有一个不认得怎么探的就当场报** —— 这一条是判据不是讲究：
// 少定义一格 `HAVE_*` 的后果往往不是编不过，而是 CPython 走进另一条 `#else`，
// 然后在某个角落静默答错（R 那一门的 `gen-rconfig.js` 靠这一条挡住过四个真坑）。
//
// 探法照 CPython 自己的 `configure.ac`（行号写在每一格上），不自己发明：
//   * 两格 gcc 内联汇编 -> **真编真链一遍**（`configure.ac:6478` / `:6490`）；
//   * x87 双舍入 -> **真跑一遍**那段程序（`configure.ac:6507`）；
//   * double 的字节序 -> **真跑一遍**，把 8 个字节印出来与 IEEE-754 的大端排布比
//     （CPython 用的是 autoconf-archive 的 `AX_C_FLOAT_WORDS_BIGENDIAN`，那一格靠在目标
//     文件里 grep 一串签名；真跑一遍更直接，而且顺带验了"它真是 64 位 IEEE-754"）。
//
// 缺省口径：**探不出来一律不定义**。这几格 CPython 都有退路（`_PY_SHORT_FLOAT_REPR` 落到 0，
// 于是 repr 退成 17 位有效数字 —— 慢路，不是错路）。唯一的例外是字节序：两格都探不到就
// exit 1，因为那时 dtoa.c 自己会 `#error`，早报比晚报好。

import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (n) => {
  const i = argv.indexOf(n);
  return i < 0 || i + 1 >= argv.length ? null : argv[i + 1];
};
const SRC = argOf('--src');
const OUT = argOf('--out');
const CC = argOf('--cc') ?? process.env.CC ?? 'clang';
if (SRC === null || OUT === null) {
  process.stderr.write('用法：gen-pyconf.js --src <cpython 树> --out <omni_pyconf.h> [--cc clang]\n');
  process.exit(2);
}

/** 借来的那几份源码（这张表跟着 `build.js` 的 `BORROWED` 走 —— 多借一份就加一行）。 */
const SOURCES = [
  'Python/dtoa.c',
  'Python/pystrtod.c',
  'Include/internal/pycore_pymath.h',
  'Include/internal/pycore_dtoa.h',
  'Include/pystrtod.h',
];

/**
 * **`--extra <相对路径,…>`**：临时多算几份（目录就整棵走一遍 `.c` / `.h`）。
 *
 * 只为"**下一批要探多少**"这一个问题：借整份运行时之前，先拿
 * `--extra Objects/unicodeobject.c,Include` 问一句"名单会涨到几个、哪几个还不知道怎么探"。
 * 不进 `build.js` 那条路（那边的名单是 `SOURCES`，与 `BORROWED` 一起改）。
 */
const EXTRA = (argOf('--extra') ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');


const scratch = mkdtempSync(join(tmpdir(), 'omni-pyconf-'));
let probes = 0;
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));

/* ---- 三种探针 ------------------------------------------------------------- */

/** 编得过吗（只编，不链）。 */
function compiles(body) {
  probes += 1;
  const src = join(scratch, `p${probes}.c`);
  writeFileSync(src, body);
  const r = spawnSync(CC, ['-std=c11', '-w', '-c', src, '-o', join(scratch, `p${probes}.o`)], { encoding: 'utf8' });
  return r.status === 0;
}

/** 编得过、链得上吗。 */
function links(body) {
  probes += 1;
  const src = join(scratch, `p${probes}.c`);
  const exe = join(scratch, `p${probes}.bin`);
  writeFileSync(src, body);
  const r = spawnSync(CC, ['-std=c11', '-w', src, '-o', exe, '-lm'], { encoding: 'utf8' });
  return r.status === 0;
}

/** 真跑一遍，回 `{ status, out }`（编不出来回 `null`）。 */
function runs(body) {
  probes += 1;
  const src = join(scratch, `p${probes}.c`);
  const exe = join(scratch, `p${probes}.bin`);
  writeFileSync(src, body);
  const c = spawnSync(CC, ['-std=c11', '-w', src, '-o', exe, '-lm'], { encoding: 'utf8' });
  if (c.status !== 0) return null;
  const r = spawnSync(exe, [], { encoding: 'utf8' });
  return { status: r.status, out: String(r.stdout ?? '') };
}

/* ---- 一格一格地探（每一格都注明 configure.ac 的出处）--------------------- */

/**
 * double 的字节序。**真跑一遍**：把一个 double 的 8 个字节印出来，与 IEEE-754 的
 * 大端排布（在这儿用 JS 的 DataView 算出来）比。
 * 顺带验了"它真是 64 位 IEEE-754" —— 对不上任何一种排列就两格都不定义，dtoa.c 自己会 #error。
 */
function doubleFormat() {
  /* 挑一个每个字节都不同的值，于是任何一种重排都分得开。 */
  const probe = 9006104071832581.0;
  const be = new Uint8Array(8);
  new DataView(be.buffer).setFloat64(0, probe, false);
  const want = { be: [...be], le: [...be].reverse() };
  const r = runs(`#include <stdio.h>\n#include <string.h>\n`
    + `int main(void){ double d = ${probe.toExponential(20)}; unsigned char b[8];\n`
    + '  memcpy(b, &d, 8);\n'
    + '  for (int i = 0; i < 8; i++) printf("%d ", (int)b[i]);\n'
    + '  return 0; }\n');
  if (r === null || r.status !== 0) return null;
  const got = r.out.trim().split(/\s+/).map(Number);
  const same = (a) => a.length === got.length && a.every((v, i) => v === got[i]);
  if (same(want.le)) return 'DOUBLE_IS_LITTLE_ENDIAN_IEEE754';
  if (same(want.be)) return 'DOUBLE_IS_BIG_ENDIAN_IEEE754';
  return null;
}

/** 整数的字节序（`WORDS_BIGENDIAN`）。 */
function wordsBigEndian() {
  const r = runs('#include <stdio.h>\nint main(void){ unsigned int i = 1;\n'
    + '  printf("%d", (int)*(unsigned char *)&i); return 0; }\n');
  return r !== null && r.status === 0 && r.out.trim() === '0';
}

/** x87 风的双舍入。**照 `configure.ac:6507` 那段程序原样跑**（它约定 exit(1) = 有）。 */
function x87DoubleRounding() {
  const r = runs('#include <stdlib.h>\n#include <math.h>\n'
    + 'int main(void) {\n'
    + '    volatile double x, y, z;\n'
    + '    /* 1./(1-2**-53) -> 1+2**-52 (correct), 1.0 (double rounding) */\n'
    + '    x = 0.99999999999999989; /* 1-2**-53 */\n'
    + '    y = 1./x;\n'
    + '    if (y != 1.)\n'
    + '        exit(0);\n'
    + '    /* 1e16+2.99999 -> 1e16+2. (correct), 1e16+4. (double rounding) */\n'
    + '    x = 1e16;\n'
    + '    y = 2.99999;\n'
    + '    z = x + y;\n'
    + '    if (z != 1e16+4.)\n'
    + '        exit(0);\n'
    + '    /* both tests show evidence of double rounding */\n'
    + '    exit(1);\n'
    + '}\n');
  return r !== null && r.status === 1;
}

/** 两格内联汇编（`configure.ac:6478` / `:6490`）—— 真编真链一遍。 */
const gccAsmX87 = () => links('int main(void){\n'
  + '  unsigned short cw;\n'
  + '  __asm__ __volatile__ ("fnstcw %0" : "=m" (cw));\n'
  + '  __asm__ __volatile__ ("fldcw %0" : : "m" (cw));\n'
  + '  return 0; }\n');
const gccAsmMc68881 = () => links('int main(void){\n'
  + '  unsigned int fpcr;\n'
  + '  __asm__ __volatile__ ("fmove.l %%fpcr,%0" : "=dm" (fpcr));\n'
  + '  __asm__ __volatile__ ("fmove.l %0,%%fpcr" : : "dm" (fpcr));\n'
  + '  return 0; }\n');

/* ---- 算名单：`pyconfig.h.in 能定义的` ∩ `这几份源码真测到的` ---------------- */

const conf = readFileSync(join(SRC, 'pyconfig.h.in'), 'utf8');
const canDefine = new Set([...conf.matchAll(/^#\s*undef\s+([A-Za-z0-9_]+)\s*$/gm)].map((m) => m[1]));
if (canDefine.size < 400) {
  throw new Error(`gen-pyconf.js: pyconfig.h.in 里只读出 ${canDefine.size} 个 \`#undef\` —— 那份模板的形状变了`);
}

const needed = new Set();
/** 一格路径 -> 要读的那几份文件（目录就整棵走，只看 `.c` / `.h`）。 */
const filesOf = (p) => {
  if (!statSync(p).isDirectory()) return [p];
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const q = join(d, e.name);
      if (e.isDirectory()) walk(q);
      else if (/\.[ch]$/.test(e.name)) out.push(q);
    }
  };
  walk(p);
  return out;
};
for (const rel of [...SOURCES, ...EXTRA]) {
  const p = join(SRC, rel);
  if (!existsSync(p)) throw new Error(`gen-pyconf.js: 借来的那份不在：${p}`);
  for (const f of filesOf(p)) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
      if (canDefine.has(m[1])) needed.add(m[1]);
    }
  }
}

/** 这一格怎么探 —— 名字 -> 一个回 `null`（不定义）/ 数 / 串的函数。 */
const HOW = new Map();
const fmt = doubleFormat();
HOW.set('DOUBLE_IS_LITTLE_ENDIAN_IEEE754', () => (fmt === 'DOUBLE_IS_LITTLE_ENDIAN_IEEE754' ? 1 : null));
HOW.set('DOUBLE_IS_BIG_ENDIAN_IEEE754', () => (fmt === 'DOUBLE_IS_BIG_ENDIAN_IEEE754' ? 1 : null));
HOW.set('WORDS_BIGENDIAN', () => (wordsBigEndian() ? 1 : null));
HOW.set('X87_DOUBLE_ROUNDING', () => (x87DoubleRounding() ? 1 : null));
HOW.set('HAVE_GCC_ASM_FOR_X87', () => (gccAsmX87() ? 1 : null));
HOW.set('HAVE_GCC_ASM_FOR_MC68881', () => (gccAsmMc68881() ? 1 : null));

/* ---- 四族通用探针 ---------------------------------------------------------
 *
 * 往后要借的是**整份运行时**（`ext/python/SPEC.md` §一之二），而那一批源码读到的宏
 * 量过是 **71 个**（`pyconfig.h.in` 的 727 ∩ 对象层那十份 .c 加 `Include/` 整棵）。
 * 71 个里绝大多数是机械的四族，所以这儿写成**按族探**，不是一格一格列：
 *
 *   `HAVE_<头>_H`        -> `AC_CHECK_HEADERS`：`#include <x.h>` 编得过吗
 *   `HAVE_<函数>`        -> `AC_CHECK_FUNCS`：取个地址链得上吗（autoconf 的老办法）
 *   `SIZEOF_T` / `ALIGNOF_T` -> `AC_CHECK_SIZEOF` / `AC_CHECK_ALIGNOF`：真跑一遍印出来
 *   `HAVE_DECL_X`        -> `AC_CHECK_DECLS`：那个名字声明过吗（缺省 0，不是不定义）
 *
 * **一条纪律不动**：按族也认不出来的名字照旧当场报（见下面 `unknown`）。
 * 按族探是为了不必手抄 60 条，不是为了"猜一个默认值" —— 猜出来的 `#else` 分支
 * 会在某个角落静默答错。
 *
 * 另一条：**这儿一行 CPython 的 configure 都不跑**（也不用它的 Makefile、不碰参考树）。
 * 探的是这台机器，问的是"这一格该定义成什么"。
 */

/** `HAVE_SYS_STAT_H` -> 几种可能的头名（下划线可能是目录分隔，也可能是名字的一部分）。 */
function headerCandidates(macro) {
  const parts = macro.slice('HAVE_'.length, -'_H'.length).toLowerCase().split('_');
  if (parts.length === 0 || parts[0] === '') return [];
  /* 每个下划线各有"当斜杠"与"留着"两种，2^(n-1) 种拼法（部分多于 4 段的就不猜了）。 */
  if (parts.length > 4) return [`${parts.join('_')}.h`];
  const out = [];
  for (let mask = 0; mask < (1 << (parts.length - 1)); mask += 1) {
    let s = parts[0];
    for (let i = 1; i < parts.length; i += 1) s += ((mask >> (i - 1)) & 1) === 1 ? `/${parts[i]}` : `_${parts[i]}`;
    out.push(`${s}.h`);
  }
  return out;
}

/** 那个头在不在（任一种拼法编得过就算在）。 */
const hasHeader = (macro) => headerCandidates(macro)
  .some((h) => compiles(`#include <${h}>\nint main(void){return 0;}\n`));

/**
 * 那个函数在不在。照 `AC_CHECK_FUNC` 的老办法：**自己声明一格、取地址、链一遍** ——
 * 故意不包那份头（包了就变成"这台机器的头声明了它吗"，而问的是"链得上吗"）。
 */
const hasFunc = (name) => links(`char ${name}(void);\nint main(void){ return (int)(long)&${name}; }\n`);

/** `SIZEOF_VOID_P` / `ALIGNOF_MAX_ALIGN_T` -> C 里那个类型（认不出来交 null）。 */
function typeOfSizeMacro(macro) {
  const KNOWN = new Map([
    ['VOID_P', 'void *'], ['SIZE_T', 'size_t'], ['MAX_ALIGN_T', 'max_align_t'],
    ['WCHAR_T', 'wchar_t'], ['PID_T', 'pid_t'], ['TIME_T', 'time_t'],
    ['OFF_T', 'off_t'], ['UINTPTR_T', 'uintptr_t'], ['INTPTR_T', 'intptr_t'],
    ['PTHREAD_T', 'pthread_t'], ['PTHREAD_KEY_T', 'pthread_key_t'],
    ['_BOOL', '_Bool'], ['FPOS_T', 'fpos_t'],
  ]);
  const rest = macro.replace(/^(SIZEOF|ALIGNOF)_/, '');
  const hit = KNOWN.get(rest);
  if (hit !== undefined) return hit;
  /* 剩下的是几个内建类型拼起来的（`LONG_LONG` / `LONG_DOUBLE` / `SHORT`）。 */
  const words = rest.toLowerCase().split('_');
  const OK = ['char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned'];
  return words.every((w) => OK.includes(w)) ? words.join(' ') : null;
}

/** 真跑一遍印 `sizeof` / `_Alignof`（探不出来交 null —— 那一格会当场报）。 */
function sizeOrAlign(macro) {
  const ty = typeOfSizeMacro(macro);
  if (ty === null) return null;
  const op = macro.startsWith('ALIGNOF_') ? '_Alignof' : 'sizeof';
  const r = runs('#include <stdio.h>\n#include <stddef.h>\n#include <stdint.h>\n'
    + '#include <sys/types.h>\n#include <pthread.h>\n#include <time.h>\n'
    + `int main(void){ printf("%d", (int)${op}(${ty})); return 0; }\n`);
  if (r === null || r.status !== 0) return null;
  const n = Number(r.out.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * `HAVE_DECL_RTLD_NOW` 那一族。与别的不同：`AC_CHECK_DECLS` **总是定义**
 * （有就 1、没有就 0），因为 CPython 那边写的是 `#if HAVE_DECL_X` 而不是 `#ifdef`。
 * 声明在哪份头里说不准，所以把常用那几份一起包上问一句"这个名字用得上吗"。
 */
function hasDecl(macro) {
  const name = macro.slice('HAVE_DECL_'.length);
  const heads = ['stdio.h', 'stdlib.h', 'string.h', 'unistd.h', 'dlfcn.h', 'math.h',
    'fcntl.h', 'signal.h', 'time.h', 'errno.h', 'limits.h', 'sys/types.h'];
  const inc = heads.map((h) => `#include <${h}>\n`).join('');
  return compiles(`${inc}int main(void){ (void)(${name}); return 0; }\n`) ? 1 : 0;
}

/** 按族认：认出来就往 `HOW` 里补一格（一格一格列的那几个优先，不覆盖）。 */
for (const name of needed) {
  if (HOW.has(name)) continue;
  if (name.startsWith('HAVE_DECL_')) { HOW.set(name, () => hasDecl(name)); continue; }
  if (/^HAVE_[A-Z0-9_]+_H$/.test(name)) { HOW.set(name, () => (hasHeader(name) ? 1 : null)); continue; }
  if (/^(SIZEOF|ALIGNOF)_/.test(name) && typeOfSizeMacro(name) !== null) {
    HOW.set(name, () => sizeOrAlign(name));
    continue;
  }
  /* 函数那一族：全小写下来是个合法的 C 标识符，而且不是上面那几种形状。
     判据是"链得上"，所以猜错名字的后果是"不定义"，与 autoconf 找不到那个函数一样。 */
  if (/^HAVE_[A-Z][A-Z0-9_]*$/.test(name)) {
    const fn = name.slice('HAVE_'.length).toLowerCase();
    HOW.set(name, () => (hasFunc(fn) ? 1 : null));
  }
}


/* ---- 两格真探针（照 configure.ac，按族认不出来的那种）--------------------- */

/**
 * 右移**补零**吗（`configure.ac:6845`）。
 *
 * 照它那段程序**一字不改**：`return (((-1)>>3 == -1) ? 0 : 1);` ——
 * 退出码 0 = 右移补的是符号位（几乎所有机器，**不定义**这个宏），1 = 补零（定义）。
 * 这一格的方向很容易写反（我第一版就反了，量出来 arm64 上答成了"补零"）：
 * 宏的名字说的是**反常的那一种**，所以"跑通了"= 不定义。
 */
function rshiftZeroFills() {
  const r = runs('int main(void)\n{\n\treturn (((-1)>>3 == -1) ? 0 : 1);\n}\n');
  return r !== null && r.status === 1;
}

/** `setpgrp` 要两个实参吗（`configure.ac:5989`：编一遍 `setpgrp(0,0)`）。 */
const setpgrpHasArg = () => hasFunc('setpgrp')
  && compiles('#include <unistd.h>\nint main(void){ setpgrp(0,0); return 0; }\n');

/* ---- 那几格**不是探针、是决定** -------------------------------------------
 *
 * 借整份运行时那件事（SPEC §一之二）量出来：对象层那一批读到 71 个宏，上面四族答了 59 个，
 * 剩下这 12 个**机器探不出来** —— 它们问的不是"这台机器怎么样"，而是"你想编成什么样"。
 * 所以一格一格写下决定与理由，理由跟着写进生成出来的那份头里（那份头要能自己解释自己）。
 * 这一处**故意不给缺省**：`HOW` 里没有的名字会当场报，逼着人做决定而不是留空。
 */
const WHY = new Map();
/** 决定：`[名字, 值（null = 不定义 / 'probe:*' = 上头那两格探针）, 理由]`。 */
const DECIDED = [
  ['WITH_PYMALLOC', 1,
    '照 configure 的缺省（configure.ac:5296 —— 除 Emscripten/WASI 一律 yes）。'
    + 'obmalloc 是对象层自己那套池分配器'],
  ['WITH_MIMALLOC', null,
    '**我们的决定**：不借 mimalloc（Objects/mimalloc/ 那一整棵第三方分配器）。'
    + '注意 configure 在这台机器上的缺省是 yes（configure.ac:5271 看 stdatomic.h 在不在）'
    + ' —— 这一格是有意与它不同的，代价是 mimalloc 那几条 #if 分支一律不编'],
  ['PYMALLOC_USE_HUGEPAGES', null, 'Linux 专有的一格加速（madvise 大页），与语义无关'],
  ['PYLONG_BITS_IN_DIGIT', null,
    '照 configure 的缺省：不定义（只有 --enable-big-digits 才给值，configure.ac:6649）。'
    + '不定义时 CPython 自己按 SIZEOF_VOID_P 挑 30 或 15（pycore_long.h）—— 让它挑'],
  ['WITH_DOC_STRINGS', 1,
    '照 configure 的缺省（configure.ac:5183）。这一格**是语义**：__doc__ 程序看得见'],
  ['WITH_DTRACE', null, '不借 DTrace 那几格探针（Include/pydtrace.h 那一路）'],
  ['PY_HAVE_PERF_TRAMPOLINE', null, '不借 perf 的跳板（给 Linux 的 perf 看栈用的）'],
  ['THREAD_STACK_SIZE', process.platform === 'darwin' ? '0x1000000' : null,
    'configure.ac:3822 —— Darwin / iOS 上给 16MB（系统默认 8MB 装不下它自己的递归上限），'
    + '别的平台不定义（用系统的）'],
  ['SIGNED_RIGHT_SHIFT_ZERO_FILLS', 'probe:rshift',
    'configure.ac:6845 —— 真跑一遍：右移补零才定义，补符号（几乎所有机器）不定义'],
  ['SETPGRP_HAVE_ARG', 'probe:setpgrp', 'configure.ac:5989 —— 编一遍 setpgrp(0,0)'],
  ['MVWDELCH_IS_EXPRESSION', null,
    'curses 专有，是扫整棵 Include/ 扫进来的（py_curses.h）—— 我们不借 curses'],
  ['WINDOW_HAS_FLAGS', null, '同上（curses 的 WINDOW 里有没有 _flags）'],
  ['WITH_VALGRIND', null,
    '照 configure 的缺省：不定义（`configure.ac:5357` 的 `with_valgrind=no`，'
    + '要 `--with-valgrind` 才开）。开着的话 `Objects/obmalloc.c` 那三处 `#ifdef` 会'
    + '在 valgrind 下绕开 pymalloc —— 我们不接 valgrind，所以让它走原路'],
];
for (const [name, value, why] of DECIDED) {
  WHY.set(name, why);
  if (value === 'probe:rshift') { HOW.set(name, () => (rshiftZeroFills() ? 1 : null)); continue; }
  if (value === 'probe:setpgrp') { HOW.set(name, () => (setpgrpHasArg() ? 1 : null)); continue; }
  HOW.set(name, () => value);
}

const unknown = [...needed].filter((n) => !HOW.has(n)).sort();
if (unknown.length > 0) {
  throw new Error(`gen-pyconf.js: 这 ${unknown.length} 个宏这几份源码读得到，可这儿不知道怎么探：\n`
    + `  ${unknown.join(' ')}\n`
    + '每一格都要么加一条探针（照 CPython 的 configure.ac，注明行号），要么写清"为什么不定义"。'
    + '悄悄留空的后果是 CPython 走进另一条 #else，然后在某个角落静默答错。');
}

if (fmt === null) {
  process.stderr.write('gen-pyconf.js: 这台机器上的 double 不是 64 位 IEEE-754（字节序对不上任何一种）'
    + ' —— dtoa.c 自己也会 #error，所以这儿先停下来\n');
  process.exit(1);
}

/* ---- 写出来 --------------------------------------------------------------- */

const lines = [
  '/* 生成物，别改。由 ext/python/rt/gen-pyconf.js 在这台机器上**真探一遍**写出来。',
  ' *',
  ` * 名单是算出来的：\`pyconfig.h.in\` 能定义 ${canDefine.size} 个宏，`,
  ` * 借来的那几份源码真读到 ${needed.size} 个 —— 只有这几个进得来。`,
  ' * 多借一份 .c 就往 gen-pyconf.js 的 SOURCES 里加一行，名单自己跟着长；',
  ' * 算出来的名字里有一个不认得怎么探的，那一份当场报，不留空。',
  ' */',
  '#ifndef OMNI_PYCONF_H',
  '#define OMNI_PYCONF_H',
  '',
  '/* pycore_* 那几份头自己要的 —— 我们确实在"编核心的一部分"。 */',
  '#ifndef Py_BUILD_CORE',
  '#define Py_BUILD_CORE 1',
  '#endif',
  '',
];
for (const name of [...needed].sort()) {
  const v = HOW.get(name)();
  /* 那几格"是决定不是探针"的，把理由跟着写进去 —— 这份头要能自己解释自己
     （下一个人看到 `/* #undef WITH_MIMALLOC *​/` 时不必去翻提交记录）。 */
  const why = WHY.get(name);
  if (why !== undefined) lines.push(`/* ${why} */`);
  lines.push(v === null ? `/* #undef ${name} */` : `#define ${name} ${v}`);
}
lines.push('', '#endif /* OMNI_PYCONF_H */', '');

const text = lines.join('\n');
mkdirSync(dirname(OUT), { recursive: true });
/* 内容一样就不写 —— 配合 ninja 的 `restat`（不然每趟都重编）。 */
if (!(existsSync(OUT) && readFileSync(OUT, 'utf8') === text)) writeFileSync(OUT, text);
