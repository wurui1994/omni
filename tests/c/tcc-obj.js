#!/usr/bin/env node
/* 与**交叉编译的 tcc** 逐字节对账（ADR-0017 第九刀第三十七片）。
 *
 * 这一份是新的那把尺子。与 `native-gen.js` 分工清楚：
 *
 *   native-gen.js   我们出 `.o` -> clang 链 -> 真进程跑，与 `tcc -run` 比**输出**
 *   这一份           我们出目标文件，与 `<target>-tcc -c` 出的目标文件比**字节**
 *
 * 为什么要换尺子：clang 那条腿只能覆盖本机这一个目标（本机的 clang/llvm 没法方便地
 * 交叉编译），而 PE 与 ELF 也在要支持的范围里。tcc 能把交叉编译全开，而编译是一个纯
 * 计算过程 —— 同一份输入、同一个目标，写出来的字节应当唯一。
 *
 * **一条要记住的事实**：tcc 的 `-c` 在**所有**目标上都写 ELF（osx 与 win32 也一样）。
 * Mach-O（`tccmacho.c`）与 PE（`tccpe.c`）只在最终可执行文件那一步出现。所以「目标文件
 * 对齐」只有一种格式要复刻，四个目标共用，差别只在 `e_machine` 与重定位号。
 *
 * 交叉编译器：
 *   mkdir .omni-cache/tcc-cross && cd .omni-cache/tcc-cross
 *   <tinycc>/configure --enable-cross && make -j8 cross
 *
 *   node tests/c/tcc-obj.js              # 全部目标、全部用例
 *   node tests/c/tcc-obj.js arm64-osx    # 只跑名字里带这个的目标
 */

import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CROSS = join(root, '.omni-cache', 'tcc-cross');
const CLI = join(root, 'stage0', 'src', 'cli.js');

/** tinycc 的源码在哪儿：从交叉编译目录的 `config.mak` 里读（`-B` 要用它）。 */
function tccSrc() {
  const mak = join(CROSS, 'config.mak');
  if (!existsSync(mak)) return null;
  const m = /^TOPSRC=(.*)$/m.exec(readFileSync(mak, 'utf8'));
  return m === null ? null : m[1].trim();
}

/* 目标：名字、交叉编译器、我们这边的 `--arch` 与 `--os`。win32 那几个的 `-B` 要指到 `win32/`。
 * `os` 只决定一件事：符号名前面那条下划线 —— osx 与 win32 有，linux 没有。 */
const TARGETS = [
  { name: 'arm64-osx', tcc: 'arm64-osx-tcc', arch: 'arm64', os: 'osx', win32: false },
  { name: 'x86_64-osx', tcc: 'x86_64-osx-tcc', arch: 'x86_64', os: 'osx', win32: false },
  { name: 'x86_64-linux', tcc: 'x86_64-tcc', arch: 'x86_64', os: 'linux', win32: false },
  { name: 'arm64-linux', tcc: 'arm64-tcc', arch: 'arm64', os: 'linux', win32: false },
  { name: 'x86_64-win32', tcc: 'x86_64-win32-tcc', arch: 'x86_64', os: 'win32', win32: true },
  { name: 'arm64-win32', tcc: 'arm64-win32-tcc', arch: 'arm64', os: 'win32', win32: true },
];

const filters = process.argv.slice(2).filter((x) => !x.startsWith('-'));
const keep = (s) => filters.length === 0 || filters.some((f) => s.includes(f));

const SRC = join(here, 'gen');
const cases = existsSync(SRC)
  ? readdirSync(SRC).filter((f) => f.endsWith('.c')).sort()
  : [];

const src = tccSrc();
if (src === null) {
  process.stdout.write(`c/tcc-obj: 没找到 ${CROSS}/config.mak —— 交叉编译器还没建，跳过\n`
    + '  mkdir -p .omni-cache/tcc-cross && cd .omni-cache/tcc-cross\n'
    + '  <tinycc>/configure --enable-cross && make -j8 cross\n');
  process.exit(0);
}

/** 头四个字节是什么格式。 */
function formatOf(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45
    && bytes[2] === 0x4c && bytes[3] === 0x46) return 'ELF';
  if (bytes.length >= 4 && bytes[0] === 0xcf && bytes[1] === 0xfa
    && bytes[2] === 0xed && bytes[3] === 0xfe) return 'Mach-O';
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) return 'PE';
  return '?';
}

/** 第一个不同的字节在哪儿；一样就回 -1。 */
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/**
 * 读一个 ELF 目标文件的节头表 —— 只为了**报账**：容器对上了多少。
 *
 * 第三十八片之后我们与 tcc 写的是同一种格式，于是差别可以说得比「第一个不同的字节在
 * 0x0」细得多：节的名字与形状（类型、旗、对齐、`sh_link`/`sh_info`）是容器的事，
 * 而 `sh_size` 与节里的字节是**码**的事 —— 后者要等 B 路（一遍过的那条）才对得上。
 */
function elfSections(b) {
  if (formatOf(b) !== 'ELF' || b.length < 64) return null;
  const shoff = Number(b.readBigUInt64LE(0x28));
  const shnum = b.readUInt16LE(0x3c);
  const shstrndx = b.readUInt16LE(0x3e);
  if (shoff + shnum * 64 > b.length) return null;
  const at = (i) => shoff + i * 64;
  const strOff = Number(b.readBigUInt64LE(at(shstrndx) + 24));
  const nameOf = (n) => {
    let e = strOff + n;
    while (e < b.length && b[e] !== 0) e++;
    return b.toString('latin1', strOff + n, e);
  };
  const out = [];
  for (let i = 1; i < shnum; i++) {
    const o = at(i);
    out.push({
      name: nameOf(b.readUInt32LE(o)),
      shape: [b.readUInt32LE(o + 4), Number(b.readBigUInt64LE(o + 8)),
        b.readUInt32LE(o + 40), b.readUInt32LE(o + 44),
        Number(b.readBigUInt64LE(o + 48)), Number(b.readBigUInt64LE(o + 56))].join('/'),
      size: Number(b.readBigUInt64LE(o + 32)),
    });
  }
  return out;
}

/** 容器对上了没有：节的名字与次序一样、每一节的形状也一样。 */
function sameContainer(got, want) {
  const a = elfSections(got);
  const c = elfSections(want);
  if (a === null || c === null) return false;
  if (a.length !== c.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== c[i].name || a[i].shape !== c[i].shape) return false;
  }
  return true;
}

const dir = mkdtempSync(join(tmpdir(), 'omni-tccobj-'));
let same = 0;
let box = 0;
let diff = 0;
let notYet = 0;
try {
  for (const t of TARGETS) {
    if (!keep(t.name)) continue;
    const tcc = join(CROSS, t.tcc);
    if (!existsSync(tcc)) {
      process.stdout.write(`  skip ${t.name}（${t.tcc} 没建）\n`);
      continue;
    }
    const B = t.win32 ? `-B${join(src, 'win32')}` : `-B${src}`;
    for (const c of cases) {
      if (!keep(c) && filters.length > 0 && !keep(t.name)) continue;
      const cpath = join(SRC, c);
      const refPath = join(dir, `ref-${t.name}-${basename(c, '.c')}.o`);
      const ref = spawnSync(tcc, [B, '-c', cpath, '-o', refPath], { encoding: 'utf8' });
      if (ref.status !== 0 || !existsSync(refPath)) {
        /* tcc 自己都编不过：那不是我们的账（有些用例要它自己没有的头文件）。 */
        continue;
      }
      const want = readFileSync(refPath);
      const ourPath = join(dir, `our-${t.name}-${basename(c, '.c')}.o`);
      const our = spawnSync('node', [CLI, 'c-obj', cpath, '-o', ourPath,
        '--arch', t.arch, '--format', 'elf', '--os', t.os], { encoding: 'utf8' });
      if (our.status !== 0 || !existsSync(ourPath)) {
        notYet++;
        continue;
      }
      const got = readFileSync(ourPath);
      const at = firstDiff(got, want);
      if (at < 0) {
        same++;
        continue;
      }
      if (sameContainer(got, want)) {
        box++;
        continue;
      }
      diff++;
      if (diff <= 6) {
        process.stdout.write(`  DIFF ${t.name} ${c}\n`
          + `    ours ${got.length} 字节（${formatOf(got)}）`
          + ` / tcc ${want.length} 字节（${formatOf(want)}）`
          + `，第一个不同在 0x${at.toString(16)}\n`);
        const a = elfSections(got);
        const w = elfSections(want);
        if (a !== null && w !== null) {
          process.stdout.write(`    节 ours [${a.map((s) => s.name).join(' ')}]\n`
            + `       tcc  [${w.map((s) => s.name).join(' ')}]\n`);
        }
      }
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 字节相同, ${box} 容器相同, ${diff} 不同, ${notYet} 我们还编不出\n`);
/* 「容器相同」的那一栏是这一片新长出来的：节头表、符号表与重定位表的**形状**与 tcc 的
 * 一样，剩下的差别在节里的字节（码本身）与 `sh_size`。逐字节全同要等 B 路 ——
 * 一遍过、寄存器分配与 tcc 相同的那条腿。所以这一份仍然不当门禁，是一把尺子；
 * 真正的门禁在 `tcc-link.js`（我们的 ELF 交给 tcc 的链接器，链出来真的跑）。 */
if (same === 0 && box === 0 && diff === 0 && notYet === 0) {
  process.stdout.write('c/tcc-obj: 一条都没量到（用例或交叉编译器不全）\n');
}
