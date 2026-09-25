#!/usr/bin/env node
// tests/r/cjs.js —— **R 的 C 上 JS 腿那一轴的尺子**。
//
// 三档 R，这是第三档的第一格：
//   1. 编译器档（`tests/r/oracle.js`）—— R 源码走我们的适配器，只链 `libomniRmath`
//   2. libR 档（`tests/r/libr.js`）—— 我们自己从 r-source 编出来的那个真 R
//   3. **这一档** —— R 自己的 C（`src/nmath` 那 120 份）经我们自己的 C 前端
//      （`src/core/frontend-c`）到 MIR，再到 JS（`src/core/mir/emit_js.js`），
//      一行本机 libm 都不链
//
// ## 四道门
//
//   1. **摊平没改数**：摊出来那一份用 `cc` 编一遍，与 `Rscript` 逐字节相同。
//      这道门管的是"摊平"本身（`#undef` 漏没漏、static 改名改错没有）—— 它与我们的
//      编译器无关，所以先过它，后面那几道门才说得清是谁的问题。
//   2. **解释腿 == JS 腿，逐字节**。这是 `tests/c/run.js` 的口径（那儿的解释腿已经证过
//      与 `tcc -run` 逐字节相同），分叉最容易出在值表示与线性内存上，而那些都会在这
//      66 行里露出来。
//   3. **JS 腿 vs `Rscript`：误差有上界**。这两边的 libm 不是同一份（JS 腿走
//      `interp/libc.js` 里那张表，本机走苹果的 libm），所以这儿不判逐字节 ——
//      判"相对/绝对误差取小者"的最大值，与 `tests/c/libc-libm.js` 同一个口径。
//   4. **`runif` 要逐位相同**。MT19937 是纯整数运算，libm 插不上手 —— 所以这三格
//      一旦不同就不是精度问题，是那 625 格状态在线性内存里被搬错了。
//
// 都要先有**行数**：`/tmp` 与空输出上吃过"空对空的 diff 也叫相同"的亏，所以每一趟
// 都先判 66 行。
//
//   node tests/r/cjs.js

import { spawnSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generate, AMALGAM, PROBE_R, PLOT_C, PLOT_R, PLOT, INCS, PROBES, RNG_N_UNIF, RNG_N_NORM,
} from '../../ext/r/cjs/gen.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(ROOT, 'src/cli.js');
const CC = process.env.OMNI_CLANG ?? process.env.CC ?? 'clang';
const N_LINES = PROBES.length + RNG_N_UNIF + RNG_N_NORM;

/** 量出来的上界（相对/绝对取小者）。**只许变小。**
 *
 * 现在最大的那一格是 `qtukey` 的 3.0e-15 —— 它是个迭代求根（`qinv` 起步 + 五步牛顿），
 * 每一步都过一次 `ptukey`，而 `ptukey` 里有 `exp`/`log`/`sqrt` 与一张 Gauss-Legendre
 * 的结点表；起点差一个 ulp，五步之后就放大到这个量级。66 格里有 51 格是**逐位相同**的。 */
const MAX_ERR = 1e-14;

let pass = 0;
let fail = 0;
const ok = (s, extra = '') => { pass += 1; process.stdout.write(`  ok   ${s}${extra === '' ? '' : ` [${extra}]`}\n`); };
const no = (s, why) => { fail += 1; process.stdout.write(`  FAIL ${s}\n       ${String(why).slice(0, 600)}\n`); };
const skip = (s) => process.stdout.write(`  skip ${s}\n`);

/* ---- 0. 摊平 -------------------------------------------------------------- */

if (!existsSync(join(ROOT, '.omni-cache/r-rt/include/Rmath.h'))) {
  skip('三份生成出来的头还不在（node ext/r/build.js）—— 整轴跳过');
  process.exit(0);
}
let gen;
try {
  gen = generate();
} catch (e) {
  no('摊平', e instanceof Error ? e.message : String(e));
  process.exit(1);
}
ok('摊平', `${gen.count} 份 .c -> ${gen.bytes} 字节，改名 ${gen.renamed.length} 处`);

/** 跑一趟，回 `{ code, out, err }`。 */
const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 600000, cwd: ROOT });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
};
/** 把一趟输出解析成 `名字 -> 数`。顺带判行数 —— 空输出不许冒充"相同"。 */
function table(label, text) {
  const lines = text.trim().split('\n').filter((l) => l.includes('\t'));
  if (lines.length !== N_LINES) {
    no(label, `只有 ${lines.length} 行，要 ${N_LINES} 行\n${text.slice(0, 500)}`);
    return null;
  }
  const m = new Map();
  for (const l of lines) {
    const [k, v] = l.split('\t');
    m.set(k, Number(v));
  }
  return m;
}
/** 只留探子那几行（编 R 的源码会往 stderr 印 `warning: xxx redefined`，那不是数）。 */
const probeLines = (r) => `${r.out}`.split('\n').filter((l) => l.includes('\t')).join('\n');

/* ---- 1. 尺子：Rscript ------------------------------------------------------ */

const rs = sh('Rscript', ['--vanilla', PROBE_R]);
if (rs.code !== 0) {
  skip(`Rscript 跑不起来（${rs.err.slice(0, 120)}）—— 整轴跳过`);
  process.exit(0);
}
const want = table('尺子 Rscript', probeLines(rs));
if (want === null) process.exit(1);
ok('尺子 Rscript', `${want.size} 格`);

/* ---- 2. 摊平没改数：cc 编的那一份与 Rscript 逐字节 ------------------------- */

const ccIncs = INCS.flatMap((d) => ['-I', d]);
const BIN = join(ROOT, '.omni-cache/r-rt/js/nmath-cc');
const cc = sh(CC, ['-O2', '-std=c99', '-w', ...ccIncs, AMALGAM, '-o', BIN, '-lm']);
if (cc.code !== 0) {
  no('摊平没改数（cc 那一腿）', `编不过：\n${cc.err.slice(0, 800)}`);
} else {
  const ccOut = probeLines(sh(BIN, []));
  if (ccOut === probeLines(rs)) ok('摊平没改数', `cc 编的那一份与 Rscript 逐字节相同（${N_LINES} 行）`);
  else no('摊平没改数', firstDiff(probeLines(rs), ccOut));
}

/* ---- 3. 我们自己那两条腿 --------------------------------------------------- */

const ourIncs = INCS.flatMap((d) => ['-I', d]);
const interp = sh('node', [CLI, 'c-run', AMALGAM, ...ourIncs]);
if (interp.code !== 0) no('解释腿', `退出码 ${interp.code}\n${interp.err.slice(0, 600)}`);
const js = sh('node', [CLI, 'run', AMALGAM, '--backend', 'js', ...ourIncs]);
if (js.code !== 0) no('JS 腿', `退出码 ${js.code}\n${js.err.slice(0, 600)}`);

const iText = probeLines(interp);
const jText = probeLines(js);
const got = table('JS 腿', jText);
if (table('解释腿', iText) === null || got === null) process.exit(1);
ok('解释腿', `${N_LINES} 行`);
ok('JS 腿', `${N_LINES} 行 —— R 的 nmath 跑成了 JS`);

if (iText === jText) ok('解释腿 == JS 腿', '逐字节相同');
else no('解释腿 == JS 腿', firstDiff(iText, jText));

/* ---- 4. 与 Rscript 的差有上界 ---------------------------------------------- */

let worst = 0;
let worstAt = '';
let exact = 0;
const over = [];
for (const [k, v] of want) {
  const w = got.get(k);
  if (w === undefined) { over.push(`${k}：JS 腿没有这一格`); continue; }
  if (w === v) { exact += 1; continue; }
  const d = Math.abs(w - v);
  const e = Math.min(d, Math.abs(v) === 0 ? d : d / Math.abs(v));
  if (e > worst) { worst = e; worstAt = k; }
  if (e > MAX_ERR) over.push(`${k}：R=${v} 我们=${w} 误差=${e.toExponential(2)}`);
}
if (over.length > 0) no('与 Rscript 的差有上界', over.join('\n       '));
else ok('与 Rscript 的差有上界', `最大 ${worst.toExponential(2)} 在 ${worstAt}`
  + `（上界 ${MAX_ERR.toExponential(0)}），逐位相同 ${exact}/${want.size}`);

/* ---- 5. runif 那三格要逐位相同 -------------------------------------------- */

const rngBad = [];
for (let i = 1; i <= RNG_N_UNIF; i++) {
  const k = `runif${i}`;
  if (got.get(k) !== want.get(k)) rngBad.push(`${k}：R=${want.get(k)} 我们=${got.get(k)}`);
}
if (rngBad.length > 0) {
  no('runif 逐位相同', `MT19937 是纯整数运算 —— 这儿不同就是线性内存里那 625 格状态搬错了\n       ${rngBad.join('\n       ')}`);
} else {
  ok('runif 逐位相同', `set.seed(42) 之后 ${RNG_N_UNIF} 格，与 R 同一条流`);
}

/* ---- 6. 画图那一格：R 的 C 在 JS 腿上画出一张真图 ----------------------- */

const PLOT_BIN = join(ROOT, '.omni-cache/r-rt/js/plot-cc');
const ccPlot = sh(CC, ['-O2', '-std=c99', '-w', ...ccIncs, PLOT_C, '-o', PLOT_BIN, '-lm']);
if (ccPlot.code !== 0) {
  no('画图（cc 腿）', `编不过：\n${ccPlot.err.slice(0, 600)}`);
} else {
  const ccSvg = sh(PLOT_BIN, []).out;
  const jsSvg = sh('node', [CLI, 'run', PLOT_C, '--backend', 'js', ...ourIncs]).out;
  const ipSvg = sh('node', [CLI, 'c-run', PLOT_C, ...ourIncs]).out;
  const pts = [...ccSvg.matchAll(/points="([^"]+)"/g)].map((m) => m[1]);
  /* 先判"是不是一张图" —— 空输出不许冒充"三条腿一致"。 */
  if (!ccSvg.startsWith('<svg ') || !ccSvg.trimEnd().endsWith('</svg>')
      || pts.length !== 2 || pts.some((p) => p.split(' ').length !== PLOT.n)) {
    no('画图', `不像一张图：${ccSvg.length} 字节，${pts.length} 条曲线`
      + `${pts.map((p) => `/${p.split(' ').length} 点`).join('')}`);
  } else {
    ok('画图', `${ccSvg.length} 字节的 SVG，两条曲线各 ${PLOT.n} 点`);
    if (jsSvg === ccSvg && ipSvg === ccSvg) ok('三条腿画的是同一张图', '逐字节相同');
    else no('三条腿画的是同一张图', firstDiff(ccSvg, jsSvg === ccSvg ? ipSvg : jsSvg));

    /* 尺子只给两条曲线的点串（不重写一遍 SVG 骨架 —— 那会飘）。 */
    const rp = sh('Rscript', ['--vanilla', PLOT_R]).out.trim().split('\n').map((s) => s.trim());
    if (rp.length !== 2 || rp.some((s) => s.length === 0)) {
      no('曲线上的点与 R 逐字节相同', `尺子给了 ${rp.length} 行`);
    } else if (rp[0] === pts[0] && rp[1] === pts[1]) {
      ok('曲线上的点与 R 逐字节相同', `dnorm 与 dt 各 ${PLOT.n} 点（坐标印到三位小数）`);
    } else {
      const i = rp[0] === pts[0] ? 1 : 0;
      const a = rp[i].split(' ');
      const b = pts[i].split(' ');
      const k = a.findIndex((v, j) => v !== b[j]);
      no('曲线上的点与 R 逐字节相同', `第 ${i + 1} 条曲线第 ${k + 1} 个点：R=${a[k]} 我们=${b[k]}`);
    }

    /* **真能渲染**：拿本机的光栅器把它变成一张 PNG。没有这个工具就跳过 ——
       它只是"这张 SVG 不是自我感觉良好"的一个旁证，不是这一轴的正本。 */
    const png = join(ROOT, '.omni-cache/r-rt/js/plot-js.svg.png');
    const svgPath = join(ROOT, '.omni-cache/r-rt/js/plot-js.svg');
    writeFileSync(svgPath, jsSvg);
    const ql = sh('qlmanage', ['-t', '-s', String(PLOT.w), '-o', dirname(svgPath), svgPath]);
    if (ql.code !== 0) {
      skip('真能渲染（qlmanage 光栅化）');
    } else if (existsSync(png) && statSync(png).size > 4096) {
      ok('真能渲染', `本机光栅器把它画成了 ${statSync(png).size} 字节的 PNG`);
    } else {
      no('真能渲染', '光栅化出来的 PNG 不像有内容（<= 4096 字节）');
    }
  }
}

/** 第一处不同，带行号。 */
function firstDiff(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return `第 ${i + 1} 行：\n       尺子 ${x[i]}\n       我们 ${y[i]}`;
  }
  return '（长度不同但每一行都一样？）';
}

process.stdout.write(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);

