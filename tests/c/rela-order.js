// tests/c/rela-order.js —— 7 号往后那几节的次序就是**造出来的次序**
// （ADR-0017 第九刀第一百一十八片）
//
// ELF 的前六节 tcc 是写死的（`.text .data .rdata|.data.ro .bss .symtab .strtab`），
// 7 号往后那些**不排序**：谁先造谁在前。而「什么时候造」是编译走到哪儿决定的 ——
//
//   `.rela.data` 在第一条**数据**重定位落的时候造（初值里的地址，解析初值那一刻）
//   `.rela.text` 在第一条**代码**重定位发出来的时候造（某个函数体里）
//   `.pdata`     在**第一个函数收尾**那一步造（win32 的 x86_64，第一百一十七片）
//
// 于是同一份代码，把带地址的初值挪到函数前面还是后面，节的次序就不同。这一门用两个
// 探子把那一对情形都钉住，加上 `gen/05-global.c` 这份真源码：
//
//   pre  ——  `char *p = "hi";` 在所有函数之前  → `.rela.data` 排最前
//   post ——  同一句挪到第一个函数之后          → 排在 `.pdata`/`.rela.pdata` 之后
//
// 尺子是交叉 tcc 写出来的 `.o`：**问它节的名单**，一个字都不写死。
//
// 一件量过的、这一门不比的事：我们模块内的直接调用走标签、不发重定位，tcc 一律发。
// 于是「第一个函数里就有调用」那种源码，tcc 的 `.rela.text` 在最前、我们那儿根本没有
// 那一条。那是另一条轴（Path B），不是这一片的事。
//
//   node tests/c/rela-order.js

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'stage0', 'src', 'cli.js');
const CROSS = join(root, '.omni-cache', 'tcc-cross');
const OUT = join(tmpdir(), 'omni-rela-order');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

function tccSrc() {
  const mak = join(CROSS, 'config.mak');
  if (!existsSync(mak)) return null;
  const m = /^TOPSRC=(.*)$/m.exec(readFileSync(mak, 'utf8'));
  return m === null ? null : m[1].trim();
}

const SRC = tccSrc();
if (SRC === null) {
  process.stdout.write(`  skip 整组：交叉编译器还没建（${CROSS}）\n`);
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/** 一个 ELF 目标文件里 7 号往后、`.shstrtab` 之前那几节的名字。 */
function tailSections(path) {
  const b = readFileSync(path);
  const shoff = Number(b.readBigUInt64LE(0x28));
  const shnum = b.readUInt16LE(0x3c);
  const shstrndx = b.readUInt16LE(0x3e);
  const at = (i) => shoff + i * 64;
  const strOff = Number(b.readBigUInt64LE(at(shstrndx) + 24));
  const out = [];
  for (let i = 7; i < shnum - 1; i++) {
    const n = b.readUInt32LE(at(i));
    let e = strOff + n;
    while (b[e] !== 0) e++;
    out.push(b.toString('latin1', strOff + n, e));
  }
  return out;
}

const PRE = 'char *p = "hi";\nint f(void){return 1;}\nint main(void){return f()+p[0];}\n';
const POST = 'int f(void){return 1;}\nchar *p = "hi";\nint main(void){return f()+p[0];}\n';

const pre = join(OUT, 'pre.c');
const post = join(OUT, 'post.c');
writeFileSync(pre, PRE);
writeFileSync(post, POST);

const PROBES = [
  { name: 'pre（初值在所有函数之前）', src: pre },
  { name: 'post（初值挪到第一个函数之后）', src: post },
  { name: 'gen/05-global.c', src: join(root, 'tests', 'c', 'gen', '05-global.c') },
];

/* linux 那边 tcc 还多写 `.eh_frame` 与 `.rela.eh_frame`（ELF 上默认带展开表），
 * 我们那一节还欠着，所以这一门先不拿 linux 比 —— 那是下一片的事。 */
const CASES = [
  { name: 'x86_64-win32', tcc: 'x86_64-win32-tcc', arch: 'x86_64', os: 'win32', win32: true },
  { name: 'arm64-osx', tcc: 'arm64-osx-tcc', arch: 'arm64', os: 'osx', win32: false },
];

for (const t of CASES) {
  const tcc = join(CROSS, t.tcc);
  if (!existsSync(tcc)) {
    process.stdout.write(`  skip ${t.name}（${t.tcc} 没建）\n`);
    continue;
  }
  const B = t.win32 ? `-B${join(SRC, 'win32')}` : `-B${SRC}`;
  for (const p of PROBES) {
    const ro = join(OUT, 'ref.o');
    const r = spawnSync(tcc, [B, '-c', p.src, '-o', ro], { encoding: 'utf8' });
    if (r.status !== 0) {
      bad(`${t.name} ${p.name}`, `    尺子自己就拒了：${(r.stderr ?? '').trim().split('\n')[0]}`);
      continue;
    }
    const mo = join(OUT, 'our.o');
    const a = spawnSync(process.execPath,
      [CLI, 'c-obj', p.src, '--arch', t.arch, '--os', t.os, '--format', 'elf', '-o', mo],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (a.status !== 0) {
      bad(`${t.name} ${p.name}`, `    我们编不动：${(a.stderr ?? '').trim().split('\n')[0]}`);
      continue;
    }
    const want = tailSections(ro).join(' ');
    const got = tailSections(mo).join(' ');
    if (want !== got) {
      bad(`${t.name} ${p.name}`, `    tcc : ${want}\n    ours: ${got}`);
    } else ok(`${t.name} ${p.name}：${got}`);
  }
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
