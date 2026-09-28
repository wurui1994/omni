#!/usr/bin/env node
/* 静态库读得对（ADR-0017 第九刀第四十六片）。
 *
 * 两段：
 *
 * A. 拿交叉编译出来的那几个 `libtcc1.a`（GNU/SysV 那一套：索引叫 `/`、大端、名字只有
 *    16 字节那一格），与系统 `ar` 对三件事 —— 成员名字与次序、每个成员的字节、
 *    索引里每条记的偏移都正好是某个成员头的偏移。没建交叉编译器就跳过这一段。
 *
 * B. **现做一份**（本机 `ar` + 我们自己那台 C 前端编出来的两份 `.o`），名字故意超过
 *    16 字节。macOS 上本机 `ar` 出的是 **BSD 那一套**：长名字写成 `#1/<n>`（真名字在
 *    内容的头 n 个字节里）、索引叫 `__.SYMDEF [SORTED]` 而且是**小端** —— 与 A 段
 *    完全是另一套编码。这一段是第一百四十八片加的：我们自己的链接器原来只认 GNU 那一套，
 *    于是"把借来的那份 CPython 打成 `.a` 摞进产物"第一脚就踩在这儿（当场报
 *    "ar: 这个库没有符号索引"）。Linux 上这一段量的是 GNU 那一套（同一段代码两种编码）。
 *
 * 第三条检查是我们自己的账：`tcc_load_alacarte` 就是照那些偏移去拉成员的，偏移错一个
 * 字节就会读到一堆垃圾。顺带把「按需取用要转圈」那条也走一遍。
 *
 *   node tests/c/ar-read.js
 */

import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readArchive, alacarte, writeArchive } from '../../src/core/link/ar.js';
import { readObject } from '../../src/core/link/elf.js';
import { readSymbols } from '../../src/core/link/pe_load.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CROSS = join(root, '.omni-cache', 'tcc-cross');

const noAr = spawnSync('ar', ['--version'], { encoding: 'utf8' }).error !== undefined
  && spawnSync('ar', [], { encoding: 'utf8' }).error !== undefined;
if (noAr) {
  process.stdout.write('c/ar-read: 没有系统 ar（尺子），跳过\n');
  process.exit(0);
}

let ok = 0;
let failed = 0;
let members = 0;
let syms = 0;
const libs = existsSync(CROSS)
  ? readdirSync(CROSS).filter((f) => f.endsWith('libtcc1.a')).sort() : [];
if (libs.length === 0) process.stdout.write('  skip A 段（没有交叉编译出来的 libtcc1.a）\n');
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

/* ---- B 段：现做一份（本机 `ar` + 我们自己那台 C 前端），名字故意超过 16 字节 ---- */

const work = join(root, '.omni-cache', 'test', 'ar-read');
mkdirSync(work, { recursive: true });
const cli = join(root, 'src', 'cli.js');
const made = [];
let bMade = true;
for (const [name, body] of [
  ['a-very-long-member-name-one.c', 'int ar_probe_one(int x) { return x + 1; }\n'],
  ['a-very-long-member-name-two.c', 'int ar_probe_one(int);\nint ar_probe_two(int x) { return ar_probe_one(x) * 2; }\n'],
]) {
  const src = join(work, name);
  const obj = join(work, `${name.slice(0, -2)}.o`);
  writeFileSync(src, body);
  const r = spawnSync(process.execPath, [cli, 'c', 'obj', src, '-o', obj], { encoding: 'utf8' });
  if (r.status !== 0 || !existsSync(obj)) {
    process.stdout.write(`  skip B 段（我们的 C 前端编不出 ${name}：${(r.stderr ?? '').trim().split('\n')[0]}）\n`);
    bMade = false;
    break;
  }
  made.push(obj);
}
if (bMade) {
  const lib = join(work, 'libarprobe.a');
  spawnSync('rm', ['-f', lib]);
  const a = spawnSync('ar', ['rcs', lib, ...made], { encoding: 'utf8' });
  if (a.status !== 0) {
    failed++;
    process.stdout.write(`  FAIL B 段：本机 ar 打不出库 —— ${(a.stderr ?? '').trim()}\n`);
  } else {
    const ar = readArchive(readFileSync(lib));
    const t = spawnSync('ar', ['t', lib], { encoding: 'utf8' });
    const want = t.stdout.split('\n').map((s) => s.trim())
      .filter((s) => s !== '' && s !== '/' && s !== '//' && s !== '/SYM64/'
        && !s.startsWith('__.SYMDEF'));
    const got = ar.members.map((m) => m.name);
    const sameNames = want.length === got.length && want.every((w, i) => w === got[i]);
    const heads = new Set(ar.members.map((m) => m.at));
    const stray = ar.index === null ? null : ar.index.syms.find((s) => !heads.has(s.at));
    /* 按需取用要**转圈**：只要 `ar_probe_two`，它自己带出 `ar_probe_one`，
     * 于是两个成员都该被拉进来（第二圈拉的那个才是这条判据的重点）。 */
    const need = new Set(['ar_probe_two', '_ar_probe_two']);
    const pulled = ar.index === null ? [] : alacarte(ar, (n) => need.has(n), (m) => {
      for (const n of [...need]) need.delete(n);
      need.add('ar_probe_one');
      need.add('_ar_probe_one');
      void m;
    });
    if (!sameNames) {
      failed++;
      process.stdout.write('  FAIL B 段：长名字读不对\n'
        + `    ar t  ${want.join(' ')}\n    ours  ${got.join(' ')}\n`);
    } else if (ar.index === null) {
      failed++;
      process.stdout.write('  FAIL B 段：没读到符号索引（macOS 上是 __.SYMDEF、小端）\n');
    } else if (stray !== undefined && stray !== null) {
      failed++;
      process.stdout.write(`  FAIL B 段：索引里 '${stray.name}' 指的 0x${stray.at.toString(16)} 不是成员头\n`);
    } else if (pulled.length !== 2) {
      failed++;
      process.stdout.write(`  FAIL B 段：按需取用该转一圈拉两个成员，拉到 ${pulled.length} 个\n`);
    } else {
      ok++;
      members += ar.members.length;
      syms += ar.index.syms.length;
      process.stdout.write(`  ok   现做的那份（${process.platform === 'darwin' ? 'BSD' : 'GNU'} 那一套）：`
        + `${ar.members.length} 个长名字成员、${ar.index.syms.length} 条索引，按需取用转圈拉了 2 个\n`);
    }
  }
}

/* ---- C 段：**我们自己打的那份**（`writeArchive`）—— 写出去再读回来 ---- */

if (bMade && made.length === 2) {
  const bytesOf = (p) => {
    const b = readFileSync(p);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  };
  /* 这一段要 **ELF 那种 `.o`**（符号表得我们自己读得懂），所以同两份源再编一遍
   * （`--format elf --os osx` —— mac 上 `c obj` 默认出 Mach-O）。这也正是"全自己那条链"
   * 用的格式：我们自己的链接器吃的就是 ELF 的 `.o`。 */
  const elfObjs = [];
  for (const o of made) {
    const src = `${o.slice(0, -2)}.c`;
    const out = `${o.slice(0, -2)}-elf.o`;
    const r = spawnSync(process.execPath, [cli, 'c', 'obj', '--format', 'elf', '--os', 'osx',
      src, '-o', out], { encoding: 'utf8' });
    if (r.status !== 0 || !existsSync(out)) {
      process.stdout.write(`  skip C 段（ELF 那一格编不出：${(r.stderr ?? '').trim().split('\n')[0]}）\n`);
      break;
    }
    elfObjs.push(out);
  }
  /* 成员名字故意超过 16 字节 —— 走的是 GNU 的 `//` 长名字表那一路。
   * 符号由 ELF 的 `.symtab` 说（GLOBAL 且 shndx 不为 0 = 这个成员定义了它）。 */
  const mem = elfObjs.map((o) => {
    const bytes = bytesOf(o);
    const syms = readSymbols(readObject(bytes))
      .filter((s) => s.name !== '' && s.bind === 1 && s.shndx !== 0).map((s) => s.name);
    return { name: o.slice(o.lastIndexOf('/') + 1), bytes, syms };
  });
  if (mem.length !== 2) { /* 上面已经说过为什么跳过 */ } else {
  const a = writeArchive(mem);
  const back = readArchive(a);
  const names = back.members.map((m) => m.name);
  const sameNames = names.length === mem.length && names.every((n, i) => n === mem[i].name);
  const sameBytes = back.members.every((m, i) => m.bytes.length === mem[i].bytes.length
    && m.bytes.every((b, k) => b === mem[i].bytes[k]));
  const heads = new Set(back.members.map((m) => m.at));
  const stray = back.index === null ? null : back.index.syms.find((s) => !heads.has(s.at));
  const want2 = mem[1].syms.find((s) => /ar_probe_two/.test(s));
  const want1 = mem[0].syms.find((s) => /ar_probe_one/.test(s));
  const need = new Set([want2]);
  const pulled = back.index === null ? [] : alacarte(back, (n) => need.has(n), () => {
    need.delete(want2);
    need.add(want1);
  });
  if (!sameNames) {
    failed++;
    process.stdout.write(`  FAIL C 段：名字读不回来\n    打进去 ${mem.map((m) => m.name).join(' ')}\n    读回来 ${names.join(' ')}\n`);
  } else if (!sameBytes) {
    failed++;
    process.stdout.write('  FAIL C 段：成员的字节读不回来（偏移或补齐错了）\n');
  } else if (back.index === null || (stray !== undefined && stray !== null)) {
    failed++;
    process.stdout.write(`  FAIL C 段：符号索引不对（${back.index === null ? '没有' : `'${stray.name}' 指到非成员头`}）\n`);
  } else if (pulled.length !== 2) {
    failed++;
    process.stdout.write(`  FAIL C 段：按需取用该转一圈拉两个成员，拉到 ${pulled.length} 个\n`);
  } else {
    ok++;
    members += back.members.length;
    syms += back.index.syms.length;
    process.stdout.write(`  ok   我们自己打的那份（GNU 那一套：\`/\` 索引 + \`//\` 长名字表）：`
      + `${back.members.length} 份成员、${back.index.syms.length} 条索引，字节与名字都读得回来\n`);
  }
  }
}

process.stdout.write(`\n${ok} 个库读对了, ${failed} 个不对（共 ${members} 个成员、${syms} 条索引）\n`);
if (failed !== 0 || ok === 0) {
  process.stdout.write('c/ar-read: 静态库读得不对 —— 与系统 ar 差了一格\n');
  process.exitCode = 1;
}


