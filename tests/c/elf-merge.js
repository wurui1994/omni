#!/usr/bin/env node
/* 目标文件的**并合**与 `tcc -r` 对字节（ADR-0017 第九刀第四十二片）。
 *
 * 这一把尺子与第四十一片一样，**与我们的代码生成无关**：并合的输入是
 * `<target>-tcc -c` 出来的目标文件，一份是 `gen/` 里的用例，一份是这儿现造的
 * 小陪衬（几个函数、几个全局、几个静态、一个未定义的外部符号，好把 `set_elf_sym`
 * 的几条岔路都走到）。同样的输入、同样的目标，`tcc -r a.o b.o -o m.o` 出来的字节
 * 应当唯一 —— 于是我们的 `mergeObjects` 只要有一格不对就会露出来。
 *
 *   node tests/c/elf-merge.js
 *   node tests/c/elf-merge.js arm64-osx
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { mergeObjects } from '../../src/core/link/elf_merge.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CROSS = join(root, '.omni-cache', 'tcc-cross');

const TARGETS = [
  { name: 'arm64-osx', tcc: 'arm64-osx-tcc', win32: false, unwind: false },
  { name: 'x86_64-osx', tcc: 'x86_64-osx-tcc', win32: false, unwind: false },
  { name: 'x86_64-linux', tcc: 'x86_64-tcc', win32: false, unwind: true },
  { name: 'arm64-linux', tcc: 'arm64-tcc', win32: false, unwind: true },
  { name: 'x86_64-win32', tcc: 'x86_64-win32-tcc', win32: true, unwind: false },
  { name: 'arm64-win32', tcc: 'arm64-win32-tcc', win32: true, unwind: false },
  /* 32 位那四个（第九刀第七十二片）：`.o` 是 ELF32 —— 头短 12 字节、节头短 24、
   * 符号 16 字节，重定位是 `Elf32_Rel`（8 字节，加数写在被修的字节里）。arm 那两个
   * 还带 `e_flags`，而且 tcc 在 arm 上**不造** `.eh_frame`（`TCC_EH_FRAME` 关着）。 */
  { name: 'i386-linux', tcc: 'i386-tcc', win32: false, unwind: true },
  { name: 'arm-linux', tcc: 'arm-tcc', win32: false, unwind: false },
  { name: 'i386-win32', tcc: 'i386-win32-tcc', win32: true, unwind: false },
  { name: 'arm-wince', tcc: 'arm-wince-tcc', win32: true, unwind: false },
  /* riscv64（第九刀第七十六片）：ELF64，`.eh_frame` 照造，多一节 `.riscv.attributes`。 */
  { name: 'riscv64-linux', tcc: 'riscv64-tcc', win32: false, unwind: true },
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
  process.stdout.write('c/elf-merge: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

/* 陪衬：代码 / 可写数据 / 只读数据 / bss / 静态（局部符号） / 未定义的外部符号。 */
const HELPER = `int mate_g = 7;
const char mate_ro[] = "mate";
int mate_bss[16];
static int mate_hidden = 3;
static int mate_hid2;
int mate_add(int a, int b) { return a + b + mate_hidden + mate_hid2; }
extern int mate_ext(int);
int mate_call(int a) { return mate_ext(a) + mate_g + mate_ro[0] + mate_bss[0]; }
`;

const SRC = join(here, 'gen');
const cases = readdirSync(SRC).filter((f) => f.endsWith('.c')).sort();

/** 第一个不同的字节在哪儿；一样就回 -1。 */
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const dir = mkdtempSync(join(tmpdir(), 'omni-elfmg-'));
let same = 0;
let diff = 0;
try {
  const matePath = join(dir, 'mate.c');
  writeFileSync(matePath, HELPER);
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
    const F = t.win32 ? [B, `-I${join(src, 'include')}`] : [B];
    const mateObj = join(dir, `${t.name}-mate.o`);
    const mate = spawnSync(tcc, [...F, '-c', matePath, '-o', mateObj], { encoding: 'utf8' });
    if (mate.status !== 0) {
      process.stdout.write(`  skip ${t.name}（陪衬都编不过：${mate.stderr.trim()}）\n`);
      continue;
    }
    const mateBytes = readFileSync(mateObj);
    let ok = 0;
    for (const c of cases) {
      const objPath = join(dir, `${t.name}-${basename(c, '.c')}.o`);
      const one = spawnSync(tcc, [...F, '-c', join(SRC, c), '-o', objPath], { encoding: 'utf8' });
      /* tcc 自己都编不过的用例不算账（有些要它没有的头文件）。 */
      if (one.status !== 0 || !existsSync(objPath)) continue;
      const wantPath = join(dir, `${t.name}-${basename(c, '.c')}-m.o`);
      const r = spawnSync(tcc, [...F, '-r', objPath, mateObj, '-o', wantPath], { encoding: 'utf8' });
      if (r.status !== 0 || !existsSync(wantPath)) continue;
      const want = readFileSync(wantPath);
      let got;
      try {
        got = mergeObjects([readFileSync(objPath), mateBytes], {
          rdata: t.win32 ? '.rdata' : '.data.ro',
          unwind: t.unwind,
        });
      } catch (e) {
        diff++;
        if (diff <= 8) process.stdout.write(`  THROW ${t.name} ${c}：${e.message}\n`);
        continue;
      }
      const at = firstDiff(got, want);
      if (at < 0) {
        same++;
        ok++;
        continue;
      }
      diff++;
      if (diff <= 8) {
        process.stdout.write(`  DIFF ${t.name} ${c}：tcc ${want.length} 字节 / 我们 `
          + `${got.length} 字节，第一个不同在 0x${at.toString(16)}\n`);
      }
    }
    process.stdout.write(`  ${t.name}: ${ok} 条并合逐字节相同\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 条相同, ${diff} 条不同\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/elf-merge: 并合不是逐字节的 —— 与 tcc -r 差了一格\n');
  process.exitCode = 1;
}
