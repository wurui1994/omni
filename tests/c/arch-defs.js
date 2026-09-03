// tests/c/arch-defs.js —— `--arch` 换的不只是后端：预定义宏里目标 CPU 那三条也跟着换
// （ADR-0017 第九刀第一百〇二片）
//
// 量出来的：`tcc -dM -E /dev/null` 与 `x86_64-osx-tcc -dM -E /dev/null` 一 diff，
// 五十条里**只差三行** —— arm64 那边是 `__aarch64__` / `__arm64__` / `__AARCH64EL__`，
// x86_64 那边是 `__x86_64__` / `__x86_64` / `__amd64__`。别的（LP64、macOS、C99 那些）
// 两边同形。
//
// 这三条不是摆设：系统头与 tinycc 自己的源码都按它们分支（`tcc.h:163-186` 在没有
// `TCC_TARGET_*` 时就是照 `__x86_64__` / `__aarch64__` 选目标的）。所以 `--arch x86_64`
// 却预定义 `__aarch64__` 的话，编出来的是「按 arm64 那一支展开、按 x86_64 生成」的
// 四不像 —— 编得过，跑起来才发现声明与调用约定对不上。
//
// 尺子是 tcc：本机那份对 arm64，交叉那份（`x86_64-osx-tcc`，出来的可执行文件在
// Rosetta 上跑）对 x86_64。探针把这六个宏的在与不在印出来，两边逐字节比。
//
//   node tests/c/arch-defs.js

import { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const TCC_DIR = join(root, '.omni-cache', 'tcc-build');
const TCC = join(TCC_DIR, 'tcc');
const XTCC = join(root, '.omni-cache', 'tcc-cross', 'x86_64-osx-tcc');
const CLI = join(root, 'src', 'core', 'cli.js');
const OUT = join(tmpdir(), 'omni-archdefs');

const MACROS = ['__aarch64__', '__arm64__', '__AARCH64EL__', '__x86_64__', '__x86_64', '__amd64__'];
const PROBE = `#include <stdio.h>\nint main(void) {\n${MACROS.map((m) => `#ifdef ${m}\n  printf("${m} 1\\n");\n#else\n  printf("${m} -\\n");\n#endif`).join('\n')}\n  printf("ptr %d long %d\\n", (int) sizeof(void *), (int) sizeof(long));\n  return 0;\n}\n`;

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  process.stdout.write(`  skip 整组：这一组是 arm64 macOS 的（现在是 ${process.platform}/${process.arch}）\n`);
  process.exit(0);
}
if (!existsSync(TCC) || !existsSync(XTCC)) {
  process.stdout.write(`  skip 整组：尺子不在（${TCC} / ${XTCC}）\n`);
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const src = join(OUT, 'probe.c');
writeFileSync(src, PROBE);

/* 交叉那份尺子没有系统头那一格（`configure` 只给本机那份烤了 SDK 的路径，
 * 第九十四片量过），所以要手工给它 `-I <SDK>/usr/include`。 */
const SDK = spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).stdout.trim();
const legs = [
  { name: 'arm64（本机）', ruler: TCC, refArgs: ['-B', TCC_DIR], arch: [], run: [] },
  {
    name: 'x86_64（Rosetta）',
    ruler: XTCC,
    /* `-B` 指到交叉那一堆：`x86_64-osx-libtcc1.a` 在那儿。 */
    refArgs: ['-B', dirname(XTCC), '-I', join(SDK, 'usr', 'include'), '-L', join(SDK, 'usr', 'lib')],
    arch: ['--arch', 'x86_64'],
    run: ['arch', '-x86_64'],
  },
];

for (const leg of legs) {
  /* 尺子：tcc 自己编自己链，跑一遍。 */
  const refExe = join(OUT, `ref-${leg.run.length}`);
  const rl = spawnSync(leg.ruler, [...leg.refArgs, src, '-o', refExe],
    { encoding: 'utf8' });
  if (rl.status !== 0) {
    bad(`${leg.name}: 尺子链不出来`, `    ${(rl.stderr ?? '').trim().split('\n')[0]}`);
    continue;
  }
  const want = leg.run.length === 0
    ? spawnSync(refExe, [], { encoding: 'utf8' })
    : spawnSync(leg.run[0], [leg.run[1], refExe], { encoding: 'utf8' });

  /* 我们：`c-obj` 出 `.o`，`clang` 链（这一格称的是前端的预定义宏，链谁都一样）。 */
  const obj = join(OUT, `mine-${leg.run.length}.o`);
  const co = spawnSync(process.execPath, [CLI, 'c-obj', src, ...leg.arch, '-o', obj],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (co.status !== 0) {
    bad(`${leg.name}: c-obj`, `    ${(co.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
    continue;
  }
  const exe = join(OUT, `mine-${leg.run.length}`);
  const cc = spawnSync('clang', [...(leg.arch.length === 0 ? ['-arch', 'arm64'] : ['-arch', 'x86_64']),
    obj, '-o', exe], { encoding: 'utf8' });
  if (cc.status !== 0) {
    bad(`${leg.name}: clang 链`, `    ${(cc.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
    continue;
  }
  chmodSync(exe, 0o755);
  const got = leg.run.length === 0
    ? spawnSync(exe, [], { encoding: 'utf8' })
    : spawnSync(leg.run[0], [leg.run[1], exe], { encoding: 'utf8' });
  if (got.stdout !== want.stdout) {
    bad(`${leg.name}: 预定义宏与 tcc 相同`,
      `    tcc :\n${(want.stdout ?? '').trimEnd().split('\n').map((l) => `      ${l}`).join('\n')}\n`
      + `    ours:\n${(got.stdout ?? '').trimEnd().split('\n').map((l) => `      ${l}`).join('\n')}`);
    continue;
  }
  ok(`${leg.name}：六个 CPU 宏 + 指针/long 宽度与 tcc 一字不差`);
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
