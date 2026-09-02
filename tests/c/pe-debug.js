#!/usr/bin/env node
/* PE 上的 `-g`：`.stab` / `.stabstr` 与那张 COFF 符号表，逐字节与 tcc 相同
 * （ADR-0017 第九刀第六十九片）。
 *
 * 尺子：`<target>-win32-tcc -g a.o -o a.exe`（Windows 上 tcc 的 `-g` 出的是 **stabs**，
 * 不是 dwarf）。这一路牵出四件事：
 *
 *  - `tccelf_new` 在 `-g` 时就调 `tcc_debug_new`：`.stab` 与 `.stabstr` 一开始就建好，
 *    而且**先放一条全 0 的 `Stab_Sym`**（12 字节）、`.stabstr` 起手一个 `\0`。于是并
 *    出来的两节比几份输入加起来各长 12 与 1 字节。
 *  - 每份目标文件的 `.stab` 接进来之后，里面的 `n_strx` 要加上它的 `.stabstr` 落在
 *    并出来那一节里的起点（`tcc_load_object_file` 末尾那一段）。`01-a`/`01-b` 就是
 *    冲这一格 —— 两份都带 stabs。
 *  - 调试那一类（`sec_debug`）**从不与前一节并条**，一节一条节表项、各自对到
 *    `SectionAlignment`。
 *  - 文件最后接一张 COFF 符号表（`pe_add_coffsym`）：一条 18 字节，只收
 *    `STB_GLOBAL`，`n_value` 是节内偏移、`n_scnum` 是节表里第几条。名字超过 8 字节
 *    的进 `.coffstr`；节名超过 8 字节的也进那张表，写成 `/<偏移>` ——
 *    `elf-gen/11-sections.c` 的 `.init_array` 就是。
 *
 * 还有一格是「谁在什么时候进符号表」：入口符号 `_start` 是命令行上那几个目标文件都
 * 装完、库还没扫的那一刻加进去的，`tcc_add_linker_symbols` 那一批（`_etext`、
 * `__start_*` …）是**表里没有也要建**。不带 `-g` 时这些都看不见，带上就看得见了。
 *
 *   node tests/c/pe-debug.js
 *   node tests/c/pe-debug.js arm64
 */

import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { peLoad, PE_GUI } from '../../stage0/src/link/pe_load.js';
import { peWrite } from '../../stage0/src/link/pe_link.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CROSS = join(root, '.omni-cache', 'tcc-cross');

const TARGETS = [
  { name: 'x86_64-win32', tcc: 'x86_64-win32-tcc' },
  { name: 'arm64-win32', tcc: 'arm64-win32-tcc' },
];

const filters = process.argv.slice(2).filter((x) => !x.startsWith('-'));
const keep = (s) => filters.length === 0 || filters.some((f) => s.includes(f));

function tccSrc() {
  const mak = join(CROSS, 'config.mak');
  if (!existsSync(mak)) return null;
  const m = /^TOPSRC=(.*)$/m.exec(readFileSync(mak, 'utf8'));
  return m === null ? null : m[1].trim();
}

const src = tccSrc();
if (src === null) {
  process.stdout.write('c/pe-debug: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

/** 每条一份链接：一个或几个源文件，加上要不要 `-shared`。 */
const CASES = [
  { name: 'global', srcs: [join(here, 'gen', '05-global.c')] },
  { name: 'libc', srcs: [join(here, 'gen', '06-libc.c')] },
  { name: 'float', srcs: [join(here, 'gen', '15-float.c')] },
  /* `.init_array` 的名字超过 8 字节 —— 节表里那一格换成 `/<偏移>`。 */
  { name: 'sections', srcs: [join(here, 'elf-gen', '11-sections.c')] },
  { name: 'weak', srcs: [join(here, 'elf-gen', '12-weak.c')] },
  { name: 'tls', srcs: [join(here, 'elf-gen', '16-tls.c')] },
  /* 两份都带 stabs：第二份的字符串偏移要重新算。 */
  { name: 'two-objs', srcs: [join(here, 'pe-debug', '01-a.c'), join(here, 'pe-debug', '01-b.c')] },
  { name: 'dll', srcs: [join(here, 'gen', '06-libc.c')], dll: true },
  { name: 'dll-two', srcs: [join(here, 'pe-debug', '01-a.c'), join(here, 'pe-debug', '01-b.c')], dll: true },
];

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const dir = mkdtempSync(join(tmpdir(), 'omni-pedebug-'));
let same = 0;
let diff = 0;
let skipped = 0;
let bytesTotal = 0;
try {
  for (const t of TARGETS) {
    if (!keep(t.name)) continue;
    const tcc = join(CROSS, t.tcc);
    if (!existsSync(tcc)) {
      process.stdout.write(`  skip ${t.name}（${t.tcc} 没建）\n`);
      continue;
    }
    const flags = [`-B${join(src, 'win32')}`, `-I${join(src, 'include')}`, `-L${CROSS}`, '-g'];
    const paths = [CROSS, join(src, 'win32', 'lib')];
    const open = (names) => {
      for (const p of paths) {
        for (const n of names) {
          const f = join(p, n);
          if (existsSync(f)) return { path: f, bytes: readFileSync(f) };
        }
      }
      return null;
    };
    let ok = 0;
    for (const c of CASES) {
      if (!keep(c.name)) continue;
      const stem = `${t.name}-${c.name}`;
      const objs = [];
      let bad = false;
      for (const s of c.srcs) {
        const o = join(dir, `${stem}-${basename(s, '.c')}.o`);
        if (spawnSync(tcc, [...flags, '-c', s, '-o', o], { encoding: 'utf8' }).status !== 0) {
          bad = true;
          break;
        }
        objs.push(o);
      }
      if (bad) continue;
      const dll = c.dll === true;
      const outPath = join(dir, `${stem}.${dll ? 'dll' : 'exe'}`);
      const args = [...flags, ...(dll ? ['-shared'] : []), ...objs, '-o', outPath];
      const link = spawnSync(tcc, args, { encoding: 'utf8' });
      if (link.status !== 0 || !existsSync(outPath)) { skipped++; continue; }
      const opt = dll ? { dll: true, outName: outPath } : {};
      let got;
      try {
        const loaded = peLoad({
          objs: objs.map((p) => ({ path: p, bytes: new Uint8Array(readFileSync(p)) })),
          libtcc1: `${t.name}-libtcc1.a`,
          open,
          debug: true,
          ...opt,
        });
        got = peWrite({
          objs: [...loaded.objs, ...loaded.members.map((m) => m.bytes)],
          dlls: loaded.dlls,
          res: loaded.res,
          startName: loaded.entryName,
          gui: loaded.peType === PE_GUI,
          debug: true,
          declare: [{ name: loaded.start, after: loaded.objs.length }],
          ...opt,
        }).bytes;
      } catch (e) {
        diff++;
        if (diff <= 6) process.stdout.write(`  THROW ${stem}：${e.message}\n`);
        continue;
      }
      const want = readFileSync(outPath);
      const d = firstDiff(got, want);
      if (d < 0) { same++; ok++; bytesTotal += got.length; continue; }
      diff++;
      if (diff <= 6) {
        process.stdout.write(`  DIFF ${stem}：第一个不同在 0x${d.toString(16)}`
          + `（我们 ${got[d]?.toString(16)}，tcc ${want[d]?.toString(16)}；`
          + `${got.length}/${want.length} 字节）\n`);
      }
    }
    process.stdout.write(`  ${t.name}: ${ok} 份逐字节相同\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 条相同, ${diff} 条不同, ${skipped} 条 tcc 自己就链不上`
  + `（共 ${bytesTotal} 字节）\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/pe-debug: 写出来的映像与 tcc 不一样\n');
  process.exitCode = 1;
}
