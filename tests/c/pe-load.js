#!/usr/bin/env node
/* 「装了什么」与 tcc 一样（ADR-0017 第九刀第四十七片）。
 *
 * `tcc -vv` 链接时会把装进来的每个文件打成 `-> 路径`，把从静态库里拉出来的每个成员
 * 打成 `   -> 名字`。这一份就拿那几行当尺子：我们自己按 `pe_add_runtime` 挑入口符号、
 * 按 `tcc_add_library` 找库、按 `tcc_load_alacarte` 拉成员，然后与 tcc 的足迹逐条比。
 *
 * 这是链 PE 的第一半 —— 还不摆地址、不改重定位，只回答「该读哪些字节」。读错了文件，
 * 后面每一格都白算。
 *
 *   node tests/c/pe-load.js
 *   node tests/c/pe-load.js arm64
 */

import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { peLoad } from '../../stage0/src/link/pe_load.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CROSS = join(root, '.omni-cache', 'tcc-cross');

const TARGETS = [
  { name: 'x86_64-win32', tcc: 'x86_64-win32-tcc' },
  { name: 'arm64-win32', tcc: 'arm64-win32-tcc' },
  { name: 'i386-win32', tcc: 'i386-win32-tcc' },
];

const filters = process.argv.slice(2).filter((x) => !x.startsWith('-'));
const keep = (s) => filters.length === 0 || filters.some((f) => s.includes(f));

function tccSrc() {
  const mak = join(CROSS, 'config.mak');
  if (!existsSync(mak)) return null;
  const m = /^TOPSRC=(.*)$/m.exec(readFileSync(mak, 'utf8'));
  return m === null ? null : m[1].trim();
}

const src = tccSrc();
if (src === null) {
  process.stdout.write('c/pe-load: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

const SRC = join(here, 'gen');
const cases = readdirSync(SRC).filter((f) => f.endsWith('.c')).sort();

/** `-vv` 的足迹：`-> 路径` 是文件，`   -> 名字` 是从库里拉出来的成员。 */
function traceOf(out) {
  const trace = [];
  for (const line of out.split('\n')) {
    let m = /^ {3}-> (.*)$/.exec(line);
    if (m !== null) { trace.push({ kind: 'member', path: m[1].trim() }); continue; }
    m = /^-> (.*)$/.exec(line);
    if (m !== null) trace.push({ kind: 'file', path: m[1].trim() });
  }
  return trace;
}

const dir = mkdtempSync(join(tmpdir(), 'omni-peload-'));
let same = 0;
let diff = 0;
let memberTotal = 0;
try {
  for (const t of TARGETS) {
    if (!keep(t.name)) continue;
    const tcc = join(CROSS, t.tcc);
    if (!existsSync(tcc)) {
      process.stdout.write(`  skip ${t.name}（${t.tcc} 没建）\n`);
      continue;
    }
    const flags = [`-B${join(src, 'win32')}`, `-I${join(src, 'include')}`, `-L${CROSS}`];
    /* 库的搜索路径与 tcc 一样：命令行上的 `-L` 在前，`-B<…>/win32` 带出来的
     * `win32/lib` 在后。`.def` 只住在后一处，`libtcc1.a` 只住在前一处。 */
    const paths = [CROSS, join(src, 'win32', 'lib')];
    const open = (names) => {
      for (const p of paths) {
        for (const n of names) {
          const f = join(p, n);
          if (existsSync(f)) return { path: f, bytes: readFileSync(f) };
        }
      }
      return null;
    };
    let ok = 0;
    for (const c of cases) {
      const stem = `${t.name}-${basename(c, '.c')}`;
      const objPath = join(dir, `${stem}.o`);
      const one = spawnSync(tcc, [...flags, '-c', join(SRC, c), '-o', objPath], { encoding: 'utf8' });
      if (one.status !== 0 || !existsSync(objPath)) continue;
      const link = spawnSync(tcc, [...flags, '-vv', objPath, '-o', join(dir, `${stem}.exe`)], { encoding: 'utf8' });
      if (link.status !== 0) continue;
      const want = traceOf(link.stdout);
      let got;
      try {
        got = peLoad({
          objs: [{ path: objPath, bytes: readFileSync(objPath) }],
          libtcc1: `${t.name}-libtcc1.a`,
          open,
        }).trace;
      } catch (e) {
        diff++;
        if (diff <= 8) process.stdout.write(`  THROW ${t.name} ${c}：${e.message}\n`);
        continue;
      }
      const show = (x) => x.map((e) => (e.kind === 'member' ? `   -> ${e.path}` : `-> ${e.path}`)).join('\n');
      if (show(got) === show(want)) {
        same++;
        ok++;
        memberTotal += got.filter((e) => e.kind === 'member').length;
        continue;
      }
      diff++;
      if (diff <= 4) {
        process.stdout.write(`  DIFF ${t.name} ${c}\n    我们:\n${show(got)}\n    tcc:\n${show(want)}\n`);
      }
    }
    process.stdout.write(`  ${t.name}: ${ok} 条足迹相同\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 条相同, ${diff} 条不同（共拉出 ${memberTotal} 个成员）\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/pe-load: 装进来的文件与 tcc 不一样 —— pe_add_runtime 或按需取用差了一格\n');
  process.exitCode = 1;
}
