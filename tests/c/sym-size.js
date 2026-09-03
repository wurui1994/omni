// tests/c/sym-size.js —— 符号表里那一格 `st_size`
// （ADR-0017 第九刀第一百二十片）
//
// 我们的 `.o` 一直把 `st_size` 写成 0。tcc 两种符号都带着这一格：
//
//   函数 —— 它在 `.text` 里占多长（**这个函数的落点到下一个函数的落点**：win32 上
//           第一个函数后面那八字节的 `UNWIND_INFO` 也算在里头，量过 `f` 是 23+9=32）
//   全局量 —— 那个 C 类型有多少字节（`static const char s[] = "hi"` 是 3）
//
// 门比两件事：
//
//   1. 全局量那些名字的 `st_size` 与尺子**一个数不差** —— 那是 C 类型的大小，
//      与代码长短无关，所以必须相同（数据段的**落点**我们还与 tcc 不同，那是另一笔债）
//   2. 函数那些的 `st_size` 把 `.text` **铺满**（第 k 个的 `val + size` 正好是第 k+1 个的
//      `val`，最后一个到节尾）—— 我们的代码比 tcc 的长，所以只能查这条不变量
//
//   node tests/c/sym-size.js

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'stage0', 'src', 'cli.js');
const CROSS = join(root, '.omni-cache', 'tcc-cross');
const OUT = join(tmpdir(), 'omni-sym-size');

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

/** 一个 ELF 目标文件里的符号：`[{name, type, shndx, value, size}]`，外加 `.text` 多大。 */
function readSyms(path) {
  const b = readFileSync(path);
  const shoff = Number(b.readBigUInt64LE(0x28));
  const shnum = b.readUInt16LE(0x3c);
  const shstrndx = b.readUInt16LE(0x3e);
  const at = (i) => shoff + i * 64;
  const strOff = Number(b.readBigUInt64LE(at(shstrndx) + 24));
  const nameAt = (base, n) => {
    let e = base + n;
    while (b[e] !== 0) e++;
    return b.toString('latin1', base + n, e);
  };
  const secs = [];
  for (let i = 0; i < shnum; i++) {
    const o = at(i);
    secs.push({
      name: nameAt(strOff, b.readUInt32LE(o)),
      off: Number(b.readBigUInt64LE(o + 24)),
      size: Number(b.readBigUInt64LE(o + 32)),
      link: b.readUInt32LE(o + 40),
    });
  }
  const st = secs.find((s) => s.name === '.symtab');
  const strtab = secs[st.link];
  const syms = [];
  for (let k = 0; k * 24 < st.size; k++) {
    const o = st.off + k * 24;
    syms.push({
      name: nameAt(strtab.off, b.readUInt32LE(o)),
      type: b[o + 4] % 16,
      shndx: b.readUInt16LE(o + 6),
      value: Number(b.readBigUInt64LE(o + 8)),
      size: Number(b.readBigUInt64LE(o + 16)),
    });
  }
  return { syms, text: secs.find((s) => s.name === '.text').size };
}

const PROBE = `static const char s[] = "hi";
int g = 7;
long long big = 1;
char tab[40];
struct P { int a; char b; } p;
int arr[7] = {1};
int f(int a){return a+1;}
static int q(int a){return a-1;}
int main(void){return s[0]+f(g)+q(arr[0])+tab[0]+p.a+(int)big;}
`;

const c = join(OUT, 'a.c');
writeFileSync(c, PROBE);

/* 三个目标一起量。符号名的前缀跟着目标走：只有 osx 加那条下划线
 * （第一百二十一片量过 —— `libtcc.c:895-898` 里 PE 那一支是注释掉的）。 */
const CASES = [
  { name: 'x86_64-linux', tcc: 'x86_64-tcc', arch: 'x86_64', os: 'linux', win32: false },
  { name: 'arm64-osx', tcc: 'arm64-osx-tcc', arch: 'arm64', os: 'osx', win32: false },
  { name: 'x86_64-win32', tcc: 'x86_64-win32-tcc', arch: 'x86_64', os: 'win32', win32: true },
];

for (const t of CASES) {
  const tcc = join(CROSS, t.tcc);
  if (!existsSync(tcc)) {
    process.stdout.write(`  skip ${t.name}（${t.tcc} 没建）\n`);
    continue;
  }
  const B = t.win32 ? `-B${join(SRC, 'win32')}` : `-B${SRC}`;
  const ro = join(OUT, 'ref.o');
  const r = spawnSync(tcc, [B, '-c', c, '-o', ro], { encoding: 'utf8' });
  if (r.status !== 0) {
    bad(t.name, `    尺子自己就拒了：${(r.stderr ?? '').trim().split('\n')[0]}`);
    continue;
  }
  const mo = join(OUT, 'our.o');
  const a = spawnSync(process.execPath,
    [CLI, 'c-obj', c, '--arch', t.arch, '--os', t.os, '--format', 'elf', '-o', mo],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (a.status !== 0) {
    bad(t.name, `    我们编不动：${(a.stderr ?? '').trim().split('\n')[0]}`);
    continue;
  }
  const ref = readSyms(ro);
  const our = readSyms(mo);

  // 1. 全局量的大小：一个数不差
  const want = new Map();
  for (const s of ref.syms) if (s.type === 1) want.set(s.name, s.size);
  const diffs = [];
  let n = 0;
  for (const s of our.syms) {
    if (s.type !== 1) continue;
    const w = want.get(s.name);
    if (w === undefined) continue;   // 串常量那些符号 tcc 那边根本没有
    n++;
    if (w !== s.size) diffs.push(`${s.name}: tcc ${w} / ours ${s.size}`);
  }
  if (n === 0) bad(`${t.name} 全局量的 st_size`, '    一个对得上名字的都没有');
  else if (diffs.length > 0) bad(`${t.name} 全局量的 st_size`, `    ${diffs.join('\n    ')}`);
  else ok(`${t.name}：${n} 个全局量的 st_size 与尺子一个数不差`);

  // 2. 函数的大小：把 `.text` 铺满
  const check = (e, who) => {
    const fs2 = e.syms.filter((s) => s.type === 2).sort((x, y) => x.value - y.value);
    if (fs2.length === 0) return `${who} 一个函数符号都没有`;
    for (let k = 0; k < fs2.length; k++) {
      const end = k + 1 < fs2.length ? fs2[k + 1].value : e.text;
      if (fs2[k].value + fs2[k].size !== end) {
        return `${who} ${fs2[k].name}：${fs2[k].value}+${fs2[k].size} != ${end}`;
      }
    }
    return null;
  };
  const why = check(ref, 'tcc') ?? check(our, 'ours');
  if (why !== null) bad(`${t.name} 函数的 st_size`, `    ${why}`);
  else {
    const nf = our.syms.filter((s) => s.type === 2).length;
    ok(`${t.name}：${nf} 个函数的 st_size 把 .text 的 ${our.text} 个字节铺满`);
  }
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
