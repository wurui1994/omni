// ext/python/rt/scope.js —— **借来的那棵 CPython：量哪几份、拿什么开关量**
//
// 两把尺子共用这一份（`sweep.js` 量"编得出多少"、`symbols.js` 量"编出来的外部符号
// 与 clang 的一不一样"）。放在一处的理由只有一条：**开关少一格数就变了**，
// 两份各写一遍迟早对不上。
//
// 只放"口径"，不放跑法：怎么并发、门定多少，各自的脚本自己说。

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `Modules/` 那张名单：**真进 libpython 的那几份**，从借来的那棵树里**读出来**，不写死。
 *
 * 来路是 `Makefile.pre.in:595-607` 的 `LIBRARY_OBJS`：
 *   `getbuildinfo.o` + `PARSER_OBJS` + `OBJECT_OBJS` + `PYTHON_OBJS` +
 *   `MODULE_OBJS`（`config.o` / `main.o` / `gcmodule.o`，`:355`）+
 *   `MODOBJS`（= `Modules/Setup.bootstrap.in` 里那一串 `*static*` 模块）+
 *   `getpath.o` + `frozen.o`。
 *
 * 从前这儿是**我手挑的 19 份**"核心扩展模块"。那张表的毛病不是选错了，是**没有来由** ——
 * 而 `Setup.bootstrap.in` 是 CPython 自己写的"哪些模块静态编进解释器"。照它读，
 * 换棵树就跟着变，也不必再解释"为什么是这 19 份"。
 *
 * `@MODULE_PWD_TRUE@pwd pwdmodule.c` 这种前缀是 configure 替换的开关，本机上都是"要"，
 * 所以**剥掉前缀照收**（记一笔：哪天在别的平台上量，这一格要照 configure 的答案筛）。
 */
export function coreModuleFiles(src) {
  const p = join(src, 'Modules', 'Setup.bootstrap.in');
  const out = new Set();
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const line = raw.replace(/@[A-Z0-9_]+@/g, '').trim();
    if (line === '' || line.startsWith('#') || line.startsWith('*')) continue;
    /* 一行是 `模块名 源文件…`，源文件可能在子目录里（`_io/fileio.c`、`_sre/sre.c`） */
    for (const tok of line.split(/\s+/).slice(1)) {
      if (tok.endsWith('.c')) out.add(tok);
    }
  }
  if (out.size < 20) {
    throw new Error(`scope.js: Setup.bootstrap.in 里只读出 ${out.size} 份源码 —— 那份名单的形状变了`);
  }
  /* `MODULE_OBJS` 与 `LIBRARY_OBJS` 里另外点名的四份（`Makefile.pre.in:355` / `:596` / `:606`）。
   * `config.c` 不在这儿 —— 它是**生成的**（见 `GENERATED`）。 */
  for (const f of ['main.c', 'gcmodule.c', 'getbuildinfo.c', 'getpath.c']) out.add(f);
  return out;
}

/**
 * 同一份 `Setup.bootstrap.in` 的**另一面**：那几个**模块名**（不是源文件名）。
 * `gen-config.js` 要它 —— `Modules/config.c` 那张 `_PyImport_Inittab` 表就是
 * 「每个静态模块一行 `{"名字", PyInit_名字}`」，而 `makesetup` 正是从这几行读名字的。
 */
export function coreModuleNames(src) {
  const p = join(src, 'Modules', 'Setup.bootstrap.in');
  const out = [];
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const line = raw.replace(/@[A-Z0-9_]+@/g, '').trim();
    if (line === '' || line.startsWith('#') || line.startsWith('*')) continue;
    const name = line.split(/\s+/)[0];
    /* 一行至少得是「名字 + 一份源码」，不然那不是模块行 */
    if (name !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) out.push(name);
  }
  if (out.length < 20) {
    throw new Error(`scope.js: Setup.bootstrap.in 里只读出 ${out.length} 个模块名 —— 那份名单的形状变了`);
  }
  return out;
}

/**
 * **要构建系统先跑一步**的那几份（在不在树里都不算我们的欠账）：
 *   * `Modules/config.c` —— `makesetup` 生成的内建模块表（树里压根没有这份文件）；
 *   * `Python/frozen.c` 与 `Modules/getpath.c` —— 要 `Python/frozen_modules/*.h`
 *     （`make regen-frozen`，那一步得先有一个能跑的 `_freeze_module`）。
 */
export const GENERATED = new Set([
  'Modules/config.c',
  'Python/frozen.c',
  'Modules/getpath.c',
]);

/**
 * **不是翻译单元**的那几份：`Makefile` 从不编它们 —— 它们是代码生成器的**输入**
 * （`Makefile.pre.in:2101` 起那一串 `regen-cases`：`Python/bytecodes.c` 与
 * `Python/optimizer_bytecodes.c` 喂给 `Tools/cases_generator`，出的是
 * `Python/generated_cases.c.h` / `optimizer_cases.c.h`）。
 *
 * 所以它们"编不出"不是欠账，是**口径错** —— 它们压根不该进分母。
 */
export const NOT_TU = new Set([
  'Python/bytecodes.c',
  'Python/optimizer_bytecodes.c',
]);

/**
 * **别的平台那一份**：同一格能力有好几份实现，configure 挑一份进 objs。
 *
 *   * `dynload_*.c` —— `configure.ac:5454` 的 `DYNLOADFILE`（darwin 挑 `dynload_shlib.c`）；
 *   * `emscripten_*.c` —— `configure.ac:5433` 的 `PLATFORM_OBJS`，只有 emscripten 才进。
 *
 * 它们在本机编不出是**对的**（`dl.h` / `windows.h` / `emscripten.h` 本来就不在），
 * 同样不该进分母。注意 `dynload_shlib.c` **不在**这张表里 —— 那份是本机真要的。
 */
export const OTHER_PLATFORM = new Set([
  'Python/dynload_hpux.c',
  'Python/dynload_win.c',
  'Python/dynload_stub.c',
  'Python/emscripten_signal.c',
  'Python/emscripten_syscalls.c',
  'Python/emscripten_trampoline.c',
  'Python/emscripten_trampoline_inner.c',
]);

/** 这一份算不算本机该编的翻译单元；回 `null` = 算，回一个串 = 不算的理由。 */
export function outOfScope(name) {
  if (NOT_TU.has(name)) return '不是翻译单元（代码生成器的输入）';
  if (OTHER_PLATFORM.has(name)) return '别的平台那一份（configure 不会挑它）';
  return null;
}

/**
 * 一份 `.c` 的编译开关。**两把尺子都用这一份** —— 少一格数就变了。
 * `-std=c11` 是 CPython 自己要的下限；两个 `-D` 是 `PY_CORE_CFLAGS` 里那两条。
 * `extra` 放**按文件加的** `-D`（见 `perFileDefs`）。
 */
export const flagsFor = (out, inc, src, extra = []) => ['c', 'obj', '-std=c11',
  '-DPy_BUILD_CORE', '-D_Py_USE_GCC_BUILTIN_ATOMICS=1', ...extra,
  '-I', inc, '-I', join(src, 'Include'), '-I', join(src, 'Include', 'internal'),
  '-I', join(src, 'Objects'), '-I', join(src, 'Python'), '-I', join(src, 'Modules'),
  '-o', out];

/**
 * `SOABI` —— 扩展模块 `.so` 的中缀名，**构建系统算出来的**
 * （`configure.ac:6742`：`cpython-<版本去掉点><ABIFLAGS><-平台>`）。
 *
 * 三段各自的来路：版本从参考树的 `Include/patchlevel.h` **读**（不写死，换棵树就跟着变）；
 * `ABIFLAGS` 空（我们不开 debug、也不开自由线程）；平台那一段跟着我们自己在
 * `gen-pyconf.js` 里对 `SOABI_PLATFORM` 的决定 —— **不定义**，所以这儿也不加后缀。
 */
export function soabi(src) {
  const t = readFileSync(join(src, 'Include', 'patchlevel.h'), 'utf8');
  const maj = t.match(/#\s*define\s+PY_MAJOR_VERSION\s+(\d+)/);
  const min = t.match(/#\s*define\s+PY_MINOR_VERSION\s+(\d+)/);
  if (maj === null || min === null) {
    throw new Error('scope.js: 读不出 Include/patchlevel.h 里的版本号 —— 那份头的形状变了');
  }
  return `cpython-${maj[1]}${min[1]}`;
}

/**
 * 那几份**摘 HACL\* 的**（CPython 把那套形式验证过的密码学实现 vendored 在
 * `Modules/_hacl/` 里）。它们 `#include "krml/internal/types.h"` 一类，而那些头在
 * `Modules/_hacl/include` 下 —— `Makefile` 给它们加的是 `LIBHACL_CFLAGS`
 * （`Makefile.pre.in:239`，configure 里拼的第一条就是那个 `-I`）。
 * **不是"不借第三方库"**：这套代码就在借来的那棵树里，少的只是一格 `-I`。
 */
const HACL_MODULES = new Set([
  'blake2module.c', 'hmacmodule.c', 'md5module.c',
  'sha1module.c', 'sha2module.c', 'sha3module.c',
]);

/**
 * **按文件加的开关**：CPython 的 `Makefile` 给某几份单独加东西，我们站在构建系统的
 * 位置上就得照它给。两条：
 *   * `Python/dynload_shlib.c` 要 `-DSOABI`（`Makefile.pre.in:1922` 那条规则）；
 *   * 摘 HACL\* 那六份要 `-I Modules/_hacl/include`（`LIBHACL_CFLAGS`）。
 */
export function perFileFlags(name, src) {
  if (name === 'Python/dynload_shlib.c') return [`-DSOABI="${soabi(src)}"`];
  if (name.startsWith('Modules/') && HACL_MODULES.has(name.slice('Modules/'.length))) {
    return ['-I', join(src, 'Modules', '_hacl', 'include')];
  }
  return [];
}

/**
 * 探出来的 `pyconfig.h` 落哪儿。**按范围分开放**：名单是"能定义的宏 ∩ 源码真读到的"，
 * 所以 `--all-modules` 那一趟的名单比缺省那一趟大（多出 `Modules/` 整棵带进来的十三格）。
 * 共用一份就会拿"少几格的那份"去编整棵 `Modules/` —— 那是静悄悄答错。
 */
export const incDirFor = (work, allModules = false) => join(work, allModules ? 'inc-all' : 'inc');

/**
 * 要**连子目录一起扫**的那几棵。现在只有 `Parser/`：它的 `PARSER_OBJS`
 * （`Makefile.pre.in:428`）= `POBJS` + `PEGEN_OBJS` + `TOKENIZER_OBJS` + `myreadline.o`，
 * 而后两族住在 `Parser/lexer/` 与 `Parser/tokenizer/` 里（十份）。
 *
 * 这个漏洞是**链接那把尺子逼出来的**：只扫顶层时，`Parser/pegen.c` 一族引用的
 * 二十一个 `_PyTokenizer_*` / `_PyToken_*` 找不到定义。
 *
 * `Objects/stringlib/` 与 `Python/clinic/` 不在这张表里 —— 那两处是**被 include 的 `.h`**，
 * 不是翻译单元（`Objects/stringlib/*.h` 靠宏参数化、在别的 `.c` 里展开好几遍）。
 */
const WALK_SUBDIRS = new Set(['Parser']);

/** 一棵目录下该量的那些相对路径（顶层的 `.c`，必要时加上子目录里的）。 */
function sourcesUnder(dir) {
  const out = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.c')).map((e) => e.name);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    for (const f of readdirSync(join(dir, e.name))) {
      if (f.endsWith('.c')) out.push(`${e.name}/${f}`);
    }
  }
  return out.sort();
}

/**
 * 要量的那一串 `[目录, 文件名]`。`filters` 非空时只留名字里带那几个词的。
 * 不在本机范围里的（`outOfScope`）**不进这张表** —— 分母就是"本机该编的份数"。
 */
export function filesIn(src, dirs, { allModules = false, filters = [] } = {}) {
  const out = [];
  const skipped = [];
  const core = dirs.includes('Modules') && !allModules ? coreModuleFiles(src) : null;
  for (const d of dirs) {
    const dir = join(src, d);
    if (!existsSync(dir)) continue;
    /* `Modules/` 缺省只量"真进 libpython 的那几份"，而那张名单里有**子目录**
     * （`_io/fileio.c` / `_sre/sre.c`），所以那一路照名单走、不扫目录。 */
    let names;
    if (d === 'Modules' && core !== null) names = [...core].sort();
    else if (WALK_SUBDIRS.has(d)) names = sourcesUnder(dir);
    else names = readdirSync(dir).filter((x) => x.endsWith('.c')).sort();
    for (const f of names) {
      if (!existsSync(join(dir, f))) {
        /* 名单上有、树里没有 —— `Modules/config.c` 就是这样（`makesetup` 生成的） */
        skipped.push([`${d}/${f}`, '树里没有这份（构建系统生成）']);
        continue;
      }
      if (filters.length > 0 && !filters.some((x) => f.includes(x))) continue;
      const why = outOfScope(`${d}/${f}`);
      if (why !== null) skipped.push([`${d}/${f}`, why]);
      else out.push([d, f]);
    }
  }
  return { files: out, skipped };
}

/**
 * 给 `gen-pyconf.js` 的 `--extra`：**`Include` 整棵**加上要量的那几处。
 *
 * `Include` 不能漏：名单是"能定义的宏 ∩ 源码真读到的"，而线程那几格（`HAVE_PTHREAD_H` …）
 * 是 `Include/internal/pycore_pythread.h` 读的 —— 漏了它，探出来的 pyconfig 少 17 条，
 * 于是**每一份都**报 `#error "Require native threads"`（量到过，一份都编不出）。
 *
 * `Modules/` 不整棵给：那会带进 13 个"要不要借第三方库"的宏（见 `coreModuleFiles`），
 * 所以按文件名一份一份给。
 */
export function pyconfExtra(dirs, allModules = false, src = null) {
  return ['Include', ...dirs.flatMap((d) => {
    if (d !== 'Modules' || allModules) return [d];
    if (src === null) return [d];
    return [...coreModuleFiles(src)].map((f) => `Modules/${f}`);
  })].join(',');
}
