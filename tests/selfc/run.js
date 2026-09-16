#!/usr/bin/env node
// Omni — **闭环**那一条轴（第一百三十五片）：一个外部工具都不用，从 .omni 到能跑的二进制。
//
//   .omni --> (backend-c) .c --> (我们自己那台 C 前端) .o --> (我们自己的链接器) 可执行文件
//
// 判据是**输出与解释器逐字节相同**。这一条与别的轴不重叠：
//   - `tests/c` 那几组问的是「我们的 C 前端与 tcc/我们自己另一条腿一致」
//   - `tests/c` 的 abi/ 问的是「我们的 `.o` 与 cc 的 `.o` 摆实参一致」
//   - 这一条问的是「**整条自己的路**能不能真的产出一个跑得起来的二进制」——
//     少了它，前两条全绿而链接器或运行时的哪一格坏了也没人知道。
//
// 默认还是外部 cc（`findCC()`）—— 这条路先钉在测试里，不动默认。
//
// **整份编译器那一趟量在这儿**（第一百三十六片，没进这条轴：它要 `dist/build/omni.c`
// 这个构建产物，不该由测试去建）：
//
//   node src/cli.js c obj dist/build/omni.c -o omni-self.o --arch arm64 --os osx -f elf
//       -> 过了，`.o` 65260089 字节、5.9s（要 `--max-old-space-size=8192`）
//   node src/cli.js c link omni-self.o rt-*.o -o omni-selfhost -f macho -lc -L $SDK/usr/lib
//       -> 55196344 字节、14 条加载命令、6 节、入口 0x31d3408、2.5s
//   ./omni-selfhost --help                      -> 印出用法
//   ./omni-selfhost check tests/cases/01_basics.omni
//       -> `ok  …：6 个函数（前端 + 检查器，没出产物）`
//
// 也就是说**整个前端 + 检查器已经在一个我们自己编、自己链的二进制里跑起来了**。
// 还差的一格是**插件**：核心与插件之间靠 `k_s16_N_s` 这一族串常量符号连着（插件引用
// 核心导出的那些），所以两边必须一起建 —— 拿旧的插件喂新核心，症状是
// `dlopen … symbol not found in flat namespace '_k_s16_1665_s'`。
//
//   node tests/selfc/run.js

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { workDir } from '../work.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const RUNTIME = join(root, 'src', 'runtime');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];
const ok = (n) => { pass++; process.stdout.write(`  ok   ${n}\n`); };
const bad = (n, d) => { fail++; failures.push(`${n}\n${d}`); process.stdout.write(`  FAIL ${n}\n`); };

/** 这一趟的目标：只在**本机**上跑（要真的执行产物）。 */
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x86_64';
const OS = process.platform === 'darwin' ? 'osx' : process.platform === 'win32' ? 'win32' : 'linux';
const FMT = OS === 'osx' ? 'macho' : OS === 'win32' ? 'pe' : 'elf';

const node = (args) => spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
const omni = (args) => node([CLI, ...args]);

/** macOS 上链接要 libSystem（`___error` 一族在那儿）：SDK 的 usr/lib。取不到就跳过。 */
function usrLib() {
  if (OS !== 'osx') return [];
  const r = spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return ['-lc', '-L', join((r.stdout ?? '').trim(), 'usr', 'lib')];
}

const dir = workDir('selfc');
const libs = usrLib();

/**
 * 那 20 份运行时编一遍（这一轴里只编一次，几份用例共用）。
 *
 * 容器是 **ELF**：`omni c link` 读的是 ELF 目标文件（tcc 的 `-c` 在所有目标上都写
 * ELF，见 `omni c link --help` 那一段），写出来的才是 macho/pe。第一次试的时候按
 * `-f macho` 编的 `.o`，链接那一步报「macho: 还不会给 0 号架构写可执行文件」——
 * 那是把 Mach-O 的头当 ELF 的 `e_machine` 读出来的 0。
 */
function buildRuntime() {
  const objs = [];
  for (const f of readdirSync(RUNTIME).filter((x) => x.endsWith('.c')).sort()) {
    const o = join(dir, `rt-${basename(f, '.c')}.o`);
    const r = omni(['c', 'obj', join(RUNTIME, f), '-o', o,
      '--arch', ARCH, '--os', OS, '-f', 'elf', '-I', RUNTIME]);
    if (r.status !== 0) return { objs: null, why: `编 ${f} 没过：\n${r.stderr}` };
    objs.push(o);
  }
  return { objs, why: null };
}

function loopCase(name, rtObjs) {
  const src = join(root, 'tests', 'cases', name);
  const nm = `selfc/${name} [我们编 + 我们链 == 解释器]`;
  /* 1. 生成 C（backend-c 那条腿，与 `build:native` 走的是同一段代码）。 */
  const c = omni(['emit', 'c', src]);
  if (c.status !== 0) {
    bad(nm, `    生成 C 没过：\n${c.stderr}`);
    return;
  }
  const cpath = join(dir, `${basename(name, '.omni')}.c`);
  writeFileSync(cpath, c.stdout);
  /* 2. 我们自己那台 C 前端编成目标文件。 */
  const obj = join(dir, `${basename(name, '.omni')}.o`);
  const g = omni(['c', 'obj', cpath, '-o', obj, '--arch', ARCH, '--os', OS, '-f', 'elf',
    '-I', RUNTIME]);
  if (g.status !== 0) {
    bad(nm, `    编生成的 C 没过：\n${g.stderr}`);
    return;
  }
  /* 3. 我们自己的链接器出可执行文件。 */
  const exe = join(dir, basename(name, '.omni'));
  const l = omni(['c', 'link', obj, ...rtObjs, '-o', exe,
    '--arch', ARCH, '--os', OS, '-f', FMT, ...libs, '-q']);
  if (l.status !== 0) {
    bad(nm, `    链接没过：\n${l.stderr}`);
    return;
  }
  spawnSync('chmod', ['+x', exe]);
  /* 4. 跑它，与解释器逐字节比。 */
  const got = spawnSync(exe, [], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const want = omni(['run', src]);
  if (got.status !== 0) {
    bad(nm, `    跑挂了（退出码 ${got.status}，信号 ${got.signal}）\n${got.stderr}`);
    return;
  }
  if (got.stdout !== want.stdout) {
    bad(nm, `    stdout 不同：\n--- 解释器 ---\n${want.stdout}--- 二进制 ---\n${got.stdout}`);
    return;
  }
  ok(`${nm} [${want.stdout.split('\n').length - 1} 行]`);
}

/* 用例挑「跑得起来、输出确定」的那几个 —— 这一轴量的是**整条路通不通**，
 * 语言特性的覆盖是别的轴的事。 */
const CASES = ['01_basics.omni', '02_numeric.omni', '03_structs.omni'];
const picked = CASES.filter((n) => !filters.length || filters.some((x) => n.includes(x)));

if (libs === null) {
  process.stdout.write('selfc: 取不到 SDK 路径（xcrun），整轴跳过\n');
  skip = picked.length;
} else {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const rt = buildRuntime();
  if (rt.objs === null) {
    bad('selfc/runtime', `    ${rt.why}`);
  } else {
    ok(`selfc/runtime [${rt.objs.length} 份运行时都编过了]`);
    for (const n of picked) loopCase(n, rt.objs);
  }
}

for (const f of failures) process.stdout.write(`\n${f}\n`);
process.stdout.write(`\n${pass} passed, ${fail} failed${skip > 0 ? `, ${skip} skipped` : ''}\n`);
process.exit(fail > 0 ? 1 : 0);
