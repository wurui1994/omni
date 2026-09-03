// tests/c/f80.js —— x87 的 80 位：位模式与尺子写出来的字节逐个相同
// （ADR-0017 第九刀第一百〇九片）
//
// `long double` 在 x86_64 上是十个字节的 x87 扩展精度，占十六个字节的格子
// （`x86_64-gen.c:102-103`）。这一组称三件事：
//
//   1. **尺子写什么我们写什么** —— 一份 `long double` 的静态初始化式，交叉编出来的
//      `x86_64-osx-tcc -c` 写在 `.data` 里的十六个字节，与 `f80Bytes` 出来的逐个相同。
//      顺带钉住一件容易想错的事：尺子自己也只有 **53 位**有效位（它跑在 arm64 上，
//      `long double` 就是 double），所以 `0.1L` 的尾数低 11 位是零。
//   2. **来回一趟不掉字** —— `f80ToDouble(f80Bytes(x)) === x`，含 ±0、非规格化数、
//      Inf、NaN 与两头的极值。80 位的指数范围比 double 宽，所以这一趟必须是恒等的。
//   3. **特例的位模式** —— 零是十六个零、Inf 的尾数是 `0x8000…`（整数位是显式的）、
//      QNaN 是 `0xC000…`。
//
//   node tests/c/f80.js

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { f80Bytes, f80Parts, f80ToDouble } from '../../src/core/frontend-c/f80.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const XTCC = join(root, '.omni-cache', 'tcc-cross', 'x86_64-osx-tcc');
const OUT = join(tmpdir(), 'omni-f80');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

const hex = (u8) => [...u8].map((x) => x.toString(16).padStart(2, '0')).join(' ');

/* ---- 1. 与尺子的字节逐个比 */

/** 那一批字面量：写法（C 源码）与它作为 double 的值。 */
const LITS = [
  ['1.5L', 1.5],
  ['2.5L', 2.5],
  ['0.1L', 0.1],
  ['-3.75L', -3.75],
  ['1.0L', 1.0],
  ['0.0L', 0.0],
  ['1e300L', 1e300],
  ['-1e-300L', -1e-300],
  ['123456789.0L', 123456789.0],
];

if (!existsSync(XTCC)) {
  process.stdout.write(`  skip 与尺子比字节：找不到 ${XTCC}\n`);
} else {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const src = join(OUT, 'f.c');
  writeFileSync(src, LITS.map(([t], i) => `long double v${i} = ${t};\n`).join(''));
  const obj = join(OUT, 'f.o');
  const r = spawnSync(XTCC, ['-c', src, '-o', obj], { encoding: 'utf8' });
  if (r.status !== 0) {
    bad('尺子 x86_64-osx-tcc -c', `    ${(r.stderr ?? '').trim().split('\n')[0]}`);
  } else {
    /* `tcc -c` 在所有目标上都写 ELF（第九十九片），所以这儿读的是 ELF64 的节表。 */
    const b = readFileSync(obj);
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
    const nameOf = (o) => b.toString('latin1', strtab.off + o, b.indexOf(0, strtab.off + o));
    let data = null;
    for (let i = 0; i < shnum; i++) {
      const s = sh(i);
      if (nameOf(s.name) === '.data') data = b.subarray(s.off, s.off + s.size);
    }
    if (data === null || data.length !== LITS.length * 16) {
      bad('尺子的 .data 是每格 16 字节',
        `    拿到 ${data === null ? '(没有 .data)' : `${data.length} 字节`}，`
        + `要 ${LITS.length * 16}`);
    } else {
      const diffs = [];
      for (let i = 0; i < LITS.length; i++) {
        const want = new Uint8Array(data.subarray(i * 16, i * 16 + 16));
        const got = f80Bytes(LITS[i][1], 16);
        if (hex(want) !== hex(got)) {
          diffs.push(`    ${LITS[i][0]}\n      tcc : ${hex(want)}\n      ours: ${hex(got)}`);
        }
      }
      if (diffs.length > 0) bad('每个字面量的 16 个字节与尺子相同', diffs.join('\n'));
      else ok(`${LITS.length} 个字面量的 16 个字节与 x86_64-osx-tcc 逐个相同`);

      /* 尺子自己只有 53 位有效位这件事，单独钉一条 —— 它决定了我们**不必**写
       * 一台十进制到 80 位的转换器（现在还不必）。 */
      const tenth = new Uint8Array(data.subarray(2 * 16, 2 * 16 + 10));
      const lowBits = (BigInt(tenth[1]) << 8n | BigInt(tenth[0])) & 0x7ffn;
      if (lowBits !== 0n) {
        bad('尺子的 0.1L 只有 53 位有效位（低 11 位是零）', `    ${hex(tenth)}`);
      } else {
        ok(`尺子的 0.1L 尾数低 11 位是零（它跑在 arm64 上，long double 就是 double）：${hex(tenth)}`);
      }
    }
  }
  rmSync(OUT, { recursive: true, force: true });
}

/* ---- 2. 来回一趟 */
{
  const vals = [
    0, -0, 1, -1, 1.5, 0.1, -3.75, 1e300, -1e-300, Math.PI,
    Number.MAX_VALUE, Number.MIN_VALUE, 5e-324, 2.2250738585072014e-308,
    1.7976931348623157e308, Infinity, -Infinity,
  ];
  const bad1 = [];
  for (const v of vals) {
    const back = f80ToDouble(f80Bytes(v, 16));
    if (!Object.is(back, v)) bad1.push(`    ${v} -> ${hex(f80Bytes(v, 10))} -> ${back}`);
  }
  const nan = f80ToDouble(f80Bytes(NaN, 16));
  if (!Number.isNaN(nan)) bad1.push(`    NaN -> ${nan}`);
  if (bad1.length > 0) bad('double -> 80 位 -> double 是恒等的', bad1.join('\n'));
  else ok(`${vals.length + 1} 个值来回一趟不掉字（含 ±0、非规格化、Inf、NaN、两头极值）`);
}

/* ---- 3. 特例的位模式 */
{
  const cases = [
    ['0.0', f80Bytes(0, 16), '00 '.repeat(16).trim()],
    ['-0.0', f80Bytes(-0, 16), `${'00 '.repeat(8)}00 80 ${'00 '.repeat(6)}`.trim()],
    ['Infinity', f80Bytes(Infinity, 16),
      `${'00 '.repeat(7)}80 ff 7f ${'00 '.repeat(6)}`.trim()],
    ['NaN', f80Bytes(NaN, 16), `${'00 '.repeat(7)}c0 ff 7f ${'00 '.repeat(6)}`.trim()],
    /* 5e-324 = 2^-1074：指数字段 16383-1074 = 15309 = 0x3bcd，尾数是那个显式整数位。 */
    ['非规格化 5e-324', f80Bytes(5e-324, 10), `${'00 '.repeat(7)}80 cd 3b`.trim()],
  ];
  const diffs = [];
  for (const [name, got, want] of cases) {
    if (hex(got) !== want) diffs.push(`    ${name}\n      want: ${want}\n      got : ${hex(got)}`);
  }
  if (diffs.length > 0) bad('零/Inf/NaN/非规格化的位模式', diffs.join('\n'));
  else ok('零是全零、Inf 尾数 0x8000…、QNaN 0xC000…、非规格化在 80 位里是规格化的');

  /* 整数位是显式的这件事，正面说一遍：1.5 的尾数最高位必须是 1。 */
  const { mant, expSign } = f80Parts(1.5);
  if (mant !== 0xC000000000000000n || expSign !== 0x3fffn) {
    bad('1.5 的尾数是 0xC000000000000000、指数 0x3fff',
      `    mant=0x${mant.toString(16)} expSign=0x${expSign.toString(16)}`);
  } else {
    ok('1.5 的尾数是 0xC000000000000000（整数位显式），指数 0x3fff');
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
