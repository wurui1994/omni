#!/usr/bin/env node
/* 接上真的 libc：整份 Mach-O 可执行文件与 tcc 逐字节相同（第九刀第五十六片）。
 *
 * 上一片是 `-nostdlib`。这一片把 libc 接上，于是多出三样东西：
 *
 *  - `.tbd`：SDK 里那种文本 stub。`tcc_add_library(s1, "c")` 找到 `libc.tbd`，
 *    从里头读出安装名 `/usr/lib/libSystem.B.dylib` 与它导出的一大堆符号 —— 那些名字
 *    只用来回答「这个未定义符号是不是来自某个 dylib」，进不了我们的符号表。
 *  - `LC_LOAD_DYLIB`：装了哪个 dylib 就多一条，排在 `LC_MAIN` 后面。
 *  - `libtcc1.a` 按需取用：`__floatundisf` 那一族要用到的时候才拉进来，
 *    拉进来的成员**接在命令行那些目标文件后面**。
 *
 * 尺子（`-B` 底下放一份带交叉前缀的 `libtcc1.a`，`-L` 指向 SDK 的 lib 目录）：
 *
 *   <target>-osx-tcc -B<dir> -L<sdk>/usr/lib a.o -o a.out
 *
 *   node tests/c/macho-libc.js
 *   node tests/c/macho-libc.js arm64
 */

import {
  readFileSync, writeFileSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync,
  readdirSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { machoExe } from '../../src/core/link/macho_exe.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CROSS = join(root, '.omni-cache', 'tcc-cross');

const TARGETS = [
  {
    name: 'x86_64-macos', tcc: 'x86_64-osx-tcc', lib: 'x86_64-osx-libtcc1.a', sign: false,
  },
  {
    name: 'arm64-macos', tcc: 'arm64-osx-tcc', lib: 'arm64-osx-libtcc1.a', sign: true,
  },
];

const filters = process.argv.slice(2).filter((x) => !x.startsWith('-'));
const keep = (s) => filters.length === 0 || filters.some((f) => s.includes(f));

if (!existsSync(CROSS)) {
  process.stdout.write('c/macho-libc: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

const probe = spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' });
const SDK = probe.status === 0 ? probe.stdout.trim()
  : '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk';
const TBD = join(SDK, 'usr', 'lib', 'libc.tbd');
if (!existsSync(TBD)) {
  process.stdout.write(`c/macho-libc: 找不到 ${TBD}，跳过\n`);
  process.exit(0);
}
const tbdText = readFileSync(TBD, 'utf8');

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

const dir = mkdtempSync(join(tmpdir(), 'omni-macholibc-'));
let same = 0;
let diff = 0;
let bytesTotal = 0;
let pulled = 0;
try {
  const mine = join(dir, 'mine');
  mkdirSync(mine);
  for (const t of TARGETS) {
    if (!keep(t.name)) continue;
    const tcc = join(CROSS, t.tcc);
    const lib = join(CROSS, t.lib);
    if (!existsSync(tcc) || !existsSync(lib)) {
      process.stdout.write(`  skip ${t.name}（${t.tcc} 没建）\n`);
      continue;
    }
    /* tcc 找支持库认的是**带交叉前缀**的名字（`CONFIG_TCC_CROSSPREFIX`），
     * 所以 `-B` 目录里两个名字都放一份。 */
    const B = join(dir, `B-${t.name}`);
    mkdirSync(B, { recursive: true });
    copyFileSync(lib, join(B, t.lib));
    copyFileSync(lib, join(B, 'libtcc1.a'));
    const libBytes = readFileSync(lib);
    const cflags = [`-B${B}`, `-I${join(SDK, 'usr', 'include')}`];
    const ldflags = [`-B${B}`, `-L${join(SDK, 'usr', 'lib')}`];
    let ok = 0;
    for (const srcs of cases) {
      const stem = `${t.name}-${basename(srcs[0], '.c')}`;
      const objs = [];
      let compiled = true;
      for (let k = 0; k < srcs.length; k++) {
        const objPath = join(dir, `${stem}-${k}.o`);
        const one = spawnSync(tcc, [...cflags, '-c', srcs[k], '-o', objPath], { encoding: 'utf8' });
        if (one.status !== 0 || !existsSync(objPath)) { compiled = false; break; }
        objs.push(objPath);
      }
      if (!compiled) continue;
      const exePath = join(dir, `${stem}.out`);
      const ln = spawnSync(tcc, [...ldflags, ...objs, '-o', exePath], { encoding: 'utf8' });
      if (ln.status !== 0 || !existsSync(exePath)) continue;
      let got;
      try {
        const r = machoExe({
          objs: objs.map((p) => readFileSync(p)),
          dylibs: [tbdText],
          archives: [libBytes],
        });
        got = r.bytes;
        pulled += r.members.length;
      } catch (e) {
        diff++;
        if (diff <= 6) process.stdout.write(`  THROW ${stem}：${e.message}\n`);
        continue;
      }
      const minePath = join(mine, `${stem}.out`);
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
      const want = readFileSync(exePath);
      const d = firstDiff(signed, want);
      if (d < 0) { same++; ok++; bytesTotal += signed.length; continue; }
      diff++;
      if (diff <= 6) {
        process.stdout.write(`  DIFF ${stem}：第一个不同在 0x${d.toString(16)}`
          + `（我们 ${signed[d]?.toString(16)}，tcc ${want[d]?.toString(16)}；`
          + `${signed.length}/${want.length} 字节）\n`);
      }
    }
    process.stdout.write(`  ${t.name}: ${ok} 份可执行文件逐字节相同\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 条相同, ${diff} 条不同`
  + `（共 ${bytesTotal} 字节，从 libtcc1.a 里拉了 ${pulled} 个成员）\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/macho-libc: 写出来的可执行文件与 tcc 不一样\n');
  process.exitCode = 1;
}
