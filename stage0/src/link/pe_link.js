/* 把节的内容真的填出来 —— ADR-0017 第 11 步，第九刀第四十九片。
 *
 * 第四十八片把「摆在哪」算对了，这一片填「里面是什么」：导入表的字节、导入桩的代码、
 * 每个符号的最终地址，然后把所有重定位落笔（`relocate_sections`）。
 *
 * 尺子是 tcc 链出来的那份 `.exe` 的每一节：拿 `readImage` 读出来，与我们摆出来的那几段
 * 逐字节比。整份文件的头留给下一片 —— 节的内容对上了，头就只剩那三十几个字段。
 *
 * 三格要记住：
 *
 *  - 导入函数的符号**不再是未定义的**：`pe_check_symbols` 把它的 `st_value` 改成了
 *    `.text` 里那个桩的偏移、`st_shndx` 改成 `.text`。于是 `call printf` 那条
 *    `R_X86_64_PLT32` 落笔时算的是「到桩的距离」。
 *  - 导入**数据**（`__declspec(dllimport)`）绑到的是 IAT 里那一格的地址，不是桩。
 *  - 桩里那一格地址由一条重定位补上：x86_64 上是 `R_X86_64_PC32`（`ff 25` 后面那个
 *    rel32，原地先写着 -4），arm64 上是 `R_AARCH64_ABS64`（16 字节代码后面那 8 字节）。
 */

import { OmniError } from '../source/diag.js';
import { peSections, CLS } from './pe_sections.js';
import { buildImports, writeImage } from './pe.js';
import { relocateOne } from './pe_reloc.js';

const SHT_NOBITS = 8;
const SHT_RELA = 4;
const SHN_UNDEF = 0;
const STB_WEAK = 2;
const SHN_COMMON = 0xfff2;
const SHN_LORESERVE = 0xff00;
const SHN_ABS = 0xfff1;
const RELA_SIZE = 24;
const IMP_DESC_SIZE = 20;
const THUNK_SIZE = 8;

const EM_X86_64 = 62;
const EM_AARCH64 = 183;

/** 一个导入桩的代码（地址那一格留空，由重定位补）。 */
function thunkCode(machine) {
  if (machine === EM_X86_64) {
    /* `ff 25 <rel32>`：跳到 IAT 那一格里存的地址。rel32 原地先写 -4。 */
    return new Uint8Array([0xff, 0x25, 0xfc, 0xff, 0xff, 0xff, 0, 0]);
  }
  if (machine === EM_AARCH64) {
    const b = new Uint8Array(24);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, 0x58000090, true);            // ldr x16, [pc, #16]
    dv.setUint32(4, 0xf9400210, true);            // ldr x16, [x16]
    dv.setUint32(8, 0xd61f0200, true);            // br x16
    dv.setUint32(12, 0xd503201f, true);           // nop（对齐）
    return b;
  }
  throw new OmniError(`pe: 不认识的架构 0x${machine.toString(16)}`);
}

/**
 * 链一份 PE：节的内容全部填好、重定位全部落笔。
 *
 * @param inp 与 `peSections` 一样
 * @returns `peSections` 的结果，外加 `infos[i].bytes`（那一节的内容）与 `entry`
 */
export function peImage(inp) {
  const r = peSections(inp);
  const { machine, imagebase, secs, syms, imports, imp } = r;

  /* 每一节一块正好那么长的缓冲区，原来的内容照抄进去。 */
  for (const s of secs) {
    if (s.type === SHT_NOBITS) { s.data = null; continue; }
    s.data = new Uint8Array(s.size);
    s.data.set(s.bytes.subarray(0, Math.min(s.bytes.length, s.size)), 0);
  }

  /* 导入表的字节。`buildImports` 回的是从 `at` 起到那一节末尾的整段。 */
  if (imp !== null) {
    const bytes = buildImports(imp);
    r.thunk.data.set(bytes, imp.at);
  }

  /* 导入桩的代码。 */
  const code = thunkCode(machine);
  const iatBase = imp === null ? 0
    : r.thunk.vaddr + imp.at + (imp.dlls.length + 1) * IMP_DESC_SIZE;
  const iatAddr = (key) => iatBase + imports.slot.get(key) * THUNK_SIZE;
  const thunkAddr = (key) => r.text.vaddr + r.thunkAt + imports.thunkIdx.get(key) * r.thunkSize;
  for (const [key, i] of imports.thunkIdx) {
    const at = r.thunkAt + i * r.thunkSize;
    r.text.data.set(code, at);
    /* 桩里指向 IAT 那一格的那条重定位，就地落笔。 */
    if (machine === EM_X86_64) {
      relocateOne(machine, 2, r.text.data, at + 2, r.text.vaddr + at + 2, iatAddr(key), imagebase);
    } else {
      relocateOne(machine, 257, r.text.data, at + 16, r.text.vaddr + at + 16, iatAddr(key), imagebase);
    }
  }

  /* 每个符号的最终地址。 */
  const addrOf = (sym) => {
    const b = imports.bind.get(sym.name);
    if (b !== undefined && sym.shndx === SHN_UNDEF) {
      return b.func ? thunkAddr(b.key) : iatAddr(b.key);
    }
    /* 链接器自己提供的那几个（`_etext`、`__init_array_start` …）与安家到 `.bss` 的
     * COMMON 符号，值不在符号表里，在这张表里。 */
    const l = r.linker.get(sym.name);
    if (l !== undefined && (sym.shndx === SHN_UNDEF || sym.shndx === SHN_COMMON)) {
      return l.sec.vaddr + l.off;
    }
    if (sym.shndx === SHN_UNDEF) return 0;         // 弱的未定义符号在 PE 上就是 0
    if (sym.shndx === SHN_ABS) return sym.value;
    if (sym.shndx >= SHN_LORESERVE) return 0;
    const s = secs[sym.shndx - 1];
    if (s === undefined) throw new OmniError(`pe: 符号 '${sym.name}' 指的节不存在`);
    return s.vaddr + sym.value;
  };

  /* 重定位落笔（`relocate_sections`）。 */
  for (const rela of secs) {
    if (rela.type !== SHT_RELA) continue;
    const tgt = secs[rela.info - 1];
    if (tgt === undefined || tgt.data === null || tgt.vaddr === undefined) continue;
    const dv = new DataView(rela.bytes.buffer, rela.bytes.byteOffset, rela.bytes.byteLength);
    for (let p = 0; p + RELA_SIZE <= rela.bytes.length; p += RELA_SIZE) {
      const off = Number(dv.getBigUint64(p, true));
      const type = dv.getUint32(p + 8, true);
      const symx = dv.getUint32(p + 12, true);
      const addend = Number(dv.getBigInt64(p + 16, true));
      const sym = syms[symx];
      if (sym === undefined) throw new OmniError('pe: 重定位指的符号不存在');
      const weak = sym.shndx === SHN_UNDEF && sym.bind === STB_WEAK
        && !imports.bind.has(sym.name) && !r.linker.has(sym.name);
      relocateOne(machine, type, tgt.data, off, tgt.vaddr + off,
        addrOf(sym) + addend, imagebase, weak);
    }
  }

  /* 一条节表项里可能并了好几节，按地址摆到一块去。**长度取 `dataSize` 而不是
   * `vsize`** —— `.bss` 并进 `.data` 那一条的时候，虚拟长度里有一大截是不写进文件的
   * （`pe_write` 里写的是 `si->data_size`）。 */
  for (const info of r.infos) {
    const b = new Uint8Array(info.dataSize);
    for (const s of info.secs) {
      if (s.data === null) continue;
      b.set(s.data.subarray(0, Math.max(0, b.length - (s.vaddr - info.vaddr))), s.vaddr - info.vaddr);
    }
    info.bytes = b;
  }

  const start = syms.find((s) => s.name === (inp.startName ?? '_start'));
  r.entry = start === undefined ? 0 : addrOf(start) - imagebase;
  r.addrOf = addrOf;
  return r;
}

/** ELF 的 `e_machine` → PE 的机器号与 `Characteristics`（`CHARACTERISTICS_EXE`）。 */
const PE_MACHINE = new Map([
  [EM_X86_64, { machine: 0x8664, chars: 0x022f }],
  [EM_AARCH64, { machine: 0xaa64, chars: 0x0022 }],
]);

/**
 * 链一份 PE 并把整个文件写出来。
 *
 * 头部那三十几个字段照 `pe_write`：`subsystem` 默认 3（console），栈默认 0x100000，
 * 数据目录里填导入表、IAT、异常表（`.pdata`）与重定位表（`.reloc`）。
 */
export function peWrite(inp) {
  const r = peImage(inp);
  const cpu = PE_MACHINE.get(r.machine);
  if (cpu === undefined) throw new OmniError(`pe: 不认识的架构 0x${r.machine.toString(16)}`);
  const base = r.imagebase;
  const dirs = [];
  for (let i = 0; i < 16; i++) dirs.push({ addr: 0, size: 0 });
  for (const info of r.infos) {
    const d = { addr: info.vaddr - base, size: info.vsize };
    if (info.cls === CLS.pdata) dirs[3] = d;       // EXCEPTION
    else if (info.cls === CLS.reloc) dirs[5] = d;  // BASERELOC
    else if (info.cls === CLS.rsrc) dirs[2] = d;   // RESOURCE
  }
  if (r.imp !== null) {
    let nsyms = 0;
    for (const d of r.imp.dlls) nsyms += d.syms.length;
    const impSize = (r.imp.dlls.length + 1) * IMP_DESC_SIZE;
    const at = r.thunk.vaddr - base + r.imp.at;
    dirs[1] = { addr: at, size: impSize };                                  // IMPORT
    dirs[12] = { addr: at + impSize, size: (nsyms + r.imp.dlls.length) * THUNK_SIZE }; // IAT
  }
  const img = {
    machine: cpu.machine,
    chars: cpu.chars,
    subsystem: inp.subsystem ?? 3,
    imagebase: base,
    entry: r.entry,
    stack: inp.stack ?? 0x100000,
    dirs,
    secs: r.infos.map((i) => ({
      name: i.name, vsize: i.vsize, vaddr: i.vaddr - base, chars: i.flags, bytes: i.bytes,
    })),
  };
  r.img = img;
  r.bytes = writeImage(img);
  return r;
}
