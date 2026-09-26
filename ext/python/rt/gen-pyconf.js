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
  existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync,
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
for (const rel of SOURCES) {
  const p = join(SRC, rel);
  if (!existsSync(p)) throw new Error(`gen-pyconf.js: 借来的那份不在：${p}`);
  const text = readFileSync(p, 'utf8');
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
    if (canDefine.has(m[1])) needed.add(m[1]);
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
  lines.push(v === null ? `/* #undef ${name} */` : `#define ${name} ${v}`);
}
lines.push('', '#endif /* OMNI_PYCONF_H */', '');

const text = lines.join('\n');
mkdirSync(dirname(OUT), { recursive: true });
/* 内容一样就不写 —— 配合 ninja 的 `restat`（不然每趟都重编）。 */
if (!(existsSync(OUT) && readFileSync(OUT, 'utf8') === text)) writeFileSync(OUT, text);
