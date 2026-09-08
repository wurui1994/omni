#!/usr/bin/env node
// Omni stage0 — JS 一致性门（ADR-0020 决策 2）
//
// 尺子是 **qjs 的 stdout**，逐字节：同一份 `.js` 交给 qjs 与 `omni run` 各跑一趟，
// 输出必须一模一样。不比我们自己的快照 —— 快照会把"两边一起错"当成通过。
//
//   node tests/js262/run.js              跑全部
//   node tests/js262/run.js symbol       只跑名字里含 symbol 的
//   node tests/js262/run.js --list-red   把当前红的那些印成 known-red 的格式
//
// qjs 从哪儿来：`OMNI_QJS` 指定，或者 PATH 里的 `qjs`，或者
// `reference/quickjs-2026-06-04/qjs`（`make qjs` 编出来的那一份）。找不到就整门跳过 ——
// 没有尺子的时候不假装量过。
//
// known-red.txt：**还没实现**的那些用例一行一个。它们红着不算门失败（这一整轴是
// 长期工程，ADR-0020 的 P1..P6），但绿了就要报出来 —— 那是"该把这一行删掉"的信号。

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = process.env.OMNI_CLI || join(root, 'src', 'core', 'cli.js');
const args = process.argv.slice(2);
const filters = args.filter((a) => !a.startsWith('-'));
const listRed = args.includes('--list-red');

function findQjs() {
  if (process.env.OMNI_QJS) return process.env.OMNI_QJS;
  const which = spawnSync('which', ['qjs'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const ref = join(root, '..', '..', 'Documents', 'Lang', 'reference', 'quickjs-2026-06-04', 'qjs');
  if (existsSync(ref)) return ref;
  return null;
}

const QJS = findQjs();
if (QJS === null) {
  process.stdout.write('js262: 没找到 qjs（OMNI_QJS 指一份，或在 quickjs 那棵树里 make qjs）——整门跳过\n');
  process.exit(0);
}

const casesDir = join(here, 'cases');
const redFile = join(here, 'known-red.txt');
const known = existsSync(redFile)
  ? new Set(readFileSync(redFile, 'utf8').split('\n').map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    // 行尾允许写"卡在哪一句"的注释，取第一个记号就是文件名
    .map((l) => l.split(/\s+/)[0]))
  : new Set();

const files = existsSync(casesDir)
  ? readdirSync(casesDir).filter((f) => f.endsWith('.js')).sort()
  : [];

let pass = 0; let fail = 0; let red = 0; let fixed = 0;
const nowRed = [];

for (const f of files) {
  if (filters.length > 0 && !filters.some((x) => f.includes(x))) continue;
  const p = join(casesDir, f);
  const ref = spawnSync(QJS, [p], { encoding: 'utf8' });
  const ours = spawnSync(process.execPath, [CLI, 'run', p, '--timeout', '20'], { encoding: 'utf8', cwd: root });
  const same = (ref.stdout ?? '') === (ours.stdout ?? '');
  if (same) {
    if (known.has(f)) {
      fixed++;
      process.stdout.write(`  绿了 ${f} —— 把它从 tests/js262/known-red.txt 里删掉\n`);
    } else {
      pass++;
      process.stdout.write(`  ok   ${f}\n`);
    }
    continue;
  }
  nowRed.push(f);
  if (known.has(f)) { red++; continue; }
  fail++;
  process.stdout.write(`  FAIL ${f}\n`);
  process.stdout.write(`    qjs : ${JSON.stringify(ref.stdout ?? '')}\n`);
  process.stdout.write(`    omni: ${JSON.stringify(ours.stdout ?? '')}\n`);
  const err = (ours.stderr ?? '').trim().split('\n')[0];
  if (err) process.stdout.write(`    err : ${err}\n`);
}

if (listRed) {
  process.stdout.write('\n# 当前红的（贴进 tests/js262/known-red.txt）\n');
  for (const f of nowRed) process.stdout.write(`${f}\n`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed, ${red} known-red`
  + `${fixed > 0 ? `, ${fixed} 已经绿了（该删 known-red 里的行）` : ''}\n`);
process.exitCode = fail > 0 ? 1 : 0;
