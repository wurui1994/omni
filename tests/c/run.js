#!/usr/bin/env node
// Omni — C 前端的测试轴（ADR-0017 第五、六刀）
//
// 这一条与别的套件不同：**它有一个真的 oracle**。同一份 `.c` 交给我们和 tcc，两边比。
// asy 那条线靠的是本机的 `asy`，这里靠的是本机编出来的 tcc
// （`.omni-cache/tcc-build/tcc`，源码树在 /Users/wurui/Documents/Lang/reference/tinycc）。
//
// 五组：
//   1. `cpp/`     —— 预处理输出与 tcc -E -P 逐字节相同。**没有 .expected 文件**：
//                    期望值就是 tcc 的输出，写死一份反而会在 tcc 升级时骗人。
//   2. `inc/`     —— `#include` 的搜索与守卫：同样与 tcc 比，只是多给一个 -I。
//   3. `cpp-bad/` —— 该拒的要拒，而且拒在正确的理由上（阶段边界与真错误各占一半）。
//                    这一组有 .expected（一行，错误消息的关键片段）。
//   4. `gen/`     —— 第六刀：编译并跑，**进程退出码与整条 stdout** 都与 `tcc -run` 相同。
//                    退出码就是 C 的 `main` 的返回值，只有 8 位（wait(2) 的规矩），
//                    所以用例都把结果收在 0..255。第五片 printf 一通之后 stdout 也进了
//                    对账范围 —— 一个字节的 oracle 会撞（`s % 251` 曾经让一个真错误躲过
//                    二分），整条 stdout 宽得多。
//   5. `gen-bad/` —— 第六刀的阶段边界与真语法错误。同样有 .expected。
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
import { Cpp } from '../../stage0/src/frontend-c/tccpp.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const TCC_DIR = join(root, '.omni-cache', 'tcc-build');
const TCC = join(TCC_DIR, 'tcc');
const CLI = join(root, 'stage0', 'src', 'cli.js');
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
function ours(path, incDirs) {
  const cpp = new Cpp({
    readFile: (p) => read(p),
    includeDirs: incDirs,
  });
  try {
    return { out: cpp.preprocessToText(path, read(path)), warnings: cpp.warnings };
  } catch (e) {
    return { err: e.message };
  }
}

/** tcc -E -P 跑同一份，回 {out} 或 {err} */
function oracle(path, incDirs) {
  const args = ['-E', '-P'];
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

/** 一份文件：我们的输出必须与 tcc 的逐字节相同 */
function compare(group, file, incDirs) {
  const name = `${group}/${basename(file, '.c')}`;
  const path = join(here, group, file);
  if (!hasTcc) {
    skip++;
    return;
  }
  const want = oracle(path, incDirs);
  const got = ours(path, incDirs);
  if (want.err !== undefined) {
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
  ok(`${name} [ours == tcc -E -P] ${n} lines`);
}

// ------------------------------------------------------------ 1. cpp/：与 tcc 逐字节相同

for (const f of pick('cpp')) compare('cpp', f, []);

// ------------------------------------------------------------ 2. inc/：#include 的搜索与守卫

const incDir = join(here, 'inc', 'include');
for (const f of pick('inc')) compare('inc', f, [incDir]);

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
function tccRun(path) {
  const r = spawnSync(TCC, ['-B', TCC_DIR, '-run', path], { encoding: 'utf8' });
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
function cRun(path) {
  const r = spawnSync(process.execPath, [CLI, 'c-run', path], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

for (const f of pick('gen')) {
  const name = `gen/${basename(f, '.c')}`;
  const path = join(here, 'gen', f);
  if (!hasTcc) {
    skip++;
    continue;
  }
  const want = tccRun(path);
  if (isTccDiag(want.err)) {
    bad(name, `    tcc 自己就拒了这份用例：\n${want.err.trim()}`);
    continue;
  }
  const got = cRun(path);
  if (got.code !== want.code) {
    bad(name, `    退出码不同：tcc=${want.code} ours=${got.code}\n${got.err}`);
    continue;
  }
  /* stdout 也要**逐字节**相同（第六刀第五片起）。printf 一通，oracle 就从「一个字节的
   * 退出码」升级成「整条 stdout」—— 之前一次 `s % 251` 的碰撞让一个真错误躲过了二分，
   * 这条轴宽得多。 */
  if (got.out !== want.out) {
    bad(name, `    stdout 不同：\n--- tcc ---\n${want.out}--- ours ---\n${got.out}`);
    continue;
  }
  /* stderr 同样逐字节（第八刀第九片起）。在这之前它是「非空就说明 tcc 拒了」，
   * 而 `fprintf(stderr, …)` 一有，那条口径就把对的用例判成错的。
   * 我们这一侧的运行期错误也走 stderr（`omni: runtime error: …`），
   * 所以这一条**同时**在管「不该有的错误消息」—— 它一出现就与 tcc 的空 stderr 不同。 */
  if (got.err !== want.err) {
    bad(name, `    stderr 不同：\n--- tcc ---\n${want.err}--- ours ---\n${got.err}`);
    continue;
  }
  const n = want.out.length;
  const e = want.err.length;
  ok(`${name} [exit ${want.code}${n > 0 ? ` + ${n}B stdout` : ''}`
    + `${e > 0 ? ` + ${e}B stderr` : ''} == tcc -run]`);
}

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

process.stdout.write(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
}
