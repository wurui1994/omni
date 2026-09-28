#!/usr/bin/env node
// Omni — R 的**整个运行时**过我们自己的 C 前端（ADR-0047 的 JS 路径）
//
// 不停在 nmath：`src/main`（99 份）+ `src/appl` + `src/unix` 一份一份编成 MIR
// （`tu` 档 —— `main` 不是必须的、堆不烤进像里），看有多少份过得去。
//
// 判据是**一个地板**：编过的份数只许涨。为什么是地板而不是"全过" ——
// 剩下那几份卡的是真缺的本事（外部函数按值收发 struct 要真 ABI、几处 GNU 扩展），
// 一刀一刀补；而"不许跌"这件事现在就能守住，它防的是"补了新的、碰坏了老的"。
//
// 这条轴**不跑**那些产物（跑要先把 libR 那一套接上，那是后面的刀），只判"编得过"
// 与"**链得起到什么程度**"：第二节把 nmath / tre / xdr / tzone 一起编进来建符号表，
// 重名、硬缺（数据与桩）、软缺（libc 也没有的那些）四个数记成天花板与地板。
// 编不过的按**错的那一类**归拢印出来 —— 下一刀要挑哪一类，看这张表就够。
//
//   node tests/r/rtc.js
//   node tests/r/rtc.js -v      # 连每一份的成败一起印

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cMir, cJsModules, cJsEntry } from '../../src/core/lang/c.js';
import { hasLibc } from '../../src/core/interp/libc.js';
import { refDir } from '../lib/refsrc.js';

const CC = process.env.OMNI_CLANG ?? process.env.CC ?? 'clang';

/** 复数那一格的驱动：一行一格 `名字<制表符>实部<制表符>虚部`，含 Inf/NaN 那几个边角。 */
const CX_DRV = `int printf(const char*, ...);
double _Complex __muldc3(double, double, double, double);
double _Complex __divdc3(double, double, double, double);
double creal(double _Complex);
double cimag(double _Complex);
double cabs(double _Complex);
double carg(double _Complex);
double _Complex conj(double _Complex);

/* div 在 ext/r/rt/omni_libc.c 里：按值回一个两格 struct —— 这一格顺手判
   "跨模块按值回 struct"这条路（R 的 printarray.c 要它）。 */
typedef struct { int quot; int rem; } omni_div_t;
omni_div_t div(int, int);

static void show(const char *tag, double _Complex z) {
  printf("%s\\t%.17g\\t%.17g\\n", tag, creal(z), cimag(z));
}

int main(void) {
  show("mul", __muldc3(1.5, 2.0, 0.5, -1.0));
  show("div", __divdc3(1.5, 2.0, 0.5, -1.0));
  show("conj", conj(__muldc3(3.0, -4.0, 1.0, 0.0)));
  printf("cabs\\t%.17g\\n", cabs(__muldc3(3.0, 4.0, 1.0, 0.0)));
  printf("carg\\t%.17g\\n", carg(__muldc3(0.0, 1.0, 1.0, 0.0)));
  double inf = 1.0 / 0.0;
  show("inf-mul", __muldc3(inf, 0.0, 2.0, 0.0));
  show("inf-div", __divdc3(inf, 0.0, 2.0, 0.0));
  show("zero-div", __divdc3(1.0, 1.0, 0.0, 0.0));
  show("big-div", __divdc3(1e300, 1e300, 1e300, 1e300));
  omni_div_t d1 = div(17, 5);
  omni_div_t d2 = div(-17, 5);
  printf("div\\t%d\\t%d\\t%d\\t%d\\n", d1.quot, d1.rem, d2.quot, d2.rem);
  return (int)(creal(__muldc3(1.5, 2.0, 0.5, -1.0)) * 2);
}
`;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 超越那一族的驱动（第十八格）：13 个函数 × 12 个点，一行一格
 * `函数(x,y)<制表符>实部<制表符>虚部`。
 *
 * 这一份**只按原型调**（不 `#include <complex.h>`），于是同一份 C 两条腿都能编：
 * 我们那条链 `ext/r/rt/omni_complex.c`，尺子那条链**平台的 libm**。
 */
const CX2_DRV = `int printf(const char*, ...);
double creal(double _Complex);
double cimag(double _Complex);
double _Complex cexp(double _Complex);
double _Complex clog(double _Complex);
double _Complex csqrt(double _Complex);
double _Complex cpow(double _Complex, double _Complex);
double _Complex csin(double _Complex);
double _Complex ccos(double _Complex);
double _Complex ctan(double _Complex);
double _Complex csinh(double _Complex);
double _Complex ccosh(double _Complex);
double _Complex ctanh(double _Complex);
double _Complex casin(double _Complex);
double _Complex cacos(double _Complex);
double _Complex catan(double _Complex);

static double _Complex mk(double r, double i) {
  double _Complex z = r;
  __imag__ z = i;
  return z;
}

static void show(const char *tag, double x, double y, double _Complex v) {
  printf("%s(%.17g,%.17g)\\t%.17g\\t%.17g\\n", tag, x, y, creal(v), cimag(v));
}

static const double PTS[][2] = {
  { 0.5, 0.25 }, { 1.5, -2.0 }, { -3.0, 0.75 }, { 0.75, 0.0 }, { 0.0, 0.75 },
  { -1.0, 0.0 }, { 1e-8, 1e-8 }, { 2.0, 40.0 }, { 100.0, 0.5 }, { -0.5, -0.5 },
  { 1e10, 1e-10 }, { 1.0, 1.0 },
};

int main(void) {
  int i;
  for (i = 0; i < 12; i++) {
    double x = PTS[i][0];
    double y = PTS[i][1];
    double _Complex z = mk(x, y);
    show("cexp", x, y, cexp(z));
    show("clog", x, y, clog(z));
    show("csqrt", x, y, csqrt(z));
    show("cpow", x, y, cpow(z, mk(0.5, 0.25)));
    show("csin", x, y, csin(z));
    show("ccos", x, y, ccos(z));
    show("ctan", x, y, ctan(z));
    show("csinh", x, y, csinh(z));
    show("ccosh", x, y, ccosh(z));
    show("ctanh", x, y, ctanh(z));
    show("casin", x, y, casin(z));
    show("cacos", x, y, cacos(z));
    show("catan", x, y, catan(z));
  }
  return 0;
}
`;const RSRC = refDir('r-source', 'R_SRC');
/** `ext/r/build-libR.js` 生成的那几份头（config.h / Rconfig.h / Rversion.h / Rmath.h）。 */
const GEN = join(ROOT, '.omni-cache', 'r-rt', 'libR');
const INCS = [GEN, join(RSRC, 'src/include'), join(RSRC, 'src/nmath'), join(RSRC, 'src/extra'),
  join(RSRC, 'src/main'), join(RSRC, 'src/unix'), '/opt/homebrew/include'];
const DEFS = [['HAVE_CONFIG_H', '1']];
const verbose = process.argv.includes('-v');
/** 只跑某一节：`rt`（编 + 符号表）/ `cx`（逐字节那一格）/ `cx2`（超越那一族）。
 *  省得改一行公式就要重编 248 份 —— 那一趟 55 秒。 */
const only = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? null;
const want = (n) => only === null || only === n;

/**
 * 编过的份数**只许涨**。量出来的这几格（2026-09-27 一天之内）：
 *   * `_Complex` 当布局收下之前 **0/111**（`R_ext/Complex.h` 一行挡住 107 份）；
 *   * 那一刀之后 **90/111**；
 *   * "按值收发 struct 的外部函数不发桩、等链接" **103/111**；
 *   * 宽字符常量进常量表达式（`case L'%':`）**105/111**；自带 `<stdalign.h>` **106/111**；
 *   * `extern T x[];` 那一对（长度后补 / 占位地址）**108/111**；
 *   * 复数算术（前端逐分量 + `__muldc3`/`__divdc3` 自己用 C 写）**110/111**；
 *   * 语句表达式里的计算跳转（R 的 `NEXT()`）**111/111** —— 全份编得过。
 */
const FLOOR = 111;


let pass = 0;
let fail = 0;
const ok = (s, extra = '') => { pass += 1; process.stdout.write(`  ok   ${s}${extra === '' ? '' : ` [${extra}]`}\n`); };
const no = (s, why) => { fail += 1; process.stdout.write(`  FAIL ${s}\n       ${String(why).slice(0, 600)}\n`); };

if (!existsSync(join(RSRC, 'src/main/Makefile.in')) || !existsSync(join(GEN, 'config.h'))) {
  process.stdout.write(`  skip 整组：参考树或生成出来的头不在（${GEN}）\n`
    + '       建它：node ext/r/build-libR.js\n');
  process.exit(0);
}

/** 读一格 make 变量（续行接起来）。名单的唯一出处是 R 自己的 Makefile.in。 */
function mkVar(path, name) {
  const text = readFileSync(path, 'utf8');
  const m = new RegExp(`^${name}\\s*=([\\s\\S]*?)\\n[A-Za-z_@]`, 'm').exec(text);
  if (m === null) throw new Error(`${path}: 没有 ${name}`);
  return m[1].replace(/\\\n/g, ' ').trim().split(/\s+/).filter((s) => s.endsWith('.c'));
}

const groups = [
  ['main', 'src/main', mkVar(join(RSRC, 'src/main/Makefile.in'), 'SOURCES_C'), true],
  ['appl', 'src/appl', mkVar(join(RSRC, 'src/appl/Makefile.in'), 'SOURCES_C'), true],
  ['unix', 'src/unix', mkVar(join(RSRC, 'src/unix/Makefile.in'), 'SOURCES_C_BASE'), true],
  /* 这四组是**同一个运行时的别处**（第十八格）：nmath 那 123 份走过 `tests/r/cjs.js`，
     tre / xdr / tzone 是 R 自己带在树里的正则、XDR 与时区 —— 它们提供的正是
     `main` 那边缺的 `tre_*` / `xdr_*`。判据在下面"符号表闭合到什么程度"那一节。 */
  ['nmath', 'src/nmath', mkVar(join(RSRC, 'src/nmath/Makefile.in'), 'SOURCES'), false],
  ['tre', 'src/extra/tre', mkVar(join(RSRC, 'src/extra/tre/Makefile.in'), 'SOURCES'), false],
  ['xdr', 'src/extra/xdr', mkVar(join(RSRC, 'src/extra/xdr/Makefile.in'), 'SOURCES'), false],
  ['tzone', 'src/extra/tzone', mkVar(join(RSRC, 'src/extra/tzone/Makefile.in'), 'SOURCES'), false],
];
/** 我们自己那两份也进符号表 —— 复数那 20 个桩与 `div` 就是它们来接的。 */
const OURS = [['omni', join(ROOT, 'ext/r/rt'), ['omni_complex.c', 'omni_libc.c', 'omni_rhost.c'], false]];

const fails = [];
/** 编出来的留着 —— 下面那一节要拿它们建符号表（"链接"就是这一步）。 */
const mods = [];
let okN = 0;
let funcs = 0;
for (const [label, dir, names, core] of (want('rt') ? [...groups, ...OURS] : [])) {
  for (const n of names) {
    try {
      const path = dir.startsWith('/') ? join(dir, n) : join(RSRC, dir, n);
      const mod = cMir(path, INCS, DEFS, [], undefined, undefined, { tu: true });
      mods.push({ tag: `${label}/${n}`, out: `${label}/${n}.mjs`, mir: mod });
      if (core) { okN += 1; funcs += mod.funcs.length; }
      if (verbose) process.stdout.write(`       ok   ${label}/${n}\n`);
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e).split('\n')[0];
      fails.push([`${label}/${n}`, msg]);
      if (verbose) process.stdout.write(`       FAIL ${label}/${n}: ${msg.slice(0, 140)}\n`);
    }
  }
}
const total = okN + fails.filter(([f]) => /^(main|appl|unix)\//.test(f)).length;

if (!want('rt')) {
  /* 这一节没跑，下面两节各自独立 */
} else if (okN < FLOOR) {
  no(`R 运行时编得过的份数（地板 ${FLOOR}）`, `这一趟只有 ${okN}/${total} ——`
    + `掉了 ${FLOOR - okN} 份。掉下去的那几份：\n       `
    + fails.map(([f, m]) => `${f}: ${m.slice(0, 120)}`).join('\n       ').slice(0, 2000));
} else {
  ok('R 运行时编得过的份数', `${okN}/${total} 份（地板 ${FLOOR}），共 ${funcs} 个函数`);
}

/* 剩下那几份按"错的那一类"归拢 —— 这张表就是下一刀的选题单。 */
const kinds = new Map();
for (const [, msg] of fails) {
  const k = msg.replace(/^.*?:\d+:\d+:\s*/, '').replace(/^.*?:\d+:\s*/, '')
    .replace(/'[^']*'/g, "'…'").slice(0, 90);
  kinds.set(k, (kinds.get(k) ?? 0) + 1);
}
if (kinds.size > 0) {
  process.stdout.write(`       还没过的 ${fails.length} 份按类：\n`);
  for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`         ${String(n).padStart(3)}  ${k}\n`);
  }
}

/* ---- 符号表闭合到什么程度（第十八格）----------------------------------------
 *
 * "编得过"之后的下一问是"**链得起**"。这一节照 `cJsModules` 那三步里的第二步建符号表
 * （谁定义了哪个名字），然后把缺口分成三类量出来 —— 四个数，三个天花板一个地板：
 *
 *   * **重名必须 0**：同一个名字两份都定义，ESM 那条路上没有"先到先得"可赖。
 *   * **硬缺·数据**：谁也没定义而又被 data 段引用。这类**不能**转手给宿主 ——
 *     放过去会得到一个指着自己那块空白的指针（静默答错）。
 *   * **硬缺·桩**：按值收发 struct 的外部函数（`tu` 档不发身子，见 `externThunk`）。
 *     它转不了手给宿主，只能由别的模块提供 —— 复数那一族就在这儿。
 *   * **软缺**：真发了 `CCALL`（口径是 `mir.cabi`，光声明没调的不算）而没人定义的。
 *     这些现在落到宿主的 `callLibc`；其中**我们的 libc 也没有**的那些才是功能映射的工单
 *     （BLAS 的 `d*_`、zlib、iconv、pthread/Mach、`xdr_*` 那几族）。
 *
 * 天花板只许降、地板只许涨。这两条合起来就是"这一套离链得起还差多少"的唯一口径。
 */
const CEIL = { dup: 0, data: 0, thunk: 0, libc: 195 };
const SYMS_FLOOR = 2562;
if (want('rt')) {
  const provide = new Map();
  const dups = [];
  for (const m of mods) {
    const claim = (name) => {
      const had = provide.get(name);
      if (had !== undefined && had !== m.out) dups.push(`${name}（${had} 与 ${m.out}）`);
      else provide.set(name, m.out);
    };
    for (const f of m.mir.funcs) {
      if (f.local === true) continue;
      if (f.thunk !== null && f.thunk !== undefined) continue;
      if (f.count() === 0) continue;
      if (f.name === m.mir.entry) continue;
      claim(f.name);
    }
    for (const [sym] of m.mir.dataSyms) claim(sym);
  }
  const missData = new Set();
  const missThunk = new Set();
  const missLibc = new Set();
  let missCall = 0;
  for (const m of mods) {
    for (const r of m.mir.dataRefs) if (!provide.has(r.name)) missData.add(r.name);
    for (const f of m.mir.funcs) {
      if (f.extern !== true) continue;
      const nm = f.thunk === null || f.thunk === undefined ? f.name : f.thunk;
      if (!provide.has(nm)) missThunk.add(nm);
    }
    for (const nm of m.mir.cabi) {
      if (provide.has(nm)) continue;
      missCall += 1;
      if (!hasLibc(nm)) missLibc.add(nm);
    }
  }
  const show = (s) => [...s].sort().join('、');
  const bad = [];
  if (dups.length > CEIL.dup) bad.push(`重名 ${dups.length} 个（天花板 ${CEIL.dup}）：${dups.slice(0, 8).join('、')}`);
  if (missData.size > CEIL.data) bad.push(`硬缺·数据 ${missData.size} 个（天花板 ${CEIL.data}）：${show(missData)}`);
  if (missThunk.size > CEIL.thunk) bad.push(`硬缺·桩 ${missThunk.size} 个（天花板 ${CEIL.thunk}）：${show(missThunk)}`);
  if (missLibc.size > CEIL.libc) bad.push(`libc 也没有的 ${missLibc.size} 个（天花板 ${CEIL.libc}）`);
  if (provide.size < SYMS_FLOOR) bad.push(`对外符号只有 ${provide.size} 个（地板 ${SYMS_FLOOR}）`);
  if (bad.length > 0) {
    no('符号表闭合（重名 / 硬缺 / 软缺）', bad.join('\n       '));
  } else {
    ok('符号表闭合', `${mods.length} 份、对外符号 ${provide.size} 个、重名 ${dups.length}；`
      + `硬缺 数据 ${missData.size}（${show(missData)}）+ 桩 ${missThunk.size}（${show(missThunk)}）；`
      + `软缺 ${missLibc.size} 个 libc 也没有`);
  }
}

/* ---- 我们自己写的那份复数运行时（`ext/r/rt/omni_complex.c`） -------------------
 *
 * R 的复数乘除就是 C99 的运算符，而 clang 把它们发成 `__muldc3` / `__divdc3` ——
 * 那两个里头有 Smith 算法与 Inf 回收。前端手写朴素公式在 Inf/NaN 上就是**静默答错**，
 * 所以那两个由这一份 C 提供（照 compiler-rt 的算法），一份 .c 一份 .js 编进模块集。
 *
 * 判据：与 **clang 编同两份文件**的 stdout 逐字节相同。clang 那边要
 * `-ffp-contract=off` —— 它默认把 `a*c + b*d` 收成一条 FMA，那条路上的最后几位与
 * 我们这条（分开的乘加）不一样，而这一格判的是**算法**，不是"谁的 FMA"。
 */
if (want('cx')) {
  const dir = join(ROOT, '.omni-cache', 'test', 'r-rtc');
  mkdirSync(dir, { recursive: true });
  const drv = join(dir, 'cx-drv.c');
  writeFileSync(drv, CX_DRV);
  const CX = join(ROOT, 'ext', 'r', 'rt', 'omni_complex.c');
  const LC = join(ROOT, 'ext', 'r', 'rt', 'omni_libc.c');
  let ours = null;
  try {
    const linked = cJsModules([
      { path: CX, out: join(dir, 'omni_complex.mjs') },
      { path: LC, out: join(dir, 'omni_libc.mjs') },
      { path: drv, out: join(dir, 'cx-drv.mjs') },
    ], { incs: [], defs: [], rtImport: join(ROOT, 'src/core/mir/js_rt.js') });
    for (const u of linked.units) writeFileSync(u.out, u.text);
    const entry = join(dir, 'cx-main.mjs');
    writeFileSync(entry, cJsEntry(linked));
    const r = spawnSync(process.execPath, [entry], { encoding: 'utf8' });
    ours = { code: r.status, out: r.stdout ?? '', err: (r.stderr ?? '').split('\n')[0] };
  } catch (e) {
    ours = { code: -1, out: '', err: String(e instanceof Error ? e.message : e).slice(0, 300) };
  }
  const bin = join(dir, 'cx-cc.bin');
  const cc = spawnSync(CC, ['-w', '-std=gnu17', '-ffp-contract=off', drv, CX, LC, '-o', bin, '-lm'],
    { encoding: 'utf8' });
  if (cc.status !== 0) {
    process.stdout.write(`  skip 复数运行时（clang 编不过尺子：${(cc.stderr ?? '').split('\n')[0].slice(0, 120)}）\n`);
  } else {
    const r = spawnSync(bin, [], { encoding: 'utf8' });
    const wantOut = `${r.status}\n${r.stdout ?? ''}`;
    const got = `${ours.code}\n${ours.out}`;
    if (got === wantOut && (ours.out.match(/\n/g) ?? []).length >= 10) {
      ok('复数运行时（__muldc3 / __divdc3 / creal / cimag / conj / cabs / carg）+ div',
        `${(ours.out.match(/\n/g) ?? []).length} 行与 clang 逐字节相同（含 Inf/NaN 与跨模块按值回 struct）`);
    } else {
      no('复数运行时 == clang', `我们 code=${ours.code}\n${ours.out}${ours.err ? `       stderr: ${ours.err}\n` : ''}`
        + `       clang code=${r.status}\n${r.stdout ?? ''}`);
    }
  }
}

/* ---- 超越那一族 vs 平台 libm（第十八格）---------------------------------------
 *
 * 这一节与上一节的判据**有意不同**：`__muldc3`/`__divdc3` 是"与 clang 链进去的那份
 * 逐字节相同"，而 `clog`/`csqrt`/`casin` 那 13 个**做不到逐位相同** —— Apple 的 libm
 * 与任何一份公开实现都差最后几位。所以这儿判两件事：
 *
 *   * **每一格的相对误差 <= 记死的上界**（现在 4e-16，约 2 ulp）；
 *   * **分类相同**：谁是 NaN、谁是 Inf、零的符号 —— 这几样不许差。
 *
 * 尺子那条腿只编驱动（链 libm），**不链我们那份 .c** —— 不然就是空对空。
 */
if (want('cx2')) {
  const dir = join(ROOT, '.omni-cache', 'test', 'r-rtc');
  mkdirSync(dir, { recursive: true });
  const drv = join(dir, 'cx2-drv.c');
  writeFileSync(drv, CX2_DRV);
  const CX = join(ROOT, 'ext', 'r', 'rt', 'omni_complex.c');
  const CEIL_REL = 4e-16;
  let ours = null;
  try {
    const linked = cJsModules([
      { path: CX, out: join(dir, 'omni_complex2.mjs') },
      { path: drv, out: join(dir, 'cx2-drv.mjs') },
    ], { incs: [], defs: [], rtImport: join(ROOT, 'src/core/mir/js_rt.js') });
    for (const u of linked.units) writeFileSync(u.out, u.text);
    const entry = join(dir, 'cx2-main.mjs');
    writeFileSync(entry, cJsEntry(linked));
    const r = spawnSync(process.execPath, [entry], { encoding: 'utf8', maxBuffer: 1 << 24 });
    ours = { code: r.status, out: r.stdout ?? '', err: (r.stderr ?? '').split('\n')[0] };
  } catch (e) {
    ours = { code: -1, out: '', err: String(e instanceof Error ? e.message : e).slice(0, 300) };
  }
  const bin = join(dir, 'cx2-cc.bin');
  /* 尺子：**只有驱动** + libm。 */
  const cc = spawnSync(CC, ['-w', '-std=gnu17', drv, '-o', bin, '-lm'], { encoding: 'utf8' });
  if (cc.status !== 0) {
    process.stdout.write(`  skip 超越那一族（clang 编不过尺子：${(cc.stderr ?? '').split('\n')[0].slice(0, 120)}）\n`);
  } else if (ours.code !== 0) {
    no('超越那一族 vs libm', `我们 code=${ours.code} ${ours.err}\n       ${ours.out.slice(0, 400)}`);
  } else {
    const ref = spawnSync(bin, [], { encoding: 'utf8', maxBuffer: 1 << 24 });
    const parse = (s) => new Map(s.trim().split('\n').map((L) => {
      const [tag, re, im] = L.split('\t');
      return [tag, [Number(re), Number(im)]];
    }));
    const A = parse(ours.out);
    const B = parse(ref.stdout ?? '');
    const bad = [];
    let worst = 0;
    let worstTag = '';
    /* 相对误差按**整个复数的模**算，不按分量各自的大小：`ctan(2,40)` 的实部是
       -2.7e-35 而虚部是 1，libm 那边实部直接下溢成 0 —— 按分量算那一格是"差了 100%"，
       按模算是 2.7e-35，后者才是这一族该判的东西。 */
    const cmp = (tag, a, b, scale, which) => {
      if (Number.isNaN(a) !== Number.isNaN(b)
        || (Number.isFinite(a) !== Number.isFinite(b) && !Number.isNaN(a))) {
        bad.push(`${tag} ${which}: 我们 ${a}、libm ${b}（分类不同）`);
        return;
      }
      if (Number.isNaN(a) || a === b) return;
      const rel = Math.abs(a - b) / scale;
      if (rel > worst) { worst = rel; worstTag = `${tag} ${which}`; }
      if (rel > CEIL_REL) bad.push(`${tag} ${which}: 我们 ${a}、libm ${b}（相对差 ${rel.toExponential(2)}）`);
    };
    for (const [tag, [re, im]] of B) {
      const got = A.get(tag);
      if (got === undefined) { bad.push(`${tag}: 我们这边没有这一行`); continue; }
      const scale = Math.max(Math.hypot(re, im), Number.MIN_VALUE);
      cmp(tag, got[0], re, scale, '实部');
      cmp(tag, got[1], im, scale, '虚部');
    }
    if (B.size < 13 * 12) bad.push(`尺子只印了 ${B.size} 行（要 ${13 * 12}）`);
    if (bad.length > 0) {
      no('超越那一族 vs libm', `${bad.length} 格超了上界 ${CEIL_REL.toExponential(0)}：\n       `
        + bad.slice(0, 12).join('\n       '));
    } else {
      ok('超越那一族（cexp/clog/csqrt/cpow/c{sin,cos,tan}{,h}/ca{sin,cos,tan}）',
        `${B.size} 格与 libm 的相对差都 <= ${CEIL_REL.toExponential(0)}，最大 ${worst.toExponential(2)}（${worstTag}）`);
    }
  }
}

/* ---- 全部运行时发成 JS 模块，装起来真调（第十九格）----------------------------
 *
 * 前三节判的是"编得过 / 链得起 / 那几个我们自己写的对不对"。这一节判的是**跑得动**：
 * 250 份 `.c` 发成 250 份 `.mjs`（一份一份，符号靠 `import`/`export`），一遍
 * `$init()` 铺好各自的 data 段，再叫 R 自己的 `Rf_InitArithmetic()` ——
 * `R_PosInf` / `R_NaN` 那几个全局是**运行时**初始化的，libR 档下 `ML_POSINF` 就是它们，
 * 不叫这一句 `pgamma(2,3,1)` 会**静默答 1**（`R_P_bounds_01` 拿 0 当正无穷）。
 *
 * 然后按原型调 10 个纯函数，答案与 `Rscript` 比（相对差 <= 1e-12）。
 * 没有 `Rscript` 就与记死的那一列常数比 —— 常数是上一次与 Rscript 对齐时记下来的。
 */
const JSRUN = [
  ['nmath__dnorm', 'Rf_dnorm4', '0, 0, 1, 0', 'dnorm(0,0,1)', 0.3989422804014327],
  ['nmath__pnorm', 'Rf_pnorm5', '1.96, 0, 1, 1, 0', 'pnorm(1.96)', 0.9750021048517795],
  ['nmath__qnorm', 'Rf_qnorm5', '0.975, 0, 1, 1, 0', 'qnorm(0.975)', 1.959963984540054],
  ['nmath__lgamma', 'Rf_lgammafn', '10', 'lgamma(10)', 12.801827480081469],
  ['nmath__gamma', 'Rf_gammafn', '5.5', 'gamma(5.5)', 52.34277778455352],
  ['nmath__pgamma', 'Rf_pgamma', '2, 3, 1, 1, 0', 'pgamma(2,3,1)', 0.32332358381693654],
  ['nmath__dbinom', 'Rf_dbinom', '3, 10, 0.3, 0', 'dbinom(3,10,0.3)', 0.26682793200000005],
  ['nmath__bessel_j', 'Rf_bessel_j', '1.5, 2', 'besselJ(1.5,2)', 0.2320876721442147],
  ['nmath__beta', 'Rf_beta', '2.5, 3.5', 'beta(2.5,3.5)', 0.036815538909255386],
  ['nmath__choose', 'Rf_choose', '10, 3', 'choose(10,3)', 120],
];
/** R 自己的初始化次序（`main.c` 的 `setup_Rmainloop`，984-999 行）。
 *
 * 次序不是可选的：`InitStringHash` 必须在 `InitNames` 之前、`InitNames` 必须在
 * `InitBaseEnv` 之后（要 `R_EmptyEnv`）、`InitTypeTables` 必须在 `InitS3DefaultTypes`
 * 之前。乱了就**卡死**不是报错 —— 量出来的：少了 `InitStringHash`，`InitNames` 一去不回
 * （`type2char` 拿到空的 `Type2Table` 去 `warning`，`warning` 又去 `install`，
 * 而符号表那一圈这时还没铺好，`install` 就在 `strcmp` 上转圈）。
 *
 * `InitTempDir` 要 `stat`、`InitEd` 要 `getpid` —— 我们的 libc 还没有这两个，
 * 所以那两步明着炸（`ALLOW_FAIL`），不静默跳过。
 */
const INIT_SEQ = ['Rf_InitArithmetic', 'Rf_InitTempDir', 'Rf_InitMemory', 'Rf_InitStringHash',
  'Rf_InitBaseEnv', 'Rf_InitNames', 'InitParser', 'Rf_InitGlobalEnv', 'Rf_InitOptions', 'Rf_InitGraphics',
  'Rf_InitTypeTables', 'Rf_InitS3DefaultTypes', 'R_InitConditions', 'Rf_InitConnections',
  'omni_console_init', 'omni_toplevel_init'];
/** 现在**一步都不许炸**（`InitTempDir` 那一步 2026-09-28 补上 stat/access/mkdtemp/
 *  setenv 之后过了）。留这张表是为了"欠账要记名字"，不是为了放水。 */
const INIT_ALLOW_FAIL = new Set([]);
/** SEXP 那一层：全用 R 自己的 API 兜回来，不读内存（读内存那一路是另一格）。 */
const SEXP_CHECKS = [
  ['str2type(type2char(REALSXP))', 14],
  ['str2type(type2char(VECSXP))', 19],
  ['asReal(ScalarReal(3.5))', 3.5],
  ['asInteger(ScalarInteger(7))', 7],
  ['xlength(allocVector(REALSXP,5))', 5],
];
/** **真跑 R**（第二十一格）：一句 R 进去、一个数出来，与 `Rscript` 比。
 *
 * 挑的都是**不要 base 那个包的 R 代码**的（**原语**）。这条线比想象的细：`sd`/`mean`
 * 是 R 写的没错，而 `nchar`/`paste0` 也是 —— 它们是 base 里的 R 函数，身子只有一句
 * `.Internal(nchar(...))`。所以"C 里有 do_nchar"不等于"这句 R 跑得动"，
 * 要 `R_LoadProfile` 把序列化过的 base 装进来（下一刀）。量出来的：那两句回 -3（R 里报错）。
 * 这张表就是"R 这条腿上现在能跑多少"的量尺，往里加句子是最省的推进方式。
 */
const EVAL_CHECKS = [
  '1+1',
  'sum(1:10)',
  'max(c(3,9,2))',
  'min(c(3,9,2))',
  'length(c(1,2,3,4))',
  'sqrt(2)',
  'exp(1)',
  'abs(-3)',
  'round(2.567, 2)',
  'as.integer("42")',
  'sum(as.numeric(c("1", "2", "3")))',
  'as.numeric("2.5") * 2',
  'if (1 < 2) 10 else 20',
  'x <- 5; x * 3',
  'f <- function(a) a * 2; f(21)',
  'sum(rep(2, 5))',
  'prod(2:5)',
  'sum(seq_len(100))',
  /* 要 base 那个包的 R 代码那几句（`nchar` / `paste0` / `mean` / `sd` / `sapply`）
     **还不在这张表里**：`omni_base_init` 装得动，但装一趟 >50 秒（base 是 1.4 MB 的
     R 源码），判据不许一趟一分钟。速度那一刀之后再进来。 */
];
if (want('jsrun')) {
  const dir = join(ROOT, '.omni-cache', 'r-rt', 'jsall');
  mkdirSync(dir, { recursive: true });
  const units = [];
  for (const [label, d, names] of [...groups, ...OURS]) {
    for (const n of names) {
      const path = d.startsWith('/') ? join(d, n) : join(RSRC, d, n);
      units.push({ path, out: join(dir, `${label}__${n.replace(/\.c$/, '')}.mjs`) });
    }
  }
  /* **按 key 缓存**（判据不许一趟一分钟）：源文件与编译器那几份源都没动过，就直接用
     上一趟发出来的那 251 份 `.mjs`。命中时这一节 1 秒内跑完发射那一半，只剩装载与调用。
     符号表落一份 `.syms.json` —— 探针（`.omni-cache/probe/*.js`）拿它只编自己那一份胶水。 */
  const keyFile = join(dir, '.key');
  const symsFile = join(dir, '.syms.json');
  const depsFile = join(dir, '.deps.json');
  const stampOf = (p) => { const s = statSync(p); return `${s.mtimeMs}:${s.size}`; };
  const key = [
    ...units.map((u) => `${u.path}=${stampOf(u.path)}`),
    ...['src/core/frontend-c/tccgen.js', 'src/core/frontend-c/tccpp.js', 'src/core/mir/emit_js.js',
      'src/core/mir/ir.js', 'src/core/mir/js_rt.js', 'src/core/lang/c.js']
      .map((f) => `${f}=${stampOf(join(ROOT, f))}`),
  ].join('\n');
  let linked = null;
  let hit = false;
  if (existsSync(keyFile) && readFileSync(keyFile, 'utf8') === key && existsSync(symsFile)
    && existsSync(depsFile) && units.every((u) => existsSync(u.out))) {
    hit = true;
    const syms = new Map(Object.entries(JSON.parse(readFileSync(symsFile, 'utf8'))));
    const deps = JSON.parse(readFileSync(depsFile, 'utf8'));
    linked = {
      units: units.map((u) => ({ path: u.path, out: u.out, lib: true, deps: deps[u.out] ?? [] })),
      entry: null,
      syms,
    };
  }
  try {
    if (!hit) {
      linked = cJsModules(units, {
        incs: INCS, defs: DEFS, rtImport: join(ROOT, 'src/core/mir/js_rt.js'),
      });
      for (const u of linked.units) writeFileSync(u.out, u.text);
      writeFileSync(symsFile, JSON.stringify(Object.fromEntries(linked.syms), null, 0));
      writeFileSync(depsFile, JSON.stringify(Object.fromEntries(
        linked.units.map((u) => [u.out, u.deps ?? []]),
      )));
      writeFileSync(keyFile, key);
    }
  } catch (e) {
    no('全部运行时发成 JS 模块', String(e instanceof Error ? e.message : e).slice(0, 400));
    linked = null;
  }
  if (linked !== null) {
    const bytes = linked.units.reduce((a, u) => a + (u.text === undefined
      ? statSync(u.out).size : u.text.length), 0);
    if (linked.units.length !== units.length) {
      no('全部运行时发成 JS 模块', `只发了 ${linked.units.length}/${units.length} 份`);
    } else {
      ok('全部运行时发成 JS 模块', `${linked.units.length} 份 .mjs、${bytes} 字节、`
        + `对外符号 ${linked.syms.size} 个${hit ? '（命中缓存，没重编）' : ''}`);
    }
    /* **只装用得着的那些**（第一百五十二片的速度那一格）：251 份全装一趟 30 秒，
       而判据只叫得出那几十个符号。根 = 提供这些符号的那几份 `.mjs`，再按 `deps`
       求传递闭包 —— ESM 本来就只装这个闭包，我们要的是"该给谁叫 $init"这张名单。 */
    const byOut = new Map(linked.units.map((u) => [u.out, u]));
    const wanted = [...INIT_SEQ, 'Rf_type2char', 'Rf_str2type', 'Rf_asReal', 'Rf_ScalarReal',
      'Rf_asInteger', 'Rf_ScalarInteger', 'Rf_xlength', 'Rf_allocVector', 'R_gc',
      'omni_src_ptr', 'omni_eval_buf', ...JSRUN.map(([, sym]) => sym)];
    const need = new Set();
    const walk = (f) => {
      if (f === undefined || need.has(f)) return;
      need.add(f);
      for (const d of byOut.get(f)?.deps ?? []) walk(d);
    };
    for (const nm of wanted) walk(linked.syms.get(nm));
    const loadList = linked.units.filter((u) => need.has(u.out));
    /* 装载 + 真调。入口自己写（`cJsEntry` 要一份有 `main` 的，libR 没有）。 */
    const L = [];
    const logFile = join(dir, '$judge.log');
    writeFileSync(logFile, '');
    L.push("import { appendFileSync } from 'node:fs';");
    L.push(`import { RT as $RT } from ${JSON.stringify(join(ROOT, 'src/core/mir/js_rt.js'))};`);
    L.push(`const LOG = ${JSON.stringify(logFile)};`);
    let k = 0;
    for (const u of loadList) L.push(`import { $init as $i${k++} } from ${JSON.stringify(u.out)};`);
    const MAIN = JSON.stringify(join(dir, 'main__arithmetic.mjs'));
    void MAIN;
    /* 初始化那一串 + SEXP 那几格都从符号表里现找（名字在别的模块里） */
    L.push(`const $M = [${loadList.map((u) => JSON.stringify(u.out)).join(', ')}];`);
    k = 0;
    for (const [mod, sym] of JSRUN) {
      L.push(`import { $fn_${sym} as $c${k++} } from ${JSON.stringify(join(dir, `${mod}.mjs`))};`);
    }
    L.push(`const INITS = [${loadList.map((_, i) => `$i${i}`).join(', ')}];`);
    L.push('let n = 0;');
    L.push('for (const f of INITS) { f(); n += 1; }');
    L.push("process.stdout.write('$init\\t' + n + '\\n');");
    /* 初始化那一串：照 R 自己的次序，一步一格印 */
    L.push('const $ns = {};');
    L.push('for (const p of $M) { const m = await import(p); for (const kk of Object.keys(m)) if (kk.startsWith("$fn_") && $ns[kk] === undefined) $ns[kk] = m[kk]; }');
    L.push(`const $F = (s) => $ns['$fn_' + s] ?? null;`);
    L.push(`for (const s of ${JSON.stringify(INIT_SEQ)}) {
  const f = $F(s);
  if (f === null) { appendFileSync(LOG, 'init\\t' + s + '\\t没这个符号\\n'); continue; }
  const t1 = Date.now();
  try { const rv = f(); appendFileSync(LOG, 'init\\t' + s + '\\tok\\t' + (Date.now() - t1) + 'ms rv=' + rv + '\\n'); }
  catch (e) { appendFileSync(LOG, 'init\\t' + s + '\\t炸了：' + String(e && e.message).slice(0, 100) + '\\n'); }
}`);
    L.push(`{
  const t2c = $F('Rf_type2char'); const s2t = $F('Rf_str2type');
  const P = (nm, v) => appendFileSync(LOG, 'sexp\\t' + nm + '\\t' + v + '\\n');
  const T = (nm, f) => { try { P(nm, f()); } catch (e) { P(nm, '炸了：' + String(e && e.message).slice(0, 120)); } };
  T('str2type(type2char(REALSXP))', () => s2t(t2c(14)));
  T('str2type(type2char(VECSXP))', () => s2t(t2c(19)));
  T('asReal(ScalarReal(3.5))', () => $F('Rf_asReal')($F('Rf_ScalarReal')(3.5)));
  T('asInteger(ScalarInteger(7))', () => $F('Rf_asInteger')($F('Rf_ScalarInteger')(7)));
  T('xlength(allocVector(REALSXP,5))', () => $F('Rf_xlength')($F('Rf_allocVector')(14, 5n)));
  /* 一句一句递进去：地址问 omni_src_ptr()，字节用 RT 的 i8 访问器写，末尾补 0 */
  const $st = $RT.memStoreFn('i8');
  const $put = (src) => {
    const p = $F('omni_src_ptr')();
    const bs = new TextEncoder().encode(src);
    for (let i = 0; i < bs.length; i++) $st(p, i, BigInt(bs[i]));
    $st(p, bs.length, 0n);
  };
  const $ev = $F('omni_eval_buf');
  for (const src of ${JSON.stringify(EVAL_CHECKS)}) T('eval:' + src, () => { $put(src); return $ev(); });
  T('R_gc', () => { $F('R_gc')(); return 1; });
}`);
    k = 0;
    for (const [, sym, args] of JSRUN) {
      L.push(`process.stdout.write(${JSON.stringify(sym)} + '\\t' + $c${k}(${args}).toPrecision(17) + '\\n');`);
      k += 1;
    }
    const entry = join(dir, '$judge.mjs');
    writeFileSync(entry, `${L.join('\n')}\n`);
    /* **V8 的编译缓存**（`NODE_COMPILE_CACHE`）：55 MB 的 JS 解析一趟要 30 秒，
       那是判据里最贵的一格。缓存之后重跑只花几秒 —— 判据不许一趟一分钟。 */
    const r = spawnSync(process.execPath, [entry], {
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      /* 子进程自己也要有上限：R 的出错那条路要是转起圈来（少了顶层上下文就会），
         这儿一等就是几分钟。30 秒够装载 + 初始化 + 那几格。 */
      timeout: 45000,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        NODE_COMPILE_CACHE: join(dir, '.v8cache'),
        /* base 那个包的 R 代码在这棵树里（`ext/r/build-libR.js` 编装的）——
           `R_OpenLibraryFile("base")` 就是按 `R_HOME` 找它。 */
        R_HOME: join(ROOT, '.omni-cache', 'r-rt', 'libR', 'home'),
      },
    });
    const logText = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    const lines = `${r.stdout ?? ''}${logText}`.trim().split('\n').map((s) => s.split('\t'));
    const got = new Map(lines.filter((a) => a[0] !== 'init' && a[0] !== 'sexp').map((a) => [a[0], a[1]]));
    const initOut = new Map(lines.filter((a) => a[0] === 'init').map((a) => [a[1], a[2]]));
    const sexpOut = new Map(lines.filter((a) => a[0] === 'sexp').map((a) => [a[1], a[2]]));
    /* 尺子：Rscript。没有就退回记死的常数。 */
    const rs = spawnSync('Rscript', ['-e',
      JSRUN.map(([, , , expr]) => `cat(sprintf("%.17g", ${expr}), "\\n")`).join(';')],
    { encoding: 'utf8' });
    const refs = rs.status === 0
      ? (rs.stdout ?? '').trim().split('\n').map((s) => Number(s))
      : JSRUN.map(([, , , , c]) => c);
    const bad = [];
    if (got.get('$init') !== String(loadList.length)) {
      bad.push(`只有 ${got.get('$init')} 份的 $init 跑过（要 ${loadList.length}）`);
    }
    /* 初始化那一串：该过的必须过，记着的那两笔账（缺 stat / getpid）允许炸 */
    for (const s of INIT_SEQ) {
      const v = initOut.get(s);
      if (v === undefined) { bad.push(`init ${s}: 一行都没印（那一步之前就断了）`); break; }
      if (v !== undefined && v.startsWith('ok')) continue;
      if (INIT_ALLOW_FAIL.has(s)) continue;
      bad.push(`init ${s}: ${v}`);
    }
    /* SEXP 那一层：R 自己的 API 兜回来的值 */
    for (const [nm, wantV] of SEXP_CHECKS) {
      const v = Number(sexpOut.get(nm));
      if (v !== wantV) bad.push(`${nm}: 我们 ${sexpOut.get(nm)}、要 ${wantV}`);
    }
    if (sexpOut.get('R_gc') !== '1') bad.push('R_gc 没跑过');
    /* 真求值那几句：尺子是 Rscript（一句一趟，`{}` 包起来免得赋值那句印两遍） */
    const rs2 = spawnSync('Rscript', ['-e',
      EVAL_CHECKS.map((e) => `cat(sprintf("%.17g", {${e}}), "\\n")`).join(';')],
    { encoding: 'utf8' });
    const refs2 = (rs2.stdout ?? '').trim().split('\n').map((x) => Number(x));
    if (rs2.status !== 0 || refs2.length !== EVAL_CHECKS.length) {
      bad.push(`Rscript 那把尺子没量出来（${(rs2.stderr ?? '').split('\n')[0].slice(0, 100)}）`);
    } else {
      EVAL_CHECKS.forEach((src, i) => {
        const got2 = sexpOut.get(`eval:${src}`);
        const v = Number(got2);
        const w = refs2[i];
        if (!Number.isFinite(v)) { bad.push(`eval ${src}: 我们 ${got2}、R ${w}`); return; }
        const rel = Math.abs(v - w) / Math.max(Math.abs(w), 1e-300);
        if (rel > 1e-12) bad.push(`eval ${src}: 我们 ${v}、R ${w}`);
      });
    }
    JSRUN.forEach(([, sym], i) => {
      const v = Number(got.get(sym));
      const w = refs[i];
      if (!Number.isFinite(v)) { bad.push(`${sym}: 没答案（${(r.stderr ?? '').split('\n')[0].slice(0, 120)}）`); return; }
      const rel = Math.abs(v - w) / Math.max(Math.abs(w), 1e-300);
      if (rel > 1e-12) bad.push(`${sym}: 我们 ${v}、R ${w}（相对差 ${rel.toExponential(2)}）`);
    });
    if (bad.length > 0) {
      no('装起来真调 R 的运行时', bad.slice(0, 8).join('\n       '));
    } else {
      const skipped = INIT_SEQ.filter((s) => initOut.get(s) !== 'ok');
      ok('装起来真调 R 的运行时', `装了 ${loadList.length}/${linked.units.length} 份（按根集合的闭包），`
        + `R 自己那 ${INIT_SEQ.length} 步初始化过了 ${INIT_SEQ.length - skipped.length} 步`
        + `（欠的：${skipped.join('、') || '无'}），SEXP 那 ${SEXP_CHECKS.length} 格 + R_gc 都对，`
        + `R 的 ${EVAL_CHECKS.length} 句都与 Rscript 对得上，`
        + `${JSRUN.length} 个函数与 ${rs.status === 0 ? 'Rscript' : '记死的常数'} 的相对差都 <= 1e-12`);
    }
  }
}

process.stdout.write(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
