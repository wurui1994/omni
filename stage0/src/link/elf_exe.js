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

const STB_WEAK = 2;

const PT_LOAD = 1;
const PT_TLS = 7;
const PT_GNU_RELRO = 0x6474e552;

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

/** `ELF_START_ADDR` 与 `ELF_PAGE_SIZE` —— 每条腿的 `*-link.c` 开头那两行。 */
function targetConf(machine) {
  if (machine === EM_X86_64) return { start: 0x400000, page: 0x1000 };
  if (machine === EM_AARCH64) return { start: 0x400000, page: 0x10000 };
  throw new OmniError(`elf: 还不会给 ${machine} 号架构写可执行文件`);
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
function sectionClass(s, i, named, bss, hasAllocReloc, isLast, isGot) {
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
  else if (s.type === SHT_RELA) k = 0x20;
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

  /* ---- build_got_entries（静态那一支）。
   *
   * 两趟：第一趟只管代码那类（`R_JMP_SLOT`，要连 `.plt` 一起造），第二趟管数据类
   * （`R_GLOB_DAT`）—— arm64 不许两类混在一张表里，所以顺序是**写死**的。
   * GOT 那一格的值不是这一步写的：`.rela.got` 里那条 `R_GLOB_DAT` 在
   * `relocate_sections` 落笔时把符号地址写进去。 */
  const gotOff = new Map();
  let GOT = -1;
  let RELAGOT = -1;
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
    st.setSym({
      name: '_GLOBAL_OFFSET_TABLE_', value: 0, size: 0, info: 1 * 16 + 1, other: 0, shndx: GOT,
    });
  };
  const putGotReloc = (at, type, sym) => {
    if (RELAGOT < 0) {
      RELAGOT = secs.length;
      secs.push({
        name: '.rela.got',
        type: SHT_RELA,
        flags: 0,
        al: 8,
        ent: 24,
        link: 0,
        info: GOT,
        data: [],
        size: 0,
        relaFor: GOT,
      });
      relas.set(RELAGOT, []);
    }
    const list = relas.get(RELAGOT);
    list.push({ at, sym, type, add: 0n });
    secs[RELAGOT].size = list.length * 24;
  };
  const globDat = machine === EM_X86_64 ? R_X86_64_GLOB_DAT : R_AARCH64_GLOB_DAT;
  const jmpSlot = machine === EM_X86_64 ? R_X86_64_JUMP_SLOT : R_AARCH64_JUMP_SLOT;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < secs.length; i++) {
      if (secs[i].type !== SHT_RELA) continue;
      const list = relas.get(i);
      if (list === undefined) continue;
      for (const r of list) {
        const g = gotpltEntryType(machine, r.type);
        if (g === NO_GOTPLT) continue;
        const sym = syms[r.sym];
        if (g === AUTO_GOTPLT) {
          /* 没有 dynsym（静态）：未定义的往下走，有定义的一律不要 GOT。 */
          if (sym.shndx === SHN_ABS) {
            if (sym.value === 0) continue;
          } else if (sym.shndx !== SHN_UNDEF) continue;
        }
        /* x86_64 上「有定义的 PLT32/PC32」在可执行文件里降成 PC32 —— 不走 PLT。 */
        if (machine === EM_X86_64 && (r.type === R_X86_64_PLT32 || r.type === R_X86_64_PC32)
          && sym.shndx !== SHN_UNDEF) {
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
        if (rt === jmpSlot) throw new OmniError(`elf: 符号 '${sym.name}' 要一条 .plt，还没写`);
        if (gotOff.has(r.sym)) continue;
        const off = secs[GOT].size;
        secs[GOT].size = off + 8;
        for (let k = 0; k < 8; k++) secs[GOT].data.push(0);
        gotOff.set(r.sym, off);
        putGotReloc(off, rt, r.sym);
      }
    }
  }

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
    const k = sectionClass(s, i, named, BSS, hasAllocReloc, i === SHSTR, i === GOT);
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
  const phfill = 0;                       // 没有 .interp，也就没有 PT_PHDR/PT_INTERP
  const tlsIdx = tls ? phnum++ : 0;
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
  let addr = conf.start;
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
      throw new OmniError(`elf: 未定义的符号 '${s.name}'`);
    }
    if (s.shndx === SHN_ABS) return s.value;
    if (s.shndx >= SHN_LORESERVE) return 0;
    return secs[s.shndx].addr + s.value;
  };
  for (const [si, list] of relas) {
    const tgt = secs[secs[si].relaFor];
    if (tgt === undefined || tgt.bytes.length === 0) continue;
    for (const r of list) {
      /* `R_XXX_RELATIVE` 在 ELF 上什么都不做 —— PE 那一路才往里写 RVA。 */
      if ((machine === EM_X86_64 && r.type === R_X86_64_RELATIVE)
        || (machine === EM_AARCH64 && r.type === R_AARCH64_RELATIVE)) continue;
      const g = gotOff.get(r.sym);
      relocateOne(machine, r.type, tgt.bytes, r.at, tgt.addr + r.at,
        symAddr(r.sym) + Number(r.add), 0, false,
        g === undefined ? undefined : secs[GOT].addr + g);
    }
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

  return {
    machine, secs, out, backmap, phdrs, phnum, shnum, entry, nameOff, fileOffset,
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
  dv.setUint16(16, ET_EXEC, true);
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
