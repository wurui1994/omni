#!/usr/bin/env node
/* 整份 Mach-O dylib 与 tcc 逐字节相同（ADR-0017 第九刀第六十三片）。
 *
 * 尺子：`<target>-osx-tcc -shared -nostdlib a.o -o a.dylib`。
 *
 * dylib 与可执行文件差在这几处：没有 `__PAGEZERO`（`__TEXT` 于是从 0 起）、多一条
 * `LC_ID_DYLIB`（名字就是输出的文件名）、没有 `LC_LOAD_DYLINKER` 与 `LC_MAIN`、
 * 文件类型 MH_DYLIB 且不带 MH_PIE、`tcc_add_linker_symbols` 整趟不叫、没定义的符号
 * 一律当「来自别处」（装载时平坦查找）。
 *
 * 跟 `macho-exe.js` 一样要在同名的路径下签名 —— ad-hoc 签名里的 identifier 取的是
 * 文件名，两边名字一样，签出来的字节才一样。
 *
 *   node tests/c/macho-dylib.js
 *   node tests/c/macho-dylib.js arm64
 */

import {
  readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, readdirSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { machoExe } from '../../stage0/src/link/macho_exe.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CROSS = join(root, '.omni-cache', 'tcc-cross');

const TARGETS = [
  { name: 'x86_64-macos', tcc: 'x86_64-osx-tcc', sign: false },
  { name: 'arm64-macos', tcc: 'arm64-osx-tcc', sign: true },
];

const filters = process.argv.slice(2).filter((x) => !x.startsWith('-'));
const keep = (s) => filters.length === 0 || filters.some((f) => s.includes(f));

if (!existsSync(CROSS)) {
  process.stdout.write('c/macho-dylib: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

const DIRS = [join(here, 'gen'), join(here, 'elf-gen'), join(here, 'macho-gen')];
const cases = [];
for (const d of DIRS) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d).filter((x) => x.endsWith('.c')).sort()) {
    if (f.endsWith('-b.c')) continue;
    const srcs = [join(d, f)];
    if (f.endsWith('-a.c')) srcs.push(join(d, `${f.slice(0, -4)}-b.c`));
    cases.push(srcs);
  }
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const dir = mkdtempSync(join(tmpdir(), 'omni-machodylib-'));
let same = 0;
let diff = 0;
let bytesTotal = 0;
try {
  const mine = join(dir, 'mine');
  mkdirSync(mine);
  for (const t of TARGETS) {
    if (!keep(t.name)) continue;
    const tcc = join(CROSS, t.tcc);
    if (!existsSync(tcc)) {
      process.stdout.write(`  skip ${t.name}（${t.tcc} 没建）\n`);
      continue;
    }
    let ok = 0;
    for (const srcs of cases) {
      const stem = `${t.name}-${basename(srcs[0], '.c')}`;
      const objs = [];
      let compiled = true;
      for (let k = 0; k < srcs.length; k++) {
        const objPath = join(dir, `${stem}-${k}.o`);
        const one = spawnSync(tcc, ['-c', srcs[k], '-o', objPath], { encoding: 'utf8' });
        if (one.status !== 0 || !existsSync(objPath)) { compiled = false; break; }
        objs.push(objPath);
      }
      if (!compiled) continue;
      const libPath = join(dir, `${stem}.dylib`);
      const ln = spawnSync(tcc, ['-shared', '-nostdlib', ...objs, '-o', libPath], { encoding: 'utf8' });
      if (ln.status !== 0 || !existsSync(libPath)) continue;
      let got;
      try {
        got = machoExe({
          objs: objs.map((p) => readFileSync(p)),
          shared: true,
          outName: libPath,
        }).bytes;
      } catch (e) {
        diff++;
        if (diff <= 6) process.stdout.write(`  THROW ${stem}：${e.message}\n`);
        continue;
      }
      const minePath = join(mine, `${stem}.dylib`);
      writeFileSync(minePath, got);
      if (t.sign) {
        const sign = spawnSync('codesign', ['-f', '-s', '-', minePath], { encoding: 'utf8' });
        if (sign.status !== 0) {
          diff++;
          if (diff <= 6) process.stdout.write(`  SIGN ${stem}：${(sign.stderr ?? '').trim()}\n`);
          continue;
        }
      }
      const signed = readFileSync(minePath);
      const want = readFileSync(libPath);
      const d = firstDiff(signed, want);
      if (d < 0) { same++; ok++; bytesTotal += signed.length; continue; }
      diff++;
      if (diff <= 6) {
        process.stdout.write(`  DIFF ${stem}：第一个不同在 0x${d.toString(16)}`
          + `（我们 ${signed[d]?.toString(16)}，tcc ${want[d]?.toString(16)}；`
          + `${signed.length}/${want.length} 字节）\n`);
      }
    }
    process.stdout.write(`  ${t.name}: ${ok} 份 dylib 逐字节相同\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 条相同, ${diff} 条不同（共 ${bytesTotal} 字节）\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/macho-dylib: 写出来的 dylib 与 tcc 不一样\n');
  process.exitCode = 1;
}
