#!/usr/bin/env node
/* 读回来的 ELF 目标文件能**原样写回去**（ADR-0017 第九刀第四十一片）。
 *
 * 这一份是最便宜的一把字节尺子，而且它**与我们的代码生成无关**：拿
 * `<target>-tcc -c` 出的目标文件，用 `readObject` 读进来、`writeSections` 写回去，
 * 两份字节要完全相同。相同就说明我们的 ELF 模型（节头表的每一格、`elf_output_obj`
 * 的排布算式、`.shstrtab` 的偏移）与 tcc 的**完全一致** —— 而这是链接器与可执行文件
 * 写出的地基：往后要拿 tcc 出的 `.o` 喂我们的链接器，再与 tcc 链出来的东西对字节。
 *
 * 六个目标一起跑（tcc 的 `-c` 在所有目标上都写 ELF，见第三十七片）。
 *
 *   node tests/c/elf-roundtrip.js
 *   node tests/c/elf-roundtrip.js arm64-osx
 */

import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { readObject, writeSections } from '../../stage0/src/link/elf.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CROSS = join(root, '.omni-cache', 'tcc-cross');

const TARGETS = [
  { name: 'arm64-osx', tcc: 'arm64-osx-tcc', win32: false },
  { name: 'x86_64-osx', tcc: 'x86_64-osx-tcc', win32: false },
  { name: 'x86_64-linux', tcc: 'x86_64-tcc', win32: false },
  { name: 'arm64-linux', tcc: 'arm64-tcc', win32: false },
  { name: 'x86_64-win32', tcc: 'x86_64-win32-tcc', win32: true },
  { name: 'arm64-win32', tcc: 'arm64-win32-tcc', win32: true },
];

const filters = process.argv.slice(2).filter((x) => !x.startsWith('-'));
const keep = (s) => filters.length === 0 || filters.some((f) => s.includes(f));

/** tinycc 的源码在哪儿：从交叉编译目录的 `config.mak` 里读（`-B` 要用它）。 */
function tccSrc() {
  const mak = join(CROSS, 'config.mak');
  if (!existsSync(mak)) return null;
  const m = /^TOPSRC=(.*)$/m.exec(readFileSync(mak, 'utf8'));
  return m === null ? null : m[1].trim();
}

const src = tccSrc();
if (src === null) {
  process.stdout.write('c/elf-roundtrip: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

const SRC = join(here, 'gen');
const cases = readdirSync(SRC).filter((f) => f.endsWith('.c')).sort();

/** 第一个不同的字节在哪儿；一样就回 -1。 */
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const dir = mkdtempSync(join(tmpdir(), 'omni-elfrt-'));
let same = 0;
let diff = 0;
try {
  for (const t of TARGETS) {
    if (!keep(t.name)) continue;
    const tcc = join(CROSS, t.tcc);
    if (!existsSync(tcc)) {
      process.stdout.write(`  skip ${t.name}（${t.tcc} 没建）\n`);
      continue;
    }
    const B = t.win32 ? `-B${join(src, 'win32')}` : `-B${src}`;
    /* win32 目标的 `-B` 指着 `win32/`，tcc 自己那几个头（`stddef.h`/`stdarg.h`）在
     * `include/` 里，得单独挂上 —— 少了它，凡是 `#include <stdio.h>` 的用例都编不过。 */
    const extra = t.win32 ? [`-I${join(src, 'include')}`] : [];
    let ok = 0;
    for (const c of cases) {
      const refPath = join(dir, `${t.name}-${basename(c, '.c')}.o`);
      const ref = spawnSync(tcc, [B, ...extra, '-c', join(SRC, c), '-o', refPath], { encoding: 'utf8' });
      /* tcc 自己都编不过的用例不算账（有些要它没有的头文件）。 */
      if (ref.status !== 0 || !existsSync(refPath)) continue;
      const want = readFileSync(refPath);
      const read = readObject(want);
      const got = writeSections(read.machine, read.secs);
      const at = firstDiff(got, want);
      if (at < 0) {
        same++;
        ok++;
        continue;
      }
      diff++;
      if (diff <= 8) {
        process.stdout.write(`  DIFF ${t.name} ${c}：tcc ${want.length} 字节 / 我们写回 `
          + `${got.length} 字节，第一个不同在 0x${at.toString(16)}\n`);
      }
    }
    process.stdout.write(`  ${t.name}: ${ok} 条往返逐字节相同\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 条相同, ${diff} 条不同\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/elf-roundtrip: 往返不是逐字节的 —— ELF 模型缺了一格\n');
  process.exitCode = 1;
}
