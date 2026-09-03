// tests/c/selfboot.js —— 自举的定点：我们编的 tcc 再编一次 tinycc，
// 与 tcc 自己编自己链的那一份**逐字节相同**（ADR-0017 第九刀第一百〇一片）
//
// 前面几片各自称了一段：
//
//   - 第九十二片：我们编出来的 tcc `-c` 出来的 `.o` 与真 tcc 的逐字节相同
//   - 第五十七片（`macho-tcc.js`）：我们的链接器把 **tcc 编的** `.o` 链出来，
//     与 tcc 自己链的逐字节相同
//
// 这一组把两段接起来，从源码一直走到**可执行文件**：
//
//   第一级：`omni c-obj` + `omni macho-link` -> omni-tcc（代码生成与链接全是我们的）
//   第二级：omni-tcc `-c` tinycc 的十二份源码 -> `.o`，`omni macho-link` 链成 tcc2
//   尺  子：`tcc -c` 同样十二份 -> `.o`，`tcc` 自己链成 tccref
//
// 要的是 **tcc2 与 tccref 逐字节相同** —— 换句话说，把编译器与链接器整条换成我们的，
// 出来的那个 tcc 是同一个文件。之后 tcc2 签个名跑一遍，让它去编一个 hello。
//
//   node tests/c/selfboot.js

import {
  existsSync, mkdirSync, readFileSync, rmSync, chmodSync, writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const TCC_DIR = join(root, '.omni-cache', 'tcc-build');
const TCC = join(TCC_DIR, 'tcc');
const CLI = join(root, 'src', 'core', 'cli.js');
const SRC = process.env.TINYCC_SRC ?? '/Users/wurui/Documents/Lang/reference/tinycc';
const OUT = join(tmpdir(), 'omni-selfboot');

/* arm64-osx 那一套（与 `selfobj.js` 同一份名单）。 */
const UNITS = ['tcc', 'libtcc', 'tccpp', 'tccgen', 'tccdbg', 'tccelf', 'tccasm', 'tccrun',
  'arm64-gen', 'arm64-link', 'arm64-asm', 'tccmacho'];

let pass = 0;
let fail = 0;
const failures = [];
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => {
  fail++;
  failures.push(`${name}\n${detail}`);
  process.stdout.write(`  FAIL ${name}\n`);
};
const die = () => {
  if (failures.length > 0) {
    process.stdout.write('\n');
    for (const f of failures) process.stdout.write(`${f}\n`);
  }
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
};

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  process.stdout.write(`  skip 整组：这一组是 arm64 macOS 的（现在是 ${process.platform}/${process.arch}）\n`);
  process.exit(0);
}
if (!existsSync(TCC) || !existsSync(join(SRC, 'tccpp.c'))) {
  process.stdout.write('  skip 整组：尺子不在\n');
  process.stdout.write(`       tcc: ${TCC}\n       源码: ${SRC}\n`);
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
for (const d of ['s1', 's2', 'ref']) mkdirSync(join(OUT, d), { recursive: true });

/* 版本行里那段 git 戳是建尺子时的 `-DTCC_GITHASH`（Makefile:267，只给 `tcc.o`）。 */
const refBanner = spawnSync(TCC, ['-v'], { encoding: 'utf8' }).stdout;
const gm = /^tcc version \S+ (.*) \(/.exec(refBanner);
const gitDefs = gm === null ? [] : [`-DTCC_GITHASH="${gm[1]}"`];
const ARGS = ['-B', TCC_DIR, '-I', TCC_DIR, '-DONE_SOURCE=0'];

// ---- 第一级：我们的编译器 + 我们的链接器 -> omni-tcc
const s1 = join(OUT, 's1');
for (const u of UNITS) {
  const r = spawnSync(process.execPath,
    [CLI, 'c-obj', join(SRC, `${u}.c`), '-I', TCC_DIR, '-DONE_SOURCE=0',
      ...(u === 'tcc' ? gitDefs : []), '--format', 'elf', '-o', join(s1, `${u}.o`)],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    bad(`第一级 c-obj ${u}.c`,
      `    ${(r.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
    die();
  }
}
const stage1 = join(OUT, 'omni-tcc');
const ln1 = spawnSync(process.execPath,
  [CLI, 'macho-link', ...UNITS.map((u) => join(s1, `${u}.o`)), '-o', stage1, '-lc'],
  { encoding: 'utf8', maxBuffer: 1 << 26 });
if (ln1.status !== 0) {
  bad('第一级 macho-link', `    ${(ln1.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
  die();
}
chmodSync(stage1, 0o755);
const v1 = spawnSync(stage1, ['-v'], { encoding: 'utf8' });
if (v1.stdout !== refBanner) {
  bad('第一级 omni-tcc -v', `    tcc : ${refBanner.trim()}\n    ours: ${(v1.stdout ?? '').trim()}`);
  die();
}
ok(`第一级：omni c-obj + omni macho-link -> omni-tcc（${refBanner.trim()}）`);

// ---- 第二级与尺子：同样十二份源码，一边我们编、一边尺子编
const s2 = join(OUT, 's2');
const rd = join(OUT, 'ref');
let objsSame = 0;
const objDiffs = [];
for (const u of UNITS) {
  const extra = u === 'tcc' ? gitDefs : [];
  const a = spawnSync(stage1, [...ARGS, ...extra, '-c', join(SRC, `${u}.c`), '-o', join(s2, `${u}.o`)],
    { encoding: 'utf8' });
  const b = spawnSync(TCC, [...ARGS, ...extra, '-c', join(SRC, `${u}.c`), '-o', join(rd, `${u}.o`)],
    { encoding: 'utf8' });
  if (a.status !== 0 || b.status !== 0) {
    objDiffs.push(`    ${u}.c：${a.status !== 0 ? '我们' : '尺子'}拒了`);
    continue;
  }
  if (Buffer.compare(readFileSync(join(s2, `${u}.o`)), readFileSync(join(rd, `${u}.o`))) === 0) {
    objsSame++;
  } else objDiffs.push(`    ${u}.c：.o 字节不同`);
}
if (objDiffs.length > 0) {
  bad('第二级 omni-tcc -c == tcc -c', objDiffs.join('\n'));
  die();
}
ok(`第二级：omni-tcc -c tinycc/*.c == tcc -c（${objsSame} 份，逐字节相同）`);

// ---- 链：我们的链接器 vs tcc 自己
/* 两份输出**同名不同目录**：`codesign` 把文件的基名当签名里的 identifier
 * （`-i` 没给的时候），叫 `tcc2` 与 `tccref` 的话签名段里就差那几个字节 ——
 * 量过：第一处不同正落在签名开头往后十几个字节上。 */
const mineDir = join(OUT, 'mine');
const theirsDir = join(OUT, 'theirs');
for (const d of [mineDir, theirsDir]) mkdirSync(d, { recursive: true });
const tcc2 = join(mineDir, 'tcc');
const tccref = join(theirsDir, 'tcc');
const ln2 = spawnSync(process.execPath,
  [CLI, 'macho-link', ...UNITS.map((u) => join(s2, `${u}.o`)), '-o', tcc2,
    '-lc', '-L', TCC_DIR, '-l:libtcc1.a'],
  { encoding: 'utf8', maxBuffer: 1 << 26 });
if (ln2.status !== 0) {
  bad('第二级 macho-link', `    ${(ln2.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
  die();
}
const lnr = spawnSync(TCC, [...ARGS, ...UNITS.map((u) => join(rd, `${u}.o`)), '-o', tccref],
  { encoding: 'utf8' });
if (lnr.status !== 0) {
  bad('尺子自己链', `    ${(lnr.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
  die();
}
/* 比之前先签名：本机 arm64 上 tcc 自己链完就 `system("codesign -f -s - …")`
 * （`CONFIG_CODESIGN` 只在本机那个目标上开），所以尺子那份是**签过**的。
 * 我们写出来的没签 —— 不签就比，差的是那两万字节的签名，不是内容。 */
chmodSync(tcc2, 0o755);
const sg = spawnSync('codesign', ['-f', '-s', '-', tcc2], { encoding: 'utf8' });
if (sg.status !== 0) {
  bad('codesign tcc2', `    ${(sg.stderr ?? '').trim().split('\n').slice(0, 2).join('\n    ')}`);
  die();
}
const A = readFileSync(tcc2);
const B = readFileSync(tccref);
if (Buffer.compare(A, B) !== 0) {
  let at = -1;
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    if (A[i] !== B[i]) { at = i; break; }
  }
  bad('自举定点：tcc2 == tccref',
    `    我们 ${A.length} 字节、尺子 ${B.length} 字节，`
    + `第一处不同在 0x${(at < 0 ? Math.min(A.length, B.length) : at).toString(16)}`);
} else {
  ok(`自举定点：tcc2 == tccref（${A.length} 字节逐字节相同 ——`
    + ' 编译器与链接器整条换成我们的，出来的是同一个文件）');
}

// ---- tcc2 真的跑一遍
const hello = join(OUT, 'hello.c');
writeFileSync(hello, '#include <stdio.h>\nint main(void){ printf("hi from tcc2\\n"); return 0; }\n');
const run = spawnSync(tcc2, ['-B', TCC_DIR, '-run', hello], { encoding: 'utf8' });
if (run.status !== 0 || run.stdout.trim() !== 'hi from tcc2') {
  bad('tcc2 -run hello.c',
    `    退出码 ${run.status}，stdout ${JSON.stringify(run.stdout)}\n`
    + `    ${(run.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
} else {
  ok('tcc2 -run hello.c（第二级那份自己跑起来了：hi from tcc2）');
}

rmSync(OUT, { recursive: true, force: true });
die();