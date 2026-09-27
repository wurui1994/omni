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

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
const OURS = [['omni', join(ROOT, 'ext/r/rt'), ['omni_complex.c', 'omni_libc.c'], false]];

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
const CEIL = { dup: 0, data: 0, thunk: 0, libc: 205 };
const SYMS_FLOOR = 2555;
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

process.stdout.write(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
