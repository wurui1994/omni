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
// c67 换一套探针：tinycc 的 c67 后端在**跨两个字的参数**上读越界（`PROBE_SRC` 里
// 那段注释量得很细），那种输入的输出取决于全局量摆在哪，称不出我们的对错。
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
import { TCC_TARGETS, unitsOf } from './tcc-targets.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const TCC_DIR = join(root, '.omni-cache', 'tcc-build');
const CROSS = join(root, '.omni-cache', 'tcc-cross');
const CLI = join(root, 'stage0', 'src', 'cli.js');
const SRC = process.env.TINYCC_SRC ?? '/Users/wurui/Documents/Lang/reference/tinycc';
const OUT = join(tmpdir(), 'omni-selfcross');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));

/* 十二个目标的文件集与宏在 `tcc-targets.js`（两个门共用，第九十九片挪出去的）。
 * c67 那副的探针换一套：它的 `load()` 在**跨两个字的参数**上读越界（见 `PROBE_SRC`）。 */
const PROBES_OF = { c67: ['wide64', 'float', 'struct1', 'flow'] };
const TARGETS = TCC_TARGETS.map((t) => ({ ...t, probes: PROBES_OF[t.name] }));


/* 探针。不带 `#include` —— 交叉编译器没有目标那一侧的头。
 * 挑的是几段最容易在「换一副后端」时露馅的东西：整数与浮点的算术、结构体传值、
 * switch、串常量、局部数组、递归。 */
const PROBE_SRC = {
  arith: 'int add(int a, int b) { return a + b * 3 - (a / 7) % 5; }\n'
    + 'long long wide(long long a, unsigned b) { return (a << 3) ^ (long long) b; }\n',
  float: 'double mix(double d, float g, int i) { return d * g + i / 2.0; }\n'
    + 'int trunc_(double d) { return (int) d; }\n',
  struct: 'struct P { int x, y; char c; };\n'
    + 'int sum(struct P p) { return p.x + p.y + p.c; }\n'
    + 'struct P mk(int v) { struct P p; p.x = v; p.y = v * 2; p.c = (char) v; return p; }\n',
  flow: 'static const char *msg = "hello";\n'
    + 'int pick(int k) { switch (k) { case 0: return 1; case 3: return 7;'
    + ' default: return msg[k & 3]; } }\n'
    + 'int fib(int n) { int a[4]; a[0] = n; return n < 2 ? n : fib(n - 1) + fib(n - 2); }\n',
  /* c67 专用的两份：把**跨两个字的参数**换掉，别的照旧。
   *
   * 为什么要换：c67 的 `load()`（`c67-gen.c:1592-1605`）碰上 `fc > 0`（tcc 以为这是
   * 栈上的参数）时，在 `TranslateStackToReg` 上找那个偏移属于第几个参数；一个跨两个字的
   * 参数只有**第一个字**的偏移对得上（`stack_pos` 一次加整个参数的大小），第二个字
   * 找不到，循环走满，`t == NoCallArgsPassedOnStack`，接着那句
   * `fc = ParamLocOnStack[t] - 8;` 读的是 `int[10]` 的**第 11 格** —— 越界。
   * 量过：`long long f(long long a){return a<<3;}` 在两份 tcc 里都是 `fc=12 t=10`，
   * 差的只是那一格里躺着什么（我们编的那份是 0、clang 编的那份是 8），于是发出去的
   * MVKL 常量差 2、指令字差一位。结构体传值（`struct P` 12 字节）走的是同一条路。
   *
   * 这不是代码生成的账，是**被编的那份程序自己踩了未定义行为** —— 它的输出取决于
   * 全局量的摆法，量不出我们的对错，所以这一副换成一个字的参数：64 位的移位与异或
   * 从局部量上走，结构体只留一个 `int`（第九十七片）。 */
  wide64: 'long long wide(int k, unsigned b) { long long a = k;'
    + ' return (a << 3) ^ (long long) b; }\n'
    + 'int add(int a, int b) { return a + b * 3 - (a / 7) % 5; }\n',
  struct1: 'struct S { int x; };\n'
    + 'int one(struct S s) { return s.x + 1; }\n'
    + 'struct S mk(int v) { struct S s; s.x = v * 2; return s; }\n',
};
const DEFAULT_PROBES = ['arith', 'float', 'struct', 'flow'];

let pass = 0;
let fail = 0;
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
for (const [n, src] of Object.entries(PROBE_SRC)) writeFileSync(join(OUT, `${n}.c`), src);

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
  const units = unitsOf(t);
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
  const probes = t.probes ?? DEFAULT_PROBES;
  for (const n of probes) {
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
    ok(`${t.name}（${units.length} 份源码 -> 一副交叉编译器，${probes.length} 个探针逐字节相同）`);
    continue;
  }
  /* 与预先建好的那份不同 —— **先别急着认账**。`.omni-cache/tcc-cross/` 里那些是
   * 另一次（另一个源码版本）建出来的：它们的 git 戳是 `main@4fb21a4`，而源码树在
   * `mob@2ba12e83`。
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
  for (const n of probes) {
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
    bad(`${t.name}: -c 探针`, `${diffs.join('\n')}\n${vs.join('\n')}`);
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
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
