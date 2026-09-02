// tests/c/selfcross.js —— 十二副**交叉编译器**，全是我们编出来的
// （ADR-0017 第九刀第九十六片）
//
// `selfobj.js` 走的是两副本机架构（arm64 与 x86_64 的 macOS）。这一组把 tinycc
// 支持的目标一副副都编出来：i386 / x86_64 / arm / arm64 / riscv64 / c67，
// 每副再乘上 ELF、PE、Mach-O 三种目标文件格式 —— 一共十二副。
//
// 每一副三步：
//
//   1. `omni c-obj` 把那副的源码（`Makefile:203-219` 的 `<target>_FILES`）编成 `.o`；
//   2. `clang` 链成一个**本机 arm64** 的可执行文件 —— 交叉编译器自己是本机程序；
//   3. 它 `-c` 编探针，出来的目标文件与 `.omni-cache/tcc-cross/<target>-tcc`
//      写出的**逐字节相同**。
//
// 探针不带任何 `#include`：交叉编译器没有目标那一侧的系统头（`configure` 只给本机
// 那一份烤了 SDK 的路径）。称的是代码生成与目标文件写出那两段。
//
// `tcctools.c` **不单独编**：`tcc.c` 里有一句 `#include "tcctools.c"`
// （Makefile 的 `LIBTCC_SRC` 也把它与 `tcc.c` 一起滤掉了）。单独编会撞
// `duplicate symbol '_tcc_tool_ar'` —— 这一格量过。
//
//   node tests/c/selfcross.js            # 十二副，约 45 秒
//   node tests/c/selfcross.js riscv c67  # 只跑名字对得上的

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const TCC_DIR = join(root, '.omni-cache', 'tcc-build');
const CROSS = join(root, '.omni-cache', 'tcc-cross');
const CLI = join(root, 'stage0', 'src', 'cli.js');
const SRC = process.env.TINYCC_SRC ?? '/Users/wurui/Documents/Lang/reference/tinycc';
const OUT = join(tmpdir(), 'omni-selfcross');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));

/* `CORE_FILES` 减掉 `tcctools.c`（见文件头）。 */
const CORE = ['tcc', 'libtcc', 'tccpp', 'tccgen', 'tccdbg', 'tccelf', 'tccasm', 'tccrun'];
const I386 = ['i386-gen', 'i386-link', 'i386-asm'];
const X64 = ['x86_64-gen', 'x86_64-link', 'i386-asm'];
const ARM = ['arm-gen', 'arm-link', 'arm-asm'];
const ARM64 = ['arm64-gen', 'arm64-link', 'arm64-asm'];
const ARM_DEF = ['-DTCC_TARGET_ARM', '-DTCC_ARM_VFP', '-DTCC_ARM_EABI', '-DTCC_ARM_HARDFLOAT'];

/** 十二副。`defs` 抄的是 Makefile:100-120 的 `DEF-<target>`。 */
const TARGETS = [
  { name: 'i386', files: I386, defs: ['-DTCC_TARGET_I386'] },
  { name: 'i386-win32', files: [...I386, 'tccpe'], defs: ['-DTCC_TARGET_I386', '-DTCC_TARGET_PE'] },
  { name: 'x86_64', files: X64, defs: ['-DTCC_TARGET_X86_64'] },
  { name: 'x86_64-win32', files: [...X64, 'tccpe'], defs: ['-DTCC_TARGET_X86_64', '-DTCC_TARGET_PE'] },
  { name: 'x86_64-osx', files: [...X64, 'tccmacho'], defs: ['-DTCC_TARGET_X86_64', '-DTCC_TARGET_MACHO'] },
  { name: 'arm', files: ARM, defs: ARM_DEF },
  { name: 'arm-wince', files: [...ARM, 'tccpe'], defs: [...ARM_DEF, '-DTCC_TARGET_PE'] },
  { name: 'arm64', files: ARM64, defs: ['-DTCC_TARGET_ARM64'] },
  { name: 'arm64-osx', files: [...ARM64, 'tccmacho'], defs: ['-DTCC_TARGET_ARM64', '-DTCC_TARGET_MACHO'] },
  { name: 'arm64-win32', files: [...ARM64, 'tccpe'], defs: ['-DTCC_TARGET_ARM64', '-DTCC_TARGET_PE'] },
  { name: 'riscv64', files: ['riscv64-gen', 'riscv64-link', 'riscv64-asm'], defs: ['-DTCC_TARGET_RISCV64'] },
  /* c67 那副 tinycc 自己都要 `-w`（它的代码生成器有一堆警告）。
   * 这一副是**已知不同**的：最小的复现是 `long long f(long long a){return a<<3;}`
   * —— 32 位目标上的 64 位移位走的是运行时的 `__ashldi3`，而那次调用的参数落位上
   * 差一个 c67 的寻址模式位（我们发 mode 0、clang 编出来的那份发 mode 1）。
   * 二分过：只换 `c67-gen.o` 一份就差出来，所以账在我们编 `c67-gen.c` 这一步。 */
  {
    name: 'c67',
    files: ['c67-gen', 'c67-link', 'tcccoff'],
    defs: ['-DTCC_TARGET_C67', '-w'],
    known: 'long long f(long long a){return a<<3;} —— 差一个 c67 的寻址模式位（第九十六片）',
  },
];

/* 探针。不带 `#include` —— 交叉编译器没有目标那一侧的头。
 * 挑的是几段最容易在「换一副后端」时露馅的东西：整数与浮点的算术、结构体传值、
 * switch、串常量、局部数组、递归。 */
const PROBES = [
  ['arith', 'int add(int a, int b) { return a + b * 3 - (a / 7) % 5; }\n'
    + 'long long wide(long long a, unsigned b) { return (a << 3) ^ (long long) b; }\n'],
  ['float', 'double mix(double d, float g, int i) { return d * g + i / 2.0; }\n'
    + 'int trunc_(double d) { return (int) d; }\n'],
  ['struct', 'struct P { int x, y; char c; };\n'
    + 'int sum(struct P p) { return p.x + p.y + p.c; }\n'
    + 'struct P mk(int v) { struct P p; p.x = v; p.y = v * 2; p.c = (char) v; return p; }\n'],
  ['flow', 'static const char *msg = "hello";\n'
    + 'int pick(int k) { switch (k) { case 0: return 1; case 3: return 7;'
    + ' default: return msg[k & 3]; } }\n'
    + 'int fib(int n) { int a[4]; a[0] = n; return n < 2 ? n : fib(n - 1) + fib(n - 2); }\n'],
];

let pass = 0;
let fail = 0;
let known = 0;
const failures = [];
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => {
  fail++;
  failures.push(`${name}\n${detail}`);
  process.stdout.write(`  FAIL ${name}\n`);
};

if (!existsSync(join(SRC, 'tccpp.c')) || !existsSync(join(CROSS, 'riscv64-tcc'))) {
  process.stdout.write('  skip 整组：尺子不在\n');
  process.stdout.write(`       源码: ${SRC}\n       交叉编出来的那些: ${CROSS}\n`);
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const [n, src] of PROBES) writeFileSync(join(OUT, `${n}.c`), src);

for (const t of TARGETS) {
  if (filters.length > 0 && !filters.some((x) => t.name.includes(x))) continue;
  const ref = join(CROSS, `${t.name}-tcc`);
  if (!existsSync(ref)) {
    process.stdout.write(`  skip ${t.name}：${ref} 不在\n`);
    continue;
  }
  /* 版本行里那段 git 戳是建**那一份**时的 `-DTCC_GITHASH`（Makefile:267，只给
   * `tcc.o`），算不出来 —— 从尺子自己的版本行里读回来递进去。 */
  const banner = spawnSync(ref, ['-v'], { encoding: 'utf8' }).stdout;
  const m = /^tcc version \S+ (.*) \(/.exec(banner);
  const gitDefs = m === null ? [] : [`-DTCC_GITHASH="${m[1]}"`];
  const dir = join(OUT, t.name);
  mkdirSync(dir, { recursive: true });
  const units = [...CORE, ...t.files];
  let built = true;
  for (const u of units) {
    const r = spawnSync(process.execPath,
      [CLI, 'c-obj', join(SRC, `${u}.c`), '-I', TCC_DIR, '-DONE_SOURCE=0', ...t.defs,
        ...(u === 'tcc' ? gitDefs : []), '-o', join(dir, `${u}.o`)],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (r.status !== 0) {
      bad(`${t.name}: c-obj ${u}.c`,
        `    ${(r.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
      built = false;
    }
  }
  if (!built) continue;
  const exe = join(dir, 'tcc');
  const ln = spawnSync('clang', ['-o', exe, ...units.map((u) => join(dir, `${u}.o`))],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (ln.status !== 0) {
    const msg = (ln.stderr ?? '').trim().split('\n');
    bad(`${t.name}: clang -o tcc *.o`, `    ${msg.length} 行，前三条：\n    ${msg.slice(0, 3).join('\n    ')}`);
    continue;
  }
  chmodSync(exe, 0o755);
  const v = spawnSync(exe, ['-v'], { encoding: 'utf8' });
  if (v.stdout !== banner) {
    bad(`${t.name}: -v`, `    tcc : ${banner.trim()}\n    ours: ${(v.stdout ?? '').trim()}`);
    continue;
  }
  const diffs = [];
  for (const [n] of PROBES) {
    const p = join(OUT, `${n}.c`);
    const mo = join(dir, `${n}.mine.o`);
    const ro = join(dir, `${n}.ref.o`);
    const a = spawnSync(exe, ['-c', p, '-o', mo], { encoding: 'utf8' });
    const b = spawnSync(ref, ['-c', p, '-o', ro], { encoding: 'utf8' });
    if (b.status !== 0) continue;                 // 尺子自己就拒了：没有可比的
    if (a.status !== 0) {
      diffs.push(`    ${n}：我们拒了 —— ${(a.stderr ?? '').trim().split('\n')[0]}`);
      continue;
    }
    if (Buffer.compare(readFileSync(mo), readFileSync(ro)) !== 0) diffs.push(`    ${n}：字节不同`);
  }
  if (diffs.length === 0) {
    ok(`${t.name}（${units.length} 份源码 -> 一副交叉编译器，${PROBES.length} 个探针逐字节相同）`);
    continue;
  }
  /* 与预先建好的那份不同 —— **先别急着认账**。`.omni-cache/tcc-cross/` 里那些是
   * 另一次（另一个源码版本）建出来的：它们的 git 戳是 `main@4fb21a4`，而源码树在
   * `mob@2ba12e83`。c67 那副就是这么差出来的。
   *
   * 所以差异出现时再拿 **clang 编同一份源码、同一套 `-D`** 当第二把尺子：
   * 我们与它相同，说明差的是「尺子那份的版本」，不是我们的代码生成。 */
  const cDir = join(dir, 'clang');
  mkdirSync(cDir, { recursive: true });
  let cOk = true;
  for (const u of units) {
    const r = spawnSync('clang',
      ['-c', '-w', '-I', TCC_DIR, '-DONE_SOURCE=0', ...t.defs,
        ...(u === 'tcc' ? gitDefs : []), join(SRC, `${u}.c`), '-o', join(cDir, `${u}.o`)],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (r.status !== 0) cOk = false;
  }
  const cExe = join(cDir, 'tcc');
  if (cOk) {
    cOk = spawnSync('clang', ['-o', cExe, ...units.map((u) => join(cDir, `${u}.o`))],
      { encoding: 'utf8', maxBuffer: 1 << 26 }).status === 0;
  }
  if (!cOk) {
    bad(`${t.name}: -c 探针 == ${t.name}-tcc -c`,
      `${diffs.join('\n')}\n    （想拿 clang 建第二把尺子，但那一步自己没成）`);
    continue;
  }
  const vs = [];
  for (const [n] of PROBES) {
    const p = join(OUT, `${n}.c`);
    const co = join(cDir, `${n}.o`);
    if (spawnSync(cExe, ['-c', p, '-o', co], { encoding: 'utf8' }).status !== 0) {
      vs.push(`    ${n}：clang 那份也拒了`);
      continue;
    }
    if (Buffer.compare(readFileSync(join(dir, `${n}.mine.o`)), readFileSync(co)) !== 0) {
      vs.push(`    ${n}：与 clang 编的同源 tcc 也不同 —— 这才是我们的账`);
    }
  }
  if (vs.length > 0) {
    /* 标了 `known` 的：差是记在账上的，报出来但不算失败。反过来 —— 它要是**相同**了，
     * 那就该把这一格去掉，所以「不该相同却相同」在下面当失败报。 */
    if (t.known !== undefined) {
      process.stdout.write(`  知道 ${t.name}：与 clang 编的同源 tcc 不同（${t.known}）\n`);
      known++;
      continue;
    }
    bad(`${t.name}: -c 探针`, `${diffs.join('\n')}\n${vs.join('\n')}`);
  } else if (t.known !== undefined) {
    bad(`${t.name}: 已知不同那一格`,
      '    与 clang 编的同源 tcc 相同了 —— 把 TARGETS 里那个 known 去掉');
  } else {
    ok(`${t.name}（${units.length} 份源码 -> 一副交叉编译器；与 clang 编的同源 tcc`
      + ` 逐字节相同，与 .omni-cache 里那份不同 —— 那份是 ${m === null ? '?' : m[1]} 建的）`);
  }
}

rmSync(OUT, { recursive: true, force: true });

if (failures.length > 0) {
  process.stdout.write('\n');
  for (const f of failures) process.stdout.write(`${f}\n`);
}
process.stdout.write(`\n${pass} passed, ${fail} failed${known > 0 ? `, ${known} 已知不同` : ''}\n`);
process.exit(fail > 0 ? 1 : 0);
