#!/usr/bin/env node
/* PE 的那几个链接器开关，逐字节与 tcc 相同（ADR-0017 第九刀第六十六片）。
 *
 * 十种走法，每一种都拿 `<target>-win32-tcc <开关> a.o -o a.exe` 当尺子：
 *
 *  - `--stack=N`（十进制）→ `SizeOfStackReserve`
 *  - `-subsystem=gui` → `Subsystem` 2；`peLoad` 还要跟着多接 `user32` / `gdi32`
 *  - `-subsystem=native` → `Subsystem` 1，**两个对齐都变 0x20**
 *  - `-subsystem=efiapp` → `Subsystem` 10，映像基址变 0
 *  - `--image-base=HEX`（也叫 `-Ttext=`）→ 最后说话的那个基址
 *  - `--file-alignment=HEX` / `--section-alignment=HEX`
 *  - `--large-address-aware` → `Characteristics |= 0x20`
 *  - `--nxcompat` / `--tsaware` / `--dynamicbase` → `DllCharacteristics`；
 *    其中 `--dynamicbase`（0x40）还会让 x86_64 也长出一节 `.reloc`
 *  - `-e,main` → 入口符号换人（于是 crt 那一套根本不用拉）
 *
 *   node tests/c/pe-flags.js
 *   node tests/c/pe-flags.js arm64
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

/** arm64-win32 的 `DllCharacteristics` 默认值（`libtcc.c`）。 */
const ARM64_DLLCHARS = 0x8160;

const MODES = [
  { name: 'stack', args: ['-Wl,--stack=2097152'], opt: { stack: 2097152 } },
  { name: 'gui', args: ['-Wl,-subsystem=gui'], opt: { subsystem: 2 } },
  { name: 'native', args: ['-Wl,-subsystem=native'], opt: { subsystem: 1 } },
  { name: 'efiapp', args: ['-Wl,-subsystem=efiapp'], opt: { subsystem: 10 } },
  {
    name: 'image-base',
    args: ['-Wl,--image-base=1000000'],
    opt: { imagebase: 0x1000000 },
  },
  {
    name: 'file-align',
    args: ['-Wl,--file-alignment=1000'],
    opt: { fileAlign: 0x1000 },
  },
  {
    name: 'section-align',
    args: ['-Wl,--section-alignment=2000'],
    opt: { sectionAlign: 0x2000 },
  },
  {
    name: 'large-address-aware',
    args: ['-Wl,--large-address-aware'],
    opt: { peChars: 0x20 },
  },
  { name: 'nxcompat', args: ['-Wl,--nxcompat'], dllChars: 0x100 },
  { name: 'tsaware', args: ['-Wl,--tsaware'], dllChars: 0x8000 },
  { name: 'dynamicbase', args: ['-Wl,--dynamicbase'], dllChars: 0x40 },
  { name: 'entry', args: ['-Wl,-e,main'], opt: { entry: 'main' } },
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
  process.stdout.write('c/pe-flags: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

/* 十二种走法乘上案例乘上目标，链的次数长得快，所以案例只挑六份有代表性的：
 * 全局量、要 libc、浮点、自己命名的节、弱符号、线程局部。 */
const cases = [
  join(here, 'gen', '05-global.c'),
  join(here, 'gen', '06-libc.c'),
  join(here, 'gen', '15-float.c'),
  join(here, 'elf-gen', '11-sections.c'),
  join(here, 'elf-gen', '12-weak.c'),
  join(here, 'elf-gen', '16-tls.c'),
];

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const dir = mkdtempSync(join(tmpdir(), 'omni-peflags-'));
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
    for (const m of MODES) {
      if (!keep(m.name)) continue;
      /* `DllCharacteristics` 是「默认值再或上这一位」。 */
      const base = t.name.startsWith('arm64') ? ARM64_DLLCHARS : 0;
      const opt = m.dllChars === undefined ? m.opt : { dllChars: base | m.dllChars };
      for (const c of cases) {
        const stem = `${t.name}-${m.name}-${basename(c, '.c')}`;
        const objPath = join(dir, `${stem}.o`);
        if (spawnSync(tcc, [...flags, '-c', c, '-o', objPath], { encoding: 'utf8' }).status !== 0) {
          continue;
        }
        const exePath = join(dir, `${stem}.exe`);
        const link = spawnSync(tcc, [...flags, ...m.args, objPath, '-o', exePath], { encoding: 'utf8' });
        if (link.status !== 0 || !existsSync(exePath)) { skipped++; continue; }
        let got;
        try {
          const obj = readFileSync(objPath);
          const loaded = peLoad({
            objs: [{ path: objPath, bytes: obj }],
            libtcc1: `${t.name}-libtcc1.a`,
            open,
            ...opt,
          });
          got = peWrite({
            objs: [obj, ...loaded.members.map((x) => x.bytes)],
            dlls: loaded.dlls,
            startName: loaded.entryName,
            gui: loaded.peType === PE_GUI,
            ...opt,
          }).bytes;
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
    }
    process.stdout.write(`  ${t.name}: ${ok} 份 .exe 逐字节相同\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 条相同, ${diff} 条不同, ${skipped} 条 tcc 自己就链不上`
  + `（共 ${bytesTotal} 字节）\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/pe-flags: 写出来的 .exe 与 tcc 不一样\n');
  process.exitCode = 1;
}
