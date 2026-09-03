// tests/c/wchar.js —— `wchar_t` 的宽度按目标走（ADR-0017 第九刀第一百三十片）
//
// tcc 那边这是编译期的两条，其实是一件事：`tcc.h:447-451` 的 `nwchar_t`（PE 上
// `unsigned short`，别处 `int`）定字节宽度，`tccgen.c:5667-5672` 那道
// `#ifdef TCC_TARGET_PE` 定宽串常量与 `L'x'` 的**类型**。量出来的（尺子是三个交叉 tcc）：
//
//   win32 : sizeof(L"ab") = 6、sizeof(L'x') = 2、`unsigned short a[] = L"ab"` 收得下
//   别的  : sizeof(L"ab") = 12、sizeof(L'x') = 4、`int a[] = L"ab"` 收得下
//
// 探针里的元素类型写 `__WCHAR_TYPE__` —— 那是第一百二十九片刚接对的预定义，
// 于是同一份源码在三个目标上各说各的类型，不必分三份写。
//
// 比的是 `.data`（`sizeof` 的值与铺开的那几格都落在这儿）与只读节的字节，加上落在
// 它们里头的符号的落点与大小。`L'\xffff'` 那种**没进探针**：量过，tcc 自己在静态
// 初始化式里就报 `constant expression expected`（两个目标都报），那不是这一格的事。
//
//   node tests/c/wchar.js [过滤串]

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CROSS = join(root, '.omni-cache', 'tcc-cross');
const CLI = join(root, 'src', 'core', 'cli.js');
const OUT = join(tmpdir(), 'omni-wchar');

/** tinycc 的源码在哪儿：从交叉编译目录的 `config.mak` 里读（`-B` 要用它）。 */
function tccSrc() {
  const mak = join(CROSS, 'config.mak');
  if (!existsSync(mak)) return null;
  const m = /^TOPSRC=(.*)$/m.exec(readFileSync(mak, 'utf8'));
  return m === null ? null : m[1].trim();
}

/** 一个 ELF `.o` 里某一节的字节，以及落在它里头的符号（按落点排）。 */
function readSec(path, name) {
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
    });
  }
  const sec = secs.find((s) => s.name === name);
  if (sec === undefined) return { bytes: '<没有这一节>', syms: [] };
  const st = secs.find((s) => s.name === '.symtab');
  const str = secs.find((s) => s.name === '.strtab');
  const syms = [];
  for (let o = st.off; o < st.off + st.size; o += 24) {
    if (b.readUInt16LE(o + 6) !== sec.no) continue;
    const raw = nameAt(str.off, b.readUInt32LE(o));
    /* 串常量的名字不比（tcc 叫 `L.N`、我们叫 `omni_str_N`，那是另一笔）。 */
    const isStr = /^_?L\.\d+$/.test(raw) || /^_?omni_str_\d+$/.test(raw);
    syms.push({
      name: isStr ? '<str>' : raw.replace(/^_/, ''),
      value: Number(b.readBigUInt64LE(o + 8)),
      size: Number(b.readBigUInt64LE(o + 16)),
    });
  }
  syms.sort((x, y) => x.value - y.value || x.size - y.size);
  return {
    bytes: [...b.subarray(sec.off, sec.off + sec.size)].join(' '),
    syms: syms.map((s) => `${s.name}@${s.value}+${s.size}`).join(' '),
  };
}

const TARGETS = [
  { name: 'x86_64-linux', tcc: 'x86_64-tcc', arch: 'x86_64', os: 'linux', ro: '.data.ro', win32: false },
  { name: 'x86_64-win32', tcc: 'x86_64-win32-tcc', arch: 'x86_64', os: 'win32', ro: '.rdata', win32: true },
  { name: 'arm64-osx', tcc: 'arm64-osx-tcc', arch: 'arm64', os: 'osx', ro: '.data.ro', win32: false },
];

const PROBES = [
  {
    /* `sizeof` 那三个数就是这一格的全部：宽串一格几字节、`L'x'` 是什么类型、
     * 一个元素多宽。三个数落在 `.data` 里，逐字节比。 */
    name: 'sizeof 宽串 / 宽字符 / 一个元素',
    src: 'int z = sizeof(L"ab");\nint w = sizeof(L\'x\');\nint e = sizeof(L"ab"[0]);\n',
  },
  {
    /* 铺进 `wchar_t` 数组：元素类型对不上的话 tcc 会当成「指针赋给整数」而不是
     * 「字符串铺开」—— 那时字节数与符号大小都会差。 */
    name: '铺进 wchar_t 数组（大小从初值来）',
    src: '__WCHAR_TYPE__ a[] = L"ab";\nint m = sizeof(a);\nint e = sizeof(a[0]);\n',
  },
  {
    /* 给定长度：装不下的那个结尾 0 可以丢，多出来的补零。 */
    name: '铺进定长的 wchar_t 数组',
    src: '__WCHAR_TYPE__ a[2] = L"ab";\n__WCHAR_TYPE__ b[5] = L"ab";\n',
  },
  {
    /* 相邻的宽串要拼起来（C11 6.4.5 第 5 段），拼完还是一格一个 `wchar_t`。 */
    name: '相邻的宽串拼起来',
    src: '__WCHAR_TYPE__ a[] = L"ab" L"cd";\nint m = sizeof(a);\n',
  },
  {
    /* 指针指着只读节里那一块：那一块的对齐与大小按 `wchar_t` 走。
     *
     * `sizeof(*p)` 顺带量出**另一笔**（第一百三十一片补的）：它借表达式那一路解析，
     * 于是 `p` 在 `n` 之前就领到了 MIR 的全局号 —— 而从前 `.data` 的字节是按**全局号**
     * 铺的，不是按声明的次序（tcc `n@0 p@8 m@16`，我们那时是 `p@0 n@8 m@16`）。 */
    name: '指向宽串的指针（只读节里那一块）',
    src: 'char *n = "z";\n__WCHAR_TYPE__ *p = L"ab";\nint m = sizeof(*p);\n',
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
  process.stdout.write(`c/wchar: 没找到 ${CROSS}/config.mak —— 交叉编译器还没建，跳过\n`);
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const t of TARGETS) {
  const tcc = join(CROSS, t.tcc);
  if (!existsSync(tcc)) {
    process.stdout.write(`  skip ${t.name}：尺子不在（${tcc}）\n`);
    continue;
  }
  const B = t.win32 ? join(SRC, 'win32') : SRC;
  for (let pi = 0; pi < PROBES.length; pi++) {
    const p = PROBES[pi];
    const label = `${t.name} / ${p.name}`;
    if (!keep(label)) continue;
    const src = join(OUT, `p${pi}.c`);
    writeFileSync(src, p.src);
    const refObj = join(OUT, `ref-${t.name}-${pi}.o`);
    const myObj = join(OUT, `my-${t.name}-${pi}.o`);

    const rl = spawnSync(tcc, [`-B${B}`, '-c', src, '-o', refObj], { encoding: 'utf8' });
    if (rl.status !== 0) {
      bad(`${label}: 尺子编不出来`, `    ${(rl.stderr ?? '').trim().split('\n')[0]}`);
      continue;
    }
    const co = spawnSync(process.execPath,
      [CLI, 'c-obj', src, '--arch', t.arch, '--os', t.os, '--format', 'elf', '-o', myObj],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (co.status !== 0) {
      bad(`${label}: c-obj`,
        `    ${(co.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
      continue;
    }

    for (const sec of ['.data', t.ro]) {
      const want = readSec(refObj, sec);
      const got = readSec(myObj, sec);
      if (want.bytes !== got.bytes) {
        bad(`${label}: ${sec} 逐字节相同`, `    tcc : ${want.bytes}\n    ours: ${got.bytes}`);
        continue;
      }
      if (want.syms !== got.syms) {
        bad(`${label}: ${sec} 里那几条符号的落点与大小`,
          `    tcc : ${want.syms}\n    ours: ${got.syms}`);
        continue;
      }
      ok(`${label}：${sec} 逐字节相同（${want.bytes === '' ? 0 : want.bytes.split(' ').length} 字节）`);
    }
  }
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
