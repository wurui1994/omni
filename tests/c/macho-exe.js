#!/usr/bin/env node
/* 整份 Mach-O 可执行文件与 tcc 逐字节相同（ADR-0017 第九刀第五十五片）。
 *
 * 尺子：`<target>-osx-tcc -nostdlib a.o -o a.out`。
 *
 * 为什么要在临时目录里凑一样的文件名：tcc 写完文件自己喊了一句
 * `codesign -f -s - <file>`（`CONFIG_CODESIGN`），而 ad-hoc 签名里的 identifier
 * 取的是**文件名**。两边名字一样，签出来的字节才一样 —— 试过了：同名两次签名逐字节
 * 相同，改个名字第 849 字节起就不同。于是门里把我们写出的（还没签名的）字节放到
 * 另一个目录、同一个名字下，签一遍，再整份比。
 *
 *   node tests/c/macho-exe.js
 *   node tests/c/macho-exe.js arm64
 */

import {
  readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, readdirSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
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
  process.stdout.write('c/macho-exe: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

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

const dir = mkdtempSync(join(tmpdir(), 'omni-machoexe-'));
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
      if (!compiled) continue;                                   // 要 libc 的头，编不了
      const exePath = join(dir, `${stem}.out`);
      const ln = spawnSync(tcc, ['-nostdlib', ...objs, '-o', exePath], { encoding: 'utf8' });
      if (ln.status !== 0 || !existsSync(exePath)) continue;      // 要 libc 的符号，链不了
      let got;
      try {
        got = machoExe({ objs: objs.map((p) => readFileSync(p)) }).bytes;
      } catch (e) {
        diff++;
        if (diff <= 6) process.stdout.write(`  THROW ${stem}：${e.message}\n`);
        continue;
      }
      /* 同名同签：我们的放在 mine/ 底下，名字跟 tcc 那份一模一样。
       * 只有**本机那个目标**（arm64）的 tcc 才带 `CONFIG_CODESIGN` —— 那个宏在
       * `config.h` 里裹在「没指定目标时」的 `#if` 里头，交叉编译出来的
       * `x86_64-osx-tcc` 于是根本不签名。 */
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

process.stdout.write(`\n${same} 条相同, ${diff} 条不同（共 ${bytesTotal} 字节）\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/macho-exe: 写出来的可执行文件与 tcc 不一样\n');
  process.exitCode = 1;
}
