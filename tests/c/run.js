#!/usr/bin/env node
// Omni — C 前端的测试轴（ADR-0017 第五刀）
//
// 这一条与别的套件不同：**它有一个真的 oracle**。同一份 `.c` 交给我们的预处理器和
// `tcc -E -P`，两份输出**逐字节**比。asy 那条线靠的是本机的 `asy`，这里靠的是本机编出来的
// tcc（`.omni-cache/tcc-build/tcc`，源码树在 /Users/wurui/Documents/Lang/reference/tinycc）。
//
// 三组：
//   1. `cpp/`     —— 与 tcc -E -P 逐字节相同。**没有 .expected 文件**：期望值就是 tcc 的输出，
//                    写死一份反而会在 tcc 升级时骗人。
//   2. `cpp-bad/` —— 该拒的要拒，而且拒在正确的理由上（阶段边界与真错误各占一半）。
//                    这一组有 .expected（一行，错误消息的关键片段）。
//   3. `inc/`     —— `#include` 的搜索与守卫：同样与 tcc 比，只是多给一个 -I。
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
const TCC = join(root, '.omni-cache', 'tcc-build', 'tcc');
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

process.stdout.write(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
}
