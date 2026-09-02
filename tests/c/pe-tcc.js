#!/usr/bin/env node
/* 用我们的链接器把 **tcc 自己** 链出来（ADR-0017 第九刀第五十二片）。
 *
 * `tests/c/pe-exe.js` 对的是 `gen/` 里那些几十行的用例。这一份换成真东西：把 tinycc 整份
 * 源码（`tcc.c`，`ONE_SOURCE`）交叉编成一个 `.o`，再用我们的链接器链成 `.exe`，与
 * `<target>-win32-tcc tcc.o -o tcc.exe` 逐字节比。四十万字节、八十几个导入桩、
 * 二十几万字节的 `.bss`。
 *
 *   node tests/c/pe-tcc.js
 *   node tests/c/pe-tcc.js arm64
 */

import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
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
  { name: 'x86_64-win32', tcc: 'x86_64-win32-tcc', def: 'TCC_TARGET_X86_64' },
  { name: 'arm64-win32', tcc: 'arm64-win32-tcc', def: 'TCC_TARGET_ARM64' },
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
if (src === null || !existsSync(join(CROSS, 'config.h'))) {
  process.stdout.write('c/pe-tcc: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const dir = mkdtempSync(join(tmpdir(), 'omni-petcc-'));
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
    /* `config.h` 与 `tccdefs_.h` 住在交叉编译的那个目录里，所以 `-I` 要带上它。 */
    const flags = [`-B${join(src, 'win32')}`, `-I${CROSS}`, `-I${join(src, 'include')}`, `-I${src}`,
      '-DTCC_TARGET_PE', `-D${t.def}`, '-DONE_SOURCE=1', `-L${CROSS}`];
    const objPath = join(dir, `${t.name}-tcc.o`);
    const one = spawnSync(tcc, [...flags, '-c', join(src, 'tcc.c'), '-o', objPath], { encoding: 'utf8' });
    if (one.status !== 0 || !existsSync(objPath)) {
      process.stdout.write(`  skip ${t.name}（编不出 tcc.o：${(one.stderr ?? '').split('\n')[0]}）\n`);
      continue;
    }
    const exePath = join(dir, `${t.name}-tcc.exe`);
    const link = spawnSync(tcc, [...flags, objPath, '-o', exePath], { encoding: 'utf8' });
    if (link.status !== 0 || !existsSync(exePath)) {
      process.stdout.write(`  skip ${t.name}（tcc 自己链不出来）\n`);
      continue;
    }
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
    let got;
    try {
      const obj = readFileSync(objPath);
      const loaded = peLoad({ objs: [{ path: objPath, bytes: obj }], libtcc1: `${t.name}-libtcc1.a`, open });
      got = peWrite({
        objs: [obj, ...loaded.members.map((m) => m.bytes)],
        dlls: loaded.dlls,
        startName: loaded.entryName,
      });
    } catch (e) {
      diff++;
      process.stdout.write(`  THROW ${t.name}：${e.message}\n`);
      continue;
    }
    const want = readFileSync(exePath);
    const d = firstDiff(got.bytes, want);
    if (d < 0) {
      same++;
      process.stdout.write(`  ${t.name}: ${want.length} 字节逐字节相同`
        + `（${got.infos.length} 节、${got.nthunks} 个导入桩）\n`);
      continue;
    }
    diff++;
    process.stdout.write(`  DIFF ${t.name}：第一个不同在 0x${d.toString(16)}`
      + `（我们 ${got.bytes[d]?.toString(16)}，tcc ${want[d]?.toString(16)}；`
      + `${got.bytes.length}/${want.length} 字节）\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 个目标相同, ${diff} 个不同\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/pe-tcc: 把 tcc 自己链出来这一步与 tcc 不一样\n');
  process.exitCode = 1;
}
