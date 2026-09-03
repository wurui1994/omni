// tests/c/predefs.js —— 预定义宏那一整张表按目标分（ADR-0017 第九刀第一百二十九片）
//
// 第一百〇二片只把**目标 CPU 那三条**接到了 `--arch` 上，剩下的四十几条照 macho 写死。
// 这道门把整张表按 `(arch, os)` 逐行对着六个交叉 tcc 称一遍 —— 那是「每个目标自己的
// 预定义」这笔欠账的尺子，`L.N` 的起点、win32 的 `wchar_t` 都压在它后面。
//
// 量出来的（`tcc -dM -E` 六份一 diff）：
//
//   * 条数就不一样：osx 51、linux 44、win32 41（arm64-win32 40）
//   * `__arm64__` **只有 Mach-O 才有**（`arm64-gen.c:57` 那道 `#if defined(TCC_TARGET_MACHO)`）
//   * `__GNUC__ 4` 也只有 APPLE（与几个 BSD）—— linux 上一条都不定
//   * `__CHAR_UNSIGNED__` 只有 arm64-**linux**（`arm64-gen.c:41`：非 MACHO 非 PE）
//   * `__INT64_TYPE__` linux 上是 `long`，osx/win32 上是 `long long`（同宽，两个名字）
//   * win32 是 LLP64：`__SIZEOF_LONG__ 4`、`__LLP64__`、`__WCHAR_TYPE__ unsigned short`，
//     还多 `__declspec`/`__cdecl`，少 glibc 的 `__REDIRECT` 一族
//
// 比的是**逐行**，不是集合 —— tcc 的 `-dD`/`-dM` 印的是定义经过的次序（第一百〇八片），
// 差一格就对不上。第二组探针把 `-dD` 也称上：那一路除了预定义还要印源码里的
// `#define`/`#undef`，两半得一起对。
//
//   node tests/c/predefs.js [过滤串]

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CROSS = join(root, '.omni-cache', 'tcc-cross');
const CLI = join(root, 'src', 'core', 'cli.js');
const OUT = join(tmpdir(), 'omni-predefs');

/** tinycc 的源码在哪儿：从交叉编译目录的 `config.mak` 里读（`-B` 要用它）。 */
function tccSrc() {
  const mak = join(CROSS, 'config.mak');
  if (!existsSync(mak)) return null;
  const m = /^TOPSRC=(.*)$/m.exec(readFileSync(mak, 'utf8'));
  return m === null ? null : m[1].trim();
}

/* 六个 64 位目标。`-B` 在 win32 上要指到 `win32/`（那儿才有 PE 的那份 include）。 */
const TARGETS = [
  { name: 'arm64-osx', tcc: 'arm64-osx-tcc', arch: 'arm64', os: 'osx', win32: false },
  { name: 'x86_64-osx', tcc: 'x86_64-osx-tcc', arch: 'x86_64', os: 'osx', win32: false },
  { name: 'x86_64-linux', tcc: 'x86_64-tcc', arch: 'x86_64', os: 'linux', win32: false },
  { name: 'arm64-linux', tcc: 'arm64-tcc', arch: 'arm64', os: 'linux', win32: false },
  { name: 'x86_64-win32', tcc: 'x86_64-win32-tcc', arch: 'x86_64', os: 'win32', win32: true },
  { name: 'arm64-win32', tcc: 'arm64-win32-tcc', arch: 'arm64', os: 'win32', win32: true },
];

/* 两组探针。`-dM` 只印宏，`-dD` 连记号流一起 —— 后者把「源码里的 `#define` 排在
 * 预定义之后」这件事也称上。`-P` 一起给，行标那一格不是这道门要量的。 */
const PROBES = [
  { name: '-dM 整张表', src: 'int x;\n', args: ['-dM'] },
  {
    name: '-dD 预定义 + 源码里的 define/undef',
    src: '#define A 1\n#undef A\n#define B(x) x+1\nint y = B(2);\n',
    args: ['-dD', '-P'],
  },
];

const filters = process.argv.slice(2).filter((x) => !x.startsWith('-'));
const keep = (s) => filters.length === 0 || filters.some((f) => s.includes(f));

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

const SRC = tccSrc();
if (SRC === null) {
  process.stdout.write(`c/predefs: 没找到 ${CROSS}/config.mak —— 交叉编译器还没建，跳过\n`
    + '  mkdir -p .omni-cache/tcc-cross && cd .omni-cache/tcc-cross\n'
    + '  <tinycc>/configure --enable-cross && make -j8 cross\n');
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/** 头一处不同的行：回 `[行号, 尺子那行, 我们那行]`，一样就回 null。 */
function firstDiff(want, got) {
  const a = want.split('\n');
  const b = got.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return [i + 1, a[i] ?? '<没有了>', b[i] ?? '<没有了>'];
  }
  return null;
}

for (const t of TARGETS) {
  const tcc = join(CROSS, t.tcc);
  if (!existsSync(tcc)) {
    process.stdout.write(`  skip ${t.name}：尺子不在（${tcc}）\n`);
    continue;
  }
  const B = t.win32 ? join(SRC, 'win32') : SRC;
  for (const p of PROBES) {
    const label = `${t.name} ${p.name}`;
    if (!keep(label)) continue;
    const src = join(OUT, `${t.name}-${p.args[0].slice(1)}.c`);
    writeFileSync(src, p.src);

    const ref = spawnSync(tcc, [`-B${B}`, '-E', ...p.args, src], { encoding: 'utf8' });
    if (ref.status !== 0) {
      bad(`${label}: 尺子跑不动`, `    ${(ref.stderr ?? '').trim().split('\n')[0]}`);
      continue;
    }
    const mine = spawnSync(process.execPath,
      [CLI, 'cpp', src, ...p.args, '--arch', t.arch, '--os', t.os],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (mine.status !== 0) {
      bad(`${label}: 我们这边出错`,
        `    ${(mine.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
      continue;
    }
    const d = firstDiff(ref.stdout, mine.stdout);
    if (d !== null) {
      bad(`${label}: 与尺子逐行相同`,
        `    第 ${d[0]} 行\n    tcc : ${d[1]}\n    ours: ${d[2]}`);
      continue;
    }
    ok(`${label}：${ref.stdout.trimEnd().split('\n').length} 行一字不差`);
  }
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
