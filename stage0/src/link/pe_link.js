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
import { DWARF_SECTIONS } from './elf_merge.js';
import { buildImports, writeImage } from './pe.js';
import { relocateOne } from './pe_reloc.js';

const SHT_NOBITS = 8;
const SHT_RELA = 4;
const SHN_UNDEF = 0;
const STB_GLOBAL = 1;
const STB_WEAK = 2;
const SHN_COMMON = 0xfff2;
const SHN_LORESERVE = 0xff00;
const SHN_ABS = 0xfff1;
const RELA_SIZE = 24;
const IMP_DESC_SIZE = 20;
const THUNK_SIZE = 8;
/** `sizeof(struct syment)` —— 紧排的 18 字节。 */
const SYMENT_SIZE = 18;

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

  /* 导出表的字节。函数 RVA 那几格还空着，等重定位落笔（见下）。 */
  if (r.exp !== null) r.thunk.data.set(r.exp.bytes, r.exp.at);

  /* `IMAGE_TLS_DIRECTORY`：四个指针加两个 0。tcc 写的是「相对 `.data` 的偏移」，
   * 再靠四条 `REL_TYPE_DIRECT` 把 `.data` 的地址加上去 —— 我们直接写终值。 */
  if (r.tls !== null) {
    const t = r.tls;
    const dv = new DataView(r.thunk.data.buffer, r.thunk.data.byteOffset + t.dir, t.size);
    dv.setBigUint64(0, BigInt(t.start), true);                      // StartAddressOfRawData
    dv.setBigUint64(8, BigInt(t.end), true);                        // EndAddressOfRawData
    dv.setBigUint64(16, BigInt(t.dataSec.vaddr + t.data), true);    // AddressOfIndex
    dv.setBigUint64(24, BigInt(t.dataSec.vaddr + t.data + 8), true); // AddressOfCallBacks
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

  /* 每个符号最后落在**哪一节的哪个偏移**上。COFF 符号表里那两格
   * （`n_scnum` / `n_value`）要的正是这个：`pe_add_coffsym` 拿到的是
   * `relocate_syms` 之后的绝对地址，再减回 `s->sh_addr`。 */
  const placeOf = (sym) => {
    const b = imports.bind.get(sym.name);
    if (b !== undefined && sym.shndx === SHN_UNDEF) {
      return b.func
        ? { sec: r.text, off: r.thunkAt + imports.thunkIdx.get(b.key) * r.thunkSize }
        : { sec: r.thunk, off: iatAddr(b.key) - r.thunk.vaddr };
    }
    const l = r.linker.get(sym.name);
    if (l !== undefined && (sym.shndx === SHN_UNDEF || sym.shndx === SHN_COMMON)) return l;
    /* 未定义（弱符号）与 `SHN_ABS` 那一路：`n_scnum` 照原样写，`n_value` 就是
     * `st_value` —— `relocate_syms` 对这两种都没加节的地址。 */
    if (sym.shndx === SHN_UNDEF || sym.shndx >= SHN_LORESERVE) return null;
    return { sec: secs[sym.shndx - 1], off: sym.value };
  };

  /* 重定位落笔（`relocate_sections`）。 */
  /* 线程局部那几号要 PT_TLS 的起止。PE 上 `pe_build_tls` 只填了 `tls_start`，
   * 末尾那一句是 `s1->tls_end = s1->tls_start` —— 两头是同一个地址，所以 x86_64 的
   * `TPOFF32` 与 arm64 的 `TLSLE_*` 算出来都是「相对 `.tls` 那一段的起点」。
   * arm64 那两号在 Windows 上**不加** `tcbhead_t` 那 16 个字节（`#if TCC_TARGET_PE`）。 */
  const TLS_RELOC = new Set([23, 549, 550]);
  const tlsSeg = r.tls === null ? undefined
    : { start: r.tls.start, end: r.tls.start, symSecEnd: 0, tcb: 0 };
  /* `relocate_section` 里那个 dwarf 的例外：调试节里 `R_DATA_32DW`（x86_64 是
   * `R_X86_64_32`、别的目标是 `R_DATA_32`）指到**另一个调试节**时，写的是
   * `tgt - 那一节的地址`，也就是**节内偏移**，不是绝对地址。调试信息内部互相指的
   * 就该是偏移。 */
  const DW = new Set(DWARF_SECTIONS);
  const dw32 = machine === EM_AARCH64 ? 258 : 10;
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
      if (type === dw32 && DW.has(tgt.name) && sym.shndx !== SHN_UNDEF
        && sym.shndx < SHN_LORESERVE && DW.has(secs[sym.shndx - 1]?.name)) {
        relocateOne(machine, type, tgt.data, off, tgt.vaddr + off, sym.value + addend, imagebase);
        continue;
      }
      relocateOne(machine, type, tgt.data, off, tgt.vaddr + off,
        addrOf(sym) + addend, imagebase, weak, undefined,
        TLS_RELOC.has(type) ? tlsSeg : undefined);
    }
  }

  /* 导出表里那几格函数 RVA：tcc 给它们挂的是 `R_XXX_RELATIVE`，也就是
   * `add32(val - imagebase)` —— 原地是 0，于是写进去的正是符号的 RVA。 */
  if (r.exp !== null) {
    const rel = machine === EM_AARCH64 ? 1027 : 8;
    for (const sl of r.exp.slots) {
      relocateOne(machine, rel, r.thunk.data, sl.at,
        r.thunk.vaddr + sl.at, addrOf(syms[sl.sym]), imagebase);
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
  r.placeOf = placeOf;
  return r;
}

/**
 * `-g` 时接在所有节后面的那张 COFF 符号表（`pe_add_coffsym`）。
 *
 * 一条 18 字节：名字（不超过 8 字节就写在原地，否则 `n_zeroes` 留 0、`n_offset` 记
 * 到字符串表里的偏移）、`n_value`、`n_scnum`、`n_type`、`n_sclass`、`n_numaux`。
 * 只收 `STB_GLOBAL` 的符号 —— 局部与弱符号都不进。`n_sclass` 一律 2（`C_EXT`）。
 *
 * `n_value` 是**这一节里的偏移**，不是 RVA：tcc 写的是 `st_value - s->sh_addr`，
 * 而那时 `st_value` 已经是绝对地址了。`n_scnum` 是 `s->sh_info` —— 摆地址那一步
 * 记下的「落在节表里第几条」，并进同一条的几节记的是同一个号。
 *
 * @param putStr 往 `.coffstr` 里接一个字符串，回它的偏移
 * @returns `{bytes, count}`
 */
function buildCoffSyms(r, putStr) {
  const list = [];
  for (let i = 1; i < r.syms.length; i++) {
    const sym = r.syms[i];
    if (sym === undefined || sym.bind !== STB_GLOBAL) continue;
    const p = r.placeOf(sym);
    list.push({
      name: sym.name,
      value: p === null ? sym.value : p.off,
      scnum: p === null ? (sym.shndx >= SHN_LORESERVE ? sym.shndx : 0) : (p.sec.peIndex ?? 0),
    });
  }
  const bytes = new Uint8Array(list.length * SYMENT_SIZE);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const at = i * SYMENT_SIZE;
    if (e.name.length <= 8) {
      for (let k = 0; k < e.name.length; k++) bytes[at + k] = e.name.charCodeAt(k) & 0xff;
    } else {
      dv.setUint32(at + 4, putStr(e.name), true);   // n_zeroes 留 0，n_offset 记偏移
    }
    dv.setInt32(at + 8, e.value, true);
    dv.setInt16(at + 12, e.scnum, true);
    bytes[at + 16] = 2;                             // n_sclass = C_EXT
  }
  return { bytes, count: list.length };
}

/** ELF 的 `e_machine` → PE 的机器号与 `Characteristics`（`CHARACTERISTICS_EXE/DLL`）。 */
const PE_MACHINE = new Map([
  [EM_X86_64, { machine: 0x8664, chars: 0x022f, charsDll: 0x222e }],
  [EM_AARCH64, { machine: 0xaa64, chars: 0x0022, charsDll: 0x2022 }],
]);

/**
 * 链一份 PE 并把整个文件写出来。
 *
 * 头部那三十几个字段照 `pe_write`：`subsystem` 默认 3（console，DLL 是 2），栈默认
 * 0x100000，数据目录里填导出表（DLL）、导入表、IAT、异常表（`.pdata`）与重定位表
 * （`.reloc`）。`Characteristics` 分 EXE 与 DLL 两个值，`.reloc` 只要**建过**就把
 * `RELOCS_STRIPPED` 抹掉 —— 哪怕它空得没进节表。
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
  if (r.exp !== null) {
    dirs[0] = { addr: r.thunk.vaddr - base + r.exp.at, size: r.exp.size };   // EXPORT
  }
  if (r.tls !== null) {
    dirs[9] = { addr: r.thunk.vaddr - base + r.tls.dir, size: r.tls.size };  // TLS
  }
  /* `pe->reloc` 只要**建了**就把 `RELOCS_STRIPPED` 抹掉 —— 哪怕它一条都没装、
   * 空得连节表都没进去。`-Wl,--large-address-aware` 加的那 0x20 在这之前先或上去。 */
  let chars = ((r.dll ? cpu.charsDll : cpu.chars) | (inp.peChars ?? 0)) >>> 0;
  if (r.hasReloc) chars &= ~0x1;
  /* `-g`：`.coffstr` 的头 4 字节留给它自己的长度，接着**先**是节表里那些超过 8 字节
   * 的节名（`pe_write` 的节头循环就在这儿把它们换成 `/<偏移>`），**再**是符号名。
   * 两段的次序不能反 —— 偏移都写进文件了。 */
  const coffstr = r.debug ? [0, 0, 0, 0] : null;
  const putStr = (s) => {
    const off = coffstr.length;
    for (let i = 0; i < s.length; i++) coffstr.push(s.charCodeAt(i) & 0xff);
    coffstr.push(0);
    return off;
  };
  const secs = r.infos.map((i) => ({
    name: i.name, vsize: i.vsize, vaddr: i.vaddr - base, chars: i.flags, bytes: i.bytes,
  }));
  if (r.debug) for (const s of secs) if (s.name.length > 8) s.name = longName(s.name, putStr);
  let tail;
  let symtab;
  if (r.debug) {
    const cs = buildCoffSyms(r, putStr);
    const dv = new DataView(new ArrayBuffer(4));
    dv.setUint32(0, coffstr.length, true);
    for (let i = 0; i < 4; i++) coffstr[i] = dv.getUint8(i);
    tail = new Uint8Array(cs.bytes.length + coffstr.length);
    tail.set(cs.bytes, 0);
    tail.set(new Uint8Array(coffstr), cs.bytes.length);
    symtab = { count: cs.count, size: cs.bytes.length };
  }
  const img = {
    machine: cpu.machine,
    chars,
    subsystem: r.subsystem,
    dllChars: r.dllChars,
    sectionAlign: r.sectionAlign,
    fileAlign: r.fileAlign,
    imagebase: base,
    entry: r.entry,
    stack: inp.stack ?? 0x100000,
    dirs,
    secs,
    tail,
    symtab,
  };
  r.img = img;
  r.bytes = writeImage(img);
  /* `pe_build_exports` 里那段 `#if 1`：只要真有导出的符号，就顺手往
   * `<输出>.def` 写一份导出清单。落盘的事交给调用方（我们不碰文件系统）。 */
  if (r.exp !== null) r.def = { path: defPath(inp.outName), text: r.exp.def };
  return r;
}

/**
 * `pstrcpy(buf, pe->filename); strcpy(tcc_fileextension(buf), ".def")`。
 *
 * `tcc_fileextension` 找的是**基名**里最后一个点；基名里没有点就回字符串末尾，
 * 于是 `.def` 直接接在后面。目录名里的点不算 —— `out.d/foo` 出来的是 `out.d/foo.def`。
 */
export function defPath(out) {
  const i = Math.max(out.lastIndexOf('/'), out.lastIndexOf('\\'));
  const dot = out.lastIndexOf('.');
  return `${dot > i ? out.slice(0, dot) : out}.def`;
}

/**
 * 超过 8 字节的节名（`.debug_info`、`.init_array` …）在 `-g` 时写成 `/<偏移>`。
 *
 * tcc 那两句是先 `memcpy(psh->Name, sh_name, umin(strlen, 8))`，**再**
 * `snprintf((char*)psh->Name, 8, "/%d", off)` —— `snprintf` 只覆盖前面那几个字节
 * 加一个结尾的 `\0`，**后面几个字节还是原名字剩下的那几个**。装载器读到 `\0` 就停，
 * 可文件里那几个字节不是 0。
 */
function longName(name, putStr) {
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) b[i] = name.charCodeAt(i) & 0xff;
  const tag = `/${putStr(name)}`;
  const n = Math.min(tag.length, 7);
  for (let i = 0; i < n; i++) b[i] = tag.charCodeAt(i);
  b[n] = 0;
  return b;
}
