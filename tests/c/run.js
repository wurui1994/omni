#!/usr/bin/env node
// Omni — C 前端的测试轴（ADR-0017 第五、六刀）
//
// 这一条与别的套件不同：**它有一个真的 oracle**。同一份 `.c` 交给我们和 tcc，两边比。
// asy 那条线靠的是本机的 `asy`，这里靠的是本机编出来的 tcc
// （`.omni-cache/tcc-build/tcc`，源码树在 /Users/wurui/Documents/Lang/reference/tinycc）。
//
// 七组：
//   1. `cpp/`     —— 预处理输出与 tcc 逐字节相同。**没有 .expected 文件**：
//                    期望值就是 tcc 的输出，写死一份反而会在 tcc 升级时骗人。
//                    每份文件走六种走法：`-P`（基准）、`-dD`、`-dM`、`-E`（带行标）、
//                    `-P1`（`#line`）、`-P10`。见 PP_MODES。
//   2. `inc/`     —— `#include` 的搜索与守卫：同样与 tcc 比，只是多给一个 -I。
//                    带行标那两种走法也在这儿 —— 进出文件的 ` 1`/` 2` 只有真 include 才试得到。
//   3. `cpp-bad/` —— 该拒的要拒，而且拒在正确的理由上（阶段边界与真错误各占一半）。
//                    这一组有 .expected（一行，错误消息的关键片段）。
//   4. `gen/`     —— 第六刀：编译并跑，**进程退出码与整条 stdout** 都与 `tcc -run` 相同。
//                    退出码就是 C 的 `main` 的返回值，只有 8 位（wait(2) 的规矩），
//                    所以用例都把结果收在 0..255。第五片 printf 一通之后 stdout 也进了
//                    对账范围 —— 一个字节的 oracle 会撞（`s % 251` 曾经让一个真错误躲过
//                    二分），整条 stdout 宽得多。
//   5. `sys/`     —— 与 `gen/` 同一口径，只是用**真的系统头**（macOS SDK）。SDK 不在
//                    就跳过。第八十九片起两条腿都自己去找，一个 `-I` 都不给。
//   5.5 `sysinc/` —— 只预处理，不跑：两边都**不给 `-I`**，各自去找系统头，`tcc -E -P`
//                    与 `-M` 都逐字节比（第八十八片）。搜索表本身就是被量的东西。
//   6. `gen-bad/` —— 第六刀的阶段边界与真语法错误。同样有 .expected。
//   7. `diag/`    —— 第八刀第十九片：**诊断本身**与 tcc 逐字节相同（同一个行号、同一句
//                    话）。同样没有 .expected —— 期望值就是 tcc 的那一行。
//
// tcc 不在的时候整组**跳过而不是假过**（印 skip 并说明原因）—— 悄悄变成 0 passed
// 才是最坏的结局。
//
//   node tests/c/run.js
//   node tests/c/run.js macro

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Cpp } from '../../src/core/frontend-c/tccpp.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const TCC_DIR = join(root, '.omni-cache', 'tcc-build');
const TCC = join(TCC_DIR, 'tcc');
const CLI = join(root, 'src', 'core', 'cli.js');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));


let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];

const ok = (name) => {
  pass++;
  process.stdout.write(`  ok   ${name}\n`);
};
const bad = (name, detail) => {
  fail++;
  failures.push(`${name}\n${detail}`);
  process.stdout.write(`  FAIL ${name}\n`);
};

const read = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

const pick = (d) => {
  const dir = join(here, d);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.c')).sort()
    .filter((f) => !filters.length || filters.some((x) => f.includes(x)));
};

/** 我们的预处理器跑一份文件，回 {out} 或 {err} */
function ours(path, incDirs, dflag = 0, pflag = 1) {
  const cpp = new Cpp({
    readFile: (p) => read(p),
    includeDirs: incDirs,
  });
  cpp.dflag = dflag;
  cpp.Pflag = pflag;
  try {
    return { out: cpp.preprocessToText(path, read(path)), warnings: cpp.warnings };
  } catch (e) {
    return { err: e.message };
  }
}

/** tcc 跑同一份（`-E` + 走法自己那几个开关），回 {out} 或 {err} */
function oracle(path, incDirs, extra = []) {
  const args = ['-E', ...extra];
  for (const d of incDirs) args.push('-I', d);
  args.push(path);
  const r = spawnSync(TCC, args, { encoding: 'utf8' });
  if (r.status !== 0) return { err: (r.stderr ?? '').trim() };
  return { out: r.stdout ?? '' };
}

const hasTcc = existsSync(TCC);
if (!hasTcc) {
  process.stdout.write(`  skip 整组：oracle 不在（${TCC}）\n`);
  process.stdout.write('       建它：见 ADR-0017「量出来的基线」那一节的树外构建\n');
}

/**
 * `cpp/`、`inc/` 两组的走法。`args` 是给 tcc 的，`pflag`/`dflag` 是给我们的
 * （`Pflag`：0 = `# 行号 "文件"`、1 = `-P` 什么都不印、2 = `-P1` 的 `#line`）。
 *
 * `strip`：第一百〇七片之前带行标比要削掉序幕 —— tcc 的预定义是一份叫 `<command line>`
 * 的**源码**，它进出主文件都印行标，而我们的预定义是三张表、没有这一段。现在这一层
 * 照旧开着（里头可能是空的，见 `pushCmdlineFile`），于是**从第一个字节起**就能比，
 * 两个 `strip` 都撤了。
 */
const PP_MODES = {
  '': { args: ['-P'], pflag: 1, dflag: 0 },
  '-dD': { args: ['-P', '-dD'], pflag: 1, dflag: 3 },
  '-dM': { args: ['-P', '-dM'], pflag: 1, dflag: 7 },
  '-E': { args: [], pflag: 0, dflag: 0 },
  '-P1': { args: ['-P1'], pflag: 2, dflag: 0 },
  '-P10': { args: ['-P10'], pflag: 11, dflag: 0, lenient: true },
};

/** 一份文件：我们的输出必须与 tcc 的逐字节相同 */
function compare(group, file, incDirs, mode = '') {
  const name = `${group}/${basename(file, '.c')}${mode === '' ? '' : ` ${mode}`}`;
  const path = join(here, group, file);
  if (!hasTcc) {
    skip++;
    return;
  }
  const m = PP_MODES[mode];
  const want = oracle(path, incDirs, m.args);
  const got = ours(path, incDirs, m.dflag, m.pflag);
  if (want.err !== undefined) {
    /* `-P10` 把每个 pp-number 都当真数字解一遍，于是「合法的 pp-number 但不是合法的
     * C 数字」（`1e`、`0x1p`）tcc 自己就拒 —— 那不是我们的错，记 skip。 */
    if (m.lenient === true) {
      skip++;
      process.stdout.write(`  skip ${name}：tcc 自己就拒了（${want.err.split('\n')[0]}）\n`);
      return;
    }
    bad(name, `    tcc 自己就拒了这份用例：\n${want.err}`);
    return;
  }
  if (got.err !== undefined) {
    bad(name, `    我们拒了，tcc 没拒：\n    ${got.err}`);
    return;
  }
  if (got.out !== want.out) {
    const w = want.out.split('\n');
    const g = got.out.split('\n');
    let i = 0;
    while (i < w.length && i < g.length && w[i] === g[i]) i++;
    bad(name, [
      `    第 ${i + 1} 行起分岔`,
      `    tcc:  ${JSON.stringify(w[i])}`,
      `    ours: ${JSON.stringify(g[i])}`,
      '    --- tcc ---',
      want.out,
      '    --- ours ---',
      got.out,
    ].join('\n'));
    return;
  }
  const n = want.out === '' ? 0 : want.out.replace(/\n$/, '').split('\n').length;
  ok(`${name} [ours == tcc -E ${m.args.join(' ')}] ${n} lines`);
}

// ------------------------------------------------------------ 1. cpp/：与 tcc 逐字节相同

for (const f of pick('cpp')) compare('cpp', f, []);

// 同一批文件再走一遍 `-dD` / `-dM`：宏表本身也要与 tcc 逐行相同（次序 = 定义次序）。
// 再走一遍 `-E`（不带 `-P`）与 `-P1`：行标那一路 —— `# 行号 "文件"` 与 `#line`。
for (const f of pick('cpp')) for (const m of ['-dD', '-dM', '-E', '-P1', '-P10']) compare('cpp', f, [], m);

// ------------------------------------------------------------ 2. inc/：#include 的搜索与守卫

const incDir = join(here, 'inc', 'include');
/* 第二个搜索目录：`#include_next` 得有「底下那一层」才试得出来（第八十四片）。
 * 两边都有 `next.h`，`include` 在前。别的用例不受影响 —— 只有 `next.h` 是重名的。 */
const incDir2 = join(here, 'inc', 'include2');
const incDirs = [incDir, incDir2];
for (const f of pick('inc')) compare('inc', f, incDirs);
// 进出文件的行标（` 1` / ` 2`）只有真 include 才试得到。
for (const f of pick('inc')) for (const m of ['-E', '-P1']) compare('inc', f, incDirs, m);

/**
 * `-M` 一族：给 make 的依赖清单（`gen_makedeps`）。这一组比的是**两边 CLI 的 stdout** ——
 * 依赖清单是驱动层的产物，不是预处理器的返回值。
 *
 * `inc/` 那几条只盖 `-MM`（自己的头）与不牵动系统头的 `-M`。真的系统头有自己一组
 * （`sysinc/`，第八十八片）—— 那一组两边都不给 `-I`，连 `-M` 摊出来的几十份
 * `sys/_types/*.h` 都逐字节对。唯一对不上的是**我们自带的那几份**（`src/include/`
 * 里的 `stddef.h` 一族）：做尺子的 tcc 没装，它那一格（`/usr/local/lib/tcc/include`）
 * 不存在，于是掉到 SDK 上；拿 `-B` 指一个 `include/` 真在的树，它就跟我们一样先用自己
 * 那份。差的是「装没装」，不是搜索顺序。
 */
function depsCase(group, file, incDirs, flags) {
  const name = `${group}/${basename(file, '.c')} ${flags.join(' ')}`;
  const path = join(here, group, file);
  if (!hasTcc) {
    skip++;
    return;
  }
  const args = [...flags];
  for (const d of incDirs) args.push('-I', d);
  const w = spawnSync(TCC, [...args, path], { encoding: 'utf8' });
  if (w.status !== 0) {
    bad(name, `    tcc 自己就拒了：\n${(w.stderr ?? '').trim()}`);
    return;
  }
  const g = spawnSync(process.execPath, [CLI, 'cpp', path, ...args], { encoding: 'utf8' });
  if (g.status !== 0) {
    bad(name, `    我们拒了，tcc 没拒：\n${(g.stderr ?? '').trim()}`);
    return;
  }
  if (g.stdout !== w.stdout) {
    bad(name, `    --- tcc ---\n${w.stdout}    --- ours ---\n${g.stdout}`);
    return;
  }
  const n = w.stdout.replace(/\n$/, '').split('\n').length;
  ok(`${name} [ours == tcc ${flags.join(' ')}] ${n} lines`);
}

for (const f of pick('inc')) {
  for (const fl of [['-MM'], ['-MM', '-MP'], ['-M'], ['-M', '-MP']]) depsCase('inc', f, incDirs, fl);
}
/* 一个头都不 include 的样子（清单里只有 `.c` 自己）。用 `gen/` 里的 —— `-M` 一族不带
 * `-E`，tcc 会真的把文件编一遍，而 `cpp/` 那几份是预处理器的探针、本来就不是合法的 C。 */
if (pick('gen').includes('01-expr.c')) depsCase('gen', '01-expr.c', [], ['-MM']);

/**
 * 驱动层的开关（`-D`/`-U`/`-isystem`/`-nostdinc`，第八十五片）：同样比两边 CLI 的
 * stdout，尺子是 `tcc -E -P <开关>`。这些开关改的是「宏表里有什么」与「往哪儿找头」，
 * 不是预处理器自己的状态，所以走 CLI 而不是 `compare()`。
 */
function optCase(group, file, flags, dropBanner = false) {
  const name = `${group}/${basename(file, '.c')} ${flags.join(' ')}`;
  const path = join(here, group, file);
  if (!hasTcc) {
    skip++;
    return;
  }
  const w = spawnSync(TCC, ['-E', '-P', ...flags, path], { encoding: 'utf8' });
  if (w.status !== 0) {
    bad(name, `    tcc 自己就拒了：\n${(w.stderr ?? '').trim()}`);
    return;
  }
  /* `-v` 一族下 tcc 的第一行是版本条（也在标准输出上，`tcc version …`）——
   * Omni 没有对应的东西，掐掉再比。 */
  const want = dropBanner ? w.stdout.slice(w.stdout.indexOf('\n') + 1) : w.stdout;
  const g = spawnSync(process.execPath, [CLI, 'cpp', path, '-P', ...flags], { encoding: 'utf8' });
  if (g.status !== 0) {
    bad(name, `    我们拒了，tcc 没拒：\n${(g.stderr ?? '').trim()}`);
    return;
  }
  if (g.stdout !== want) {
    bad(name, `    --- tcc ---\n${want}    --- ours ---\n${g.stdout}`);
    return;
  }
  const n = want === '' ? 0 : want.replace(/\n$/, '').split('\n').length;
  ok(`${name} [ours == tcc -E -P ${flags.join(' ')}] ${n} lines`);
}

if (pick('cpp').includes('09-cmdline.c')) {
  for (const fl of [
    ['-DX=2'],
    ['-DX=2', '-DY=7'],
    ['-DX=2', '-UX'],            // 顺序有意义：这一条 X 是没有的
    ['-UX', '-DX=2'],            // 这一条 X = 2
    ['-DY'],                     // 没有 `=` 的宏体是 1，不是空 —— 于是 `Y > 1` 为假
    ['-UPATH_DOES_NOT_EXIST'],   // 掀一个本来就没有的，什么都不该发生
  ]) optCase('cpp', '09-cmdline.c', fl);
}
/* `-isystem` 与 `-nostdinc`：把 inc/ 那两个目录当系统头目录来找 `<next.h>`。 */
if (pick('inc').includes('02-include-next.c')) {
  optCase('inc', '02-include-next.c', ['-isystem', incDir, '-isystem', incDir2]);
  optCase('inc', '02-include-next.c', ['-nostdinc', '-isystem', incDir, '-isystem', incDir2]);
}
/* `-include`：开工前先读的那几份（第八十六片）。路径给绝对的 —— tcc 那边这一格算的是
 * `<command line>` 的目录，也就是当前工作目录，而门是从仓库根上跑的。 */
if (pick('inc').includes('01-include.c')) {
  const via = join(incDir, 'viaflag.h');
  const local = join(here, 'inc', 'local.h');
  optCase('inc', '01-include.c', ['-I', incDir, '-include', via]);
  optCase('inc', '01-include.c', ['-I', incDir, '-include', local, '-include', via]);
  // 依赖清单里也要有它（`<command line>` 那一层是真的 include 层）
  depsCase('inc', '01-include.c', [incDir], ['-MM', '-include', via]);
}
/* `-v` / `-vv` / `-vvv`：头文件的开合都印一行（第八十七片）。`-vvv` 那一档连试不开的
 * 也印，于是会踩到系统头目录 —— 我们只有一个 `src/include`，tcc 有两个，所以那一档
 * 加 `-nostdinc` 把系统那一段整个掐掉再比。 */
if (pick('inc').includes('01-include.c')) {
  optCase('inc', '01-include.c', ['-I', incDir, '-v'], true);
  optCase('inc', '01-include.c', ['-I', incDir, '-vv'], true);
  optCase('inc', '01-include.c', ['-nostdinc', '-I', incDir, '-vvv'], true);
}
if (pick('inc').includes('02-include-next.c')) {
  optCase('inc', '02-include-next.c', ['-isystem', incDir, '-isystem', incDir2, '-vv'], true);
  optCase('inc', '02-include-next.c',
    ['-nostdinc', '-isystem', incDir, '-isystem', incDir2, '-vvv'], true);
}
/* `sysinc/`：真的系统头（第八十八片）。两边都**不给 `-I`**，各自去找 —— 找到的是不是
 * 同一份文件、读出来的宏与 `#if` 分支是不是同一支，`-E -P` 逐字节比就见分晓；`-M`
 * 再把整条 include 链（几十份 `sys/_types/*.h`）摊开对一遍。 */
for (const f of pick('sysinc')) {
  optCase('sysinc', f, []);
  depsCase('sysinc', f, [], ['-M']);
  depsCase('sysinc', f, [], ['-MM']);
}

// ------------------------------------------------------------ 3. cpp-bad/：该拒的要拒

for (const f of pick('cpp-bad')) {
  const name = `cpp-bad/${basename(f, '.c')}`;
  const path = join(here, 'cpp-bad', f);
  const want = (read(join(here, 'cpp-bad', `${basename(f, '.c')}.expected`)) ?? '').trim();
  const got = ours(path, []);
  if (want === '') {
    bad(name, `    缺 cpp-bad/${basename(f, '.c')}.expected`);
  } else if (got.err === undefined) {
    bad(name, `    该拒没拒，输出是：\n${got.out}`);
  } else if (!got.err.includes(want)) {
    bad(name, `    想要 ${JSON.stringify(want)}\n    实得: ${got.err}`);
  } else {
    ok(`${name} [rejected: ${want}]`);
  }
}

// ------------------------------------------------------------ 4. gen/：跑起来，退出码与 tcc -run 相同

/** `tcc -run`：`-B` 指到构建目录，否则它找不到 runmain.o 与 libtcc1.a。 */
function tccRun(path, incDirs = []) {
  const args = ['-B', TCC_DIR];
  for (const d of incDirs) args.push('-I', d);
  args.push('-run', path);
  const r = spawnSync(TCC, args, { encoding: 'utf8' });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/**
 * 这段 stderr 是 **tcc 自己的诊断**，还是**被跑的程序写的**？（第八刀第九片）
 *
 * 到第八片为止 `gen/` 那一组把「tcc 的 stderr 非空」一律当成「tcc 拒了这份用例」——
 * 那时没有任何用例会往 stderr 写字。第九片有了 `fprintf(stderr, …)`，这条口径就得改：
 * 不改的话第一个写 stderr 的用例会被判成失败，而它其实是对的。
 *
 * tcc 自己的话有两种形状：`tcc: error: …` / `tcc: warning: …`，以及
 * `文件.c:行: error: …`（`tccpp.c` 的 `tcc_error` 与 `tcc_warning`）。两种都认成
 * 「这份用例本身有问题」；别的都当成程序的输出，逐字节比。
 */
function isTccDiag(err) {
  if (/(^|\n)tcc: /.test(err)) return true;
  return /(^|\n)[^\n]*:\d+: (error|warning):/.test(err);
}

/** 我们这一条腿：`cli.js c-run`（C -> MIR -> 闭包解释器），退出码同样是 main 的返回值。 */
function cRun(path, incDirs = []) {
  const args = [CLI, 'c-run', path];
  for (const d of incDirs) args.push('-I', d);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/**
 * 一份用例：编译、跑、与 `tcc -run` 逐字节对账（退出码 + stdout + stderr）。
 * `incDirs` 只给**我们这一条腿** —— tcc 自己知道系统头在哪儿，而我们要被告知（`sys/` 组）。
 */
function runCase(group, f, incDirs = []) {
  const name = `${group}/${basename(f, '.c')}`;
  const path = join(here, group, f);
  if (!hasTcc) {
    skip++;
    return;
  }
  const want = tccRun(path);
  if (isTccDiag(want.err)) {
    bad(name, `    tcc 自己就拒了这份用例：\n${want.err.trim()}`);
    return;
  }
  const got = cRun(path, incDirs);
  if (got.code !== want.code) {
    bad(name, `    退出码不同：tcc=${want.code} ours=${got.code}\n${got.err}`);
    return;
  }
  /* stdout 也要**逐字节**相同（第六刀第五片起）。printf 一通，oracle 就从「一个字节的
   * 退出码」升级成「整条 stdout」—— 之前一次 `s % 251` 的碰撞让一个真错误躲过了二分，
   * 这条轴宽得多。 */
  if (got.out !== want.out) {
    bad(name, `    stdout 不同：\n--- tcc ---\n${want.out}--- ours ---\n${got.out}`);
    return;
  }
  /* stderr 同样逐字节（第八刀第九片起）。在这之前它是「非空就说明 tcc 拒了」，
   * 而 `fprintf(stderr, …)` 一有，那条口径就把对的用例判成错的。
   * 我们这一侧的运行期错误也走 stderr（`omni: runtime error: …`），
   * 所以这一条**同时**在管「不该有的错误消息」—— 它一出现就与 tcc 的空 stderr 不同。 */
  if (got.err !== want.err) {
    bad(name, `    stderr 不同：\n--- tcc ---\n${want.err}--- ours ---\n${got.err}`);
    return;
  }
  const n = want.out.length;
  const e = want.err.length;
  ok(`${name} [exit ${want.code}${n > 0 ? ` + ${n}B stdout` : ''}`
    + `${e > 0 ? ` + ${e}B stderr` : ''} == tcc -run]`);
}

for (const f of pick('gen')) runCase('gen', f);

// ------------------------------------------------------------ 4.5 sys/：真的系统头，两条腿读同一份

/** SDK 里那份 `/usr/include`（`xcrun --show-sdk-path`）。取不到就整组跳过。 */
function sdkInclude() {
  const r = spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const p = join((r.stdout ?? '').trim(), 'usr', 'include');
  return existsSync(p) ? p : null;
}

/* SDK 在不在只决定「跳还是不跳」—— 第八十九片起**不再当 `-I` 传进去**：
 * 自带的那几份 libc 头删了，两条腿都自己找到 SDK 那一份（`cli.js` 的 `sdkUsrInclude`）。 */
const SDK_INC = sdkInclude();
for (const f of pick('sys')) {
  if (SDK_INC === null) {
    skip++;
    continue;
  }
  runCase('sys', f);
}

// ------------------------------------------------------------ 4.6 gen/ 再跑一遍：编成 JS 那条腿

/**
 * 同一批用例，第三条腿：**C -> MIR -> JS 源码 -> `new Function`**（ADR-0013）。
 *
 * 为什么单开一组而不是把 `runCase` 改成三方比：这一组**不需要 tcc**（比的是我们自己
 * 两条腿），所以没装 tcc 的机器上它照样是一道门。而它要的正是解释器已经证过的那件事
 * —— 解释器与 `tcc -run` 逐字节相同（第 4 组），所以「新腿 == 解释器」就等于
 * 「新腿 == tcc」，中间不必再跑一遍 tcc。
 *
 * 比三项：**退出码 + stdout + stderr**，都逐字节。发 JS 这条路上最容易分叉的是
 * 值表示（i32 的回绕、无符号比较、i64 与 Number 的边界）与线性内存的读写，而那些
 * 分叉全都会在这三项里露出来 —— 静默的错答案是这条腿最大的风险（它是 oracle 的对照物）。
 */
function cRunJs(path, incDirs = []) {
  const args = [CLI, 'run', path, '--backend', 'js'];
  for (const d of incDirs) args.push('-I', d);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function jsLegCase(group, f, incDirs = []) {
  const nm = `${group}/${basename(f, '.c')}`;
  const name = `${nm} [js leg == interp]`;
  const path = join(here, group, f);
  const want = cRun(path, incDirs);
  const got = cRunJs(path, incDirs);
  if (got.code !== want.code) {
    bad(name, `    退出码不同：interp=${want.code} js=${got.code}\n${got.err}`);
    return;
  }
  if (got.out !== want.out) {
    bad(name, `    stdout 不同：\n--- interp ---\n${want.out}--- js ---\n${got.out}`);
    return;
  }
  if (got.err !== want.err) {
    bad(name, `    stderr 不同：\n--- interp ---\n${want.err}--- js ---\n${got.err}`);
    return;
  }
  ok(`${name} [exit ${want.code}${want.out.length > 0 ? ` + ${want.out.length}B stdout` : ''}]`);
}

for (const f of pick('gen')) jsLegCase('gen', f);

// ------------------------------------------------------------ 5. gen-bad/：边界与语法错误

for (const f of pick('gen-bad')) {
  const nm = basename(f, '.c');
  const name = `gen-bad/${nm}`;
  const path = join(here, 'gen-bad', f);
  const want = (read(join(here, 'gen-bad', `${nm}.expected`)) ?? '').trim();
  const got = cRun(path);
  if (want === '') {
    bad(name, `    缺 gen-bad/${nm}.expected`);
  } else if (got.code === 0) {
    bad(name, `    该拒没拒，输出是：\n${got.out}`);
  } else if (!got.err.includes(want)) {
    bad(name, `    想要 ${JSON.stringify(want)}\n    实得: ${got.err}`);
  } else {
    ok(`${name} [rejected: ${want}]`);
  }
}

// ------------------------------------------------------------ 6. diag/：诊断逐字节相同

/** `tcc -c`：只编译，只要那句诊断。`-o /dev/null` 免得留下 .o。 */
function tccCompile(path) {
  const r = spawnSync(TCC, ['-B', TCC_DIR, '-c', '-o', '/dev/null', path], { encoding: 'utf8' });
  return { code: r.status, err: (r.stderr ?? '').trim() };
}

/** 我们这一条腿：`c-mir`（不跑，只编译）。 */
function cCompile(path) {
  const r = spawnSync(process.execPath, [CLI, 'c-mir', path], { encoding: 'utf8' });
  return { code: r.status, err: (r.stderr ?? '').trim() };
}

/**
 * 第八刀第十九片的测试轴：**诊断本身**要与 tcc 逐字节相同 —— 不是「也报了个错」，
 * 而是同一个文件名、同一个行号、同一句话。行号那条减法（`Cpp.errLine`）与
 * `(got 'x')` 那一段都只有这样才钉得住。
 *
 * 只比**第一行**：tcc 报完第一条致命错误就 longjmp 出去了，后面没有别的。
 */
for (const f of pick('diag')) {
  const name = `diag/${basename(f, '.c')}`;
  const path = join(here, 'diag', f);
  if (!hasTcc) {
    skip++;
    continue;
  }
  const want = tccCompile(path);
  const got = cCompile(path);
  if (want.code === 0) {
    bad(name, '    tcc 自己没拒这份用例 —— diag/ 里的每一份都该被拒');
  } else if (got.code === 0) {
    bad(name, '    我们没拒，tcc 拒了');
  } else {
    const w = want.err.split('\n')[0];
    const g = got.err.split('\n')[0];
    if (w !== g) {
      bad(name, `    tcc:  ${JSON.stringify(w)}\n    ours: ${JSON.stringify(g)}`);
    } else {
      ok(`${name} [ours == tcc: ${w}]`);
    }
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}\n`);if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
}
