// tests/c/char-sign.js —— 光秃秃的 `char` 是有符号还是无符号
// （ADR-0017 第九刀第一百三十六片）
//
// **只有 arm64-linux 一个目标**上 `char` 是无符号的（`arm64-gen.c:41` 的
// `CHAR_IS_UNSIGNED` -> `libtcc.c:889` 的 `char_is_unsigned`）。第一百二十九片把
// `__CHAR_UNSIGNED__` 那个宏摆对了，这一格是它的**语言**那一半。
//
// 门的办法：探针把答案算成几个 `int` 全局量摆进 `.data`，两边各编一个 `.o`、把那一节的
// 字节读回来比。期望值**从尺子读**——不写死「arm64-linux 上该是 200」这种数。
//
// 探针里那两条 `signed char` / `unsigned char` 是**对照**：显式写过符号的不受这一格
// 影响（`VT_DEFSIGN` 那一位），三个目标上都该是同一个数。
//
//   node tests/c/char-sign.js

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const CROSS = join(root, '.omni-cache', 'tcc-cross');
const OUT = join(tmpdir(), 'omni-char-sign');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

const mak = join(CROSS, 'config.mak');
if (!existsSync(mak)) {
  process.stdout.write(`  skip 整组：交叉编译器还没建（${CROSS}）\n`);
  process.exit(0);
}
const m = /^TOPSRC=(.*)$/m.exec(readFileSync(mak, 'utf8'));
const SRC = m === null ? null : m[1].trim();
if (SRC === null) {
  process.stdout.write('  skip 整组：config.mak 里没有 TOPSRC\n');
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/* 探针里每一格都是一个 `int`，按声明的次序摆在 `.data` 里。 */
const NAMES = ['cast200', 'negIsNeg', 'sum', 'schar', 'uchar'];
const PROBE = `int cast200 = (int)(char)200;
int negIsNeg = ((char)-1) < 0;
int sum = (int)(char)127 + (int)(char)128;
int schar = (int)(signed char)200;
int uchar = (int)(unsigned char)200;
`;

const c = join(OUT, 'a.c');
writeFileSync(c, PROBE);

/** `.data` 那一节前 N 个 `int`。 */
function readInts(path, n) {
  const b = readFileSync(path);
  const shoff = Number(b.readBigUInt64LE(0x28));
  const shnum = b.readUInt16LE(0x3c);
  const shstrndx = b.readUInt16LE(0x3e);
  const at = (i) => shoff + i * 64;
  const strOff = Number(b.readBigUInt64LE(at(shstrndx) + 24));
  for (let i = 0; i < shnum; i++) {
    const o = at(i);
    const nm = b.readUInt32LE(o);
    let e = strOff + nm;
    while (b[e] !== 0) e++;
    if (b.toString('latin1', strOff + nm, e) !== '.data') continue;
    const off = Number(b.readBigUInt64LE(o + 24));
    const out = [];
    for (let k = 0; k < n; k++) out.push(b.readInt32LE(off + k * 4));
    return out;
  }
  return null;
}

const CASES = [
  { name: 'arm64-linux', tcc: 'arm64-tcc', arch: 'arm64', os: 'linux', win32: false },
  { name: 'arm64-osx', tcc: 'arm64-osx-tcc', arch: 'arm64', os: 'osx', win32: false },
  { name: 'arm64-win32', tcc: 'arm64-win32-tcc', arch: 'arm64', os: 'win32', win32: true },
  { name: 'x86_64-linux', tcc: 'x86_64-tcc', arch: 'x86_64', os: 'linux', win32: false },
  { name: 'x86_64-osx', tcc: 'x86_64-osx-tcc', arch: 'x86_64', os: 'osx', win32: false },
  { name: 'x86_64-win32', tcc: 'x86_64-win32-tcc', arch: 'x86_64', os: 'win32', win32: true },
];

/* 「至少有一个目标是无符号的」——不然这门比的是空气（尺子那边整组都一样就该起疑）。 */
let sawUnsigned = false;

for (const t of CASES) {
  const tcc = join(CROSS, t.tcc);
  if (!existsSync(tcc)) {
    process.stdout.write(`  skip ${t.name}（${t.tcc} 没建）\n`);
    continue;
  }
  const B = t.win32 ? `-B${join(SRC, 'win32')}` : `-B${SRC}`;
  const ro = join(OUT, 'ref.o');
  /* 两边**同一串 argv**（ADR-0018 决策三）：只差一个 `-b`。 */
  const ARGS = [B, '-c', c];
  const r = spawnSync(tcc, [...ARGS, '-o', ro], { encoding: 'utf8' });
  if (r.status !== 0) {
    bad(t.name, `    尺子自己就拒了：${(r.stderr ?? '').trim().split('\n')[0]}`);
    continue;
  }
  const mo = join(OUT, 'our.o');
  const a = spawnSync(process.execPath,
    [CLI, 'c', 'tcc', '-b', `${t.arch}-${t.os}`, ...ARGS, '-o', mo],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (a.status !== 0) {
    bad(t.name, `    我们编不动：${(a.stderr ?? '').trim().split('\n')[0]}`);
    continue;
  }
  const want = readInts(ro, NAMES.length);
  const got = readInts(mo, NAMES.length);
  if (want === null || got === null) {
    bad(t.name, '    有一边没有 .data 这一节');
    continue;
  }
  if (want[1] === 0) sawUnsigned = true;
  const diffs = [];
  for (let k = 0; k < NAMES.length; k++) {
    if (want[k] !== got[k]) diffs.push(`${NAMES[k]}: tcc ${want[k]} / ours ${got[k]}`);
  }
  if (diffs.length > 0) bad(t.name, `    ${diffs.join('\n    ')}`);
  else ok(`${t.name}：char ${want[1] === 0 ? '无' : '有'}符号，${NAMES.length} 个数与尺子全同`);
}

if (!sawUnsigned) {
  bad('这门有没有称到东西', '    六个目标里一个「char 是无符号的」都没量到 —— 尺子或探针有问题');
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
