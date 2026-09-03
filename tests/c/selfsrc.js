// tests/c/selfsrc.js —— 我们编出来的 tcc 去编 tinycc 的**全部**源码
// （ADR-0017 第九刀第九十九片）
//
// `selfobj.js` 的第 5 步只编 arm64-osx 那十二份。这一组把范围推到十二个目标的
// 每一套源码上：`tcc-targets.js` 里那张表一行行走，同一份 `.c` 换一套 `-D`
// 就是另一条路 —— i386/x86_64/arm/arm64/riscv64/c67 六个后端、`tccpe.c`、
// `tcccoff.c`、`tccmacho.c` 全在里头，加起来一百二十多个（文件，宏）组合。
//
// 两边都是**本机 arm64 的代码生成**（尺子是 `.omni-cache/tcc-build/tcc`，我们那份是
// 同一套源码编出来的），差别只在「谁编的 tcc」。所以这一组称的是：我们编出来的 tcc
// 在**读**这些源码时与真的 tcc 走同一条路 —— 输出逐字节相同。
//
//   node tests/c/selfsrc.js            # 十二套，约 60 秒
//   node tests/c/selfsrc.js c67 riscv  # 只跑名字对得上的

import { existsSync, mkdirSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { TCC_TARGETS, unitsOf } from './tcc-targets.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const TCC_DIR = join(root, '.omni-cache', 'tcc-build');
const TCC = join(TCC_DIR, 'tcc');
const CLI = join(root, 'src', 'core', 'cli.js');
const SRC = process.env.TINYCC_SRC ?? '/Users/wurui/Documents/Lang/reference/tinycc';
const OUT = join(tmpdir(), 'omni-selfsrc');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));

/* 我们那份 tcc 用 arm64-osx 那一套源码编（与 `selfobj.js` 第 1~2 步同一件事）。 */
const SELF = ['tcc', 'libtcc', 'tccpp', 'tccgen', 'tccdbg', 'tccelf', 'tccasm', 'tccrun',
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
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/* 版本行里那段 git 戳是建尺子时的 `-DTCC_GITHASH`（Makefile:267，只给 `tcc.o`），
 * 算不出来 —— 从尺子自己的版本行里读回来递进去（第九十二片量的）。 */
const refBanner = spawnSync(TCC, ['-v'], { encoding: 'utf8' }).stdout;
const m = /^tcc version \S+ (.*) \(/.exec(refBanner);
const gitDefs = m === null ? [] : [`-DTCC_GITHASH="${m[1]}"`];

// ---- 1. 先编出我们那份 tcc（clang 只管链，代码生成全是我们的）
let built = true;
for (const u of SELF) {
  const r = spawnSync(process.execPath,
    [CLI, 'c-obj', join(SRC, `${u}.c`), '-I', TCC_DIR, '-DONE_SOURCE=0',
      ...(u === 'tcc' ? gitDefs : []), '-o', join(OUT, `${u}.o`)],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    bad(`c-obj ${u}.c`, `    ${(r.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
    built = false;
  }
}
const exe = join(OUT, 'omni-tcc');
if (built) {
  const ln = spawnSync('clang', ['-o', exe, ...SELF.map((u) => join(OUT, `${u}.o`))],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (ln.status !== 0) {
    bad('clang -o omni-tcc *.o', `    ${(ln.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
    built = false;
  }
}
if (!built) {
  process.stdout.write('\n');
  for (const f of failures) process.stdout.write(`${f}\n`);
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(1);
}
chmodSync(exe, 0o755);
const v = spawnSync(exe, ['-v'], { encoding: 'utf8' });
if (v.stdout !== refBanner) {
  bad('omni-tcc -v', `    tcc : ${refBanner.trim()}\n    ours: ${(v.stdout ?? '').trim()}`);
} else {
  ok(`omni-tcc -v == tcc -v（${refBanner.trim()}）`);
}

// ---- 2. 十二套源码，一套一条：每份 `.c` 两边各编一次，逐字节比
const ro = join(OUT, 'ref.o');
const mo = join(OUT, 'mine.o');
let total = 0;
for (const t of TCC_TARGETS) {
  if (filters.length > 0 && !filters.some((x) => t.name.includes(x))) continue;
  const args = ['-B', TCC_DIR, '-I', TCC_DIR, '-DONE_SOURCE=0', ...t.defs];
  const diffs = [];
  let same = 0;
  for (const u of unitsOf(t)) {
    const f = join(SRC, `${u}.c`);
    const extra = u === 'tcc' ? gitDefs : [];
    if (spawnSync(TCC, [...args, ...extra, '-c', f, '-o', ro],
      { encoding: 'utf8' }).status !== 0) continue;      // 尺子自己就拒了：没有可比的
    const a = spawnSync(exe, [...args, ...extra, '-c', f, '-o', mo], { encoding: 'utf8' });
    if (a.status !== 0) {
      diffs.push(`    ${u}.c：我们拒了 —— ${(a.stderr ?? '').trim().split('\n')[0]}`);
      continue;
    }
    if (Buffer.compare(readFileSync(mo), readFileSync(ro)) === 0) same++;
    else diffs.push(`    ${u}.c：字节不同`);
  }
  total += same;
  if (diffs.length > 0) bad(`omni-tcc -c ${t.name} 那套源码 == tcc -c`, diffs.slice(0, 6).join('\n'));
  else ok(`${t.name}（${same} 份源码，逐字节相同）`);
}

rmSync(OUT, { recursive: true, force: true });

if (failures.length > 0) {
  process.stdout.write('\n');
  for (const f of failures) process.stdout.write(`${f}\n`);
}
process.stdout.write(`\n${pass} passed, ${fail} failed（一共比了 ${total} 个（文件，宏）组合）\n`);
process.exit(fail > 0 ? 1 : 0);
