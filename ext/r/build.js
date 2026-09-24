#!/usr/bin/env node
// ext/r/build.js —— **R 的 C 运行时**：拿 r-source 的源码与一台 C 编译器编出 `libomniRmath`
//
//   omni ninja -f ext/r/build.js            # 或者直接 node ext/r/build.js
//   omni ninja -f ext/r/build.js -t dirty   # 谁脏、为什么
//   omni ninja -f ext/r/build.js --emit-ninja > /tmp/r.ninja
//
// ## 为什么是这一份，而不是接着往 cli.js 里塞几条 spawn
//
// 这是 `src/core/build/`（那份纯 JS 的 ninja）**第一个生产调用者** —— 在这之前只有判据
// 在用它，而 `docs/design/build-system.md` 自己写着"老实说：没有构建系统，只有几条写死的
// 流水线"。R 的运行时正好是那句话兜不住的第一格活：**123 条编译边 + 三份生成出来的头**，
// 而且那三份头一变就得重编 123 份。写死的顺序语句表达不了这件事（它只会每次全编，或者
// 每次都不编）。
//
// ## 三条纪律
//
//   1. **输入只有那棵源码树与一台 C 编译器。** 不借本机装的那个 R 的任何东西 ——
//      它的 `Rmath.h` 是 4.6.1 的，而这棵树是 4.7.0（四份 bessel 要新宏），拿它编就是
//      "用别人的头编我们的源码"。三份头（`config.h` / `Rconfig.h` / `Rmath.h`）自己生成。
//   2. **不重写 R 已经写好的那部分。** 要编哪些 `.c` 从 R 自己的
//      `src/nmath/standalone/Makefile.in` 里读（`SOURCES_NMATH`）；`Rconfig.h` 直接跑
//      R 自己的 `tools/GETCONFIG`。我们只加"探本机"（`gen-config.js`）与"替模板"
//      （`gen-rmath.js`）这两格 configure 没法替我们做的事。
//   3. **规则写在 JS 里的好处要用上。** 路径在造图的时候就都是绝对的（不必靠 ninja 变量
//      拼），输出目录在 `run()` 之前就 mkdir 好（ninja 自己不建目录）。

import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Build } from '../../src/core/build/api.js';
import { refDir } from '../../tests/lib/refsrc.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const RSRC = refDir('r-source', 'R_SRC');
const CC = process.env.OMNI_CLANG ?? process.env.CC ?? 'clang';

/** 产物落在缓存根下 —— 与别的原生库（`.omni-cache/gl/`）一个地方。 */
const OUT = join(ROOT, '.omni-cache', 'r-rt');
const GEN = join(OUT, 'include');   // 三份生成出来的头（**排在包含路径最前**）
const OBJ = join(OUT, 'obj');
export const LIB = join(OUT, `libomniRmath${process.platform === 'darwin' ? '.dylib' : '.so'}`);

if (!existsSync(join(RSRC, 'src/nmath'))) {
  process.stderr.write(`ext/r/build.js: 参考树不在：${RSRC}\n`
    + '（`R_SRC=<路径>` 或 `OMNI_REF_DIR=<那几棵树的父目录>`）\n');
  process.exit(1);
}

/**
 * 要编哪些 `.c` —— **从 R 自己的 standalone Makefile 里读**，不在这儿抄一份名单。
 * 抄一份的话它会与那棵树分叉（R 4.7 就新加过 `cospi.c`），而分叉的症状是"少编一份，
 * 链接时缺一个符号"，离根因很远。
 */
function nmathSources() {
  const mk = join(RSRC, 'src/nmath/standalone/Makefile.in');
  const text = readFileSync(mk, 'utf8');
  const m = /SOURCES_NMATH\s*=\s*([\s\S]*?)\nSOURCES\s*=/.exec(text);
  if (m === null) throw new Error(`ext/r/build.js: ${mk} 里找不到 SOURCES_NMATH —— 那份 Makefile 的形状变了`);
  const names = m[1].replace(/\\\n/g, ' ').trim().split(/\s+/).filter((s) => s.endsWith('.c'));
  if (names.length < 100) throw new Error(`ext/r/build.js: SOURCES_NMATH 只读出 ${names.length} 份，不像话`);
  return names;
}

const srcs = nmathSources().map((n) => ({ name: n, path: join(RSRC, 'src/nmath', n) }));
/* **`std_unif.c`（树里的 `sunif.c`）刻意不编。** 那一格是 standalone 自己的
   Marsaglia-MultiCarry 发生器，而 R 默认用 Mersenne-Twister、播种法也不同 ——
   于是 `set.seed(42); runif(1)` 两边不是同一条流。我们自己那份 `omni_rng.c` 顶它，
   照 `src/main/RNG.c` 公开的算法写（账在 `rt/omni_rng.h` 头上）。
   换掉之后 nmath 那一族 `r*` 是**R 自己的代码**跑在**R 自己的流**上，数逐位相同。 */

/**
 * **我们自己那几格**，与上面那张 R 的名单分开列（一眼能看出哪些代码是谁的）。
 *
 *   `omni_rna.c` —— `NA` / `NaN` / `Inf` 三格真值。它们在 R 那边属于解释器
 *     （`src/main/arithmetic.c` 的 `R_NaReal`），standalone 的 nmath 里没有，
 *     所以按 *R Internals* §1.3 公开的表示自己写（账在 `rt/omni_rna.h` 头上）。
 *   `omni_rng.c` —— R 的 Mersenne-Twister 与它的播种法，顶掉 standalone 那份
 *     Marsaglia-MultiCarry（账在 `rt/omni_rng.h` 头上）。
 */
const OURS = [
  { name: 'omni_rna.c', path: join(HERE, 'rt/omni_rna.c'), hdr: join(HERE, 'rt/omni_rna.h') },
  { name: 'omni_rng.c', path: join(HERE, 'rt/omni_rng.c'), hdr: join(HERE, 'rt/omni_rng.h') },
];

for (const d of [GEN, OBJ]) mkdirSync(d, { recursive: true });

const b = new Build();

/* ---- 三份生成出来的头 -----------------------------------------------------
 * 都挂 `restat`：内容没变就把"它没变"传下去，123 份 `.o` 不白重编
 * （两个生成器自己也做了"内容一样就不写"那一半 —— 两边都要有，restat 看的是 mtime）。 */

const CONFIG_H = join(GEN, 'config.h');
const RCONFIG_H = join(GEN, 'Rconfig.h');
const RMATH_H = join(GEN, 'Rmath.h');

b.rule('genconfig', {
  command: `node ${join(HERE, 'rt/gen-config.js')} --out $out --cc ${CC}`,
  description: '探本机 -> config.h',
  restat: 'true',
});
b.rule('getconfig', {
  /* **跑 R 自己那份 `tools/GETCONFIG`** —— 它是个 51 行的 POSIX shell 脚本，
     从同目录的 `config.h` 里 grep 出该进 `Rconfig.h` 的那些行。在这儿重写一遍它
     等于把它的名单抄第二份，所以直接跑。 */
  command: `cd ${GEN} && sh ${join(RSRC, 'tools/GETCONFIG')} > $out`,
  description: 'R 的 GETCONFIG -> Rconfig.h',
  restat: 'true',
});
b.rule('genrmath', {
  command: `node ${join(HERE, 'rt/gen-rmath.js')} --src ${RSRC} --out $out`,
  description: 'Rmath.h0.in -> Rmath.h',
  restat: 'true',
});

b.build(CONFIG_H, 'genconfig', [], { implicit: [join(HERE, 'rt/gen-config.js')] });
b.build(RCONFIG_H, 'getconfig', [CONFIG_H], { implicit: [join(RSRC, 'tools/GETCONFIG')] });
b.build(RMATH_H, 'genrmath', [join(RSRC, 'src/include/Rmath.h0.in')], {
  implicit: [join(HERE, 'rt/gen-rmath.js'), join(RSRC, 'VERSION')],
});

/* ---- 编译与链接 -----------------------------------------------------------
 * `-I` 的次序要紧：**生成出来的头排最前**，这样 `#include <Rmath.h>` 拿到的是我们
 * 从这棵树的模板生成的那一份，而不是别处某个装好的 R 的。
 * `-DMATHLIB_STANDALONE` 与 `-DHAVE_CONFIG_H` 照 R 的 standalone Makefile（`DEFS`）。 */
const cflags = [
  '-O2', '-std=c99', '-w', '-fPIC',
  '-DMATHLIB_STANDALONE', '-DHAVE_CONFIG_H',
  '-I', GEN, '-I', join(RSRC, 'src/nmath'), '-I', join(RSRC, 'src/include'),
].join(' ');

b.set('cflags', cflags);
b.rule('cc', { command: `${CC} $cflags -c $in -o $out`, description: 'CC $out' });
b.rule('dylib', {
  command: `${CC} ${process.platform === 'darwin' ? `-dynamiclib -install_name ${LIB}` : '-shared'} -o $out $in -lm`,
  description: 'LINK $out',
});

const objs = [];
for (const s of srcs) {
  const o = join(OBJ, `${s.name.replace(/\.c$/, '')}.o`);
  objs.push(o);
  /* 三份头都挂 `implicit`：它们不进 `$in`（`$in` 是那一份 `.c`），可它们一变就得重编。
     真正的逐头依赖（`depfile`）这套引擎还没实现 —— 所以这儿是"全体挂三份头"这个保守口径，
     代价是改一格探针会重编 123 份（几秒），换来的是**不会漏**。 */
  b.build(o, 'cc', s.path, { implicit: [CONFIG_H, RCONFIG_H, RMATH_H] });
}
/* 我们自己那几格：只依赖它自己的头（它不碰 R 的那三份），所以不跟着探针重编。 */
for (const s of OURS) {
  const o = join(OBJ, `${s.name.replace(/\.c$/, '')}.o`);
  objs.push(o);
  b.build(o, 'cc', s.path, { implicit: [s.hdr, CONFIG_H] });
}
b.build(LIB, 'dylib', objs);
b.default(LIB);

b.run(process.argv.slice(2));
