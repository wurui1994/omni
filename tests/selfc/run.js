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
// 核心与插件之间靠 `k_s16_N_s` 这一族串常量符号连着（插件引用核心导出的那些），所以两边
// 必须**一起建** —— 拿旧的插件喂新核心，症状是
// `dlopen … symbol not found in flat namespace '_k_s16_1665_s'`。
//
// **插件那一格也通了**（第一百三十八片）：链接器早有 `--shared`（macho_exe 的 MH_DYLIB /
// elf_exe 的 ET_DYN），`OMNI_CC=self` 那条路以前只是没接过来。整份量到的是：
//
//   OMNI_CC=self omni build src/cli.js --extern --plugins -o dist-self/omni
//       -> 核心 52.7M（C 13.7M / 272588 行，发射 316ms + cc 8.6s）+ 12 格插件 115.3M，31.5s
//       （这一行是第一百四十二到一百四十五片那四刀**之前**量的；单独一个核心那一档
//        现在是 35.4M，见 `cli.js` 的 `selfCC` —— 带插件的整档没有重新量过）
//   ./dist-self/omni emit c|js|llvm tests/cases/01_basics.omni
//       -> 三格 target 插件都 dlopen 得动，`emit c` 与 node 那条腿逐字节相同
//
// arm64 macOS 上共享库**没签名就 dlopen 不了**（`missing code signature in <no uuid> …`），
// 所以 `buildSelf` 链完补一句 `codesign -f -s -` —— tcc 自己也是这么做的（`tccmacho.c:2243`）。
// 下面 `dylibCase` 把这一格钉住：一份 `.c` 出 dylib，另一份 `.c` 出可执行文件去 dlopen 它，
// 两边都走我们自己的 `c obj` + `c link`。
//
// **这条路的天花板也量到了**（第一百三十八片）：`OMNI_CC=self` 只在 **node 这条腿**上成立。
// 装好的编译器**跑不了自己的 C 前端**，而且与谁编的无关：
//
//   ./dist/omni c obj x.c            -> runtime error: a byte-buffer view expects a byte
//                                       buffer, found undefined      （cc 编的核心，一样）
//   OMNI_CC=self ./dist-self/omni build x.omni -> uncaught: TypeError: not a function
//
// 也就是 **C 那条腿上的 JS 支持还差几格**（不是这条路的问题）。于是 `omni bootstrap`
// 在 `OMNI_CC=self` 下停在第 2 阶段（N2 = N1 build，7 passed 1 failed）；默认那一路
// （外部 cc）照旧 **10 passed 0 failed**。往这一格走之前先补的两处是真 bug：
//   - `lang/c.js` 的 `readFile` 从前是 `try { readText } catch`，而 C 那条腿上读失败是
//     **致命错误**（`omni_js_host.c:146` 的 `omni_errorf`）—— 改成先 `exists` 再读；
//   - 自带的那几份头（`src/include`）从前不跟着产物走，装好的编译器一编 C 就说
//     `stdbool.h` 找不着 —— 进了 `CORE_DATA` 与自举的布局（`share/include`）。
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

/**
 * 链接时那一份「默认 libc + crt」——一个词：`--stdlib`（`c link` 那一格，
 * 与 `omni build` / `omni run` 走同一条路）。
 *
 * 从前这儿是手写的 `['-lc', '-L', <SDK>/usr/lib]`，而**非 macOS 上回的是空表** ——
 * 于是 x86_64 容器里这条轴 4 条挂在 `undefined symbol: stdout` 与
 * `undefined symbol: dlopen` 上：链出来的东西一个共享库都没带，crt 也没有。
 * 判据本身没错，错在判据自己拼那份清单。
 *
 * macOS 上 SDK 那一层还是要探一次（`-L <SDK>/usr/lib` 由 `cDefaultLibs('osx')` 给，
 * 它走的是 `c.usrLib` 那格能力）—— 取不到就跳过整轴，与从前一样。
 */
function usrLib() {
  if (OS !== 'osx') return ['--stdlib'];
  const r = spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return ['--stdlib'];
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

/**
 * 同一条路，**从 `omni build` 那一头走**（`OMNI_CC=self`，第一百三十七片）。
 *
 * 上面那几格是手工摆的三步（emit c / c obj / c link）；这一格问的是「那个开关真的把
 * 三步接起来了吗」—— 少了它，`buildSelf` 里任何一处摆错（容器、libc、执行位）都要等到
 * 有人手工试才发现。判据照旧是**与解释器逐字节相同**。
 */
function switchCase(name) {
  const src = join(root, 'tests', 'cases', name);
  const nm = `selfc/${name} [OMNI_CC=self omni build == 解释器]`;
  const exe = join(dir, `sw-${basename(name, '.omni')}`);
  const b = spawnSync(process.execPath, [CLI, 'build', src, '-o', exe, '--backend', 'c'],
    { encoding: 'utf8', env: { ...process.env, OMNI_CC: 'self' }, maxBuffer: 1 << 28 });
  if (b.status !== 0) {
    bad(nm, `    build 没过：\n${b.stderr}`);
    return;
  }
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

/**
 * 共享库那一格（第一百三十八片）：`--shared` 出一份 dylib/so，再由**我们自己链的**
 * 可执行文件把它 `dlopen` 进来。插件那条路上的每一样东西都在这一格里：
 * `--shared`、`--install-name`（`LC_ID_DYLIB`）、arm64 上非签不可的那一句 `codesign`。
 *
 * 故意用两份小 `.c` 而不是真插件：真插件要先有 `--extern` 的核心与 `.syms`（分钟级，
 * 而且那是 `build:native` 的事）。这一格问的是**链接器与装载器这一段**通不通。
 */
function dylibCase(name) {
  const nm = `selfc/${name} [我们出 dylib + 我们链的可执行文件 dlopen 它]`;
  const so = join(dir, OS === 'osx' ? 'libselfc.dylib' : 'libselfc.so');
  const lsrc = join(dir, 'dl-lib.c');
  const hsrc = join(dir, 'dl-host.c');
  writeFileSync(lsrc, 'int selfc_add(int a, int b) { return a + b; }\nint selfc_g = 7;\n');
  /* 宿主自己 `dlopen`：路径由 argv[1] 给（写死在源码里就换不了工作目录）。 */
  writeFileSync(hsrc, '#include <stdio.h>\n#include <dlfcn.h>\n'
    + 'int main(int c, char **v) {\n'
    + '  void *h = dlopen(v[1], RTLD_NOW);\n'
    + '  if (h == 0) { printf("dlopen: %s\\n", dlerror()); return 1; }\n'
    + '  int (*f)(int, int) = (int (*)(int, int)) dlsym(h, "selfc_add");\n'
    + '  int *g = (int *) dlsym(h, "selfc_g");\n'
    + '  if (f == 0 || g == 0) { printf("dlsym 找不到\\n"); return 2; }\n'
    + '  printf("%d %d\\n", f(3, 4), *g);\n'
    + '  return 0;\n}\n');
  const lo = join(dir, 'dl-lib.o');
  const ho = join(dir, 'dl-host.o');
  for (const [src, o] of [[lsrc, lo], [hsrc, ho]]) {
    const g = omni(['c', 'obj', src, '-o', o, '--arch', ARCH, '--os', OS, '-f', 'elf']);
    if (g.status !== 0) { bad(nm, `    编 ${basename(src)} 没过：\n${g.stderr}`); return; }
  }
  const sl = omni(['c', 'link', lo, '-o', so, '--arch', ARCH, '--os', OS, '-f', FMT,
    '--shared', '--install-name', so, ...libs, '-q']);
  if (sl.status !== 0) { bad(nm, `    出共享库没过：\n${sl.stderr}`); return; }
  /* 签名不属于链接器（tcc 也是链完 `system("codesign …")`）；少了它 arm64 上
   * `dlopen` 报的是 `missing code signature in <no uuid> '…'`。 */
  if (OS === 'osx') spawnSync('codesign', ['-f', '-s', '-', so], { encoding: 'utf8' });
  const exe = join(dir, 'dl-host');
  const hl = omni(['c', 'link', ho, '-o', exe, '--arch', ARCH, '--os', OS, '-f', FMT,
    ...libs, '-q']);
  if (hl.status !== 0) { bad(nm, `    链宿主没过：\n${hl.stderr}`); return; }
  spawnSync('chmod', ['+x', exe]);
  const got = spawnSync(exe, [so], { encoding: 'utf8' });
  if (got.status !== 0 || got.stdout !== '7 7\n') {
    bad(nm, `    退出码 ${got.status}，stdout ${JSON.stringify(got.stdout)}\n${got.stderr}`);
    return;
  }
  ok(`${nm} [selfc_add(3,4)=7、selfc_g=7]`);
}

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
    /* 开关那一格只跑头一个用例：它量的是「三步接起来了吗」，不是语言覆盖。 */
    if (picked.length > 0) switchCase(picked[0]);
    dylibCase('dylib');
  }
}

for (const f of failures) process.stdout.write(`\n${f}\n`);
process.stdout.write(`\n${pass} passed, ${fail} failed${skip > 0 ? `, ${skip} skipped` : ''}\n`);
process.exit(fail > 0 ? 1 : 0);
