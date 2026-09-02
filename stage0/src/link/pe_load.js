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

const SHT_SYMTAB = 2;
const SYM_SIZE = 24;
const SHN_UNDEF = 0;
const STB_LOCAL = 0;

/** `pe_add_runtime` 里那四种映像类型。 */
export const PE_EXE = 1;
export const PE_DLL = 2;
export const PE_GUI = 3;

/**
 * 把一个目标文件的符号表读出来。
 *
 * `readObject` 只到「节的字节」那一层（并合用不着解释符号），这里往下走一层：
 * 找到 `SHT_SYMTAB`，按它的 `sh_link` 找到自己的字符串表，一条 24 字节地读。
 */
export function readSymbols(obj) {
  const st = obj.secs.find((s) => s.type === SHT_SYMTAB);
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
  for (let p = 0; p + SYM_SIZE <= st.bytes.length; p += SYM_SIZE) {
    const info = st.bytes[p + 4];
    out.push({
      name: nameAt(dv.getUint32(p, true)),
      info,
      bind: Math.floor(info / 16),
      type: info % 16,
      other: st.bytes[p + 5],
      shndx: dv.getUint16(p + 6, true),
      value: Number(dv.getBigUint64(p + 8, true)),
      size: Number(dv.getBigUint64(p + 16, true)),
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
      if (s.bind === STB_LOCAL || s.name === '') continue;
      const old = this.byName.get(s.name);
      if (old === undefined || (old === SHN_UNDEF && s.shndx !== SHN_UNDEF)) {
        this.byName.set(s.name, s.shndx);
      }
    }
  }

  /** `set_global_sym(s1, name, NULL, 0)`：加一条未定义的全局符号。 */
  declare(name) {
    if (!this.byName.has(name)) this.byName.set(name, SHN_UNDEF);
  }

  has(name) { return this.byName.has(name); }

  /** `tcc_load_alacarte` 问的正是这一句：在表里、且还没有定义。 */
  isUndef(name) { return this.byName.get(name) === SHN_UNDEF; }

  /** 还欠着的符号，按进表的次序。 */
  undefined() {
    const out = [];
    for (const [n, sh] of this.byName) if (sh === SHN_UNDEF) out.push(n);
    return out;
  }
}

/**
 * `pe_add_runtime` 的前半：挑入口符号与映像类型。
 *
 * @param tab 已经装完命令行上那些目标文件的符号表
 * @param opts `{subsystem, dll, entry, leadingUnderscore}`
 * @returns `{start, peType}`，`start` 就是要当作未定义符号加进去的那个名字
 */
export function peStart(tab, opts) {
  const o = opts ?? {};
  const under = o.leadingUnderscore === true;   // i386-win32 才是 true
  const std = (n, s) => (under ? `_${n}${s}` : n);
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
 * 按 tcc 的次序把该装的东西装进来，并且把「装了什么」记成一串足迹 ——
 * 那一串正好能与 `tcc -vv` 打出来的 `-> …` 行逐条比。
 *
 * @param inp `{objs, libtcc1, open, subsystem, dll, entry, leadingUnderscore, nostdlib}`
 *        - `objs`：`[{path, bytes}]`，命令行上给的文件。开头是 `MZ` 的当作真的 `.dll`
 *          （`pe_load_file` 就是这么认的），进 `dlls` 而不进符号表
 *        - `libtcc1`：支持库的文件名（带交叉前缀，如 `x86_64-win32-libtcc1.a`）
 *        - `open(names)`：给一串候选文件名，回 `{path, bytes}` 或 `null`
 * @returns `{trace, tab, start, peType, dlls, members, objs}`；`trace` 每条
 *          `{kind:'file'|'member', path}`，`objs` 是**真的目标文件**那几份字节
 */
export function peLoad(inp) {
  const tab = new SymTab();
  const trace = [];
  const members = [];
  const dlls = [];
  const objs = [];

  const loadObject = (bytes) => tab.addObject(readSymbols(readObject(bytes)));

  for (const o of inp.objs) {
    trace.push({ kind: 'file', path: o.path });
    if (o.bytes[0] === 0x4d && o.bytes[1] === 0x5a) { dlls.push(readDllExports(o.bytes, o.path)); continue; }
    objs.push(o.bytes);
    loadObject(o.bytes);
  }

  const { start, entryName, peType } = peStart(tab, inp);
  tab.declare(start);                            // 就是这一句把 crt 拉进来

  if (inp.nostdlib === true) return { trace, tab, start, entryName, peType, dlls, members, objs };

  const want = [[inp.libtcc1], ...runtimeLibs(peType).map((l) => libCandidates(l))];
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
    trace, tab, start, entryName, peType, dlls, members, objs,
  };
}

function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
