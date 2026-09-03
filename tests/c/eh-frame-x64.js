// tests/c/eh-frame-x64.js —— linux 目标的 `.o` 里那张 DWARF 展开表
// （ADR-0017 第九刀第一百一十九片）
//
// tcc 在 **ELF 这个输出格式**上默认带展开表（`unwind_tables`，`libtcc.c:887`；
// `tccelf.c:92-94` 又把非 ELF 的输出格式那一格关掉），于是 linux 目标的 `.o` 里多两节：
// `.eh_frame` 与 `.rela.eh_frame`。这与 win32 的 `.pdata`（第一百一十七片）是同一件事
// 的两种写法 —— 那边是查表，这边是 DWARF 的 CFI。
//
// 结构（`tccdbg.c` 的 `tcc_eh_frame_start` / `tcc_debug_frame_end` / `tcc_eh_frame_end`）：
//
//   CIE          24 字节，一份
//   FDE * n      每个函数 36 字节（每一格都定长，所以长度都一样）
//   00000000     收尾那四个零字节
//
// 一个 FDE 里只有三个数跟函数走：`PC Begin`（挂一条 PC32）、`PC Range`、还有
// `DW_CFA_advance_loc4` 那一格的 `size - 5`。门于是把那三个数**挖掉**再逐字节比 ——
// 我们的代码还比 tcc 的长，那三个数不可能一样，别的一个字节都不该差。
//
//   node tests/c/eh-frame-x64.js

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const CROSS = join(root, '.omni-cache', 'tcc-cross');
const OUT = join(tmpdir(), 'omni-eh-frame');

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
const LTCC = join(CROSS, 'x86_64-tcc');
if (SRC === null || !existsSync(LTCC)) {
  process.stdout.write(`  skip 整组：x86_64-linux 的交叉编译器还没建（${CROSS}）\n`);
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

function readElf(path) {
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
      info: b.readUInt32LE(o + 44),
      al: Number(b.readBigUInt64LE(o + 48)),
    });
  }
  const sec = (n) => secs.find((s) => s.name === n);
  const st = sec('.symtab');
  const syms = [];
  for (let k = 0; k * 24 < st.size; k++) {
    const o = st.off + k * 24;
    syms.push({ info: b[o + 4], shndx: b.readUInt16LE(o + 6) });
  }
  return { bytes: b, names: secs.map((s) => s.name), secs, sec, syms, shInfo: st.info };
}

function relas(e, name) {
  const s = e.sec(name);
  if (s === undefined) return [];
  const out = [];
  for (let k = 0; k * 24 < s.size; k++) {
    const o = s.off + k * 24;
    out.push({
      at: Number(e.bytes.readBigUInt64LE(o)),
      type: e.bytes.readUInt32LE(o + 8),
      sym: e.bytes.readUInt32LE(o + 12),
      add: Number(e.bytes.readBigInt64LE(o + 16)),
    });
  }
  return out;
}

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

/** 把每个 FDE 里跟函数走的那三个数挖成 `..`，剩下的该逐字节相同。 */
function maskEh(buf) {
  const b = Buffer.from(buf);
  for (let at = 24; at + 36 <= b.length - 4; at += 36) {
    b.fill(0, at + 8, at + 16);    // PC Begin / PC Range
    b.fill(0, at + 26, at + 30);   // advance_loc4 的那四个字节
  }
  return b;
}

const PROBE = 'int f(int a){return a+1;}\nint main(void){return f(1);}\n';
const c = join(OUT, 'a.c');
writeFileSync(c, PROBE);

const ro = join(OUT, 'ref.o');
/* 两边**同一串 argv**（ADR-0018 决策三）：只差一个 `-b`。 */
const ARGS = [`-B${SRC}`, '-c', c];
const r = spawnSync(LTCC, [...ARGS, '-o', ro], { encoding: 'utf8' });
if (r.status !== 0) {
  bad('尺子', `    自己就拒了：${(r.stderr ?? '').trim().split('\n')[0]}`);
} else {
  const mo = join(OUT, 'our.o');
  const a = spawnSync(process.execPath,
    [CLI, 'c', 'tcc', '-b', 'x86_64-linux', ...ARGS, '-o', mo],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (a.status !== 0) {
    bad('我们', `    编不动：${(a.stderr ?? '').trim().split('\n')[0]}`);
  } else {
    const ref = readElf(ro);
    const our = readElf(mo);

    // 1. `.eh_frame` 紧跟着 `.rela.eh_frame`，而且是 7 号往后的第一节
    const shape = (e) => {
      const i = e.names.indexOf('.eh_frame');
      return `${i}/${e.names[i + 1]}`;
    };
    if (shape(ref) !== shape(our)) {
      bad('两节的位置', `    tcc : ${shape(ref)}\n    ours: ${shape(our)}`);
    } else ok(`.eh_frame 在 ${our.names.indexOf('.eh_frame')} 号、后面紧跟着 .rela.eh_frame`);

    // 2. 节头那几格：大小、对齐、`sh_link`/`sh_info`
    const rs = ref.sec('.eh_frame');
    const os2 = our.sec('.eh_frame');
    const rr = ref.sec('.rela.eh_frame');
    const orr = our.sec('.rela.eh_frame');
    const nf = (rs.size - 28) / 36;
    const g = (s, rel, e) => `${s.size}/${s.al}/${rel.al}/${e.names[rel.info] ?? '?'}`;
    if (os2 === undefined || orr === undefined) bad('.eh_frame', '    我们一节也没写');
    else if (g(rs, rr, ref) !== g(os2, orr, our)) {
      bad('节头那几格', `    tcc : ${g(rs, rr, ref)}\n    ours: ${g(os2, orr, our)}`);
    } else ok(`.eh_frame ${os2.size} 字节（CIE 24 + FDE 36×${nf} + 收尾 4）、对齐 ${os2.al}`);

    // 3. 挖掉那三个数之后逐字节相同
    const rb = maskEh(ref.bytes.subarray(rs.off, rs.off + rs.size));
    const ob = maskEh(our.bytes.subarray(os2.off, os2.off + os2.size));
    if (Buffer.compare(rb, ob) !== 0) {
      bad('.eh_frame 的字节', `    tcc : ${hex(rb)}\n    ours: ${hex(ob)}`);
    } else ok('.eh_frame 挖掉「PC Begin / PC Range / size-5」之后逐字节相同');

    // 4. 那三个数与我们自己的函数对得上
    const fdes = [];
    for (let at = 24; at + 36 <= os2.size - 4; at += 36) {
      fdes.push({
        begin: our.bytes.readUInt32LE(os2.off + at + 8),
        range: our.bytes.readUInt32LE(os2.off + at + 12),
        adv: our.bytes.readUInt32LE(os2.off + at + 26),
      });
    }
    const text = our.sec('.text');
    let why = null;
    for (let k = 0; k < fdes.length; k++) {
      const end = k + 1 < fdes.length ? fdes[k + 1].begin : text.size;
      if (fdes[k].begin + fdes[k].range !== end) why = `第 ${k} 条：${fdes[k].begin}+${fdes[k].range} != ${end}`;
      if (fdes[k].adv !== fdes[k].range - 5) why = `第 ${k} 条的 advance_loc4 ${fdes[k].adv} != ${fdes[k].range - 5}`;
    }
    if (why !== null) bad('FDE 里那三个数', `    ${why}`);
    else ok(`${fdes.length} 条 FDE 把 .text 的 ${text.size} 个字节铺满，advance_loc4 都是 size-5`);

    // 5. 重定位与那几条节符号
    const re = relas(ref, '.rela.eh_frame');
    const oe = relas(our, '.rela.eh_frame');
    const rt = (e, xs) => xs.map((x) => `${(x.at - 32) % 36}:${e.syms[x.sym].info}/${e.syms[x.sym].shndx}/${x.type}/${x.add}`).join(' ');
    if (re.length !== oe.length || rt(ref, re) !== rt(our, oe)) {
      bad('.rela.eh_frame', `    tcc : ${re.length} 条 ${rt(ref, re)}\n    ours: ${oe.length} 条 ${rt(our, oe)}`);
    } else ok(`.rela.eh_frame ${oe.length} 条，每个 FDE 的 PC Begin 一条、挂在一条 STT_SECTION 上`);

    const nsect = (e) => e.syms.filter((s) => s.info === 3).length;
    if (nsect(ref) !== nsect(our) || ref.shInfo !== our.shInfo) {
      bad('节符号', `    tcc : ${nsect(ref)} 条，sh_info ${ref.shInfo}\n    ours: ${nsect(our)} 条，sh_info ${our.shInfo}`);
    } else ok(`符号表里 ${nsect(our)} 条 STT_SECTION（每个 FDE 一条），sh_info ${our.shInfo}`);
  }
}

/* 反面那两条：osx 与 win32 上一节也不多 —— 那是输出格式的事实。 */
for (const t of [{ name: 'arm64-osx', arch: 'arm64', os: 'osx' },
  { name: 'x86_64-win32', arch: 'x86_64', os: 'win32' }]) {
  const mo = join(OUT, `${t.name}.o`);
  const a = spawnSync(process.execPath,
    [CLI, 'c-obj', c, '--arch', t.arch, '--os', t.os, '--format', 'elf', '-o', mo],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (a.status !== 0) bad(`${t.name} 上不该有 .eh_frame`, `    编不动：${(a.stderr ?? '').trim().split('\n')[0]}`);
  else {
    const e = readElf(mo);
    const extra = e.names.filter((n) => n.endsWith('eh_frame'));
    if (extra.length > 0) bad(`${t.name} 上不该有 .eh_frame`, `    多了 ${extra.join(' ')}`);
    else ok(`${t.name} 上没有 .eh_frame`);
  }
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
