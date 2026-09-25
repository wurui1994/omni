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
export const AMALGAM = join(OUT, 'nmath-all.c');
export const PROBE_R = join(OUT, 'probe.R');
/** 三份生成出来的头在这儿（`ext/r/build.js` 造的）—— 编这份 `.c` 要 `-I` 它。 */
export const GEN_INC = join(ROOT, '.omni-cache', 'r-rt', 'include');
export const INCS = [GEN_INC, join(RSRC, 'src/nmath'), join(RSRC, 'src/include')];

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
  L.push('/* nmath-all.c —— `ext/r/cjs/gen.js` 生成，别手改。');
  L.push(' * R 的 src/nmath 摊成一份翻译单元，好让 C -> MIR -> JS 那条腿能整块吃下去。 */');
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
  L.push(probeMain());
  return { text: `${L.join('\n')}\n`, renamed, count: files.length };
}

/** 探子那一段 C：一行一格 `名字<制表符>%.17g`。 */
function probeMain() {
  const L = [];
  L.push('\n/* ---- 探子（gen.js 的 PROBES 生成） ---- */');
  L.push('#include <stdio.h>');
  L.push(`#include "${join(HERE, '..', 'rt', 'omni_rng.h')}"`);
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
  const { text, renamed, count } = amalgamate();
  writeFileSync(AMALGAM, text);
  writeFileSync(PROBE_R, probeR());
  return { bytes: text.length, count, renamed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = generate();
  process.stdout.write(`${AMALGAM}\n  ${r.count} 份 .c 摊成 ${r.bytes} 字节，`
    + `${PROBES.length + RNG_N_UNIF + RNG_N_NORM} 格探子\n`);
  if (process.argv.includes('-v')) {
    process.stdout.write(`  改了名的 static（${r.renamed.length} 处）：\n    ${r.renamed.join('\n    ')}\n`);
  }
}
