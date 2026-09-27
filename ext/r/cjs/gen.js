#!/usr/bin/env node
// ext/r/cjs/gen.js —— 把 R 的 nmath 摊成**一份** C，好让我们自己的 C 前端把它编到 JS
//
//   node ext/r/cjs/gen.js        # 写出 .omni-cache/r-rt/js/{nmath-all.c, probe.R}
//   node ext/r/cjs/gen.js -v     # 顺带印出改了名的那几个 static
//
// ## 这一刀要证的是什么
//
// `r-target.md` 那一句："把 R 依赖的 C 通过我们自己编到 JS，看能不能正常使用。"
// 最小的一格是 **nmath**：R 的 120 份数值 `.c`（`dnorm` / `pgamma` / `qbeta` / bessel
// 那一族），它是 R 里**唯一**不碰 `setjmp` / `SEXP` / Fortran 的一块，所以它是这条路上
// 第一级能踩实的台阶。踩实的判据在 `tests/r/cjs.js`：同一批数，**解释腿与 JS 腿逐字节
// 相同**，而两条腿与 `Rscript` 的差落在一个记死的上界里。
//
// ## 为什么要摊平成一份
//
// 我们那条 C -> MIR -> JS 的路是**单翻译单元**的（`src/core/mir/` 没有链接器，
// 一次 `omni run x.c` 就是一个模块）。nmath 在 R 那边是 120 个翻译单元，所以要么写一个
// MIR 层的链接器，要么把它们摊进一份 `.c` —— 这一刀选后者：摊平是**几十行的机械活**，
// 链接器是另一刀。摊平要跨过三道坎，每一道都在下面的代码里：
//
//   1. **文件局部的 `#define` 会漏到下一份**。`lgammacor.c` 里 `#define xbig …`，
//      而 `gamma_cody.c` 里 `const static double xbig = 171.624;` —— 摊到一起那一行
//      就成了 `const static double 94906265.62425156 = …`。所以每一份包完就把它自己
//      `#define` 过的名字全 `#undef` 掉（它们本来就是文件局部的东西）。
//   2. **同名的 `static` 会撞车**。`wilcox.c` 与 `signrank.c` 各有一个 `w_init_maybe`
//      （签名还不同），`qbinom.c` / `qpois.c` / `qnbinom.c` / `qnbinom_mu.c` 各从
//      `qDiscrete_search.h` 生出一个 `do_search`。所以先算出"哪些 static 名字出现在
//      一份以上"，再给那几个按文件名挂后缀 —— **只动撞车的那几个**，别的原样。
//   3. **`-D` 进不了 JS 腿**。顶层 `omni run x.c --backend js` 只收 `-I`，所以
//      `MATHLIB_STANDALONE` 与 `HAVE_CONFIG_H` 写进文件头，这份 `.c` 自带口径。
//
// 摊平**不改 R 的源码一个字**：改名走 `#define`，撤销走 `#undef`，源文件是只读的。

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refDir } from '../../../tests/lib/refsrc.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const RSRC = refDir('r-source', 'R_SRC');

/** 产物落缓存（约定：生成出来的东西不进版本库，也不进临时目录）。 */
export const OUT = join(ROOT, '.omni-cache', 'r-rt', 'js');
/** 摊平出来的那一份，**不带 `main`** —— 两个驱动各 `#include` 它一次。 */
export const LIB_C = join(OUT, 'nmath-lib.c');
/** 驱动一：66 格数的探子（`tests/r/cjs.js` 的前七道门）。 */
export const AMALGAM = join(OUT, 'nmath-probe.c');
export const PROBE_R = join(OUT, 'probe.R');
/** 驱动二：往 stdout 印一张 SVG（"画到浏览器里"那一格）。 */
export const PLOT_C = join(OUT, 'nmath-plot.c');
export const PLOT_R = join(OUT, 'plot.R');
/** 驱动三：自己画帧缓冲，再调宿主把这一帧交出去（真设备那一格）。 */
export const FRAME_C = join(OUT, 'nmath-frame.c');
export const FRAME_PNG = join(OUT, 'nmath-frame.png');
/** 驱动四：用**设备自己的笔**画（`cls`/`setcol`/`moveto`/`lineto`/`refresh`）。 */
export const DEV_C = join(OUT, 'nmath-dev.c');
export const DEV_PNG = join(OUT, 'nmath-dev.png');
/**
 * 驱动二**预处理摊平**之后那一份：一份 550 KB 的自足 `.c`，**一个 `-I` 都不要**。
 *
 * 为什么要这一格：浏览器那条腿的文件系统是内存里一张表（`host/browser.js` 的 VFS），
 * 那儿没有 r-source 那 120 份源码，也没有 SDK 的头。`omni c cpp` 把它们全展开成一份
 * （16 195 行），于是**同一份 C 可以搬进页面里跑**（`tests/r/cjs.js` 最后那一节）。
 * 这一份由测试现做（要 CLI 跑一趟 `c cpp`），不在 `generate()` 里。
 */
export const PLOT_FLAT = join(OUT, 'nmath-plot-flat.c');
/**
 * **一个 .c 一个 .js** 那条路的产物落这儿（ADR-0047 第十/十一格）：
 * `mod/<名字>.mjs` 一份一份，`mod/probe-drv.c` 是那个只按原型调的驱动，
 * `mod/main.mjs` 是入口（先叫每份库的 `$init()`，再跑 `$run()`）。
 */
export const MOD_DIR = join(OUT, 'mod');
export const MOD_DRV = join(MOD_DIR, 'probe-drv.c');
export const MOD_ENTRY = join(MOD_DIR, 'main.mjs');

/** 三份生成出来的头在这儿（`ext/r/build.js` 造的）—— 编这份 `.c` 要 `-I` 它。 */
export const GEN_INC = join(ROOT, '.omni-cache', 'r-rt', 'include');
export const INCS = [GEN_INC, join(RSRC, 'src/nmath'), join(RSRC, 'src/include')];

/**
 * 那张图的口径 —— **C 与 R 两边都从这一处读**，所以画布不会各自飘。
 *
 * 坐标一律印到**三位小数**：两边的 libm 不是同一份，而三位小数把那点差（1e-16 量级）
 * 吃掉了 —— 于是"同一张图"这句话可以判**逐字节**，不必落到"看着差不多"。
 */
export const PLOT = {
  w: 480, h: 320, ml: 44, mr: 12, mt: 16, mb: 34, x0: -4, x1: 4, n: 161, ymax: 0.45,
};


/**
 * 探子：**一格一行，C 与 R 的写法摆在一起**。
 *
 * 摆在一起是因为这两句必须指同一个数，而分成两份文件（一份 `.c` 一份 `.R`）就要靠手
 * 去同步 —— 那正是"看着对、其实两边算的不是一回事"的来路。C 那边的形参多几个
 * （`give_log` / `lower_tail` / `log_p` 是 R 在 `.Call` 里传的），R 那边用默认值。
 *
 * 刻意**不放 `Inf` 与 `NaN` 的出口**：C 的 `printf("%.17g")` 印 `inf` / `nan`，
 * R 的 `sprintf` 印 `Inf` / `NaN` —— 那种差是两边 stdio 的口径差，不是数学差，
 * 摆进来只会把判据变成"要不要替换字符串"。NA 那一格同理（它是 R 解释器的东西）。
 */
export const PROBES = [
  ['dnorm', 'dnorm(0.5, 0.0, 1.0, 0)', 'dnorm(0.5)'],
  ['pnorm', 'pnorm(1.96, 0.0, 1.0, 1, 0)', 'pnorm(1.96)'],
  ['pnorm.log', 'pnorm(-9.0, 0.0, 1.0, 1, 1)', 'pnorm(-9, log.p = TRUE)'],
  ['qnorm', 'qnorm(0.975, 0.0, 1.0, 1, 0)', 'qnorm(0.975)'],
  ['dlnorm', 'dlnorm(2.0, 0.0, 1.0, 0)', 'dlnorm(2)'],
  ['plnorm', 'plnorm(2.0, 0.0, 1.0, 1, 0)', 'plnorm(2)'],
  ['dbinom', 'dbinom(3.0, 10.0, 0.3, 0)', 'dbinom(3, 10, 0.3)'],
  ['pbinom', 'pbinom(3.0, 10.0, 0.3, 1, 0)', 'pbinom(3, 10, 0.3)'],
  ['qbinom', 'qbinom(0.4, 10.0, 0.3, 1, 0)', 'qbinom(0.4, 10, 0.3)'],
  ['dpois', 'dpois(3.0, 4.5, 0)', 'dpois(3, 4.5)'],
  ['ppois', 'ppois(3.0, 4.5, 1, 0)', 'ppois(3, 4.5)'],
  ['qpois', 'qpois(0.4, 4.5, 1, 0)', 'qpois(0.4, 4.5)'],
  /* `dgamma` 的第三个形参在 C 那边是 **scale**，R 那边默认是 rate —— 这一格最容易错。 */
  ['dgamma', 'dgamma(2.0, 3.0, 2.0, 0)', 'dgamma(2, 3, scale = 2)'],
  ['pgamma', 'pgamma(2.0, 3.0, 2.0, 1, 0)', 'pgamma(2, 3, scale = 2)'],
  ['qgamma', 'qgamma(0.3, 3.0, 2.0, 1, 0)', 'qgamma(0.3, 3, scale = 2)'],
  ['dbeta', 'dbeta(0.3, 2.0, 3.0, 0)', 'dbeta(0.3, 2, 3)'],
  ['pbeta', 'pbeta(0.3, 2.0, 3.0, 1, 0)', 'pbeta(0.3, 2, 3)'],
  ['qbeta', 'qbeta(0.3, 2.0, 3.0, 1, 0)', 'qbeta(0.3, 2, 3)'],
  ['dt', 'dt(1.5, 7.0, 0)', 'dt(1.5, 7)'],
  ['pt', 'pt(1.5, 7.0, 1, 0)', 'pt(1.5, 7)'],
  ['qt', 'qt(0.95, 7.0, 1, 0)', 'qt(0.95, 7)'],
  ['df', 'df(1.5, 3.0, 7.0, 0)', 'df(1.5, 3, 7)'],
  ['pf', 'pf(1.5, 3.0, 7.0, 1, 0)', 'pf(1.5, 3, 7)'],
  ['qf', 'qf(0.95, 3.0, 7.0, 1, 0)', 'qf(0.95, 3, 7)'],
  ['dchisq', 'dchisq(2.5, 3.0, 0)', 'dchisq(2.5, 3)'],
  ['pchisq', 'pchisq(2.5, 3.0, 1, 0)', 'pchisq(2.5, 3)'],
  ['qchisq', 'qchisq(0.95, 3.0, 1, 0)', 'qchisq(0.95, 3)'],
  ['pnchisq', 'pnchisq(2.5, 3.0, 1.5, 1, 0)', 'pchisq(2.5, 3, ncp = 1.5)'],
  /* `dexp` 在 C 那边收 **scale**，R 收 rate —— 同上，写反了数会很像。 */
  ['dexp', 'dexp(1.5, 2.0, 0)', 'dexp(1.5, rate = 0.5)'],
  ['dweibull', 'dweibull(1.5, 2.0, 3.0, 0)', 'dweibull(1.5, 2, 3)'],
  ['dlogis', 'dlogis(0.5, 0.0, 1.0, 0)', 'dlogis(0.5)'],
  ['dcauchy', 'dcauchy(0.5, 0.0, 1.0, 0)', 'dcauchy(0.5)'],
  ['dnbinom', 'dnbinom(3.0, 5.0, 0.4, 0)', 'dnbinom(3, 5, 0.4)'],
  ['dhyper', 'dhyper(2.0, 5.0, 7.0, 4.0, 0)', 'dhyper(2, 5, 7, 4)'],
  ['phyper', 'phyper(2.0, 5.0, 7.0, 4.0, 1, 0)', 'phyper(2, 5, 7, 4)'],
  /* 这两族带一张**要在堆上现算的表**（`w_init_maybe` / `calloc`）—— 线性内存那条腿
     上它们是最容易出事的一格，所以特意摆进来。 */
  ['dwilcox', 'dwilcox(10.0, 5.0, 5.0, 0)', 'dwilcox(10, 5, 5)'],
  ['pwilcox', 'pwilcox(10.0, 5.0, 5.0, 1, 0)', 'pwilcox(10, 5, 5)'],
  ['dsignrank', 'dsignrank(10.0, 8.0, 0)', 'dsignrank(10, 8)'],
  ['psignrank', 'psignrank(10.0, 8.0, 1, 0)', 'psignrank(10, 8)'],
  ['gammafn', 'gammafn(12.5)', 'gamma(12.5)'],
  ['lgammafn', 'lgammafn(12.5)', 'lgamma(12.5)'],
  ['beta', 'beta(2.5, 3.5)', 'beta(2.5, 3.5)'],
  ['lbeta', 'lbeta(2.5, 3.5)', 'lbeta(2.5, 3.5)'],
  ['choose', 'choose(10.0, 3.0)', 'choose(10, 3)'],
  ['lchoose', 'lchoose(50.0, 20.0)', 'lchoose(50, 20)'],
  ['digamma', 'digamma(2.5)', 'digamma(2.5)'],
  ['trigamma', 'trigamma(2.5)', 'trigamma(2.5)'],
  ['psigamma', 'psigamma(2.5, 3.0)', 'psigamma(2.5, 3)'],
  ['bessel_j', 'bessel_j(2.5, 1.5)', 'besselJ(2.5, 1.5)'],
  ['bessel_y', 'bessel_y(2.5, 1.5)', 'besselY(2.5, 1.5)'],
  ['bessel_i', 'bessel_i(1.5, 0.5, 1.0)', 'besselI(1.5, 0.5)'],
  ['bessel_k', 'bessel_k(1.5, 0.5, 1.0)', 'besselK(1.5, 0.5)'],
  ['ptukey', 'ptukey(2.0, 1.0, 3.0, 10.0, 1, 0)', 'ptukey(2, 3, 10)'],
  ['qtukey', 'qtukey(0.9, 1.0, 3.0, 10.0, 1, 0)', 'qtukey(0.9, 3, 10)'],
  ['fround', 'fround(2.345678, 3.0)', 'round(2.345678, 3)'],
  ['fprec', 'fprec(123456.789, 4.0)', 'signif(123456.789, 4)'],
  ['sign', 'sign(-2.5)', 'sign(-2.5)'],
  ['cospi', 'cospi(0.25)', 'cospi(0.25)'],
  ['sinpi', 'sinpi(0.25)', 'sinpi(0.25)'],
  ['tanpi', 'tanpi(0.25)', 'tanpi(0.25)'],
  ['log1pexp', 'log1pexp(2.5)', 'log(1 + exp(2.5))'],
];

/**
 * 随机数那一格单开：它要**一条流**，不是一个孤立的数。
 *
 * `set.seed(42)` 之后 `runif` 三下再 `rnorm` 两下 —— 两边要走同一条流，所以 C 这边
 * 的调用次序必须与 R 那边一字不差（`norm_rand` 的 INVERSION 每次吃两个 uniform）。
 * 这一格最值钱：`runif` 是**纯整数运算**（MT19937），所以它在三条腿上应当**逐位相同**
 * —— 它验的不是 libm，是"线性内存里那 625 格状态有没有被我们搬错"。
 */
export const RNG_N_UNIF = 3;
export const RNG_N_NORM = 2;

/**
 * 要摊哪些 `.c` —— 与 `ext/r/build.js` 一样**从 R 自己的 standalone Makefile 里读**。
 * 两处各读一遍而不是共用一个函数：`build.js` 在模块顶层就 `b.run()` 了（它是个可执行的
 * 构建脚本），import 它等于顺手跑一遍构建。名单的**唯一出处**仍然只有那份 Makefile。
 */
function nmathSources() {
  const mk = join(RSRC, 'src/nmath/standalone/Makefile.in');
  const text = readFileSync(mk, 'utf8');
  const m = /SOURCES_NMATH\s*=\s*([\s\S]*?)\nSOURCES\s*=/.exec(text);
  if (m === null) throw new Error(`ext/r/cjs/gen.js: ${mk} 里找不到 SOURCES_NMATH`);
  const names = m[1].replace(/\\\n/g, ' ').trim().split(/\s+/).filter((s) => s.endsWith('.c'));
  if (names.length < 100) throw new Error(`ext/r/cjs/gen.js: SOURCES_NMATH 只读出 ${names.length} 份`);
  return names;
}

/** 文件里 `#define` 过的名字（对象宏与函数宏都算）—— 包完要 `#undef` 掉的就是这些。 */
const definesOf = (src) => new Set([...src.matchAll(/^[ \t]*#[ \t]*define[ \t]+(\w+)/gm)].map((m) => m[1]));

/**
 * 文件里**文件作用域的 `static`** 名字。
 *
 * 正则只认"`static` 开头、到第一个 `(` / `[` / `=` / `;` 之前的最后一个标识符"，所以
 * 函数、数组、标量都收得到，而函数体里缩进过的 `static` 收不到（它们不出文件，撞不了车）。
 * `qDiscrete_search.h` 那个 `do_search` 是宏拼出来的，正则看不见 —— 包了那份头就手动加上。
 */
function staticsOf(src) {
  const s = new Set([...src.matchAll(/^[ \t]*static\b[^;(){}=[]*?(\w+)[ \t]*(?:\(|\[|=|;)/gm)].map((m) => m[1]));
  if (/qDiscrete_search\.h/.test(src)) s.add('do_search');
  return s;
}

/** `ext/r/build.js` 里那两份我们自己的代码：NA/NaN/Inf 三格真值，与 R 的 Mersenne-Twister。 */
const OURS = ['omni_rna.c', 'omni_rng.c'].map((n) => ({ name: n, path: join(HERE, '..', 'rt', n) }));

/** 摊平：回 `{ text, renamed }`。`renamed` 是"撞了车、按文件挂了后缀"的那几个名字。 */
export function amalgamate() {
  const files = nmathSources().map((n) => ({ name: n, path: join(RSRC, 'src/nmath', n) }));
  for (const o of OURS) files.push(o);

  for (const f of files) {
    const src = readFileSync(f.path, 'utf8');
    f.defines = definesOf(src);
    f.statics = staticsOf(src);
  }
  /* 哪些 static 名字出现在一份以上 —— 只有这些要改名。 */
  const seen = new Map();
  for (const f of files) {
    for (const nm of f.statics) {
      if (!seen.has(nm)) seen.set(nm, []);
      seen.get(nm).push(f.name);
    }
  }
  const clash = new Set([...seen].filter(([, fs]) => fs.length > 1).map(([nm]) => nm));

  const L = [];
  L.push('/* nmath-lib.c —— `ext/r/cjs/gen.js` 生成，别手改。');
  L.push(' * R 的 src/nmath 摊成一份翻译单元，好让 C -> MIR -> JS 那条腿能整块吃下去。');
  L.push(' * **没有 `main`** —— 驱动各自 `#include` 它一次。 */');
  /* `-D` 进不了顶层 `omni run`，所以口径写在文件里（照 R 的 standalone Makefile 的 DEFS）。 */
  L.push('#define MATHLIB_STANDALONE 1');
  L.push('#define HAVE_CONFIG_H 1');
  const renamed = [];
  for (const f of files) {
    const ren = [...f.statics].filter((nm) => clash.has(nm));
    const stem = f.name.replace(/\.c$/, '').replace(/\W/g, '_');
    L.push(`\n/* ---- ${f.name} ---- */`);
    for (const nm of ren) {
      L.push(`#define ${nm} ${nm}__${stem}`);
      renamed.push(`${f.name}:${nm}`);
    }
    L.push(`#include "${f.path}"`);
    for (const nm of ren) L.push(`#undef ${nm}`);
    for (const nm of f.defines) if (!ren.includes(nm)) L.push(`#undef ${nm}`);
  }
  return { text: `${L.join('\n')}\n`, renamed, count: files.length };
}

/** 驱动的头：包一次摊平出来那份，再加自己的 `main`。 */
const driverHead = (what) => [`/* \`ext/r/cjs/gen.js\` 生成，别手改 —— ${what} */`,
  '#include <stdio.h>', `#include "${LIB_C}"`,
  `#include "${join(HERE, '..', 'rt', 'omni_rng.h')}"`].join('\n');

/**
 * **一个 .c 一个 .js** 那条路的驱动头（ADR-0047 第十/十一格）：**不**包那份摊平的 `.c`，
 * 只按原型调 —— 那 122 份各自编成一份 `.js` 模块，符号靠 `import`/`export` 接上。
 */
const modDriverHead = (what) => [`/* \`ext/r/cjs/gen.js\` 生成，别手改 —— ${what} */`,
  '#include <stdio.h>', '#include <Rmath.h>',
  `#include "${join(HERE, '..', 'rt', 'omni_rng.h')}"`].join('\n');

/** 驱动一（探子）：一行一格 `名字<制表符>%.17g`。 */
function probeMain(head) {
  const L = [head === undefined ? driverHead('66 格数的探子') : head];

  L.push('int main(void) {');
  for (const [name, cExpr] of PROBES) {
    L.push(`  printf("${name}\\t%.17g\\n", (double)(${cExpr}));`);
  }
  L.push(`  omni_r_set_seed(42);`);
  for (let i = 0; i < RNG_N_UNIF; i++) L.push(`  printf("runif${i + 1}\\t%.17g\\n", unif_rand());`);
  for (let i = 0; i < RNG_N_NORM; i++) L.push(`  printf("rnorm${i + 1}\\t%.17g\\n", norm_rand());`);
  L.push('  return 0;');
  L.push('}');
  return L.join('\n');
}

/** 尺子那一份 R：同一批数、同一套标签、同一个 `%.17g`。 */
export function probeR() {
  const L = [];
  L.push('# probe.R —— `ext/r/cjs/gen.js` 生成，别手改。这是 nmath 上 JS 腿那一刀的尺子。');
  L.push('p <- function(nm, v) cat(nm, "\\t", sprintf("%.17g", v), "\\n", sep = "")');
  for (const [name, , rExpr] of PROBES) L.push(`p("${name}", ${rExpr})`);
  L.push('set.seed(42)');
  L.push(`u <- runif(${RNG_N_UNIF})`);
  L.push(`n <- rnorm(${RNG_N_NORM})`);
  L.push(`for (i in seq_len(${RNG_N_UNIF})) p(paste0("runif", i), u[i])`);
  L.push(`for (i in seq_len(${RNG_N_NORM})) p(paste0("rnorm", i), n[i])`);
  return `${L.join('\n')}\n`;
}

/**
 * 驱动二（画图）：往 **stdout 印一张 SVG**。
 *
 * 为什么是 SVG 而不是接一台图形设备：调研的结论是这个仓库里已经有一条**零成本**的
 * "编译产物 -> 浏览器里的图"的路 —— 程序把 `<svg …>` 印到 stdout，Studio 的预览栏
 * （`src/studio/render.js` 认 `<svg` 开头与逐块抠 `<svg>…</svg>`）就当图挂上去，
 * `src/lib/plot.omni` 与 `turtle.omni` 已经这么干了。C→JS 那条腿目前**没有通用的
 * 宿主导入表**（产物只导出一个 `$run()`），所以"接一台真设备"要先有那张表 ——
 * 那是另一刀。而这一刀要的是**这条路上第一张真的图**，用现成的地基。
 *
 * 画的是两条曲线：`dnorm(x)` 与 `dt(x, 3)`（都是 R 自己的 C 算的），加坐标轴与刻度。
 * 坐标一律 `%.3f` —— 见 `PLOT` 的账。
 */
function plotMain() {
  const { w, h, ml, mr, mt, mb, x0, x1, n, ymax } = PLOT;
  const L = [driverHead('往 stdout 印一张 SVG')];
  L.push(`#define PW ${w}
#define PH ${h}
#define ML ${ml}
#define MR ${mr}
#define MT ${mt}
#define MB ${mb}
#define X0 (${x0}.0)
#define X1 (${x1}.0)
#define NP ${n}
#define YMAX (${ymax})

/* 数据坐标 -> 画布坐标。两条轴各自线性映射，y 轴朝下所以要翻一次。 */
static double px(double x) { return ML + (x - X0) / (X1 - X0) * (PW - ML - MR); }
static double py(double y) { return PH - MB - y / YMAX * (PH - MT - MB); }

/* 一条曲线：kind 0 是 dnorm(x)，1 是 dt(x, 3)。 */
static void curve(int kind, const char *color) {
  int i;
  printf("  <polyline fill=\\"none\\" stroke=\\"%s\\" stroke-width=\\"2\\" points=\\"", color);
  for (i = 0; i < NP; i++) {
    double x = X0 + (X1 - X0) * i / (double)(NP - 1);
    double y = (kind == 0) ? dnorm(x, 0.0, 1.0, 0) : dt(x, 3.0, 0);
    printf("%s%.3f,%.3f", i == 0 ? "" : " ", px(x), py(y));
  }
  printf("\\"/>\\n");
}

int main(void) {
  int k;
  printf("<svg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"%d\\" height=\\"%d\\" "
         "viewBox=\\"0 0 %d %d\\">\\n", PW, PH, PW, PH);
  printf("  <rect width=\\"%d\\" height=\\"%d\\" fill=\\"#fff\\"/>\\n", PW, PH);
  /* 坐标轴 */
  printf("  <path fill=\\"none\\" stroke=\\"#333\\" d=\\"M %.3f %.3f L %.3f %.3f L %.3f %.3f\\"/>\\n",
         px(X0), py(0.0) - (PH - MT - MB), px(X0), py(0.0), px(X1), py(0.0));
  /* x 轴刻度与标签 */
  for (k = (int)X0; k <= (int)X1; k++) {
    double x = px((double)k);
    printf("  <path stroke=\\"#333\\" d=\\"M %.3f %.3f L %.3f %.3f\\"/>\\n",
           x, py(0.0), x, py(0.0) + 5.0);
    printf("  <text x=\\"%.3f\\" y=\\"%.3f\\" font-size=\\"11\\" text-anchor=\\"middle\\""
           " fill=\\"#333\\">%d</text>\\n", x, py(0.0) + 18.0, k);
  }
  /* y 轴刻度与标签（0、0.15、0.30、0.45） */
  for (k = 0; k <= 3; k++) {
    double y = py(YMAX * k / 3.0);
    printf("  <path stroke=\\"#333\\" d=\\"M %.3f %.3f L %.3f %.3f\\"/>\\n",
           px(X0) - 5.0, y, px(X0), y);
    printf("  <text x=\\"%.3f\\" y=\\"%.3f\\" font-size=\\"11\\" text-anchor=\\"end\\""
           " fill=\\"#333\\">%.2f</text>\\n", px(X0) - 8.0, y + 4.0, YMAX * k / 3.0);
  }
  curve(0, "#1f77b4");
  curve(1, "#d62728");
  printf("  <text x=\\"%.3f\\" y=\\"%d\\" font-size=\\"12\\" fill=\\"#1f77b4\\">dnorm(x)</text>\\n",
         (double)(PW - MR - 150), MT);
  printf("  <text x=\\"%.3f\\" y=\\"%d\\" font-size=\\"12\\" fill=\\"#d62728\\">dt(x, 3)</text>\\n",
         (double)(PW - MR - 70), MT);
  printf("</svg>\\n");
  return 0;
}`);
  return L.join('\n');
}

/**
 * 画图那一格的尺子：**只印两条曲线的点串**，不重写一遍 SVG。
 *
 * 为什么不让 R 也生成整张 SVG：那等于把画布那几十行逻辑写两遍，而两遍之间会飘。
 * 图里真正是"数"的部分只有那两个 `points` 串 —— 判它逐字节相同就够了，
 * 剩下的骨架由"解释腿 == JS 腿 == cc 腿"三方逐字节那道门管着。
 */
export function plotR() {
  const { w, h, ml, mr, mt, mb, x0, x1, n, ymax } = PLOT;
  return `# plot.R —— \`ext/r/cjs/gen.js\` 生成，别手改。画图那一格的尺子：两条曲线的点串。
px <- function(x) ${ml} + (x - (${x0})) / (${x1} - (${x0})) * (${w} - ${ml} - ${mr})
py <- function(y) ${h} - ${mb} - y / ${ymax} * (${h} - ${mt} - ${mb})
i <- 0:(${n} - 1)
x <- ${x0} + (${x1} - (${x0})) * i / (${n} - 1)
one <- function(y) cat(paste(sprintf("%.3f,%.3f", px(x), py(y)), collapse = " "), "\\n", sep = "")
one(dnorm(x))
one(dt(x, 3))
`;
}

/**
 * 驱动三（真设备）：自己在**帧缓冲**上画，再调宿主把这一帧交出去。
 *
 * 与驱动二的分别是本质的：那一格是"程序把图当文本印出去、宿主负责画"，这一格是
 * **程序调宿主的画笔** —— `omni_c_gfx_frame(路径, 宽, 高, 帧缓冲)` 是 C→JS 这条腿上
 * 第一个"对外世界"的出口（在这之前它只有一张写死的 libc 表）。图形设备就是这个形状：
 * 图元全在内存里画，一趟只过一帧。
 *
 * 再往 stdout 印一行 `#gfx png <路径> <宽> <高>` —— `src/studio/render.js:267` 认这行，
 * 于是同一份程序在 Studio 里就是 canvas 上的一张图。
 */
function frameMain() {
  const { w, h, ml, mr, mt, mb, x0, x1, ymax } = PLOT;
  const L = [driverHead('自己画帧缓冲，再调宿主交出这一帧')];
  L.push(`#define FW ${w}
#define FH ${h}
#define ML ${ml}
#define MR ${mr}
#define MT ${mt}
#define MB ${mb}
#define X0 (${x0}.0)
#define X1 (${x1}.0)
#define YMAX (${ymax})

/* 宿主那一格（\`src/core/interp/libc.js\` 的 \`omni_c_gfx_frame\`）。
   一格像素是一个 unsigned int，按 0xRRGGBB 读。 */
extern int omni_c_gfx_frame(const char *path, int w, int h, const unsigned int *fb);

static unsigned int fb[FW * FH];

static void put(int x, int y, unsigned int c) {
  if (x >= 0 && x < FW && y >= 0 && y < FH) fb[y * FW + x] = c;
}
/* 竖线与横线 —— 坐标轴与刻度就这两样，不必要 Bresenham。 */
static void vline(int x, int y0, int y1, unsigned int c) {
  int y; for (y = y0; y <= y1; y++) put(x, y, c);
}
static void hline(int y, int x0, int x1, unsigned int c) {
  int x; for (x = x0; x <= x1; x++) put(x, y, c);
}
static double px(double x) { return ML + (x - X0) / (X1 - X0) * (FW - ML - MR); }
static double py(double y) { return FH - MB - y / YMAX * (FH - MT - MB); }

/* 一条曲线：每一列算一个 y，与上一列之间竖着连起来（**逐列**，所以不会断）。
   kind 0 是 dnorm(x)，1 是 dt(x, 3) —— 与驱动二画的是同两条。 */
static void curve(int kind, unsigned int c) {
  int sx, prev = -1;
  for (sx = ML; sx <= FW - MR; sx++) {
    double x = X0 + (X1 - X0) * (sx - ML) / (double)(FW - ML - MR);
    double v = (kind == 0) ? dnorm(x, 0.0, 1.0, 0) : dt(x, 3.0, 0);
    int sy = (int)(py(v) + 0.5);
    if (prev < 0) prev = sy;
    vline(sx, sy < prev ? sy : prev, sy < prev ? prev : sy, c);
    prev = sy;
  }
}

int main(void) {
  int i, k;
  const char *out = "${join(OUT, 'nmath-frame.png')}";
  for (i = 0; i < FW * FH; i++) fb[i] = 0xffffff;
  /* 坐标轴 */
  vline((int)px(X0), MT, (int)py(0.0), 0x333333);
  hline((int)py(0.0), (int)px(X0), (int)px(X1), 0x333333);
  for (k = (int)X0; k <= (int)X1; k++) {
    int sx = (int)px((double)k);
    vline(sx, (int)py(0.0), (int)py(0.0) + 5, 0x333333);
  }
  for (k = 0; k <= 3; k++) {
    int sy = (int)py(YMAX * k / 3.0);
    hline(sy, (int)px(X0) - 5, (int)px(X0), 0x333333);
  }
  curve(0, 0x1f77b4);
  curve(1, 0xd62728);
  if (omni_c_gfx_frame(out, FW, FH, fb) <= 0) { printf("交帧失败\\n"); return 1; }
  /* Studio 的预览栏认这一行（render.js:267） —— 于是浏览器里它就是 canvas 上的图。 */
  printf("#gfx png %s %d %d\\n", out, FW, FH);
  return 0;
}`);
  return L.join('\n');
}

/**
 * 驱动四（真设备，实时那一档）：用**设备自己的笔**画。
 *
 * 与驱动三的分别：那一格是"我自己画好一整帧，你存成图"（`omni_c_gfx_frame`），
 * 这一格是"**你替我画**" —— `cls` / `setcol` / `moveto` / `lineto` / `refresh` 打到的是
 * `globalThis.__OMNI_GFX`：node 上是 `host/gfx-cpu.js` 那一档，**浏览器里是
 * `src/studio/gfx-gl.js` 那台 WebGL2 设备**。所以同一份 C 在页面里画的是真 canvas。
 * 这就是"浏览器图形设备"该有的形状。
 *
 * 画布尺寸**问设备要**（`xres`/`yres`），不写死 —— 页面上 canvas 多大就画多大。
 */
function devMain() {
  const { ml, mr, mt, mb, x0, x1, ymax } = PLOT;
  const L = [driverHead('用设备自己的笔画（实时那一档）')];
  L.push(`#define ML ${ml}
#define MR ${mr}
#define MT ${mt}
#define MB ${mb}
#define X0 (${x0}.0)
#define X1 (${x1}.0)
#define YMAX (${ymax})

/* 宿主那一格（\`src/core/interp/libc.js\` 的 \`omni_c_gfx_call\`）：名字 + 一串 double，
   回一个 double。名字表在 \`src/core/host/gfx-cpu.js\` 的 \`gfxCall\`。 */
extern double omni_c_gfx_call(const char *name, const double *args, int n);

static double ARG[4];
static double g0(const char *nm) { return omni_c_gfx_call(nm, ARG, 0); }
static double g1(const char *nm, double a) { ARG[0] = a; return omni_c_gfx_call(nm, ARG, 1); }
static double g2(const char *nm, double a, double b) {
  ARG[0] = a; ARG[1] = b; return omni_c_gfx_call(nm, ARG, 2);
}

static int W, H;
static double px(double x) { return ML + (x - X0) / (X1 - X0) * (W - ML - MR); }
static double py(double y) { return H - MB - y / YMAX * (H - MT - MB); }

/* 一条曲线：\`moveto\` 一次，往后一路 \`lineto\` —— 折线交给设备去画。 */
static void curve(int kind) {
  int sx;
  for (sx = ML; sx <= W - MR; sx++) {
    double x = X0 + (X1 - X0) * (sx - ML) / (double)(W - ML - MR);
    double v = (kind == 0) ? dnorm(x, 0.0, 1.0, 0) : dt(x, 3.0, 0);
    if (sx == ML) g2("moveto", (double)sx, py(v));
    else g2("lineto", (double)sx, py(v));
  }
}

int main(void) {
  int k;
  W = (int)g0("xres");
  H = (int)g0("yres");
  if (W <= 0 || H <= 0) { printf("这一趟没有设备\\n"); return 1; }
  g1("cls", (double)0xffffff);
  /* 坐标轴与刻度 */
  g1("setcol", (double)0x333333);
  g2("moveto", px(X0), (double)MT);
  g2("lineto", px(X0), py(0.0));
  g2("lineto", px(X1), py(0.0));
  for (k = (int)X0; k <= (int)X1; k++) {
    g2("moveto", px((double)k), py(0.0));
    g2("lineto", px((double)k), py(0.0) + 5.0);
  }
  for (k = 0; k <= 3; k++) {
    g2("moveto", px(X0) - 5.0, py(YMAX * k / 3.0));
    g2("lineto", px(X0), py(YMAX * k / 3.0));
  }
  g1("setcol", (double)0x1f77b4); curve(0);
  g1("setcol", (double)0xd62728); curve(1);
  /* 交帧。CPU 备选那一档自己写图 + 印一行 \`#gfx\`；浏览器那一档就是 canvas 上的一帧。 */
  g0("refresh");
  printf("dev %dx%d\\n", W, H);
  return 0;
}`);
  return L.join('\n');
}

/**
 * **一个 .c 一个 .js** 那条路要编的那一串（`{path, out}`）：nmath 那 122 份 + 我们自己
 * 那两份 + 那个只按原型调的驱动。名单的唯一出处仍是 R 自己的 Makefile。
 */
export function modUnits() {
  const us = nmathSources().map((n) => ({
    path: join(RSRC, 'src/nmath', n),
    out: join(MOD_DIR, `${n.replace(/\.c$/, '')}.mjs`),
  }));
  for (const o of OURS) {
    us.push({ path: o.path, out: join(MOD_DIR, `${o.name.replace(/\.c$/, '')}.mjs`) });
  }
  us.push({ path: MOD_DRV, out: join(MOD_DIR, 'probe-drv.mjs') });
  return us;
}

/** 写盘。回写了几份、摊了几个文件、改了哪几个名字。 */
export function generate() {

  if (!existsSync(join(RSRC, 'src/nmath'))) {
    throw new Error(`ext/r/cjs/gen.js: 参考树不在：${RSRC}（R_SRC=<路径>）`);
  }
  if (!existsSync(join(GEN_INC, 'Rmath.h'))) {
    throw new Error('ext/r/cjs/gen.js: 三份生成出来的头还不在'
      + `（${GEN_INC}）—— 先跑一遍 \`node ext/r/build.js\``);
  }
  mkdirSync(OUT, { recursive: true });
  mkdirSync(MOD_DIR, { recursive: true });
  const { text, renamed, count } = amalgamate();
  writeFileSync(LIB_C, text);
  writeFileSync(AMALGAM, `${probeMain()}\n`);
  /* 同一个 `main`，只换了头：那一份包摊平的 `.c`，这一份只按原型调（一个 .c 一个 .js）。
     两份的 stdout 必须逐字节相同 —— 那就是 `tests/r/cjs.js` 最后那一节的判据。 */
  writeFileSync(MOD_DRV, `${probeMain(modDriverHead('66 格数的探子（一个 .c 一个 .js）'))}\n`);
  writeFileSync(PROBE_R, probeR());
  writeFileSync(PLOT_C, `${plotMain()}\n`);
  writeFileSync(PLOT_R, plotR());
  writeFileSync(FRAME_C, `${frameMain()}\n`);
  writeFileSync(DEV_C, `${devMain()}\n`);
  return { bytes: text.length, count, renamed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = generate();
  process.stdout.write(`${LIB_C}\n  ${r.count} 份 .c 摊成 ${r.bytes} 字节\n`
    + `${AMALGAM}\n  ${PROBES.length + RNG_N_UNIF + RNG_N_NORM} 格探子\n`
    + `${PLOT_C}\n  一张 ${PLOT.w}x${PLOT.h} 的 SVG（dnorm 与 dt 各 ${PLOT.n} 点）\n`
    + `${FRAME_C}\n  同两条曲线画进帧缓冲，调 omni_c_gfx_frame 交帧 -> PNG\n`
    + `${DEV_C}\n  同两条曲线交给设备自己的笔（cls/setcol/moveto/lineto/refresh）\n`);
  if (process.argv.includes('-v')) {
    process.stdout.write(`  改了名的 static（${r.renamed.length} 处）：\n    ${r.renamed.join('\n    ')}\n`);
  }
}
