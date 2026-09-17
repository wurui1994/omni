#!/usr/bin/env node
/* 我们自己那份 malloc 的判据（第一百四十片第四格）。
 *
 * 拿 `cc` 把 `tests/c/libc/malloc_probe.c` 编出来跑 —— 那份探子把 `brk` 换成一块
 * 静态数组，再把真的 `src/sysroot/x86_64-linux/libc/malloc.c` **原样 include** 进去。
 * 于是这条轴不进容器、不发 syscall，本机零点几秒就跑完，而量的是真的那份实现。
 *
 * 为什么值得单独一份：第一版 malloc 在这儿**十秒出不来**（`timeout` 回 124）——
 * 整堆线性 first-fit，加上长堆时那一大截 slack 没有块头，扫到零头 `bsz = 0`、
 * `p += bsz` 原地转圈。那一格在容器里的症状是「72M 的编译器跑 214s 不出 `--help`」，
 * 离病根隔着模拟器与二进制大小两层 —— 所以判据得摆在这儿，不能摆在那儿。
 *
 *   node tests/c/libc-malloc.js
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'libc', 'malloc_probe.c');
const WORK = join(HERE, '..', '..', '.omni-cache', 'work', 'libc-malloc');
const BIN = join(WORK, 'malloc_probe');

let pass = 0;
let fail = 0;
const ok = (what) => { pass++; process.stdout.write(`  ok   ${what}\n`); };
const bad = (what, why) => { fail++; process.stdout.write(`  FAIL ${what}\n    ${why}\n`); };

/* 这台机器上有没有 `cc`。没有就整条轴跳过（判据不该因为环境缺工具而变红）。 */
const probe = spawnSync('cc', ['--version'], { encoding: 'utf8' });
if (probe.status !== 0) {
  process.stdout.write('  skip 这台机器上没有 cc\n\n0 passed, 0 failed, 1 skipped\n');
  process.exit(0);
}

mkdirSync(WORK, { recursive: true });
rmSync(BIN, { force: true });
const cc = spawnSync('cc', ['-O1', '-w', '-o', BIN, SRC], { encoding: 'utf8' });
if (cc.status !== 0) bad('探子编得过', (cc.stderr || '').split('\n').slice(0, 3).join(' / '));
else ok('探子编得过');

if (existsSync(BIN)) {
  /* 20 秒够跑完 20 万块（本机量到 0.3s）；死循环那一版在这儿是 124。 */
  const run = spawnSync(BIN, [], { encoding: 'utf8', timeout: 20000 });
  const out = (run.stdout || '') + (run.stderr || '');
  if (run.signal !== null || run.status === null) {
    bad('20 秒之内跑完（不死循环）', `signal=${run.signal}，输出：${out.slice(0, 200)}`);
  } else ok('20 秒之内跑完（不死循环）');
  if (run.status === 0) ok('四格全过（不重叠 / 复用 / realloc / calloc）');
  else bad('四格全过', out.split('\n').filter((l) => l.includes('FAIL')).join(' / ') || out.slice(0, 200));
  for (const line of out.split('\n')) {
    if (line.startsWith('ok   ')) process.stdout.write(`       ${line.slice(5)}\n`);
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
