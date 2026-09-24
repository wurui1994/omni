/* 链 PE 之前的那一半：符号表、入口符号、按需取用、`.def` 导入库 ——
 * ADR-0017 第 11 步，第九刀第四十七片。
 *
 * `pe_write` 那一族（第四十三到四十五片）已经能照原样重建映像里的每一段，可那都是
 * 「拿 tcc 链好的 `.exe` 当模板」。要自己链出来，第一步不是摆地址，是**先把该读的
 * 文件读进来**：哪些库、哪些成员、哪些导入符号。这一步有一把独立的尺子 ——
 * `tcc -vv` 链接时会把每个装进来的文件打成 `-> 路径`，把从库里拉出来的成员打成
 * `   -> 名字`。于是「装了什么」可以先单独对准，不必等整份 `.exe` 能写出来。
 *
 * 照的是 `tccpe.c:pe_add_runtime` 与 `pe_load_def`，加上 `tccelf.c` 的
 * `tcc_load_alacarte`（第四十六片已经有了）。几格值得记：
 *
 *  - 入口符号是**按符号表里有什么**挑的：有 `WinMain` 就 `__winstart`（并且是 GUI），
 *    有 `wmain` 就 `__wstart`，否则 `__start`。挑完之后名字要去掉一个下划线
 *    （`pe->start_symbol = start_symbol + 1`），x86_64/arm64 上不带前导下划线，
 *    于是真正进符号表的是 `_start`。
 *  - 这个入口符号是当作**未定义的全局符号**加进去的（`set_global_sym`），正是它把
 *    `libtcc1.a` 里的 crt 那一个成员拉了进来。少了这一句，一个成员都拉不出来。
 *  - `-lmsvcrt` 找的是 `%s.def` / `lib%s.def` / `%s.dll` / `lib%s.dll` / `lib%s.a`
 *    这个次序（`tcc_add_library`）；win32 上前两个就命中了。
 *  - **`.def` 里的符号不进 `.symtab`**，进的是另一张 `dynsymtab_section`
 *    （`pe_putimport` → `set_elf_sym(s1->dynsymtab_section, …)`）。所以它们不能
 *    在扫库的时候充当「已定义」——`printf` 在扫 `libtcc1.a` 的那一刻仍然是未定义的。
 *    两张表要到 `pe_check_symbols` 才对上。这一格错了，拉出来的成员就会多。
 */

import { OmniError } from '../source/diag.js';
import { readObject } from './elf.js';
import { readArchive, alacarte } from './ar.js';
import { readImage } from './pe.js';

const PLOAD_SHT_SYMTAB = 2;
const PLOAD_SYM_SIZE = 24;
const EM_386 = 3;
const EM_ARM = 40;
const PLOAD_SHN_UNDEF = 0;
const PLOAD_STB_LOCAL = 0;
/* `struct pe_rsrc_header`：COFF 的文件头加一条节表项。 */
const RES_HDR_SIZE = 20 + 40;
/* `struct pe_rsrc_reloc`：偏移、符号号、类型 —— 紧排，10 字节。 */
const RES_RELOC_SIZE = 10;
/* `RSRC_RELTYPE`：x86_64 与 arm64 都是 3（`ADDR32NB`），i386/arm 是 7（`DIR32NB`）。 */
const RSRC_RELTYPE = new Map([[0x8664, 3], [0xaa64, 3], [0x14c, 7], [0x1c0, 7]]);

/** `pe_add_runtime` 里那四种映像类型。 */
export const PE_EXE = 1;
export const PE_DLL = 2;
export const PE_GUI = 3;

/**
 * 把一个目标文件的符号表读出来。
 *
 * `readObject` 只到「节的字节」那一层（并合用不着解释符号），这里往下走一层：
 * 找到 `PLOAD_SHT_SYMTAB`，按它的 `sh_link` 找到自己的字符串表，一条 24 字节地读。
 */
export function readSymbols(obj) {
  const st = obj.secs.find((s) => s.type === PLOAD_SHT_SYMTAB);
  if (st === undefined) return [];
  /* `sh_link` 是**节号**（连 0 号空节一起数），`secs` 是从 1 号开始摆的。 */
  const strs = obj.secs[st.link - 1];
  if (strs === undefined) throw new OmniError('elf: .symtab 的 sh_link 指不到字符串表');
  const nameAt = (n) => {
    let e = n;
    while (e < strs.bytes.length && strs.bytes[e] !== 0) e++;
    let s = '';
    for (let k = n; k < e; k++) s += String.fromCharCode(strs.bytes[k]);
    return s;
  };
  const dv = new DataView(st.bytes.buffer, st.bytes.byteOffset, st.bytes.byteLength);
  const out = [];
  /* 32 位的 `Elf32_Sym` 是 16 字节，而且字段次序不一样：名字、值、大小在前，
   * `st_info` / `st_other` / `st_shndx` 在后。 */
  const c32 = obj.class32 === true;
  const size = c32 ? 16 : PLOAD_SYM_SIZE;
  for (let p = 0; p + size <= st.bytes.length; p += size) {
    const info = st.bytes[p + (c32 ? 12 : 4)];
    out.push({
      name: nameAt(dv.getUint32(p, true)),
      info,
      bind: Math.floor(info / 16),
      type: info % 16,
      other: st.bytes[p + (c32 ? 13 : 5)],
      shndx: dv.getUint16(p + (c32 ? 14 : 6), true),
      value: c32 ? dv.getUint32(p + 4, true) : Number(dv.getBigUint64(p + 8, true)),
      size: c32 ? dv.getUint32(p + 8, true) : Number(dv.getBigUint64(p + 16, true)),
    });
  }
  return out;
}

/**
 * 链接过程中的那一张全局符号表，只留「按需取用」要问的两件事：
 * 这个名字在不在表里、它现在有没有定义。
 */
export class SymTab {
  constructor() {
    this.byName = new Map();                     // 名字 → shndx（0 就是未定义）
  }

  /** 一个目标文件的符号并进来（局部符号不参与解析，跳过）。 */
  addObject(syms) {
    for (const s of syms) {
      if (s.bind === PLOAD_STB_LOCAL || s.name === '') continue;
      const old = this.byName.get(s.name);
      if (old === undefined || (old === PLOAD_SHN_UNDEF && s.shndx !== PLOAD_SHN_UNDEF)) {
        this.byName.set(s.name, s.shndx);
      }
    }
  }

  /** `set_global_sym(s1, name, NULL, 0)`：加一条未定义的全局符号。 */
  declare(name) {
    if (!this.byName.has(name)) this.byName.set(name, PLOAD_SHN_UNDEF);
  }

  has(name) { return this.byName.has(name); }

  /** `tcc_load_alacarte` 问的正是这一句：在表里、且还没有定义。 */
  isUndef(name) { return this.byName.get(name) === PLOAD_SHN_UNDEF; }

  /** 还欠着的符号，按进表的次序。 */
  undefined() {
    const out = [];
    for (const [n, sh] of this.byName) if (sh === PLOAD_SHN_UNDEF) out.push(n);
    return out;
  }
}

/**
 * `pe_add_runtime` 的前半：挑入口符号与映像类型。
 *
 * @param tab 已经装完命令行上那些目标文件的符号表
 * @param opts `{subsystem, dll, entry, leadingUnderscore, stdcall}`
 *        - `stdcall`：32 位的那两个 PE 目标（i386/arm）。`PE_STDSYM` 是**按目标**定的宏
 *          （`#if defined TCC_TARGET_X86_64 || defined TCC_TARGET_ARM64` 时是 `n`，
 *          否则是 `"_" n s`），与 `leading_underscore` 无关
 * @returns `{start, peType}`，`start` 就是要当作未定义符号加进去的那个名字
 */
export function peStart(tab, opts) {
  const o = opts ?? {};
  const under = o.leadingUnderscore === true;   // PE 上默认是 0，只有 `-fleading-underscore` 才开
  /* `PE_STDSYM(n,s)`：64 位那两个目标上就是 `n`，32 位上是 `"_" n s` —— 也就是
   * i386/arm 上入口是 `___dllstart@12`、要找的是 `_WinMain@16`。 */
  const std = (n, s) => (o.stdcall === true ? `_${n}${s}` : n);
  let start;
  let peType;
  if (o.dll === true) {
    peType = PE_DLL;
    start = std('__dllstart', '@12');
  } else if (tab.has(std('WinMain', '@16'))) {
    start = '__winstart';
    peType = PE_GUI;
  } else if (tab.has(std('wWinMain', '@16'))) {
    start = '__wwinstart';
    peType = PE_GUI;
  } else if (tab.has('wmain')) {
    start = '__wstart';
    peType = PE_EXE;
  } else {
    start = '__start';
    peType = o.subsystem === 2 ? PE_GUI : PE_EXE;
  }
  if (typeof o.entry === 'string') return { start: o.entry, entryName: o.entry, peType };
  /* 两个名字要分开：查入口地址用的是 `pe->start_symbol = start_symbol + 1`，
   * 而**写进符号表**的那个还要看前导下划线 —— 不带下划线时再 `++` 一次。
   * 于是 x86_64/arm64 上进符号表的是 `_start`，i386 上是 `__start`。 */
  const entryName = start.slice(1);
  return { start: under && !start.includes('@') ? start : entryName, entryName, peType };
}

/** `pe_add_runtime` 的后半：要接哪几个库。 */
export function runtimeLibs(peType) {
  const libs = ['msvcrt', 'kernel32'];
  /* 那个空串是个哨兵：EXE 就到此为止，DLL/GUI 才继续接 `user32`、`gdi32`。 */
  if (peType === PE_DLL || peType === PE_GUI) libs.push('user32', 'gdi32');
  return libs;
}

/** `-l<名字>` 在 PE 上依次找的这几个文件名（`tcc_add_library` 的 `libs[]`）。 */
export function libCandidates(name) {
  return [`${name}.def`, `lib${name}.def`, `${name}.dll`, `lib${name}.dll`, `lib${name}.a`];
}

/**
 * 读一个 `.def` 导入库（`pe_load_def`）。
 *
 * 格式就三件事：`LIBRARY <名字>`、`EXPORTS`、然后一行一个符号，名字后面可以跟
 * `@<序号>`。名字没有扩展名就补 `.dll`。`;` 开头的是注释。
 */
export function parseDef(text) {
  let dll = null;
  const syms = [];
  let state = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith(';')) continue;
    const parts = line.split(/[\s,]+/).filter((x) => x !== '');
    if (state === 0) {
      if (parts[0].toUpperCase() !== 'LIBRARY' || parts.length < 2) {
        throw new OmniError('def: 第一行不是 LIBRARY <名字>');
      }
      dll = parts[1].includes('.') ? parts[1] : `${parts[1]}.dll`;
      state = 1;
      continue;
    }
    if (state === 1) {
      if (parts[0].toUpperCase() !== 'EXPORTS') throw new OmniError('def: LIBRARY 之后应当是 EXPORTS');
      state = 2;
      continue;
    }
    /* 序号既可以写成 `名字 @3`，也可以紧挨着写成 `名字@3` —— 可名字里本来就可能
     * 有 `@`（C++ 修饰过的名字满是），所以只认「@ 之后全是数字」这一种。 */
    let name = parts[0];
    let ordinal = 0;
    if (parts.length > 1 && /^@\d+$/.test(parts[1])) {
      ordinal = parseInt(parts[1].slice(1), 10);
    } else {
      const m = /^(.*)@(\d+)$/.exec(name);
      if (m !== null && !m[1].endsWith('@')) { name = m[1]; ordinal = parseInt(m[2], 10); }
    }
    syms.push({ name, ordinal });
  }
  if (dll === null) throw new OmniError('def: 空文件');
  return { dll, syms };
}

/**
 * 读一份真的 `.dll`，把它的导出名字当成一张 `.def`（`get_dllexports` +
 * `pe_load_dll`）。
 *
 * 只看数据目录 0 那张导出表的 `AddressOfNames`：一个个名字读出来，序号一律给 0
 * （`pe_putimport(s1, ref->index, q, 0)`）—— 于是导入表里走的是名字那一路，
 * 跟 `.def` 里不带 `@序号` 的那些一模一样。
 *
 * 库名取的是**文件名的基名**（`tcc_basename(dllref->name)`），命令行上写的路径不算。
 */
export function readDllExports(bytes, path) {
  const img = readImage(bytes);
  const dir = img.dirs[0];
  const syms = [];
  if (dir.size !== 0) {
    /* tcc 那一句是 `addr >= ish.VirtualAddress && addr < …+ ish.SizeOfRawData` ——
     * `readImage` 留下的 `bytes` 长度正是 `SizeOfRawData`。 */
    const sec = img.secs.find((s) => dir.addr >= s.vaddr && dir.addr < s.vaddr + s.bytes.length);
    if (sec === undefined) throw new OmniError('pe: 导出表不在任何一节里');
    const b = sec.bytes;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const at = dir.addr - sec.vaddr;
    const n = dv.getUint32(at + 24, true);            // NumberOfNames
    const namesAt = dv.getUint32(at + 32, true) - sec.vaddr;
    for (let i = 0; i < n; i++) {
      let p = dv.getUint32(namesAt + i * 4, true) - sec.vaddr;
      let name = '';
      while (b[p] !== 0) { name += String.fromCharCode(b[p]); p++; }
      syms.push({ name, ordinal: 0 });
    }
  }
  return { dll: path.split(/[\\/]/).pop(), syms };
}

/**
 * 读一份 `windres -O coff` 造出来的资源文件（`pe_load_res`）。
 *
 * 它是一份**只有一节的 COFF**：20 字节的文件头 + 40 字节的节表项，那一节叫 `.rsrc`。
 * tcc 认它的三个条件是「机器号对得上、只有一节、节名正好是 `.rsrc`」—— 连魔数都没有，
 * 所以这一步必须在认 `MZ` 之前，而且 ELF 那 `\x7fELF` 落在机器号那两字节上，撞不着。
 *
 * 装进来的东西就两样：那一节的原始字节，以及它自己那张重定位表。COFF 里每条重定位
 * 是 10 字节（偏移、符号号、类型），类型必须是 `RSRC_RELTYPE`（x86_64 与 arm64 是 3，
 * 也就是 `ADDR32NB`；i386/arm 是 7）。tcc 那句 `hdr.filehdr.Machine != IMAGE_FILE_MACHINE`
 * 保证机器号就是目标的机器号，所以这里按文件头里那个机器号选。符号号一律不看 ——
 * tcc 把每一条都改挂到自己新加的那个
 * `.rsrc` 符号上，落笔时成了 `R_XXX_RELATIVE`，也就是「原地那个节内偏移 + 这一节的
 * RVA」。资源目录里指向数据的那几格正是这么补上的。
 *
 * @returns `null`（不是资源文件）或 `{bytes, relocs}`
 */
export function readRes(bytes) {
  if (bytes.length < RES_HDR_SIZE) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint16(2, true) !== 1) return null;             // NumberOfSections
  const relType = RSRC_RELTYPE.get(dv.getUint16(0, true));  // Machine
  if (relType === undefined) return null;
  let name = '';
  for (let i = 0; i < 8 && bytes[20 + i] !== 0; i++) name += String.fromCharCode(bytes[20 + i]);
  if (name !== '.rsrc') return null;
  const size = dv.getUint32(20 + 16, true);                 // SizeOfRawData
  const ptr = dv.getUint32(20 + 20, true);                  // PointerToRawData
  const relPtr = dv.getUint32(20 + 24, true);               // PointerToRelocations
  const nrel = dv.getUint16(20 + 32, true);                 // NumberOfRelocations
  if (ptr + size > bytes.length) throw new OmniError('res: .rsrc 的字节超出文件');
  const relocs = [];
  for (let i = 0; i < nrel; i++) {
    const p = relPtr + i * RES_RELOC_SIZE;
    if (p + RES_RELOC_SIZE > bytes.length) throw new OmniError('res: 重定位表超出文件');
    if (dv.getUint16(p + 8, true) !== relType) {
      throw new OmniError(`res: 不认识的重定位类型 ${dv.getUint16(p + 8, true)}`);
    }
    relocs.push(dv.getUint32(p, true));
  }
  return { bytes: bytes.subarray(ptr, ptr + size), relocs };
}

/**
 * 按 tcc 的次序把该装的东西装进来，并且把「装了什么」记成一串足迹 ——
 * 那一串正好能与 `tcc -vv` 打出来的 `-> …` 行逐条比。
 *
 * @param inp `{objs, libtcc1, open, subsystem, dll, entry, leadingUnderscore, nostdlib}`
 *        - `objs`：`[{path, bytes}]`，命令行上给的文件。只有一节且那一节叫 `.rsrc` 的
 *          当作资源文件（进 `res`），开头是 `MZ` 的当作真的 `.dll`（进 `dlls`），
 *          剩下的才是目标文件 —— `pe_load_file` 就是这个次序
 *        - `libtcc1`：支持库的文件名（带交叉前缀，如 `x86_64-win32-libtcc1.a`）
 *        - `open(names)`：给一串候选文件名，回 `{path, bytes}` 或 `null`
 * @returns `{trace, tab, start, peType, dlls, members, objs, res}`；`trace` 每条
 *          `{kind:'file'|'member', path}`，`objs` 是**真的目标文件**那几份字节
 */
export function peLoad(inp) {
  const tab = new SymTab();
  const trace = [];
  const members = [];
  const dlls = [];
  const objs = [];
  const res = [];
  let machine = null;

  const loadObject = (bytes) => {
    const obj = readObject(bytes);
    if (machine === null) machine = obj.machine;
    tab.addObject(readSymbols(obj));
  };

  for (const o of inp.objs) {
    trace.push({ kind: 'file', path: o.path });
    /* `pe_load_file` 的次序：先试资源文件，再看是不是 `MZ`，剩下的当目标文件。 */
    const rs = readRes(o.bytes);
    if (rs !== null) { res.push(rs); continue; }
    if (o.bytes[0] === 0x4d && o.bytes[1] === 0x5a) { dlls.push(readDllExports(o.bytes, o.path)); continue; }
    objs.push(o.bytes);
    loadObject(o.bytes);
  }

  const { start, entryName, peType } = peStart(tab,
    { ...inp, stdcall: machine === EM_386 || machine === EM_ARM });
  tab.declare(start);                            // 就是这一句把 crt 拉进来

  if (inp.nostdlib === true) {
    return { trace, tab, start, entryName, peType, dlls, members, objs, res };
  }

  /* `--libc self`（第 win-c-backend 刀）：我们自己那份 libc 已经在 `.o` 里了，
   * 所以 **msvcrt 与 libtcc1 都不接**，但 `kernel32` 仍然要 —— Windows 上没有
   * 稳定的裸 syscall，`WriteFile`/`VirtualAlloc` 这一层就是这个平台的地板。
   * 与 `nostdlib` 不是一回事：那个是「一个库都不要」，这个是「只要地板」。
   *
   * DLL/GUI 那两种 `runtimeLibs` 还会接 `user32`/`gdi32` —— 那是给 msvcrt 那一路的
   * 窗口程序准备的，我们自己这份 libc 一个都不引（插件里更不会有窗口）。留着的结果是
   * `pe: 找不到 user32.def`（sysroot 里只有 kernel32.def），所以这一路**只留 kernel32**。 */
  const want = inp.selfLibc === true
    ? [libCandidates('kernel32')]
    : [[inp.libtcc1], ...runtimeLibs(peType).map((l) => libCandidates(l))];
  for (const names of want) {
    const f = inp.open(names);
    if (f === null) throw new OmniError(`pe: 找不到 ${names[0]}`);
    trace.push({ kind: 'file', path: f.path });
    if (f.path.endsWith('.def')) {
      /* 导入库：符号进的是另一张表，不影响后面谁算未定义。 */
      dlls.push(parseDef(latin1(f.bytes)));
      continue;
    }
    if (f.path.endsWith('.a')) {
      const ar = readArchive(f.bytes);
      alacarte(ar, (n) => tab.isUndef(n), (m) => {
        trace.push({ kind: 'member', path: m.name });
        members.push(m);
        loadObject(m.bytes);
      });
      continue;
    }
    throw new OmniError(`pe: 还不会装 ${f.path}`);
  }
  return {
    trace, tab, start, entryName, peType, dlls, members, objs, res,
  };
}

function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
