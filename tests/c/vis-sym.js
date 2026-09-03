// tests/c/vis-sym.js —— `__attribute__((visibility(…)))`：符号的 `st_other`
// （ADR-0017 第九刀第一百〇六片）
//
// 可见性不改绑定、不改地址、不改代码 —— 它落在 ELF 符号表那 24 个字节里的**第 6 个**
// （`st_other`，低两位是 STV_*）：DEFAULT 0、INTERNAL 1、HIDDEN 2、PROTECTED 3。
// `nm` 不印这一格，所以这个门自己解 symtab。
//
// 尺子是 `tcc -c`（它在所有目标上都写 ELF）。称两件事：
//   1. 每条符号的 `(名字, st_info, st_other)` 与 tcc 相同 —— 四种可见性、函数与数据各一份；
//   2. 认不出的名字（`visibility("weird")`）报错与 tcc 一字不差。
//
// Mach-O 那边**不落**这一格：tcc 自己的 `tccmacho.c` 也不消费可见性（`N_PEXT` 它没用），
// 所以我们跟着不写 —— 尺子是 tcc，不是 clang。
//
//   node tests/c/vis-sym.js

import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const TCC_DIR = join(root, '.omni-cache', 'tcc-build');
const TCC = join(TCC_DIR, 'tcc');
const CLI = join(root, 'stage0', 'src', 'cli.js');
const OUT = join(tmpdir(), 'omni-vissym');

const PROBE = '__attribute__((visibility("hidden"))) int h(int x) { return x + 1; }\n'
  + '__attribute__((visibility("default"))) int d(int x) { return x + 2; }\n'
  + '__attribute__((visibility("internal"))) int i(int x) { return x + 3; }\n'
  + '__attribute__((visibility("protected"))) int p(int x) { return x + 4; }\n'
  + '__attribute__((visibility("hidden"))) int hv = 5;\n'
  /* 两条声明各写一个：合并时取更严的那个（DEFAULT<PROTECTED<HIDDEN<INTERNAL）。 */
  + 'int both(void) __attribute__((visibility("protected")));\n'
  + 'int both(void) __attribute__((visibility("hidden")));\n'
  + 'int both(void) { return 6; }\n'
  + 'int plain(void) { return h(1) + d(2) + i(3) + p(4) + hv + both(); }\n';

const BAD = 'int f(void) __attribute__((visibility("weird")));\n'
  + 'int f(void) { return 1; }\n';

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

if (process.platform !== 'darwin' || !existsSync(TCC)) {
  process.stdout.write(`  skip 整组：尺子不在（${TCC}）\n`);
  process.exit(0);
}

/** ELF64 的符号表：每条 `[名字, st_info, st_other]`，按名字排序。 */
function elfSyms(path) {
  const b = readFileSync(path);
  const d = new DataView(b.buffer, b.byteOffset, b.length);
  const shoff = Number(d.getBigUint64(0x28, true));
  const shent = d.getUint16(0x3a, true);
  const shnum = d.getUint16(0x3c, true);
  let tab = null;
  for (let s = 0; s < shnum; s++) {
    const o = shoff + s * shent;
    if (d.getUint32(o + 4, true) !== 2) continue;    // SHT_SYMTAB
    tab = {
      off: Number(d.getBigUint64(o + 0x18, true)),
      size: Number(d.getBigUint64(o + 0x20, true)),
      link: d.getUint32(o + 0x28, true),
    };
  }
  if (tab === null) return null;
  const str = Number(d.getBigUint64(shoff + tab.link * shent + 0x18, true));
  const out = [];
  for (let k = 0; k < tab.size / 24; k++) {
    const s = tab.off + k * 24;
    let n = '';
    for (let q = str + d.getUint32(s, true); b[q] !== 0; q++) n += String.fromCharCode(b[q]);
    if (n === '') continue;
    out.push(`${n} info=${d.getUint8(s + 4)} other=${d.getUint8(s + 5)}`);
  }
  return out.sort().join('\n');
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const src = join(OUT, 'probe.c');
const badSrc = join(OUT, 'bad.c');
writeFileSync(src, PROBE);
writeFileSync(badSrc, BAD);

const refObj = join(OUT, 'ref.o');
const mineObj = join(OUT, 'mine.o');
const rc = spawnSync(TCC, ['-B', TCC_DIR, '-c', src, '-o', refObj], { encoding: 'utf8' });
const mc = spawnSync(process.execPath, [CLI, 'c-obj', src, '--format', 'elf', '-o', mineObj],
  { encoding: 'utf8', maxBuffer: 1 << 26 });

if (rc.status !== 0) {
  bad('尺子 tcc -c', `    ${(rc.stderr ?? '').trim().split('\n')[0]}`);
} else if (mc.status !== 0) {
  bad('我们的 c-obj', `    ${(mc.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
} else {
  const want = elfSyms(refObj);
  const got = elfSyms(mineObj);
  if (want !== got) {
    bad('每条符号的 st_info 与 st_other 与 tcc 相同',
      `    tcc :\n${(want ?? '').split('\n').map((l) => `      ${l}`).join('\n')}\n`
      + `    ours:\n${(got ?? '').split('\n').map((l) => `      ${l}`).join('\n')}`);
  } else {
    ok('四种可见性（含两条声明合并取更严的那个）落在 st_other 上，与 tcc 相同');
  }
}

const rb = spawnSync(TCC, ['-B', TCC_DIR, '-c', badSrc, '-o', join(OUT, 'bad-ref.o')],
  { encoding: 'utf8' });
const mb = spawnSync(process.execPath,
  [CLI, 'c-obj', badSrc, '--format', 'elf', '-o', join(OUT, 'bad-mine.o')],
  { encoding: 'utf8', maxBuffer: 1 << 26 });
const line = (s) => (s ?? '').trim().split('\n')[0].replace(/^.*bad\.c/, 'bad.c');
if (rb.status === 0 || mb.status === 0) {
  bad('认不出的可见性该拒', `    tcc status ${rb.status}、ours status ${mb.status}`);
} else if (line(rb.stderr) !== line(mb.stderr)) {
  bad('报错与 tcc 相同', `    tcc : ${line(rb.stderr)}\n    ours: ${line(mb.stderr)}`);
} else {
  ok(`认不出的可见性拒得与 tcc 一样（${line(mb.stderr)}）`);
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
