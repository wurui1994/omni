#!/usr/bin/env node
/* 异常展开表能**照原样重建**（ADR-0017 第九刀第四十五片）。
 *
 * 拿 `<target>-win32-tcc a.o -o a.exe` 链出来的映像，把 `.pdata` 读成一张函数表，
 * 再用 `buildUnwind` 重新摆一遍，与 tcc 摆的那几段逐字节比：
 *
 *  - x86_64：`.pdata` 一条 12 字节，展开信息只有一份、住在 `.text` 里（8 字节）；
 *  - arm64：`.pdata` 一条 8 字节，每个函数在 `.xdata` 里有自己的 8 字节。
 *
 * 第四十四片留下的那个尾巴（arm64 上 `.rdata` 里接在导入表后面的那一段）就是 `.xdata`，
 * 这一片把它认下来。这一份仍然**与我们的代码生成无关**。
 *
 *   node tests/c/pe-unwind.js
 *   node tests/c/pe-unwind.js arm64
 */

import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { readImage, readUnwind, buildUnwind, unwindInfoX64 } from '../../stage0/src/link/pe.js';

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
  process.stdout.write('c/pe-unwind: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

const SRC = join(here, 'gen');
const cases = readdirSync(SRC).filter((f) => f.endsWith('.c')).sort();

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const dir = mkdtempSync(join(tmpdir(), 'omni-peuw-'));
let same = 0;
let diff = 0;
let funcTotal = 0;
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
      /* 一份映像里要对三段（arm64 是两段 + 一段），逐段攒起来一起比。 */
      const pairs = [];
      let u;
      try {
        const img = readImage(readFileSync(exePath));
        u = readUnwind(img);
        if (u === null) continue;
        const got = buildUnwind(u);
        const ps = img.secs[u.psec];
        pairs.push(['pdata', got.pdata, ps.bytes.slice(u.pat, u.pat + got.pdata.length)]);
        if (got.xdata.length !== 0) {
          const xs = img.secs[u.xsec];
          pairs.push(['xdata', got.xdata, xs.bytes.slice(u.xat, u.xat + got.xdata.length)]);
        } else {
          /* x86_64：展开信息一个目标文件一份，每一处都要是那 8 字节。 */
          for (const rva of u.uwRvas) {
            const ts = img.secs.find((s) => rva >= s.vaddr && rva < s.vaddr + s.vsize);
            if (ts === undefined) throw new Error(`展开信息 0x${rva.toString(16)} 不在任何一节里`);
            const at = rva - ts.vaddr;
            pairs.push(['uwinfo', unwindInfoX64(), ts.bytes.slice(at, at + 8)]);
          }
        }
      } catch (e) {
        diff++;
        if (diff <= 8) process.stdout.write(`  THROW ${t.name} ${c}：${e.message}\n`);
        continue;
      }
      let bad = null;
      for (const [what, got, want] of pairs) {
        const d = firstDiff(got, want);
        if (d >= 0) { bad = `${what} 第一个不同在 0x${d.toString(16)}（${got.length}/${want.length} 字节）`; break; }
      }
      if (bad === null) {
        same++;
        ok++;
        funcTotal += u.funcs.length;
        continue;
      }
      diff++;
      if (diff <= 8) process.stdout.write(`  DIFF ${t.name} ${c}：${bad}\n`);
    }
    process.stdout.write(`  ${t.name}: ${ok} 条展开表逐字节相同\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 条相同, ${diff} 条不同（共 ${funcTotal} 个函数）\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/pe-unwind: 展开表重建不是逐字节的 —— 与 pe_add_unwind_data 差了一格\n');
  process.exitCode = 1;
}
