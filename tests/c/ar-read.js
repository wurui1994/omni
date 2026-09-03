#!/usr/bin/env node
/* 静态库读得对（ADR-0017 第九刀第四十六片）。
 *
 * 拿交叉编译出来的那几个 `libtcc1.a`，与系统 `ar` 对三件事：
 *
 *  1. 成员的名字与次序（`ar t`）；
 *  2. 每个成员的字节（`ar p`）；
 *  3. 符号索引里每条记的偏移，都正好是某个成员头的偏移。
 *
 * 第三条是我们自己的账：`tcc_load_alacarte` 就是照那些偏移去拉成员的，偏移错一个
 * 字节就会读到一堆垃圾。顺带把「按需取用要转圈」那条也走一遍。
 *
 *   node tests/c/ar-read.js
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readArchive, alacarte } from '../../src/core/link/ar.js';
import { readObject } from '../../src/core/link/elf.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CROSS = join(root, '.omni-cache', 'tcc-cross');

if (!existsSync(CROSS)) {
  process.stdout.write('c/ar-read: 交叉编译器还没建，跳过\n');
  process.exit(0);
}
if (spawnSync('ar', ['--version'], { encoding: 'utf8' }).error !== undefined
  && spawnSync('ar', [], { encoding: 'utf8' }).error !== undefined) {
  process.stdout.write('c/ar-read: 没有系统 ar（尺子），跳过\n');
  process.exit(0);
}

const libs = readdirSync(CROSS).filter((f) => f.endsWith('libtcc1.a')).sort();
if (libs.length === 0) {
  process.stdout.write('c/ar-read: 一个 libtcc1.a 都没有，跳过\n');
  process.exit(0);
}

let ok = 0;
let failed = 0;
let members = 0;
let syms = 0;
for (const lib of libs) {
  const path = join(CROSS, lib);
  const bytes = readFileSync(path);
  let ar;
  try {
    ar = readArchive(bytes);
  } catch (e) {
    failed++;
    process.stdout.write(`  FAIL ${lib}：读不进来 —— ${e.message}\n`);
    continue;
  }

  /* 32 位的目标（i386/arm）不在我们的账上 —— ELF 的读法只认 64 位小端（第九刀只
   * 复刻 arm64 与 x86_64）。看第一个成员的 `EI_CLASS` 就知道。 */
  if (ar.members.length !== 0 && ar.members[0].bytes[4] !== 2) {
    process.stdout.write(`  skip ${lib}（32 位的目标，不在这一刀的账上）\n`);
    continue;
  }

  /* 一、名字与次序。 */
  const t = spawnSync('ar', ['t', path], { encoding: 'utf8' });
  if (t.status !== 0) {
    process.stdout.write(`  skip ${lib}（系统 ar 读不了它：${(t.stderr ?? '').trim()}）\n`);
    continue;
  }
  /* 系统 `ar t` 会把符号索引那个成员（名叫 `/`）与长名字表（`//`）也列出来，
   * 它们不是真成员 —— tcc 把 `/` 当索引、`//` 当名字表，我们也一样。 */
  const want = t.stdout.split('\n').map((s) => s.trim())
    .filter((s) => s !== '' && s !== '/' && s !== '//' && s !== '/SYM64/');
  const got = ar.members.map((m) => m.name);
  /* tcc 自己写的库里名字带不带尾巴的 `/` 看平台，比的时候两边都去掉。 */
  const norm = (s) => (s.endsWith('/') ? s.slice(0, -1) : s);
  const sameNames = want.length === got.length
    && want.every((w, i) => norm(w) === norm(got[i]));
  if (!sameNames) {
    failed++;
    process.stdout.write(`  FAIL ${lib}：成员名字/次序不同\n    ar t  ${want.slice(0, 6).join(' ')}…（${want.length} 个）\n`
      + `    ours  ${got.slice(0, 6).join(' ')}…（${got.length} 个）\n`);
    continue;
  }

  /* 二、每个成员的内容都得是一份读得进来的 `ET_REL`。
   *
   * 这儿本来想用 `ar p` 对字节，但 macOS 的 BSD `ar` 做不到：tcc 写库时名字只有
   * 16 字节那一格，超长的就被截掉（`x86_64-osx-libtcc1.o` -> `x86_64-osx-libt/`），
   * 而 BSD `ar` 按完整名字找成员，于是 `ar p` 一律「not found in archive」。
   * 退一步用 `readObject`：偏移或长度错一个字节，ELF 的头就对不上了。 */
  let bad = null;
  for (const m of ar.members) {
    try {
      const o = readObject(m.bytes);
      if (o.secs.length === 0) bad = `${m.name}：一节都没有`;
    } catch (e) {
      bad = `${m.name}：读不成目标文件 —— ${e.message}`;
    }
    if (bad !== null) break;
  }
  if (bad !== null) {
    failed++;
    process.stdout.write(`  FAIL ${lib}：${bad}\n`);
    continue;
  }

  /* 三、符号索引里的偏移都落在成员头上。 */
  if (ar.index === null) {
    failed++;
    process.stdout.write(`  FAIL ${lib}：没读到符号索引\n`);
    continue;
  }
  const heads = new Set(ar.members.map((m) => m.at));
  const stray = ar.index.syms.find((s) => !heads.has(s.at));
  if (stray !== undefined) {
    failed++;
    process.stdout.write(`  FAIL ${lib}：索引里 '${stray.name}' 指的 0x${stray.at.toString(16)} 不是成员头\n`);
    continue;
  }

  /* 顺带走一遍按需取用：只要一个符号，看它连带拉进来几个成员。 */
  const first = ar.index.syms[0].name;
  const need = new Set([first]);
  const pulled = alacarte(ar, (n) => need.has(n), (m) => {
    /* 真的链接时这儿要把成员并进来、把它带的未定义符号加进 need；这一份只数个数。 */
    need.delete(first);
    void m;
  });

  ok++;
  members += ar.members.length;
  syms += ar.index.syms.length;
  process.stdout.write(`  ok   ${lib}：${ar.members.length} 个成员、${ar.index.syms.length} 条索引`
    + `（要 '${first}' 拉进来 ${pulled.length} 个）\n`);
}

process.stdout.write(`\n${ok} 个库读对了, ${failed} 个不对（共 ${members} 个成员、${syms} 条索引）\n`);
if (failed !== 0 || ok === 0) {
  process.stdout.write('c/ar-read: 静态库读得不对 —— 与系统 ar 差了一格\n');
  process.exitCode = 1;
}
