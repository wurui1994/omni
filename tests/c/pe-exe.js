#!/usr/bin/env node
/* 整份 `.exe` 与 tcc 逐字节相同（ADR-0017 第九刀第五十片）。
 *
 * 前面几片各对一段：装了什么（四十七）、摆在哪（四十八）、里面是什么（四十九）。这一份
 * 把头补上，然后与 `<target>-win32-tcc a.o -o a.exe` 写出来的文件**整个**比。
 *
 * PE 是三种可执行格式里唯一没有代码签名的 —— 所以「整个文件逐字节相同」这句话在这里
 * 是字面意思，没有要跳过的区段。
 *
 *   node tests/c/pe-exe.js
 *   node tests/c/pe-exe.js arm64
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
  { name: 'x86_64-win32', tcc: 'x86_64-win32-tcc', imagebase: 0x400000, dynamicBase: false },
  { name: 'arm64-win32', tcc: 'arm64-win32-tcc', imagebase: 0x140000000, dynamicBase: true },
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
  process.stdout.write('c/pe-exe: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

/* `gen/` 是要 libc 的那一拨，`elf-gen/` 是专门试链接器的那一拨（弱符号、`.tdata`、
 * 自己命名的节…）。tcc 在 win32 上链不上的几份（`vsscanf` 不在 `msvcrt.def` 里、
 * 只有一半的 `14-multi-a`）会被下面那个 `continue` 跳过。 */
const cases = [
  ...readdirSync(join(here, 'gen')).filter((f) => f.endsWith('.c')).sort()
    .map((f) => join(here, 'gen', f)),
  ...readdirSync(join(here, 'elf-gen')).filter((f) => f.endsWith('.c')).sort()
    .map((f) => join(here, 'elf-gen', f)),
];

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const dir = mkdtempSync(join(tmpdir(), 'omni-peexe-'));
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
    for (const c of cases) {
      const stem = `${t.name}-${basename(c, '.c')}`;
      const objPath = join(dir, `${stem}.o`);
      const one = spawnSync(tcc, [...flags, '-c', c, '-o', objPath], { encoding: 'utf8' });
      if (one.status !== 0 || !existsSync(objPath)) continue;
      const exePath = join(dir, `${stem}.exe`);
      const link = spawnSync(tcc, [...flags, objPath, '-o', exePath], { encoding: 'utf8' });
      if (link.status !== 0 || !existsSync(exePath)) continue;
      let got;
      try {
        const obj = readFileSync(objPath);
        const loaded = peLoad({ objs: [{ path: objPath, bytes: obj }], libtcc1: `${t.name}-libtcc1.a`, open });
        got = peWrite({
          objs: [obj, ...loaded.members.map((m) => m.bytes)],
          dlls: loaded.dlls,
          startName: loaded.entryName,
          imagebase: t.imagebase,
          dynamicBase: t.dynamicBase,
        }).bytes;
      } catch (e) {
        diff++;
        if (diff <= 6) process.stdout.write(`  THROW ${t.name} ${c}：${e.message}\n`);
        continue;
      }
      const want = readFileSync(exePath);
      const d = firstDiff(got, want);
      if (d < 0) { same++; ok++; bytesTotal += got.length; continue; }
      diff++;
      if (diff <= 6) {
        process.stdout.write(`  DIFF ${t.name} ${c}：第一个不同在 0x${d.toString(16)}`
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
  process.stdout.write('c/pe-exe: 写出来的 .exe 与 tcc 不一样\n');
  process.exitCode = 1;
}
