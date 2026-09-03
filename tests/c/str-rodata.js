// tests/c/str-rodata.js —— 串常量摆进只读那一节
// （ADR-0017 第九刀第一百二十三片）
//
// 上一片把 `const` 的全局量摆进了只读节，尺子上还剩串常量这一样。量过 tcc
// （x86_64-linux，`char *a="A"; char *b="B"; …L"ab"…`）：
//
//   * 串常量落在 `.data.ro` 里（PE 上 `.rdata`），符号是**有名字的局部** `L.N`
//   * 每条按**元素的宽度**对齐：窄串 1、宽串 4 —— `L.3`@0、`L.4`@2、宽串 `L.5`@4
//   * `st_size` 是带结尾那一格的长度：窄串 `strlen+1`、宽串 `(n+1)*4`
//   * 节自己的 `sh_addralign` 还是 8
//
// 这道门比的是**字节与落点**，不比名字 —— 我们叫 `omni_str_N`，tcc 叫 `L.N`，
// 那个编号是 tcc 的匿名符号计数器走到那儿的值（`tccpp.c:626`：`L.%u`，
// `v - SYM_FIRST_ANOM`），是另一片的事。
//
// 第一百二十四片补上「不去重」这一格：同一个串写三遍，tcc 摆**三份**（量过 x86_64-linux
// 的 `char *a="A"; char *b="A"; … char *c="A";`：`.data.ro` 是 `65 0 65 0 65 0`，
// `L.3`@0+2、`L.4`@2+2、`L.5`@4+2）。串常量的身份是**它在源码里的那一处**，不是它的字节。
//
// 第一百二十五片补上「次序」这一格：只读节里 `const` 全局与串常量**按声明的次序交替**
// 摆（量过 `const int c1=11; char *a="A"; const int c2=22; char *b="B";`：
// `11 0 0 0 | 65 0 | 0 0 | 22 0 0 0 | 66 0`）。tcc 那边只读节就是一个按序推进的游标，
// 没有「先摆哪一类」这回事。
//
//   node tests/c/str-rodata.js

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'stage0', 'src', 'cli.js');
const CROSS = join(root, '.omni-cache', 'tcc-cross');
const OUT = join(tmpdir(), 'omni-str-rodata');

let pass = 0;
let fail = 0;
let notYet = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

/** tinycc 的源码在哪儿：交叉目录的 `config.mak` 里记着（`-B` 要用它）。 */
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

/** 一个 ELF `.o` 里只读那一节的字节、对齐，以及落在它里头的符号（按落点排）。 */
function readRo(path, roName) {
  const b = readFileSync(path);
  const shoff = Number(b.readBigUInt64LE(0x28));
  const shnum = b.readUInt16LE(0x3c);
  const shstrndx = b.readUInt16LE(0x3e);
  const at = (i) => shoff + i * 64;
  const nameAt = (base, n) => {
    let e = base + n;
    while (b[e] !== 0) e++;
    return b.toString('latin1', base + n, e);
  };
  const shstrOff = Number(b.readBigUInt64LE(at(shstrndx) + 24));
  const secs = [];
  for (let i = 0; i < shnum; i++) {
    secs.push({
      no: i,
      name: nameAt(shstrOff, b.readUInt32LE(at(i))),
      off: Number(b.readBigUInt64LE(at(i) + 24)),
      size: Number(b.readBigUInt64LE(at(i) + 32)),
      al: Number(b.readBigUInt64LE(at(i) + 48)),
    });
  }
  const ro = secs.find((s) => s.name === roName);
  const st = secs.find((s) => s.name === '.symtab');
  const str = secs.find((s) => s.name === '.strtab');
  const syms = [];
  for (let o = st.off; o < st.off + st.size; o += 24) {
    if (b.readUInt16LE(o + 6) !== ro.no) continue;
    syms.push({
      /* 名字只为了报错时看得懂 —— 比的是后面那两个数。 */
      name: nameAt(str.off, b.readUInt32LE(o)),
      value: Number(b.readBigUInt64LE(o + 8)),
      size: Number(b.readBigUInt64LE(o + 16)),
      /* `info` 的低四位是类型：1 是 STT_OBJECT。高四位是绑定：0 是 STB_LOCAL。 */
      info: b[o + 4],
    });
  }
  syms.sort((x, y) => x.value - y.value || x.size - y.size);
  return {
    al: ro.al,
    bytes: [...b.subarray(ro.off, ro.off + ro.size)].join(' '),
    syms,
  };
}

const PROBES = [
  {
    name: '两条窄串',
    src: 'char *a = "A";\nchar *b = "B";\nint main(void) { return a[0] + b[0]; }\n',
  },
  {
    name: '窄串夹一条宽串（按元素宽度对齐）',
    src: 'char *a = "A";\nchar *b = "B";\n'
      + 'int main(void) { const int *w = L"ab"; return a[0] + b[0] + w[0]; }\n',
    /* win32 的 `wchar_t` 是**两字节**（tcc 那边 `L"ab"` 在 `.rdata` 里占 6 字节），
     * 我们的宽串一律四字节 —— 那是另一笔目标事实，还没做。记在这儿，不是绕过去。 */
    notYet: { win32: 'win32 的 wchar_t 是 2 字节，我们的宽串还一律 4 字节' },
  },
  {
    name: '带转义字节的串',
    src: 'char *a = "\\xe4\\xb8\\x96";\nchar *b = "z";\nint main(void) { return a[0] + b[0]; }\n',
  },
  {
    name: '一条串也没有',
    src: 'int g = 5;\nint main(void) { return g; }\n',
  },
  {
    /* 不去重：同一个串三处，三份字节、三条符号。两处在文件作用域、一处在函数体里 ——
     * 函数体我们要走两遍（ADR-0017 偏差四），第二遍必须认回第一遍那一条，不能再摆一份。 */
    name: '同一个串写三遍（不去重）',
    src: 'char *a = "A";\nchar *b = "A";\n'
      + 'int main(void) { char *c = "A"; return a[0] + b[0] + c[0]; }\n',
  },
  {
    /* 两个函数体各一条串 —— 两遍解析各自从 0 数起，别让第二个函数的第一条串
     * 认到第一个函数那一条上去。 */
    name: '两个函数体各一条串',
    src: 'char *f(void) { return "fx"; }\nchar *g(void) { return "gy"; }\n'
      + 'int main(void) { return f()[0] + g()[0]; }\n',
  },
  {
    /* 第一百二十五片：只读节里 `const` 全局与串常量**按声明的次序交替**摆。
     * 量过 tcc：`11 0 0 0 | 65 0 | 0 0 | 22 0 0 0 | 66 0` —— `c2` 让到 8 是因为
     * `L.3` 之后游标在 6，`int` 要 4 对齐。 */
    name: 'const 全局与串常量交替（按声明的次序）',
    src: 'const int c1 = 11;\nchar *a = "A";\nconst int c2 = 22;\nchar *b = "B";\n'
      + 'int main(void) { return c1 + c2 + a[0] + b[0]; }\n',
  },
  {
    /* 带初值的 `const` 指针：那一块在**解析初值之前**就领了字节，所以它排在自己初值
     * 里那条串的前面（量过 tcc：`q`@0+8、`L.3`@8+2）。 */
    name: 'const 指针的初值里那条串排在它后面',
    src: 'const char *const q = "S";\nconst int c = 7;\nchar *p = "P";\n'
      + 'int main(void) { return c + q[0] + p[0]; }\n',
  },
];

const CASES = [
  { name: 'x86_64-linux', tcc: 'x86_64-tcc', arch: 'x86_64', os: 'linux', rdata: '.data.ro' },
  { name: 'x86_64-win32', tcc: 'x86_64-win32-tcc', arch: 'x86_64', os: 'win32', rdata: '.rdata' },
  { name: 'arm64-osx', tcc: 'arm64-osx-tcc', arch: 'arm64', os: 'osx', rdata: '.data.ro' },
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const t of CASES) {
  const tcc = join(CROSS, t.tcc);
  if (!existsSync(tcc)) {
    process.stdout.write(`  skip ${t.name}（${t.tcc} 没建）\n`);
    continue;
  }
  const B = t.os === 'win32' ? `-B${join(SRC, 'win32')}` : `-B${SRC}`;
  for (let i = 0; i < PROBES.length; i++) {
    const pr = PROBES[i];
    const tag = `${t.name} / ${pr.name}`;
    /* 已经量过、还没做的那几格照实报出来（不是绿的，也不是坏的）。 */
    const why = pr.notYet === undefined ? undefined : pr.notYet[t.os];
    if (why !== undefined) {
      notYet++;
      process.stdout.write(`  todo ${tag}：${why}\n`);
      continue;
    }
    const c = join(OUT, `p${i}.c`);
    writeFileSync(c, pr.src);
    const ro = join(OUT, `ref-${t.name}-${i}.o`);
    const r = spawnSync(tcc, [B, '-c', c, '-o', ro], { encoding: 'utf8' });
    if (r.status !== 0) {
      bad(tag, `    尺子自己就拒了：${(r.stderr ?? '').trim().split('\n')[0]}`);
      continue;
    }
    const mo = join(OUT, `our-${t.name}-${i}.o`);
    const a = spawnSync(process.execPath,
      [CLI, 'c-obj', c, '--arch', t.arch, '--os', t.os, '--format', 'elf', '-o', mo],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (a.status !== 0) {
      bad(tag, `    我们编不动：${(a.stderr ?? '').trim().split('\n')[0]}`);
      continue;
    }
    const want = readRo(ro, t.rdata);
    const got = readRo(mo, t.rdata);

    /* 一、那一节的字节 —— 逐字节。 */
    if (want.bytes !== got.bytes) {
      bad(`${tag} 的 ${t.rdata} 字节`, `    tcc : ${want.bytes}\n    ours: ${got.bytes}`);
    } else ok(`${tag}：${t.rdata} 逐字节相同（${want.bytes === '' ? 0 : got.bytes.split(' ').length} 字节）`);

    /* 二、落在那一节里的符号：落点与大小（名字不比 —— tcc 叫 `L.N`）。
     *     顺带把「局部的 STT_OBJECT」这一格也比上。 */
    const fmt = (ss) => ss.map((s) => `${s.value}+${s.size}/${s.info}`).join(' ');
    if (fmt(want.syms) !== fmt(got.syms)) {
      bad(`${tag} 里那几条符号`,
        `    tcc : ${want.syms.map((s) => `${s.name}@${s.value}+${s.size}/${s.info}`).join(' ')}\n`
        + `    ours: ${got.syms.map((s) => `${s.name}@${s.value}+${s.size}/${s.info}`).join(' ')}`);
    } else ok(`${tag}：${got.syms.length} 条符号的落点与大小对得上`);

    /* 三、节自己的对齐（量过是 8，不是每条串的对齐）。 */
    if (want.al !== got.al) {
      bad(`${tag} 的 sh_addralign`, `    tcc : ${want.al}\n    ours: ${got.al}`);
    } else ok(`${tag}：sh_addralign ${got.al}`);
  }
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed, ${notYet} not yet\n`);
process.exit(fail > 0 ? 1 : 0);
