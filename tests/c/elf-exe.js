#!/usr/bin/env node
/* 整份 ELF 可执行文件与 tcc 逐字节相同（ADR-0017 第九刀第五十三片）。
 *
 * 尺子：`<target>-tcc -static -nostdlib -Wl,-e,main a.o -o a.out`。
 *
 * 为什么是这三个开关：交叉编译的 Linux 目标在 macOS 上没有 libc 可装，动态那一整套
 * （`.interp`/`.dynsym`/`.dynamic`/`.got`）也还没写；`-static -nostdlib` 剩下的正好是
 * 「摆放 + 写出」这一段，而那一段是三个格式共用的骨架。没有 crt 也就没有 `_start`，
 * 入口只能自己指。
 *
 *   node tests/c/elf-exe.js
 *   node tests/c/elf-exe.js arm64
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
  /* 32 位那两个（第九刀第七十五片）：ELF32 的头 52、程序头 32（`p_flags` 挪到末尾）、
   * 节头 40，装载地址 i386 是 0x08048000、arm 是 0x00010000。 */
  { name: 'i386-linux', tcc: 'i386-tcc' },
  { name: 'arm-linux', tcc: 'arm-tcc' },
];

const filters = process.argv.slice(2).filter((x) => !x.startsWith('-'));
const keep = (s) => filters.length === 0 || filters.some((f) => s.includes(f));

if (!existsSync(CROSS)) {
  process.stdout.write('c/elf-exe: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

/** 不带 libc 也能编的那些用例：`gen/` 里的前几条，加上专为这一片写的几份。
 *
 * 名字以 `-a.c` 结尾的那一份要跟同名的 `-b.c` 一起链 —— 多个目标文件的并合、
 * 跨文件的调用与共享变量都在那一条上。 */
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

const dir = mkdtempSync(join(tmpdir(), 'omni-elfexe-'));
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
    const link = ['-static', '-nostdlib', '-Wl,-e,main'];
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
      const exePath = join(dir, `${stem}.out`);
      const ln = spawnSync(tcc, [...link, ...objs, '-o', exePath], { encoding: 'utf8' });
      if (ln.status !== 0 || !existsSync(exePath)) continue;     // 要 libc 的符号，链不了
      let got;
      try {
        got = elfExe({ objs: objs.map((p) => readFileSync(p)), entryName: 'main', static: true })
          .bytes;
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
  process.stdout.write('c/elf-exe: 写出来的可执行文件与 tcc 不一样\n');
  process.exitCode = 1;
}
