#!/usr/bin/env node
/* 用我们的链接器把 **tcc 自己** 在 macOS 上链出来（第九刀第五十七片）。
 *
 * PE 那一路有 `tests/c/pe-tcc.js`，这是 Mach-O 的那一份：把 tinycc 整份源码交叉编成
 * 目标文件（`ONE_SOURCE` 一个、拆开编十二个），再用 `machoExe` 链成可执行文件，与
 * `<target>-osx-tcc t.o -o tcc` 逐字节比。arm64 那一份签完名还真的跑一遍 —— 让它去编
 * 一个 hello。
 *
 *   node tests/c/macho-tcc.js
 *   node tests/c/macho-tcc.js arm64
 */

import {
  readFileSync, writeFileSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { machoExe } from '../../src/core/link/macho_exe.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CROSS = join(root, '.omni-cache', 'tcc-cross');

const TARGETS = [
  {
    name: 'x86_64-macos',
    tcc: 'x86_64-osx-tcc',
    lib: 'x86_64-osx-libtcc1.a',
    def: 'TCC_TARGET_X86_64',
    gen: ['x86_64-gen', 'x86_64-link', 'i386-asm'],
    sign: false,
  },
  {
    name: 'arm64-macos',
    tcc: 'arm64-osx-tcc',
    lib: 'arm64-osx-libtcc1.a',
    def: 'TCC_TARGET_ARM64',
    gen: ['arm64-gen', 'arm64-link', 'arm64-asm'],
    sign: true,
  },
];

/** 拆开编的那一份：非 `ONE_SOURCE` 时这几个 `.c` 各出一个 `.o`（`tccmacho` 替了 `tccpe`）。 */
const PARTS = ['tcc', 'libtcc', 'tccpp', 'tccgen', 'tccdbg', 'tccelf', 'tccasm', 'tccrun',
  'tccmacho'];

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
  process.stdout.write('c/macho-tcc: 交叉编译器还没建，跳过\n');
  process.exit(0);
}
const probe = spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' });
const SDK = probe.status === 0 ? probe.stdout.trim()
  : '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk';
const TBD = join(SDK, 'usr', 'lib', 'libc.tbd');
if (!existsSync(TBD)) {
  process.stdout.write(`c/macho-tcc: 找不到 ${TBD}，跳过\n`);
  process.exit(0);
}
const tbdText = readFileSync(TBD, 'utf8');

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const dir = mkdtempSync(join(tmpdir(), 'omni-machotcc-'));
let same = 0;
let diff = 0;

/** 一组源文件各编一个 `.o`，tcc 链一遍、我们链一遍，逐字节比。回我们那份的路径。 */
function round(t, tcc, B, one, srcs, label) {
  const flags = [`-B${B}`, `-I${CROSS}`, `-I${join(src, 'include')}`, `-I${src}`,
    `-I${join(SDK, 'usr', 'include')}`,
    '-DTCC_TARGET_MACHO', `-D${t.def}`, `-DONE_SOURCE=${one}`];
  const objPaths = [];
  for (const s of srcs) {
    const p = join(dir, `${t.name}-${label}-${s}.o`);
    const r = spawnSync(tcc, [...flags, '-c', join(src, `${s}.c`), '-o', p], { encoding: 'utf8' });
    if (r.status !== 0 || !existsSync(p)) {
      process.stdout.write(`  skip ${t.name} ${label}（编不出 ${s}.o：`
        + `${(r.stderr ?? '').split('\n')[0]}）\n`);
      return null;
    }
    objPaths.push(p);
  }
  const mine = join(dir, 'mine', label);
  mkdirSync(mine, { recursive: true });
  const theirs = join(dir, 'theirs', label);
  mkdirSync(theirs, { recursive: true });
  const exePath = join(theirs, `${t.name}-tcc`);
  const link = spawnSync(tcc, [...flags, `-L${join(SDK, 'usr', 'lib')}`, ...objPaths,
    '-o', exePath], { encoding: 'utf8' });
  if (link.status !== 0 || !existsSync(exePath)) {
    process.stdout.write(`  skip ${t.name} ${label}（tcc 自己链不出来：`
      + `${(link.stderr ?? '').split('\n')[0]}）\n`);
    return null;
  }
  let got;
  try {
    got = machoExe({
      objs: objPaths.map((p) => readFileSync(p)),
      dylibs: [tbdText],
      archives: [readFileSync(join(CROSS, t.lib))],
    });
  } catch (e) {
    diff++;
    process.stdout.write(`  THROW ${t.name} ${label}：${e.message}\n`);
    return null;
  }
  const minePath = join(mine, `${t.name}-tcc`);
  writeFileSync(minePath, got.bytes, { mode: 0o755 });
  if (t.sign) {
    const sign = spawnSync('codesign', ['-f', '-s', '-', minePath], { encoding: 'utf8' });
    if (sign.status !== 0) {
      diff++;
      process.stdout.write(`  SIGN ${t.name} ${label}：${(sign.stderr ?? '').trim()}\n`);
      return null;
    }
  }
  const mineBytes = readFileSync(minePath);
  const want = readFileSync(exePath);
  const d = firstDiff(mineBytes, want);
  if (d < 0) {
    same++;
    process.stdout.write(`  ${t.name} ${label}: ${want.length} 字节逐字节相同`
      + `（${objPaths.length} 个 .o、${got.ncmds} 条加载命令、${got.nsects} 节`
      + `${got.members.length === 0 ? '' : `、${got.members.length} 个库成员`}）\n`);
    return minePath;
  }
  diff++;
  process.stdout.write(`  DIFF ${t.name} ${label}：第一个不同在 0x${d.toString(16)}`
    + `（我们 ${mineBytes[d]?.toString(16)}，tcc ${want[d]?.toString(16)}；`
    + `${mineBytes.length}/${want.length} 字节）\n`);
  return null;
}

try {
  for (const t of TARGETS) {
    if (!keep(t.name)) continue;
    if (!existsSync(join(CROSS, t.tcc))) {
      process.stdout.write(`  skip ${t.name}（${t.tcc} 没建）\n`);
      continue;
    }
    const tcc = join(CROSS, t.tcc);
    const B = join(dir, `B-${t.name}`);
    mkdirSync(B, { recursive: true });
    copyFileSync(join(CROSS, t.lib), join(B, t.lib));
    copyFileSync(join(CROSS, t.lib), join(B, 'libtcc1.a'));
    const oursOne = round(t, tcc, B, 1, ['tcc'], 'one-source');
    round(t, tcc, B, 0, [...PARTS, ...t.gen], 'parts');
    /* arm64 那一份是本机能跑的：让我们链出来的 tcc 去编一个 hello，再跑一遍。 */
    if (t.sign && oursOne !== null) {
      const hello = join(dir, 'hello.c');
      writeFileSync(hello, '#include <stdio.h>\nint main(){printf("hi from ours\\n");return 0;}\n');
      const out = join(dir, 'hello');
      const cc = spawnSync(oursOne, [`-B${B}`, `-I${join(SDK, 'usr', 'include')}`,
        `-L${join(SDK, 'usr', 'lib')}`, hello, '-o', out], { encoding: 'utf8' });
      const run = cc.status === 0 && existsSync(out)
        ? spawnSync(out, [], { encoding: 'utf8' }) : null;
      if (run !== null && run.status === 0 && run.stdout.trim() === 'hi from ours') {
        process.stdout.write('  我们链出来的 tcc 能编能跑：hi from ours\n');
      } else {
        diff++;
        process.stdout.write('  我们链出来的 tcc 跑不起来：'
          + `${(cc.stderr ?? '').split('\n')[0]}${(run?.stderr ?? '').split('\n')[0]}\n`);
      }
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 条相同, ${diff} 条不同\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/macho-tcc: 与 tcc 自己链的不一样\n');
  process.exitCode = 1;
}
