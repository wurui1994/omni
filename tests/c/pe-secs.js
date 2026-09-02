#!/usr/bin/env node
/* 节表与 tcc 一样（ADR-0017 第九刀第四十八片）。
 *
 * `tcc -vv` 在写文件之前会把最终的节表打出来：
 *
 *     虚拟地址 文件偏移 长度 节名
 *       1000    400    a08  .text
 *
 * 那正是 `pe_assign_addresses` 的结果加上 `pe_write` 算出来的文件偏移。这一份就拿它当
 * 尺子：我们自己装文件（第四十七片）、并合、算导入桩与导入表、分类摆地址，然后逐条比。
 *
 * 一个字节都不用改重定位 —— 节表只与**长度**有关。所以这一步能单独对准。
 *
 *   node tests/c/pe-secs.js
 *   node tests/c/pe-secs.js arm64
 */

import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { peLoad } from '../../stage0/src/link/pe_load.js';
import { peSections } from '../../stage0/src/link/pe_sections.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CROSS = join(root, '.omni-cache', 'tcc-cross');

const TARGETS = [
  { name: 'x86_64-win32', tcc: 'x86_64-win32-tcc' },
  /* arm64-win32 的映像基址是 0x140000000，`DllCharacteristics` 还带 `DYNAMIC_BASE`，
   * 于是多一节 `.reloc` —— 这两件事 `peSections` 自己按目标定，不用告诉它。 */
  { name: 'arm64-win32', tcc: 'arm64-win32-tcc' },
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
  process.stdout.write('c/pe-secs: 交叉编译器还没建，跳过\n');
  process.exit(0);
}

const SRC = join(here, 'gen');
const cases = readdirSync(SRC).filter((f) => f.endsWith('.c')).sort();

/** `-vv` 打出来的那张表。 */
function tableOf(out) {
  const rows = [];
  for (const line of out.split('\n')) {
    const m = /^\s*([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+(\.\S+)$/.exec(line);
    if (m !== null) rows.push({ virt: parseInt(m[1], 16), file: parseInt(m[2], 16), size: parseInt(m[3], 16), name: m[4] });
  }
  return rows;
}

const show = (rows) => rows.map((r) => `${r.name} v${r.virt.toString(16)} f${r.file.toString(16)} s${r.size.toString(16)}`).join('\n      ');

const dir = mkdtempSync(join(tmpdir(), 'omni-pesecs-'));
let same = 0;
let diff = 0;
try {
  for (const t of TARGETS) {
    if (!keep(t.name)) continue;
    const tcc = join(CROSS, t.tcc);
    if (!existsSync(tcc)) {
      process.stdout.write(`  skip ${t.name}（${t.tcc} 没建）\n`);
      continue;
    }
    const flags = [`-B${join(src, 'win32')}`, `-I${join(src, 'include')}`, `-L${CROSS}`];
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
      const want = tableOf(link.stdout);
      if (want.length === 0) continue;
      let got;
      try {
        const obj = readFileSync(objPath);
        const loaded = peLoad({ objs: [{ path: objPath, bytes: obj }], libtcc1: `${t.name}-libtcc1.a`, open });
        const r = peSections({
          objs: [obj, ...loaded.members.map((m) => m.bytes)],
          dlls: loaded.dlls,
        });
        got = r.infos.map((i) => ({ name: i.name, virt: i.vaddr - r.imagebase, file: i.filePos, size: i.vsize }));
      } catch (e) {
        diff++;
        if (diff <= 6) process.stdout.write(`  THROW ${t.name} ${c}：${e.message}\n`);
        continue;
      }
      if (show(got) === show(want)) { same++; ok++; continue; }
      diff++;
      if (diff <= 4) {
        process.stdout.write(`  DIFF ${t.name} ${c}\n    我们:\n      ${show(got)}\n    tcc:\n      ${show(want)}\n`);
      }
    }
    process.stdout.write(`  ${t.name}: ${ok} 张节表相同\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${same} 条相同, ${diff} 条不同\n`);
if (diff !== 0 || same === 0) {
  process.stdout.write('c/pe-secs: 节表与 tcc 不一样 —— 分类、并节、导入桩或者文件偏移差了一格\n');
  process.exitCode = 1;
}
