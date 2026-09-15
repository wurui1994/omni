// tests/c/selfpp.js —— 拿 tinycc **自己的源码**当尺子（ADR-0017 第九刀第九十一片）
//
// 这一组与 `tests/c/run.js` 里那些用例的区别只有一个：输入不是我们写的探针，而是
// **真实的、几千行、层层套着系统头的 C**。第九刀那一路（`-E` 的每一个细节）到这儿
// 才算被真正称过 —— 一份 `tcc.c` 展开出来两万九千行，任何一处宏、`#if`、空白、
// 记号粘连出错都会立刻显形。
//
// 口径：同一份 `.c`，两边都**自己去找头文件**（只给 `-I <构建目录>`，那是
// `config.h` 所在的地方），出来的字节必须一样。
//
//   tcc:  tcc -B <构建目录> -I <构建目录> -E -P x.c
//   我们: omni cpp x.c -P -I <构建目录>
//
// `-B` 是给 tcc 指它自己那份 `include/`（那个 tcc **没装**，`/usr/local/lib/tcc`
// 不存在）—— 于是两边的系统头搜索表形状相同：自带的一份在前、SDK 的 `/usr/include`
// 在后。我们自带的那份是 `src/include/`。
//
// 源码树或构建不在就整组跳过（印 skip 并说明），不假过。
//
//   node tests/c/selfpp.js
//   node tests/c/selfpp.js tccpp   # 只跑名字里带 tccpp 的

import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { refDir } from '../lib/refsrc.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const TCC_DIR = join(root, '.omni-cache', 'tcc-build');
const TCC = join(TCC_DIR, 'tcc');
const CLI = join(root, 'src', 'core', 'cli.js');
/* 源码树的位置与 ADR-0017 里记的一致；`TINYCC_SRC` 可以指到别处。 */
const SRC = refDir('tinycc', 'TINYCC_SRC');
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

if (!existsSync(TCC) || !existsSync(join(SRC, 'tccpp.c'))) {
  process.stdout.write('  skip 整组：尺子不在\n');
  process.stdout.write(`       tcc: ${TCC}\n       源码: ${SRC}\n`);
  process.stdout.write('       建它：见 ADR-0017「量出来的基线」那一节的树外构建\n');
  process.exit(0);
}

const files = readdirSync(SRC).filter((f) => f.endsWith('.c')).sort()
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)));

/** 前 n 行不同的地方，用来看失败在哪儿（整份 diff 太长，印不动）。 */
function firstDiff(a, b, n = 6) {
  const xs = a.split('\n');
  const ys = b.split('\n');
  const out = [];
  for (let i = 0; i < Math.max(xs.length, ys.length) && out.length < n; i++) {
    if (xs[i] !== ys[i]) out.push(`    第 ${i + 1} 行：\n      tcc : ${xs[i]}\n      ours: ${ys[i]}`);
  }
  return out.join('\n');
}

for (const f of files) {
  const path = join(SRC, f);
  const w = spawnSync(TCC, ['-B', TCC_DIR, '-I', TCC_DIR, '-E', '-P', path],
    { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (w.status !== 0) {
    /* tcc 自己就编不过的（`il-gen.c` 那种早就不在构建里的文件）—— 没有尺子，跳过。 */
    skip++;
    process.stdout.write(`  skip ${f}（tcc 自己就拒了：${(w.stderr ?? '').trim().split('\n')[0]}）\n`);
    continue;
  }
  const g = spawnSync(process.execPath, [CLI, 'cpp', path, '-P', '-I', TCC_DIR],
    { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (g.status !== 0) {
    bad(f, `    我们拒了，tcc 没拒：\n${(g.stderr ?? '').trim().split('\n').slice(0, 4).join('\n')}`);
    continue;
  }
  if (g.stdout !== w.stdout) {
    const wl = w.stdout.split('\n').length;
    const gl = g.stdout.split('\n').length;
    bad(f, `    行数 tcc=${wl} ours=${gl}\n${firstDiff(w.stdout, g.stdout)}`);
    continue;
  }
  ok(`${f} [ours == tcc -E -P] ${w.stdout.split('\n').length - 1} lines`);
}

if (failures.length > 0) {
  process.stdout.write('\n');
  for (const f of failures) process.stdout.write(`${f}\n`);
}
process.stdout.write(`\n${pass} passed, ${fail} failed${skip > 0 ? `, ${skip} skipped` : ''}\n`);
process.exit(fail > 0 ? 1 : 0);
