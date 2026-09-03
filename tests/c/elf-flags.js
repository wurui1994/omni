#!/usr/bin/env node
/* 链接器那几个开关与 tcc 逐字节相同（ADR-0017 第九刀第六十二片）。
 *
 * 一份用例编一次，按四种开关各链一遍：
 *
 *   -pie                            位置无关的可执行文件（ET_DYN + DF_1_PIE）
 *   -rdynamic                       所有有定义的非局部符号都进 `.dynsym`
 *   -Wl,-rpath=…                    DT_RPATH
 *   -Wl,-rpath=…,--enable-new-dtags DT_RUNPATH
 *   -shared -Wl,-soname=…           DT_SONAME
 *
 *   node tests/c/elf-flags.js
 *   node tests/c/elf-flags.js arm64
 */

import {
  readFileSync, existsSync, mkdtempSync, rmSync, readdirSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { elfExe } from '../../src/core/link/elf_exe.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CROSS = join(root, '.omni-cache', 'tcc-cross');
/* `-pie` 在 tcc 的命令行上是个空壳（选项表里那条 `{ "pie", 0, 0 }`）—— 位置无关的
 * 可执行文件是**编译期**配出来的：`tcc_set_output_type` 里那句
 * `#ifdef CONFIG_TCC_PIE ... output_type |= TCC_OUTPUT_DYN`。所以这一路的尺子是
 * 另一份交叉编译器：
 *
 *   mkdir .omni-cache/tcc-pie && cd .omni-cache/tcc-pie
 *   <tinycc>/configure --enable-cross && make x86_64-tcc arm64-tcc \
 *     EXTRA-DEFS=-DCONFIG_TCC_PIE=1
 *
 * （`--config-pie` 不够用：configure 把那一整块塞在 `#if !(TCC_TARGET_…)` 里，
 * 交叉编译的目标是在命令行上给的，于是整块被跳过。）
 */
const PIE = join(root, '.omni-cache', 'tcc-pie');

const TARGETS = [
  { name: 'x86_64-linux', tcc: 'x86_64-tcc' },
  { name: 'arm64-linux', tcc: 'arm64-tcc' },
  /* 32 位那两个（第九刀第七十五片）。`-pie` 那一档要另一份交叉编译器，没建就跳过。 */
  { name: 'i386-linux', tcc: 'i386-tcc' },
  { name: 'arm-linux', tcc: 'arm-tcc' },
  /* riscv64（第九刀第七十六片）。 */
  { name: 'riscv64-linux', tcc: 'riscv64-tcc' },
];

const RPATH = '/opt/omni/lib:/usr/local/omni';
const SONAME = 'libomni.so.1';

/** 每一种开关：给 tcc 的那几个字，给我们的那几个键；`dir` 是拿哪一份 tcc 当尺子。 */
const MODES = [
  { name: 'pie', args: [], opt: { pie: true }, dir: PIE },
  { name: 'rdynamic', args: ['-rdynamic'], opt: { rdynamic: true } },
  { name: 'rpath', args: [`-Wl,-rpath=${RPATH}`], opt: { rpath: RPATH } },
  {
    name: 'runpath',
    args: [`-Wl,-rpath=${RPATH}`, '-Wl,--enable-new-dtags'],
    opt: { rpath: RPATH, newDtags: true },
  },
  {
    name: 'soname',
    args: ['-shared', `-Wl,-soname=${SONAME}`],
    opt: { shared: true, soname: SONAME },
  },
];

const filters = process.argv.slice(2).filter((x) => !x.startsWith('-'));
const keep = (s) => filters.length === 0 || filters.some((f) => s.includes(f));

if (!existsSync(CROSS)) {
  process.stdout.write('c/elf-flags: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

const DIRS = [join(here, 'gen'), join(here, 'elf-gen')];
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

const dir = mkdtempSync(join(tmpdir(), 'omni-elfflags-'));
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
    let ok = 0;
    for (const srcs of cases) {
      const stem = `${t.name}-${basename(srcs[0], '.c')}`;
      const objs = [];
      let compiled = true;
      for (let k = 0; k < srcs.length; k++) {
        const objPath = join(dir, `${stem}-${k}.o`);
        const one = spawnSync(tcc, ['-c', srcs[k], '-o', objPath], { encoding: 'utf8' });
        if (one.status !== 0 || !existsSync(objPath)) { compiled = false; break; }
        objs.push(objPath);
      }
      if (!compiled) continue;
      const bytes = objs.map((p) => readFileSync(p));
      for (const m of MODES) {
        const ruler = m.dir === undefined ? tcc : join(m.dir, t.tcc);
        if (!existsSync(ruler)) continue;
        const outPath = join(dir, `${stem}-${m.name}.out`);
        const ln = spawnSync(
          ruler,
          [...m.args, '-nostdlib', '-Wl,-e,main', ...objs, '-o', outPath],
          { encoding: 'utf8' },
        );
        if (ln.status !== 0 || !existsSync(outPath)) continue;
        let got;
        try {
          got = elfExe({ objs: bytes, entryName: 'main', ...m.opt }).bytes;
        } catch (e) {
          diff++;
          if (diff <= 6) process.stdout.write(`  THROW ${stem}-${m.name}：${e.message}\n`);
          continue;
        }
        const want = readFileSync(outPath);
        const d = firstDiff(got, want);
        if (d < 0) { same++; ok++; bytesTotal += got.length; continue; }
        diff++;
        if (diff <= 6) {
          process.stdout.write(`  DIFF ${stem}-${m.name}：第一个不同在 0x${d.toString(16)}`
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

process.stdout.write(`\n${same} 条相同, ${diff} 条不同（共 ${bytesTotal} 字节）\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/elf-flags: 写出来的文件与 tcc 不一样\n');
  process.exitCode = 1;
}
