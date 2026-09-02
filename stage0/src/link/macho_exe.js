/* Mach-O 可执行文件的写出 —— ADR-0017 第 11 步，第九刀第五十五片。
 *
 * 三个格式里这是最后一个：PE（四十七到五十二片）、ELF（五十三、五十四片），
 * 现在是 macOS 的 Mach-O。尺子照旧是 tcc：
 *
 *   <target>-osx-tcc -nostdlib a.o -o a.out
 *
 * `-nostdlib` 是因为 tcc 自己的 `libtcc1.a` 在交叉编译出来的目录里叫
 * `<target>-osx-libtcc1.a`，`-B` 也找不着；而 `tcc_add_runtime` 在 `nostdlib`
 * 下一件事都不做，剩下的正好是「摆放 + 写出」这一段。
 *
 * Mach-O 与前两个格式差得最远的几处：
 *
 *  - **没有节头表**。文件里是「段（segment）套节（section）」，段头就是加载命令
 *    （`LC_SEGMENT_64`），节头紧跟在段头后面。ELF 的节号只活在 tcc 的内存里，
 *    最后靠 `elfsectomacho` 换成 Mach-O 的节号（1 起，跨段连续编号）。
 *  - **节按用途归类**（`enum skind`）：`.text` 一类归 `sk_text`、`.data.ro` 归
 *    `sk_ro_data`、`.got` 归 `sk_nl_ptr`……每一类写死了落在哪个段里
 *    （`skinfo[].seg_initial`），于是 `__TEXT` / `__DATA_CONST` / `__DATA` 三个段
 *    的内容是**类**决定的，不是 flags 决定的。
 *  - **动态链接不用符号表，用「链式修正」**（`LC_DYLD_CHAINED_FIXUPS`）：要重定位的
 *    那几个 8 字节格子自己串成一条链，每格里存着「下一格离我几个 4 字节」。
 *    导出的符号也不放符号表，放一棵**前缀树**（`LC_DYLD_EXPORTS_TRIE`）。
 *  - **文件写完还要签名**。tcc 自己 `system("codesign -f -s - <file>")`（
 *    `CONFIG_CODESIGN`）。签名是纯计算，但**签名里含文件名**（ad-hoc 的
 *    identifier 取的是 basename），所以门里两边的文件名要一样。
 *
 * 几格容易写错的：
 *
 *  - `__PAGEZERO` 占满头 4GB（`vmsize = 1 << 32`），于是 `__TEXT` 的 `vmaddr`
 *    正好是 `0x100000000`；头 4096 字节留给 mach 头与加载命令，`curaddr` 从
 *    `vmaddr + 4096` 起 —— 所以 `LC_MAIN` 的 `entryoff` 是「main 的地址减段基址」，
 *    没有 crt 也照样跑。
 *  - `__mh_execute_header` 这个符号是**当场造**的（`tcc_macho_add_destructor`），
 *    值写的是 `-4096`：等 `relocate_syms` 给它加上 `.text` 的地址，正好落回
 *    mach 头那儿。
 *  - `check_relocs` 造 GOT 的时候，`.rela.got` 那几条 `R_JMP_SLOT` **会被同一个
 *    循环再扫一遍**（C 那边 `for (i = 1; i < s1->nb_sections; i++)` 的上界是
 *    每轮重读的），于是每个 GOT 格子在这一趟里领到一条 bind 或 rebase。
 *  - 段页是 16384，不是 4096（`SEG_PAGE_SIZE`）—— 链式修正的「页」也是这个。
 */

import { OmniError } from '../source/diag.js';
import { linkObjects } from './elf_merge.js';
import { relocateOne } from './pe_reloc.js';
import { readObject } from './elf.js';
import { readArchive, alacarte } from './ar.js';
import { readSymbols, SymTab } from './pe_load.js';

const EM_X86_64 = 62;
const EM_AARCH64 = 183;

const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;
const SHT_NOBITS = 8;
const SHT_INIT_ARRAY = 14;
const SHT_FINI_ARRAY = 15;
/** `SHT_LOOS + 42` —— tcc 拿它标「只活在 `__LINKEDIT` 里」的那几条节。 */
const SHT_LINKEDIT = 0x60000000 + 42;

const SHF_WRITE = 0x1;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;

const SHN_UNDEF = 0;
const SHN_ABS = 0xfff1;
const SHN_COMMON = 0xfff2;
const SHN_LORESERVE = 0xff00;
/** `SHN_LOOS + 2`：未定义，但来自某个 dylib —— `relocate_syms` 于是不喊。 */
const SHN_FROMDLL = 0xff20 + 2;

const STB_LOCAL = 0;
const STB_GLOBAL = 1;
const STB_WEAK = 2;
const STT_NOTYPE = 0;
const STT_OBJECT = 1;
const STT_FUNC = 2;
const STT_SECTION = 3;
const STT_FILE = 4;
const STT_TLS = 6;

// ---- mach 头
const MH_MAGIC_64 = 0xfeedfacf;
const MH_EXECUTE = 2;
const MH_DYLIB = 6;
const MH_DYLDLINK = 0x4;
const MH_PIE = 0x200000;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_SUBTYPE_X86_ALL = 3;
const CPU_SUBTYPE_LIB64 = 0x80000000;
const CPU_SUBTYPE_ARM64_ALL = 0;

// ---- 加载命令
const LC_REQ_DYLD = 0x80000000;
const LC_SYMTAB = 0x2;
const LC_DYSYMTAB = 0xb;
const LC_LOAD_DYLIB = 0xc;
const LC_ID_DYLIB = 0xd;
const LC_LOAD_DYLINKER = 0xe;
const LC_SEGMENT_64 = 0x19;
const LC_MAIN = 0x28 | LC_REQ_DYLD;
const LC_SOURCE_VERSION = 0x2a;
const LC_BUILD_VERSION = 0x32;
const LC_DYLD_EXPORTS_TRIE = 0x33 | LC_REQ_DYLD;
const LC_DYLD_CHAINED_FIXUPS = 0x34 | LC_REQ_DYLD;

const SG_READ_ONLY = 0x10;

// ---- 节的类型与属性
const S_REGULAR = 0x0;
const S_ZEROFILL = 0x1;
const S_NON_LAZY_SYMBOL_POINTERS = 0x6;
const S_SYMBOL_STUBS = 0x8;
const S_MOD_INIT_FUNC_POINTERS = 0x9;
const S_MOD_TERM_FUNC_POINTERS = 0xa;
const S_ATTR_PURE_INSTRUCTIONS = 0x80000000;
const S_ATTR_SOME_INSTRUCTIONS = 0x00000400;
const S_ATTR_DEBUG = 0x02000000;

const PLATFORM_MACOS = 1;

const N_UNDF = 0x0;
const N_ABS = 0x2;
const N_EXT = 0x1;
const N_SECT = 0xe;
const N_WEAK_REF = 0x0040;
const N_WEAK_DEF = 0x0080;

const INDIRECT_SYMBOL_LOCAL = 0x80000000;

const EXPORT_SYMBOL_FLAGS_KIND_REGULAR = 0x00;
const EXPORT_SYMBOL_FLAGS_WEAK_DEFINITION = 0x04;

const DYLD_CHAINED_IMPORT = 1;
const DYLD_CHAINED_PTR_64 = 2;
const DYLD_CHAINED_PTR_START_NONE = 0xffff;
const BIND_SPECIAL_DYLIB_FLAT_LOOKUP = -2;

const SEG_PAGE_SIZE = 16384;
/** `__PAGEZERO` 占满头 4GB，`__TEXT` 从这儿起。 */
const START = 0x100000000;

// ---- 类（`enum skind`），序号就是排布的次序
const sk_unknown = 0;
const sk_discard = 1;
const sk_text = 2;
const sk_stubs = 3;
const sk_stub_helper = 4;
const sk_ro_data = 5;
const sk_uw_info = 6;
const sk_nl_ptr = 7;
const sk_debug_info = 8;
const sk_debug_abbrev = 9;
const sk_debug_line = 10;
const sk_debug_aranges = 11;
const sk_debug_str = 12;
const sk_debug_line_str = 13;
const sk_stab = 14;
const sk_stab_str = 15;
const sk_la_ptr = 16;
const sk_init = 17;
const sk_fini = 18;
const sk_rw_data = 19;
const sk_bss = 20;
const sk_linkedit = 21;
const sk_last = 22;

/** `skinfo[]`：每一类落在哪个段、节头里的 flags、节叫什么名字（`null` 表示不造节）。 */
const SKINFO = [];
SKINFO[sk_unknown] = { seg: 0, flags: 0, name: null };
SKINFO[sk_discard] = { seg: 0, flags: 0, name: null };
SKINFO[sk_text] = {
  seg: 1, flags: S_REGULAR | S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS, name: '__text',
};
SKINFO[sk_stubs] = {
  seg: 1,
  flags: S_REGULAR | S_ATTR_PURE_INSTRUCTIONS | S_SYMBOL_STUBS | S_ATTR_SOME_INSTRUCTIONS,
  name: '__stubs',
};
SKINFO[sk_stub_helper] = {
  seg: 1,
  flags: S_REGULAR | S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS,
  name: '__stub_helper',
};
SKINFO[sk_ro_data] = { seg: 2, flags: S_REGULAR, name: '__rodata' };
SKINFO[sk_uw_info] = { seg: 0, flags: 0, name: null };
SKINFO[sk_nl_ptr] = { seg: 2, flags: S_NON_LAZY_SYMBOL_POINTERS, name: '__got' };
SKINFO[sk_debug_info] = { seg: 3, flags: S_REGULAR | S_ATTR_DEBUG, name: '__debug_info' };
SKINFO[sk_debug_abbrev] = { seg: 3, flags: S_REGULAR | S_ATTR_DEBUG, name: '__debug_abbrev' };
SKINFO[sk_debug_line] = { seg: 3, flags: S_REGULAR | S_ATTR_DEBUG, name: '__debug_line' };
SKINFO[sk_debug_aranges] = { seg: 3, flags: S_REGULAR | S_ATTR_DEBUG, name: '__debug_aranges' };
SKINFO[sk_debug_str] = { seg: 3, flags: S_REGULAR | S_ATTR_DEBUG, name: '__debug_str' };
SKINFO[sk_debug_line_str] = {
  seg: 3, flags: S_REGULAR | S_ATTR_DEBUG, name: '__debug_line_str',
};
SKINFO[sk_stab] = { seg: 4, flags: S_REGULAR, name: '__stab' };
SKINFO[sk_stab_str] = { seg: 4, flags: S_REGULAR, name: '__stab_str' };
SKINFO[sk_la_ptr] = { seg: 4, flags: 0x7, name: '__la_symbol_ptr' };
SKINFO[sk_init] = { seg: 4, flags: S_MOD_INIT_FUNC_POINTERS, name: '__mod_init_func' };
SKINFO[sk_fini] = { seg: 4, flags: S_MOD_TERM_FUNC_POINTERS, name: '__mod_term_func' };
SKINFO[sk_rw_data] = { seg: 4, flags: S_REGULAR, name: '__data' };
SKINFO[sk_bss] = { seg: 4, flags: S_ZEROFILL, name: '__bss' };
SKINFO[sk_linkedit] = { seg: 5, flags: S_REGULAR, name: null };

/** `all_segment[]`：`vmaddr` 是 -1 的那几个等排布的时候才知道落在哪儿。 */
const ALL_SEGMENT = [
  { used: 1, name: '__PAGEZERO', vmaddr: 0, vmsize: START, maxprot: 0, initprot: 0, flags: 0 },
  { used: 0, name: '__TEXT', vmaddr: START, vmsize: 0, maxprot: 5, initprot: 5, flags: 0 },
  {
    used: 0, name: '__DATA_CONST', vmaddr: -1, vmsize: 0, maxprot: 3, initprot: 3, flags: SG_READ_ONLY,
  },
  { used: 0, name: '__DWARF', vmaddr: -1, vmsize: 0, maxprot: 7, initprot: 3, flags: 0 },
  { used: 0, name: '__DATA', vmaddr: -1, vmsize: 0, maxprot: 3, initprot: 3, flags: 0 },
  { used: 1, name: '__LINKEDIT', vmaddr: -1, vmsize: 0, maxprot: 1, initprot: 1, flags: 0 },
];

// ---- 重定位号：只认这两个架构
const R_X86_64_64 = 1;
const R_X86_64_PC32 = 2;
const R_X86_64_PLT32 = 4;
const R_X86_64_GOTPCREL = 9;
const R_X86_64_JUMP_SLOT = 7;
const R_AARCH64_ABS64 = 257;
const R_AARCH64_ADR_PREL_PG_HI21 = 275;
const R_AARCH64_LDST8_ABS_LO12_NC = 278;
const R_AARCH64_JUMP_SLOT = 1026;
const R_AARCH64_CALL26 = 283;
const R_AARCH64_ADR_GOT_PAGE = 311;
const R_AARCH64_LD64_GOT_LO12_NC = 312;

const NO_GOTPLT = 0;
const BUILD_GOT_ONLY = 1;
const AUTO_GOTPLT = 2;
const ALWAYS_GOTPLT = 3;

/** `code_reloc()`：这一条是不是「代码里的跳转」——要 PLT 的那种。 */
const CODE_RELOC = new Map([
  [EM_X86_64, new Set([R_X86_64_PC32, R_X86_64_PLT32, R_X86_64_JUMP_SLOT, 24, 31])],
  [EM_AARCH64, new Set([282, R_AARCH64_CALL26, R_AARCH64_JUMP_SLOT, 280, 279])],
]);

/** `gotplt_entry_type()`：抄 `x86_64-link.c` / `arm64-link.c` 里那两张表。 */
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
  if (t === undefined) throw new OmniError(`macho: 还不会 ${machine} 号架构`);
  if (t.no.has(type)) return NO_GOTPLT;
  if (t.always.has(type)) return ALWAYS_GOTPLT;
  if (t.buildOnly.has(type)) return BUILD_GOT_ONLY;
  if (t.auto.has(type)) return AUTO_GOTPLT;
  throw new OmniError(`macho: ${type} 号该不该走 GOT，还没写`);
}

function codeReloc(machine, type) {
  const s = CODE_RELOC.get(machine);
  return s !== undefined && s.has(type) ? 1 : 0;
}

function align(n, to) {
  return Math.ceil(n / to) * to;
}

/** `exact_log2p1(x) - 1`：对齐值换成位数。 */
function log2of(x) {
  let a = 0;
  let v = x;
  while (v > 1) { v = Math.floor(v / 2); a++; }
  return a;
}

function ulebSize(v) {
  let n = 0;
  let x = v;
  do { x = Math.floor(x / 128); n++; } while (x !== 0);
  return n;
}

function ulebPush(out, v) {
  let x = v;
  do {
    const b = x % 128;
    x = Math.floor(x / 128);
    out.push(b | (x !== 0 ? 0x80 : 0));
  } while (x !== 0);
}

function targetConf(machine) {
  if (machine === EM_X86_64) {
    return {
      cputype: CPU_TYPE_X86_64,
      cpusubtype: (CPU_SUBTYPE_LIB64 | CPU_SUBTYPE_X86_ALL) >>> 0,
      stubSize: 6,
      dataPtr: R_X86_64_64,
      jmpSlot: R_X86_64_JUMP_SLOT,
      gotReloc: R_X86_64_GOTPCREL,
      callReloc: R_X86_64_PLT32,
    };
  }
  if (machine === EM_AARCH64) {
    return {
      cputype: CPU_TYPE_ARM64,
      cpusubtype: CPU_SUBTYPE_ARM64_ALL,
      stubSize: 12,
      dataPtr: R_AARCH64_ABS64,
      jmpSlot: R_AARCH64_JUMP_SLOT,
      gotReloc: R_AARCH64_ADR_GOT_PAGE,
      callReloc: R_AARCH64_CALL26,
    };
  }
  throw new OmniError(`macho: 还不会给 ${machine} 号架构写可执行文件`);
}

/** C 里 `name[i]`：越过结尾就是 0。 */
function chAt(s, i) {
  return i < s.length ? s.charCodeAt(i) : 0;
}

/** 节名能不能写成 C 的标识符（`__start_X` / `__stop_X` 认这个）。 */
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

/** `create_trie`：把已经排好的名字按公共前缀分叉。 */
function createTrie(node, from, to, indexStart, trie) {
  let i = from;
  while (i < to) {
    let cur = chAt(trie[i].name, indexStart);
    const start = i++;
    for (; i < to; i++) if (cur !== chAt(trie[i].name, indexStart)) break;
    let end = i;
    let indexEnd;
    if (start === end - 1
      || (chAt(trie[start].name, indexStart) !== 0
        && chAt(trie[start].name, indexStart + 1) === 0)) {
      indexEnd = trie[start].strSize - 1;
    } else {
      indexEnd = indexStart + 1;
      for (;;) {
        cur = chAt(trie[start].name, indexEnd);
        let j = start + 1;
        for (; j < end; j++) if (cur !== chAt(trie[j].name, indexEnd)) break;
        if (chAt(trie[start].name, indexEnd) !== 0
          && chAt(trie[start].name, indexEnd + 1) === 0) {
          end = start + 1;
          indexEnd = trie[start].strSize - 1;
          break;
        }
        if (j !== end) break;
        indexEnd++;
      }
    }
    const child = {
      start, end, indexStart, indexEnd, nChild: 0, child: [],
    };
    node.child.push(child);
    node.nChild++;
    if (start !== end - 1) createTrie(child, start, end, indexEnd, trie);
    i = end;
  }
}

/** `create_seq`：把树摊成一条条记录，顺手把每条在文件里的偏移算出来。 */
function createSeq(state, node, trie) {
  const lastSeq = state.seq.length;
  const retval = state.offset;
  for (let i = 0; i < node.nChild; i++) {
    const nest = node.child[i];
    state.seq.push({
      nChild: i === 0 ? node.nChild : -1, node: nest, offset: state.offset, nestOffset: 0,
    });
    state.offset += (i === 0 ? 2 : 0) + nest.indexEnd - nest.indexStart + 1 + 3;
  }
  for (let i = 0; i < node.nChild; i++) {
    state.seq[lastSeq + i].nestOffset = createSeq(state, node.child[i], trie);
  }
  return retval;
}

/** `triecmp`：'xx' 要排在 'xx1' **后面**。 */
function trieCmp(a, b) {
  const la = a.name.length;
  const lb = b.name.length;
  const n = la < lb ? la : lb;
  if (a.name.slice(0, n) === b.name.slice(0, n)) {
    if (la < lb) return 1;
    return la > lb ? -1 : 0;
  }
  return a.name < b.name ? -1 : 1;
}

/**
 * `export_trie`：导出的符号（有定义的 GLOBAL / WEAK）摊成一棵前缀树的字节。
 *
 * 每个结点是「共同的那一段字符 + 子结点表」，叶子上挂着 flag 与「地址减段基址」。
 */
function exportTrie(syms, secs, vmaddr) {
  const trie = [];
  for (let i = 1; i < syms.length; i++) {
    const s = syms[i];
    const bind = Math.floor(s.info / 16);
    if (s.shndx === SHN_UNDEF || s.shndx >= SHN_LORESERVE) continue;
    if (bind !== STB_GLOBAL && bind !== STB_WEAK) continue;
    let flag = EXPORT_SYMBOL_FLAGS_KIND_REGULAR;
    if (bind === STB_WEAK) flag |= EXPORT_SYMBOL_FLAGS_WEAK_DEFINITION;
    const addr = s.value + secs[s.shndx].addr - vmaddr;
    trie.push({
      name: s.name,
      flag,
      addr,
      strSize: s.name.length + 1,
      termSize: ulebSize(flag) + ulebSize(addr),
    });
  }
  const out = [];
  if (trie.length === 0) return out;
  trie.sort(trieCmp);
  const root = { start: 0, end: 0, indexStart: 0, indexEnd: 0, nChild: 0, child: [] };
  createTrie(root, 0, trie.length, 0, trie);
  const state = { offset: 0, seq: [] };
  createSeq(state, root, trie);
  const saveOffset = state.offset;
  for (const q of state.seq) {
    if (q.node.nChild === 0) {
      q.nestOffset = state.offset;
      state.offset += 1 + trie[q.node.start].termSize + 1;
    }
  }
  const growTo = (n) => { while (out.length < n) out.push(0); };
  for (const q of state.seq) {
    const t = trie[q.node.start];
    if (q.nChild >= 0) {
      growTo(q.offset);
      out.push(0, q.nChild);
    }
    const size = q.node.indexEnd - q.node.indexStart;
    for (let k = 0; k < size; k++) out.push(chAt(t.name, q.node.indexStart + k));
    out.push(0);
    ulebPush(out, q.nestOffset);
  }
  growTo(saveOffset);
  for (const q of state.seq) {
    if (q.node.nChild !== 0) continue;
    const t = trie[q.node.start];
    ulebPush(out, t.termSize);
    ulebPush(out, t.flag);
    ulebPush(out, t.addr);
    out.push(0);
  }
  while ((out.length & 7) !== 0) out.push(0);
  return out;
}

/**
 * `macho_load_tbd`：一份 `.tbd`（SDK 里那种文本 stub）里的安装名与导出符号。
 *
 * 这个「解析器」照抄 tcc 的那几个宏，粗得可以 —— 它不认 YAML，只会
 * 「找到 `install-name: `」「一遍遍找 `symbols: [`，把方括号里的名字一个个撕下来」。
 * 于是 `targets:` 那一格根本不看：x86_64 专属的导出也一并进表。存在性判断够用了。
 */
export function parseTbd(text) {
  let pos = 0;
  const at = (i) => (i < text.length ? text[i] : '');
  const movepast = (s) => {
    const i = text.indexOf(s, pos);
    if (i < 0) return false;
    pos = i + s.length;
    return true;
  };
  const movetoany = (cs) => {
    let i = pos;
    while (i < text.length && !cs.includes(text[i])) i++;
    if (i >= text.length) return false;
    pos = i;
    return true;
  };
  const skipws = () => { while (pos < text.length && (at(pos) === ' ' || at(pos) === '\n')) pos++; };
  const quote = () => { if (at(pos) === "'" || at(pos) === '"') pos++; };
  if (!movepast('install-name: ')) return null;
  skipws();
  quote();
  const start = pos;
  if (!movetoany('\n "\'')) return null;
  const soname = text.slice(start, pos);
  pos++;
  const syms = [];
  for (;;) {
    if (!movepast('symbols: ')) break;
    if (!movepast('[')) break;
    let cont = true;
    while (cont) {
      skipws();
      quote();
      const s0 = pos;
      if (!movetoany(',] "\'')) break;
      const name = text.slice(s0, pos);
      quote();
      if (at(pos) === ' ') pos++;
      skipws();
      if (pos >= text.length || at(pos) === ']') cont = false;
      pos++;
      syms.push(name);
    }
  }
  return { soname, syms };
}

/**
 * `tcc_add_runtime` 那一段：装 dylib（记下安装名与它导出的符号）、按需从 `libtcc1.a`
 * 里取成员。
 *
 * @param inp `{objs, dylibs, libtcc1}`；`dylibs` 每条是一份 `.tbd` 的文本
 * @returns `{objs, dylibNames, dynsym, members}`；`objs` 是「命令行上的那些 + 拉进来的
 *          成员」，次序就是 tcc 装它们的次序
 */
function loadInputs(inp) {
  const objs = [...inp.objs];
  const dylibNames = [];
  const dynsym = new Set();
  for (const text of inp.dylibs === undefined ? [] : inp.dylibs) {
    const d = parseTbd(text);
    if (d === null) throw new OmniError('macho: 这份 .tbd 里没有 install-name');
    if (dylibNames.includes(d.soname)) continue;      // `tcc_add_dllref(...)->found`
    dylibNames.push(d.soname);
    for (const s of d.syms) dynsym.add(s);
  }
  const members = [];
  if (inp.libtcc1 !== undefined) {
    const tab = new SymTab();
    for (const b of inp.objs) tab.addObject(readSymbols(readObject(b)));
    alacarte(readArchive(inp.libtcc1), (n) => tab.isUndef(n), (m) => {
      members.push(m.name);
      objs.push(m.bytes);
      tab.addObject(readSymbols(readObject(m.bytes)));
    });
  }
  return {
    objs, dylibNames, dynsym, members,
  };
}

/**
 * 把几个 Mach-O 目标文件链成一个可执行文件（`macho_output_file` 的 EXE 那一路），
 * 或者一份 dylib（`-shared`，第九刀第六十三片）。
 *
 * @param inp `{objs, entryName, dylibs, libtcc1, shared, outName, installName}`；
 *            `entryName` 默认 `_main`（Mach-O 的名字带下划线），`dylibs` 是几份 `.tbd`
 *            的文本，`libtcc1` 是支持库的字节（按需取用）；`shared` 出 MH_DYLIB，
 *            `LC_ID_DYLIB` 里那个名字是 `installName`，没给就用 `outName`
 *            （tcc 拿的是**输出的文件名**）
 * @returns `{bytes, ncmds, nsects, entryoff, members}`；`bytes` 还**没签名** —— 签名是
 *          `codesign -f -s -` 干的事，tcc 自己也是 `system()` 出去喊的
 */
export function machoExe(inp) {
  const loaded = loadInputs(inp);
  const st = linkObjects(loaded.objs, { rdata: '.data.ro', unwind: false });
  /** `-shared`：MH_DYLIB —— 没有 `__PAGEZERO`，`__TEXT` 从 0 起，多一条 `LC_ID_DYLIB`，
   * 没有 `LC_LOAD_DYLINKER` 与 `LC_MAIN`，没定义的符号一律当「来自别处」。 */
  const shared = inp.shared === true;
  /** `__TEXT` 是第几个段 —— 少了 `__PAGEZERO` 就往前挪一格
   * （tcc 那句 `get_segment(mo, s1->output_type == TCC_OUTPUT_EXE)`）。 */
  const TEXTSEG = shared ? 0 : 1;

  const {
    machine, secs, syms, relas, byName,
  } = st;
  const { TEXT, DATA, RDATA, BSS, SYMTAB } = st.idx;
  const conf = targetConf(machine);
  const findSec = (n) => {
    for (let i = 1; i < secs.length; i++) if (secs[i].name === n) return i;
    return -1;
  };

  /* ---- `put_elf_reloca`：给某一节添一条重定位，头一条顺手把 `.rela<名字>` 那一节造出来。
   * 造析构函数那一段、造 GOT 与桩子都要用它。 */
  const relocSec = new Map();
  for (let i = 1; i < secs.length; i++) {
    if (secs[i].type === SHT_RELA) relocSec.set(secs[i].relaFor, i);
  }
  const putReloc = (target, at, type, sym, add) => {
    let ri = relocSec.get(target);
    if (ri === undefined) {
      ri = st.newSec(`.rela${secs[target].name}`, SHT_RELA, 0, 8, 24);
      secs[ri].link = SYMTAB;
      secs[ri].info = target;
      secs[ri].relaFor = target;
      relocSec.set(target, ri);
      relas.set(ri, []);
    }
    relas.get(ri).push({
      at, sym, type, add: BigInt(add === undefined ? 0 : add),
    });
    secs[ri].size = relas.get(ri).length * 24;
    return ri;
  };

  /* ---- tcc_macho_add_destructor。
   *
   * `__mh_execute_header` 是**当场造**的符号，值写 `-4096`：等 `relocate_syms` 给它
   * 加上 `.text` 的地址，正好落回 mach 头那儿（`.text` 是从段基址 + 4096 起的）。 */
  st.setSym({
    name: '__mh_execute_header',
    value: -4096,
    size: 0,
    info: STB_GLOBAL * 16 + STT_OBJECT,
    other: 0,
    shndx: TEXT,
  });
  const mhSym = byName.get('__mh_execute_header');
  const FINI = findSec('.fini_array') < 0
    ? st.newSec('.fini_array', SHT_PROGBITS, SHF_ALLOC, 8, 0)
    : findSec('.fini_array');
  if (secs[FINI].size !== 0) {
    /* Mach-O 上没有 `.fini_array` 这回事：tcc **当场生成一段代码** ——
     * 一个 `___GLOBAL_init_65535`，里头对每个析构函数调一次 `___cxa_atexit(f, 0,
     * &__mh_execute_header)`，然后把这个函数自己挂到 `.init_array` 上，
     * 再把 `.fini_array` 清空、摘掉 `SHF_ALLOC`。 */
    const initSym = st.setSym({
      name: '___GLOBAL_init_65535',
      value: secs[TEXT].size,
      size: 0,
      info: STB_LOCAL * 16 + STT_FUNC,
      other: 0,
      shndx: TEXT,
    });
    const atExit = st.setSym({
      name: '___cxa_atexit',
      value: 0,
      size: 0,
      info: STB_GLOBAL * 16 + STT_FUNC,
      other: 0,
      shndx: SHN_UNDEF,
    });
    const t = secs[TEXT];
    const push32 = (v) => {
      t.data.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
      t.size += 4;
    };
    const pushB = (bs) => {
      for (const b of bs) t.data.push(b);
      t.size += bs.length;
    };
    const fr = relocSec.get(FINI);
    const dtors = fr === undefined ? [] : (relas.get(fr) ?? []);
    if (machine === EM_AARCH64) {
      push32(0xa9bf7bfd);                          // stp x29, x30, [sp, #-16]!
      push32(0x910003fd);                          // mov x29, sp
      for (const rel of dtors) {
        const base = t.size;
        putReloc(TEXT, base, R_AARCH64_ADR_PREL_PG_HI21, rel.sym, 0);
        push32(0x90000000);                        // adrp x0, dtor@page
        putReloc(TEXT, base + 4, R_AARCH64_LDST8_ABS_LO12_NC, rel.sym, 0);
        push32(0x91000000);                        // add x0, x0, dtor@pageoff
        push32(0xd2800001);                        // mov x1, #0
        putReloc(TEXT, base + 12, R_AARCH64_ADR_PREL_PG_HI21, mhSym, 0);
        push32(0x90000002);                        // adrp x2, mh@page
        putReloc(TEXT, base + 16, R_AARCH64_LDST8_ABS_LO12_NC, mhSym, 0);
        push32(0x91000042);                        // add x2, x2, mh@pageoff
        putReloc(TEXT, base + 20, R_AARCH64_CALL26, atExit, 0);
        push32(0x94000000);                        // bl ___cxa_atexit
      }
      push32(0xa8c17bfd);                          // ldp x29, x30, [sp], #16
      push32(0xd65f03c0);                          // ret
    } else {
      pushB([0x55, 0x48, 0x89, 0xe5]);             // push %rbp; mov %rsp,%rbp
      for (const rel of dtors) {
        const base = t.size;
        pushB([
          0x48, 0x8d, 0x05, 0, 0, 0, 0,            // lea dtor(%rip),%rax
          0x48, 0x89, 0xc7,                        // mov %rax,%rdi
          0x31, 0xc9,                              // xor %ecx,%ecx
          0x89, 0xce,                              // mov %ecx,%esi
          0x48, 0x8d, 0x15, 0, 0, 0, 0,            // lea mh(%rip),%rdx
          0xe8, 0, 0, 0, 0,                        // call ___cxa_atexit
        ]);
        putReloc(TEXT, base + 3, R_X86_64_PC32, rel.sym, -4);
        putReloc(TEXT, base + 17, R_X86_64_PC32, mhSym, -4);
        putReloc(TEXT, base + 22, R_X86_64_PLT32, atExit, -4);
      }
      pushB([0x5d, 0xc3]);                         // pop %rbp; ret
    }
    if (fr !== undefined) {
      relas.set(fr, []);
      secs[fr].size = 0;
    }
    secs[FINI].data = [];
    secs[FINI].size = 0;
    secs[FINI].flags &= ~SHF_ALLOC;
    /* `add_array(s1, ".init_array", init_sym)`：`shf_RELRO` 在非 PE 上就是 `SHF_ALLOC`。 */
    const IA = findSec('.init_array') < 0
      ? st.newSec('.init_array', SHT_PROGBITS, SHF_ALLOC, 8, 0)
      : findSec('.init_array');
    secs[IA].flags = SHF_ALLOC;
    secs[IA].type = SHT_INIT_ARRAY;
    secs[IA].al = 8;
    putReloc(IA, secs[IA].size, conf.dataPtr, initSym, 0);
    for (let k = 0; k < 8; k++) secs[IA].data.push(0);
    secs[IA].size += 8;
  }

  // ---- resolve_common_syms
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

  /* ---- tcc_add_linker_symbols（`resolve_common_syms` 末尾那一句）。
   *
   * 这一段跟 ELF 那一路是同一份代码 —— Mach-O 上一样要 `_etext` / `_edata` / `_end`、
   * 三个数组的 start/end、以及名字能写成 C 标识符的节的 `__start_X` / `__stop_X`。
   * 少了它们，Mach-O 的符号表就短一截（也就少了那 17 条），后面所有偏移全错。 */
  const defined = (n) => {
    const i = byName.get(n);
    return i !== undefined && syms[i].shndx !== SHN_UNDEF;
  };
  const defineSym = (name, sec, off) => st.setSym({
    name, value: off, size: 0, info: STB_GLOBAL * 16 + STT_NOTYPE, other: 0, shndx: sec,
  });
  const setLinkerSym = (name, sec, needRef) => {
    if (!defined(name) && !(needRef && !byName.has(name))) {
      defineSym(name, sec, secs[sec].size);
    }
    if (name.startsWith('_')) setLinkerSym(name.slice(1), sec, true);
  };
  /* 造 dylib 那一路不叫这一趟（`resolve_common_syms` 末尾那句 `if (s1->output_type
   * != TCC_OUTPUT_DLL) tcc_add_linker_symbols(s1)`）—— 少了这十几条符号，
   * 符号表、字符串表与导出的前缀树都跟着短一截。 */
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

  /* ---- create_symtab。
   *
   * 造节的次序是写死的：`__stubs`、`.got`、`CHAINED_FIXUPS`、`EXPORT`、`LEINDIR`、
   * `LESYMTAB`、`LESTRTAB` —— 后五条落在 `__LINKEDIT` 里，摆放的次序就是这个次序。 */
  const STUBS = st.newSec('__stubs', SHT_PROGBITS, SHF_ALLOC | SHF_EXECINSTR, 8, 0);
  const GOT = st.newSec('.got', SHT_PROGBITS, SHF_ALLOC | SHF_WRITE, 8, 0);
  const stubsym = st.setSym({
    name: '.__stubs', value: 0, size: 0, info: STB_LOCAL * 16 + STT_SECTION, other: 0, shndx: STUBS,
  });
  const LE = (name) => st.newSec(name, SHT_LINKEDIT, SHF_ALLOC | SHF_WRITE, 8, 0);
  const CHAINED = LE('CHAINED_FIXUPS');
  const EXPORTS = LE('EXPORT');
  const INDIR = LE('LEINDIR');
  const MSYMTAB = LE('LESYMTAB');
  const MSTRTAB = LE('LESTRTAB');

  /** Mach-O 的字符串表从**一个空格**起头（`put_elf_str(mo->strtab, " ")`）。 */
  const mstr = [0x20, 0];
  const putStr = (name) => {
    const off = mstr.length;
    for (let k = 0; k < name.length; k++) mstr.push(name.charCodeAt(k));
    mstr.push(0);
    return off;
  };
  const nlist = [];
  for (let i = 1; i < syms.length; i++) {
    nlist.push({
      strx: putStr(syms[i].name), type: 0, sect: 0, desc: 0, elf: i,
    });
  }
  while ((mstr.length & 7) !== 0) mstr.push(0);
  /* 局部的在前、有定义的外部符号居中、未定义的在后；后两段还按名字排。
   * 末尾那条 `ea - eb` 让这个序是**全序** —— tcc 用的希尔排序不稳定，靠的就是这一条。 */
  nlist.sort((a, b) => {
    const sa = syms[a.elf];
    const sb = syms[b.elf];
    let r = (Math.floor(sb.info / 16) === STB_LOCAL ? 1 : 0)
      - (Math.floor(sa.info / 16) === STB_LOCAL ? 1 : 0);
    if (r !== 0) return r;
    r = (sa.shndx === SHN_UNDEF ? 1 : 0) - (sb.shndx === SHN_UNDEF ? 1 : 0);
    if (r !== 0) return r;
    if (Math.floor(sa.info / 16) !== STB_LOCAL && sa.name !== sb.name) {
      return sa.name < sb.name ? -1 : 1;
    }
    return a.elf - b.elf;
  });
  secs[MSYMTAB].size = nlist.length * 16;
  secs[MSTRTAB].size = mstr.length;
  const e2msym = new Array(syms.length).fill(-1);
  for (let k = 0; k < nlist.length; k++) e2msym[nlist[k].elf] = k;

  /* ---- check_relocs（`CONFIG_NEW_MACHO` 那一路）。
   *
   * 一趟扫完所有重定位：未定义的符号、以及「代码生成上非得有个地方放地址」的符号
   * （`ALWAYS_GOTPLT_ENTRY`）各领一格 GOT；代码里的跳转再领一条 `__stubs`。
   * 这个循环的上界在 C 那边是**每轮重读**的 `s1->nb_sections` —— 这一趟里新造出来的
   * `.rela.got` / `.rela__stubs` 会被同一个循环接着扫到，于是每个 GOT 格子在那儿
   * 领到一条 bind 或 rebase。 */
  /** `s1->got->reloc->data_offset -= sizeof(rel)`：刚放进去那一条又拿掉。 */
  const dropGotReloc = () => {
    const ri = relocSec.get(GOT);
    const list = relas.get(ri);
    list.pop();
    secs[ri].size = list.length * 24;
  };
  const attrOf = new Map();
  const bindRebase = [];
  const goti = [];
  const indir = [];
  let nrPlt = 0;
  const bindRebaseAdd = (bind, section, rel, attr) => {
    bindRebase.push({
      section,
      bind,
      rel: { ...rel, at: attr === undefined || attr === null ? rel.at : attr.gotOff },
    });
  };
  for (let i = 1; i < secs.length; i++) {
    const sr = secs[i];
    if (sr.type !== SHT_RELA) continue;
    const tgt = sr.relaFor;
    if (secs[tgt].name.startsWith('.debug_')) continue;
    const list = relas.get(i);
    if (list === undefined) continue;
    for (const rel of list) {
      const save = { ...rel };
      const { type } = rel;
      const g = gotpltEntryType(machine, type);
      const forCode = codeReloc(machine, type) !== 0;
      const sym = syms[rel.sym];
      if (sym.shndx === SHN_UNDEF || g === ALWAYS_GOTPLT) {
        let a = attrOf.get(rel.sym);
        if (a === undefined) {
          a = { gotOff: 0, pltOff: -1, dynIndex: 0 };
          attrOf.set(rel.sym, a);
        }
        if (a.dynIndex === 0) {
          a.gotOff = secs[GOT].size;
          a.pltOff = -1;
          a.dynIndex = 1;
          for (let k = 0; k < 8; k++) secs[GOT].data.push(0);
          secs[GOT].size += 8;
          putReloc(GOT, a.gotOff, conf.jmpSlot, rel.sym, 0);
          if (Math.floor(sym.info / 16) === STB_LOCAL) {
            if (sym.shndx === SHN_UNDEF) {
              throw new OmniError(`macho: 局部符号 '${sym.name}' 没有定义`);
            }
            goti.push(INDIRECT_SYMBOL_LOCAL);
          } else {
            goti.push(e2msym[rel.sym]);
            if (sym.shndx === SHN_UNDEF && type === conf.gotReloc) {
              a.pltOff = -bindRebase.length - 2;
              bindRebaseAdd(1, GOT, save, a);
              dropGotReloc();
            }
            if (forCode && sym.shndx === SHN_UNDEF) dropGotReloc();
          }
        }
        if (forCode && sym.shndx === SHN_UNDEF) {
          if (a.pltOff < -1) {
            /* 上面那条 bind 作废 —— 这个符号要走 `__stubs`，不是直接绑 GOT。 */
            bindRebase[-a.pltOff - 2].bind = 2;
            a.pltOff = -1;
          }
          if (a.pltOff === -1) {
            a.pltOff = secs[STUBS].size;
            /* 这一格是 tcc 的一处怪癖：类型不对就**先记下 plt_offset 再走**，
             * 桩子并没造出来；同一个符号下一条重定位于是照着这个偏移改写。 */
            if (type !== conf.callReloc) continue;
            const d = secs[STUBS].data;
            if (machine === EM_X86_64) {
              d.push(0xff, 0x25, 0, 0, 0, 0);              // jmpq *ofs(%rip)
              secs[STUBS].size += 6;
              putReloc(STUBS, a.pltOff + 2, R_X86_64_GOTPCREL, rel.sym, 0);
            } else {
              const w32 = (v) => {
                d.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
              };
              putReloc(STUBS, a.pltOff, R_AARCH64_ADR_GOT_PAGE, rel.sym, 0);
              w32(0x90000010);                             // adrp x16, #sym
              putReloc(STUBS, a.pltOff + 4, R_AARCH64_LD64_GOT_LO12_NC, rel.sym, 0);
              w32(0xf9400210);                             // ldr x16,[x16, #sym]
              w32(0xd61f0200);                             // br x16
              secs[STUBS].size += 12;
            }
            bindRebaseAdd(1, GOT, save, a);
            indir.push(e2msym[rel.sym]);
            nrPlt++;
          }
          rel.sym = stubsym;
          rel.add += BigInt(a.pltOff);
        }
      }
      if (type === conf.dataPtr || type === conf.jmpSlot) {
        bindRebaseAdd(sym.shndx === SHN_UNDEF ? 1 : 0, tgt, save, null);
      }
    }
  }
  const live = bindRebase.filter((b) => b.bind !== 2);
  bindRebase.length = 0;
  for (const b of live) bindRebase.push(b);
  let nBind = 0;
  for (const b of bindRebase) nBind += b.bind;
  for (const v of goti) indir.push(v);
  secs[INDIR].size = indir.length * 4;

  /* ---- check_symbols：局部 / 有定义的外部 / 未定义，三段的起点。
   * 未定义的那些若是弱符号（或来自某个 dylib），改标成 `SHN_FROMDLL`。 */
  let ilocal = -1;
  let iextdef = -1;
  let iundef = -1;
  for (let k = 0; k < nlist.length; k++) {
    const sym = syms[nlist[k].elf];
    const bind = Math.floor(sym.info / 16);
    if (bind === STB_LOCAL) {
      if (ilocal === -1) ilocal = k;
      if (iextdef !== -1 || iundef !== -1) throw new OmniError('macho: 局部符号排到全局后头了');
    } else if (sym.shndx !== SHN_UNDEF) {
      if (iextdef === -1) iextdef = k;
      if (iundef !== -1) throw new OmniError('macho: 有定义的外部符号排到未定义后头了');
    } else {
      if (iundef === -1) iundef = k;
      /* 弱符号、或者某个 dylib 导出了这个名字 —— 那就不是「没定义」，是「来自 dylib」。
       * 造 dylib 时这道筛子整个撤掉（`|| s1->output_type != TCC_OUTPUT_EXE`）：
       * 谁来填由装载时的平坦查找决定。 */
      if (!shared && bind !== STB_WEAK && !loaded.dynsym.has(sym.name)) {
        throw new OmniError(`macho: 符号 '${sym.name}' 没有定义`);
      }
      sym.shndx = SHN_FROMDLL;
    }
  }

  /* ---- collect_sections：先给每条节归类（`enum skind`），类决定它落在哪个段里。
   * 倒着扫是为了让每一类里的次序**跟节号一致**（C 那边是往链表头上插）。 */
  const skSect = [];
  for (let sk = 0; sk < sk_last; sk++) skSect.push([]);
  const usedSegment = ALL_SEGMENT.map((x) => x.used);
  for (let i = secs.length - 1; i >= 1; i--) {
    const s = secs[i];
    let sk = sk_unknown;
    if ((s.flags & SHF_ALLOC) !== 0 || s.name.startsWith('.debug_')) {
      if (s.type === SHT_INIT_ARRAY) sk = sk_init;
      else if (s.type === SHT_FINI_ARRAY) sk = sk_fini;
      else if (s.type === SHT_NOBITS) sk = sk_bss;
      else if (s.type === SHT_SYMTAB) sk = sk_discard;
      else if (s.type === SHT_STRTAB) sk = s.name === '.stabstr' ? sk_stab_str : sk_discard;
      else if (s.type === SHT_RELA) sk = sk_discard;
      else if (s.type === SHT_LINKEDIT) sk = sk_linkedit;
      else if (s.type === SHT_PROGBITS) {
        if (i === STUBS) sk = sk_stubs;
        else if (i === RDATA) sk = sk_ro_data;
        else if (i === GOT) sk = sk_nl_ptr;
        else if (s.name === '.stab') sk = sk_stab;
        else if ((s.flags & SHF_EXECINSTR) !== 0) sk = sk_text;
        else if ((s.flags & SHF_WRITE) !== 0) sk = sk_rw_data;
        else sk = sk_ro_data;
      }
    } else sk = sk_discard;
    skSect[sk].unshift(i);
    usedSegment[SKINFO[sk].seg] = 1;
  }
  /* 造 dylib 就没有 `__PAGEZERO` —— 这一句在归类**之后**（`sk_discard` 归的也是 0 号段，
   * 放在前头会被那一趟重新点上）。 */
  if (shared) usedSegment[0] = 0;

  // ---- 段与加载命令
  const segs = [];
  const lcs = [];
  const segOfSk = new Array(sk_last).fill(0);
  for (let i = 0; i < ALL_SEGMENT.length; i++) {
    if (usedSegment[i] === 0) continue;
    const a = ALL_SEGMENT[i];
    const seg = {
      name: a.name,
      /* dylib 里 `__TEXT` 也从 0 起（`if (i == 1 && output_type != EXE) vmaddr = 0`）。 */
      vmaddr: shared && i === 1 ? 0 : a.vmaddr,
      vmsize: a.vmsize,
      fileoff: 0,
      filesize: 0,
      maxprot: a.maxprot,
      initprot: a.initprot,
      flags: a.flags,
      sects: [],
    };
    segs.push(seg);
    lcs.push({ kind: 'seg', seg });
    for (let sk = 0; sk < sk_last; sk++) if (SKINFO[sk].seg === i) segOfSk[sk] = segs.length - 1;
  }
  const chainedLc = { dataoff: 0, datasize: 0 };
  const trieLc = { dataoff: 0, datasize: 0 };
  const symLc = {
    symoff: 0, nsyms: 0, stroff: 0, strsize: 0,
  };
  const dysymLc = {
    ilocalsym: 0, nlocalsym: 0, iextdefsym: 0, nextdefsym: 0, iundefsym: 0, nundefsym: 0,
    indirectsymoff: 0, nindirectsyms: 0,
  };
  const mainLc = { entryoff: 4096, stacksize: 0 };
  /* `LC_ID_DYLIB` 排在段头之后、链式修正之前，名字是**输出的文件名**
   * （`s1->install_name ? s1->install_name : filename`）。 */
  if (shared) {
    const name = inp.installName ?? inp.outName;
    if (name === undefined) throw new OmniError('macho: 造 dylib 要知道输出的文件名');
    lcs.push({ kind: 'iddylib', name });
  }
  lcs.push({ kind: 'le', cmd: LC_DYLD_CHAINED_FIXUPS, obj: chainedLc });
  lcs.push({ kind: 'le', cmd: LC_DYLD_EXPORTS_TRIE, obj: trieLc });
  lcs.push({ kind: 'symtab', obj: symLc });
  lcs.push({ kind: 'dysymtab', obj: dysymLc });
  if (!shared) lcs.push({ kind: 'dylinker', name: '/usr/lib/dyld' });
  lcs.push({ kind: 'buildver' });
  lcs.push({ kind: 'sourcever' });
  if (!shared) lcs.push({ kind: 'main', obj: mainLc });
  /* 装了哪些 dylib 就多几条 `LC_LOAD_DYLIB`，排在 `LC_MAIN` 后面。 */
  for (const name of loaded.dylibNames) lcs.push({ kind: 'dylib', name });

  /* ---- calc_fixup_size：链式修正那一块有多大，摆放之前就得算出来 —— 它自己
   * 也在 `__LINKEDIT` 里，长度差一个字节后面的偏移全错。 */
  const calcFixupSize = () => {
    let size = align(28, 8);                            // dyld_chained_fixups_header
    size += align(8 + (segs.length - 1) * 4, 8);        // dyld_chained_starts_in_image
    for (let i = TEXTSEG; i < segs.length - 1; i++) {
      const pages = Math.ceil(segs[i].vmsize / SEG_PAGE_SIZE);
      size += align(24 + (pages - 1) * 2, 8);           // dyld_chained_starts_in_segment
    }
    size += nBind * 4 + 1;                              // dyld_chained_import[] + 一个 0
    for (const b of bindRebase) if (b.bind !== 0) size += syms[b.rel.sym].name.length + 1;
    size = align(size, 8);
    secs[CHAINED].size = size;
    secs[CHAINED].data = new Array(size).fill(0);
  };

  // ---- 摆放：头 4096 字节留给 mach 头与加载命令
  let fileofs = 4096;
  let curaddr = segs[TEXTSEG].vmaddr + 4096;
  let seg = null;
  let numsec = 0;
  const elfsectomacho = new Array(secs.length).fill(0);
  for (let sk = 0; sk < sk_last; sk++) {
    let sec = null;
    if (seg !== null) {
      seg.vmsize = curaddr - seg.vmaddr;
      seg.filesize = fileofs - seg.fileoff;
    }
    if (sk === sk_linkedit) {
      calcFixupSize();
      const tr = exportTrie(syms, secs, segs[TEXTSEG].vmaddr);
      secs[EXPORTS].data = tr;
      secs[EXPORTS].size = tr.length;
    }
    if (SKINFO[sk].seg === 0 || (!shared && segOfSk[sk] === 0)
      || skSect[sk].length === 0) continue;
    seg = segs[segOfSk[sk]];
    if (SKINFO[sk].name !== null) {
      sec = {
        name: SKINFO[sk].name,
        segname: seg.name,
        addr: 0,
        size: 0,
        offset: 0,
        align: 0,
        flags: SKINFO[sk].flags,
        r1: 0,
        r2: 0,
      };
      seg.sects.push(sec);
      numsec++;
      if (sk === sk_stubs) sec.r2 = conf.stubSize;
      if (sk === sk_nl_ptr) sec.r1 = nrPlt;
    }
    if (seg.vmaddr === -1) {
      curaddr = align(curaddr, SEG_PAGE_SIZE);
      seg.vmaddr = curaddr;
      fileofs = align(fileofs, SEG_PAGE_SIZE);
      seg.fileoff = fileofs;
    }
    let al = 0;
    for (const i of skSect[sk]) {
      const a = log2of(secs[i].al);
      if (secs[i].al !== 0 && al < a) al = a;
    }
    if (sec !== null) sec.align = al;
    let alv = 2 ** al;
    if (alv > 4096) {
      if (sec !== null) sec.align = 12;
      alv = 4096;
    }
    curaddr = align(curaddr, alv);
    fileofs = align(fileofs, alv);
    if (sec !== null) {
      sec.addr = curaddr;
      sec.offset = fileofs;
    }
    for (const i of skSect[sk]) {
      const s = secs[i];
      curaddr = align(curaddr, s.al);
      s.addr = curaddr;
      curaddr += s.size;
      if (s.type !== SHT_NOBITS) {
        fileofs = align(fileofs, s.al);
        s.off = fileofs;
        fileofs += s.size;
      }
      if (sec !== null) elfsectomacho[i] = numsec;
    }
    if (sec !== null) sec.size = curaddr - sec.addr;
  }
  if (seg !== null) {
    seg.vmsize = curaddr - seg.vmaddr;
    seg.filesize = fileofs - seg.fileoff;
  }

  // ---- 符号表那几条加载命令的格子
  symLc.symoff = secs[MSYMTAB].off;
  symLc.nsyms = nlist.length;
  symLc.stroff = secs[MSTRTAB].off;
  symLc.strsize = mstr.length;
  dysymLc.iundefsym = iundef === -1 ? symLc.nsyms : iundef;
  dysymLc.iextdefsym = iextdef === -1 ? dysymLc.iundefsym : iextdef;
  dysymLc.ilocalsym = ilocal === -1 ? dysymLc.iextdefsym : ilocal;
  dysymLc.nlocalsym = dysymLc.iextdefsym - dysymLc.ilocalsym;
  dysymLc.nextdefsym = dysymLc.iundefsym - dysymLc.iextdefsym;
  dysymLc.nundefsym = symLc.nsyms - dysymLc.iundefsym;
  dysymLc.indirectsymoff = secs[INDIR].off;
  dysymLc.nindirectsyms = indir.length;
  if (secs[CHAINED].size !== 0) {
    chainedLc.dataoff = secs[CHAINED].off;
    chainedLc.datasize = secs[CHAINED].size;
  }
  if (secs[EXPORTS].size !== 0) {
    trieLc.dataoff = secs[EXPORTS].off;
    trieLc.datasize = secs[EXPORTS].size;
  }

  // ---- 这几条节的字节现在才知道：LEINDIR / LESTRTAB
  {
    const ib = new Uint8Array(indir.length * 4);
    const idv = new DataView(ib.buffer);
    for (let k = 0; k < indir.length; k++) idv.setUint32(k * 4, indir[k] >>> 0, true);
    secs[INDIR].bytes = ib;
    secs[MSTRTAB].bytes = new Uint8Array(mstr);
  }

  // ---- relocate_syms + relocate_sections
  for (const s of syms) {
    if (s.shndx !== SHN_UNDEF && s.shndx < SHN_LORESERVE) s.value += secs[s.shndx].addr;
  }
  const entryName = inp.entryName === undefined ? '_main' : inp.entryName;
  if (!shared) {
    const ei = byName.get(entryName);
    if (ei === undefined || syms[ei].shndx === SHN_UNDEF) {
      throw new OmniError(`macho: 找不到入口符号 '${entryName}'`);
    }
    mainLc.entryoff = syms[ei].value - segs[TEXTSEG].vmaddr;
  }

  for (let i = 1; i <= secs.length - 1; i++) {
    const s = secs[i];
    if (s.bytes !== undefined) continue;
    s.bytes = s.type === SHT_NOBITS ? new Uint8Array(0) : new Uint8Array(s.data);
  }
  const symAddr = (idx) => {
    const s = syms[idx];
    if (s.shndx === SHN_UNDEF) throw new OmniError(`macho: 未定义的符号 '${s.name}'`);
    return s.value;
  };
  /* Mach-O 上没有 PT_TLS —— tcc 的 `s1->tls_start` / `tls_end` 一直是 0（那一段是
   * `layout_sections` 里摆程序头时才填的，Mach-O 那一路不走）。于是线程局部那几号
   * 算出来的偏移相对的是「0」与「符号所在那一节的末尾」。 */
  const TLS_RELOC = new Set([23, 549, 550]);
  const tlsOf = (idx) => {
    const s = syms[idx];
    const ss = s.shndx < SHN_LORESERVE ? secs[s.shndx] : undefined;
    return {
      start: 0, end: 0, tcb: 16, symSecEnd: ss === undefined ? 0 : ss.addr + ss.size,
    };
  };
  for (const [si, list] of relas) {
    const tgt = secs[secs[si].relaFor];
    if (tgt === undefined || tgt.bytes.length === 0) continue;
    for (const r of list) {
      const a = attrOf.get(r.sym);
      relocateOne(machine, r.type, tgt.bytes, r.at, tgt.addr + r.at,
        symAddr(r.sym) + Number(r.add), 0, false,
        a === undefined ? undefined : secs[GOT].addr + a.gotOff,
        TLS_RELOC.has(r.type) ? tlsOf(r.sym) : undefined);
    }
  }

  /* ---- bind_rebase_import：链式修正。
   *
   * 要动的那几个 8 字节格子（GOT 的每一格、数据里的每个指针）自己串成一条链：
   * 每格里记着「下一格离我几个 4 字节」，链头记在所在页的 `page_start[]` 里。
   * 未定义的符号那一格是 bind（记一个 import 号），有定义的是 rebase（把原来写进去的
   * 绝对地址拆成 36 位的 target 加 8 位的 high8）。 */
  {
    const cd = secs[CHAINED].bytes;
    const cdv = new DataView(cd.buffer);
    const addrOf = (b) => secs[b.section].addr + b.rel.at;
    bindRebase.sort((a, b) => {
      const d = addrOf(a) - addrOf(b);
      return d;
    });
    for (let i = 0; i + 1 < bindRebase.length; i++) {
      if (bindRebase[i].section === bindRebase[i + 1].section
        && bindRebase[i].rel.at === bindRebase[i + 1].rel.at) {
        throw new OmniError(`macho: ${secs[bindRebase[i].section].name} 上两条修正撞在一起了`);
      }
    }
    const startsOffset = align(28, 8);
    cdv.setUint32(4, startsOffset, true);
    cdv.setUint32(16, nBind, true);
    cdv.setUint32(20, DYLD_CHAINED_IMPORT, true);
    cdv.setUint32(24, 0, true);
    let p = startsOffset;
    const imageOff = p;
    cdv.setUint32(imageOff, segs.length, true);
    p += align(8 + (segs.length - 1) * 4, 8);
    const getSlot = (b) => {
      const s = secs[b.section];
      return new DataView(s.bytes.buffer, s.bytes.byteOffset, s.bytes.byteLength);
    };
    for (let i = TEXTSEG; i < segs.length - 1; i++) {
      const sg = segs[i];
      cdv.setUint32(imageOff + 4 + i * 4, p - startsOffset, true);
      const pages = Math.ceil(sg.vmsize / SEG_PAGE_SIZE);
      const size = 24 + (pages - 1) * 2;
      const so = p;
      p += align(size, 8);
      cdv.setUint32(so, size, true);
      cdv.setUint16(so + 4, SEG_PAGE_SIZE, true);
      cdv.setUint16(so + 6, DYLD_CHAINED_PTR_64, true);
      cdv.setBigUint64(so + 8, BigInt(sg.fileoff), true);
      cdv.setUint32(so + 16, 0, true);
      cdv.setUint16(so + 20, pages, true);
      const pageStart = so + 22;
      let bindIndex = 0;
      let k = 0;
      for (let j = 0; j < pages; j++) {
        const start = sg.vmaddr + j * SEG_PAGE_SIZE;
        const end = start + SEG_PAGE_SIZE;
        let last = null;
        let lastO = 0;
        cdv.setUint16(pageStart + j * 2, DYLD_CHAINED_PTR_START_NONE, true);
        for (; k < bindRebase.length; k++) {
          const b = bindRebase[k];
          const s = secs[b.section];
          const roff = b.rel.at;
          const at = s.addr + roff;
          if ((at & 3) !== 0 || (at % SEG_PAGE_SIZE) > SEG_PAGE_SIZE - 8) {
            throw new OmniError(`macho: ${s.name} 上的修正落在 ${roff}，位置不合规`);
          }
          if (at >= end) break;
          if (at >= start) {
            const curO = at - start;
            if (cdv.getUint16(pageStart + j * 2, true) === DYLD_CHAINED_PTR_START_NONE) {
              cdv.setUint16(pageStart + j * 2, curO, true);
            } else {
              const dv = getSlot(last);
              const old = dv.getBigUint64(last.rel.at, true);
              const next = BigInt((curO - lastO) / 4);
              dv.setBigUint64(last.rel.at,
                (old & ~(0xfffn << 51n)) | (next << 51n), true);
            }
            const dv = getSlot(b);
            if (b.bind !== 0) {
              dv.setBigUint64(roff, (BigInt(bindIndex) & 0xffffffn) | (1n << 63n), true);
            } else {
              const cur = dv.getBigUint64(roff, true);
              const target = cur & 0xfffffffffn;
              const high8 = cur >> 56n;
              if (cur !== (high8 << 56n) + target) {
                throw new OmniError(`macho: ${s.name} 上 ${roff} 处的地址塞不进 rebase`);
              }
              dv.setBigUint64(roff, target | (high8 << 36n), true);
            }
            last = b;
            lastO = curO;
          }
          bindIndex += b.bind;
        }
      }
    }
    cdv.setUint32(8, p, true);
    const importsOff = p;
    p += nBind * 4;
    cdv.setUint32(12, p, true);
    const symbolsOff = p;
    p += 1;
    let bi = 0;
    for (const b of bindRebase) {
      if (b.bind === 0) continue;
      const sym = syms[b.rel.sym];
      const weak = Math.floor(sym.info / 16) === STB_WEAK ? 1 : 0;
      const nameOffset = p - symbolsOff;
      cdv.setUint32(importsOff + bi * 4,
        (((BIND_SPECIAL_DYLIB_FLAT_LOOKUP & 0xff) | (weak << 8)) + nameOffset * 512) >>> 0, true);
      for (let c = 0; c < sym.name.length; c++) cd[p++] = sym.name.charCodeAt(c);
      cd[p++] = 0;
      bi++;
    }
  }

  /* ---- convert_symbols：ELF 的符号换成 Mach-O 的 `nlist_64`。
   * 注意只有 `STB_GLOBAL` 才打 `N_EXT` —— 弱符号靠 `n_desc` 里的两位表示。 */
  {
    const sb = new Uint8Array(nlist.length * 16);
    const sdv = new DataView(sb.buffer);
    for (let k = 0; k < nlist.length; k++) {
      const n = nlist[k];
      const sym = syms[n.elf];
      const stt = sym.info % 16;
      let type;
      if (stt === STT_NOTYPE || stt === STT_OBJECT || stt === STT_FUNC
        || stt === STT_TLS || stt === STT_SECTION) type = N_SECT;
      else if (stt === STT_FILE) type = N_ABS;
      else throw new OmniError(`macho: 还不会 ${stt} 号符号类型（${sym.name}）`);
      let sect = 0;
      let desc = 0;
      if (sym.shndx === SHN_UNDEF) {
        throw new OmniError(`macho: 符号 '${sym.name}' 该早就标成来自 dylib 了`);
      } else if (sym.shndx === SHN_FROMDLL) {
        type = N_UNDF;
      } else if (sym.shndx === SHN_ABS) {
        type = N_ABS;
      } else if (sym.shndx >= SHN_LORESERVE) {
        throw new OmniError(`macho: 符号 '${sym.name}' 落在 ${sym.shndx} 号节，还不会`);
      } else if (elfsectomacho[sym.shndx] === 0) {
        throw new OmniError(`macho: ${secs[sym.shndx].name} 没进 Mach-O，可 '${sym.name}' 在里头`);
      } else sect = elfsectomacho[sym.shndx];
      const bind = Math.floor(sym.info / 16);
      if (bind === STB_GLOBAL) type |= N_EXT;
      else if (bind === STB_WEAK) desc |= N_WEAK_REF | (type !== N_UNDF ? N_WEAK_DEF : 0);
      sdv.setUint32(k * 16, n.strx, true);
      sb[k * 16 + 4] = type;
      sb[k * 16 + 5] = sect;
      sdv.setUint16(k * 16 + 6, desc, true);
      sdv.setBigUint64(k * 16 + 8, BigInt(sym.value < 0 ? 0 : sym.value), true);
    }
    secs[MSYMTAB].bytes = sb;
  }

  // ---- macho_write
  const lcSize = (l) => {
    if (l.kind === 'seg') return 72 + 80 * l.seg.sects.length;
    if (l.kind === 'le') return 16;
    if (l.kind === 'symtab') return 24;
    if (l.kind === 'dysymtab') return 80;
    if (l.kind === 'dylinker') return align(12 + l.name.length + 1, 8);
    if (l.kind === 'dylib' || l.kind === 'iddylib') return align(24 + l.name.length + 1, 8);
    if (l.kind === 'buildver') return 24;
    if (l.kind === 'sourcever') return 16;
    return 24;                                      // main
  };
  let sizeofcmds = 0;
  for (const l of lcs) sizeofcmds += lcSize(l);
  let total = 32 + sizeofcmds;
  for (let i = 1; i < secs.length; i++) {
    const s = secs[i];
    if (s.off === undefined || s.type === SHT_NOBITS) continue;
    if (s.off + s.bytes.length > total) total = s.off + s.bytes.length;
  }
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  const str16 = (o, s) => {
    for (let k = 0; k < s.length && k < 16; k++) buf[o + k] = s.charCodeAt(k);
  };
  dv.setUint32(0, MH_MAGIC_64, true);
  dv.setUint32(4, conf.cputype, true);
  dv.setUint32(8, conf.cpusubtype, true);
  dv.setUint32(12, shared ? MH_DYLIB : MH_EXECUTE, true);
  dv.setUint32(16, lcs.length, true);
  dv.setUint32(20, sizeofcmds, true);
  dv.setUint32(24, (shared ? MH_DYLDLINK : MH_DYLDLINK | MH_PIE) >>> 0, true);
  dv.setUint32(28, 0, true);
  let o = 32;
  for (const l of lcs) {
    const sz = lcSize(l);
    if (l.kind === 'seg') {
      const sg = l.seg;
      dv.setUint32(o, LC_SEGMENT_64, true);
      dv.setUint32(o + 4, sz, true);
      str16(o + 8, sg.name);
      dv.setBigUint64(o + 24, BigInt(sg.vmaddr), true);
      dv.setBigUint64(o + 32, BigInt(sg.vmsize), true);
      dv.setBigUint64(o + 40, BigInt(sg.fileoff), true);
      dv.setBigUint64(o + 48, BigInt(sg.filesize), true);
      dv.setInt32(o + 56, sg.maxprot, true);
      dv.setInt32(o + 60, sg.initprot, true);
      dv.setUint32(o + 64, sg.sects.length, true);
      dv.setUint32(o + 68, sg.flags, true);
      let so = o + 72;
      for (const sec of sg.sects) {
        str16(so, sec.name);
        str16(so + 16, sec.segname);
        dv.setBigUint64(so + 32, BigInt(sec.addr), true);
        dv.setBigUint64(so + 40, BigInt(sec.size), true);
        dv.setUint32(so + 48, sec.offset, true);
        dv.setUint32(so + 52, sec.align, true);
        dv.setUint32(so + 56, 0, true);
        dv.setUint32(so + 60, 0, true);
        dv.setUint32(so + 64, sec.flags, true);
        dv.setUint32(so + 68, sec.r1, true);
        dv.setUint32(so + 72, sec.r2, true);
        dv.setUint32(so + 76, 0, true);
        so += 80;
      }
    } else if (l.kind === 'le') {
      dv.setUint32(o, l.cmd, true);
      dv.setUint32(o + 4, sz, true);
      dv.setUint32(o + 8, l.obj.dataoff, true);
      dv.setUint32(o + 12, l.obj.datasize, true);
    } else if (l.kind === 'symtab') {
      dv.setUint32(o, LC_SYMTAB, true);
      dv.setUint32(o + 4, sz, true);
      dv.setUint32(o + 8, l.obj.symoff, true);
      dv.setUint32(o + 12, l.obj.nsyms, true);
      dv.setUint32(o + 16, l.obj.stroff, true);
      dv.setUint32(o + 20, l.obj.strsize, true);
    } else if (l.kind === 'dysymtab') {
      dv.setUint32(o, LC_DYSYMTAB, true);
      dv.setUint32(o + 4, sz, true);
      dv.setUint32(o + 8, l.obj.ilocalsym, true);
      dv.setUint32(o + 12, l.obj.nlocalsym, true);
      dv.setUint32(o + 16, l.obj.iextdefsym, true);
      dv.setUint32(o + 20, l.obj.nextdefsym, true);
      dv.setUint32(o + 24, l.obj.iundefsym, true);
      dv.setUint32(o + 28, l.obj.nundefsym, true);
      dv.setUint32(o + 56, l.obj.indirectsymoff, true);
      dv.setUint32(o + 60, l.obj.nindirectsyms, true);
    } else if (l.kind === 'dylinker') {
      dv.setUint32(o, LC_LOAD_DYLINKER, true);
      dv.setUint32(o + 4, sz, true);
      dv.setUint32(o + 8, 12, true);
      for (let k = 0; k < l.name.length; k++) buf[o + 12 + k] = l.name.charCodeAt(k);
    } else if (l.kind === 'buildver') {
      dv.setUint32(o, LC_BUILD_VERSION, true);
      dv.setUint32(o + 4, sz, true);
      dv.setUint32(o + 8, PLATFORM_MACOS, true);
      dv.setUint32(o + 12, (10 << 16) + (6 << 8), true);
      dv.setUint32(o + 16, (10 << 16) + (6 << 8), true);
      dv.setUint32(o + 20, 0, true);
    } else if (l.kind === 'sourcever') {
      dv.setUint32(o, LC_SOURCE_VERSION, true);
      dv.setUint32(o + 4, sz, true);
      dv.setBigUint64(o + 8, 0n, true);
    } else if (l.kind === 'dylib' || l.kind === 'iddylib') {
      dv.setUint32(o, l.kind === 'dylib' ? LC_LOAD_DYLIB : LC_ID_DYLIB, true);
      dv.setUint32(o + 4, sz, true);
      dv.setUint32(o + 8, 24, true);                // name 从结构体末尾起
      dv.setUint32(o + 12, l.kind === 'dylib' ? 2 : 1, true);   // timestamp
      dv.setUint32(o + 16, 1 << 16, true);          // current_version 1.0.0
      dv.setUint32(o + 20, 1 << 16, true);          // compatibility_version 1.0.0
      for (let k = 0; k < l.name.length; k++) buf[o + 24 + k] = l.name.charCodeAt(k);
    } else {
      dv.setUint32(o, LC_MAIN, true);
      dv.setUint32(o + 4, sz, true);
      dv.setBigUint64(o + 8, BigInt(l.obj.entryoff), true);
      dv.setBigUint64(o + 16, BigInt(l.obj.stacksize), true);
    }
    o += sz;
  }
  for (let sk = 0; sk < sk_last; sk++) {
    if (SKINFO[sk].seg === 0 || (!shared && segOfSk[sk] === 0)
      || skSect[sk].length === 0) continue;
    for (const i of skSect[sk]) {
      const s = secs[i];
      if (s.type === SHT_NOBITS || s.size === 0) continue;
      buf.set(s.bytes.subarray(0, s.size), s.off);
    }
  }
  return {
    bytes: buf,
    ncmds: lcs.length,
    nsects: numsec,
    entryoff: mainLc.entryoff,
    members: loaded.members,
  };
}
