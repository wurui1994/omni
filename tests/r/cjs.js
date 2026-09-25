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

import { spawnSync, execFile as execFileCb } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  generate, AMALGAM, PROBE_R, PLOT_C, PLOT_R, PLOT, PLOT_FLAT,
  FRAME_C, FRAME_PNG, DEV_C, DEV_PNG,
  INCS, PROBES, RNG_N_UNIF, RNG_N_NORM,
} from '../../ext/r/cjs/gen.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(ROOT, 'src/cli.js');
const CC = process.env.OMNI_CLANG ?? process.env.CC ?? 'clang';
const execFile = promisify(execFileCb);
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
const sh = (cmd, args, extraEnv = undefined) => {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: 600000,
    cwd: ROOT,
    env: extraEnv === undefined ? process.env : { ...process.env, ...extraEnv },
  });
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

/* ---- 7. 真设备那一格：程序调宿主的画笔，交出一帧 ------------------------- */

{
  /* 两条腿各交一帧，中间把文件挪走 —— 不然第二趟看到的可能是第一趟留下的。 */
  const one = (args) => {
    if (existsSync(FRAME_PNG)) rmSync(FRAME_PNG);
    const r = sh('node', [CLI, ...args, ...ourIncs]);
    const line = r.out.split('\n').find((l) => l.startsWith('#gfx ')) ?? '';
    return { line, png: existsSync(FRAME_PNG) ? readFileSync(FRAME_PNG) : null, err: r.err };
  };
  const ip = one(['c-run', FRAME_C]);
  const jsF = one(['run', FRAME_C, '--backend', 'js']);
  const wantLine = `#gfx png ${FRAME_PNG} ${PLOT.w} ${PLOT.h}`;
  if (jsF.png === null) {
    no('交帧（JS 腿）', `没出 PNG\n${jsF.err.slice(0, 400)}`);
  } else if (jsF.line !== wantLine) {
    no('交帧（JS 腿）', `指针那一行不对：\n       要 ${wantLine}\n       给 ${jsF.line}`);
  } else if (jsF.png.length < 10000 || jsF.png.subarray(1, 4).toString('latin1') !== 'PNG') {
    no('交帧（JS 腿）', `不像一张 PNG：${jsF.png.length} 字节`);
  } else {
    ok('交帧（JS 腿）', `omni_c_gfx_frame 出了 ${jsF.png.length} 字节的 PNG，`
      + `stdout 上那行 #gfx 指得对`);
    if (ip.png !== null && ip.png.equals(jsF.png)) ok('两条腿交的是同一帧', '两张 PNG 逐字节相同');
    else no('两条腿交的是同一帧', `解释腿 ${ip.png === null ? '没出 PNG' : `${ip.png.length} 字节`}，JS 腿 ${jsF.png.length} 字节`);
  }
}

/* ---- 8. 实时那一档：设备自己的笔 ---------------------------------------- */

{
  /* 尺寸与落点走环境（`host/gfx-cpu.js` 的 `need` 与 `outPath` 读这三格）——
     浏览器里这两样由 canvas 与页面决定，所以 C 那边是问 `xres`/`yres` 来的。 */
  const devEnv = { OMNI_GFX_W: String(PLOT.w), OMNI_GFX_H: String(PLOT.h), OMNI_GFX_OUT: DEV_PNG };
  const one = (args) => {
    if (existsSync(DEV_PNG)) rmSync(DEV_PNG);
    const r = sh('node', [CLI, ...args, ...ourIncs], devEnv);
    return {
      out: r.out, err: r.err,
      png: existsSync(DEV_PNG) ? readFileSync(DEV_PNG) : null,
    };
  };
  const ipD = one(['c-run', DEV_C]);
  const jsD = one(['run', DEV_C, '--backend', 'js']);
  const wantLine = `#gfx png ${DEV_PNG} ${PLOT.w} ${PLOT.h}`;
  if (jsD.png === null) {
    no('设备自己的笔（JS 腿）', `没出 PNG\n${jsD.err.slice(0, 500)}`);
  } else if (!jsD.out.includes(wantLine) || !jsD.out.includes(`dev ${PLOT.w}x${PLOT.h}`)) {
    no('设备自己的笔（JS 腿）', `输出不对：\n${jsD.out.slice(0, 400)}`);
  } else {
    ok('设备自己的笔（JS 腿）', `cls/setcol/moveto/lineto/refresh 打到 __OMNI_GFX，`
      + `出 ${jsD.png.length} 字节的 PNG（${PLOT.w}x${PLOT.h}，尺寸是问设备要的）`);
    if (ipD.png !== null && ipD.png.equals(jsD.png)) ok('两条腿画的是同一帧', '两张 PNG 逐字节相同');
    else no('两条腿画的是同一帧', `解释腿 ${ipD.png === null ? '没出 PNG' : `${ipD.png.length} 字节`}`);
  }
}

/* ---- 9. 浏览器那条腿：同一份 C，同一张图 -------------------------------- */

/**
 * 这一节把"R 的 C 在浏览器里画图"从**说得通**变成**跑过了**。
 *
 * 三件事凑齐才可能：
 *   1. `omni c cpp` 把驱动二连 R 那 120 份源码与 SDK 的头全展开成**一份 550 KB 的 `.c`**
 *      —— 浏览器那条腿的文件系统是内存里一张表，它装不下 r-source，但装得下这一份；
 *   2. 单体 HTML（`tools/bundle-studio.mjs`）里那份编译器**自带 C 前端**；
 *   3. `/api/file` PUT 能把一份源码写进那张内存表（Studio 自己"存了再跑"就是这条路）。
 *
 * 壳子照 `tests/studio/run.js` 第 3 节那一招：把内联的那段 JS 抠出来、前面塞一格
 * `window`，于是 **node 跑的就是页面上要跑的那份代码**。真浏览器那一层由
 * `tests/studio/run.js` 第 4 节管（那儿有 playwright），这儿不重复造。
 *
 * 判的是**逐字节**：同一份 C，在本地 JS 腿与浏览器腿上画出来的 SVG 要一模一样。
 */
{
  const bundle = join(ROOT, '.omni-cache/work/studio-judge/omni-studio.html');
  const flatSrc = sh('node', [CLI, 'c', 'cpp', PLOT_C, ...ourIncs]);
  if (flatSrc.code !== 0 || flatSrc.out.length < 100000) {
    no('摊平预处理（c cpp）', `${flatSrc.code}：${flatSrc.err.slice(0, 300)}`);
  } else {
    writeFileSync(PLOT_FLAT, flatSrc.out);
    /* 先证这一份自足：**一个 `-I` 都不给**，画出来的图要与原件逐字节相同。 */
    const flatOut = sh('node', [CLI, 'run', PLOT_FLAT, '--backend', 'js']);
    const jsSvg = sh('node', [CLI, 'run', PLOT_C, '--backend', 'js', ...ourIncs]).out;
    if (flatOut.out !== jsSvg) {
      no('摊平预处理（c cpp）', firstDiff(jsSvg, flatOut.out));
    } else {
      ok('摊平预处理（c cpp）', `${flatSrc.out.length} 字节的自足 .c（不要任何 -I），画的是同一张图`);
      if (!existsSync(bundle)) {
        skip('浏览器那条腿（单体 HTML 还没拼：node tools/bundle-studio.mjs -o '
          + '.omni-cache/work/studio-judge/omni-studio.html）');
      } else {
        const html = readFileSync(bundle, 'utf8');
        const a = html.indexOf('<script type="module">') + '<script type="module">'.length;
        const b = html.indexOf('</script>', a);
        const shellPath = join(ROOT, '.omni-cache/r-rt/js/browser-shell.mjs');
        writeFileSync(shellPath,
          'globalThis.window = globalThis;\n'
          + `${html.slice(a, b)}\n`
          + 'const src = await import("node:fs").then((m) => m.readFileSync(process.argv[2], "utf8"));\n'
          /* 先写进内存里那张表（Studio 的"存"就是这一条），再按路径跑它。 */
          + 'await window.__OMNI_LOCAL("/api/file", { method: "PUT",\n'
          + '  body: JSON.stringify({ path: "r-nmath-plot.c", text: src }) });\n'
          + 'const r = await window.__OMNI_LOCAL("/api/run",\n'
          /* **`--backend js` 要明说**：`run x.c` 的缺省是原生那条路（编 + 链 + 跑），
             而页面上没有链接器也没有 libc —— 不给这个开关，报的是 `elf: 找不到库 -lc`。 */
          + '  { body: JSON.stringify({ argv: ["run", "r-nmath-plot.c", "--backend", "js"] }) });\n'
          + 'process.stdout.write(r.stdout);\n'
          + 'process.stderr.write(r.stderr);\n');
        const got = sh('node', [shellPath, PLOT_FLAT]);
        if (got.out === jsSvg) {
          ok('浏览器那条腿上是同一张图', `${got.out.length} 字节，逐字节相同`
            + '（R 的 nmath 编成 JS，在页面那份编译器里跑）');
        } else {
          no('浏览器那条腿上是同一张图', got.out.length === 0
            ? `没有输出：${got.err.slice(0, 500)}` : firstDiff(jsSvg, got.out));
        }
        await realBrowser(bundle, jsSvg);
      }
    }
  }
}

/**
 * **真浏览器那一趟**（`tests/studio/run.js` 第 4 节同一条路：静态服务 + `playwright-cli`）。
 *
 * 为什么 node 壳子不够：上一节那一趟在 node 上跑，`process` 是有的；页面上没有。
 * 那一类红（`process is not defined`）只有真浏览器里才现形，而那一节看不见它。
 * 这一趟额外判"控制台一条错都没有" —— 白屏是静默的。
 *
 * 没装 `playwright-cli` 就明着跳过（它是台机器上的工具，不在仓库依赖里）。
 */
async function realBrowser(bundle, want) {
  const r = sh('playwright-cli', ['--version']);
  if (r.code !== 0) { skip('真浏览器那一趟（这台机器上没有 playwright-cli）'); return; }
  const work = join(ROOT, '.omni-cache/work/r-cjs-browser');
  mkdirSync(work, { recursive: true });
  copyFileSync(bundle, join(work, 'omni-studio.html'));
  copyFileSync(PLOT_FLAT, join(work, 'r-nmath-plot.c'));
  const srv = createServer((req, res) => {
    const rel = req.url.split('?')[0].replace(/^\//, '');
    try {
      const body = readFileSync(join(work, rel));
      /* **`.html` 必须报 `text/html`**：报成 `text/plain` 浏览器就把它当源码显示，
         `playwright-cli goto` 于是失败（第一版就是这么红的）。 */
      res.writeHead(200, { 'content-type': rel.endsWith('.html') ? 'text/html' : 'text/plain' });
      res.end(body);
    } catch { res.writeHead(404); res.end('no'); }
  });
  await new Promise((done) => srv.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${srv.address().port}/omni-studio.html`;
  const S = '-s=r-cjs-judge';
  /* **必须异步**：静态服务就在这个进程里，同步等子进程会把事件循环挡死，
     页面一个字节都收不到（`tests/studio/run.js` 上撞过一次）。 */
  const pw = async (args) => (await execFile('playwright-cli', args,
    { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 })).stdout;
  try {
    try { await pw([S, 'open', url]); } catch { /* 同名会话已经开着也行 */ }
    await pw([S, 'goto', url]);
    const con = await pw([S, 'console', 'error']);
    if (/Errors: 0/.test(con)) ok('真浏览器里控制台一条错都没有');
    else no('真浏览器里控制台一条错都没有', con.trim().slice(0, 300));
    /* 那份 550 KB 的 C 从同源取回来，PUT 进内存表，再按路径跑。 */
    const probe = 'async () => {'
      + ' const src = await (await fetch("r-nmath-plot.c")).text();'
      + ' await window.__OMNI_LOCAL("/api/file", { method: "PUT",'
      + '   body: JSON.stringify({ path: "r-nmath-plot.c", text: src }) });'
      + ' const r = await window.__OMNI_LOCAL("/api/run", { body: JSON.stringify({'
      + '   argv: ["run", "r-nmath-plot.c", "--backend", "js"] }) });'
      + ' return { n: src.length, o: r.stdout, e: (r.stderr || "").slice(0, 300), code: r.code }; }';
    const g = JSON.parse(await pw([S, '--raw', 'eval', probe]));
    if (g.o === want && g.code === 0) {
      ok('真浏览器里画的是同一张图', `${g.n} 字节的 C -> ${g.o.length} 字节的 SVG，逐字节相同`);
    } else {
      no('真浏览器里画的是同一张图', `code=${g.code} err=${JSON.stringify(g.e)}\n       `
        + (g.o === undefined || g.o === '' ? '没有输出' : firstDiff(want, g.o)));
    }
  } catch (e) {
    no('真浏览器那一趟', String(e instanceof Error ? e.message : e).slice(0, 400));
  } finally {
    srv.close();
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

