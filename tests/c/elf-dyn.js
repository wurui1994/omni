#!/usr/bin/env node
/* 动态链接的 ELF 可执行文件与 tcc 逐字节相同（ADR-0017 第九刀第五十四片）。
 *
 * 尺子：`<target>-tcc -nostdlib -Wl,-e,main a.o -o a.out`。**没有** `-static` ——
 * tcc 默认就是动态链接，即使一个共享库都没装，它也会把整套家当摆出来：`.interp`、
 * `.dynsym`/`.dynstr`/`.hash`/`.gnu.hash`、`.dynamic`、`.rela.got`、`.eh_frame_hdr`，
 * 八个程序头（PT_PHDR / PT_INTERP / 三个 PT_LOAD / PT_DYNAMIC / PT_GNU_EH_FRAME /
 * PT_GNU_RELRO）。
 *
 *   node tests/c/elf-dyn.js
 *   node tests/c/elf-dyn.js arm64
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
  /* 32 位那两个（第九刀第七十五片）：`.interp` 是 `/lib/ld-linux.so.2` 与
   * `/lib/ld-linux.so.3`，GOT 一格四字节，`.rel.got` 一条八字节。 */
  { name: 'i386-linux', tcc: 'i386-tcc' },
  { name: 'arm-linux', tcc: 'arm-tcc' },
];

const filters = process.argv.slice(2).filter((x) => !x.startsWith('-'));
const keep = (s) => filters.length === 0 || filters.some((f) => s.includes(f));

if (!existsSync(CROSS)) {
  process.stdout.write('c/elf-dyn: 交叉编译器还没建，跳过\n');
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

const dir = mkdtempSync(join(tmpdir(), 'omni-elfdyn-'));
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
    const link = ['-nostdlib', '-Wl,-e,main'];
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
      if (!compiled) continue;
      const exePath = join(dir, `${stem}.out`);
      const ln = spawnSync(tcc, [...link, ...objs, '-o', exePath], { encoding: 'utf8' });
      if (ln.status !== 0 || !existsSync(exePath)) continue;
      let got;
      try {
        got = elfExe({ objs: objs.map((p) => readFileSync(p)), entryName: 'main' }).bytes;
      } catch (e) {
        diff++;
        if (diff <= 6) process.stdout.write(`  THROW ${stem}：${e.message}\n`);
        continue;
      }
      const want = readFileSync(exePath);
      const d = firstDiff(got, want);
      if (d < 0) { same++; ok++; bytesTotal += got.length; continue; }
      diff++;
      if (diff <= 6) {
        process.stdout.write(`  DIFF ${stem}：第一个不同在 0x${d.toString(16)}`
          + `（我们 ${got[d]?.toString(16)}，tcc ${want[d]?.toString(16)}；`
          + `${got.length}/${want.length} 字节）\n`);
      }
    }
    process.stdout.write(`  ${t.name}: ${ok} 份可执行文件逐字节相同\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 条相同, ${diff} 条不同（共 ${bytesTotal} 字节）\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/elf-dyn: 写出来的可执行文件与 tcc 不一样\n');
  process.exitCode = 1;
}
