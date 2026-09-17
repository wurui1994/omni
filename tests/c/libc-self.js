#!/usr/bin/env node
/* 自带 libc 在**本机 macOS** 上从编到跑的判据（第一百四十片第八格）。
 *
 * 量的是「问内核那一层」：`tests/x64/libc-syscall-probe.c` 里每一格都真的调一次内核，
 * 自己判自己。为什么值得一条独立的轴 —— 调用号错了的症状不是输出不同，是当场 SIGSYS
 * （`Bad system call: 12`）：`getcwd` 那个 326 号在 arm64 macOS 上无效（Apple 自己的
 * `syscall(326, …)` 也一样崩），而它露头的地方是「整份 43M 的编译器一起来就死」，
 * 离病根隔着链接与装载两层。判据摆在这儿，死在第几行就是第几格。
 *
 * 这条轴只在 arm64 macOS 上跑（要本机装载得动 Mach-O、还要 codesign）；别的机器上跳过。
 *
 *   node tests/c/libc-self.js
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CLI = join(ROOT, 'src', 'cli.js');
const SRC = join(HERE, '..', 'x64', 'libc-syscall-probe.c');
const SYSROOT = join(ROOT, 'src', 'sysroot', 'arm64-osx');
const WORK = join(ROOT, '.omni-cache', 'work', 'libc-self');
const OBJ = join(WORK, 'probe.o');
const BIN = join(WORK, 'probe');

let pass = 0;
let fail = 0;
const ok = (what) => { pass++; process.stdout.write(`  ok   ${what}\n`); };
const bad = (what, why) => { fail++; process.stdout.write(`  FAIL ${what}\n    ${why}\n`); };

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  process.stdout.write(`  skip 这条轴要 arm64 macOS（这台是 ${process.platform}/${process.arch}）\n`
    + '\n0 passed, 0 failed, 1 skipped\n');
  process.exit(0);
}

mkdirSync(WORK, { recursive: true });
rmSync(OBJ, { force: true });
rmSync(BIN, { force: true });

/* `.o` 一律是 ELF 容器（我们的链接器只读 ELF 的 `.o`，写 elf/macho/pe 三种可执行文件）。 */
const step = (args, timeout) => spawnSync(process.execPath, [CLI, ...args],
  { encoding: 'utf8', timeout, cwd: ROOT });

const o = step(['c', 'obj', SRC, '--arch', 'arm64', '--os', 'osx', '-f', 'elf', '-o', OBJ], 120000);
if (!existsSync(OBJ)) bad('c obj（我们自己那台 C 前端）', (o.stderr || o.stdout || '').slice(0, 300));
else ok('c obj（我们自己那台 C 前端）');

if (existsSync(OBJ)) {
  const l = step(['c', 'link', OBJ, '-o', BIN, '--stdlib', '--libc', 'self',
    '--sysroot', SYSROOT, '-f', 'macho', '--arch', 'arm64', '--os', 'osx'], 180000);
  if (!existsSync(BIN)) bad('c link --libc self（一个外部库都不链）', (l.stderr || l.stdout || '').slice(0, 300));
  else ok('c link --libc self（一个外部库都不链）');
}

if (existsSync(BIN)) {
  /* 执行位与 ad-hoc 签名：链接器只写字节（`buildSelf` 也是链完补这两句）。 */
  spawnSync('chmod', ['+x', BIN]);
  spawnSync('codesign', ['-f', '-s', '-', BIN], { encoding: 'utf8' });
  /* 一行都不该有 —— 连 libSystem 都不沾。 */
  const dl = spawnSync('otool', ['-L', BIN], { encoding: 'utf8' });
  const libs = (dl.stdout || '').split('\n').slice(1).filter((x) => x.trim() !== '');
  if (libs.length === 0) ok('otool -L 一行都不印（不沾 libSystem）');
  else bad('otool -L 一行都不印', libs.join(' / '));

  const run = spawnSync(BIN, [], { encoding: 'utf8', timeout: 30000 });
  const out = (run.stdout || '') + (run.stderr || '');
  if (run.signal !== null) {
    /* SIGSYS 就长这样：某个调用号在这台机器上不通。 */
    bad('跑起来不收信号（调用号都通）', `signal=${run.signal}，输出：${out.slice(0, 300)}`);
  } else ok('跑起来不收信号（调用号都通）');
  if (run.status === 0 && /0 failed/.test(out)) ok(`探子自己那几格全过（${out.trim().split('\n').pop()}）`);
  else bad('探子自己那几格全过', out.split('\n').filter((x) => x.startsWith('FAIL')).join(' / ') || out.slice(0, 300));
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
