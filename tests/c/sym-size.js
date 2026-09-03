// tests/c/sym-size.js —— 符号表里那一格 `st_size`
// （ADR-0017 第九刀第一百二十片）
//
// 我们的 `.o` 一直把 `st_size` 写成 0。tcc 两种符号都带着这一格：
//
//   函数 —— 它在 `.text` 里占多长（**这个函数的落点到下一个函数的落点**：win32 上
//           第一个函数后面那八字节的 `UNWIND_INFO` 也算在里头，量过 `f` 是 23+9=32）
//   全局量 —— 那个 C 类型有多少字节（`static const char s[] = "hi"` 是 3）
//
// 门比三件事：
//
//   1. 全局量那些名字的 `st_size` 与尺子**一个数不差** —— 那是 C 类型的大小，
//      与代码长短无关，所以必须相同
//   2. 全局量的**落点**也一个数不差：哪一节（`.data` / `.data.ro`（win32 `.rdata`）/
//      `.bss`）、节里第几个字节。第一百三十一片把 `.data` 的次序摆对，第一百三十二片
//      把没有初值的那些挪进 `.bss`，第一百三十三片把函数体里 `static` 的名字改成
//      tcc 写的那个（`n`，不是 `f.n.0`）—— 三笔都齐了这一条才能开。同名的局部符号
//      可以有两条（两个函数各一个 `static int n;`），所以按名字攒成多重集来比
//   3. 函数那些的 `st_size` 把 `.text` **铺满**（第 k 个的 `val + size` 正好是第 k+1 个的
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
const CLI = join(root, 'src', 'core', 'cli.js');
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
      al: Number(b.readBigUInt64LE(o + 48)),
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
      /* 落点要比「哪一节」而不是节号 —— 节的次序两边不必相同（`.rela.*` 是按造出来的
       * 次序插的）。号越界（`SHN_ABS` 那种）就记 `''`。 */
      sec: secs[b.readUInt16LE(o + 6)] === undefined ? '' : secs[b.readUInt16LE(o + 6)].name,
      value: Number(b.readBigUInt64LE(o + 8)),
      size: Number(b.readBigUInt64LE(o + 16)),
    });
  }
  return {
    syms,
    text: secs.find((s) => s.name === '.text').size,
    /* 节自己的两格（第一百三十二片）：多长、按几对齐。`sh_addralign` 是「里头对齐要求
     * 最大的那一块」，下界 8 —— 从前我们三节都写死 8。 */
    secs: new Map(secs.map((s) => [s.name, { size: s.size, al: s.al }])),
  };
}

const PROBE = `static const char s[] = "hi";
int g = 7;
long long big = 1;
char tab[40];
struct P { int a; char b; } p;
int arr[7] = {1};
struct Q { int x; } wide[2] __attribute__((aligned(16)));
char *lit = "hi";
int f(int a){ static int n = 5; static char pad[3]; return a+1+n+pad[0]; }
static int q(int a){ static int n; return a-1+n; }
int main(void){return s[0]+f(g)+q(arr[0])+tab[0]+p.a+(int)big+wide[0].x+lit[0];}
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

  /* 按名字攒成**多重集**：同一份 `.o` 里可以有两条同名的局部符号（两个函数各有一个
   * `static int n;`，第一百三十三片），所以一个名字底下是一串，比的时候两边各自排序。 */
  const group = (e, f) => {
    const m = new Map();
    for (const s of e.syms) {
      if (s.type !== 1) continue;
      if (!m.has(s.name)) m.set(s.name, []);
      m.get(s.name).push(f(s));
    }
    for (const v of m.values()) v.sort();
    return m;
  };
  const cmp = (what, f) => {
    const w = group(ref, f);
    const o = group(our, f);
    const ds = [];
    let cnt = 0;
    for (const [nm, want] of w) {
      const got = o.get(nm);
      /* tcc 那边有、我们那边没有的名字**是差错**；反过来不是（串常量那些符号
       * `L.3`/`omni_str_0` tcc 与我们各有各的名字）。 */
      if (got === undefined) { ds.push(`${nm}: tcc ${want.join(',')} / ours 没这个符号`); continue; }
      cnt += want.length;
      if (want.join('|') !== got.join('|')) {
        ds.push(`${nm}: tcc ${want.join(',')} / ours ${got.join(',')}`);
      }
    }
    if (cnt === 0) bad(`${t.name} ${what}`, '    一个对得上名字的都没有');
    else if (ds.length > 0) bad(`${t.name} ${what}`, `    ${ds.join('\n    ')}`);
    else ok(`${t.name}：${cnt} 个全局量的 ${what} 与尺子一个数不差`);
  };
  // 1. 全局量的大小
  cmp('st_size', (s) => `${s.size}`);
  /* 2. 全局量的落点：哪一节、节里第几个字节（第一百三十一、一百三十二片）。 */
  cmp('落点（哪一节、第几个字节）', (s) => `${s.sec}@${s.value}`);

  /* 3. 三节自己的两格（第一百三十二片）：多长、按几对齐。`.bss` 是 NOBITS ——
   * 有 `sh_size`、在文件里不占字节；三节的 `sh_addralign` 都是「里头对齐要求最大的
   * 那一块」，下界 8（`wide` 那个 `aligned(16)` 就是来顶这一格的）。 */
  const ROD = t.win32 ? '.rdata' : '.data.ro';
  const secDiffs = [];
  for (const nm of ['.data', ROD, '.bss']) {
    const w = ref.secs.get(nm);
    const o = our.secs.get(nm);
    if (w === undefined || o === undefined) { secDiffs.push(`${nm}: 有一边没有这一节`); continue; }
    if (w.size !== o.size || w.al !== o.al) {
      secDiffs.push(`${nm}: tcc ${w.size}/al${w.al} / ours ${o.size}/al${o.al}`);
    }
  }
  if (secDiffs.length > 0) bad(`${t.name} 数据三节的长度与对齐`, `    ${secDiffs.join('\n    ')}`);
  else ok(`${t.name}：.data / ${ROD} / .bss 三节的 sh_size 与 sh_addralign 都与尺子相同`);

  // 4. 函数的大小：把 `.text` 铺满
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
