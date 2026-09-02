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
// 6~8 步（第九十三片）把 `clang` 也换掉：`--format elf` 出 tcc 那种 `ET_REL`，
// 我们自己的 `macho-link` 读回来链成 `MH_EXECUTE`，那一份同样跑得起来、同样逐字节相同。
// 于是整条链上除了 SDK 的头与 `libc.tbd`，没有别人的东西。
//
// 9~11 步（第九十四片）换架构：同一份源码编成 **x86_64** 的 tcc，在 Rosetta 上跑，
// 尺子是交叉编出来的 `x86_64-osx-tcc`。83 份里 80 份逐字节相同，差的那两份是
// `long double`（我们在 x86_64 上还是 8 字节）—— 明着列出来，多一份少一份都算失败。
//
// 尺子（`.omni-cache/tcc-build/tcc`）、源码树、或者不是 arm64 的 macOS —— 整组跳过。
//
//   node tests/c/selfobj.js

import { readdirSync, existsSync, mkdirSync, readFileSync, rmSync, chmodSync } from 'node:fs';
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

/** 尺子编出来的那一份，按「文件 + 参数」记着 —— 两条腿比的是同一份，不必编两遍。 */
const refCache = new Map();
function refObj(f, args) {
  const key = `${args.join(' ')}|${f}`;
  const hit = refCache.get(key);
  if (hit !== undefined) return hit;
  const ro = join(OUT, 'ref.o');
  const b = spawnSync(TCC, ['-B', TCC_DIR, ...args, '-c', f, '-o', ro],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  const v = b.status === 0 ? readFileSync(ro) : null;   // null = 尺子自己就拒了
  refCache.set(key, v);
  return v;
}

/** 两个 tcc 编同一份 `.c`，目标文件必须逐字节相同。 */
function objParity(tcc, label, args, files) {
  let same = 0;
  const diffs = [];
  for (const f of files) {
    const want = refObj(f, args);
    if (want === null) continue;             // 没有尺子，不比
    const mo = join(OUT, 'mine.o');
    const a = spawnSync(tcc, ['-B', TCC_DIR, ...args, '-c', f, '-o', mo],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (a.status !== 0) {
      diffs.push(`    ${f}：我们拒了 —— ${(a.stderr ?? '').trim().split('\n')[0]}`);
      continue;
    }
    if (Buffer.compare(readFileSync(mo), want) === 0) same++;
    else diffs.push(`    ${f}：字节不同`);
  }
  if (diffs.length > 0) bad(label, diffs.slice(0, 6).join('\n'));
  else ok(`${label}（${same} 份，逐字节相同）`);
}

const genFiles = readdirSync(join(here, 'gen')).filter((f) => f.endsWith('.c')).sort()
  .map((f) => join(here, 'gen', f));
const tinyFiles = UNITS.map((u) => join(SRC, `${u}.c`));
const TINY_ARGS = ['-I', TCC_DIR, '-DONE_SOURCE=0'];

// ---- 4. 我们编出来的 tcc 去编测试用例：与尺子写出同一串字节
objParity(exe, 'omni-tcc -c tests/c/gen/*.c == tcc -c', [], genFiles);

// ---- 5. 收口：我们编出来的 tcc 去编 tinycc 自己
objParity(exe, 'omni-tcc -c tinycc/*.c == tcc -c', TINY_ARGS, tinyFiles);

/* ---- 6~8. 再把 clang 也换掉（第九十三片）
 *
 * 上面那一份是 `clang` 链的。这一段改成**我们自己的链接器**：`c-obj --format elf`
 * 出 tcc 那种 `ET_REL`（tcc 的 `-c` 在所有目标上都写 ELF），`macho-link` 读回来、
 * 定位、写出一个真的 `MH_EXECUTE`。除了 SDK 里那份 `libc.tbd`（从里头只读符号名，
 * 用来回答「这个未定义的名字是不是来自某个 dylib」），整条链上没有别人的东西。 */
const SDK = spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).stdout.trim();
const TBD = join(SDK, 'usr', 'lib', 'libc.tbd');
if (SDK === '' || !existsSync(TBD)) {
  process.stdout.write(`  skip 自己链那一段：找不到 ${TBD}\n`);
} else {
  const elfDir = join(OUT, 'elf');
  mkdirSync(elfDir, { recursive: true });
  let elfOk = true;
  for (const u of UNITS) {
    const r = spawnSync(process.execPath,
      [CLI, 'c-obj', join(SRC, `${u}.c`), '-I', TCC_DIR, '-DONE_SOURCE=0',
        ...(u === 'tcc' ? gitDefs : []),
        '--format', 'elf', '-o', join(elfDir, `${u}.o`)],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (r.status !== 0) {
      bad(`c-obj --format elf ${u}.c`,
        `    ${(r.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
      elfOk = false;
    }
  }
  if (elfOk) ok(`c-obj --format elf ×${UNITS.length}（tcc 那种 ET_REL）`);

  const own = join(OUT, 'omni-tcc-own');
  const lk = elfOk
    ? spawnSync(process.execPath,
      [CLI, 'macho-link', ...UNITS.map((u) => join(elfDir, `${u}.o`)),
        '-o', own, '--dylib', TBD],
      { encoding: 'utf8', maxBuffer: 1 << 26 })
    : null;
  if (lk === null) { /* 上一步就没成，链接这一步不必报第二遍 */ } else if (lk.status !== 0) {
    bad('macho-link *.o -o omni-tcc-own',
      `    ${(lk.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
  } else {
    ok(`macho-link *.o -o omni-tcc-own（${(lk.stdout ?? '').trim()}）`);
    chmodSync(own, 0o755);
    const v = spawnSync(own, ['-v'], { encoding: 'utf8' });
    if (v.stdout !== refBanner) {
      bad('omni-tcc-own -v', `    tcc : ${refBanner.trim()}\n    ours: ${(v.stdout ?? '').trim()}`
        + `\n    退出码 ${v.status}${v.signal === null ? '' : `，信号 ${v.signal}`}`);
    } else {
      ok('omni-tcc-own -v == tcc -v（自己编的、自己链的，跑起来了）');
      objParity(own, 'omni-tcc-own -c tests/c/gen/*.c == tcc -c', [], genFiles);
      objParity(own, 'omni-tcc-own -c tinycc/*.c == tcc -c', TINY_ARGS, tinyFiles);
    }
  }
}

rmSync(OUT, { recursive: true, force: true });

/* ---- 9~11. 换一副架构（第九十四片）
 *
 * 同一份源码编成 **x86_64** 的 tcc，在 Rosetta 上跑。尺子换成交叉编出来的那一份
 * （`.omni-cache/tcc-cross/x86_64-osx-tcc`）—— 它自己的 git 戳与本机那份不同，
 * 所以 `-DTCC_GITHASH` 要从**它**的版本行里读。
 *
 * 交叉编出来的 tcc **没有**系统头那一格（`configure` 只给本机那份烤了 SDK 的路径），
 * 所以两边都要手工给 `-I <SDK>/usr/include` —— 尺子自己也是这样才编得动 `<stdio.h>`。
 *
 * `long double` 那两份是**已知不同**：这一格盯的是「差的正好是这两份」，
 * 多一份少一份都算失败。 */
const X64_UNITS = ['tcc', 'libtcc', 'tccpp', 'tccgen', 'tccdbg', 'tccelf', 'tccasm', 'tccrun',
  'x86_64-gen', 'x86_64-link', 'i386-asm', 'tccmacho'];
/* 我们的 `long double` 在 x86_64 上还是 8 字节（该是 16 字节的 x87 80 位）——
 * 于是我们编出来的 tcc 存不住 `1.5L`，这两份用例里那十个字节写成了零。 */
const X64_KNOWN_DIFF = ['15-float.c', '21-ldouble.c'];
const XTCC = join(root, '.omni-cache', 'tcc-cross', 'x86_64-osx-tcc');
const SDK_INC = SDK === '' ? '' : join(SDK, 'usr', 'include');

if (!existsSync(XTCC) || SDK_INC === '') {
  process.stdout.write(`  skip x86_64 那一段：找不到 ${XTCC}\n`);
} else {
  mkdirSync(OUT, { recursive: true });
  const xDir = join(OUT, 'x64');
  mkdirSync(xDir, { recursive: true });
  const xBanner = spawnSync(XTCC, ['-v'], { encoding: 'utf8' }).stdout;
  const xm = /^tcc version \S+ (.*) \(/.exec(xBanner);
  const xGit = xm === null ? [] : [`-DTCC_GITHASH="${xm[1]}"`];
  let xOk = true;
  for (const u of X64_UNITS) {
    const r = spawnSync(process.execPath,
      [CLI, 'c-obj', join(SRC, `${u}.c`), '-I', TCC_DIR, '-DONE_SOURCE=0',
        '-DTCC_TARGET_X86_64', '-DTCC_TARGET_MACHO', '--arch', 'x86_64',
        ...(u === 'tcc' ? xGit : []),
        '-o', join(xDir, `${u}.o`)],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (r.status !== 0) {
      bad(`c-obj --arch x86_64 ${u}.c`,
        `    ${(r.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
      xOk = false;
    }
  }
  if (xOk) {
    ok(`c-obj --arch x86_64 ×${X64_UNITS.length}（x86_64-osx 那一套源码）`);
    const xExe = join(OUT, 'x64-tcc');
    const xln = spawnSync('clang',
      ['-arch', 'x86_64', '-o', xExe, ...X64_UNITS.map((u) => join(xDir, `${u}.o`))],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (xln.status !== 0) {
      const msg = (xln.stderr ?? '').trim().split('\n');
      bad('clang -arch x86_64 -o x64-tcc *.o',
        `    ${msg.length} 行，前三条：\n    ${msg.slice(0, 3).join('\n    ')}`);
    } else {
      const v = spawnSync('arch', ['-x86_64', xExe, '-v'], { encoding: 'utf8' });
      if (v.stdout !== xBanner) {
        bad('x64-tcc -v', `    tcc : ${xBanner.trim()}\n    ours: ${(v.stdout ?? '').trim()}`);
      } else {
        ok(`x64-tcc -v == x86_64-osx-tcc -v（${xBanner.trim()}，在 Rosetta 上）`);
        const args = ['-B', TCC_DIR, '-I', SDK_INC];
        const diffs = [];
        let same = 0;
        for (const f of genFiles) {
          const ro = join(OUT, 'xref.o');
          const mo = join(OUT, 'xmine.o');
          if (spawnSync(XTCC, [...args, '-c', f, '-o', ro],
            { encoding: 'utf8' }).status !== 0) continue;   // 尺子自己就拒了
          const a = spawnSync('arch', ['-x86_64', xExe, ...args, '-c', f, '-o', mo],
            { encoding: 'utf8' });
          const base = f.slice(f.lastIndexOf('/') + 1);
          const eq = a.status === 0
            && Buffer.compare(readFileSync(mo), readFileSync(ro)) === 0;
          if (eq) same++;
          if (eq === X64_KNOWN_DIFF.includes(base)) {
            diffs.push(`    ${base}：${eq ? '相同了 —— 把它从已知不同里去掉' : '字节不同'}`);
          }
        }
        if (diffs.length > 0) {
          bad('x64-tcc -c tests/c/gen/*.c == x86_64-osx-tcc -c', diffs.slice(0, 6).join('\n'));
        } else {
          ok(`x64-tcc -c tests/c/gen/*.c == x86_64-osx-tcc -c（${same} 份相同，`
            + `已知不同 ${X64_KNOWN_DIFF.length} 份：long double 还是 8 字节）`);
        }
      }
    }
  }
  rmSync(OUT, { recursive: true, force: true });
}

if (failures.length > 0) {
  process.stdout.write('\n');
  for (const f of failures) process.stdout.write(`${f}\n`);
}
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
