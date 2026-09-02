// tests/c/selfobj.js —— 用我们的编译器把 tinycc 编出来，再让它去编 tinycc
// （ADR-0017 第九刀第九十二片）
//
// `selfpp.js` 称的是 `-E`：预处理器的每一个字节。这一组往下再走一层：
//
//   1. `omni c-obj` 把 tinycc 的十二个 `.c`（arm64-osx 那一套，Makefile:201-240）
//      各编成一个 `.o`；
//   2. 十二个 `.o` 用 `clang` 链成 `omni-tcc` —— 这一步是**局部符号**那一片的考题：
//      串常量、`static`、`inline`、外部函数的转发桩，每个翻译单元里都有一份，
//      当外部符号发的话十二份一链就是一千四百条 `duplicate symbol`；
//   3. `omni-tcc` 跑起来，印的版本行与尺子那份一模一样；
//   4. `omni-tcc -c` 编 `tests/c/gen/` 那批，出来的目标文件与尺子 tcc 的**逐字节相同**；
//   5. `omni-tcc -c` 编 **tinycc 自己的那十二份源码**，同样逐字节相同。
//
// 第 5 步是这一路的收口：我们编出来的 tcc 与真的 tcc，对二十三万行输入写出同一串字节。
//
// 尺子（`.omni-cache/tcc-build/tcc`）、源码树、或者不是 arm64 的 macOS —— 整组跳过。
//
//   node tests/c/selfobj.js

import { readdirSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const TCC_DIR = join(root, '.omni-cache', 'tcc-build');
const TCC = join(TCC_DIR, 'tcc');
const CLI = join(root, 'stage0', 'src', 'cli.js');
const SRC = process.env.TINYCC_SRC ?? '/Users/wurui/Documents/Lang/reference/tinycc';
const OUT = join(tmpdir(), 'omni-selfobj');

/* arm64-osx 的那一套目标文件（Makefile:201-240 的 `CORE_FILES` + arm64 三件 + tccmacho）。
 * `tcc.o` 与 `libtcc.o` 要 `-DONE_SOURCE=0`：那两份都是**单独**编的翻译单元。 */
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

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  process.stdout.write(`  skip 整组：这一组是 arm64 macOS 的（现在是 ${process.platform}/${process.arch}）\n`);
  process.exit(0);
}
if (!existsSync(TCC) || !existsSync(join(SRC, 'tccpp.c'))) {
  process.stdout.write('  skip 整组：尺子不在\n');
  process.stdout.write(`       tcc: ${TCC}\n       源码: ${SRC}\n`);
  process.stdout.write('       建它：见 ADR-0017「量出来的基线」那一节的树外构建\n');
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/* 版本行里的那一段（`tcc version 0.9.28rc 2026-09-01 main@cf0e1fe* (AArch64 Darwin)`
 * 中间那块）不在源码里：Makefile:267 只给 `tcc.o` 加一个 `-DTCC_GITHASH="…"`，
 * 内容是**建那一份 tcc 时**的 git 状态。所以它不能算出来，只能从尺子自己的版本行里
 * 读回来 —— 读回来当命令行上的 `-D` 递进去，与 Makefile 做的是同一件事。 */
const refBanner = spawnSync(TCC, ['-v'], { encoding: 'utf8' }).stdout;
const m = /^tcc version \S+ (.*) \(/.exec(refBanner);
const gitDefs = m === null ? [] : [`-DTCC_GITHASH="${m[1]}"`];

// ---- 1. 十二个目标文件
for (const u of UNITS) {
  const r = spawnSync(process.execPath,
    [CLI, 'c-obj', join(SRC, `${u}.c`), '-I', TCC_DIR, '-DONE_SOURCE=0',
      ...(u === 'tcc' ? gitDefs : []),
      '-o', join(OUT, `${u}.o`)],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    bad(`c-obj ${u}.c`, `    ${(r.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
    continue;
  }
  ok(`c-obj ${u}.c -> ${u}.o`);
}
if (fail > 0) {
  process.stdout.write('\n目标文件没编齐，后面几步不必跑了\n');
  for (const f of failures) process.stdout.write(`${f}\n`);
  process.exit(1);
}

// ---- 2. 链接。局部符号那一片的考题就在这儿：一条 `duplicate symbol` 都不该有
const exe = join(OUT, 'omni-tcc');
const ln = spawnSync('clang', ['-o', exe, ...UNITS.map((u) => join(OUT, `${u}.o`))],
  { encoding: 'utf8', maxBuffer: 1 << 26 });
if (ln.status !== 0) {
  const msg = (ln.stderr ?? '').trim().split('\n');
  bad('clang -o omni-tcc *.o',
    `    ${msg.length} 行，前三条：\n    ${msg.slice(0, 3).join('\n    ')}`);
  process.stdout.write('\n链不上，后面几步不必跑了\n');
  for (const f of failures) process.stdout.write(`${f}\n`);
  process.exit(1);
}
ok(`clang -o omni-tcc *.o（${UNITS.length} 个目标文件，一条 duplicate symbol 都没有）`);

// ---- 3. 跑起来：版本行与尺子一样
const mineV = spawnSync(exe, ['-v'], { encoding: 'utf8' });
if (mineV.status !== 0) {
  bad('omni-tcc -v', `    退出码 ${mineV.status}\n    ${(mineV.stderr ?? '').trim()}`);
} else if (mineV.stdout !== refBanner) {
  bad('omni-tcc -v', `    tcc : ${refBanner.trim()}\n    ours: ${mineV.stdout.trim()}`);
} else ok(`omni-tcc -v == tcc -v（${refBanner.trim()}）`);

/** 两个 tcc 编同一份 `.c`，目标文件必须逐字节相同。 */
function objParity(label, args, files) {
  let same = 0;
  const diffs = [];
  for (const f of files) {
    const mo = join(OUT, 'mine.o');
    const ro = join(OUT, 'ref.o');
    const a = spawnSync(exe, ['-B', TCC_DIR, ...args, '-c', f, '-o', mo],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    const b = spawnSync(TCC, ['-B', TCC_DIR, ...args, '-c', f, '-o', ro],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (b.status !== 0) continue;            // 尺子自己就拒了：没有可比的
    if (a.status !== 0) {
      diffs.push(`    ${f}：我们拒了 —— ${(a.stderr ?? '').trim().split('\n')[0]}`);
      continue;
    }
    if (Buffer.compare(readFileSync(mo), readFileSync(ro)) === 0) same++;
    else diffs.push(`    ${f}：字节不同`);
  }
  if (diffs.length > 0) bad(label, diffs.slice(0, 6).join('\n'));
  else ok(`${label}（${same} 份，逐字节相同）`);
}

// ---- 4. 我们编出来的 tcc 去编测试用例：与尺子写出同一串字节
const genDir = join(here, 'gen');
objParity('omni-tcc -c tests/c/gen/*.c == tcc -c', [],
  readdirSync(genDir).filter((f) => f.endsWith('.c')).sort().map((f) => join(genDir, f)));

// ---- 5. 收口：我们编出来的 tcc 去编 tinycc 自己
objParity('omni-tcc -c tinycc/*.c == tcc -c', ['-I', TCC_DIR, '-DONE_SOURCE=0'],
  UNITS.map((u) => join(SRC, `${u}.c`)));

rmSync(OUT, { recursive: true, force: true });

if (failures.length > 0) {
  process.stdout.write('\n');
  for (const f of failures) process.stdout.write(`${f}\n`);
}
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
