#!/usr/bin/env node
/* 整份 `.dll` 与 tcc 逐字节相同（ADR-0017 第九刀第六十四片）。
 *
 * 尺子：`<target>-win32-tcc -shared a.o -o a.dll`。与 `.exe` 那一路（`pe-exe.js`）差在
 * 五处，全在 `tccpe.c` 里问「是不是 `PE_DLL`」：
 *
 *  - `pe_set_options`：映像基址换成 `IMAGE_BASE_DLL`（x86_64 0x10000000、
 *    arm64 0x180000000），`subsystem` 换成 2。
 *  - `pe_assign_addresses`：`.reloc` 一定建 —— 哪怕一条都没装。
 *  - `pe_build_exports`：thunk 节里导入表后面再接一张导出表（对到 16），里面是按
 *    `strcmp` 排过的那些 `__declspec(dllexport)` 符号。
 *  - `pe_write`：`Characteristics` 换成 `CHARACTERISTICS_DLL`，而且只要 `pe->reloc`
 *    **建过**就把 `RELOCS_STRIPPED` 抹掉。
 *  - `pe_add_runtime`：入口符号是 `_dllstart`（`PE_STDSYM("__dllstart","@12")` 削掉
 *    头一个下划线），从 `libtcc1.a` 里的 `dllcrt1.o` 来。
 *
 * 案例有两拨：`gen/`（不导出任何东西，只看头与入口）与 `pe-gen/`（专门造导出表）。
 * 两拨都自带 `_dllstart` 或者从 `libtcc1.a` 里拉 `dllcrt1.o`。
 *
 *   node tests/c/pe-dll.js
 *   node tests/c/pe-dll.js arm64
 */

import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { peLoad } from '../../stage0/src/link/pe_load.js';
import { peWrite } from '../../stage0/src/link/pe_link.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CROSS = join(root, '.omni-cache', 'tcc-cross');

const TARGETS = [
  { name: 'x86_64-win32', tcc: 'x86_64-win32-tcc' },
  { name: 'arm64-win32', tcc: 'arm64-win32-tcc' },
  { name: 'i386-win32', tcc: 'i386-win32-tcc' },
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
  process.stdout.write('c/pe-dll: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

/** `pe-gen/` 专门造导出表，`gen/` 与 `elf-gen/` 那两拨顺带把普通的 DLL 也过一遍。 */
const cases = ['pe-gen', 'gen', 'elf-gen'].flatMap((d) => readdirSync(join(here, d))
  .filter((f) => f.endsWith('.c')).sort()
  .map((f) => ({ dir: join(here, d), file: f })));

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const dir = mkdtempSync(join(tmpdir(), 'omni-pedll-'));
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
    const flags = [`-B${join(src, 'win32')}`, `-I${join(src, 'include')}`, `-L${CROSS}`];
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
    for (const c of cases) {
      const stem = `${t.name}-${basename(c.file, '.c')}`;
      const objPath = join(dir, `${stem}.o`);
      const one = spawnSync(tcc, [...flags, '-c', join(c.dir, c.file), '-o', objPath], { encoding: 'utf8' });
      if (one.status !== 0 || !existsSync(objPath)) continue;
      /* 导出表里写的是**输出文件的基名**，所以两边必须是同一个名字。 */
      const dllPath = join(dir, `${stem}.dll`);
      const link = spawnSync(tcc, [...flags, '-shared', objPath, '-o', dllPath], { encoding: 'utf8' });
      if (link.status !== 0 || !existsSync(dllPath)) {
        /* tcc 在 win32 上本来就链不上的几份（`vsscanf`、`__builtin_alloca` 不在
         * `msvcrt.def` 与 `libtcc1.a` 里）—— 可执行文件那一路也一样，跳过。 */
        skipped++;
        continue;
      }
      let got;
      try {
        const obj = readFileSync(objPath);
        const loaded = peLoad({
          objs: [{ path: objPath, bytes: obj }],
          libtcc1: `${t.name}-libtcc1.a`,
          open,
          dll: true,
        });
        got = peWrite({
          objs: [obj, ...loaded.members.map((m) => m.bytes)],
          dlls: loaded.dlls,
          startName: loaded.entryName,
          dll: true,
          outName: dllPath,
        }).bytes;
      } catch (e) {
        diff++;
        if (diff <= 6) process.stdout.write(`  THROW ${stem}：${e.message}\n`);
        continue;
      }
      const want = readFileSync(dllPath);
      const d = firstDiff(got, want);
      if (d < 0) { same++; ok++; bytesTotal += got.length; continue; }
      diff++;
      if (diff <= 6) {
        process.stdout.write(`  DIFF ${stem}：第一个不同在 0x${d.toString(16)}`
          + `（我们 ${got[d]?.toString(16)}，tcc ${want[d]?.toString(16)}；`
          + `${got.length}/${want.length} 字节）\n`);
      }
    }
    process.stdout.write(`  ${t.name}: ${ok} 份 .dll 逐字节相同\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 条相同, ${diff} 条不同, ${skipped} 条 tcc 自己就链不上（共 ${bytesTotal} 字节）\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/pe-dll: 写出来的 .dll 与 tcc 不一样\n');
  process.exitCode = 1;
}
