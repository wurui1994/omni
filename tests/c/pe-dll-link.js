#!/usr/bin/env node
/* 接着真的 `.dll` 链一份 `.exe`，与 tcc 逐字节相同（ADR-0017 第九刀第六十七片）。
 *
 * 尺子：先 `<target>-win32-tcc -shared lib.o -o mylib.dll`，再
 * `<target>-win32-tcc use.o mylib.dll -o a.exe`。
 *
 * 这一路要的东西就一件：**认得一份真的 `.dll`**。`pe_load_file` 看开头是不是 `MZ`，
 * 是就走 `pe_load_dll` → `get_dllexports`：读数据目录 0 那张导出表的
 * `AddressOfNames`，一个个名字当成一张 `.def` 里的行，序号一律 0。库名取文件名的
 * 基名（`tcc_basename`），命令行上写的路径不算。
 *
 * 导入表里那一串的次序还是「符号表里先出现的先来」（`pe_check_symbols` 扫的是
 * `.symtab`），跟导出表按 `strcmp` 排过的次序无关 —— `02-order` 就是冲这一格。
 *
 *   node tests/c/pe-dll-link.js
 *   node tests/c/pe-dll-link.js arm64
 */

import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
  process.stdout.write('c/pe-dll-link: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

/** `pe-dll/` 里成对的两份：`NN-名字-lib.c` 与 `NN-名字-use.c`。 */
const SRC = join(here, 'pe-dll');
const cases = readdirSync(SRC).filter((f) => f.endsWith('-lib.c')).sort()
  .map((f) => f.slice(0, -6));

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const dir = mkdtempSync(join(tmpdir(), 'omni-pedlllink-'));
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
    for (const stem of cases) {
      const tag = `${t.name}-${stem}`;
      const run = (args) => spawnSync(tcc, [...flags, ...args], { encoding: 'utf8' });
      const libObj = join(dir, `${tag}-lib.o`);
      const useObj = join(dir, `${tag}-use.o`);
      /* 库名进导入表，所以两边必须是同一个文件名。 */
      const dllPath = join(dir, `${tag}.dll`);
      if (run(['-c', join(SRC, `${stem}-lib.c`), '-o', libObj]).status !== 0) continue;
      if (run(['-c', join(SRC, `${stem}-use.c`), '-o', useObj]).status !== 0) continue;
      if (run(['-shared', libObj, '-o', dllPath]).status !== 0) continue;
      const exePath = join(dir, `${tag}.exe`);
      const ln = run([useObj, dllPath, '-o', exePath]);
      if (ln.status !== 0 || !existsSync(exePath)) {
        diff++;
        if (diff <= 6) process.stdout.write(`  tcc 自己就链不上 ${tag}：${ln.stderr}\n`);
        continue;
      }
      let got;
      try {
        const loaded = peLoad({
          objs: [
            { path: useObj, bytes: new Uint8Array(readFileSync(useObj)) },
            { path: dllPath, bytes: new Uint8Array(readFileSync(dllPath)) },
          ],
          libtcc1: `${t.name}-libtcc1.a`,
          open,
        });
        got = peWrite({
          objs: [...loaded.objs, ...loaded.members.map((m) => m.bytes)],
          dlls: loaded.dlls,
          startName: loaded.entryName,
        }).bytes;
      } catch (e) {
        diff++;
        if (diff <= 6) process.stdout.write(`  THROW ${tag}：${e.message}\n`);
        continue;
      }
      const want = readFileSync(exePath);
      const d = firstDiff(got, want);
      if (d < 0) { same++; ok++; bytesTotal += got.length; continue; }
      diff++;
      if (diff <= 6) {
        process.stdout.write(`  DIFF ${tag}：第一个不同在 0x${d.toString(16)}`
          + `（我们 ${got[d]?.toString(16)}，tcc ${want[d]?.toString(16)}；`
          + `${got.length}/${want.length} 字节）\n`);
      }
    }
    process.stdout.write(`  ${t.name}: ${ok} 份 .exe 逐字节相同\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 条相同, ${diff} 条不同（共 ${bytesTotal} 字节）\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/pe-dll-link: 写出来的 .exe 与 tcc 不一样\n');
  process.exitCode = 1;
}
