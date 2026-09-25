#!/usr/bin/env node
// tests/r/libr.js —— **libR 那一档的尺子**（编译器那一档的尺子是 `tests/r/oracle.js`）。
//
// 量的是"我们自己从 r-source 编出来的那个 R 能干什么"，一格一件事、都是真跑：
//   1. base：算术与向量
//   2. base：`.C_*` / `.F_*` 那批原生符号对象在不在（`baseloader.R` 的尾巴）
//   3. stats + LAPACK：`lm()` 的系数（走 Accelerate）
//   4. methods：S4 起得来
//   5. grid + ggplot2：`ggsave` 出一份真 PDF（CRAN 装进来的包）
//   6. Rcpp：`cppFunction` 现场编一段 C++ 并算对（走 `R CMD SHLIB` + 我们生成的 Makeconf）
//   7. quartz：R 自己那份 Cocoa 设备出一张 PNG（`capabilities("aqua")` 为真）
//   8. `omni run x.R` 一句换档，而且 R 自己的编译器全关
//
// **每一格都还判"输出里一行 Error 都没有"** —— 出过那种"图照样出得来、但 stderr 里四行
// Error"的情形（见第 2 格的账），只看退出码与要的那一行是发现不了的。
//
// R_HOME 没建出来就**整轴跳过**（不是失败）：`node ext/r/build-libR.js` 要几十秒，
// 而 CRAN 那几个包要 `node ext/r/install-cran.js`。第 4、5 两格在包没装时也跳过。
//
//   node tests/r/libr.js

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const HOME = join(ROOT, '.omni-cache/r-rt/libR/home');
const RBIN = join(HOME, 'bin/exec/R');
const LIB = join(HOME, 'library');

let pass = 0;
let fail = 0;
const ok = (s, extra = '') => { pass += 1; process.stdout.write(`  ok   ${s}${extra === '' ? '' : ` [${extra}]`}\n`); };
const no = (s, why) => { fail += 1; process.stdout.write(`  FAIL ${s}\n       ${String(why).slice(0, 300)}\n`); };
const skip = (s) => process.stdout.write(`  skip ${s}\n`);

if (!existsSync(RBIN)) {
  skip('libR 还没建出来（node ext/r/build-libR.js）—— 整轴跳过');
  process.exit(0);
}

/** 起一趟我们的 R，回 stdout+stderr。 */
const run = (code, ms = 300000) => {
  const r = spawnSync(RBIN, ['--vanilla', '--no-echo', '-e', code], {
    encoding: 'utf8',
    timeout: ms,
    env: {
      ...process.env, R_HOME: HOME, R_ENABLE_JIT: '0', TZDIR: '/usr/share/zoneinfo',
    },
  });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status ?? 1 };
};
/** 判据统一成"输出里有一行正好是这个"。
    为什么不比"最后一行"：S4 初始化会往**前面**印一行，而 `geom_smooth()` 会往**后面**
    印一行 `using formula = 'y ~ x'` —— 两头都有噪声，所以判"有这一行"，不判位置。

    **顺带判"一行 Error 都没有"**：`library(ggplot2)` 出过那种"图照样出得来、但 stderr
    里四行 Error"的情形（`cli` 的 `.onLoad` 挂了，见 base 那一格的账）。退出码是 0、
    要的那一行也在 —— 只看这两样发现不了，所以这儿把 Error 也当失败。 */
const want = (label, code, expect, ms) => {
  const r = run(code, ms);
  const lines = r.out.trim().split('\n').map((l) => l.trim());
  const bad = lines.filter((l) => l.startsWith('Error'));
  if (r.code !== 0) no(label, r.out);
  else if (bad.length > 0) no(label, `输出里有 ${bad.length} 行 Error：${bad[0]}`);
  else if (!lines.includes(expect)) no(label, `想要有一行是 ${JSON.stringify(expect)}，得到：${r.out.trim()}`);
  else ok(label, expect);
};

want('base/算术与向量', 'cat(sum(1:10), round(sd(c(1,2,3,4)), 6), length(rev(1:5)), "\\n")', '55 1.290994 5');
/**
 * **base 的原生符号对象在不在**（`.C_*` / `.F_*`）。
 *
 * R 正经的构建里 `library/base/R/base` 装的是 `baseloader.R`，而我们装的是 all.R ——
 * 于是 `baseloader.R` 里那句 `getDLLRegisteredRoutines("base")` 少了，`.C_*` 一格都没有。
 * 症状离病根很远：`addTaskCallback()` 报 `object '.C_R_addTaskCallback' not found`，
 * 而调它的是 `cli` 的 `.onLoad` —— 于是 `library(ggplot2)` 会吐四行 Error
 * （`'ansi_show_cursor' is not an exported object from 'namespace:cli'`），
 * 图**照样出得来**，所以光看 PDF 是发现不了的。这一格就是为那件事守着（见 `mkbase`）。
 */
want('base/原生符号对象（baseloader 的尾巴）',
  'cat(exists(".C_R_addTaskCallback", envir=baseenv()),'
  + ' exists(".F_dqrdc2", envir=baseenv()),'
  + ' length(getTaskCallbackNames()) >= 0, "\\n")', 'TRUE TRUE TRUE');
want('stats+LAPACK/lm 的系数',
  'fit <- lm(c(1,2,3.1) ~ c(1,2,3)); cat(round(coef(fit)[2], 4), class(fit), "\\n")', '1.05 lm');
want('methods/S4 起得来',
  'library(methods); setClass("P", representation(x="numeric")); cat(isVirtualClass("P"), slotNames("P"), "\\n")', 'FALSE x');
/* 产物一律落 `.omni-cache/r-rt/libR/` 下（与 `home/` 同级）—— 不用 `tempdir()`：
   那个目录 R 一退就删，出了事连"那份文件长什么样"都看不着。 */
const ART = join(ROOT, '.omni-cache/r-rt/libR');
const png = join(ART, 'test-quartz.png');
rmSync(png, { force: true });
want('quartz/R 自己的 Cocoa 设备出 PNG',
  `quartz(type="png", file=${JSON.stringify(png)}, width=4, height=3); plot(1:10); dev.off();`
  + ` cat(capabilities("aqua"), file.size(${JSON.stringify(png)}) > 1000, "\\n")`, 'TRUE TRUE');

if (!existsSync(join(LIB, 'ggplot2'))) {
  skip('ggplot2 没装（node ext/r/install-cran.js）');
} else {
  const pdf = join(ART, 'test-gg.pdf');
  rmSync(pdf, { force: true });
  want('ggplot2/ggsave 出真 PDF',
    'library(ggplot2); d <- data.frame(x=1:10, y=(1:10)^2);'
    + ' p <- ggplot(d, aes(x, y)) + geom_point() + geom_smooth(method="lm", se=FALSE);'
    + ` ggsave(${JSON.stringify(pdf)}, p, width=5, height=4);`
    + ` cat(as.character(packageVersion("ggplot2")), file.size(${JSON.stringify(pdf)}) > 3000, "\\n")`,
    '4.0.3 TRUE');
}

if (!existsSync(join(LIB, 'Rcpp'))) {
  skip('Rcpp 没装（node ext/r/install-cran.js Rcpp）');
} else {
  want('Rcpp/cppFunction 现场编 C++',
    'library(Rcpp); cppFunction("double ssq(NumericVector x) { double s=0; for (int i=0;i<x.size();i++) s+=x[i]*x[i]; return s; }");'
    + ' cat(ssq(1:10), "\\n")', '385');
}

/**
 * **`omni run x.R` 一句就够** —— 编译器那一档接不住时自己换到这一档（`ext/r/libr-run.js`）。
 *
 * 量两件事，因为它们都出过问题：
 *   1. 换档真的发生了，而且不用手敲 `R_HOME=… bin/exec/R --vanilla -f …` 那一串；
 *   2. **R 自己的编译器一格都没用上**（ADR-0046）：JIT 级别是 0、转了 100 圈的函数体还是
 *      `call` 而不是 `bytecode`、装进来的 base/stats 里的函数体也还是 `{`。
 *      只设 `R_ENABLE_JIT=0` 不够 —— 包里带着字节码时还会去执行它，所以
 *      `R_DISABLE_BYTECODE=1` 那一格也要在。
 */
const omniRun = (code, ms = 300000) => {
  const f = join(ROOT, '.omni-cache/r-rt/libR', 'test-omni-run.R');
  writeFileSync(f, code);
  const r = spawnSync(process.execPath, [join(ROOT, 'src/cli.js'), 'run', f], {
    encoding: 'utf8', timeout: ms, cwd: ROOT,
  });
  rmSync(f, { force: true });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
};
const out = omniRun('library(stats)\n'
  + 'f <- function(x) x + 1\n'
  + 'for (i in 1:100) f(i)\n'
  + 'cat("JIT", compiler::enableJIT(-1), class(body(f))[1], class(body(var))[1], "\\n")\n');
const badRun = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('Error'));
if (!out.includes('换 libR 那一档')) no('omni run/接不住时自己换档', out);
else if (badRun.length > 0) no('omni run/换过去之后一行 Error 都没有', badRun[0]);
else if (!out.split('\n').map((l) => l.trim()).includes('JIT 0 call {')) {
  no('omni run/R 自己的编译器一格都不用', `想要有一行是 "JIT 0 call {"，得到：${out.trim()}`);
} else ok('omni run/一句换到 libR 那一档，R 的编译器全关', 'JIT 0 call {');

process.stdout.write(`\n${pass} passed, ${fail} failed（libR：我们自己编的那个 R）\n`);
process.exit(fail === 0 ? 0 : 1);
