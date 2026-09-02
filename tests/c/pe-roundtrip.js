#!/usr/bin/env node
/* 读回来的 PE 映像能**从模板写回去**（ADR-0017 第九刀第四十三片）。
 *
 * 与第四十一片的 ELF 往返同一种尺子，只是对象换成**可执行文件**：拿
 * `<target>-win32-tcc a.o -o a.exe` 链出来的映像，用 `readImage` 读进来、
 * `writeImage` 从 `pe_template` 写回去，两份字节要完全相同。头部除了「算出来的
 * 那几格」全部来自模板，节的位置由 `pe_file_align` 现算 —— 模板错一格、算式错一格，
 * 字节就不同。这一份**与我们的代码生成无关**。
 *
 * 为什么可执行文件先挑 PE：它是三种里唯一完全确定的（没有代码签名、没有 dyld 那一摊），
 * 而且在 macOS 上就能链得出来（win32 的导入库随 tinycc 源码走）。
 *
 *   node tests/c/pe-roundtrip.js
 *   node tests/c/pe-roundtrip.js x86_64
 */

import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { readImage, writeImage } from '../../stage0/src/link/pe.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CROSS = join(root, '.omni-cache', 'tcc-cross');

const TARGETS = [
  { name: 'x86_64-win32', tcc: 'x86_64-win32-tcc' },
  { name: 'arm64-win32', tcc: 'arm64-win32-tcc' },
  { name: 'i386-win32', tcc: 'i386-win32-tcc' },
  { name: 'arm-wince', tcc: 'arm-wince-tcc' },
];

const filters = process.argv.slice(2).filter((x) => !x.startsWith('-'));
const keep = (s) => filters.length === 0 || filters.some((f) => s.includes(f));

/** tinycc 的源码在哪儿：`-B<src>/win32` 是 win32 的头文件与导入库。 */
function tccSrc() {
  const mak = join(CROSS, 'config.mak');
  if (!existsSync(mak)) return null;
  const m = /^TOPSRC=(.*)$/m.exec(readFileSync(mak, 'utf8'));
  return m === null ? null : m[1].trim();
}

const src = tccSrc();
if (src === null) {
  process.stdout.write('c/pe-roundtrip: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

const SRC = join(here, 'gen');
const cases = readdirSync(SRC).filter((f) => f.endsWith('.c')).sort();

/** 第一个不同的字节在哪儿；一样就回 -1。 */
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const dir = mkdtempSync(join(tmpdir(), 'omni-pert-'));
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
    /* win32 的 libtcc1.a 带目标前缀，tcc 自己按前缀找，所以把交叉目录挂到 -L 上。
     * `-I<src>/include` 是 tcc 自己那几个头（`stddef.h`/`stdarg.h`）—— 交叉的时候
     * 它只往 `-B<dir>/include` 里找，而那是 win32 的那一套，少了这几个。 */
    const flags = [`-B${join(src, 'win32')}`, `-I${join(src, 'include')}`, `-L${CROSS}`];
    let ok = 0;
    for (const c of cases) {
      const stem = `${t.name}-${basename(c, '.c')}`;
      const objPath = join(dir, `${stem}.o`);
      const one = spawnSync(tcc, [...flags, '-c', join(SRC, c), '-o', objPath], { encoding: 'utf8' });
      if (one.status !== 0 || !existsSync(objPath)) continue;
      const exePath = join(dir, `${stem}.exe`);
      const link = spawnSync(tcc, [...flags, objPath, '-o', exePath], { encoding: 'utf8' });
      /* tcc 自己链不上的不算账（缺哪个 win32 的符号是它的事）。 */
      if (link.status !== 0 || !existsSync(exePath)) continue;
      const want = readFileSync(exePath);
      let got;
      try {
        got = writeImage(readImage(want));
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
        process.stdout.write(`  DIFF ${t.name} ${c}：tcc ${want.length} 字节 / 我们写回 `
          + `${got.length} 字节，第一个不同在 0x${at.toString(16)}\n`);
      }
    }
    process.stdout.write(`  ${t.name}: ${ok} 条往返逐字节相同\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 条相同, ${diff} 条不同\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/pe-roundtrip: 往返不是逐字节的 —— PE 的模型缺了一格\n');
  process.exitCode = 1;
}
