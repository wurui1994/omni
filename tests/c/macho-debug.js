#!/usr/bin/env node
/* macOS 上的 `-g`：stabs 与 dwarf 两路都与 tcc 逐字节相同（ADR-0017 第九刀第七十九片）。
 *
 * 尺子：`<target>-osx-tcc -gstabs|-gdwarf -nostdlib a.o -o a.out`（`-shared` 出 dylib）。
 *
 * 这一路牵出三件事：
 *
 *  - 调试那几节要跟着并进来（`linkObjects` 的 `debug`/`dwarf`）—— stabs 是
 *    `.stab`/`.stabstr`，dwarf 是十来节，其中大半是空的。macOS 上 `-gdwarf` 的默认
 *    版本是 **2**（`DEFAULT_DWARF_VERSION`，别的目标是 5），所以没有 `.debug_line_str`。
 *  - `collect_sections` 里 dwarf 的六节各自一类，落进 `__DWARF` 段（`__debug_info`
 *    `__debug_abbrev` `__debug_line` `__debug_aranges` `__debug_str`
 *    `__debug_line_str`），标志带 `S_ATTR_DEBUG`。别的 `.debug_*`（`.debug_ranges`
 *    之类）落到 `sk_ro_data` —— 它们本来就是空的。
 *  - 调试节里指向调试节的 `R_DATA_32DW` 写的是**节内偏移**（`relocate_section` 里
 *    `is_dwarf` 那道岔），不是绝对地址。
 *
 * 从 `.o` 里读进来的 `.stab` 是**丢掉**的（`sk_stab` 认的是本次编译造的那一节），
 * 所以 stabs 那一路的产物里没有 `__stab`，只是符号表里多了几条。
 *
 *   node tests/c/macho-debug.js
 *   node tests/c/macho-debug.js arm64
 */

import {
  readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync,
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
  process.stdout.write('c/macho-debug: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

/** 每条一份链接：几个源文件，加上要不要 `-shared`。挑的都是不用 libc 的 ——
 * `-nostdlib` 下 tcc 自己也链不上要 `printf` 的那些。 */
const CASES = [
  { name: 'expr', srcs: [join(here, 'gen', '01-expr.c')] },
  { name: 'pointer', srcs: [join(here, 'gen', '04-pointer.c')] },
  { name: 'global', srcs: [join(here, 'gen', '05-global.c')] },
  { name: 'weak', srcs: [join(here, 'elf-gen', '12-weak.c')] },
  { name: 'consts', srcs: [join(here, 'elf-gen', '13-consts.c')] },
  { name: 'tls', srcs: [join(here, 'elf-gen', '16-tls.c')] },
  { name: 'fixups', srcs: [join(here, 'macho-gen', '20-fixups.c')] },
  { name: 'init', srcs: [join(here, 'macho-gen', '21-init.c')] },
  { name: 'two-objs', srcs: [join(here, 'elf-gen', '14-multi-a.c'), join(here, 'elf-gen', '14-multi-b.c')] },
  { name: 'so', srcs: [join(here, 'macho-gen', '22-bss.c')], shared: true },
];

/** 两路调试信息。macOS 上 `-gdwarf` 是版本 2。 */
const MODES = [{ flag: '-gstabs', dwarf: 0 }, { flag: '-gdwarf', dwarf: 2 }];

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const dir = mkdtempSync(join(tmpdir(), 'omni-machodebug-'));
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
    for (const c of CASES) {
      if (!keep(c.name)) continue;
      for (const m of MODES) {
        const tag = `${t.name}-${c.name}${m.flag}`;
        const run = (args) => spawnSync(tcc, args, { encoding: 'utf8' });
        const objs = [];
        let compiled = true;
        for (let k = 0; k < c.srcs.length; k++) {
          const p = join(dir, `${tag}-${k}.o`);
          if (run([m.flag, '-c', c.srcs[k], '-o', p]).status !== 0 || !existsSync(p)) {
            compiled = false;
            break;
          }
          objs.push(p);
        }
        if (!compiled) continue;
        const outPath = join(dir, `${tag}${c.shared === true ? '.dylib' : '.out'}`);
        const ln = run([m.flag, '-nostdlib', ...(c.shared === true ? ['-shared'] : []),
          ...objs, '-o', outPath]);
        if (ln.status !== 0 || !existsSync(outPath)) {
          diff++;
          if (diff <= 6) process.stdout.write(`  tcc 自己就链不上 ${tag}：${ln.stderr}\n`);
          continue;
        }
        let got;
        try {
          got = machoExe({
            objs: objs.map((p) => readFileSync(p)),
            shared: c.shared === true,
            debug: true,
            dwarf: m.dwarf,
            outName: outPath,
          }).bytes;
        } catch (e) {
          diff++;
          if (diff <= 6) process.stdout.write(`  THROW ${tag}：${e.message}\n`);
          continue;
        }
        /* 签名里的 identifier 取的是文件名，两边名字得一样。 */
        const minePath = join(mine, `${tag}${c.shared === true ? '.dylib' : '.out'}`);
        writeFileSync(minePath, got);
        if (t.sign) {
          const sign = spawnSync('codesign', ['-f', '-s', '-', minePath], { encoding: 'utf8' });
          if (sign.status !== 0) {
            diff++;
            if (diff <= 6) process.stdout.write(`  SIGN ${tag}：${(sign.stderr ?? '').trim()}\n`);
            continue;
          }
        }
        const signed = readFileSync(minePath);
        const want = readFileSync(outPath);
        const d = firstDiff(signed, want);
        if (d < 0) { same++; ok++; bytesTotal += signed.length; continue; }
        diff++;
        if (diff <= 6) {
          process.stdout.write(`  DIFF ${tag}：第一个不同在 0x${d.toString(16)}`
            + `（我们 ${signed[d]?.toString(16)}，tcc ${want[d]?.toString(16)}；`
            + `${signed.length}/${want.length} 字节）\n`);
        }
      }
    }
    process.stdout.write(`  ${t.name}: ${ok} 份产物逐字节相同\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 条相同, ${diff} 条不同（共 ${bytesTotal} 字节）\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/macho-debug: 带 -g 写出来的产物与 tcc 不一样\n');
  process.exitCode = 1;
}
