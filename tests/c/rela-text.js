// tests/c/rela-text.js —— `.text` 里那几条重定位
// （ADR-0017 第九刀第一百二十七片）
//
// 量过 tcc（x86_64-linux，`static int a(void){…} int main(void){ return a(); }`）：
//
//   .text : … e8 00 00 00 00 …            位移是**四个零**
//   .rela.text: @30 R_X86_64_PLT32 sym=a add=-4
//
// 也就是说**模块内的直接调用也走符号** —— 哪怕被调的就在同一个 `.o` 里、哪怕它是
// 局部符号，tcc 也不在汇编那一层把位移算掉。我们从前算掉了，于是 `.rela.text` 一条
// 也没有（`.o` 的节表都比 tcc 少一节）。
//
// 这道门比的是**那几条重定位本身**（类型、指着谁、加数）与「位移那几个字节是零」，
// 不比 `r_offset` —— 我们出的代码比 tcc 长，落点对不上是另一回事（窥孔那几片）。
// 串常量的名字也不比：tcc 叫 `L.N`、我们叫 `omni_str_N`（第一百二十三片量过为什么）。
//
// 第一百二十八片起「模块内一条、模块外一条」那个探针也在这儿：外部函数不再发桩，
// 于是那三条重定位与尺子同数、同序（`4/one 2/<str> 4/strlen`）。
//
//   node tests/c/rela-text.js

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'stage0', 'src', 'cli.js');
const CROSS = join(root, '.omni-cache', 'tcc-cross');
const OUT = join(tmpdir(), 'omni-rela-text');

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

/**
 * 一个 ELF `.o` 的 `.rela.text`：按表里的次序，每条「类型/指着谁/加数」，
 * 外加那一条落点上的四个字节（`pcrel` 的位移，两边都该是零）。
 */
function readRelaText(path, pre) {
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
      link: b.readUInt32LE(at(i) + 40),
    });
  }
  const ra = secs.find((s) => s.name === '.rela.text');
  if (ra === undefined) return { rows: [], disp: [], has: false };
  const st = secs[ra.link];
  const str = secs.find((s) => s.name === '.strtab');
  const tx = secs.find((s) => s.name === '.text');
  const rows = [];
  const disp = [];
  for (let o = ra.off; o < ra.off + ra.size; o += 24) {
    const off = Number(b.readBigUInt64LE(o));
    const info = b.readBigUInt64LE(o + 8);
    const add = b.readBigInt64LE(o + 16);
    const type = Number(info & 0xffffffffn);
    let sym = nameAt(str.off, b.readUInt32LE(st.off + Number(info >> 32n) * 24));
    /* osx 上符号名前面有一个下划线 —— 比之前剥掉。 */
    if (pre !== '' && sym.startsWith(pre)) sym = sym.slice(pre.length);
    /* 串常量的名字不比：tcc 叫 `L.N`、我们叫 `omni_str_N`（那个编号是匿名符号计数器，
     * 压在「每个目标自己的预定义」那笔欠账后面，见第一百二十三片的测量）。 */
    if (/^L\.\d+$/.test(sym) || /^omni_str_\d+$/.test(sym)) sym = '<str>';
    rows.push(`${type}/${sym}/${add}`);
    disp.push([...b.subarray(tx.off + off, tx.off + off + 4)].join(' '));
  }
  return { rows, disp, has: true };
}

const PROBES = [
  {
    /* 量过的那一格：`static` 的被调者是**局部符号**，tcc 照样发重定位。 */
    name: '调同一个单元里的 static 函数',
    src: 'static int a(void) { return 1; }\nint main(void) { return a(); }\n',
  },
  {
    /* 非 static 的被调者（全局符号），而且**先调用后定义** —— 位移那一层压根没法算。 */
    name: '先调用后定义的全局函数',
    src: 'int later(int x);\nint main(void) { return later(2); }\n'
      + 'int later(int x) { return x + 1; }\n',
  },
  {
    /* 两条都打进同一个单元 —— 比的是两条重定位在表里的次序（按落点递增，也就是
     * 出代码的次序）。 */
    name: '模块内两条调用',
    src: 'static int one(void) { return 1; }\nstatic int two(void) { return 2; }\n'
      + 'int main(void) { return one() + two(); }\n',
  },
  {
    /* 两条调用，一条打进同一个单元、一条打进外面（`strlen`）—— 比的是两条的次序。
     * 第一百二十八片之前这一格是 `not yet`：外部函数的转发桩是个真函数，桩里那条
     * `call strlen` 反而排在最前，`.rela.text` 里多两条。桩去掉之后就是尺子那三条。 */
    name: '模块内一条、模块外一条',
    src: 'unsigned long strlen(const char *s);\n'
      + 'static int one(void) { return 1; }\n'
      + 'int main(void) { return one() + (int)strlen("ab"); }\n',
    /* arm64 上串常量的地址还不是同一条序列：tcc 是 `adrp` + **`ldr`**
     * （`311/312` = `ADR_PREL_PG_HI21`/`ADD_ABS_LO12_NC`，第三条指令是 `f9400000`），
     * 我们是 `adrp` + `add`（`275/277`，`91000000`）。那是「取数据地址那条序列」的事，
     * 不是调用这一片的 —— 量在这儿。 */
    notYet: { osx: 'arm64 上串常量的地址是 adrp+ldr，我们还发 adrp+add' },
  },
];

const CASES = [
  { name: 'x86_64-linux', tcc: 'x86_64-tcc', arch: 'x86_64', os: 'linux', pre: '' },
  { name: 'x86_64-win32', tcc: 'x86_64-win32-tcc', arch: 'x86_64', os: 'win32', pre: '' },
  { name: 'arm64-osx', tcc: 'arm64-osx-tcc', arch: 'arm64', os: 'osx', pre: '_' },
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
    /* 已经量过、还压在别的欠账后面的那一格照实报出来（不是绿的，也不是坏的）。 */
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
    const want = readRelaText(ro, t.pre);
    const got = readRelaText(mo, t.pre);

    /* 一、那一节在不在（从前我们压根没有它）。 */
    if (want.has !== got.has) {
      bad(`${tag} 的 .rela.text 有没有`, `    tcc : ${want.has}\n    ours: ${got.has}`);
      continue;
    }

    /* 二、那几条本身：类型、指着谁、加数，按表里的次序。 */
    if (want.rows.join(' ') !== got.rows.join(' ')) {
      bad(`${tag} 的重定位`,
        `    tcc : ${want.rows.join(' ')}\n    ours: ${got.rows.join(' ')}`);
    } else ok(`${tag}：${got.rows.length} 条重定位（类型/符号/加数）对得上`);

    /* 三、落点上那四个字节 —— 两边都该是零（位移交给链接器）。 */
    if (want.disp.join(' | ') !== got.disp.join(' | ')) {
      bad(`${tag} 落点上的位移`,
        `    tcc : ${want.disp.join(' | ')}\n    ours: ${got.disp.join(' | ')}`);
    } else ok(`${tag}：落点上的位移都是 ${got.disp[0] ?? '（没有）'}`);
  }
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed, ${notYet} not yet\n`);
process.exit(fail > 0 ? 1 : 0);
