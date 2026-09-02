#!/usr/bin/env node
/* 接着真的 dylib 链一份可执行文件，与 tcc 逐字节相同（ADR-0017 第九刀第七十七片）。
 *
 * 尺子：先 `<target>-osx-tcc -shared -nostdlib lib.o -o lib.dylib`，再
 * `<target>-osx-tcc -nostdlib -e _main use.o lib.dylib -o a.out`。
 *
 * 这一路要的是 `macho_load_dll` —— 在这以前 `--dylib` 只认 `.tbd` 那种文本 stub，
 * SDK 外头的库读不进来。dylib 对链接器来说就是一张名字表：`LC_ID_DYLIB` 给安装名
 * （进 `LC_LOAD_DYLIB`），`LC_SYMTAB` 配 `LC_DYSYMTAB` 的 `iextdefsym`/`nextdefsym`
 * 圈出「它导出了什么」，段的内容一眼都不看。
 *
 * 库名进 `LC_LOAD_DYLIB`，两边得是同一个路径；arm64 上还要在同名的路径下签名。
 *
 * `-Wl,-rpath=`（第七十八片）也一起比：`LC_RPATH` 一段一条，可执行文件与 dylib 都发。
 *
 *   node tests/c/macho-dll.js
 *   node tests/c/macho-dll.js arm64
 */

import {
  readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
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
  process.stdout.write('c/macho-dll: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

/** 借 `elf-dll/` 里成对的那些：`NN-名字-lib.c` 与 `NN-名字-use.c`。 */
const SRC = join(here, 'elf-dll');
const cases = readdirSync(SRC).filter((f) => f.endsWith('-lib.c')).sort()
  .map((f) => f.slice(0, -6));

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const dir = mkdtempSync(join(tmpdir(), 'omni-machodll-'));
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
    for (const stem of cases) {
      const tag = `${t.name}-${stem}`;
      const run = (args) => spawnSync(tcc, args, { encoding: 'utf8' });
      const libObj = join(dir, `${tag}-lib.o`);
      const useObj = join(dir, `${tag}-use.o`);
      const libPath = join(dir, `lib${tag}.dylib`);
      if (run(['-c', join(SRC, `${stem}-lib.c`), '-o', libObj]).status !== 0) continue;
      if (run(['-c', join(SRC, `${stem}-use.c`), '-o', useObj]).status !== 0) continue;
      if (run(['-shared', '-nostdlib', libObj, '-o', libPath]).status !== 0) continue;
      /* 再拿 `lipo` 把两个架构拼成一份胖二进制，走 `macho_load_dll` 里挑片那一段。
       * 只有 arm64 那一趟比得出来：lipo 给 x86_64 那片的 cpusubtype 是
       * `CPU_SUBTYPE_X86_ALL | CPU_SUBTYPE_LIB64`，而 tcc 那句是严格的 `==
       * CPU_SUBTYPE_X86_ALL`，于是它自己就认不出胖文件里的 x86_64。我们照抄这个
       * 严格比 —— 两边一起认不出来，门只在 tcc 链得上的时候才比。 */
      let fatPath = null;
      const other = TARGETS.find((x) => x.name !== t.name);
      const otherTcc = other === undefined ? '' : join(CROSS, other.tcc);
      if (existsSync(otherTcc)) {
        const oObj = join(dir, `${tag}-other.o`);
        const oLib = join(dir, `${tag}-other.dylib`);
        const oc = (args) => spawnSync(otherTcc, args, { encoding: 'utf8' }).status === 0;
        const p = join(dir, `libfat${tag}.dylib`);
        if (oc(['-c', join(SRC, `${stem}-lib.c`), '-o', oObj])
          && oc(['-shared', '-nostdlib', oObj, '-o', oLib])
          && spawnSync('lipo', ['-create', libPath, oLib, '-output', p]).status === 0) {
          fatPath = p;
        }
      }
      /* `LC_RPATH` 在 dylib 上也发（tcc 那段不在 EXE 的分支里）—— 顺手比一份。 */
      {
        const rpLib = join(dir, `librp${tag}.dylib`);
        const wl = ['-Wl,-rpath=@loader_path', '-Wl,-rpath=/opt/omni'];
        if (run(['-shared', '-nostdlib', ...wl, libObj, '-o', rpLib]).status === 0) {
          const minePath = join(mine, `librp${tag}.dylib`);
          let ok2 = true;
          try {
            writeFileSync(minePath, machoExe({
              objs: [readFileSync(libObj)],
              shared: true,
              rpath: '@loader_path:/opt/omni',
              outName: rpLib,
            }).bytes);
          } catch (e) {
            ok2 = false;
            diff++;
            if (diff <= 6) process.stdout.write(`  THROW ${tag}-so-rpath：${e.message}\n`);
          }
          if (ok2 && t.sign
            && spawnSync('codesign', ['-f', '-s', '-', minePath]).status !== 0) ok2 = false;
          if (ok2) {
            const d2 = firstDiff(readFileSync(minePath), readFileSync(rpLib));
            if (d2 < 0) { same++; ok++; bytesTotal += readFileSync(minePath).length; } else {
              diff++;
              if (diff <= 6) {
                process.stdout.write(`  DIFF ${tag}-so-rpath：第一个不同在 0x${d2.toString(16)}\n`);
              }
            }
          }
        }
      }
      for (const m of [
        { sfx: '', lib: libPath, wl: [] },
        { sfx: '-fat', lib: fatPath, wl: [] },
        /* `LC_RPATH`（第九刀第七十八片）：一条、两条（`-Wl,-rpath=` 给两次，tcc 用
         * 冒号把它们攒成一串，再按冒号切回来一段一条）。 */
        { sfx: '-rpath', lib: libPath, wl: ['-Wl,-rpath=@loader_path'], rpath: '@loader_path' },
        {
          sfx: '-rpath2',
          lib: libPath,
          wl: ['-Wl,-rpath=@loader_path/../lib', '-Wl,-rpath=/opt/omni'],
          rpath: '@loader_path/../lib:/opt/omni',
        },
      ]) {
        if (m.lib === null) continue;
        const name = `${tag}${m.sfx}`;
        const exePath = join(dir, `${name}.out`);
        const ln = run(['-nostdlib', ...m.wl, useObj, m.lib, '-o', exePath]);
        if (ln.status !== 0 || !existsSync(exePath)) {
          /* 胖文件里没有 tcc 认得的那一片 —— 上面那段注释里的严格比。 */
          if (m.sfx === '-fat') continue;
          diff++;
          if (diff <= 6) process.stdout.write(`  tcc 自己就链不上 ${name}：${ln.stderr}\n`);
          continue;
        }
        let got;
        try {
          got = machoExe({
            objs: [readFileSync(useObj)],
            entryName: '_main',
            dylibs: [{ name: m.lib, bytes: readFileSync(m.lib) }],
            rpath: m.rpath,
            outName: exePath,
          }).bytes;
        } catch (e) {
          diff++;
          if (diff <= 6) process.stdout.write(`  THROW ${name}：${e.message}\n`);
          continue;
        }
        /* 签名里的 identifier 取的是文件名，两边名字得一样。 */
        const minePath = join(mine, `${name}.out`);
        writeFileSync(minePath, got);
        if (t.sign) {
          const sign = spawnSync('codesign', ['-f', '-s', '-', minePath], { encoding: 'utf8' });
          if (sign.status !== 0) {
            diff++;
            if (diff <= 6) process.stdout.write(`  SIGN ${name}：${(sign.stderr ?? '').trim()}\n`);
            continue;
          }
        }
        const signed = readFileSync(minePath);
        const want = readFileSync(exePath);
        const d = firstDiff(signed, want);
        if (d < 0) { same++; ok++; bytesTotal += signed.length; continue; }
        diff++;
        if (diff <= 6) {
          process.stdout.write(`  DIFF ${name}：第一个不同在 0x${d.toString(16)}`
            + `（我们 ${signed[d]?.toString(16)}，tcc ${want[d]?.toString(16)}；`
            + `${signed.length}/${want.length} 字节）\n`);
        }
      }
    }
    process.stdout.write(`  ${t.name}: ${ok} 份可执行文件逐字节相同\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 条相同, ${diff} 条不同（共 ${bytesTotal} 字节）\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/macho-dll: 写出来的可执行文件与 tcc 不一样\n');
  process.exitCode = 1;
}
