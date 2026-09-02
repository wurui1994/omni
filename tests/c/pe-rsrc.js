#!/usr/bin/env node
/* 资源那一节 `.rsrc`，逐字节与 tcc 相同（ADR-0017 第九刀第六十八片）。
 *
 * 尺子：`<target>-win32-tcc a.o a.res -o a.exe`。`a.res` 是 `windres -O coff` 那种
 * 文件 —— 交叉环境里没有 windres，所以这份用例自己造：它就是一份**只有一节的
 * COFF**（20 字节文件头 + 40 字节节表项，那一节叫 `.rsrc`），没有魔数。
 *
 * `pe_load_res` 干的事只有三件：把那一节的原始字节整块搬成一节新的 `.rsrc`
 * （`SHT_PROGBITS | SHF_ALLOC`）、加一个同名的局部符号、把 COFF 那张重定位表
 * 一条条改挂成 `R_XXX_RELATIVE` 指向那个符号。于是资源目录里 `OffsetToData`
 * 那几格落笔时得到「原地那个节内偏移 + `.rsrc` 的 RVA」—— tcc 用的是 `add32le`，
 * 原地那个值是要算进去的。
 *
 * 两格值得记：
 *
 *  - `.rsrc` 的类是 `sec_rsrc`（8），排在 `.pdata` 之后、`.reloc` 之前，并且
 *    `pe_assign_addresses` 顺手把它填进数据目录 2。
 *  - `R_XXX_RELATIVE` **不是** `REL_TYPE_DIRECT`，所以这几条不进 `.reloc` ——
 *    资源目录里那些 RVA 本来就是 RVA，装载时不用再改。
 *
 *   node tests/c/pe-rsrc.js
 *   node tests/c/pe-rsrc.js arm64
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
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
  { name: 'x86_64-win32', tcc: 'x86_64-win32-tcc', machine: 0x8664 },
  { name: 'arm64-win32', tcc: 'arm64-win32-tcc', machine: 0xaa64 },
  { name: 'i386-win32', tcc: 'i386-win32-tcc', machine: 0x14c, rsrcRel: 7 },
  { name: 'arm-wince', tcc: 'arm-wince-tcc', machine: 0x1c0, rsrcRel: 7 },
];

/** `RSRC_RELTYPE`：x86_64 与 arm64 都是 3（`IMAGE_REL_*_ADDR32NB`），i386/arm 是 7。 */
const RSRC_RELTYPE = 3;
const RT_RCDATA = 10;

/**
 * 造一棵资源树：类型（一律 `RT_RCDATA`）→ 名字（编号 1..n）→ 语言（一律 0）→ 数据项。
 *
 * `OffsetToData` 那一格先写「节内偏移」，再各挂一条重定位把 `.rsrc` 的 RVA 加上去。
 *
 * @param blobs 每份资源的字节
 * @returns `{bytes, relocs}`
 */
function resTree(blobs) {
  const n = blobs.length;
  const nameDirAt = 24;
  const langDirAt = nameDirAt + 16 + n * 8;
  const dataEntAt = langDirAt + n * 24;
  const dataAt = dataEntAt + n * 16;
  let total = dataAt;
  const at = blobs.map((b) => { const a = total; total += Math.ceil(b.length / 8) * 8; return a; });
  const bytes = new Uint8Array(total);
  const dv = new DataView(bytes.buffer);
  const dir = (o, named, ids) => { dv.setUint16(o + 12, named, true); dv.setUint16(o + 14, ids, true); };
  const ent = (o, id, off, isDir) => {
    dv.setUint32(o, id, true);
    dv.setUint32(o + 4, (isDir ? off | 0x80000000 : off) >>> 0, true);
  };
  dir(0, 0, 1);
  ent(16, RT_RCDATA, nameDirAt, true);
  dir(nameDirAt, 0, n);
  const relocs = [];
  for (let i = 0; i < n; i++) {
    const lang = langDirAt + i * 24;
    const de = dataEntAt + i * 16;
    ent(nameDirAt + 16 + i * 8, i + 1, lang, true);
    dir(lang, 0, 1);
    ent(lang + 16, 0, de, false);
    dv.setUint32(de, at[i], true);                 // OffsetToData（等重定位补 RVA）
    dv.setUint32(de + 4, blobs[i].length, true);   // Size
    relocs.push(de);
    bytes.set(blobs[i], at[i]);
  }
  return { bytes, relocs };
}

/** 把 `{bytes, relocs}` 包成一份 `windres -O coff` 那样的单节 COFF。 */
function resFile(machine, tree, relType) {
  const HDR = 20 + 40;
  const out = new Uint8Array(HDR + tree.bytes.length + tree.relocs.length * 10);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, machine, true);
  dv.setUint16(2, 1, true);                        // NumberOfSections
  dv.setUint16(18, 0x0104, true);                  // Characteristics
  for (let i = 0; i < 5; i++) out[20 + i] = '.rsrc'.charCodeAt(i);
  dv.setUint32(20 + 16, tree.bytes.length, true);  // SizeOfRawData
  dv.setUint32(20 + 20, HDR, true);                // PointerToRawData
  dv.setUint32(20 + 24, HDR + tree.bytes.length, true); // PointerToRelocations
  dv.setUint16(20 + 32, tree.relocs.length, true); // NumberOfRelocations
  dv.setUint32(20 + 36, 0x40000040, true);         // Characteristics
  out.set(tree.bytes, HDR);
  let p = HDR + tree.bytes.length;
  for (const off of tree.relocs) {
    dv.setUint32(p, off, true);
    dv.setUint32(p + 4, 0, true);                  // 符号号（tcc 一律不看）
    dv.setUint16(p + 8, relType, true);
    p += 10;
  }
  return out;
}

const blob = (n, c) => { const b = new Uint8Array(n); b.fill(c); return b; };

const SHAPES = [
  { name: 'one', tree: () => resTree([blob(8, 0x41)]) },
  { name: 'many', tree: () => resTree([blob(8, 0x41), blob(24, 0x42), blob(3, 0x43)]) },
  /* 一棵空树：16 字节的目录头，0 条重定位。 */
  { name: 'empty', tree: () => ({ bytes: new Uint8Array(16), relocs: [] }) },
  /* 长度不是 4 的倍数 —— 节的长度与文件对齐都得自己处理。 */
  { name: 'odd', tree: () => ({ bytes: new Uint8Array(19), relocs: [] }) },
  /* 跨过一个 0x1000 页，后面那几节的地址都要跟着挪。 */
  { name: 'big', tree: () => resTree([blob(0x1200, 0x44)]) },
  /* 造 DLL 的时候 `.rsrc` 与导出表、`.reloc` 是一起来的。 */
  { name: 'dll', dll: true, tree: () => resTree([blob(16, 0x45), blob(16, 0x46)]) },
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
  process.stdout.write('c/pe-rsrc: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

/* 案例挑六份有代表性的：全局量、要 libc、浮点、自己命名的节、弱符号、线程局部。 */
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

const dir = mkdtempSync(join(tmpdir(), 'omni-persrc-'));
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
    for (const sh of SHAPES) {
      if (!keep(sh.name)) continue;
      const resPath = join(dir, `${t.name}-${sh.name}.res`);
      writeFileSync(resPath, resFile(t.machine, sh.tree(), t.rsrcRel ?? RSRC_RELTYPE));
      const dll = sh.dll === true;
      for (const c of cases) {
        const stem = `${t.name}-${sh.name}-${basename(c, '.c')}`;
        const objPath = join(dir, `${stem}.o`);
        if (spawnSync(tcc, [...flags, '-c', c, '-o', objPath], { encoding: 'utf8' }).status !== 0) {
          continue;
        }
        const outPath = join(dir, `${stem}.${dll ? 'dll' : 'exe'}`);
        const args = [...flags, ...(dll ? ['-shared'] : []), objPath, resPath, '-o', outPath];
        const link = spawnSync(tcc, args, { encoding: 'utf8' });
        if (link.status !== 0 || !existsSync(outPath)) { skipped++; continue; }
        const opt = dll ? { dll: true, outName: outPath } : {};
        let got;
        try {
          const obj = readFileSync(objPath);
          const loaded = peLoad({
            objs: [
              { path: objPath, bytes: obj },
              { path: resPath, bytes: new Uint8Array(readFileSync(resPath)) },
            ],
            libtcc1: `${t.name}-libtcc1.a`,
            open,
            ...opt,
          });
          got = peWrite({
            objs: [...loaded.objs, ...loaded.members.map((x) => x.bytes)],
            dlls: loaded.dlls,
            res: loaded.res,
            startName: loaded.entryName,
            ...opt,
          }).bytes;
        } catch (e) {
          diff++;
          if (diff <= 6) process.stdout.write(`  THROW ${stem}：${e.message}\n`);
          continue;
        }
        const want = readFileSync(outPath);
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
    process.stdout.write(`  ${t.name}: ${ok} 份逐字节相同\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 条相同, ${diff} 条不同, ${skipped} 条 tcc 自己就链不上`
  + `（共 ${bytesTotal} 字节）\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/pe-rsrc: 写出来的映像与 tcc 不一样\n');
  process.exitCode = 1;
}
