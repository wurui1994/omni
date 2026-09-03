// tests/c/rdata-name.js —— 只读数据那一节的名字跟着目标走
// （ADR-0017 第九刀第一百一十六片）
//
// tcc 里这是一个 `#ifdef`（`tccelf.c:50-56`）：
//
//     #ifdef TCC_TARGET_PE
//     static const char rdata[] = ".rdata";
//     #else
//     static const char rdata[] = ".data.ro";
//     #endif
//
// 于是同一份源码编给 win32 与编给 linux/osx，3 号节的名字不同。这是**目标的事实**，
// 与符号名前面那条下划线并列 —— 六个目标共用一个 ELF 写出器，差别就那么几处。
//
// 尺子是交叉编译器自己写出来的 `.o`：**问它 3 号节叫什么**，而不是把名字写死在门里。
//
//   node tests/c/rdata-name.js

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const CROSS = join(root, '.omni-cache', 'tcc-cross');
const OUT = join(tmpdir(), 'omni-rdata-name');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

/** tinycc 的源码在哪儿：交叉目录的 `config.mak` 里记着（`-B` 要用它）。 */
function tccSrc() {
  const mak = join(CROSS, 'config.mak');
  if (!existsSync(mak)) return null;
  const m = /^TOPSRC=(.*)$/m.exec(readFileSync(mak, 'utf8'));
  return m === null ? null : m[1].trim();
}

const SRC = tccSrc();
if (SRC === null) {
  process.stdout.write(`  skip 整组：交叉编译器还没建（${CROSS}）\n`);
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/** 一个 ELF 目标文件里 3 号节的名字。 */
function sectionName(path, no) {
  const b = readFileSync(path);
  const shoff = Number(b.readBigUInt64LE(0x28));
  const shstrndx = b.readUInt16LE(0x3e);
  const at = (i) => shoff + i * 64;
  const strOff = Number(b.readBigUInt64LE(at(shstrndx) + 24));
  const n = b.readUInt32LE(at(no));
  let e = strOff + n;
  while (b[e] !== 0) e++;
  return b.toString('latin1', strOff + n, e);
}

const PROBE = 'static const char s[] = "hi";\nint main(void) { return s[0]; }\n';
const c = join(OUT, 'a.c');
writeFileSync(c, PROBE);

/* 三个目标各一遍：win32 该是 `.rdata`，另两个该是 `.data.ro`。
 * 期望值不写死 —— 拿交叉编译器写出来的那一份问。 */
const CASES = [
  { name: 'x86_64-win32', tcc: 'x86_64-win32-tcc', arch: 'x86_64', os: 'win32', win32: true },
  { name: 'x86_64-linux', tcc: 'x86_64-tcc', arch: 'x86_64', os: 'linux', win32: false },
  { name: 'arm64-osx', tcc: 'arm64-osx-tcc', arch: 'arm64', os: 'osx', win32: false },
];

for (const t of CASES) {
  const tcc = join(CROSS, t.tcc);
  if (!existsSync(tcc)) {
    process.stdout.write(`  skip ${t.name}（${t.tcc} 没建）\n`);
    continue;
  }
  const B = t.win32 ? `-B${join(SRC, 'win32')}` : `-B${SRC}`;
  const ro = join(OUT, `ref-${t.name}.o`);
  const r = spawnSync(tcc, [B, '-c', c, '-o', ro], { encoding: 'utf8' });
  if (r.status !== 0) {
    bad(t.name, `    尺子自己就拒了：${(r.stderr ?? '').trim().split('\n')[0]}`);
    continue;
  }
  const mo = join(OUT, `our-${t.name}.o`);
  const a = spawnSync(process.execPath,
    [CLI, 'c-obj', c, '--arch', t.arch, '--os', t.os, '--format', 'elf', '-o', mo],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (a.status !== 0) {
    bad(t.name, `    我们编不动：${(a.stderr ?? '').trim().split('\n')[0]}`);
    continue;
  }
  const want = sectionName(ro, 3);
  const got = sectionName(mo, 3);
  if (want !== got) bad(`${t.name} 的 3 号节`, `    tcc : ${want}\n    ours: ${got}`);
  else ok(`${t.name} 的 3 号节叫 ${got}（与尺子一样）`);
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
