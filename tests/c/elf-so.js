#!/usr/bin/env node
/* 共享库（ET_DYN）与 tcc 逐字节相同（ADR-0017 第九刀第五十九片）。
 *
 * 尺子：`<target>-tcc -shared -nostdlib a.o -o a.so`。
 *
 * 与可执行文件那两路的差别都在这一条命令里：没有 `.interp`（谁装载库谁自己带解释器），
 * 没有 PT_PHDR/PT_INTERP，装载地址从 0 起，`tcc_add_linker_symbols` 那十几个符号不造
 * （`resolve_common_syms` 末尾那句认 `output_type != TCC_OUTPUT_DLL`），而所有非局部符号
 * 都原样端进 `.dynsym`（`export_global_syms`）—— 库就是靠这张表被别人用的。
 *
 * 用例还是 `gen/` 与 `elf-gen/` 那两摞：共享库不要 `main`，未定义的符号也不算错，
 * 所以能过的比可执行文件那两路多。
 *
 *   node tests/c/elf-so.js
 *   node tests/c/elf-so.js arm64
 */

import {
  readFileSync, existsSync, mkdtempSync, rmSync, readdirSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { elfExe } from '../../stage0/src/link/elf_exe.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CROSS = join(root, '.omni-cache', 'tcc-cross');

const TARGETS = [
  { name: 'x86_64-linux', tcc: 'x86_64-tcc' },
  { name: 'arm64-linux', tcc: 'arm64-tcc' },
];

const filters = process.argv.slice(2).filter((x) => !x.startsWith('-'));
const keep = (s) => filters.length === 0 || filters.some((f) => s.includes(f));

if (!existsSync(CROSS)) {
  process.stdout.write('c/elf-so: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

const DIRS = [join(here, 'gen'), join(here, 'elf-gen')];
const cases = [];
for (const d of DIRS) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d).filter((x) => x.endsWith('.c')).sort()) {
    if (f.endsWith('-b.c')) continue;
    const srcs = [join(d, f)];
    if (f.endsWith('-a.c')) srcs.push(join(d, `${f.slice(0, -4)}-b.c`));
    cases.push(srcs);
  }
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const dir = mkdtempSync(join(tmpdir(), 'omni-elfso-'));
let same = 0;
let diff = 0;
let bytesTotal = 0;
try {
  for (const t of TARGETS) {
    if (!keep(t.name)) continue;
    const tcc = join(CROSS, t.tcc);
    if (!existsSync(tcc)) {
      process.stdout.write(`  skip ${t.name}（${t.tcc} 没建）\n`);
      continue;
    }
    let ok = 0;
    for (const srcs of cases) {
      const stem = `${t.name}-${basename(srcs[0], '.c')}`;
      const objs = [];
      let compiled = true;
      for (let k = 0; k < srcs.length; k++) {
        const objPath = join(dir, `${stem}-${k}.o`);
        const one = spawnSync(tcc, ['-c', srcs[k], '-o', objPath], { encoding: 'utf8' });
        if (one.status !== 0 || !existsSync(objPath)) { compiled = false; break; }
        objs.push(objPath);
      }
      if (!compiled) continue;                                   // 要 libc 的头，编不了
      const soPath = join(dir, `${stem}.so`);
      const ln = spawnSync(tcc, ['-shared', '-nostdlib', ...objs, '-o', soPath],
        { encoding: 'utf8' });
      if (ln.status !== 0 || !existsSync(soPath)) continue;
      let got;
      try {
        got = elfExe({ objs: objs.map((p) => readFileSync(p)), shared: true }).bytes;
      } catch (e) {
        diff++;
        if (diff <= 6) process.stdout.write(`  THROW ${stem}：${e.message}\n`);
        continue;
      }
      const want = readFileSync(soPath);
      const d = firstDiff(got, want);
      if (d < 0) { same++; ok++; bytesTotal += got.length; continue; }
      diff++;
      if (diff <= 6) {
        process.stdout.write(`  DIFF ${stem}：第一个不同在 0x${d.toString(16)}`
          + `（我们 ${got[d]?.toString(16)}，tcc ${want[d]?.toString(16)}；`
          + `${got.length}/${want.length} 字节）\n`);
      }
    }
    process.stdout.write(`  ${t.name}: ${ok} 份共享库逐字节相同\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 条相同, ${diff} 条不同（共 ${bytesTotal} 字节）\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/elf-so: 写出来的共享库与 tcc 不一样\n');
  process.exitCode = 1;
}
