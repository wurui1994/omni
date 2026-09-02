/* ELF 可执行文件的写出 —— ADR-0017 第 11 步，第九刀第五十三片。
 *
 * PE 那一路（四十七到五十二片）走完之后，`.o` -> 可执行文件这条路我们自己走了一遍。
 * 这一片换一个格式：Linux 的 ELF。同一件事换一套规矩，能把「我们照的是 tcc 的算式，
 * 不是照着一个输出反推的」这句话验一遍。
 *
 * 尺子是 `<target>-tcc -static -nostdlib -Wl,-e,main a.o -o a.out`：
 *
 *  - `-static`：不要 `.interp` / `.dynsym` / `.dynamic` / `.got` 那一整套，
 *    先把**摆放与写出**这一段对齐，动态那一段留给后面的片；
 *  - `-nostdlib`：交叉编译的 Linux 目标在 macOS 上没有 libc 可装；
 *  - `-Wl,-e,main`：没有 crt 也就没有 `_start`，入口直接指 `main`。
 *
 * 三个格式里 ELF 这一份最省：**符号表根本不写**。`set_sec_sizes` 只给 `SHF_ALLOC`
 * 的节把 `sh_size` 填上（`tccelf.c:2217`），`.symtab` / `.strtab` / `.rela.*` 的
 * `sh_size` 一直是 0；`alloc_sec_names` 于是不给它们名字（`sh_name == 0`），
 * `sort_sections` 把没名字的一律归到 0x900 那一类，`reorder_sections` 再把它们
 * 从节表里摘掉。于是可执行文件里只剩下 `SHF_ALLOC` 的节加一条 `.shstrtab`。
 *
 * 几格容易写错的：
 *
 *  - 节的次序是 `sort_sections` 算出来的两级键：`j` 认 alloc/write（0x100/0x200/0x700/
 *    0x900），`k` 认「是什么节」（符号表 0x10、重定位 0x20、可执行 0x60、bss 0x70、
 *    别的数据 0x50），然后 `if (s->sh_num <= bss_section->sh_num) ++k` —— 起手那几条
 *    标准节要**排在同类的后面**，`_etext` / `_edata` 才是对的值。排法是插入排序，
 *    同键保持原次序。
 *  - 头占的地方要**先**算出来：`file_offset = (Ehdr + phnum*Phdr + 3) & -4`，再加
 *    `shnum * Shdr`，然后 `addr = ELF_START_ADDR + file_offset` —— 第一个 PT_LOAD
 *    的 `p_offset` 最后又被按回 0、`p_vaddr` 按回 base，好让 strip 一类的工具高兴。
 *  - `f != f0 && s->sh_size` 才开新的 PT_LOAD：**空节不换段**。于是 `.data`/`.bss`
 *    是空的时候，它们跟着 `.text` 那一段走，段的 `p_filesz` 是按对齐推过去的游标算的。
 *  - `R_XXX_RELATIVE` 在 ELF 上什么都不做（`x86_64-link.c:398` 那个 `#ifdef
 *    TCC_TARGET_PE` 之外只有一句注释）；arm64 上「弱未定义符号改写成 movz/nop」
 *    也是 PE 才有的事 —— 同一个 `relocate()`，两个格式两套边角。
 */

import { OmniError } from '../source/diag.js';
import { linkObjects } from './elf_merge.js';
import { relocateOne } from './pe_reloc.js';

const EHDR_SIZE = 64;
const PHDR_SIZE = 56;
const SHDR_SIZE = 64;

const ET_EXEC = 2;
const ET_DYN = 3;

const EM_X86_64 = 62;
const EM_AARCH64 = 183;

const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;
const SHT_HASH = 5;
const SHT_DYNAMIC = 6;
const SHT_NOTE = 7;
const SHT_NOBITS = 8;
const SHT_DYNSYM = 11;
const SHT_INIT_ARRAY = 14;
const SHT_FINI_ARRAY = 15;
const SHT_PREINIT_ARRAY = 16;
const SHT_GNU_HASH = 0x6ffffff6;
const SHT_GNU_verdef = 0x6ffffffd;
const SHT_GNU_verneed = 0x6ffffffe;
const SHT_GNU_versym = 0x6fffffff;

const SHF_WRITE = 0x1;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;
const SHF_TLS = 0x400;

const SHN_UNDEF = 0;
const SHN_ABS = 0xfff1;
const SHN_COMMON = 0xfff2;
const SHN_LORESERVE = 0xff00;

const STB_LOCAL = 0;
const STB_WEAK = 2;

const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const PT_INTERP = 3;
const PT_PHDR = 6;
const PT_TLS = 7;
const PT_GNU_EH_FRAME = 0x6474e550;
const PT_GNU_RELRO = 0x6474e552;

const DT_NULL = 0;
const DT_HASH = 4;
const DT_STRTAB = 5;
const DT_SYMTAB = 6;
const DT_RELA = 7;
const DT_RELASZ = 8;
const DT_RELAENT = 9;
const DT_STRSZ = 10;
const DT_SYMENT = 11;
const DT_INIT_ARRAY = 25;
const DT_FINI_ARRAY = 26;
const DT_INIT_ARRAYSZ = 27;
const DT_FINI_ARRAYSZ = 28;
const DT_FLAGS = 30;
const DT_PREINIT_ARRAY = 32;
const DT_PREINIT_ARRAYSZ = 33;
const DT_RELACOUNT = 0x6ffffff9;
const DT_GNU_HASH = 0x6ffffef5;
const DT_FLAGS_1 = 0x6ffffffb;
const DF_BIND_NOW = 8;
const DF_1_NOW = 1;

const DT_INIT_TAGS = new Map([
  ['.preinit_array', [DT_PREINIT_ARRAY, DT_PREINIT_ARRAYSZ]],
  ['.init_array', [DT_INIT_ARRAY, DT_INIT_ARRAYSZ]],
  ['.fini_array', [DT_FINI_ARRAY, DT_FINI_ARRAYSZ]],
]);

/** `.eh_frame_hdr` 里那四个字节的编码格式（`tccdbg.c:1035`）。 */
const EHFH_HEAD = [1, 0x1b, 0x03, 0x3b];
/** `.eh_frame` 的 CIE 里那一格增补数据（`DW_EH_PE_udata4|signed|pcrel`）。 */
const FDE_ENCODING = 0x1b;

const PF_X = 1;
const PF_W = 2;
const PF_R = 4;

/** `sec_cls` 里借高位记的两件事（`tccelf.c:2335`）。 */
const SHFX_NEWPH = 1 << 4;
const SHFX_RELRO = 1 << 5;

/** ELF 上不落笔的那两号（PE 才把 RVA 写进去）。 */
const R_X86_64_RELATIVE = 8;
const R_AARCH64_RELATIVE = 1027;

/* `gotplt_entry_type` 的四档（`tcc.h`）。 */
const NO_GOTPLT = 0;
const BUILD_GOT_ONLY = 1;
const AUTO_GOTPLT = 2;
const ALWAYS_GOTPLT = 3;

const R_X86_64_PC32 = 2;
const R_X86_64_PLT32 = 4;
const R_X86_64_GLOB_DAT = 6;
const R_X86_64_JUMP_SLOT = 7;

const R_AARCH64_GLOB_DAT = 1025;
const R_AARCH64_JUMP_SLOT = 1026;

/* `prepare_dynamic_rel` 认的那几号：绝对地址（要装载时改）与 PC 相对（能顶掉的才要）。 */
const ABS_RELOC = new Map([
  [EM_X86_64, new Set([1, 10, 11])],          // R_X86_64_64 / _32 / _32S
  [EM_AARCH64, new Set([257, 258])],          // R_AARCH64_ABS64 / ABS32
]);
/** 这几号里「64 位那一号」要写回加数，32 位那号只写 RELATIVE。 */
const ABS64_RELOC = new Map([[EM_X86_64, 1], [EM_AARCH64, 257]]);
const PCREL_RELOC = new Map([
  [EM_X86_64, new Set([2])],                  // R_X86_64_PC32
  [EM_AARCH64, new Set([261])],               // R_AARCH64_PREL32
]);

/** `code_reloc`：1 是「跳转/调用」，0 是数据（`*-link.c` 开头那张表）。 */
const CODE_RELOC = new Map([
  [EM_X86_64, new Set([2, 4, 7, 24, 31])],
  [EM_AARCH64, new Set([282, 283, 1026, 280, 279])],
]);

/** `gotplt_entry_type`：只列 NO 与 ALWAYS/BUILD_GOT_ONLY，剩下的算 AUTO。 */
const GOTPLT = new Map([
  [EM_X86_64, {
    no: new Set([5, 6, 7, 8, 18, 23]),
    always: new Set([3, 4, 9, 17, 19, 20, 21, 25, 26, 27, 29, 31, 41, 42]),
    buildOnly: new Set([22]),
    auto: new Set([1, 2, 10, 11, 24]),
  }],
  [EM_AARCH64, {
    no: new Set([261, 263, 264, 265, 266, 275, 277, 278, 279, 280, 284, 285, 286,
      299, 549, 550, 1025, 1026, 1024]),
    always: new Set([311, 312]),
    buildOnly: new Set(),
    auto: new Set([257, 258, 282, 283]),
  }],
]);

function gotpltEntryType(machine, type) {
  const t = GOTPLT.get(machine);
  if (t.no.has(type)) return NO_GOTPLT;
  if (t.always.has(type)) return ALWAYS_GOTPLT;
  if (t.buildOnly.has(type)) return BUILD_GOT_ONLY;
  if (t.auto.has(type)) return AUTO_GOTPLT;
  throw new OmniError(`elf: ${type} 号该不该走 GOT，还没写`);
}

function codeReloc(machine, type) {
  return CODE_RELOC.get(machine).has(type) ? 1 : 0;
}

function align(n, to) {
  return to <= 1 || n % to === 0 ? n : n + (to - (n % to));
}

/** `ELF_START_ADDR` / `ELF_PAGE_SIZE` / `CONFIG_TCC_ELFINTERP`。 */
function targetConf(machine) {
  if (machine === EM_X86_64) {
    return { start: 0x400000, page: 0x1000, interp: '/lib64/ld-linux-x86-64.so.2' };
  }
  if (machine === EM_AARCH64) {
    return { start: 0x400000, page: 0x10000, interp: '/lib/ld-linux-aarch64.so.1' };
  }
  throw new OmniError(`elf: 还不会给 ${machine} 号架构写可执行文件`);
}

/** `.hash` 用的那个老哈希（`elf_hash`）。 */
function elfHash(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 4) + name.charCodeAt(i)) >>> 0;
    const g = h & 0xf0000000;
    if (g !== 0) h ^= g >>> 24;
    h = (h & ~g) >>> 0;
  }
  return h >>> 0;
}

/** `.gnu.hash` 用的 djb2（`elf_gnu_hash`）。 */
function gnuHash(name) {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = (Math.imul(h, 33) + name.charCodeAt(i)) >>> 0;
  return h >>> 0;
}


/** 节名去掉开头的点之后能不能当 C 标识符（`tcc_add_linker_symbols` 里那一圈）。 */
function cName(name) {
  const p0 = name.startsWith('.') ? name.slice(1) : name;
  for (let i = 0; i < p0.length; i++) {
    const c = p0[i];
    const ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'
      || (c >= '0' && c <= '9');
    if (!ok) return null;
  }
  return p0;
}

/**
 * 一条节归到哪一类（`sort_sections` 的 `j + k`）。
 *
 * @param i 节号（原来的号 —— `++k` 那一步要拿它跟 `.bss` 的号比）
 * @param named 这一条有没有名字（`sh_name != 0`）
 * @param bss `.bss` 的节号
 * @param isLast 是不是节表里最后一条（`.shstrtab` 认这个，`k` 直接按成 0xff）
 * @param isGot 是不是那条 `.got`（它单独一档 0x47，为的是进 PT_GNU_RELRO）
 */
function sectionClass(s, i, named, bss, hasAllocReloc, isLast, isGot, isInterp, isPltReloc) {
  let j;
  if (!named) j = 0x900;
  else if ((s.flags & SHF_ALLOC) !== 0) {
    j = (s.flags & (SHF_WRITE | SHF_TLS)) === SHF_WRITE ? 0x200 : 0x100;
  } else j = 0x700;

  let k;
  if (s.type === SHT_SYMTAB || s.type === SHT_DYNSYM) k = 0x10;
  else if (s.type === SHT_STRTAB && s.name !== '.stabstr') k = isLast ? 0xff : 0x11;
  else if (s.type === SHT_HASH || s.type === SHT_GNU_HASH) k = 0x12;
  else if (s.type === SHT_GNU_verdef || s.type === SHT_GNU_verneed
    || s.type === SHT_GNU_versym) k = 0x13;
  /* `.rela.plt` 单独一档 —— 于是它排在别的重定位表**后头**，`update_reloc_sections`
   * 里 DT_RELA 那一段（把余下几张表接成连着的一块）就不会被它插一脚。 */
  else if (s.type === SHT_RELA) k = isPltReloc ? 0x21 : 0x20;
  else if ((s.flags & SHF_EXECINSTR) !== 0) k = 0x60;
  else if ((s.flags & SHF_TLS) !== 0) k = 0x40 + (s.type === SHT_NOBITS ? 1 : 0);
  else if (s.type === SHT_PREINIT_ARRAY) k = 0x42;
  else if (s.type === SHT_INIT_ARRAY) k = 0x43;
  else if (s.type === SHT_FINI_ARRAY) k = 0x44;
  else if (s.type === SHT_DYNAMIC) k = 0x46;
  else if (isGot) k = 0x47;
  else if (hasAllocReloc && j === 0x100) k = 0x45;
  else if (s.type === SHT_NOTE) k = 0x08;
  else if (s.type === SHT_NOBITS) k = 0x70;
  else if (isInterp) k = 0x00;
  else k = 0x50;

  k += j;
  /* 起手那几条标准节排在同类的最后 —— `_etext`/`_edata` 要的就是这个。 */
  if (i <= bss) ++k;
  /* RELRO 的那几条要可写（这一步**改节的 flags**，后面分段就跟着变）。 */
  if ((k & 0xfff0) === 0x140) {
    k += 0x100;
    s.flags |= SHF_WRITE;
  }
  return k;
}

/**
 * 摆好一份 ELF 可执行文件：节的地址、文件偏移、程序头，重定位也落完笔。
 *
 * @param inp `{objs, entryName}`：`objs` 是几个 `ET_REL` 的字节，`entryName` 是
 *            `-Wl,-e,` 给的入口名（不给就找 `_start`）
 */
export function elfExeImage(inp) {
  const st = linkObjects(inp.objs, { rdata: '.data.ro', unwind: true });
  const {
    machine, secs, syms, relas, byName,
  } = st;
  const { TEXT, DATA, BSS } = st.idx;
  const conf = targetConf(machine);
  /** `-shared`：输出是 ET_DYN，装载地址从 0 起，没有 `.interp`。 */
  const shared = inp.shared === true;

  // ---- resolve_common_syms：COMMON 的符号在 .bss 里安家
  for (const s of syms) {
    if (s.shndx === SHN_COMMON && s.size !== 0) {
      const bss = secs[BSS];
      const al = s.value < 1 ? 1 : s.value;
      const off = align(bss.size, al);
      bss.size = off + s.size;
      if (al > bss.al) bss.al = al;
      s.value = off;
      s.shndx = BSS;
    }
  }

  /* ---- tcc_add_linker_symbols。
   *
   * 这些是**真的放进符号表**（`set_global_sym`），不是旁边记一张表 —— 这一格有讲究：
   * 放进去之后 `_etext` 一类就是**有定义**的符号，于是 `build_got_entries` 里那条
   * 「AUTO 且未定义才走 GOT」的筛子会把它们放过去。旁表模型会多造出 GOT 项来。 */
  const defined = (n) => {
    const i = byName.get(n);
    return i !== undefined && syms[i].shndx !== SHN_UNDEF;
  };
  const findSec = (n) => {
    for (let i = 1; i < secs.length; i++) if (secs[i].name === n) return i;
    return -1;
  };
  /** `set_global_sym(name, sec, offs)`：STB_GLOBAL + STT_NOTYPE。 */
  const defineSym = (name, sec, off) => st.setSym({
    name, value: off, size: 0, info: 1 * 16, other: 0, shndx: sec,
  });
  /** `set_linker_sym`：`needRef` 是那个不带下划线的别名 —— 有人引用才给。 */
  const setLinkerSym = (name, sec, needRef) => {
    if (!defined(name) && !(needRef && !byName.has(name))) {
      defineSym(name, sec, secs[sec].size);
    }
    if (name.startsWith('_')) setLinkerSym(name.slice(1), sec, true);
  };
  /* 造共享库那一路不叫这一趟（`resolve_common_syms` 末尾那句是
   * `if (s1->output_type != TCC_OUTPUT_DLL) tcc_add_linker_symbols(s1)`）。 */
  if (!shared) {
    setLinkerSym('_etext', TEXT, false);
    setLinkerSym('_edata', DATA, false);
    setLinkerSym('_end', BSS, false);
    for (const nm of ['.preinit_array', '.init_array', '.fini_array']) {
      let i = findSec(nm);
      let end;
      if (i < 0 || (secs[i].flags & SHF_ALLOC) === 0) {
        end = 0;
        i = TEXT;
      } else end = secs[i].size;
      defineSym(`__${nm.slice(1)}_start`, i, 0);
      defineSym(`__${nm.slice(1)}_end`, i, end);
    }
    for (let i = 1; i < secs.length; i++) {
      const s = secs[i];
      if ((s.flags & SHF_ALLOC) === 0) continue;
      if (s.type !== SHT_PROGBITS && s.type !== SHT_NOBITS && s.type !== SHT_STRTAB) continue;
      const p0 = cName(s.name);
      if (p0 === null) continue;
      defineSym(`__start_${p0}`, i, 0);
      defineSym(`__stop_${p0}`, i, s.size);
    }
  }

  /* ---- 动态那一套（`!static_link`，也就是 tcc 的默认）。
   *
   * 造节的次序就是 `elf_output_file` 里的次序：`.interp` / `.dynsym` / `.dynstr` /
   * `.hash` / `.dynamic` / `.got` / `.rela.got` / `.eh_frame_hdr` / `.gnu.hash`。
   * 这个次序不只是好看 —— `.shstrtab` 里的名字是按**节号**排的。 */
  const dynamic = inp.static !== true;
  let INTERP = -1;
  let DYNSYM = -1;
  let DYNSTR = -1;
  let HASH = -1;
  let DYNA = -1;
  let GNUHASH = -1;
  let EHFH = -1;
  /** `.dynsym` 的三件套：符号、字符串、老哈希表。 */
  const dsyms = [{
    name: '', strx: 0, value: 0, size: 0, info: 0, other: 0, shndx: SHN_UNDEF,
  }];
  const dstr = [0];
  /** `.dynsym` 里的名字 -> 号（`find_elf_sym` 那张表）。 */
  const dynByName = new Map();
  let dhash = [1, 1, 0, 0];
  let dhashed = 0;
  const rebuildDynHash = (nb) => {
    const n = dsyms.length;
    const h = new Array(2 + nb + n).fill(0);
    h[0] = nb;
    h[1] = n;
    for (let i = 1; i < n; i++) {
      const s = dsyms[i];
      if (Math.floor(s.info / 16) === STB_LOCAL) continue;
      const b = elfHash(s.name) % nb;
      h[2 + nb + i] = h[2 + b];
      h[2 + b] = i;
    }
    dhash = h;
  };
  /** `put_elf_sym(s1->dynsym, …)`：连字符串表与哈希表一起动。 */
  const dynPutSym = (name, value, size, info, other, shndx) => {
    let strx = 0;
    if (name !== '') {
      strx = dstr.length;
      for (let k = 0; k < name.length; k++) dstr.push(name.charCodeAt(k));
      dstr.push(0);
    }
    dsyms.push({
      name, strx, value, size, info, other, shndx,
    });
    const idx = dsyms.length - 1;
    dhash.push(0);
    if (Math.floor(info / 16) !== STB_LOCAL) {
      const nb = dhash[0];
      const h = elfHash(name) % nb;
      dhash[dhash.length - 1] = dhash[2 + h];
      dhash[2 + h] = idx;
      dhash[1]++;
      dhashed++;
      if (dhashed > 2 * nb) rebuildDynHash(2 * nb);
    } else dhash[1]++;
    dynByName.set(name, idx);
    return idx;
  };
  /** `set_elf_sym(s1->dynsym, …)`：同名的那条改写，不再添一条。 */
  const dynSetSym = (name, value, size, info, other, shndx) => {
    const hit = dynByName.get(name);
    if (hit === undefined) return dynPutSym(name, value, size, info, other, shndx);
    const old = dsyms[hit];
    /* 老的没定义、新的有定义 —— 补上（`set_elf_sym` 里那一支）。 */
    if (old.shndx === SHN_UNDEF && shndx !== SHN_UNDEF) {
      dsyms[hit] = {
        ...old, value, size, info, other, shndx,
      };
    }
    return hit;
  };
  if (dynamic) {
    if (!shared) {
      INTERP = st.newSec('.interp', SHT_PROGBITS, SHF_ALLOC, 1, 0);
      for (let k = 0; k < conf.interp.length; k++) {
        secs[INTERP].data.push(conf.interp.charCodeAt(k));
      }
      secs[INTERP].data.push(0);
      secs[INTERP].size = secs[INTERP].data.length;
    }
    DYNSYM = st.newSec('.dynsym', SHT_DYNSYM, SHF_ALLOC, 8, 24);
    DYNSTR = st.newSec('.dynstr', SHT_STRTAB, SHF_ALLOC, 1, 0);
    HASH = st.newSec('.hash', SHT_HASH, SHF_ALLOC, 8, 4);
    secs[DYNSYM].link = DYNSTR;
    secs[DYNSYM].info = 1;                 // 局部符号只有 0 号那一条
    secs[HASH].link = DYNSYM;
    DYNA = st.newSec('.dynamic', SHT_DYNAMIC, SHF_ALLOC | SHF_WRITE, 8, 16);
    secs[DYNA].link = DYNSTR;
  }

  /* ---- build_got_entries（静态那一支）。
   *
   * 两趟：第一趟只管代码那类（`R_JMP_SLOT`，要连 `.plt` 一起造），第二趟管数据类
   * （`R_GLOB_DAT`）—— arm64 不许两类混在一张表里，所以顺序是**写死**的。
   * GOT 那一格的值不是这一步写的：`.rela.got` 里那条 `R_GLOB_DAT` 在
   * `relocate_sections` 落笔时把符号地址写进去。 */
  const gotOff = new Map();
  /** symtab 的符号号 -> `.dynsym` 里的号（`attr->dyn_index`）。 */
  const dynIndex = new Map();
  const relative = machine === EM_X86_64 ? R_X86_64_RELATIVE : R_AARCH64_RELATIVE;
  let GOT = -1;
  let RELAGOT = -1;
  /** `_GLOBAL_OFFSET_TABLE_` 在 symtab 里的号（`build_got` 的返回值 `got_sym`）。 */
  let GOTSYM = 0;
  const buildGot = () => {
    GOT = secs.length;
    secs.push({
      name: '.got',
      type: SHT_PROGBITS,
      flags: SHF_ALLOC | SHF_WRITE,
      al: 8,
      ent: 4,
      link: 0,
      info: 0,
      /* 头三格留给 `_DYNAMIC` 与两条哑项。 */
      data: new Array(24).fill(0),
      size: 24,
      relaFor: 0,
    });
    GOTSYM = st.setSym({
      name: '_GLOBAL_OFFSET_TABLE_', value: 0, size: 0, info: 1 * 16 + 1, other: 0, shndx: GOT,
    });
  };
  /* 动态那一路的 `.got` 是**无条件**造的（`elf_output_file` 里那句 `build_got(s1)`）：
   * 一格都不用也照样占 24 字节，头一格还要记 `.dynamic` 的地址。 */
  if (dynamic) buildGot();
  const putGotReloc = (at, type, sym, local) => {    if (RELAGOT < 0) {
      RELAGOT = secs.length;
      secs.push({
        name: '.rela.got',
        type: SHT_RELA,
        /* `put_elf_reloca`：重定位表的 flags 跟着**符号表**走 —— 动态那一路的
         * `.rela.got` 于是是 `SHF_ALLOC` 的，要装进内存里给动态链接器看。 */
        flags: DYNSYM >= 0 ? SHF_ALLOC : 0,
        al: 8,
        ent: 24,
        link: DYNSYM >= 0 ? DYNSYM : st.idx.SYMTAB,
        info: GOT,
        data: [],
        size: 0,
        relaFor: GOT,
      });
      relas.set(RELAGOT, []);
    }
    const list = relas.get(RELAGOT);
    list.push({
      at, sym, type, add: 0n, local: local === true,
    });
    secs[RELAGOT].size = list.length * 24;
  };
  const globDat = machine === EM_X86_64 ? R_X86_64_GLOB_DAT : R_AARCH64_GLOB_DAT;
  const jmpSlot = machine === EM_X86_64 ? R_X86_64_JUMP_SLOT : R_AARCH64_JUMP_SLOT;
  /** symtab 的符号号 -> `.plt` 里那一格的偏移（`attr->plt_offset`）。 */
  const pltOff = new Map();
  /** symtab 的符号号 -> `name@plt` 那条符号的号（`attr->plt_sym`）。 */
  const pltSym = new Map();
  let PLT = -1;
  let RELAPLT = -1;
  const buildPlt = () => {
    PLT = st.newSec('.plt', SHT_PROGBITS, SHF_ALLOC | SHF_EXECINSTR, 8, 4);
  };
  /** 动态那一路跳板的重定位表（`put_elf_reloc(dynsym, s1->plt, ...)`）。 */
  const putPltReloc = (at, dynIdx) => {
    if (RELAPLT < 0) {
      RELAPLT = st.newSec('.rela.plt', SHT_RELA, SHF_ALLOC, 8, 24);
      secs[RELAPLT].link = DYNSYM;
      /* `build_got_entries` 末尾那一句：`.rela.plt` 的 `sh_info` 改指 `.got`
       * —— 表里的 `r_offset` 落的是 GOT 那几格。 */
      secs[RELAPLT].info = GOT;
      secs[RELAPLT].relaFor = GOT;
      relas.set(RELAPLT, []);
    }
    const list = relas.get(RELAPLT);
    list.push({ at, sym: dynIdx, type: jmpSlot, add: 0n });
    secs[RELAPLT].size = list.length * 24;
    return list.length;
  };
  /**
   * `create_plt_entry`：往 `.plt` 里加一格，返回这一格的偏移。
   *
   * 静态链接这一路**不叫** `relocate_plt`（`elf_output_file` 里那一句在
   * `if (dynamic)` 里头），所以这些字节就是最后写进文件的样子 —— 里头的
   * `got_offset` 还是节内偏移，没换成地址差。跳板本身跳不通，可这不打紧：
   * 静态链接里没有解析例程，弱符号那一格是 0，谁也不会真跳进来。
   */
  const pltEntry = (gotOffset, nrel) => {
    const d = secs[PLT].data;
    const w32 = (v) => d.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    if (machine === EM_X86_64) {
      if (d.length === 0) {
        /* PLT0：push 库的标识（GOT + 8），再跳去解析例程（GOT + 16）。 */
        d.push(0xff, 0x35); w32(8);
        d.push(0xff, 0x25); w32(16);
        w32(0);
      }
      const at = d.length;
      d.push(0xff, 0x25); w32(gotOffset);        // jmp *(got + x)
      /* push 的是「这一格对应的重定位在表里的号」。静态那一路 `.plt` 没有自己的
       * 重定位表（那几条在 `.rela.got` 里），`relofs` 于是是 0 —— 号是 -1。 */
      d.push(0x68); w32(nrel - 1);
      d.push(0xe9); w32(-(at + 16));             // jmp plt_start
      secs[PLT].size = d.length;
      return at;
    }
    /* arm64：头一格 32 字节先留空，每格 16 字节里只写 got 的偏移（64 位小端），
     * 剩下 8 字节留给 `relocate_plt` 的 adrp/ldr/add/br。 */
    if (d.length === 0) for (let k = 0; k < 32; k++) d.push(0);
    const at = d.length;
    w32(gotOffset);
    w32(0);
    for (let k = 0; k < 8; k++) d.push(0);
    secs[PLT].size = d.length;
    return at;
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < secs.length; i++) {
      if (secs[i].type !== SHT_RELA) continue;
      /* 只扫「符号号指着 symtab」的那些表 —— 动态那一路的 `.rela.got` 指着
       * `.dynsym`，那里面的 `R_RELATIVE`/`R_GLOB_DAT` 不该再过一遍这道筛子
       * （`build_got_entries` 里那句 `if (s->link != symtab_section) continue`）。 */
      if (secs[i].link !== st.idx.SYMTAB) continue;
      const list = relas.get(i);
      if (list === undefined) continue;
      for (const r of list) {
        const g = gotpltEntryType(machine, r.type);
        if (g === NO_GOTPLT) continue;
        const sym = syms[r.sym];
        if (g === AUTO_GOTPLT) {
          /* 未定义的往下走（要一格 GOT），有定义的一律不要。 */
          if (sym.shndx === SHN_ABS) {
            if (sym.value === 0) continue;
          } else if (sym.shndx !== SHN_UNDEF) continue;
        }
        /* x86_64 上「有定义的 PLT32/PC32」在可执行文件里降成 PC32 —— 不走 PLT。
         * 造共享库时不能这么降：别人可以用自己的定义把库里的这个符号顶掉
         * （`打断` 语义），所以只有局部符号或藏起来的符号才降。 */
        if (machine === EM_X86_64 && (r.type === R_X86_64_PLT32 || r.type === R_X86_64_PC32)
          && sym.shndx !== SHN_UNDEF
          && (!shared || Math.floor(sym.info / 16) === STB_LOCAL || (sym.other & 3) !== 0)) {
          if (pass !== 0) continue;
          r.type = R_X86_64_PC32;
          continue;
        }
        let rt;
        if (codeReloc(machine, r.type) !== 0) {
          if (pass !== 0) continue;
          rt = jmpSlot;
        } else {
          if (pass !== 1) continue;
          rt = globDat;
        }
        if (GOT < 0) buildGot();
        if (g === BUILD_GOT_ONLY) continue;
        /* ---- put_got_entry。
         *
         * 「被调用」与「被取地址」记在**两个**格子里（`plt_offset` 与 `got_offset`），
         * 于是同一个函数两样都来一遍就有两格 GOT：头一趟（代码那类）给跳板占一格，
         * 第二趟（数据那类）再给取地址占一格。 */
        const needPlt = rt === jmpSlot;
        if (needPlt) {
          if (pltOff.has(r.sym)) { r.sym = pltSym.get(r.sym); continue; }
          if (PLT < 0) buildPlt();
        } else if (gotOff.has(r.sym)) continue;
        const off = secs[GOT].size;
        secs[GOT].size = off + 8;
        for (let k = 0; k < 8; k++) secs[GOT].data.push(0);
        if (!needPlt) gotOff.set(r.sym, off);
        let nrel = 0;
        if (DYNSYM < 0) {
          putGotReloc(off, rt, r.sym);
        } else if (Math.floor(sym.info / 16) === STB_LOCAL) {
          /* 局部符号不进 `.dynsym`：先把 symtab 的号偷偷放在重定位里，
           * 等地址定了再由 `fill_local_got_entries` 改成 `R_RELATIVE` + 加数。 */
          putGotReloc(off, relative, r.sym, true);
        } else {
          let di = dynIndex.get(r.sym);
          if (di === undefined) {
            di = dynPutSym(sym.name, sym.value, sym.size, sym.info, 0, sym.shndx);
            dynIndex.set(r.sym, di);
          }
          if (needPlt) nrel = putPltReloc(off, di);
          else putGotReloc(off, rt, di);
        }
        if (needPlt) {
          const at = pltEntry(off, nrel);
          pltOff.set(r.sym, at);
          /* 跳板那一格自己是一条符号 `name@plt`（`plt_name` 那块 200 字节的栈缓冲
           * 只留 195 个字符给名字），调用点的重定位改指它。 */
          const ps = st.setSym({
            name: `${sym.name.slice(0, 195)}@plt`,
            value: at,
            size: 0,
            info: 1 * 16 + 2,
            other: 0,
            shndx: PLT,
          });
          pltSym.set(r.sym, ps);
          r.sym = ps;
        }
      }
    }
  }

  /* `build_got_entries` 末尾那句：`_GLOBAL_OFFSET_TABLE_` 的 `st_size` 记 GOT 的长度。
   * 可执行文件里看不出来（symtab 不写进去），共享库里这条符号是导出的，就看得出来了。 */
  if (GOTSYM !== 0) syms[GOTSYM].size = secs[GOT].size;

  /* ---- export_global_syms：造共享库就把**所有**非局部符号原样端进 `.dynsym`。
   * 连 `_GLOBAL_OFFSET_TABLE_` 与 `xxx@plt` 都在里头 —— 它们在 symtab 里是 GLOBAL 的。 */
  if (shared) {
    for (let i = 1; i < syms.length; i++) {
      const s = syms[i];
      if (Math.floor(s.info / 16) === STB_LOCAL) continue;
      dynIndex.set(i, dynSetSym(s.name, s.value, s.size, s.info, s.other, s.shndx));
    }
  }

  /* ---- prepare_dynamic_rel（`set_sec_sizes` 里那一段）。
   *
   * 造共享库时，本来只给自己用的重定位表（`.rela.text`/`.rela.data`，非 alloc）里
   * 有些条目要留到装载时才算得出来 —— 绝对地址那几号一律留，PC 相对那号只在符号
   * 能被别人顶掉（进了 `.dynsym`）时留。数出几条，这张表就跟着变成 alloc 的，
   * 长度按数出来的条数定；至于留下哪几条、写成什么样，是落笔那一趟的事。 */
  const dynRel = new Set();
  const absSet = ABS_RELOC.get(machine);
  const pcSet = PCREL_RELOC.get(machine);
  if (shared) {
    for (let i = 1; i < secs.length; i++) {
      const sr = secs[i];
      if (sr.type !== SHT_RELA || (sr.flags & SHF_ALLOC) !== 0) continue;
      const tgt = secs[sr.relaFor];
      if (tgt === undefined || (tgt.flags & SHF_ALLOC) === 0) continue;
      let count = 0;
      for (const r of relas.get(i) ?? []) {
        if (absSet.has(r.type)) count++;
        else if (pcSet.has(r.type) && dynIndex.has(r.sym)) count++;
      }
      if (count === 0) continue;
      sr.flags |= SHF_ALLOC;
      sr.size = count * 24;
      sr.link = DYNSYM;
      dynRel.add(i);
    }
  }

  if (dynamic) {
    secs[DYNSYM].size = dsyms.length * 24;
    secs[DYNSTR].size = dstr.length;
    secs[HASH].size = dhash.length * 4;
  }

  /* ---- `.eh_frame_hdr`（`tcc_eh_frame_hdr`）。长度只认 FDE 的条数：走一遍
   * `.eh_frame`，只数那些「CIE 的增补串是 "zR"、编码是 `DW_EH_PE_udata4|signed|pcrel`」
   * 的记录。头是 4 + 4（eh_frame_ptr）+ 4（条数），后面每条 8 字节。 */
  const EH = findSec('.eh_frame');
  let nfde = 0;
  if (dynamic && EH > 0 && secs[EH].size !== 0) {
    const d = secs[EH].data;
    const u32 = (p) => ((d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0);
    let lastCie = -1;
    let ln = 0;
    while (ln < d.length) {
      const length = u32(ln);
      let take = length !== 0;
      if (take) {
        const cieOff = u32(ln + 4);
        if (cieOff === 0) take = false;                      // 这是一条 CIE，不是 FDE
        else if (cieOff !== lastCie) {
          let p = ln + 8 - cieOff + 4;
          const uleb = () => {
            let v = 0;
            let sh = 0;
            for (;;) {
              const b = d[p++];
              v += (b & 0x7f) * (2 ** sh);
              if ((b & 0x80) === 0) return v;
              sh += 7;
            }
          };
          if (p < 0) take = false;
          else {
            const version = d[p++];
            if ((version === 1 || version === 3) && d[p++] === 0x7a
              && d[p++] === 0x52 && d[p++] === 0) {
              uleb();                                        // code_alignment_factor
              uleb();                                        // data_alignment_factor（sleb）
              p++;                                           // 返回地址列
              if (uleb() === 1 && d[p] === FDE_ENCODING) lastCie = cieOff;
              else take = false;
            } else take = false;
          }
        }
      }
      if (take) nfde++;
      ln += length + 4;
    }
    EHFH = st.newSec('.eh_frame_hdr', SHT_PROGBITS, SHF_ALLOC, 8, 0);
    secs[EHFH].size = 12 + nfde * 8;
  }

  /* ---- `.gnu.hash`（`create_gnu_hash`）：长度算得出来，内容等地址定了再填。 */
  const gnu = {
    nbuckets: 0, symoffset: 0, bloomSize: 0, bloomShift: 6, ndef: 0,
  };
  if (dynamic) {
    let ndef = 0;
    for (const s of dsyms) if (s.shndx !== SHN_UNDEF) ndef++;
    gnu.ndef = ndef;
    gnu.nbuckets = Math.floor(ndef / 4) + 1;
    gnu.symoffset = dsyms.length - ndef;
    gnu.bloomSize = 1;
    while (ndef >= gnu.bloomSize * (1 << (gnu.bloomShift - 3))) gnu.bloomSize *= 2;
    GNUHASH = st.newSec('.gnu.hash', SHT_GNU_HASH, SHF_ALLOC, 8, 0);
    secs[GNUHASH].link = DYNSYM;
    secs[GNUHASH].size = 4 * 4 + 8 * gnu.bloomSize + gnu.nbuckets * 4 + ndef * 4;
  }

  /* ---- `.dynamic` 的标签（`fill_dynamic`，前面还有 `DT_FLAGS`/`DT_FLAGS_1`）。
   * 条数与地址无关，所以长度现在就定得下来，值等摆好了再算一遍。 */
  const dynTagList = (relAddr, relSize) => {
    const at = (i) => (i < 0 ? 0 : secs[i].addr ?? 0);
    const t = [[DT_FLAGS, DF_BIND_NOW], [DT_FLAGS_1, DF_1_NOW]];
    t.push([DT_HASH, at(HASH)]);
    t.push([DT_GNU_HASH, at(GNUHASH)]);
    t.push([DT_STRTAB, at(DYNSTR)]);
    t.push([DT_SYMTAB, at(DYNSYM)]);
    t.push([DT_STRSZ, dstr.length]);
    t.push([DT_SYMENT, 24]);
    t.push([DT_RELA, relAddr]);
    t.push([DT_RELASZ, relSize]);
    t.push([DT_RELAENT, 24]);
    if (RELAPLT >= 0) {
      /* 跳板那一路的四条：DT_PLTGOT / DT_PLTRELSZ / DT_JMPREL / DT_PLTREL。 */
      t.push([3, at(GOT)]);
      t.push([2, secs[RELAPLT].size]);
      t.push([23, at(RELAPLT)]);
      t.push([20, DT_RELA]);
    }
    t.push([DT_RELACOUNT, 0]);
    for (const nm of ['.preinit_array', '.init_array', '.fini_array']) {
      const i = findSec(nm);
      if (i < 0 || secs[i].size === 0) continue;
      const pair = DT_INIT_TAGS.get(nm);
      t.push([pair[0], at(i)]);
      t.push([pair[1], secs[i].size]);
    }
    for (const nm of ['.init', '.fini']) {
      const i = findSec(nm);
      if (i < 0 || secs[i].size === 0) continue;
      t.push([nm === '.init' ? 12 : 13, at(i)]);
    }
    t.push([DT_NULL, 0]);
    return t;
  };
  if (DYNA >= 0) secs[DYNA].size = dynTagList(0, 0).length * 16;

  /* ---- set_sec_sizes + alloc_sec_names。
   *
   * `.shstrtab` 是**最后**造的一条（`e_shstrndx = shnum - 1` 靠的就是这个）。 */
  const SHSTR = secs.length;
  secs.push({
    name: '.shstrtab',
    type: SHT_STRTAB,
    flags: 0,
    al: 1,
    ent: 0,
    link: 0,
    info: 0,
    data: [],
    size: 0,
    relaFor: 0,
  });
  /* 非 alloc 的节 `sh_size` 一直是 0（`set_sec_sizes` 只填 alloc 的那些）——
   * 于是它们在可执行文件里连名字都没有，最后被摘掉。 */
  const shSize = (i) => (i === SHSTR || (secs[i].flags & SHF_ALLOC) !== 0 ? secs[i].size : 0);
  const shstr = [0];
  const nameOff = new Map();
  for (let i = 1; i <= SHSTR; i++) {
    if (!(shSize(i) !== 0 || i === SHSTR || (secs[i].flags & SHF_ALLOC) !== 0)) continue;
    nameOff.set(i, shstr.length);
    for (let k = 0; k < secs[i].name.length; k++) shstr.push(secs[i].name.charCodeAt(k));
    shstr.push(0);
  }
  secs[SHSTR].data = shstr;
  secs[SHSTR].size = shstr.length;

  // ---- sort_sections：插入排序，同键保持原次序
  const ord = [0];
  const cls = [0];
  for (let i = 1; i <= SHSTR; i++) {
    const s = secs[i];
    const named = nameOff.has(i);
    let hasAllocReloc = false;
    for (let r = 1; r <= SHSTR; r++) {
      if (secs[r].relaFor === i && (secs[r].flags & SHF_ALLOC) !== 0) hasAllocReloc = true;
    }
    /* `.shstrtab` 是最后一条 —— `sort_sections` 把它的 `k` 直接按成 0xff。 */
    const k = sectionClass(s, i, named, BSS, hasAllocReloc, i === SHSTR, i === GOT,
      i === INTERP, i === RELAPLT);
    let n = ord.length;
    ord.push(i);
    cls.push(k);
    while (n > 1 && k < cls[n - 1]) {
      cls[n] = cls[n - 1];
      ord[n] = ord[n - 1];
      n--;
    }
    cls[n] = k;
    ord[n] = i;
  }

  // ---- 数一数要几个 PT_LOAD，同时算 shnum 与每一条的 f
  let shnum = 1;
  let nload = 0;
  let f0 = 0;
  let relro = false;
  let tls = false;
  const fs = [0];
  for (let i = 1; i <= SHSTR; i++) {
    const s = secs[ord[i]];
    const k = cls[i];
    let f = 0;
    if (k < 0x900) ++shnum;
    if (k < 0x700) {
      f = s.flags & (SHF_ALLOC | SHF_WRITE | SHF_EXECINSTR);
      if (f !== f0 && shSize(ord[i]) !== 0) {
        f0 = f;
        ++nload;
        f |= SHFX_NEWPH;
      }
      if ((s.flags & SHF_TLS) !== 0 && shSize(ord[i]) !== 0) {
        tls = true;
        f |= SHF_TLS;
      }
      if ((k & 0xfff0) === 0x240) {
        relro = true;
        f |= SHFX_RELRO;
      }
    }
    fs.push(f);
  }

  // ---- layout_sections
  let phnum = nload;
  /* 有 `.interp` 就多两个段头：0 号是 PT_PHDR、1 号是 PT_INTERP，PT_LOAD 从 2 号起。 */
  const phfill = INTERP >= 0 ? 2 : 0;
  phnum += phfill;
  const dynaIdx = DYNA >= 0 ? phnum++ : 0;
  const tlsIdx = tls ? phnum++ : 0;
  const ehfrIdx = EHFH >= 0 ? phnum++ : 0;
  const relroIdx = relro ? phnum++ : 0;
  const phdrs = [];
  for (let i = 0; i < phnum; i++) {
    phdrs.push({
      type: 0, flags: 0, off: 0, vaddr: 0, paddr: 0, filesz: 0, memsz: 0, al: 0,
    });
  }
  const fillPhdr = (ph, type, s) => {
    ph.type = type;
    ph.flags = PF_R;
    if (s !== null) {
      if ((s.flags & SHF_WRITE) !== 0) ph.flags |= PF_W;
      ph.off = s.off;
      ph.vaddr = s.addr;
      ph.filesz = s.shsize;
      ph.al = s.al;
    }
    ph.paddr = ph.vaddr;
    ph.memsz = ph.filesz;
    return ph;
  };
  const updatePhdr = (ph, type, s, at, fileOff) => {
    if (ph.type === 0) fillPhdr(ph, type, s);
    ph.filesz = fileOff - ph.off;
    ph.memsz = at - ph.vaddr;
    return ph;
  };

  let fileOffset = align(EHDR_SIZE + phnum * PHDR_SIZE, 4) + shnum * SHDR_SIZE;
  const sAlign = conf.page;
  /* 共享库从 0 起（`if (s1->output_type & TCC_OUTPUT_DYN) addr = 0`）。 */
  let addr = shared ? 0 : conf.start;
  const base = addr;
  addr += fileOffset;

  let ph = null;
  let n = 0;
  for (let i = 1; i <= SHSTR; i++) {
    const s = secs[ord[i]];
    const f = fs[i];
    const al = s.al - 1;
    s.shsize = shSize(ord[i]);
    if (f === 0) {                        // 不装载：只排文件偏移
      fileOffset = (fileOffset + al) & ~al;
      s.off = fileOffset;
      s.addr = 0;
      if (s.type !== SHT_NOBITS) fileOffset += s.shsize;
      continue;
    }
    if ((f & SHFX_NEWPH) !== 0 && n !== 0) {
      /* rwx 变了：段头要新开一个，而一页里不能一半 RX 一半 RW —— 挪到下一页。 */
      if ((addr & (sAlign - 1)) !== 0) addr += sAlign;
    }
    const tmp = addr;
    addr = (addr + al) & ~al;
    fileOffset += addr - tmp;
    s.off = fileOffset;
    s.addr = addr;
    addr += s.shsize;
    if (s.type !== SHT_NOBITS) fileOffset += s.shsize;

    if ((f & SHFX_NEWPH) !== 0) {
      ph = phdrs[phfill + n];
      fillPhdr(ph, PT_LOAD, s);
      ph.al = sAlign;
      if ((f & SHF_EXECINSTR) !== 0) ph.flags |= PF_X;
      if (n === 0) {
        /* 第一个 PT_LOAD 把 ELF 头与程序头也圈进来 —— 内存用量一样，
         * 而 strip 一类的工具认这个。 */
        ph.off = 0;
        ph.vaddr = base;
        ph.paddr = base;
      }
      ++n;
    }
    if (ph !== null) updatePhdr(ph, 0, null, addr, fileOffset);
    if ((f & SHFX_RELRO) !== 0) {
      updatePhdr(phdrs[relroIdx], PT_GNU_RELRO, s, addr, fileOffset).al = 1;
    }
    if ((f & SHF_TLS) !== 0) {
      const ph2 = updatePhdr(phdrs[tlsIdx], PT_TLS, s, addr, fileOffset);
      if (s.al > ph2.al) ph2.al = s.al;
      if (s.type === SHT_NOBITS) addr -= s.shsize;
    }
  }

  /* ---- 剩下那几个段头（`layout_sections` 末尾那一段）。 */
  if (DYNA >= 0) fillPhdr(phdrs[dynaIdx], PT_DYNAMIC, secs[DYNA]);
  if (EHFH >= 0) fillPhdr(phdrs[ehfrIdx], PT_GNU_EH_FRAME, secs[EHFH]);
  if (INTERP >= 0) fillPhdr(phdrs[1], PT_INTERP, secs[INTERP]);
  if (phfill !== 0) {
    const p0 = phdrs[0];
    p0.off = EHDR_SIZE;
    p0.vaddr = base + EHDR_SIZE;
    p0.filesz = phnum * PHDR_SIZE;
    p0.al = 4;
    fillPhdr(p0, PT_PHDR, null);
  }

  // ---- 节的字节：可以落笔了
  for (let i = 1; i <= SHSTR; i++) {
    const s = secs[i];
    s.bytes = s.type === SHT_NOBITS ? new Uint8Array(0) : new Uint8Array(s.data);
  }

  // ---- relocate_syms + relocate_sections
  const symAddr = (idx) => {
    const s = syms[idx];
    if (s.shndx === SHN_UNDEF) {
      if (Math.floor(s.info / 16) === STB_WEAK) return 0;
      /* `.dynsym` 里有这个名字就认（`relocate_syms` 里那句 `find_elf_sym`）——
       * 造共享库时未定义的全局符号都进了 `.dynsym`，留给装载时解析。 */
      if (dynamic && dynByName.has(s.name)) return 0;
      throw new OmniError(`elf: 未定义的符号 '${s.name}'`);
    }
    if (s.shndx === SHN_ABS) return s.value;
    if (s.shndx >= SHN_LORESERVE) return 0;
    return secs[s.shndx].addr + s.value;
  };
  /* ---- GOT 的头一格记 `.dynamic` 的地址（32 位写，tcc 那句是 `write32le`）。 */
  if (GOT >= 0 && DYNA >= 0) {
    const g = secs[GOT].bytes;
    const a = secs[DYNA].addr;
    g[0] = a & 0xff; g[1] = (a >> 8) & 0xff; g[2] = (a >> 16) & 0xff; g[3] = (a >>> 24) & 0xff;
  }

  /* ---- relocate_plt。
   *
   * `create_plt_entry` 落笔时只知道 GOT 里那一格的**偏移**，取址要的地址差得等摆好了
   * 才算得出来 —— 这一趟就是回填那几处。`.rela.plt` 里的 `r_offset` 这会儿还是 GOT
   * 里的偏移（换成绝对地址是 `relocate_sections` 末尾的事），所以每一格跳板对应的
   * GOT 单元也在这儿写：动态链接器第一次跳进来之前，它得指着解析用的那段。
   *
   * 静态那一路不叫这一趟（`elf_output_file` 里那句在 `if (dynamic)` 里头）。 */
  if (dynamic && PLT >= 0) {
    const p = secs[PLT].bytes;
    const dvp = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const gotB = secs[GOT].bytes;
    const dvgot = new DataView(gotB.buffer, gotB.byteOffset, gotB.byteLength);
    const pltAddr = secs[PLT].addr;
    const gotAddr = secs[GOT].addr;
    if (machine === EM_X86_64) {
      const x = gotAddr - pltAddr - 6;
      dvp.setInt32(2, dvp.getInt32(2, true) + x, true);
      dvp.setInt32(8, dvp.getInt32(8, true) + x - 6, true);
      for (let at = 16; at < p.length; at += 16) {
        dvp.setInt32(at + 2, dvp.getInt32(at + 2, true) + x - at, true);
      }
      /* GOT 那一格先指着「本格跳板的第二条指令」——push 那一句，动态链接器由此
       * 认出是哪一格要解析。 */
      let x2 = pltAddr + 16 + 6;
      for (const r of relas.get(RELAPLT) ?? []) {
        dvgot.setBigUint64(r.at, BigInt(x2), true);
        x2 += 16;
      }
    } else {
      const page = (v) => Math.floor(v / 4096);
      const adrp = (off) => ((0x90000000 | 16 | ((off & 0x1ffffc) << 3)
        | ((off & 3) << 29)) >>> 0);
      const ldrX17 = (a2) => ((0xf9400000 | 17 | (16 << 5) | ((a2 & 0xff8) << 7)) >>> 0);
      const addX16 = (a2) => ((0x91000000 | 16 | (16 << 5) | ((a2 & 0xfff) << 10)) >>> 0);
      const BR_X17 = 0xd61f0220;
      const NOP = 0xd503201f;
      /* 头一格 32 字节：先把 x16/x30 压栈，再从 GOT 的第三格取解析例程的地址。 */
      const got0 = gotAddr + 16;
      dvp.setUint32(0, 0xa9bf7bf0, true);          // stp x16,x30,[sp,#-16]!
      dvp.setUint32(4, adrp(page(got0) - page(pltAddr)), true);
      dvp.setUint32(8, ldrX17(got0), true);
      dvp.setUint32(12, addX16(got0), true);
      dvp.setUint32(16, BR_X17, true);
      dvp.setUint32(20, NOP, true);
      dvp.setUint32(24, NOP, true);
      dvp.setUint32(28, NOP, true);
      for (let at = 32; at < p.length; at += 16) {
        const target = gotAddr + Number(dvp.getBigUint64(at, true));
        const pc = pltAddr + at;
        dvp.setUint32(at, adrp(page(target) - page(pc)), true);
        dvp.setUint32(at + 4, ldrX17(target), true);
        dvp.setUint32(at + 8, addX16(target), true);
        dvp.setUint32(at + 12, BR_X17, true);
      }
      /* arm64 的每一格都从 `.plt` 头上那一段进，GOT 里填的于是都是 `.plt` 的地址。 */
      for (const r of relas.get(RELAPLT) ?? []) {
        dvgot.setBigUint64(r.at, BigInt(pltAddr), true);
      }
    }
  }

  /* ---- relocate_syms(dynsym, 2)：有定义的加上节的地址。 */
  for (const s of dsyms) {
    if (s.shndx !== SHN_UNDEF && s.shndx < SHN_LORESERVE) s.value += secs[s.shndx].addr;
  }

  const abs64 = ABS64_RELOC.get(machine);
  for (const [si, list] of relas) {
    const tgt = secs[secs[si].relaFor];
    if (tgt === undefined || tgt.bytes.length === 0) continue;
    /* 动态那一路的 `.got` 不在这儿落笔（`relocate_sections` 里那个 `s != s1->got`）：
     * GLOB_DAT 那几格留给动态链接器，RELATIVE 那几格由 `fill_local_got_entries` 填。 */
    const skip = dynamic && secs[si].relaFor === GOT;
    /* 变成 alloc 的那几张表要**原地改写**：留下的条目往前挤（tcc 里那个 `qrel`），
     * 符号号换成 `.dynsym` 的号，加数按落笔前的内容算。 */
    const qrel = dynRel.has(si) ? [] : null;
    const dvt = qrel === null ? null
      : new DataView(tgt.bytes.buffer, tgt.bytes.byteOffset, tgt.bytes.byteLength);
    for (const r of list) {
      if (skip) continue;
      /* `R_XXX_RELATIVE` 在 ELF 上什么都不做 —— PE 那一路才往里写 RVA。 */
      if ((machine === EM_X86_64 && r.type === R_X86_64_RELATIVE)
        || (machine === EM_AARCH64 && r.type === R_AARCH64_RELATIVE)) continue;
      const val = symAddr(r.sym) + Number(r.add);
      let apply = true;
      if (qrel !== null) {
        const esym = dynIndex.get(r.sym) ?? 0;
        if (absSet.has(r.type)) {
          if (esym !== 0) {
            /* 别人能顶掉的符号：这一条原样留给装载器（本地**不**落笔）。 */
            qrel.push({
              at: r.at, sym: esym, type: r.type, add: r.add,
            });
            apply = false;
          } else {
            /* 局部符号：装载时按基址挪一挪就行 —— RELATIVE，加数是落笔后的值。 */
            const old = r.type === abs64
              ? Number(dvt.getBigInt64(r.at, true)) : dvt.getInt32(r.at, true);
            qrel.push({
              at: r.at, sym: 0, type: relative, add: BigInt(old + val),
            });
          }
        } else if (pcSet.has(r.type) && esym !== 0) {
          qrel.push({
            at: r.at, sym: esym, type: r.type, add: BigInt(dvt.getInt32(r.at, true)) + r.add,
          });
          apply = false;
        }
      }
      if (!apply) continue;
      const g = gotOff.get(r.sym);
      relocateOne(machine, r.type, tgt.bytes, r.at, tgt.addr + r.at,
        val, 0, false,
        g === undefined ? undefined : secs[GOT].addr + g);
    }
    if (qrel !== null) {
      relas.set(si, qrel);
      secs[si].size = qrel.length * 24;
    }
  }

  /* ---- `.rela.*` 是装载的那些：`r_offset` 要换成绝对地址（`relocate_sections` 末尾）。
   * 顺手把 `update_reloc_sections` 要的那两格算出来 —— `.dynamic` 里的 DT_RELA/DT_RELASZ。 */
  let relAddr = 0;
  let relSize = 0;
  for (let i = 1; i <= SHSTR; i++) {
    if (secs[i].type !== SHT_RELA || (secs[i].flags & SHF_ALLOC) === 0) continue;
    const tgt = secs[secs[i].relaFor];
    for (const r of relas.get(i) ?? []) r.at += tgt.addr;
    /* `update_reloc_sections` 把 `.rela.plt` 摘出去不算 —— DT_RELA 那一段说的是
     * 「剩下那几张接成连着的一块」，跳板那张由 DT_JMPREL 单独说。 */
    if (i === RELAPLT) continue;
    if (relSize === 0) relAddr = secs[i].addr;
    relSize += secs[i].size;
  }

  /* ---- fill_local_got_entries：局部符号那几条重定位改成「0 号符号 + 加数」。
   * GOT 那一格**不填**（RELA 的架构上 tcc 只动加数，值留给动态链接器写）。 */
  if (dynamic && GOT >= 0) {
    for (const r of relas.get(RELAGOT) ?? []) {
      if (r.local !== true) continue;
      r.add = BigInt(symAddr(r.sym));
      r.sym = 0;
      r.dynSym = 0;
    }
  }

  /* ---- update_gnu_hash：`.dynsym` 按桶重排，`.rela.got` 里的号跟着改，
   * 老哈希表最后重建一遍。 */
  const gnuBuckets = [];
  const gnuChain = [];
  const gnuBloom = [];
  if (dynamic) {
    const nb = dsyms.length;
    const hashes = new Array(nb).fill(0);
    const newSyms = [];
    const map = new Array(nb).fill(0);
    for (let i = 0; i < nb; i++) {
      if (dsyms[i].shndx === SHN_UNDEF) {
        map[i] = newSyms.length;
        newSyms.push(dsyms[i]);
      } else hashes[i] = gnuHash(dsyms[i].name);
    }
    for (let i = 0; i < gnu.bloomSize; i++) gnuBloom.push(0n);
    const buck = new Array(gnu.nbuckets).fill(null);
    for (let i = 0; i < nb; i++) {
      if (dsyms[i].shndx === SHN_UNDEF) continue;
      const b = hashes[i] % gnu.nbuckets;
      if (buck[b] === null) buck[b] = [i];
      else buck[b].push(i);
    }
    for (let b = 0; b < gnu.nbuckets; b++) {
      if (buck[b] === null) {
        gnuBuckets.push(0);
        continue;
      }
      gnuBuckets.push(newSyms.length);
      for (const cur of buck[b]) {
        map[cur] = newSyms.length;
        newSyms.push(dsyms[cur]);
        gnuChain.push(hashes[cur] & ~1);
        gnuBloom[Math.floor(hashes[cur] / 64) % gnu.bloomSize] |= (1n << BigInt(hashes[cur] % 64))
          | (1n << BigInt((hashes[cur] >>> gnu.bloomShift) % 64));
      }
      gnuChain[gnuChain.length - 1] |= 1;
    }
    dsyms.length = 0;
    for (const s of newSyms) dsyms.push(s);
    for (const [si, list] of relas) {
      if (secs[si].link !== DYNSYM) continue;
      for (const r of list) r.dynSym = map[r.dynSym ?? r.sym] ?? 0;
    }
    rebuildDynHash(dhash[0]);
  }

  // ---- 入口（`get_sym_addr`，找不到就退回 `.text` 的地址）
  const entryName = inp.entryName === undefined ? '_start' : inp.entryName;
  const ei = byName.get(entryName);
  const entry = ei === undefined ? secs[TEXT].addr : symAddr(ei);

  /* ---- reorder_sections：0x900 那一类摘掉，剩下的按排好的次序重新编号。 */
  const backmap = new Array(SHSTR + 1).fill(0);
  const out = [];
  for (let i = 1; i <= SHSTR; i++) {
    if (cls[i] >= 0x900) continue;
    out.push(ord[i]);
    backmap[ord[i]] = out.length;
  }
  if (out.length + 1 !== shnum) {
    throw new OmniError(`elf: 节数算成了 ${shnum}，摆出来 ${out.length + 1} 条`);
  }
  /* `.dynsym` 是要写进文件的 —— 里面的 `st_shndx` 得换成**重排之后**的节号
   * （`reorder_sections` 里那一圈 `sym->st_shndx = backmap[...]`）。 */
  for (const s of dsyms) {
    if (s.shndx !== SHN_UNDEF && s.shndx < SHN_LORESERVE) s.shndx = backmap[s.shndx];
  }

  /* ---- 动态那几条节的字节：地址都定了，现在才填得出来。 */
  if (dynamic) {
    const put = (i, bytes) => { secs[i].bytes = bytes; };
    // .dynsym
    const ds = new Uint8Array(dsyms.length * 24);
    const dvs = new DataView(ds.buffer);
    for (let k = 0; k < dsyms.length; k++) {
      const s = dsyms[k];
      dvs.setUint32(k * 24, s.strx, true);
      ds[k * 24 + 4] = s.info;
      ds[k * 24 + 5] = s.other;
      dvs.setUint16(k * 24 + 6, s.shndx, true);
      dvs.setBigUint64(k * 24 + 8, BigInt(s.value), true);
      dvs.setBigUint64(k * 24 + 16, BigInt(s.size), true);
    }
    put(DYNSYM, ds);
    put(DYNSTR, new Uint8Array(dstr));
    // .hash
    const hb = new Uint8Array(dhash.length * 4);
    const dvh = new DataView(hb.buffer);
    for (let k = 0; k < dhash.length; k++) dvh.setUint32(k * 4, dhash[k] >>> 0, true);
    put(HASH, hb);
    // .gnu.hash
    const gh = new Uint8Array(secs[GNUHASH].size);
    const dvg = new DataView(gh.buffer);
    dvg.setUint32(0, gnu.nbuckets, true);
    dvg.setUint32(4, gnu.symoffset, true);
    dvg.setUint32(8, gnu.bloomSize, true);
    dvg.setUint32(12, gnu.bloomShift, true);
    for (let k = 0; k < gnu.bloomSize; k++) dvg.setBigUint64(16 + k * 8, gnuBloom[k], true);
    const bAt = 16 + gnu.bloomSize * 8;
    for (let k = 0; k < gnu.nbuckets; k++) dvg.setUint32(bAt + k * 4, gnuBuckets[k], true);
    const cAt = bAt + gnu.nbuckets * 4;
    for (let k = 0; k < gnuChain.length; k++) dvg.setUint32(cAt + k * 4, gnuChain[k] >>> 0, true);
    put(GNUHASH, gh);
    // .dynamic
    const tags = dynTagList(relAddr, relSize);
    const db = new Uint8Array(tags.length * 16);
    const dvd = new DataView(db.buffer);
    for (let k = 0; k < tags.length; k++) {
      dvd.setBigUint64(k * 16, BigInt(tags[k][0]), true);
      dvd.setBigUint64(k * 16 + 8, BigInt(tags[k][1]), true);
    }
    put(DYNA, db);
    // .eh_frame_hdr
    if (EHFH >= 0) {
      const hdr = new Uint8Array(secs[EHFH].size);
      const dve = new DataView(hdr.buffer);
      for (let k = 0; k < 4; k++) hdr[k] = EHFH_HEAD[k];
      dve.setInt32(4, secs[EH].addr - secs[EHFH].addr - 4, true);
      dve.setUint32(8, nfde, true);
      /* FDE 的表：每条是「函数地址 - .eh_frame_hdr 的地址」与「FDE 的位置 - 同上」，
       * 按前者排序（`sort_eh_table`）。 */
      const d = secs[EH].bytes;
      const dvf = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const rows = [];
      let ln = 0;
      while (ln < d.length) {
        const length = dvf.getUint32(ln, true);
        if (length !== 0 && dvf.getUint32(ln + 4, true) !== 0) {
          const fdeOff = secs[EH].addr + ln - secs[EHFH].addr;
          rows.push([(dvf.getInt32(ln + 8, true) + fdeOff + 8) | 0, fdeOff]);
        }
        ln += length + 4;
      }
      rows.sort((a, b) => ((a[0] >>> 0) - (b[0] >>> 0)));
      for (let k = 0; k < rows.length && k < nfde; k++) {
        dve.setInt32(12 + k * 8, rows[k][0], true);
        dve.setInt32(12 + k * 8 + 4, rows[k][1], true);
      }
      put(EHFH, hdr);
    }
    // .rela.got / .rela.plt / 变成 alloc 的那几张
    for (const ri of [RELAGOT, RELAPLT, ...dynRel]) {
      if (ri < 0) continue;
      const list = relas.get(ri);
      const rb = new Uint8Array(list.length * 24);
      const dvr = new DataView(rb.buffer);
      for (let k = 0; k < list.length; k++) {
        const r = list[k];
        dvr.setBigUint64(k * 24, BigInt(r.at), true);
        dvr.setBigUint64(k * 24 + 8,
          BigInt(r.dynSym ?? r.sym) * 4294967296n + BigInt(r.type), true);
        dvr.setBigInt64(k * 24 + 16, r.add, true);
      }
      secs[ri].bytes = rb;
    }
  }

  return {
    machine, secs, out, backmap, phdrs, phnum, shnum, entry, nameOff, fileOffset, shared,
  };
}

/** 摆好之后写成字节（`tcc_output_elf`）。 */
export function elfExe(inp) {
  const r = elfExeImage(inp);
  const {
    secs, out, backmap, phdrs, phnum, shnum,
  } = r;
  const shoff = align(EHDR_SIZE + phnum * PHDR_SIZE, 4);

  let end = shoff + shnum * SHDR_SIZE;
  for (const i of out) {
    if (secs[i].type === SHT_NOBITS) continue;
    end = Math.max(end, secs[i].off + secs[i].shsize);
  }
  const b = new Uint8Array(end);
  const dv = new DataView(b.buffer);

  // ---- ELF 头
  b[0] = 0x7f; b[1] = 0x45; b[2] = 0x4c; b[3] = 0x46;
  b[4] = 2; b[5] = 1; b[6] = 1;
  dv.setUint16(16, r.shared ? ET_DYN : ET_EXEC, true);
  dv.setUint16(18, r.machine, true);
  dv.setUint32(20, 1, true);
  dv.setBigUint64(24, BigInt(r.entry), true);
  dv.setBigUint64(32, BigInt(phnum > 0 ? EHDR_SIZE : 0), true);
  dv.setBigUint64(40, BigInt(shoff), true);
  dv.setUint32(48, 0, true);
  dv.setUint16(52, EHDR_SIZE, true);
  dv.setUint16(54, phnum > 0 ? PHDR_SIZE : 0, true);
  dv.setUint16(56, phnum, true);
  dv.setUint16(58, SHDR_SIZE, true);
  dv.setUint16(60, shnum, true);
  dv.setUint16(62, shnum - 1, true);

  // ---- 程序头
  for (let i = 0; i < phnum; i++) {
    const p = phdrs[i];
    const o = EHDR_SIZE + i * PHDR_SIZE;
    dv.setUint32(o, p.type, true);
    dv.setUint32(o + 4, p.flags, true);
    dv.setBigUint64(o + 8, BigInt(p.off), true);
    dv.setBigUint64(o + 16, BigInt(p.vaddr), true);
    dv.setBigUint64(o + 24, BigInt(p.paddr), true);
    dv.setBigUint64(o + 32, BigInt(p.filesz), true);
    dv.setBigUint64(o + 40, BigInt(p.memsz), true);
    dv.setBigUint64(o + 48, BigInt(p.al), true);
  }

  // ---- 节头表（0 号全是 0）
  for (let k = 0; k < out.length; k++) {
    const s = secs[out[k]];
    const o = shoff + (k + 1) * SHDR_SIZE;
    dv.setUint32(o, r.nameOff.get(out[k]) ?? 0, true);
    dv.setUint32(o + 4, s.type, true);
    dv.setBigUint64(o + 8, BigInt(s.flags), true);
    dv.setBigUint64(o + 16, BigInt(s.addr), true);
    dv.setBigUint64(o + 24, BigInt(s.off), true);
    dv.setBigUint64(o + 32, BigInt(s.shsize), true);
    dv.setUint32(o + 40, s.link === 0 ? 0 : backmap[s.link], true);
    dv.setUint32(o + 44, s.type === SHT_RELA ? backmap[s.info] : s.info, true);
    dv.setBigUint64(o + 48, BigInt(s.al), true);
    dv.setBigUint64(o + 56, BigInt(s.ent), true);
  }

  // ---- 节的内容
  for (const i of out) {
    const s = secs[i];
    if (s.type === SHT_NOBITS || s.shsize === 0) continue;
    b.set(s.bytes.subarray(0, s.shsize), s.off);
  }
  return { bytes: b, machine: r.machine, entry: r.entry, shnum, phnum };
}
