#!/usr/bin/env node
/* 顺手写出的那份 `<输出>.def`，以及带导出符号的 `.exe`（ADR-0017 第九刀第七十一片）。
 *
 * `pe_build_exports`（`tccpe.c:1025`）是 `pe_assign_addresses` 走到 thunk 那一节时
 * **无条件**调的 —— 不问是不是 DLL。于是两件事一直漏着：
 *
 *  - 一份普通的 `.exe` 里只要有 `__declspec(dllexport)` 的符号，一样摆出导出目录，
 *    数据目录第 0 条一样指过去。我们原先拿 `if (dll)` 把它挡住了。
 *  - 只要真有导出的符号，就往 `<输出>.def` 写一份清单：
 *    `LIBRARY <输出的基名>\n\nEXPORTS\n` 后面一行一个名字，跟表里同一个次序
 *    （按 `strcmp` 排过）。文件名是把**基名里最后一个点**之后换成 `.def`
 *    （`tcc_fileextension`）—— `my.lib.dll` 出来的是 `my.lib.def`。
 *
 * 尺子两样都对：`.def` 的字节，和那份 `.exe` / `.dll` 自己的字节。
 *
 *   node tests/c/pe-def.js
 *   node tests/c/pe-def.js arm64
 */

import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { peLoad } from '../../stage0/src/link/pe_load.js';
import { peWrite, defPath } from '../../stage0/src/link/pe_link.js';

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

function tccSrc() {
  const mak = join(CROSS, 'config.mak');
  if (!existsSync(mak)) return null;
  const m = /^TOPSRC=(.*)$/m.exec(readFileSync(mak, 'utf8'));
  return m === null ? null : m[1].trim();
}

const src = tccSrc();
if (src === null) {
  process.stdout.write('c/pe-def: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

/* `pe-def/` 是带 `main` 的（链成 `.exe`），`pe-gen/` 是带 `_dllstart` 的（链成 `.dll`）。
 * 后缀故意有两样：`.dll` 那一路再多一份 `a.b.dll`，看换扩展名那一步认的是哪个点。 */
const cases = [
  ...readdirSync(join(here, 'pe-def')).filter((f) => f.endsWith('.c')).sort()
    .map((f) => ({ dir: join(here, 'pe-def'), file: f, ext: 'exe' })),
  ...readdirSync(join(here, 'pe-gen')).filter((f) => f.endsWith('.c')).sort()
    .flatMap((f) => [
      { dir: join(here, 'pe-gen'), file: f, ext: 'dll', dll: true },
      { dir: join(here, 'pe-gen'), file: f, ext: 'two.dll', dll: true },
    ]),
];

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const dir = mkdtempSync(join(tmpdir(), 'omni-pedef-'));
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
      const stem = `${t.name}-${basename(c.file, '.c')}`;
      const objPath = join(dir, `${stem}.o`);
      const one = spawnSync(tcc, [...flags, '-c', join(c.dir, c.file), '-o', objPath], { encoding: 'utf8' });
      if (one.status !== 0 || !existsSync(objPath)) continue;
      /* 导出表与 `.def` 里写的都是**输出文件的基名**，两边必须是同一个名字。 */
      const outPath = join(dir, `${stem}.${c.ext}`);
      const link = spawnSync(tcc,
        [...flags, ...(c.dll === true ? ['-shared'] : []), objPath, '-o', outPath],
        { encoding: 'utf8' });
      if (link.status !== 0 || !existsSync(outPath)) continue;
      let got;
      try {
        const obj = readFileSync(objPath);
        const loaded = peLoad({
          objs: [{ path: objPath, bytes: obj }],
          libtcc1: `${t.name}-libtcc1.a`,
          open,
          dll: c.dll === true,
        });
        got = peWrite({
          objs: [obj, ...loaded.members.map((m) => m.bytes)],
          dlls: loaded.dlls,
          startName: loaded.entryName,
          dll: c.dll === true,
          outName: outPath,
        });
      } catch (e) {
        diff++;
        if (diff <= 6) process.stdout.write(`  THROW ${stem}.${c.ext}：${e.message}\n`);
        continue;
      }
      /* 一、映像自己。 */
      const want = readFileSync(outPath);
      const d = firstDiff(got.bytes, want);
      if (d >= 0) {
        diff++;
        if (diff <= 6) {
          process.stdout.write(`  DIFF ${stem}.${c.ext}：第一个不同在 0x${d.toString(16)}`
            + `（我们 ${got.bytes[d]?.toString(16)}，tcc ${want[d]?.toString(16)}；`
            + `${got.bytes.length}/${want.length} 字节）\n`);
        }
        continue;
      }
      same++; bytesTotal += got.bytes.length;
      /* 二、旁边那份 `.def`。 */
      const wantDef = defPath(outPath);
      if (got.def === undefined || got.def.path !== wantDef) {
        diff++;
        if (diff <= 6) {
          process.stdout.write(`  DIFF ${stem}.${c.ext}：`
            + `.def 的路径是 ${got.def === undefined ? '（没写）' : got.def.path}，该是 ${wantDef}\n`);
        }
        continue;
      }
      if (!existsSync(wantDef)) {
        diff++;
        if (diff <= 6) process.stdout.write(`  DIFF ${stem}.${c.ext}：tcc 没写 ${wantDef}\n`);
        continue;
      }
      const wd = readFileSync(wantDef, 'latin1');
      if (wd !== got.def.text) {
        diff++;
        if (diff <= 6) {
          process.stdout.write(`  DIFF ${stem}.${c.ext} 的 .def：`
            + `${got.def.text.length}/${wd.length} 字节\n`);
        }
        continue;
      }
      same++; bytesTotal += wd.length; ok++;
    }
    process.stdout.write(`  ${t.name}: ${ok} 份映像与 .def 都逐字节相同\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 条相同, ${diff} 条不同（共 ${bytesTotal} 字节）\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/pe-def: 写出来的 .def 或映像与 tcc 不一样\n');
  process.exitCode = 1;
}
