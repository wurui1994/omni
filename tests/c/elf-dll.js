#!/usr/bin/env node
/* 接着真的共享库链一份可执行文件，与 tcc 逐字节相同（ADR-0017 第九刀第六十片）。
 *
 * 尺子：先 `<target>-tcc -shared -nostdlib lib.o -o lib.so`，再
 * `<target>-tcc -nostdlib -Wl,-e,main use.o lib.so -o a.out`。
 *
 * 这一路要的东西：读库的 `.dynsym` 与 `DT_SONAME`（`tcc_load_dll`）、
 * `bind_exe_dynsyms`（函数走跳板，数据在自己的 `.bss` 里划一块加一条 `R_*_COPY`）、
 * `bind_libs_dynsyms`（库里提到的、我们有定义的名字要导出）、`DT_NEEDED`。
 *
 *   node tests/c/elf-dll.js
 *   node tests/c/elf-dll.js arm64
 */

import {
  readFileSync, existsSync, mkdtempSync, rmSync, readdirSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { elfExe } from '../../src/core/link/elf_exe.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CROSS = join(root, '.omni-cache', 'tcc-cross');
/* 位置无关那一路的尺子是另一份交叉编译器（见 `tests/c/elf-flags.js` 的说明）：
 * `bind_exe_dynsyms` 头一句 `if (is_PIE) continue` —— 库里那些名字既不走跳板，
 * 也不往自己的 `.bss` 里拷，全交给 GOT。 */
const PIE = join(root, '.omni-cache', 'tcc-pie');

const TARGETS = [
  { name: 'x86_64-linux', tcc: 'x86_64-tcc' },
  { name: 'arm64-linux', tcc: 'arm64-tcc' },
  /* 32 位那两个（第九刀第七十五片）：读库那一段的 `Elf32_Sym` 与八字节一条的
   * `.dynamic`，`R_386_COPY`/`R_ARM_COPY` 那条落在自己的 `.bss` 上。 */
  { name: 'i386-linux', tcc: 'i386-tcc' },
  { name: 'arm-linux', tcc: 'arm-tcc' },
  /* riscv64（第九刀第七十六片）。 */
  { name: 'riscv64-linux', tcc: 'riscv64-tcc' },
];

const filters = process.argv.slice(2).filter((x) => !x.startsWith('-'));
const keep = (s) => filters.length === 0 || filters.some((f) => s.includes(f));

if (!existsSync(CROSS)) {
  process.stdout.write('c/elf-dll: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

/** `elf-dll/` 里成对的两份：`NN-名字-lib.c` 与 `NN-名字-use.c`。 */
const SRC = join(here, 'elf-dll');
const cases = readdirSync(SRC).filter((f) => f.endsWith('-lib.c')).sort()
  .map((f) => f.slice(0, -6));

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const dir = mkdtempSync(join(tmpdir(), 'omni-elfdll-'));
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
    for (const stem of cases) {
      const tag = `${t.name}-${stem}`;
      const run = (args) => spawnSync(tcc, args, { encoding: 'utf8' });
      const libObj = join(dir, `${tag}-lib.o`);
      const useObj = join(dir, `${tag}-use.o`);
      /* 库名进 `DT_NEEDED`，所以两边必须是同一个文件名。 */
      const soPath = join(dir, `lib${tag}.so`);
      if (run(['-c', join(SRC, `${stem}-lib.c`), '-o', libObj]).status !== 0) continue;
      if (run(['-c', join(SRC, `${stem}-use.c`), '-o', useObj]).status !== 0) continue;
      if (run(['-shared', '-nostdlib', libObj, '-o', soPath]).status !== 0) continue;
      /* 两路：普通可执行文件，与位置无关的那一份（尺子换成 tcc-pie 那一份）。 */
      for (const m of [{ name: '', ruler: tcc, opt: {} }, { name: '-pie', ruler: join(PIE, t.tcc), opt: { pie: true } }]) {
        if (!existsSync(m.ruler)) continue;
        const exePath = join(dir, `${tag}${m.name}.out`);
        const ln = spawnSync(
          m.ruler,
          ['-nostdlib', '-Wl,-e,main', useObj, soPath, '-o', exePath],
          { encoding: 'utf8' },
        );
        if (ln.status !== 0 || !existsSync(exePath)) {
          diff++;
          if (diff <= 6) process.stdout.write(`  tcc 自己就链不上 ${tag}${m.name}：${ln.stderr}\n`);
          continue;
        }
        let got;
        try {
          got = elfExe({
            objs: [readFileSync(useObj)],
            entryName: 'main',
            dlls: [{ bytes: readFileSync(soPath), name: soPath }],
            ...m.opt,
          }).bytes;
        } catch (e) {
          diff++;
          if (diff <= 6) process.stdout.write(`  THROW ${tag}${m.name}：${e.message}\n`);
          continue;
        }
        const want = readFileSync(exePath);
        const d = firstDiff(got, want);
        if (d < 0) { same++; ok++; bytesTotal += got.length; continue; }
        diff++;
        if (diff <= 6) {
          process.stdout.write(`  DIFF ${tag}${m.name}：第一个不同在 0x${d.toString(16)}`
            + `（我们 ${got[d]?.toString(16)}，tcc ${want[d]?.toString(16)}；`
            + `${got.length}/${want.length} 字节）\n`);
        }
      }
    }
    process.stdout.write(`  ${t.name}: ${ok} 份可执行文件逐字节相同\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 条相同, ${diff} 条不同（共 ${bytesTotal} 字节）\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/elf-dll: 写出来的可执行文件与 tcc 不一样\n');
  process.exitCode = 1;
}
