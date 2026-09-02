#!/usr/bin/env node
/* 导入表能**照原样重建**（ADR-0017 第九刀第四十四片）。
 *
 * 拿 `<target>-win32-tcc a.o -o a.exe` 链出来的映像，把导入表读成「哪个 dll、
 * 按什么次序导入哪些符号」，再用 `buildImports` 重新摆一遍，与 tcc 摆的那一段
 * 逐字节比。导入表整段是 thunk 那一节（`.rdata`）的尾巴，一格挪不得：描述符、
 * 两份 thunk 数组、dll 名字、每个符号的「提示字 + 名字」，次序与偏移全是算出来的。
 *
 * 这一份仍然**与我们的代码生成无关** —— 输入是 tcc 自己写的字节。
 *
 *   node tests/c/pe-imports.js
 *   node tests/c/pe-imports.js x86_64
 */

import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { readImage, readImports, buildImports } from '../../stage0/src/link/pe.js';

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
  process.stdout.write('c/pe-imports: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

const SRC = join(here, 'gen');
const cases = readdirSync(SRC).filter((f) => f.endsWith('.c')).sort();

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const dir = mkdtempSync(join(tmpdir(), 'omni-peimp-'));
let same = 0;
let diff = 0;
let dllTotal = 0;
let symTotal = 0;
try {
  for (const t of TARGETS) {
    if (!keep(t.name)) continue;
    const tcc = join(CROSS, t.tcc);
    if (!existsSync(tcc)) {
      process.stdout.write(`  skip ${t.name}（${t.tcc} 没建）\n`);
      continue;
    }
    const flags = [`-B${join(src, 'win32')}`, `-I${join(src, 'include')}`, `-L${CROSS}`];
    let ok = 0;
    for (const c of cases) {
      const stem = `${t.name}-${basename(c, '.c')}`;
      const objPath = join(dir, `${stem}.o`);
      const one = spawnSync(tcc, [...flags, '-c', join(SRC, c), '-o', objPath], { encoding: 'utf8' });
      if (one.status !== 0 || !existsSync(objPath)) continue;
      const exePath = join(dir, `${stem}.exe`);
      const link = spawnSync(tcc, [...flags, objPath, '-o', exePath], { encoding: 'utf8' });
      if (link.status !== 0 || !existsSync(exePath)) continue;
      let imp;
      let want;
      let got;
      try {
        const img = readImage(readFileSync(exePath));
        imp = readImports(img);
        if (imp === null) continue;                       // 没有导入表，不算账
        const sec = img.secs[imp.sec];
        got = buildImports(imp);
        if (imp.at + got.length > sec.vsize) {
          throw new Error(`重建出来的比 ${sec.name} 还长（${imp.at + got.length} > ${sec.vsize}）`);
        }
        /* 只比我们声称重建的那一段。arm64 上导入表**不是** `.rdata` 的最后一段 ——
         * 后面还接着 `.xdata`（每个函数 8 字节的展开信息，`pe_add_unwind_info`），
         * 那是另一片的事。 */
        want = sec.bytes.slice(imp.at, imp.at + got.length);
      } catch (e) {
        diff++;
        if (diff <= 8) process.stdout.write(`  THROW ${t.name} ${c}：${e.message}\n`);
        continue;
      }
      const at = firstDiff(got, want);
      if (at < 0) {
        same++;
        ok++;
        dllTotal += imp.dlls.length;
        for (const d of imp.dlls) symTotal += d.syms.length;
        continue;
      }
      diff++;
      if (diff <= 8) {
        process.stdout.write(`  DIFF ${t.name} ${c}：tcc ${want.length} 字节 / 我们 `
          + `${got.length} 字节，第一个不同在 0x${at.toString(16)}\n`);
      }
    }
    process.stdout.write(`  ${t.name}: ${ok} 条导入表逐字节相同\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 条相同, ${diff} 条不同（共 ${dllTotal} 个 dll、${symTotal} 个导入符号）\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/pe-imports: 导入表重建不是逐字节的 —— 与 pe_build_imports 差了一格\n');
  process.exitCode = 1;
}
