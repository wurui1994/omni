#!/usr/bin/env node
/* 我们的 **ELF 目标文件**交给 **tcc 自己的链接器**，链出来的东西真的跑
 * （ADR-0017 第九刀第三十八片）。
 *
 * 三把尺子的分工，到这一片是这样：
 *
 *   native-gen.js   我们出 Mach-O 的 `.o` -> **clang** 链 -> 跑，与 `tcc -run` 比输出
 *   这一份           我们出 ELF 的 `.o`    -> **tcc**   链 -> 跑，与 `tcc -run` 比输出
 *   tcc-obj.js      我们出 ELF 的 `.o`，与 `<target>-tcc -c` 出的目标文件比**字节**
 *
 * 为什么这一份值得单独存在：它是唯一一条**不经过 clang** 的能跑的路。tcc 的
 * `tcc_load_object_file` 会把我们写的节头、符号表、重定位全读一遍再自己重定位 ——
 * 一个字段填歪它就会说话，而 clang 那条腿根本看不见 ELF。换句话说，这一份同时验
 * 「ELF 写对了」与「码本来就对」两件事。
 *
 * 链接要用到 `libtcc1.a`（`__va_start` 那一族的辅助函数住在里头）。交叉编译出来的
 * 那些名字带前缀（`arm64-osx-libtcc1.a`），而 tcc 只找 `-B<dir>/libtcc1.a`，所以这儿
 * 现搭一个只有那一个文件的目录喂给 `-B`。
 *
 *   node tests/c/tcc-link.js
 *   node tests/c/tcc-link.js switch     # 只跑名字里带 switch 的
 */

import {
  readdirSync, existsSync, mkdtempSync, rmSync, mkdirSync, copyFileSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CROSS = join(root, '.omni-cache', 'tcc-cross');
const TCC_DIR = join(root, '.omni-cache', 'tcc-build');
const TCC = join(TCC_DIR, 'tcc');
const CLI = join(root, 'src', 'core', 'cli.js');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));

/** 能链上并且跑对的最少条数 —— 往下走就是回归（`native-gen.js` 那边同一条防线）。 */
const MIN_OK = 81;

/** 与 `native-gen.js` 同一份原因：这两条问不出同一个答案。 */
const SKIP = new Map([
  ['37-argv', 'argv[0] 两边本来就不同（tcc -run 传的是源文件路径）'],
  ['82-flex-init', '印的是两个全局之间的距离，C 不保证'],
]);

if (process.arch !== 'arm64' || process.platform !== 'darwin') {
  process.stdout.write(`c/tcc-link: 这一片只在 arm64 macOS 上跑（这台是 ${process.platform}/${process.arch}），跳过\n`);
  process.exit(0);
}
const CROSS_TCC = join(CROSS, 'arm64-osx-tcc');
const LIB1 = join(CROSS, 'arm64-osx-libtcc1.a');
if (!existsSync(CROSS_TCC) || !existsSync(LIB1)) {
  process.stdout.write('c/tcc-link: 没有交叉编译的 arm64-osx-tcc / libtcc1.a，跳过\n'
    + '  mkdir -p .omni-cache/tcc-cross && cd .omni-cache/tcc-cross\n'
    + '  <tinycc>/configure --enable-cross && make -j8 cross\n');
  process.exit(0);
}
if (!existsSync(TCC)) {
  process.stdout.write('c/tcc-link: 没有本机 tcc（oracle），跳过\n');
  process.exit(0);
}

const cases = readdirSync(join(here, 'gen')).filter((f) => f.endsWith('.c')).sort()
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)));

const dir = mkdtempSync(join(tmpdir(), 'omni-tcclink-'));
/* tcc 只认 `-B<dir>/libtcc1.a` 这个名字，所以现搭一个目录。 */
const B = join(dir, 'B');
mkdirSync(B);
copyFileSync(LIB1, join(B, 'libtcc1.a'));

let ok = 0;
let failed = 0;
const todos = [];
try {
  for (const f of cases) {
    const name = basename(f, '.c');
    const src = join(here, 'gen', f);
    const why = SKIP.get(name);
    if (why !== undefined) {
      process.stdout.write(`  skip ${name}（${why}）\n`);
      continue;
    }
    const objPath = join(dir, `${name}.o`);
    const obj = spawnSync(process.execPath,
      [CLI, 'c-obj', src, '-o', objPath, '--format', 'elf'], { encoding: 'utf8' });
    if (obj.status !== 0) {
      const line = (obj.stderr ?? '').trim().split('\n').find((l) => l.trim() !== '') ?? '?';
      todos.push(`${name}: ${line.slice(0, 120)}`);
      continue;
    }
    const progPath = join(dir, name);
    const link = spawnSync(CROSS_TCC, [`-B${B}`, objPath, '-o', progPath], { encoding: 'utf8' });
    if (link.status !== 0) {
      failed++;
      process.stdout.write(`  FAIL ${name}（tcc 链不上）\n    ${(link.stderr ?? '').trim()}\n`);
      continue;
    }
    const got = spawnSync(progPath, [], { encoding: 'utf8' });
    const want = spawnSync(TCC, ['-B', TCC_DIR, '-run', src], { encoding: 'utf8' });
    if (got.status !== want.status) {
      failed++;
      process.stdout.write(`  FAIL ${name}：退出码 tcc=${want.status} ours=${got.status}\n`);
      continue;
    }
    if ((got.stdout ?? '') !== (want.stdout ?? '')) {
      failed++;
      process.stdout.write(`  FAIL ${name}：stdout 不同\n    tcc  ${JSON.stringify(want.stdout)}\n`
        + `    ours ${JSON.stringify(got.stdout)}\n`);
      continue;
    }
    ok++;
    process.stdout.write(`  ok   ${name}\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n还没到（${todos.length} 条）：\n`);
for (const t of todos) process.stdout.write(`  - ${t}\n`);
process.stdout.write(`\n${ok} passed, ${failed} failed, ${todos.length} not yet\n`);
if (filters.length === 0 && ok < MIN_OK) {
  process.stdout.write(`c/tcc-link: 只跑通 ${ok} 条，少于 ${MIN_OK} —— 有回归\n`);
  process.exitCode = 1;
}
if (failed !== 0) process.exitCode = 1;
