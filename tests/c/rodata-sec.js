// tests/c/rodata-sec.js —— 只读的全局量落进只读那一节
// （ADR-0017 第九刀第一百二十二片）
//
// tcc 那边这是 `tccgen.c:8401-8413` 的三行：
//
//     while ((tp->t & (VT_BTYPE|VT_ARRAY)) == (VT_PTR|VT_ARRAY)) tp = &tp->ref->type;
//     is_const = tp->t & VT_CONSTANT;
//     …
//     } else if (is_const) { sec = rodata_section; }
//
// 剥掉的只有**数组**那几层，剥完剩下的类型带 `const` 就进只读节。于是
//
//   * `const char s[] = "hi"`      -> 只读节（数组剥掉，`char` 上有 const）
//   * `const int ci = 7`           -> 只读节
//   * `const char *const cq = "q"` -> 只读节（**只读的指针**），哪怕初值要一条重定位
//                                     —— 于是多一张 `.rela.data.ro`
//   * `const char *cp = "cst"`     -> `.data`（指针自己不是 const）
//   * `char *p`、`int g`           -> `.data`
//
// 尺子是交叉编译器写出来的 `.o`：**问它每个符号在第几节**，而不是把节号写死在门里。
// 我们与它对不上的只剩串常量（tcc 把 `"lit"` 摆进只读节、名字是 `L.3`），所以这道门
// 只比**两边都有的那些名字**，串常量那一笔记在 ADR 的欠账里。
//
//   node tests/c/rodata-sec.js

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const CROSS = join(root, '.omni-cache', 'tcc-cross');
const OUT = join(tmpdir(), 'omni-rodata-sec');

let pass = 0;
let fail = 0;
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

/** 一个 ELF `.o` 拆成「节名表 + 符号表 + 每一节的字节」。 */
function readObj(path) {
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
  const st = secs.find((s) => s.name === '.symtab');
  const str = secs.find((s) => s.name === '.strtab');
  const syms = new Map();
  for (let o = st.off; o < st.off + st.size; o += 24) {
    const name = nameAt(str.off, b.readUInt32LE(o));
    if (name === '') continue;
    syms.set(name, {
      shndx: b.readUInt16LE(o + 6),
      value: Number(b.readBigUInt64LE(o + 8)),
      size: Number(b.readBigUInt64LE(o + 16)),
    });
  }
  const bytesOf = (name) => {
    const s = secs.find((x) => x.name === name);
    return s === undefined ? null : b.subarray(s.off, s.off + s.size);
  };
  return { names: secs.map((s) => s.name), syms, bytesOf };
}

const PROBES = [
  {
    name: '常量与可写混着摆',
    src: 'const char s[] = "hi";\nconst int ci = 7;\nchar *p = "lit";\nint g = 5;\n'
      + 'const char *cp = "cst";\nint main(void) { return s[0] + ci + p[0] + g + cp[0]; }\n',
    /* 两边都有的名字（串常量不比 —— tcc 叫 `L.3`，我们叫 `omni_str_0`）。 */
    look: ['s', 'ci', 'p', 'g', 'cp'],
    rela: false,
  },
  {
    name: '只读的指针（初值要一条重定位）',
    src: 'int g = 5;\nconst char *const cq = "q";\nconst int ci = 7;\n'
      + 'int main(void) { return cq[0] + ci + g; }\n',
    look: ['g', 'cq', 'ci'],
    rela: true,
  },
  {
    name: '一个 const 也没有',
    src: 'int g = 5;\nchar *p = "x";\nint main(void) { return g + p[0]; }\n',
    look: ['g', 'p'],
    rela: false,
  },
];

const CASES = [
  { name: 'x86_64-linux', tcc: 'x86_64-tcc', arch: 'x86_64', os: 'linux', rdata: '.data.ro', pre: '' },
  { name: 'x86_64-win32', tcc: 'x86_64-win32-tcc', arch: 'x86_64', os: 'win32', rdata: '.rdata', pre: '' },
  /* osx 的符号名前面有一条下划线（第一百二十一片）—— 两边都有，所以查表时都加上。 */
  { name: 'arm64-osx', tcc: 'arm64-osx-tcc', arch: 'arm64', os: 'osx', rdata: '.data.ro', pre: '_' },
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
    const c = join(OUT, `p${i}.c`);
    writeFileSync(c, pr.src);
    const ro = join(OUT, `ref-${t.name}-${i}.o`);
    /* 两边**同一串 argv**（ADR-0018 决策三）：只差一个 `-b`。 */
    const ARGS = [B, '-c', c];
    const r = spawnSync(tcc, [...ARGS, '-o', ro], { encoding: 'utf8' });
    if (r.status !== 0) {
      bad(tag, `    尺子自己就拒了：${(r.stderr ?? '').trim().split('\n')[0]}`);
      continue;
    }
    const mo = join(OUT, `our-${t.name}-${i}.o`);
    const a = spawnSync(process.execPath,
      [CLI, 'c', 'tcc', '-b', `${t.arch}-${t.os}`, ...ARGS, '-o', mo],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (a.status !== 0) {
      bad(tag, `    我们编不动：${(a.stderr ?? '').trim().split('\n')[0]}`);
      continue;
    }
    const want = readObj(ro);
    const got = readObj(mo);

    /* 一、每个名字在第几节。3 号是只读那一节、2 号是 `.data`。
     *     查不到就是这道门自己坏了（名字拼错、前缀忘了）—— 当场报，不许静悄悄
     *     两边都 `undefined` 地「过」。 */
    const missing = pr.look.filter((n) => want.syms.get(t.pre + n) === undefined
      || got.syms.get(t.pre + n) === undefined);
    if (missing.length > 0) {
      bad(`${tag} 的节号`, `    符号表里找不到：${missing.map((n) => t.pre + n).join(' ')}`);
    } else {
      const wsec = pr.look.map((n) => `${n}:${want.syms.get(t.pre + n).shndx}`).join(' ');
      const gsec = pr.look.map((n) => `${n}:${got.syms.get(t.pre + n).shndx}`).join(' ');
      if (wsec !== gsec) bad(`${tag} 的节号`, `    tcc : ${wsec}\n    ours: ${gsec}`);
      else ok(`${tag}：节号 ${gsec}`);
    }

    /* 二、只读那一节里那几样的字节。位置各家自己排（我们还没把串常量摆进去，
     *     所以偏移不一定一样），比的是「这个符号那一段的内容」。 */
    const wro = want.bytesOf(t.rdata);
    const gro = got.bytesOf(t.rdata);
    const diffs = [];
    let cmp = 0;
    for (const n of pr.look) {
      const ws = want.syms.get(t.pre + n);
      const gs = got.syms.get(t.pre + n);
      if (ws === undefined || gs === undefined || ws.shndx !== 3) continue;
      cmp++;
      const w = [...wro.subarray(ws.value, ws.value + ws.size)].join(' ');
      const g = [...gro.subarray(gs.value, gs.value + gs.size)].join(' ');
      /* 初值要重定位的那一格两边都是零（加数搬去了 `r_addend`），所以照样能比。 */
      if (w !== g) diffs.push(`    ${n}\n      tcc : ${w}\n      ours: ${g}`);
    }
    if (diffs.length > 0) bad(`${tag} 只读节里的字节`, diffs.join('\n'));
    else ok(`${tag}：只读节里那 ${cmp} 样的字节与尺子一样`);

    /* 三、只读节的重定位表：有没有、叫什么、在 7 号往后那一段的第几位。 */
    const rn = `.rela${t.rdata}`;
    const wHas = want.names.includes(rn);
    const gHas = got.names.includes(rn);
    if (wHas !== pr.rela) {
      bad(`${tag} 的 ${rn}`, `    尺子与这道门的预期不一致：tcc ${wHas ? '有' : '没有'}`);
    } else if (wHas !== gHas) {
      bad(`${tag} 的 ${rn}`, `    tcc ${wHas ? '有' : '没有'}，我们 ${gHas ? '有' : '没有'}`);
    } else if (wHas
      && want.names.indexOf(rn) !== got.names.indexOf(rn)) {
      bad(`${tag} 里 ${rn} 的位置`,
        `    tcc : ${want.names.join(' ')}\n    ours: ${got.names.join(' ')}`);
    } else ok(`${tag}：${rn} ${wHas ? `在第 ${got.names.indexOf(rn)} 节` : '一张也没有'}`);
  }
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
