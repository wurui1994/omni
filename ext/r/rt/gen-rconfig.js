#!/usr/bin/env node
// ext/r/rt/gen-rconfig.js —— 从 `src/include/config.h.in` 生出**整份** `config.h`。
//
// 为什么要这一份：`libR`（R 的 C 运行时）要的不是 nmath 那十四个宏，而是 configure 那 421 个。
// 我们不跑 R 的 configure（那是 autoconf + make 那一套，我们的构建是 JS 写 rule 的 ninja），
// 所以这儿把它做的事**按种类分开**做：
//
//   * `HAVE_<X>_H`       → 真编一遍 `#include <x/y.h>`，编过就是有
//   * `HAVE_DECL_<X>`    → 真编一遍 `(void) X;`，回 1 / 0（这一族**必须**定义成 0 或 1）
//   * `HAVE_<FUNC>`      → 真编 + 真链一遍（autoconf 那个 `(void*)&F` 的写法，宏也认）
//   * `SIZEOF_X`         → 真跑一趟 `printf("%zu", sizeof(X))`
//   * 剩下的（PACKAGE / R_OS / USE_* / FC_* 这一族）→ **一张显式的表**，每一格写清值与依据
//
// 表里没有、又落不进上面四类的名字**当场报**（连名字一起印出来）。这一条是判据不是讲究：
// 少定义一格 `HAVE_*` 的后果往往不是编不过，而是 R 走进另一条 `#else`，然后在某个角落
// 静默答错 —— 那种错查起来要一天。
//
// 用法：node ext/r/rt/gen-rconfig.js --src <r-source> --out <config.h> [--cc clang] [-j 8]
//
// 内容没变就不写（给 ninja 的 `restat` 用）。

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i < 0 ? d : argv[i + 1];
};
const SRC = arg('--src', null);
const OUT = arg('--out', null);
const CC = arg('--cc', 'clang');
const JOBS = Number(arg('-j', '8'));
if (SRC === null || OUT === null) {
  process.stderr.write('用法：gen-rconfig.js --src <r-source> --out <config.h> [--cc clang]\n');
  process.exit(2);
}

const version = readFileSync(join(SRC, 'VERSION'), 'utf8').trim();
const shortVer = version.split(' ')[0];
const host = `${process.arch === 'arm64' ? 'aarch64' : process.arch}-apple-darwin${
  spawnSync('uname', ['-r'], { encoding: 'utf8' }).stdout.trim()}`;
const hostCpu = host.split('-')[0];
const hostOs = host.split('-').slice(2).join('-');

/* ─── 探针 ─────────────────────────────────────────────────────────────── */

const work = mkdtempSync(join(tmpdir(), 'omni-rconf-'));
const PRELUDE = [
  'stdio.h', 'stdlib.h', 'string.h', 'strings.h', 'unistd.h', 'time.h', 'math.h',
  'limits.h', 'locale.h', 'wchar.h', 'wctype.h', 'ctype.h', 'errno.h', 'fcntl.h',
  'signal.h', 'stdarg.h', 'stddef.h', 'stdint.h', 'inttypes.h', 'sys/types.h',
  'sys/stat.h', 'sys/time.h', 'sys/times.h', 'sys/utsname.h', 'sys/select.h',
  'sys/socket.h', 'sys/wait.h', 'netdb.h', 'netinet/in.h', 'arpa/inet.h',
  'dirent.h', 'dlfcn.h', 'pwd.h', 'grp.h', 'glob.h', 'langinfo.h', 'iconv.h',
  'pthread.h', 'termios.h', 'utime.h', 'sys/resource.h', 'sys/param.h',
  'fenv.h', 'float.h', 'setjmp.h', 'sys/mman.h', 'complex.h', 'stdbool.h',
].map((h) => `#include <${h}>`).join('\n');

let probeN = 0;
/** 编一趟（`link` 为真时连链接一起）。回 true 表示过了。 */
function tryCc(body, link) {
  const p = join(work, `p${probeN}.c`);
  probeN += 1;
  writeFileSync(p, body);
  const outBin = `${p}.out`;
  const args = link ? [p, '-o', outBin] : ['-c', p, '-o', `${p}.o`];
  const r = spawnSync(CC, ['-w', '-std=gnu17', ...args], { stdio: 'ignore' });
  return { ok: r.status === 0, bin: outBin };
}
const haveHeader = (h) => tryCc(`#include <${h}>\nint main(void){return 0;}\n`, false).ok;
/** autoconf 那个写法：是宏就当有，不是宏就取一次地址（声明冲突也就露出来了）。 */
const haveFunc = (f) => tryCc(`${PRELUDE}\nint main(void){\n#if defined ${f} || defined __${f}\n  return 0;\n#else\n  void *p = (void *) ${f}; return p != (void *) 1;\n#endif\n}\n`, true).ok;
const haveDecl = (f) => tryCc(`${PRELUDE}\nint main(void){\n#ifndef ${f}\n  (void) ${f};\n#endif\n  return 0;\n}\n`, false).ok;
function sizeOf(type) {
  const r = tryCc(`${PRELUDE}\nint main(void){printf("%zu", sizeof(${type}));return 0;}\n`, true);
  if (!r.ok) return null;
  const run = spawnSync(r.bin, [], { encoding: 'utf8' });
  return run.status === 0 ? Number(run.stdout.trim()) : null;
}

/* ─── 那张显式的表 ─────────────────────────────────────────────────────── */

/**
 * 探不出来的那一族：值是**我们定的**，所以每一格都写依据。
 * `null` = 留着不定义。字符串值原样写进去（要引号的自己带）。
 */
const TABLE = new Map(Object.entries({
  /* 包的身份（configure.ac 的 AC_INIT，第 33 行） */
  PACKAGE: '"R"',
  PACKAGE_NAME: '"R"',
  PACKAGE_TARNAME: '"R"',
  PACKAGE_VERSION: `"${shortVer}"`,
  PACKAGE_STRING: `"R ${shortVer}"`,
  PACKAGE_BUGREPORT: '"https://bugs.r-project.org"',
  PACKAGE_URL: '"https://www.r-project.org"',
  VERSION: `"${shortVer}"`,
  /* 这台机器（configure.ac 第 70..76 行拿的是 ${host}） */
  R_PLATFORM: `"${host}"`,
  R_CPU: `"${hostCpu}"`,
  R_VENDOR: '"apple"',
  R_OS: `"${hostOs}"`,
  R_ARCH: '""',
  SHLIB_EXT: '".so"',
  R_PRINTCMD: '"lpr"',
  R_INLINE: 'inline',
  IEEE_754: '1',
  INT_32_BITS: '1',
  STDC_HEADERS: '1',
  /* darwin 上 configure 强制内部时区码（configure.ac 2315..2338） */
  USE_INTERNAL_MKTIME: '1',
  MKTIME_SETS_ERRNO: '1',
  /* 同上那一段：内部 iswxxx / towlower / wcwidth（2341..2362） */
  USE_RI18N_FNS: '1',
  USE_RI18N_WIDTH: '1',
  USE_RI18N_CASE: '1',
  USE_POSIX_THREADS: '1',
  USE_POSIX_THREADS_WEAK: null,
  USE_PTH_THREADS: null,
  USE_PTH_THREADS_WEAK: null,
  USE_SOLARIS_THREADS: null,
  USE_SOLARIS_THREADS_WEAK: null,
  USE_WIN32_THREADS: null,
  PTHREAD_IN_USE_DETECTION_HARD: null,
  /* 不做的那几格：每一格都是一项能力，明写在 ext/r/SPEC.md */
  ENABLE_NLS: null,
  USE_ICU: null,
  USE_ICU_APPLE: null,
  USE_LIBDEFLATE: null,
  SUPPORT_OPENMP: null,
  R_MEMORY_PROFILING: null,
  TESTING_WRITE_BARRIER: null,
  VALGRIND_LEVEL: '0',
  NVALGRIND: '1',
  X_DISPLAY_MISSING: '1',
  /* Fortran（gfortran）：名字加一个下划线，字符长度参数是 size_t */
  FC_FUNC: 'FC_FUNC(name,NAME) name ## _',
  FC_FUNC_: 'FC_FUNC_(name,NAME) name ## _',
  FC_LEN_T: 'size_t',
  FC_DUMMY_MAIN: null,
  FC_DUMMY_MAIN_EQ_F77: '1',
  CC_VER: `"${(spawnSync(CC, ['--version'], { encoding: 'utf8' }).stdout || '').split('\n')[0]}"`,
  FC_VER: '"gfortran"',
  C_ALLOCA: null,
  STACK_DIRECTION: '-1',
  C_STACK_DIRECTION: '-1',
  ICONV_CONST: '',
  LT_OBJDIR: '".libs/"',
  OS_MUSL: null,
  PRI_MACROS_BROKEN: null,
  INTDIV0_RAISES_SIGFPE: null,
  OBJC_NEXT_RUNTIME: '1',
  OBJC_GNU_RUNTIME: null,
  WORDS_BIGENDIAN: null,
  TYPEOF_STRUCT_STAT_ST_ATIM_IS_STRUCT_TIMESPEC: '1',
  PCRE2_CODE_UNIT_WIDTH: '8',
  R_SOCKLEN_T: 'socklen_t',
  R_PROFILING: '1',
  SIZE_MAX: null,
  _FILE_OFFSET_BITS: null,
  _LARGEFILE_SOURCE: null,
  _LARGE_FILES: null,
  _TIME_BITS: null,
  _UINT64_T: null,
  __MINGW_USE_VC2005_COMPAT: null,
  U: null,
  W: null,
  /* 外部库：这台机器上量过（pcre2 10.48 / zlib / curl / lzma / bzip2 / iconv 都在） */
  HAVE_PCRE2: '1',
  HAVE_LIBCURL: '1',
  HAVE_LZMA: '1',
  HAVE_LIBDEFLATE: null,
  HAVE_LIBICUCORE: null,
  /* 图形：**要 quartz**（R 自己那份 Cocoa 设备），不要 X11 / cairo */
  HAVE_AQUA: '1',
  HAVE_X11: null,
  HAVE_WORKING_CAIRO: null,
  HAVE_WORKING_X11_CAIRO: null,
  HAVE_PANGOCAIRO: null,
  HAVE_CAIRO_PDF: null,
  HAVE_CAIRO_PS: null,
  HAVE_CAIRO_SVG: null,
  HAVE_JPEG: null,
  HAVE_PNG: null,
  HAVE_TIFF: null,
  HAVE_OPENMP: null,
  HAVE_OPENMP_SIMDRED: null,
  /* Fortran 名字修饰（gfortran：一个下划线、没有额外那一个） */
  HAVE_F77_UNDERSCORE: '1',
  HAVE_F77_EXTRA_UNDERSCORE: null,
  /* 几格"能用吗"：macOS 的 libc 这几格都是好的（R 的 configure 也这么判） */
  HAVE_WORKING_CALLOC: '1',
  HAVE_WORKING_FTELL: '1',
  HAVE_WORKING_ISFINITE: '1',
  HAVE_WORKING_LOG1P: '1',
  HAVE_WORKING_CTANH: '1',
  HAVE_WORKING_SIGACTION: '1',
  HAVE_POSIX_SETJMP: '1',
  HAVE_POSIX_PRINTF: '1',
  HAVE_POSIX_LEAPSECONDS: '1',    /* 内部时区码那一档下 R 按 POSIX 算（不带闰秒）——
                                     `datetime.c` 的 `n_leapseconds` 只在**不用**内部
                                     时区码那一支里定义，而用它的地方只看这一格；
                                     所以 `USE_INTERNAL_MKTIME` 与这一格要一起开。 */
  HAVE_WORKING_MKTIME_AFTER_2037: '1',
  HAVE_WORKING_MKTIME_BEFORE_1902: '1',
  HAVE_WORKING_MKTIME_BEFORE_1970: '1',
  HAVE_VISIBILITY: '1',
  HAVE_VISIBILITY_ATTRIBUTE: '1',
  HAVE_LONG_DOUBLE: '1',
  HAVE_ALLOCA: '1',
  /* pthread 是**库**不是函数，探针那条路（取 `pthread` 的地址）答不出来。
     macOS 的 libc 自带 pthread，R 的 configure 也是按库查的。
     漏了它的症状不是"少一格功能"：`eval.c` 的 `__APPLE__` 分支里用的
     `R_profiled_thread` 只在 `HAVE_PTHREAD` 下声明，于是 eval.c 编不过。 */
  HAVE_PTHREAD: '1',
  /* autoconf 的 AC_USE_SYSTEM_EXTENSIONS 那一族：它一律定义成 1（这样各家 libc 才把
     扩展那一半露出来），只有 MINIX 与 `_POSIX_SOURCE` 那三格是留给 MINIX 的。 */
  _ALL_SOURCE: '1',
  _DARWIN_C_SOURCE: '1',
  __EXTENSIONS__: '1',
  _GNU_SOURCE: '1',
  _HPUX_ALT_XOPEN_SOCKET_API: '1',
  _NETBSD_SOURCE: '1',
  _OPENBSD_SOURCE: '1',
  _POSIX_PTHREAD_SEMANTICS: '1',
  _TANDEM_SOURCE: '1',
  __STDC_WANT_IEC_60559_ATTRIBS_EXT__: '1',
  __STDC_WANT_IEC_60559_BFP_EXT__: '1',
  __STDC_WANT_IEC_60559_DFP_EXT__: '1',
  __STDC_WANT_IEC_60559_EXT__: '1',
  __STDC_WANT_IEC_60559_FUNCS_EXT__: '1',
  __STDC_WANT_IEC_60559_TYPES_EXT__: '1',
  __STDC_WANT_LIB_EXT2__: '1',
  __STDC_WANT_MATH_SPEC_FUNCS__: '1',
  _MINIX: null,
  _POSIX_SOURCE: null,
  _POSIX_1_SOURCE: null,
  _XOPEN_SOURCE: null,        /* 定了它 macOS 反而把 BSD 那一半藏起来 */
  /* 这两格是 R 自己的"哪套系统"开关 */
  Unix: '1',
  Win32: null,
  /* 下面这些是 autoconf 的"没有这个类型就替它定义一个"—— macOS 上全都有，所以都不定义。
     这一格要是定错了（比如 `#define const`）后果是整棵树的语义变了，所以宁可显式留空。 */
  const: null,
  inline: null,
  blkcnt_t: null,
  pid_t: null,
  ptrdiff_t: null,
  size_t: null,
  uint64_t: null,
  uintmax_t: null,
}));

/** `SIZEOF_X` → 要量的那个类型。 */
const SIZEOF_TYPE = new Map(Object.entries({
  SIZEOF_DOUBLE: 'double',
  SIZEOF_INT: 'int',
  SIZEOF_LONG: 'long',
  SIZEOF_LONG_DOUBLE: 'long double',
  SIZEOF_LONG_LONG: 'long long',
  SIZEOF_SIZE_T: 'size_t',
}));

/** `HAVE_<X>_H` → 头文件名。规则是"下划线换斜杠"，但有几格得掰回来。 */
const HEADER_FIX = new Map(Object.entries({
  HAVE_SYS_TIME_H: 'sys/time.h',
  HAVE_NETINET_IN_H: 'netinet/in.h',
  HAVE_ARPA_INET_H: 'arpa/inet.h',
  HAVE_X11_XMU_ATOMS_H: 'X11/Xmu/Atoms.h',
  HAVE_LIBINTL_H: 'libintl.h',
  HAVE_BZLIB_H: 'bzlib.h',
  HAVE_ZLIB_H: 'zlib.h',
  HAVE_LZMA_H: 'lzma.h',
  HAVE_PCRE2_H: 'pcre2.h',
  HAVE_JPEGLIB_H: 'jpeglib.h',
  HAVE_PNG_H: 'png.h',
  HAVE_TIFFIO_H: 'tiffio.h',
  HAVE_CURL_CURL_H: 'curl/curl.h',
  HAVE_ICONV_H: 'iconv.h',
  HAVE_ELF_H: 'elf.h',
  HAVE_SYS_SELECT_H: 'sys/select.h',
}));
const headerOf = (name) => HEADER_FIX.get(name)
  ?? `${name.replace(/^HAVE_/, '').replace(/_H$/, '').toLowerCase().replace(/_/g, '/')}.h`;

/* ─── 走一遍 config.h.in ───────────────────────────────────────────────── */

const tpl = readFileSync(join(SRC, 'src/include/config.h.in'), 'utf8');
const lines = tpl.split('\n');
const unknown = [];
const out = [];
let nProbe = 0;
let nTable = 0;

for (const line of lines) {
  const m = /^#\s*undef\s+([A-Za-z0-9_]+)\s*$/.exec(line);
  if (m === null) {
    out.push(line);
    continue;
  }
  const name = m[1];
  const emit = (v) => out.push(v === null ? `/* #undef ${name} */` : `#define ${name} ${v}`);
  if (TABLE.has(name)) {
    nTable += 1;
    emit(TABLE.get(name));
  } else if (SIZEOF_TYPE.has(name)) {
    nProbe += 1;
    const n = sizeOf(SIZEOF_TYPE.get(name));
    if (n === null) throw new Error(`gen-rconfig：${name} 量不出来（${SIZEOF_TYPE.get(name)} 编不过）`);
    emit(String(n));
  } else if (/^HAVE_[A-Z0-9_]+_H$/.test(name)) {
    nProbe += 1;
    emit(haveHeader(headerOf(name)) ? '1' : null);
  } else if (/^HAVE_DECL_/.test(name)) {
    /* 这一族 autoconf 一律定义成 0 或 1 —— 源码里写的是 `#if HAVE_DECL_X`。
       **大小写两样都要试**：宏名是全大写的，而它指的那个符号可能是小写（`isnan`）
       也可能是大写（`SIZE_MAX` / `RTLD_DEFAULT`）—— 只按小写试的话 `HAVE_DECL_SIZE_MAX`
       会答 0，然后 `Defn.h` 那句 `#error SIZE_MAX is required for C99` 当场把整棵树挡住
       （这是量出来的第一个坑）。 */
    nProbe += 1;
    const raw = name.replace(/^HAVE_DECL_/, '');
    emit(haveDecl(raw.toLowerCase()) || haveDecl(raw) ? '1' : '0');
  } else if (/^HAVE_[A-Z0-9_]+_T$/.test(name)) {
    /* `HAVE_STACK_T` / `HAVE_SOCKLEN_T` 这一族问的是**类型**在不在，
       按函数探（取 `stack_t` 的地址）一定答不出来 —— 漏了 `HAVE_STACK_T` 的症状是
       `main.c` 走进 `struct sigaltstack` 那一支，而 macOS 的 SDK 里那个 tag 不存在。 */
    nProbe += 1;
    const t = name.replace(/^HAVE_/, '').toLowerCase();
    emit(sizeOf(t) === null ? null : '1');
  } else if (/^HAVE_/.test(name)) {
    nProbe += 1;
    const raw = name.replace(/^HAVE_/, '');
    emit(haveFunc(raw.toLowerCase()) || haveFunc(raw) ? '1' : null);
  } else {
    unknown.push(name);
    out.push(`/* #undef ${name} */`);
  }
}

if (unknown.length > 0) {
  rmSync(work, { recursive: true, force: true });
  throw new Error(`gen-rconfig：这 ${unknown.length} 格既不在表里、也落不进四类探针，`
    + `所以我说不出它该是什么 —— 要么加进 TABLE（连依据一起写），要么说清为什么可以不定义：\n  ${unknown.join(' ')}`);
}

const head = `/* ext/r/rt/gen-rconfig.js 生成 —— 别手改。\n`
  + ` * 来源：${join(SRC, 'src/include/config.h.in')}\n`
  + ` * 这一趟：探针 ${nProbe} 格、表里 ${nTable} 格。${CC} / ${host}\n`
  + ` */\n`;
const text = head + out.join('\n');
rmSync(work, { recursive: true, force: true });

/* 内容没变就不写 —— ninja 那边靠 restat 把下游整条链剪掉。 */
if (existsSync(OUT) && readFileSync(OUT, 'utf8') === text) {
  process.stdout.write(`gen-rconfig: ${OUT} 没变（探针 ${nProbe} / 表 ${nTable}）\n`);
  process.exit(0);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, text);
process.stdout.write(`gen-rconfig: 写了 ${OUT}（${text.length} 字节，探针 ${nProbe} / 表 ${nTable}）\n`);



