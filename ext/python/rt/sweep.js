#!/usr/bin/env node
// ext/python/rt/sweep.js —— **量尺：借来的那棵 CPython，我们这台 C 前端能编出多少份**
//
//   node ext/python/rt/sweep.js                      # 默认 Objects + Python + Parser + 核心 Modules
//   node ext/python/rt/sweep.js --dirs Objects        # 只量一棵
//   node ext/python/rt/sweep.js --dirs Modules       # 真进 libpython 的那几份（照 Setup.bootstrap.in 读）
//   node ext/python/rt/sweep.js unicode               # 只量名字里带 unicode 的
//   node ext/python/rt/sweep.js --min 0               # 不设门（探路用）
//
// ## 为什么要有这一份
//
// "借 CPython 的运行时"（SPEC §一）这条线的进度从前是**手工数的** —— 每次改完 C 前端
// 拿一行 shell 循环跑一遍，数字记在提交信息里。那种数字没人守：下一刀退了一格也看不见。
// 这一份把它变成一把**能回归的尺子**：`--min` 是那道门（像 `tests/c/native-gen.js` 的
// `MIN_OK`），编出来的份数少于它就 exit 1。
//
// ## 口径
//
//   * **参考树只读**：不跑 CPython 的 `configure`、不用它的 `Makefile`、不写它一个字节
//     （那棵树是几个 worktree 共用的输入）。产物一律落 `.omni-cache/py-rt/`。
//   * `pyconfig.h` 由 `gen-pyconf.js` **自己探**（缺了就现探一份，探法照 `configure.ac`）。
//   * 一份 `.c` 分三档：**ok**（出 `.o`、一条诊断都没有）、**warn**（出了 `.o`，但有
//     警告 —— 那多半是"将来会变链接错"的隐式声明）、**fail**（没出 `.o`）。
//     fail 按**原因**归族印出来，因为"22 份编不出"这个数没有意义，
//     "其中 11 份卡在同一句 `__asm__`"才有。
//   * 参考树不在就印一行跳过、exit 0（与 `tests/c` 缺 tcc 那一组同一口径）。

import { existsSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesIn, flagsFor, incDirFor, perFileFlags, pyconfExtra } from './scope.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const CLI = join(root, 'src', 'cli.js');
const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i < 0 || i + 1 >= argv.length ? d : argv[i + 1];
};
const filters = argv.filter((a, i) => !a.startsWith('-')
  && !(i > 0 && ['--src', '--inc', '--dirs', '--min', '--jobs'].includes(argv[i - 1])));

const SRC = argOf('--src', process.env.OMNI_CPYTHON
  ?? join(homedir(), 'Documents', 'Lang', 'reference', 'cpython'));
const WORK = join(root, '.omni-cache', 'py-rt');
/* 三棵都量（`gen-pyconf.js` 那七格 `Python/` 带进来的宏已经照 `configure.ac` 决定过）。 */
const DIRS = argOf('--dirs', 'Objects,Python,Parser,Modules').split(',');

/**
 * `Modules/` 那一棵**按名单量**（`--dirs …,Modules`），不整棵走 ——
 * 名单从 `Setup.bootstrap.in` 读出来（`scope.js` 的 `coreModuleFiles`）。整棵都想量：`--all-modules`。
 */
const ALL_MODULES = argv.includes('--all-modules');
/* 探出来的 `pyconfig.h` 落哪儿 —— **按范围分开放**（见 scope.js 的 `incDirFor`）。 */
const INC = argOf('--inc', null) ?? incDirFor(WORK, ALL_MODULES);
/**
 * 编得出 `.o` 的最少份数（ok + warn）。往上走是好事，往下走是回归。
 *
 * **门跟着"冻没冻过"走**：`Python/frozen.c` 与 `Modules/getpath.c` 要
 * `Python/frozen_modules/*.h`，而那些头是第四把尺子（`npm run py:freeze`）拿
 * **我们自己编出来的 `_freeze_module`** 冻的、落在 `.omni-cache/py-rt/gen/` 里。
 * 冻过了这两份就该编得出（201），没冻过（比如刚 clone）照旧是 199 ——
 * 定成一个固定的数必有一边在骗人。
 */
const FROZEN_READY = existsSync(join(WORK, 'gen', 'Python', 'frozen_modules', 'getpath.h'));
const MIN_OK = Number(argOf('--min', FROZEN_READY ? '201' : '199'));
const JOBS = Number(argOf('--jobs', '4'));

if (!existsSync(join(SRC, 'Include', 'Python.h'))) {
  process.stdout.write(`py-rt/sweep: 参考树不在（${SRC}），跳过\n`);
  process.stdout.write('            指过去：--src <cpython> 或 OMNI_CPYTHON=<cpython>\n');
  process.exit(0);
}

/* `pyconfig.h`：缺了就现探一份（探法照 `configure.ac`，见 gen-pyconf.js 的文件头）。
 * 探一次几秒钟、之后一直复用 —— 所以它落 `.omni-cache/py-rt/inc`，不落 /tmp。 */
const PYCONF = join(INC, 'pyconfig.h');
if (!existsSync(PYCONF)) {
  mkdirSync(INC, { recursive: true });
  process.stdout.write(`py-rt/sweep: 探一份 pyconfig.h -> ${PYCONF}\n`);
  const g = spawnSync(process.execPath,
    /* `--extra` 怎么算（为什么必须带 `Include` 整棵）：见 scope.js 的 `pyconfExtra` */
    [join(here, 'gen-pyconf.js'), '--src', SRC, '--out', PYCONF,
      '--extra', pyconfExtra(DIRS, ALL_MODULES, SRC)],
    { encoding: 'utf8' });
  if (g.status !== 0) {
    process.stdout.write(`py-rt/sweep: gen-pyconf 没过：\n${g.stderr}${g.stdout}`);
    process.exit(1);
  }
}

/** 一份 `.c` 的编译开关在 `scope.js`（两把尺子共用 —— 少一格数就变了）。 */
const flags = (out, name) => flagsFor(out, INC, SRC, perFileFlags(name, SRC));

/**
 * 一条诊断归到哪一族。**「22 份编不出」这个数没有意义**，
 * 「其中 11 份卡在同一句 `__asm__`」才有 —— 所以这儿按原因归族。
 */
function familyOf(msg) {
  if (/__asm__/.test(msg)) return '非空的 __asm__ 模板（等自带汇编器）';
  const inc = msg.match(/include file '([^']+)' not found/);
  if (inc !== null) return `头文件不在：${inc[1]}`;
  const und = msg.match(/'([^']+)' undeclared/);
  if (und !== null) return `名字看不见：${und[1]}`;
  const imp = msg.match(/implicit declaration of function '([^']+)'/);
  if (imp !== null) return `隐式声明：${imp[1]}`;
  return msg.replace(/^.*(error|warning): /, '').slice(0, 60);
}

/* 分母是**本机该编的份数**：代码生成器的输入与别的平台那几份不算（见 scope.js）。 */
const { files, skipped } = filesIn(SRC, DIRS, { allModules: ALL_MODULES, filters });
mkdirSync(join(WORK, 'obj'), { recursive: true });

/** 一份的结果：`{ name, kind: 'ok' | 'warn' | 'fail', first }`。 */
function compileOne(d, f) {
  return new Promise((done) => {
    const name = `${d}/${f}`;
    const out = join(WORK, 'obj', `${d}-${f}`.replace(/[/.]/g, '-') + '.o');
    const p = spawn(process.execPath, [CLI, ...flags(out, name), join(SRC, d, f)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '';
    let se = '';
    p.stdout.on('data', (b) => { so += String(b); });
    p.stderr.on('data', (b) => { se += String(b); });
    p.on('close', () => {
      const diag = (se + so).split('\n').filter((l) => /error:|warning:/.test(l));
      if (!so.includes(out)) done({ name, kind: 'fail', first: diag[0] ?? '(没出 .o，也没有诊断)' });
      else if (diag.length > 0) done({ name, kind: 'warn', first: diag[0] });
      else done({ name, kind: 'ok', first: '' });
    });
  });
}

/* 一个小池子（默认四路）：顺序跑一遍 163 份要三分钟，四路一分钟。 */
const results = [];
let next = 0;
async function worker() {
  for (;;) {
    const i = next;
    next++;
    if (i >= files.length) return;
    const r = await compileOne(files[i][0], files[i][1]);
    results[i] = r;
    const mark = r.kind === 'ok' ? 'ok  ' : (r.kind === 'warn' ? 'warn' : 'FAIL');
    process.stdout.write(`  ${mark} ${r.name}${r.first === '' ? '' : ` :: ${familyOf(r.first)}`}\n`);
  }
}

const t0 = Date.now();
await Promise.all(Array.from({ length: Math.max(1, JOBS) }, () => worker()));
const secs = ((Date.now() - t0) / 1000).toFixed(0);

const ok = results.filter((r) => r.kind === 'ok');
const warn = results.filter((r) => r.kind === 'warn');
const fail = results.filter((r) => r.kind === 'fail');

/** 按族数一遍，多的排前面 —— 这张表才是"下一刀该切哪儿"的答案。 */
function byFamily(list) {
  const m = new Map();
  for (const r of list) {
    const k = familyOf(r.first);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

process.stdout.write(`\n共 ${files.length} 份：**编出 .o ${ok.length + warn.length}**`
  + `（干净 ${ok.length} + 带警告 ${warn.length}）、编不出 ${fail.length}（${secs}s）\n`);
if (skipped.length > 0) {
  /* 分母之外的那几份 —— 印出来，免得"182 里 174"这种数看着像少了八格 */
  process.stdout.write(`\n另有 ${skipped.length} 份不进分母：\n`);
  for (const [n, why] of skipped) process.stdout.write(`       ${n} —— ${why}\n`);
}
if (fail.length > 0) {
  process.stdout.write('\n编不出的按族：\n');
  for (const [k, n] of byFamily(fail)) process.stdout.write(`  ${String(n).padStart(3)} 份  ${k}\n`);
}
if (warn.length > 0) {
  process.stdout.write('\n带警告的按族（这几族多半是"链接那天才炸"）：\n');
  for (const [k, n] of byFamily(warn)) process.stdout.write(`  ${String(n).padStart(3)} 份  ${k}\n`);
}
if (ok.length + warn.length < MIN_OK) {
  process.stdout.write(`\n回归：编出来的份数 ${ok.length + warn.length} < 门 ${MIN_OK}\n`);
  process.exit(1);
}
process.stdout.write(`\n门：>= ${MIN_OK} 份编得出 —— 过\n`);
