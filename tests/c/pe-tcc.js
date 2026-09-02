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
  { name: 'i386-win32', tcc: 'i386-win32-tcc', def: 'TCC_TARGET_I386' },
  { name: 'arm-wince', tcc: 'arm-wince-tcc', def: 'TCC_TARGET_ARM' },
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

/* tinycc 拆开编的那一份：非 `ONE_SOURCE` 时这几个 `.c` 各出一个 `.o`。
 * 代码生成与汇编那三个是按目标挑的（`Makefile` 里的 `$(X)_FILES`）。 */
const PARTS = ['tcc', 'libtcc', 'tccpp', 'tccgen', 'tccdbg', 'tccelf', 'tccasm', 'tccrun', 'tccpe'];
const GEN = {
  'x86_64-win32': ['x86_64-gen', 'x86_64-link', 'i386-asm'],
  'arm64-win32': ['arm64-gen', 'arm64-link', 'arm64-asm'],
  'i386-win32': ['i386-gen', 'i386-link', 'i386-asm'],
  'arm-wince': ['arm-gen', 'arm-link', 'arm-asm'],
};

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const dir = mkdtempSync(join(tmpdir(), 'omni-petcc-'));
let same = 0;
let diff = 0;

/** 一组源文件各编一个 `.o`，tcc 链一遍、我们链一遍，逐字节比。 */
function round(t, tcc, one, srcs, label) {
  /* `config.h` 与 `tccdefs_.h` 住在交叉编译的那个目录里，所以 `-I` 要带上它。 */
  const flags = [`-B${join(src, 'win32')}`, `-I${CROSS}`, `-I${join(src, 'include')}`, `-I${src}`,
    '-DTCC_TARGET_PE', `-D${t.def}`, `-DONE_SOURCE=${one}`, `-L${CROSS}`];
  const objPaths = [];
  for (const s of srcs) {
    const p = join(dir, `${t.name}-${label}-${s}.o`);
    const r = spawnSync(tcc, [...flags, '-c', join(src, `${s}.c`), '-o', p], { encoding: 'utf8' });
    if (r.status !== 0 || !existsSync(p)) {
      process.stdout.write(`  skip ${t.name} ${label}（编不出 ${s}.o：${(r.stderr ?? '').split('\n')[0]}）\n`);
      return;
    }
    objPaths.push(p);
  }
  const exePath = join(dir, `${t.name}-${label}.exe`);
  const link = spawnSync(tcc, [...flags, ...objPaths, '-o', exePath], { encoding: 'utf8' });
  if (link.status !== 0 || !existsSync(exePath)) {
    process.stdout.write(`  skip ${t.name} ${label}（tcc 自己链不出来：${(link.stderr ?? '').split('\n')[0]}）\n`);
    return;
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
    const objs = objPaths.map((p) => readFileSync(p));
    const loaded = peLoad({
      objs: objPaths.map((p, i) => ({ path: p, bytes: objs[i] })),
      libtcc1: `${t.name}-libtcc1.a`,
      open,
    });
    got = peWrite({
      objs: [...objs, ...loaded.members.map((m) => m.bytes)],
      dlls: loaded.dlls,
      startName: loaded.entryName,
    });
  } catch (e) {
    diff++;
    process.stdout.write(`  THROW ${t.name} ${label}：${e.message}\n`);
    return;
  }
  const want = readFileSync(exePath);
  const d = firstDiff(got.bytes, want);
  if (d < 0) {
    same++;
    process.stdout.write(`  ${t.name} ${label}: ${want.length} 字节逐字节相同`
      + `（${objPaths.length} 个 .o、${got.infos.length} 节、${got.nthunks} 个导入桩）\n`);
    return;
  }
  diff++;
  process.stdout.write(`  DIFF ${t.name} ${label}：第一个不同在 0x${d.toString(16)}`
    + `（我们 ${got.bytes[d]?.toString(16)}，tcc ${want[d]?.toString(16)}；`
    + `${got.bytes.length}/${want.length} 字节）\n`);
}

try {
  for (const t of TARGETS) {
    if (!keep(t.name)) continue;
    const tcc = join(CROSS, t.tcc);
    if (!existsSync(tcc)) {
      process.stdout.write(`  skip ${t.name}（${t.tcc} 没建）\n`);
      continue;
    }
    round(t, tcc, 1, ['tcc'], '一份');
    round(t, tcc, 0, [...PARTS, ...GEN[t.name]], '拆开');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 份相同, ${diff} 份不同\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/pe-tcc: 把 tcc 自己链出来这一步与 tcc 不一样\n');
  process.exitCode = 1;
}
