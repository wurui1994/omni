#!/usr/bin/env node
/* 节的内容与 tcc 一样（ADR-0017 第九刀第四十九片）。
 *
 * 第四十八片对的是节表（摆在哪），这一份对的是节里的字节：导入表、导入桩、以及所有落笔
 * 完的重定位。拿 tcc 链出来的 `.exe` 用 `readImage` 读出来，一节一节逐字节比。
 *
 * 头留给下一片 —— 节的内容对上了，剩下的只是那三十几个字段。
 *
 *   node tests/c/pe-content.js
 *   node tests/c/pe-content.js arm64
 */

import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { peLoad } from '../../stage0/src/link/pe_load.js';
import { peImage } from '../../stage0/src/link/pe_link.js';
import { readImage } from '../../stage0/src/link/pe.js';

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
  process.stdout.write('c/pe-content: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

const SRC = join(here, 'gen');
const cases = readdirSync(SRC).filter((f) => f.endsWith('.c')).sort();

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const dir = mkdtempSync(join(tmpdir(), 'omni-pect-'));
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
      const one = spawnSync(tcc, [...flags, '-c', join(SRC, c), '-o', objPath], { encoding: 'utf8' });
      if (one.status !== 0 || !existsSync(objPath)) continue;
      const exePath = join(dir, `${stem}.exe`);
      const link = spawnSync(tcc, [...flags, objPath, '-o', exePath], { encoding: 'utf8' });
      if (link.status !== 0 || !existsSync(exePath)) continue;
      let bad = null;
      try {
        const obj = readFileSync(objPath);
        const loaded = peLoad({ objs: [{ path: objPath, bytes: obj }], libtcc1: `${t.name}-libtcc1.a`, open });
        const r = peImage({
          objs: [obj, ...loaded.members.map((m) => m.bytes)],
          dlls: loaded.dlls,
          startName: loaded.entryName,
          imagebase: t.imagebase,
          dynamicBase: t.dynamicBase,
        });
        const img = readImage(readFileSync(exePath));
        for (const info of r.infos) {
          if (info.dataSize === 0) continue;
          const w = img.secs.find((s) => s.name === info.name);
          if (w === undefined) { bad = `tcc 里没有 ${info.name} 这一节`; break; }
          const want = w.bytes.subarray(0, info.bytes.length);
          const d = firstDiff(info.bytes, want);
          if (d >= 0) {
            bad = `${info.name} 第一个不同在 0x${d.toString(16)}`
              + `（我们 ${info.bytes[d]?.toString(16)}，tcc ${want[d]?.toString(16)}）`;
            break;
          }
        }
      } catch (e) {
        diff++;
        if (diff <= 6) process.stdout.write(`  THROW ${t.name} ${c}：${e.message}\n`);
        continue;
      }
      if (bad === null) { same++; ok++; continue; }
      diff++;
      if (diff <= 6) process.stdout.write(`  DIFF ${t.name} ${c}：${bad}\n`);
    }
    process.stdout.write(`  ${t.name}: ${ok} 份节内容逐字节相同\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 条相同, ${diff} 条不同\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/pe-content: 节里的字节与 tcc 不一样 —— 导入桩、符号地址或者重定位差了一格\n');
  process.exitCode = 1;
}
