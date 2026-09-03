// tests/c/ldouble-x64.js —— x86_64 上 `long double` 是 16 字节的 x87 80 位
// （ADR-0017 第九刀第一百一十一、一百一十二片）
//
// 这一组称**已经做到**的四件事，一件不多：
//
//   1. **宽度与布局** —— `sizeof(long double)` 是 16、`struct { char c; long double d; }` 是 32、
//      `long double[3]` 是 48。
//   2. **算得对** —— 局部量存进帧上那十六个字节、读回来、算术、转成 int：这一路全程
//      f80 的读写（`fld/fstp tbyte`）。
//   4. **返回值在 `st0` 里**（第一百一十二片）—— 直接调用、按指针调用、外部符号三条路。
//
//   这三条的尺子是 `clang -arch x86_64`（Rosetta 上跑）。为什么不是 tcc：交叉编出来的那份
//   `x86_64-osx-tcc` **链不动** —— 它没有 x86_64 那一档的 libc 路径与 `libtcc1.a`
//   （`configure` 只给本机那份烤了 SDK 的路径），`-o 可执行文件` 直接报
//   `library 'c' not found`。字节这一层的尺子仍是 tcc（下面第 3 条与 `selfobj`）。
//
//   3. **静态初始化式的字节** —— `.data` 里那十六个字节与 `f80Bytes`（第一百〇九片，
//      拿 `x86_64-osx-tcc -c` 写出来的字节称过的那一份）逐个相同。
//
// **还没做到**（下一片）：SysV 的 long double **传参**（MEMORY 类，栈上 16 字节的格子）。
// 所以 `printf("%Lf", x)` 在 x86_64 上仍然印不对，`long double f(long double)` 也还收不对。
//
//   node tests/c/ldouble-x64.js

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { f80Bytes } from '../../stage0/src/frontend-c/f80.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'stage0', 'src', 'cli.js');
const XTCC = join(root, '.omni-cache', 'tcc-cross', 'x86_64-osx-tcc');
const OUT = join(tmpdir(), 'omni-ldouble-x64');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

if (!existsSync(XTCC)) {
  process.stdout.write(`  skip 整组：尺子不在（${XTCC}）\n`);
  process.exit(0);
}
const sdk = spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' });
const SDK_INC = sdk.status === 0 ? join(sdk.stdout.trim(), 'usr', 'include') : '';
if (SDK_INC === '') {
  process.stdout.write('  skip 整组：找不到 SDK 的头文件\n');
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/** 编一份、链一份、跑一遍，回退出码。`by` 是 'ours' 或 'clang'。 */
function runProbe(name, src, by) {
  const c = join(OUT, `${name}-${by}.c`);
  writeFileSync(c, src);
  const exe = join(OUT, `${name}-${by}`);
  if (by === 'clang') {
    const r = spawnSync('clang', ['-arch', 'x86_64', '-w', c, '-o', exe], { encoding: 'utf8' });
    if (r.status !== 0) return { err: (r.stderr ?? '').trim().split('\n')[0] };
  } else {
    const o = `${exe}.o`;
    const r = spawnSync(process.execPath, [CLI, 'c-obj', c, '--arch', 'x86_64', '-o', o],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (r.status !== 0) return { err: (r.stderr ?? '').trim().split('\n')[0] };
    const l = spawnSync('clang', ['-arch', 'x86_64', '-o', exe, o], { encoding: 'utf8' });
    if (l.status !== 0) return { err: (l.stderr ?? '').trim().split('\n')[0] };
  }
  const run = spawnSync(exe, [], { encoding: 'utf8' });
  return { code: run.status };
}

/** 同一份源码两边各跑一遍，退出码必须一样（也必须等于期望值）。 */
function sameExit(what, name, src, want) {
  const a = runProbe(name, src, 'clang');
  const b = runProbe(name, src, 'ours');
  if (a.err !== undefined) { bad(what, `    尺子编不动：${a.err}`); return; }
  if (b.err !== undefined) { bad(what, `    我们编不动：${b.err}`); return; }
  if (a.code !== want || b.code !== want) {
    bad(what, `    期望 ${want}，尺子 ${a.code}，我们 ${b.code}`);
    return;
  }
  ok(`${what}（两边都退 ${want}）`);
}

/* 1. 宽度与布局：16 + 32 + 48 = 96。 */
sameExit('sizeof 与结构布局：16 / 32 / 48', 'size',
  'struct box { char c; long double d; };\n'
  + 'static long double z[3];\n'
  + 'int main(void) {\n'
  + '  return (int)sizeof(long double) + (int)sizeof(struct box) + (int)sizeof(z);\n'
  + '}\n', 96);

/* 2. 算得对：静态初始化式读回来、局部量存进帧再读出来、算术、转 int。
 *    `2.5L * 2 + 0.75L` = 5.75 -> (int) 5；`gs`（静态的 1.5L）再加进去 -> 6。 */
sameExit('帧上的十六个字节：存、读、算、转 int', 'calc',
  'static long double gs = 1.5L;\n'
  + 'int main(void) {\n'
  + '  long double a = 2.5L;\n'
  + '  long double b = a * 2 + 0.75L;\n'
  + '  long double c = b + gs;\n'
  + '  return (int)c;\n'
  + '}\n', 7);

/* 3. 静态初始化式的字节：我们写出来的 `.data` 与 `f80Bytes` 逐个相同。
 *    （`--format elf` 那一路 —— tcc 的 `-c` 在所有目标上都写 ELF。） */
{
  const vals = [['1.5L', 1.5], ['2.5L', 2.5], ['-3.75L', -3.75], ['0.1L', 0.1]];
  const c = join(OUT, 'data.c');
  writeFileSync(c, vals.map(([t], i) => `long double v${i} = ${t};\n`).join(''));
  const o = join(OUT, 'data.o');
  const r = spawnSync(process.execPath,
    [CLI, 'c-obj', c, '--arch', 'x86_64', '--format', 'elf', '-o', o],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    bad('静态初始化式的十六个字节', `    我们编不动：${(r.stderr ?? '').trim().split('\n')[0]}`);
  } else {
    const b = readFileSync(o);
    const shoff = Number(b.readBigUInt64LE(0x28));
    const shentsize = b.readUInt16LE(0x3a);
    const shnum = b.readUInt16LE(0x3c);
    const shstrndx = b.readUInt16LE(0x3e);
    const sh = (i) => ({
      name: b.readUInt32LE(shoff + i * shentsize),
      off: Number(b.readBigUInt64LE(shoff + i * shentsize + 0x18)),
      size: Number(b.readBigUInt64LE(shoff + i * shentsize + 0x20)),
    });
    const strtab = sh(shstrndx);
    const nameOf = (x) => b.toString('latin1', strtab.off + x, b.indexOf(0, strtab.off + x));
    let data = null;
    for (let i = 0; i < shnum; i++) {
      const s = sh(i);
      if (nameOf(s.name) === '.data') data = b.subarray(s.off, s.off + s.size);
    }
    const hex = (u8) => [...u8].map((v) => v.toString(16).padStart(2, '0')).join(' ');
    const want = [];
    for (const [, v] of vals) want.push(...f80Bytes(v, 16));
    if (data === null || hex(data.subarray(0, want.length)) !== hex(new Uint8Array(want))) {
      bad('静态初始化式的十六个字节与 f80Bytes 相同',
        `    want: ${hex(new Uint8Array(want))}\n`
        + `    got : ${data === null ? '(没有 .data)' : hex(data)}`);
    } else {
      ok(`${vals.length} 个静态 long double 的 .data 字节与 f80Bytes 逐个相同`);
    }
  }
}

/* 4. 返回值在 `st0` 里（第一百一十二片）：三条路各走一遍 —— 直接调我们自己定义的
 *    （`CALL` 问被调那个函数的标注）、按指针调（`CALLI` 的 `CALL_LDRET`）、
 *    调外部符号（`strtold` 走桩，桩两头都在 x87 上）。
 *    少了这一片的话三条都错在同一处：值在 st0 而我们从 xmm0 读，取回来是上一次留下的垃圾。 */
sameExit('返回值在 st0：直接调用', 'ret-direct',
  'long double one(void) { return 1.5L; }\n'
  + 'int main(void) { long double a = one() + 2.5L; return (int)a; }\n', 4);

sameExit('返回值在 st0：按指针调用', 'ret-ptr',
  'long double one(void) { return 1.5L; }\n'
  + 'int main(void) {\n'
  + '  long double (*p)(void) = one;\n'
  + '  return (int)(p() + 2.5L) * 2;\n'
  + '}\n', 8);

sameExit('返回值在 st0：外部符号（strtold 走桩）', 'ret-extern',
  '#include <stdlib.h>\n'
  + 'int main(void) { long double a = strtold("2.5", 0); return (int)(a * 2); }\n', 5);

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
