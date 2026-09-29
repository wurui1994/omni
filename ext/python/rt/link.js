#!/usr/bin/env node
// ext/python/rt/link.js —— **量尺：我们编出来的那堆 .o 真链得起来吗**
//
//   node ext/python/rt/link.js                 # 默认那 201 份的范围
//   node ext/python/rt/link.js --keep          # 把 .a / .dylib 留在 .omni-cache 里
//
// ## 为什么要有这一份
//
// 前两把尺子回答"编得出"（`sweep.js`）与"编得对（接口层面）"（`symbols.js`）。
// 这一份回答第三问：**把它们摞在一起，链接器还缺什么**。
//
// 做法是**让真链接器说话**：`clang -dynamiclib` 把那堆 `.o` 链成一份动态库。macOS 的
// 链接器会自己从 libSystem 解析 libc 那一族，所以**剩下的未定义符号就是"我们还差的东西"**。
// 不用手工拿 `nm` 做集合减法 —— 那种减法容易把"libc 会给的"也算成缺口。
//
// ## 口径
//
//   * 范围与两把尺子共用 `scope.js`（`LIBRARY_OBJS` 那一串：`Objects` + `Python` +
//     `Parser`（连子目录）+ `Setup.bootstrap.in` 点名的那几份 `Modules/`）。
//   * `.o` 从 `.omni-cache/py-rt/obj/` 拿 —— **先跑一趟 `npm run py:sweep`**。缺了就说，
//     不自己偷偷编（两件事分开，数才对得上）。
//   * 门：未定义符号必须**全在 `EXPECTED` 那张表里**（那几个符号来自"要构建系统先跑一步"
//     的三份源码）。多出一个就红 —— 那才是真缺口。
//   * 顺手 `ar` 打一个静态库：那一步证明**归档器也读得懂我们的 `.o`**。

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesIn, GENERATED } from './scope.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i < 0 || i + 1 >= argv.length ? d : argv[i + 1];
};
const SRC = argOf('--src', process.env.OMNI_CPYTHON
  ?? join(homedir(), 'Documents', 'Lang', 'reference', 'cpython'));
const WORK = join(root, '.omni-cache', 'py-rt');
const OBJ = argOf('--obj', join(WORK, 'obj'));
const DIRS = argOf('--dirs', 'Objects,Python,Parser,Modules').split(',');
const CC = argOf('--cc', process.env.CC ?? 'clang');
const KEEP = argv.includes('--keep');
/** **整份运行时**（`--runtime`）：`Modules/` 那一棵连 `Setup.stdlib.in` 那一族一起链
 *  —— 与 `sweep --runtime` 同一个口径（见 `scope.js` 的 `runtimeModuleFiles`）。 */
const RUNTIME = argv.includes('--runtime');

/**
 * **允许还缺的那几个符号** —— 它们的定义都在"要构建系统先跑一步"的那三份源码里
 * （`scope.js` 的 `GENERATED`）。每一条写清由谁提供：
 *
 *   * `Python/frozen.c`（要 `Python/frozen_modules/*.h`，`make regen-frozen` 生成）——
 *     那一族"冻结模块表"：`importlib._bootstrap` 一类的字节码打进 `.c` 数组；
 *   * `Modules/getpath.c`（要 `Python/frozen_modules/getpath.h`）—— 算 `sys.path` 那一格；
 *   * `Modules/config.c`（**树里压根没有这份文件**，`makesetup` 按 `Setup` 生成）——
 *     内建模块表 `_PyImport_Inittab`。
 *
 * 也就是说：**这三份不是我们编不出来，是它们的输入还没生成**。哪天站到构建系统的位置上
 * 把那几份头生成出来（那一步要一个能跑的 `_freeze_module`，是个自举环），这张表就该空。
 *
 * **2026-09-28：空了。** 第四把尺子（`freeze.js`，`npm run py:freeze`）拿**我们自己编出来的**
 * `_freeze_module` 把那 26 份 frozen 头冻了出来，`frozen.c` / `getpath.c` 就编得出了，
 * `config.c` 由 `gen-config.js` 生成 —— 跑过那一趟之后这儿是"一个未定义符号都没有"。
 * 这张表留着：没跑过 `py:freeze` 的时候（比如刚 clone）那三份照旧缺，它们得有账。
 */
const EXPECTED = new Map([
  ['_PyImport_FrozenModules', 'Python/frozen.c'],
  ['__PyImport_FrozenBootstrap', 'Python/frozen.c'],
  ['__PyImport_FrozenStdlib', 'Python/frozen.c'],
  ['__PyImport_FrozenTest', 'Python/frozen.c'],
  ['__PyImport_FrozenAliases', 'Python/frozen.c'],
  ['__PyConfig_InitPathConfig', 'Modules/getpath.c'],
  ['__PyImport_Inittab', 'Modules/config.c'],
]);

if (!existsSync(join(SRC, 'Include', 'Python.h'))) {
  process.stdout.write(`py-rt/link: 参考树不在（${SRC}），跳过\n`);
  process.exit(0);
}

const { files } = filesIn(SRC, DIRS, { runtime: RUNTIME });
const objOf = ([d, f]) => join(OBJ, `${d}-${f}`.replace(/[/.]/g, '-') + '.o');
const have = [];
const missing = [];
for (const it of files) {
  const o = objOf(it);
  if (existsSync(o)) have.push(o);
  else missing.push(`${it[0]}/${it[1]}`);
}
if (have.length === 0) {
  process.stdout.write('py-rt/link: 一份 .o 都没有 —— 先跑 `npm run py:sweep`\n');
  process.exit(1);
}
/* **树上压根没有、但我们自己生成了**的那几份（现在只有 `Modules/config.c` ——
 * `gen-config.js` 按 `config.c.in` 生成、第四把尺子 `freeze.js` 编成
 * `obj/Modules-config-c.o`）。它在 `LIBRARY_OBJS` 里（`Makefile.pre.in:355` 的
 * `MODULE_OBJS`），所以有就摞进来 —— 于是那几个"有账的"缺口会一个一个消掉。 */
const genExtra = [];
for (const name of GENERATED) {
  if (files.some(([d, f]) => `${d}/${f}` === name)) continue;   // 树上有的那两份上面已经收了
  const i = name.indexOf('/');
  const o = objOf([name.slice(0, i), name.slice(i + 1)]);
  if (existsSync(o)) { have.push(o); genExtra.push(name); }
}
if (genExtra.length > 0) {
  process.stdout.write(`py-rt/link: 另收我们自己生成的 ${genExtra.join(' ')}\n`);
}
process.stdout.write(`py-rt/link: 范围 ${files.length} 份，手上有 ${have.length} 份 .o\n`);
if (missing.length > 0) {
  /* 编不出来的那几份：`sweep` 那把尺子的账。这儿只印出来，好知道缺口是谁欠的 */
  process.stdout.write(`            少 ${missing.length} 份（sweep 那把尺子的账）：\n`);
  for (const m of missing) {
    process.stdout.write(`              ${m}${GENERATED.has(m) ? ' —— 要构建系统先跑一步' : ''}\n`);
  }
}

const out = join(WORK, 'link');
mkdirSync(out, { recursive: true });
const lib = join(out, 'libomnipython.a');
const dylib = join(out, 'libomnipython.dylib');

/* 一、静态库：证明归档器读得懂我们的 .o */
rmSync(lib, { force: true });
const a = spawnSync('ar', ['rcs', lib, ...have], { encoding: 'utf8' });
if (a.status !== 0) {
  process.stdout.write(`py-rt/link: ar 打不出静态库：\n${a.stderr}`);
  process.exit(1);
}
const mb = (p) => (statSync(p).size / (1024 * 1024)).toFixed(1);
process.stdout.write(`\nar: ${lib} —— ${mb(lib)}M\n`);

/* 二、真链一次：**让链接器说还缺什么**（libc 那一族它自己从 libSystem 解析）。
   **平台那几格库要明着给**：`_scproxy` 要 macOS 的两个 framework
   （`configure.ac:8542`：`-framework SystemConfiguration -framework CoreFoundation`），
   `math` / `cmath` 那几格要 `-lm`。不给的症状是链接缺 26 个 `kSC*` / `CF*` /
   `SCDynamicStoreCopyProxies`（量出来的原话）—— 那不是我们的欠账，是**没把
   构建系统该给的链接开关给上**。 */
const SYS_LIBS = process.platform === 'darwin'
  ? ['-framework', 'SystemConfiguration', '-framework', 'CoreFoundation', '-lm']
  : ['-lm'];
const t0 = Date.now();
const l = spawnSync(CC, ['-dynamiclib', '-o', dylib, ...have, ...SYS_LIBS], { encoding: 'utf8' });
const secs = ((Date.now() - t0) / 1000).toFixed(1);
const undef = [...new Set([...(l.stderr ?? '').matchAll(/^ {2}"([^"]+)", referenced from:/gm)]
  .map((m) => m[1]))].sort();

if (l.status === 0) {
  process.stdout.write(`ld: ${dylib} —— ${mb(dylib)}M，**一个未定义符号都没有**（${secs}s）\n`);
} else if (undef.length === 0) {
  /* 链接失败但认不出未定义符号那一段 —— 别自己编故事，原样印出来 */
  process.stdout.write(`\npy-rt/link: 链接没过，而且不是"未定义符号"那一种：\n${l.stderr}`);
  process.exit(1);
} else {
  process.stdout.write(`ld: 还缺 ${undef.length} 个符号（${secs}s）\n`);
}

/** 这个符号该由谁给；回 null = 没人认它（真缺口）。 */
const ownerOf = (s) => EXPECTED.get(s) ?? null;
const byOwner = new Map();
const orphan = [];
for (const s of undef) {
  const owner = ownerOf(s);
  if (owner === null) orphan.push(s);
  else byOwner.set(owner, [...(byOwner.get(owner) ?? []), s]);
}

if (byOwner.size > 0) {
  process.stdout.write('\n有账的（等构建系统先跑一步）：\n');
  for (const [owner, syms] of [...byOwner].sort()) {
    process.stdout.write(`  ${owner}（${syms.length} 个）：${syms.join(' ')}\n`);
  }
}
if (orphan.length > 0) {
  process.stdout.write('\n**没账的（真缺口）**：\n');
  for (const s of orphan) process.stdout.write(`  ${s}\n`);
}
if (!KEEP) rmSync(out, { recursive: true, force: true });

if (orphan.length > 0) {
  process.stdout.write(`\n回归：${orphan.length} 个未定义符号没人认\n`);
  process.exit(1);
}
process.stdout.write(`\n门：没账的未定义符号 0 个 —— 过（${have.length} 份 .o 摞起来，`
  + `${byOwner.size === 0 ? '**一个缺口都没有**' : `只等那 ${[...byOwner.values()].flat().length} 个构建系统产物`}）\n`);
