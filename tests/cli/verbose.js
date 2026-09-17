#!/usr/bin/env node
/* `-v` 的账要**记到最后一步**（ADR-0018 分片 2 的那张表 + 老的 `vStep`）。
 *
 * 为什么单独一份：`VERBOSE` 是模块级的，而链接那一步是**嵌套调一趟 `main`**
 * （`buildSelf` 里 `subMain(['c','link',…,'-q'])`）。内层按自己那串 argv 重置一次
 * `VERBOSE`，外层的 `-v` 就没了 —— 量到的原话是 `run -v --backend c` 在
 * `runtime .o` 之后直接跳到程序输出，**`c link` 与 `exec` 两行都不见**，
 * 也就是「链接花了多久、跑了多久」这条腿上一直没有数。
 *
 * 判据按**步骤名**比，不比耗时（那是机器的事）：
 *   - c 那条腿最后一行是 `exec …`，中间有 `c link`
 *   - js 那条腿最后一行是 `exec in-process`
 *   - 两条腿都不许把 `pipeline …`（那张表的表头）印第二遍
 *
 *   node tests/cli/verbose.js
 */

import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const SRC = join(root, 'bench', 'fib.omni');

let pass = 0;
let fail = 0;
const eq = (what, got, want) => {
  if (got === want) { pass++; process.stdout.write(`  ok   ${what}\n`); return; }
  fail++;
  process.stdout.write(`  FAIL ${what}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}\n`);
};

/** 跑一趟，回 stderr 上那些 `omni: …` 的**步骤名**（去掉耗时与路径）。 */
function steps(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) {
    process.stdout.write(`  （这一趟退出码 ${r.status}）\n${r.stderr}\n`);
    return { lines: [], raw: r.stderr ?? '' };
  }
  const lines = (r.stderr ?? '').split('\n')
    .filter((l) => l.startsWith('omni: '))
    .map((l) => l.slice(6).split('  ')[0]);
  return { lines, raw: r.stderr ?? '' };
}

{
  const { lines, raw } = steps(['run', SRC, '-v', '--backend', 'c']);
  /* 最后那一行是 `exec <可执行文件>  exit=0` —— 路径里没有两个空格，所以只比开头。 */
  eq('c 那条腿：最后一步是 exec', (lines[lines.length - 1] ?? '').startsWith('exec '), true);
  eq('c 那条腿：链接那一步有账', lines.some((l) => l.startsWith('c link')), true);
  eq('c 那条腿：codegen 那一步有账', lines.some((l) => l === 'backend c'), true);
  /* 嵌套那一趟不许再起一张表 —— 起了就会多一行 `pipeline …`。 */
  eq('c 那条腿：pipeline 表头最多一份',
    (raw.match(/pipeline {2}/g) ?? []).length <= 1, true);
}
{
  const { lines } = steps(['run', SRC, '-v', '--backend', 'js']);
  eq('js 那条腿：最后一步是 exec in-process', lines[lines.length - 1] ?? '', 'exec in-process (node host, new Function)');
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
