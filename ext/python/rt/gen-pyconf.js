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

/** `unistd.h` 自己定不定 `_POSIX_THREADS`（`configure.ac:4885` 的 `AX_CHECK_DEFINE`）。 */
const unistdDefinesPosixThreads = () => compiles('#include <unistd.h>\n'
  + '#ifndef _POSIX_THREADS\n#error no\n#endif\nint main(void){ return 0; }\n');

/* ---- `Modules/` 那一棵带进来的几格（扩面那一刀补的）--------------------------
 *
 * 这几格全在 `Modules/` 下才读得到，所以要 `--extra …,Modules` 才进名单。
 * 四个真探针照 `configure.ac` 的程序原样跑，剩下的是"借不借那个第三方库"的决定。 */

/** IPv6 能不能真开（`configure.ac:5028-5050`：建一个 `AF_INET6` 的 socket 看成不成）。 */
const ipv6Works = () => {
  const r = runs('#include <sys/types.h>\n#include <sys/socket.h>\n'
    + 'int main(void){ int s = socket(AF_INET6, SOCK_STREAM, 0);\n'
    + '  if (s < 0) return 1; return 0; }\n');
  return r !== null && r.status === 0;
};

/** `getpgrp(0)` 编得过吗（`configure.ac:5980-5986`）。 */
const getpgrpHasArg = () => compiles('#include <unistd.h>\nint main(void){ getpgrp(0); return 0; }\n');

/**
 * `major` / `minor` / `makedev` 从哪个头来（`configure.ac:6042` 那段链接测试，**三选一**：
 * 先试只 `<sys/types.h>`，不成试 `<sys/mkdev.h>`，再不成试 `<sys/sysmacros.h>`）。
 * 探一次记住 —— 两格宏问的是同一件事。
 */
let devMacros = 'not-yet';
function deviceMacrosIn() {
  if (devMacros !== 'not-yet') return devMacros;
  const prog = (inc) => `${inc}int main(void){ makedev(major(0), minor(0)); return 0; }\n`;
  if (links(prog('#include <sys/types.h>\n'))) devMacros = null;
  else if (links(prog('#include <sys/mkdev.h>\n#include <sys/types.h>\n'))) devMacros = 'MAJOR_IN_MKDEV';
  else if (links(prog('#include <sys/types.h>\n#include <sys/sysmacros.h>\n'))) devMacros = 'MAJOR_IN_SYSMACROS';
  else devMacros = null;
  return devMacros;
}

/** POSIX 信号量真能用吗（`configure.ac:6560-6585` 那个程序原样跑）。 */
const posixSemaphoresWork = () => {
  const r = runs('#include <unistd.h>\n#include <fcntl.h>\n#include <stdio.h>\n'
    + '#include <semaphore.h>\n#include <sys/stat.h>\n'
    + 'int main(void){ sem_t *a = sem_open("/autoconf", O_CREAT, S_IRUSR|S_IWUSR, 0);\n'
    + '  if (a == SEM_FAILED) { perror("sem_open"); return 1; }\n'
    + '  sem_close(a); sem_unlink("/autoconf"); return 0; }\n');
  return r !== null && r.status === 0;
};

/**
 * `sem_getvalue` 坏不坏（`configure.ac:6600-6627` 那个程序）：开一个信号量、问它的值，
 * **问不出来就算坏**（macOS 上 `sem_getvalue` 压根没实现，回 -1/ENOSYS）。
 * 与上面那格一样是"名字反着的"：坏才定义。
 */
const semGetvalueBroken = () => {
  const r = runs('#include <unistd.h>\n#include <fcntl.h>\n#include <semaphore.h>\n'
    + '#include <sys/stat.h>\n'
    + 'int main(void){ sem_t *a = sem_open("/autocvt", O_CREAT, S_IRUSR|S_IWUSR, 0);\n'
    + '  int v; int bad = 0;\n'
    + '  if (a == SEM_FAILED) return 1;\n'
    + '  if (sem_getvalue(a, &v) < 0) bad = 1;\n'
    + '  sem_close(a); sem_unlink("/autocvt"); return bad; }\n');
  /* 跑不起来（连不上、编不过）就不下结论 —— 与 configure 的 cross-compile 缺省一致：不坏 */
  return r !== null && r.status === 1;
};

/** `/dev/ptmx` 在不在（`configure.ac:7547` 的 `AC_CHECK_FILE`）—— 这一格不用编译器，看文件。 */
const devPtmxExists = () => existsSync('/dev/ptmx');

/** `struct dirent` 有 `d_type` 吗（`configure.ac:7878-7882`：还要 `DT_UNKNOWN` 在）。 */
const direntHasDType = () => compiles('#include <dirent.h>\n'
  + 'int main(void){ struct dirent e; return e.d_type == DT_UNKNOWN; }\n');

/** `struct sockaddr` 有 `sa_len` 吗（`configure.ac:6304-6307`，BSD 一族才有）。 */
const sockaddrHasSaLen = () => compiles('#include <sys/types.h>\n#include <sys/socket.h>\n'
  + 'int main(void){ struct sockaddr x; x.sa_len = 0; return 0; }\n');

/** `siginfo_t` 有 `si_band` 吗（`AC_CHECK_MEMBERS([siginfo_t.si_band])` —— 它是 typedef，
 * 所以宏名里**没有** `STRUCT`，`hasMember` 那一族接不到它）。 */
const siginfoHasSiBand = () => compiles('#include <signal.h>\n'
  + 'int main(void){ siginfo_t x; (void)x.si_band; return 0; }\n');

/** `struct stat` 的纳秒那一格是 `st_mtimespec.tv_nsec`（BSD 写法，`configure.ac:7215-7221`）。 */
const statHasTvNsec2 = () => compiles('#include <sys/types.h>\n#include <sys/stat.h>\n'
  + 'int main(void){ struct stat st; st.st_mtimespec.tv_nsec = 1; return 0; }\n');

/** 一个常量在不在（`MAXLOGNAME` / `UT_NAMESIZE`，`configure.ac:5935-5950`）。 */
const hasConst = (name, head) => compiles(`#include <${head}>\n`
  + `int main(void){ return (int)${name}; }\n`);

/**
 * `tzset` 管不管用（`configure.ac:7150-7193` 那个程序的**短版**）：换 `TZ` 再 `tzset`，
 * 看 `localtime` 跟不跟着变。CPython 那份还多查几个时区与 `altzone`；这儿只要"跟着变"
 * 这一条 —— 记一笔：短了，所以它只会答得比 configure **保守**（不会把坏的说成好的）。
 */
const tzsetWorks = () => {
  const r = runs('#include <stdlib.h>\n#include <time.h>\n#include <string.h>\n'
    + 'int main(void){ time_t t = 1234567890;\n'
    + '  setenv("TZ", "UTC+0", 1); tzset();\n'
    + '  struct tm a = *localtime(&t);\n'
    + '  setenv("TZ", "EST+5EDT", 1); tzset();\n'
    + '  struct tm b = *localtime(&t);\n'
    + '  return (a.tm_hour == b.tm_hour) ? 1 : 0; }\n');
  return r !== null && r.status === 0;
};

/* ---- 算名单：`pyconfig.h.in 能定义的` ∩ `这几份源码真测到的` ---------------- */

const conf = readFileSync(join(SRC, 'pyconfig.h.in'), 'utf8');
const canDefine = new Set([...conf.matchAll(/^#\s*undef\s+([A-Za-z0-9_]+)\s*$/gm)].map((m) => m[1]));
/**
 * 那几格在模板里**自己带 `#ifndef` 罩子**的（`AC_USE_SYSTEM_EXTENSIONS` 出的那一族：
 * `pyconfig.h.in:2020` 起的 `_ALL_SOURCE` / `_GNU_SOURCE` / `_XOPEN_SOURCE` …）。
 *
 * 罩子不是装饰：`Python/remote_debugging.c:1` 自己先 `#define _GNU_SOURCE`（空体），
 * 我们要是无罩子地再 `#define _GNU_SOURCE 1`，那一份就多一条 `redefined` 警告
 * （量到过）。照模板的形状出，警告就没了。
 */
const guarded = new Set([...conf.matchAll(/^#\s*ifndef\s+(\w+)\s*\n#\s*undef\s+\1\s*\n#\s*endif/gm)]
  .map((m) => m[1]));

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
    /* `_` 打头的也要收：`_PYTHONFRAMEWORK` / `_POSIX_THREADS` / `_XOPEN_SOURCE` 这一族
     * 都在 `pyconfig.h.in` 里，从前那道 `[A-Z]` 打头的筛子把它们整族漏了 ——
     * 量到的后果是 `Python/sysmodule.c:4025` 报「名字看不见：_PYTHONFRAMEWORK」。 */
    for (const m of text.matchAll(/\b(_?[A-Z][A-Z0-9_]{2,})\b/g)) {
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

/**
 * `HAVE_STRUCT_TM_TM_ZONE` 那一族（autoconf 的 `AC_CHECK_MEMBERS`）：**问的不是函数，
 * 是"这个结构体有这个成员吗"**。名字是 `HAVE_STRUCT_<类型>_<成员>`，而**哪个下划线是分界
 * 看不出来**（`STRUCT_STAT_ST_BLKSIZE` 是 `struct stat` 的 `st_blksize`），所以每种切法
 * 都试一遍 —— 与 `headerCandidates` 同一手法。
 *
 * 头包得宽（`AC_CHECK_MEMBERS` 在 CPython 那边是一处一处指定的）：这一问是"存在吗"，
 * 多包几份头只会让答案更容易是"有"，而这一族的正确答案本来就是"有"。
 * 从前它落进"链得上一个叫 `struct_stat_st_blksize` 的函数吗"那一族、一律答"没有" ——
 * 代价是 `os.stat()` 那几格属性在借来的运行时里会**静悄悄少掉**。
 */
const MEMBER_HEADS = ['sys/types.h', 'sys/stat.h', 'sys/socket.h', 'sys/time.h', 'time.h',
  'pwd.h', 'grp.h', 'dirent.h', 'signal.h', 'netdb.h', 'unistd.h']
  .map((h) => `#include <${h}>\n`).join('');
function hasMember(macro) {
  const parts = macro.slice('HAVE_STRUCT_'.length).toLowerCase().split('_');
  for (let i = 1; i < parts.length; i += 1) {
    const ty = parts.slice(0, i).join('_');
    const mem = parts.slice(i).join('_');
    if (compiles(`${MEMBER_HEADS}int main(void){ struct ${ty} x; (void)x.${mem}; return 0; }\n`)) {
      return 1;
    }
  }
  return null;
}

/**
 * **`AC_CHECK_TYPES` 那一族**（`HAVE_ADDRINFO` / `HAVE_SOCKADDR_STORAGE` /
 * `HAVE_SOCKADDR_ALG`）：问的是"**这个结构体在不在**"，不是"链得上这个函数吗"。
 *
 * 宏名上看不出来 —— `HAVE_ADDRINFO` 与 `HAVE_GETADDRINFO` 长得一模一样，所以从前它们
 * 落进函数那一族、`hasFunc('addrinfo')` 链不上、**一律不定义**。代价是借来的
 * `socketmodule.c` 编不出来：`Modules/addrinfo.h` 见 `HAVE_ADDRINFO` 没定义就**自己
 * 补一份** `struct addrinfo` / `struct sockaddr_storage`，与系统头撞成 redefinition
 * （量出来的原话：`redefinition of 'struct sockaddr_storage'` / `'struct addrinfo'`）。
 *
 * 来路：`configure.ac` 的 `AC_CHECK_TYPES([struct addrinfo],…,[#include <netdb.h>])`
 * 那三条。这一族**只有这三格**，所以一格一格列、各写自己的头。
 */
const TYPE_CHECKS = new Map([
  ['HAVE_ADDRINFO', ['struct addrinfo', ['netdb.h']]],
  ['HAVE_SOCKADDR_STORAGE', ['struct sockaddr_storage', ['sys/types.h', 'sys/socket.h']]],
  ['HAVE_SOCKADDR_ALG', ['struct sockaddr_alg', ['sys/socket.h', 'linux/if_alg.h']]],
]);
function hasType(macro) {
  const [ty, heads] = TYPE_CHECKS.get(macro);
  const inc = heads.map((h) => `#include <${h}>\n`).join('');
  return compiles(`${inc}int main(void){ ${ty} x; (void)x; return 0; }\n`) ? 1 : null;
}

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
  if (TYPE_CHECKS.has(name)) { HOW.set(name, () => hasType(name)); continue; }
  if (name.startsWith('HAVE_STRUCT_')) { HOW.set(name, () => hasMember(name)); continue; }
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

/**
 * **`PY_CHECK_FUNC` 那一族要换一种问法** —— 从 `configure.ac` 里**读出来**，不写死。
 *
 * CPython 自己有两种"有没有这个函数"的检查，而宏名上看不出是哪一种：
 *   * `AC_CHECK_FUNCS(x)` 问的是**链得上吗**（上面那个 `hasFunc`）；
 *   * `PY_CHECK_FUNC(x, [头])`（`configure.ac:57-70`）问的是**这几份头声明了它吗**
 *     —— 它的程序体就是 `void *x = 函数名;`，连都不连。
 *
 * 差别会咬人：`fdatasync` 在 macOS 上 libSystem **真有这个符号**（链得上、还跑得通），
 * 可 `<unistd.h>` 里**没有声明**。于是链法答"有"、`PY_CHECK_FUNC` 答"没有" ——
 * 本机那份真 CPython 的 pyconfig 写的就是 `/* #undef HAVE_FDATASYNC *​/`。
 * 我们从前答"有"，`Modules/posixmodule.c:4478` 于是去拿 `fdatasync` 的地址，
 * 报 `'fdatasync' undeclared` —— **clang 在同一份配置下一字不差地也报这一句**，
 * 所以那不是前端的欠账，是这一格答错了。
 *
 * 这儿的办法是**照 `configure.ac` 的原文来**：把每一处 `PY_CHECK_FUNC` 的名字、头、
 * 宏名解析出来，按它的问法探。换棵 CPython 树就跟着变，不用改这儿一个字。
 */
const PY_CHECK_RE = /PY_CHECK_FUNC\(\s*\[(\w+)\]\s*,\s*\[([\s\S]*?)\]\s*(?:,\s*\[(\w+)\]\s*)?\)/g;
const confAc = readFileSync(join(SRC, 'configure.ac'), 'utf8');
let pyCheckN = 0;
for (const m of confAc.matchAll(PY_CHECK_RE)) {
  const fn = m[1];
  /* m4 的四联字 `@%:@` 就是 `#`（`configure.ac` 里的 `@%:@include <unistd.h>`） */
  const heads = m[2].replaceAll('@%:@', '#').trim();
  const macro = m[3] ?? `HAVE_${fn.toUpperCase()}`;
  if (!needed.has(macro)) continue;
  pyCheckN += 1;
  HOW.set(macro, () => (compiles(`${heads}\nint main(void){ void *x = ${fn}; return x != 0; }\n`)
    ? 1 : null));
}
if (pyCheckN === 0) {
  process.stderr.write('gen-pyconf.js: 从 configure.ac 里一条 `PY_CHECK_FUNC` 都没解析出来'
    + ' —— 那份文件的形状变了，这一族会静悄悄退回"链得上吗"那种问法\n');
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

/**
 * `pthread_key_t` 与 int 兼容吗（`configure.ac:3436-3452`）。
 * 两问都要过：宽度一样（`AC_CHECK_SIZEOF`），而且**它能当算术类型用**
 * （`pthread_key_t k; k * 1;` 编得过 —— 那一句就是 configure 写的）。
 */
function pthreadKeyIsInt() {
  const sz = runs('#include <pthread.h>\n#include <stdio.h>\n'
    + 'int main(void){ printf("%d %d\\n", (int)sizeof(pthread_key_t), (int)sizeof(int)); return 0; }\n');
  if (sz === null) return false;
  const [a, b] = sz.out.trim().split(/\s+/).map(Number);
  if (a !== b) return false;
  return compiles('#include <pthread.h>\nint main(void){ pthread_key_t k = 0; return (int)(k * 1); }\n');
}

/**
 * `PTHREAD_SCOPE_SYSTEM` 真能用吗（`configure.ac:4960-4990`）——
 * configure 那段是**真编真跑**：起一个 system 域的线程再 join 一遍，
 * 退出码 0 才算支持（编不过 / 跑不过都算不支持，与它的 cross 回退一致）。
 */
function pthreadSystemSched() {
  const r = runs('#include <pthread.h>\n#include <stdio.h>\n'
    + 'void *foo(void *p){ (void)p; return NULL; }\n'
    + 'int main(void){ pthread_attr_t attr; pthread_t id;\n'
    + '  if (pthread_attr_init(&attr)) return -1;\n'
    + '  if (pthread_attr_setscope(&attr, PTHREAD_SCOPE_SYSTEM)) return -1;\n'
    + '  if (pthread_create(&id, &attr, foo, NULL)) return -1;\n'
    + '  if (pthread_join(id, NULL)) return -1;\n'
    + '  return 0; }\n');
  return r !== null && r.status === 0;
}

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

  /* ---- `Python/` 整棵带进来的那七格（这一刀补的）。 */
  ['PY_COERCE_C_LOCALE', 1,
    '照 configure 的缺省 **yes**（`configure.ac:5335-5349`：`--with-c-locale-coercion`'
    + ' 不给值就是 yes）。这一格**是语义**：C locale 下把它强制成 UTF-8（PEP 538）'],
  ['PTHREAD_KEY_T_IS_COMPATIBLE_WITH_INT', 'probe:pkey',
    'configure.ac:3436 —— 两问都要过：宽度与 int 一样，而且 `pthread_key_t k; k * 1;`'
    + ' 编得过（那一句就是 configure 写的）'],
  ['PTHREAD_SYSTEM_SCHED_SUPPORTED', 'probe:psched',
    'configure.ac:4960 —— 真编真跑：起一个 `PTHREAD_SCOPE_SYSTEM` 的线程再 join'],
  ['USE_COMPUTED_GOTOS', null,
    '照 configure 的缺省：**两条 `AC_DEFINE` 都不走**（`configure.ac:7597`：'
    + '`--with-computed-gotos` 不给值就"no value specified"，宏压根不定义）。'
    + '不定义时 CPython 自己按编译器挑（`ceval_macros.h` 看 `__GNUC__`）—— 让它挑。'
    + '记一笔：它挑"开"的那一支要 `&&label` 与 `goto *p`，那是编 `Python/ceval.c` 那天的问题'],
  ['SOABI_PLATFORM', null,
    '**构建系统给的字符串**（`configure.ac:1219-1226`：从 `PLATFORM_TRIPLET` 切出来的），'
    + '不是探出来的。我们不造扩展模块的 `.so`，所以不定义 —— `Python/dynload_shlib.c` 那份'
    + '因此编不出（它要 `SOABI`），那是**它的**前提不在，不是我们缺一格'],
  ['ALT_SOABI', null, '同上（`configure.ac:6749`：`cpython-<版本><ABI 标志>` 那个串）'],
  ['ANDROID_API_LEVEL', null,
    'Android 才有（`configure.ac:1309`：从编译器的 `__ANDROID_API__` 里 sed 出来的）'],
  ['HAVE_DYNAMIC_LOADING', 1,
    '**这一格是决定，不是函数探针**（从前它落进"有没有这个函数"那一族、被静悄悄答成"没有"）。'
    + '`configure.ac:5473-5477`：`DYNLOADFILE != dynload_stub.o` 就定义它；而 `:5462-5468` 在'
    + '有 `dlopen` 的机器上挑 `dynload_shlib.o` —— 我们这台有（`HAVE_DLOPEN` / `HAVE_DLFCN_H` '
    + '都探到了）。量到的代价：答"没有"时 `Python/import.c` 少编一整块（动态装载那条路，'
    + '于是 `import_run_modexport` 成了没人引用的 static）、`Python/dynload_shlib.c` 连 '
    + '`dl_funcptr` 那个 typedef 都看不见（`pycore_importdl.h` 拿这一格罩着）'],
  ['_PYTHONFRAMEWORK', '""',
    '**非 framework 构建就是空串**：`configure.ac:722` 那条 `AC_DEFINE_UNQUOTED` 是'
    + '无条件的，而 `--enable-framework` 不给时 `PYTHONFRAMEWORK=`（`configure.ac:687`）。'
    + '也就是说这一格不是"不定义"，是"定义成空串" —— `Python/sysmodule.c:4025` 把它塞进'
    + '`sys._framework`，少了它那一份编不出来。与我们 `WITH_NEXT_FRAMEWORK` 不定义那一格一致'],

  /* ---- `_` 打头那一族（收全筛子之后冒出来的六格）。 */
  ['_ALL_SOURCE', 1,
    'autoconf 的 `AC_USE_SYSTEM_EXTENSIONS`（`configure.ac:1129`）**无条件**定的那几条'
    + '之一（生成的 configure:6579）。AIX 才认，别处无害'],
  ['_GNU_SOURCE', 1, '同上（configure:6583）—— glibc 才认，macOS 的头不看它'],
  ['_XOPEN_SOURCE', null,
    '**darwin 上明确不定**：`configure.ac:886-889` 那两支 `Darwin/…) define_xopen_source=no`'
    + '（理由写在它自己的注里：10.4 起定了它会"disables platform specific features beyond'
    + ' repair"）。定了反而编不出来 —— 这一格是"照它说的不定"'],
  ['_XOPEN_SOURCE_EXTENDED', null, '同上（`configure.ac:919` 只在 xopen 那一支里定）'],
  ['_POSIX_C_SOURCE', null, '同上（`configure.ac:925` 同一支：`202405L`）'],
  ['_POSIX_THREADS', 'probe:unistd-pthreads',
    '**反着来**：`unistd.h` 自己定了就不定这一格（`configure.ac:4885`+`:4942` —— '
    + '「POSIX 说 pthreads 实现必须在 unistd.h 里定它，有些实现没定」）。真探一次'],
  ['_PYTHREAD_NAME_MAXLEN', process.platform === 'darwin' ? 63 : (process.platform === 'linux' ? 15 : null),
    '**按平台一张表**，照 `configure.ac:8284-8292`（Darwin 63、Linux/Android 15、'
    + 'SunOS 31、FreeBSD 19…，表外的不定义）。线程名超了要截断，`Python/thread_pthread.h` 用它'],

  /* ---- `Modules/` 整棵带进来的那十三格（扩面那一刀补的）。
   *
   * 四格是真探针（照 `configure.ac` 的程序原样跑），剩下九格是**借不借那个第三方库 /
   * 可选模块**的决定 —— 那不是编译器的活，所以由我们直接答。答"不借"的代价很清楚：
   * 那几份模块的 `.c` 编不出来，而那**不是我们的欠账**（它要的库压根不在）。 */
  ['ENABLE_IPV6', 'probe:ipv6',
    '`configure.ac:5003-5055`：`--enable-ipv6` 缺省 **yes（如果支持）**，而"支持"是**真跑**'
    + '一个建 `AF_INET6` socket 的程序。这一格是语义（`socketmodule.c` 拿它开整片 IPv6 的路），'
    + '所以照它探'],
  ['GETPGRP_HAVE_ARG', 'probe:getpgrp-arg',
    '`configure.ac:5980-5986`：`getpgrp(0);` 编得过才定义（SysV 那一支的签名）。'
    + '`posixmodule.c` 拿它挑怎么调'],
  ['MAJOR_IN_MKDEV', 'probe:major-mkdev',
    '`configure.ac:6042-6060` 那段三选一的链接测试：`major`/`minor`/`makedev` 只在 '
    + '`<sys/types.h>` 里就不定义这两格，在 `<sys/mkdev.h>` 里定这一格，在 '
    + '`<sys/sysmacros.h>` 里定另一格'],
  ['MAJOR_IN_SYSMACROS', 'probe:major-sysmacros', '同上（同一次探针的另一半）'],
  ['POSIX_SEMAPHORES_NOT_ENABLED', 'probe:posix-sem',
    '`configure.ac:6560-6590`：**真跑** `sem_open` + `sem_close` + `sem_unlink`，跑不成才定义'
    + '（注意是反着的：这一格的名字是"没有"）。`_multiprocessing` 拿它挑后端'],
  ['HAVE__GETPTY', null,
    'IRIX 专有的 `_getpty`（`AC_CHECK_FUNCS`）—— 这台机器上没有。'
    + '它没落进"函数探针"那一族是因为名字里那个额外的下划线（`HAVE__GETPTY` -> `_getpty`）'],
  ['PY_SQLITE_ENABLE_LOAD_EXTENSION', null,
    '**不借 sqlite**（`configure.ac:4580` 一带那一族要 `libsqlite3`）。'
    + '代价是 `Modules/_sqlite/` 编不出来 —— 它要的库不在，不是我们缺一格'],
  ['PY_SQLITE_HAVE_SERIALIZE', null, '同上'],
  ['PY_SSL_DEFAULT_CIPHERS', null,
    '**不借 OpenSSL**（`configure.ac:8095-8125`）。代价是 `Modules/_ssl.c` / `_hashopenssl.c` '
    + '编不出来'],
  ['PY_SSL_DEFAULT_CIPHER_STRING', null, '同上'],
  ['WITH_EDITLINE', null,
    '**不借 libedit**（`configure.ac:6887-6940`：`readline` 模块拿它当后端）'],
  ['WITH_DECIMAL_CONTEXTVAR', 1,
    '照 configure 的缺省 **yes**（`configure.ac:4518-4534`：不给值就是 yes）。'
    + '这一格**是语义**：`_decimal` 的上下文存在 contextvar 里（协程本地）而不是线程本地。'
    + '就算哪天不借 `_decimal`，答对了也不亏'],
  ['WITH_NEXT_FRAMEWORK', null,
    '非 framework 构建（`configure.ac:3461` 只在 `--enable-framework` 那一支定义）——'
    + '与 `_PYTHONFRAMEWORK` 是空串那一格一致'],

  /* ---- 三格"类型在不在"（不是函数！）+ 两格"编译器自己的事"。
   *
   * 这几格是拿**本机那份真 python 的 `pyconfig.h` 当 oracle 对出来的**（SPEC §14 末尾）：
   * `HAVE_X` 这个名字**不一定是个函数**，从前它们全落进"链得上一个同名函数吗"那一族、
   * 一律答"没有"。代价看得见：`Modules/addrinfo.h:129` 于是自己又定义一遍
   * `struct addrinfo`，`socketmodule.c` 报 `redefinition of 'struct addrinfo'`。
   *
   * 还有一条更要紧的分界：**探针只回答"这台机器怎样"，不回答"我们这台编译器怎样"**。
   * 探针用的是 clang，所以凡是问"编译器支持某个扩展吗"的格子都不能拿它探 —— 那是决定。 */
  ['HAVE_ADDRINFO', 'probe:type-addrinfo',
    '**结构体**检查（`configure.ac:6244`：`struct addrinfo a;` 编得过吗），不是函数'],
  ['HAVE_SOCKADDR_STORAGE', 'probe:type-sockaddr-storage',
    '**结构体**检查（`configure.ac:6252`：`struct sockaddr_storage s;`）'],
  ['HAVE_SSIZE_T', 'probe:type-ssize-t', '**类型**检查（`AC_CHECK_TYPE([ssize_t])`）'],
  ['HAVE_GCC_UINT128_T', null,
    '**这一格问的是编译器，不是机器**：clang 有 `__uint128_t`，我们**没有** ——'
    + '`tccdefs.js` 把 `__uint128_t` 映成 `struct __uint128__`（占位，不能做算术）。'
    + '定义它会让 `Objects/longobject.c` 一族走 128 位那条快路，我们编不出来。'
    + '所以这一格是决定：不定义。（从前答对是**碰巧** —— 那一族按"链得上吗"问、答了"没有"）'],
  ['HAVE_COMPUTED_GOTOS', null,
    '同上，问的是编译器：`&&label` 与 `goto *p`（GNU 的 computed goto）我们不支持。'
    + '注意这一格与 `USE_COMPUTED_GOTOS` 是两回事 —— 那一格是"用不用"（照 configure 不定义、'
    + '让 CPython 自己挑），这一格是"能不能"'],

  /* ---- 再十格"不是函数"的（同一把 oracle 对出来的第二批）。 */
  ['HAVE_MAKEDEV', 'probe:makedev',
    '`makedev(major(0),minor(0));` 编得过吗（`configure.ac:3285-3293`）—— 宏，不是函数'],
  ['HAVE_DEVICE_MACROS', 'probe:makedev',
    '同一个程序（`configure.ac:6042-6057`）：设备号那三个宏在不在'],
  ['HAVE_DEV_PTMX', 'probe:dev-ptmx',
    '`/dev/ptmx` 这个**文件**在不在（`configure.ac:7547` 的 `AC_CHECK_FILE`）——'
    + '这一格连编译器都不用'],
  ['HAVE_DIRENT_D_TYPE', 'probe:dirent-d-type',
    '`struct dirent` 有 `d_type` 吗（`configure.ac:7878`）。少了它 `os.scandir` 的快路走不成'],
  ['HAVE_SOCKADDR_SA_LEN', 'probe:sockaddr-sa-len',
    '`struct sockaddr` 有 `sa_len` 吗（`configure.ac:6304`，BSD 一族才有）——'
    + '`socketmodule.c` 拿它决定怎么填地址长度'],
  ['HAVE_SIGINFO_T_SI_BAND', 'probe:siginfo-si-band',
    '`AC_CHECK_MEMBERS([siginfo_t.si_band])`。`siginfo_t` 是 typedef，所以宏名里**没有**'
    + '`STRUCT` —— `HAVE_STRUCT_*` 那一族接不到它，单列一格'],
  ['HAVE_STAT_TV_NSEC2', 'probe:stat-tv-nsec2',
    '`struct stat` 的纳秒那一格是 `st_mtimespec.tv_nsec`（BSD 写法，`configure.ac:7215`）。'
    + '少了它 `os.stat()` 的时间戳只剩秒'],
  ['HAVE_MAXLOGNAME', 'probe:const-maxlogname',
    '`<sys/param.h>` 里那个 `MAXLOGNAME` **常量**在不在（`configure.ac:5941`）'],
  ['HAVE_UT_NAMESIZE', 'probe:const-ut-namesize',
    '`<utmp.h>` 里那个 `UT_NAMESIZE` **常量**在不在（`configure.ac:5947`）'],
  ['HAVE_WORKING_TZSET', 'probe:tzset',
    '`tzset` 管不管用（`configure.ac:7150-7193`，真跑）。`timemodule.c` 拿它决定'
    + '`time.tzset()` 露不露出来'],
  ['HAVE_BROKEN_SEM_GETVALUE', 'probe:sem-getvalue',
    '`sem_getvalue` 坏不坏（`configure.ac:6600-6627`，真跑 —— macOS 上它压根没实现）。'
    + '名字是反的：**坏**才定义'],
];
for (const [name, value, why] of DECIDED) {
  WHY.set(name, why);
  if (value === 'probe:rshift') { HOW.set(name, () => (rshiftZeroFills() ? 1 : null)); continue; }
  if (value === 'probe:setpgrp') { HOW.set(name, () => (setpgrpHasArg() ? 1 : null)); continue; }
  if (value === 'probe:pkey') { HOW.set(name, () => (pthreadKeyIsInt() ? 1 : null)); continue; }
  if (value === 'probe:psched') { HOW.set(name, () => (pthreadSystemSched() ? 1 : null)); continue; }
  if (value === 'probe:unistd-pthreads') {
    /* 反着来：unistd.h 自己定了，这一格就**不**定义 */
    HOW.set(name, () => (unistdDefinesPosixThreads() ? null : 1));
    continue;
  }
  if (value === 'probe:ipv6') { HOW.set(name, () => (ipv6Works() ? 1 : null)); continue; }
  if (value === 'probe:getpgrp-arg') { HOW.set(name, () => (getpgrpHasArg() ? 1 : null)); continue; }
  if (value === 'probe:major-mkdev') {
    HOW.set(name, () => (deviceMacrosIn() === 'MAJOR_IN_MKDEV' ? 1 : null));
    continue;
  }
  if (value === 'probe:major-sysmacros') {
    HOW.set(name, () => (deviceMacrosIn() === 'MAJOR_IN_SYSMACROS' ? 1 : null));
    continue;
  }
  if (value === 'probe:posix-sem') {
    /* 反着来：跑得成就**不**定义（这一格的名字是"没有"） */
    HOW.set(name, () => (posixSemaphoresWork() ? null : 1));
    continue;
  }
  if (value === 'probe:type-addrinfo') {
    HOW.set(name, () => (compiles('#include <sys/types.h>\n#include <sys/socket.h>\n'
      + '#include <netdb.h>\nint main(void){ struct addrinfo a; (void)a; return 0; }\n') ? 1 : null));
    continue;
  }
  if (value === 'probe:type-sockaddr-storage') {
    HOW.set(name, () => (compiles('#include <sys/types.h>\n#include <sys/socket.h>\n'
      + 'int main(void){ struct sockaddr_storage s; (void)s; return 0; }\n') ? 1 : null));
    continue;
  }
  if (value === 'probe:type-ssize-t') {
    HOW.set(name, () => (compiles('#include <sys/types.h>\n'
      + 'int main(void){ ssize_t x = 0; (void)x; return 0; }\n') ? 1 : null));
    continue;
  }
  if (value === 'probe:makedev') {
    /* 三种头都试一遍（与 `deviceMacrosIn` 同一组程序）：能编出来就算有 */
    HOW.set(name, () => (['#include <sys/types.h>\n',
      '#include <sys/mkdev.h>\n#include <sys/types.h>\n',
      '#include <sys/types.h>\n#include <sys/sysmacros.h>\n']
      .some((inc) => compiles(`${inc}int main(void){ makedev(major(0), minor(0)); return 0; }\n`))
      ? 1 : null));
    continue;
  }
  if (value === 'probe:dev-ptmx') { HOW.set(name, () => (devPtmxExists() ? 1 : null)); continue; }
  if (value === 'probe:dirent-d-type') { HOW.set(name, () => (direntHasDType() ? 1 : null)); continue; }
  if (value === 'probe:sockaddr-sa-len') { HOW.set(name, () => (sockaddrHasSaLen() ? 1 : null)); continue; }
  if (value === 'probe:siginfo-si-band') { HOW.set(name, () => (siginfoHasSiBand() ? 1 : null)); continue; }
  if (value === 'probe:stat-tv-nsec2') { HOW.set(name, () => (statHasTvNsec2() ? 1 : null)); continue; }
  if (value === 'probe:const-maxlogname') {
    HOW.set(name, () => (hasConst('MAXLOGNAME', 'sys/param.h') ? 1 : null));
    continue;
  }
  if (value === 'probe:const-ut-namesize') {
    HOW.set(name, () => (hasConst('UT_NAMESIZE', 'utmp.h') ? 1 : null));
    continue;
  }
  if (value === 'probe:tzset') { HOW.set(name, () => (tzsetWorks() ? 1 : null)); continue; }
  if (value === 'probe:sem-getvalue') { HOW.set(name, () => (semGetvalueBroken() ? 1 : null)); continue; }
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
  if (v === null) { lines.push(`/* #undef ${name} */`); continue; }
  /* 模板里带罩子的，照它的形状出（见 `guarded` 头上那段） */
  if (guarded.has(name)) lines.push(`#ifndef ${name}`, `# define ${name} ${v}`, '#endif');
  else lines.push(`#define ${name} ${v}`);
}
lines.push('', '#endif /* OMNI_PYCONF_H */', '');

const text = lines.join('\n');
mkdirSync(dirname(OUT), { recursive: true });
/* 内容一样就不写 —— 配合 ninja 的 `restat`（不然每趟都重编）。 */
if (!(existsSync(OUT) && readFileSync(OUT, 'utf8') === text)) writeFileSync(OUT, text);
