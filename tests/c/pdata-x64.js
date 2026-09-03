// tests/c/pdata-x64.js —— win32 的 x86_64 上每个函数都要在 `.pdata` 里占一条
// （ADR-0017 第九刀第一百一十七片）
//
// 这一节是 win64 的异常展开表。tcc 在每个函数收尾的时候（`gfunc_epilog` 叫
// `pe_add_unwind_data`，`tccpe.c:1980`）往 `.pdata` 里塞一条 12 字节的
// `RUNTIME_FUNCTION{BeginAddress, EndAddress, UnwindData}`，三个字段各挂一条
// 指着 `.uw_base` 的 RELATIVE 重定位；那一份共用的 8 字节 `UNWIND_INFO`
// （所有函数一个栈帧长相，所以只要一份）住在 `.text` 里，摆在**第一个函数之后**、
// 对齐到 4。
//
// 门看四件事，期望一律从交叉编译器写出来的 `.o` 里读，不写死：
//
//   1. `.pdata` 后面紧跟着 `.rela.pdata`，两节与 `.rela.text` 的先后照**造出来的次序**：
//      第一个函数里有代码重定位就 `.rela.text` 在前，没有就 `.pdata` 在前（两份各自算一遍）
//   2. `.pdata` 每个函数 12 字节、`sh_addralign` 与尺子一样
//   3. `.rela.pdata` 每个函数三条，都指着 `.uw_base`、同一个类型号、加数 0
//   4. `.uw_base` 是局部段的最后一条、NOTYPE、指着 `.text`
//   5. `.text` 里那八个字节与尺子的一模一样，且所有函数的 `UnwindData` 都指着它
//
// 外加一条反面的：linux 那边一节也不多 —— 这是 PE 的事实，不是所有目标的。
//
//   node tests/c/pdata-x64.js

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const CROSS = join(root, '.omni-cache', 'tcc-cross');
const OUT = join(tmpdir(), 'omni-pdata-x64');

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
const WTCC = join(CROSS, 'x86_64-win32-tcc');
if (SRC === null || !existsSync(WTCC)) {
  process.stdout.write(`  skip 整组：x86_64-win32 的交叉编译器还没建（${CROSS}）\n`);
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/** 把一个 ELF 目标文件读成 `{names, sec, syms, shInfo}` —— 只读这门要看的那几格。 */
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
  const sec = (name) => secs.find((s) => s.name === name);
  const st = sec('.symtab');
  const strtab = secs[st.link];
  const syms = [];
  for (let k = 0; k * 24 < st.size; k++) {
    const o = st.off + k * 24;
    syms.push({
      name: nameAt(strtab.off, b.readUInt32LE(o)),
      info: b[o + 4],
      shndx: b.readUInt16LE(o + 6),
    });
  }
  return { bytes: b, names: secs.map((s) => s.name), sec, syms, shInfo: st.info };
}

/** 一张 RELA 表读成 `[{at, sym, type, add}]`。 */
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

/** `.pdata` 的每一条：`[start, end, uw]`。 */
function pdataEntries(e) {
  const s = e.sec('.pdata');
  if (s === undefined) return null;
  const out = [];
  for (let k = 0; k * 12 < s.size; k++) {
    const o = s.off + k * 12;
    out.push([e.bytes.readUInt32LE(o), e.bytes.readUInt32LE(o + 4), e.bytes.readUInt32LE(o + 8)]);
  }
  return out;
}

/* 两个探子：一个第一个函数里**没有**重定位（`.pdata` 先造），一个有（`.rela.text` 先造）。
 * 那一格正是「节的次序就是造出来的次序」这件事的证据。 */
const PROBES = [
  { name: '第一个函数里没有重定位', src: 'int f(int a){return a+1;}\nint main(void){return f(1);}\n' },
  {
    name: '第一个函数里有重定位',
    src: 'extern int g(int);\nint f(int a){return g(a)+1;}\nint main(void){return f(1);}\n',
  },
];

for (const p of PROBES) {
  const c = join(OUT, 'p.c');
  writeFileSync(c, p.src);
  const ro = join(OUT, 'ref.o');
  const r = spawnSync(WTCC, [`-B${join(SRC, 'win32')}`, '-c', c, '-o', ro], { encoding: 'utf8' });
  if (r.status !== 0) {
    bad(p.name, `    尺子自己就拒了：${(r.stderr ?? '').trim().split('\n')[0]}`);
    continue;
  }
  const mo = join(OUT, 'our.o');
  const a = spawnSync(process.execPath,
    [CLI, 'c-obj', c, '--arch', 'x86_64', '--os', 'win32', '--format', 'elf', '-o', mo],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (a.status !== 0) {
    bad(p.name, `    我们编不动：${(a.stderr ?? '').trim().split('\n')[0]}`);
    continue;
  }
  const ref = readElf(ro);
  const our = readElf(mo);

  // 1. `.pdata`/`.rela.pdata`/`.rela.text` 的次序 —— 照**造出来的次序**那条规矩，
  //    两份各自算一遍：第一个函数里有代码重定位就 `.rela.text` 在前，没有就 `.pdata` 在前。
  const order = (e) => {
    const ns = e.names;
    const ip = ns.indexOf('.pdata');
    if (ip < 0 || ns[ip + 1] !== '.rela.pdata') return '.pdata 后面没紧跟着 .rela.pdata';
    const it = ns.indexOf('.rela.text');
    const rt = relas(e, '.rela.text');
    const ent = pdataEntries(e);
    const inFirst = rt.length > 0 && rt[0].at < ent[0][1];
    if (it < 0) return 'pdata 先（没有 .rela.text）';
    if (inFirst !== (it < ip)) return `次序不合：.rela.text 在 ${it}、.pdata 在 ${ip}，第一个函数里${inFirst ? '有' : '没有'}重定位`;
    return inFirst ? 'rela.text 先' : 'pdata 先';
  };
  const oref = order(ref);
  const oour = order(our);
  if (oref.startsWith('.') || oref.startsWith('次序') || oour.startsWith('.') || oour.startsWith('次序')) {
    bad(`${p.name}：节的次序`, `    tcc : ${oref}\n    ours: ${oour}`);
  } else ok(`${p.name}：节的次序照造出来的次序（尺子 ${oref}、我们 ${oour}）`);

  // 2. `.pdata` 的大小与对齐
  const nf = ref.sec('.pdata').size / 12;
  const rp = ref.sec('.pdata');
  const op = our.sec('.pdata');
  if (op === undefined) bad(`${p.name}：.pdata`, '    我们一节也没写');
  else if (op.size % 12 !== 0 || op.al !== rp.al) {
    bad(`${p.name}：.pdata 的形状`,
      `    tcc : ${rp.size} 字节（${nf} 个函数）、对齐 ${rp.al}\n    ours: ${op.size} 字节、对齐 ${op.al}`);
  } else ok(`${p.name}：.pdata 每个函数 12 字节、对齐 ${op.al}（与尺子一样）`);

  // 3. `.rela.pdata`：每条 `RUNTIME_FUNCTION` 三个字段各一条，都指着 `.uw_base`。
  //    条数按**各自的函数个数**算 —— 我们那边外部函数还带着一个 `$ext$` 的桩，
  //    那也是一个真函数，于是比尺子多一条；桩这门手法退役之前这一格只能这么比。
  const rr = relas(ref, '.rela.pdata');
  const or = relas(our, '.rela.pdata');
  const uwRef = ref.syms.findIndex((s) => s.name === '.uw_base');
  const uwOur = our.syms.findIndex((s) => s.name === '.uw_base');
  const shape = (rs, uwNo, n) => (rs.length !== n * 3
    ? `${rs.length} 条（该是 ${n * 3}）`
    : rs.map((x) => `${x.at % 12}:${x.sym === uwNo ? 'uw' : '?'}/${x.type}/${x.add}`).slice(0, 3).join(' '));
  const sref = shape(rr, uwRef, pdataEntries(ref).length);
  const sour = shape(or, uwOur, pdataEntries(our).length);
  if (uwOur < 0) bad(`${p.name}：.uw_base`, '    符号表里没有这一条');
  else if (sref !== sour) {
    bad(`${p.name}：.rela.pdata`, `    tcc : ${sref}\n    ours: ${sour}`);
  } else ok(`${p.name}：.rela.pdata 每个函数三条 ${sour}（${or.length / 3} 个函数）`);

  // `.uw_base` 那一条本身：局部段的**最后**一条、NOTYPE、指着 `.text`
  const su = (e, k) => (k < 0 ? 'none' : `${e.syms[k].info}/${e.syms[k].shndx}/${k === e.shInfo - 1 ? '末' : `${k}≠${e.shInfo - 1}`}`);
  if (su(ref, uwRef) !== su(our, uwOur)) {
    bad(`${p.name}：.uw_base 那条符号`,
      `    tcc : ${su(ref, uwRef)}（${uwRef} 号，sh_info ${ref.shInfo}）\n    ours: ${su(our, uwOur)}（${uwOur} 号，sh_info ${our.shInfo}）`);
  } else ok(`${p.name}：.uw_base 是局部段最后一条、NOTYPE、指着 .text（${uwOur} 号）`);

  // 4. `.text` 里那八个字节，与 `UnwindData` 指的地方
  const uwBytes = (e) => {
    const t = e.sec('.text');
    const ent = pdataEntries(e);
    const off = ent[0][2];
    return { off, hex: hex(e.bytes.subarray(t.off + off, t.off + off + 8)), same: ent.every((x) => x[2] === off) };
  };
  const bref = uwBytes(ref);
  const bour = uwBytes(our);
  if (bref.hex !== bour.hex || !bour.same) {
    bad(`${p.name}：UNWIND_INFO`,
      `    tcc : ${bref.hex}（在 .text 的 ${bref.off}）\n    ours: ${bour.hex}（在 .text 的 ${bour.off}，共用 ${bour.same}）`);
  } else if (bour.off % 4 !== 0) {
    bad(`${p.name}：UNWIND_INFO 的位置`, `    ${bour.off} 没对齐到 4`);
  } else ok(`${p.name}：.text 里那 8 个字节是 ${bour.hex}，${nf} 个函数共用一份`);
}

/* 反面那一条：linux 上一节也不多 —— `.pdata` 是 PE 的事实。 */
{
  const c = join(OUT, 'p.c');
  const mo = join(OUT, 'linux.o');
  const a = spawnSync(process.execPath,
    [CLI, 'c-obj', c, '--arch', 'x86_64', '--os', 'linux', '--format', 'elf', '-o', mo],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (a.status !== 0) bad('linux 上不该有 .pdata', `    我们编不动：${(a.stderr ?? '').trim().split('\n')[0]}`);
  else {
    const e = readElf(mo);
    const extra = e.names.filter((n) => n === '.pdata' || n === '.rela.pdata');
    const uw = e.syms.some((s) => s.name === '.uw_base');
    if (extra.length > 0 || uw) {
      bad('linux 上不该有 .pdata', `    多了 ${extra.join(' ')}${uw ? '、还有 .uw_base' : ''}`);
    } else ok('x86_64-linux 上没有 .pdata、也没有 .uw_base');
  }
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
