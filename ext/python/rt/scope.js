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
 * `Modules/` 那张名单：**核心扩展模块**（不依赖任何第三方库）。
 *
 * 理由是量出来的：整棵 101 份会给 `gen-pyconf.js` 带进 13 个还没决定的宏，而那 13 个
 * 几乎全是"要不要借那个第三方库 / 可选模块"（sqlite / ssl / editline / decimal / ipv6…）
 * 的决定，不是编译器的活。这张名单里的量过 —— 它们一个新宏都不带。
 *
 * 整棵都想量：`--all-modules`（那时得先给那 13 个宏一格一格写决定）。
 */
export const CORE_MODULES = new Set([
  '_abc.c', '_bisectmodule.c', '_codecsmodule.c', '_collectionsmodule.c', '_datetimemodule.c',
  '_functoolsmodule.c', '_heapqmodule.c', '_operator.c', '_randommodule.c', '_stat.c',
  '_typingmodule.c', '_weakref.c', 'atexitmodule.c', 'cmathmodule.c', 'errnomodule.c',
  'itertoolsmodule.c', 'mathmodule.c', 'symtablemodule.c', 'timemodule.c',
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
 * **按文件加的 `-D`**：CPython 的 `Makefile` 给某几份单独加开关，我们站在构建系统的
 * 位置上就得照它给。现在只有一条 —— `Python/dynload_shlib.c` 要 `SOABI`
 * （`Makefile.pre.in:1922-1925` 那条规则，一模一样的形状）。
 */
export function perFileDefs(name, src) {
  if (name === 'Python/dynload_shlib.c') return [`-DSOABI="${soabi(src)}"`];
  return [];
}

/**
 * 要量的那一串 `[目录, 文件名]`。`filters` 非空时只留名字里带那几个词的。
 * 不在本机范围里的（`outOfScope`）**不进这张表** —— 分母就是"本机该编的份数"。
 */
export function filesIn(src, dirs, { allModules = false, filters = [] } = {}) {
  const out = [];
  const skipped = [];
  for (const d of dirs) {
    const dir = join(src, d);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.c')).sort()) {
      if (d === 'Modules' && !allModules && !CORE_MODULES.has(f)) continue;
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
 * `Modules/` 不整棵给：那会带进 13 个"要不要借第三方库"的宏（见 `CORE_MODULES`），
 * 所以按文件名一份一份给。
 */
export function pyconfExtra(dirs, allModules = false) {
  return ['Include', ...dirs.flatMap((d) => (d === 'Modules' && !allModules
    ? [...CORE_MODULES].map((f) => `Modules/${f}`) : [d]))].join(',');
}
