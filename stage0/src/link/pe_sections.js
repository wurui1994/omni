/* PE 的节表：分类、摆地址、导入桩、重定位块 —— ADR-0017 第 11 步，第九刀第四十八片。
 *
 * 第四十七片解决了「该读哪些字节」，这一片解决「这些字节摆在哪」。尺子还是 `tcc -vv`：
 * 它在写文件之前会把最终的节表打出来（`虚拟地址 文件偏移 长度 节名`），那正是
 * `pe_assign_addresses` 的结果 + `pe_write` 算出来的文件偏移。
 *
 * 照的是 `tccpe.c` 的 `pe_section_class` / `pe_assign_addresses` / `pe_check_symbols` /
 * `pe_build_reloc`。要点：
 *
 *  - **节按「类」重排**，不按名字：text < rdata < data < bss < idata < pdata < tls <
 *    other < rsrc < debug < reloc。用的是插入排序，所以同一类里保持原来的次序。
 *  - 同一类连着的几节**并成一条**（对到 16），换类就对到 `SectionAlignment`（0x1000）。
 *    `PE_MERGE_DATA` 把 `.bss` 也算进 data 那一类。
 *  - 空节（`data_offset == 0`）不进节表，可它**照样把地址推到下一个 0x1000** ——
 *    `s->sh_addr = addr = pe_virtual_align(...)` 在 `continue` 之前就做了。
 *  - `.text` 在链接时会长：先对到 8（`pe_align_section(text_section, 8)`），然后每个
 *    「用作函数的导入符号」加一个跳转桩（x86_64 是 `ff 25` 那 8 字节，arm64 是 24 字节）。
 *  - 第一个 rdata 类的节就是 thunk 节，导入表接在它后面（对到 16），造 DLL 的时候
 *    导出表再接在导入表后面（也对到 16）。
 *  - `.reloc` 只在 DLL 或者 `DYNAMIC_BASE` 时才有（arm64-win32 默认有，x86_64 没有）。
 *    里面是按 4K 分页的块：8 字节的头 + 每条 2 字节，块尾对到 4 字节。
 */

import { OmniError } from '../source/diag.js';
import { readObject } from './elf.js';
import { mergeObjects, DWARF_SECTIONS } from './elf_merge.js';
import { readSymbols } from './pe_load.js';
import { buildImports } from './pe.js';

const SHT_PROGBITS = 1;
const SHT_RELA = 4;
const SHT_STRTAB = 3;
const SHT_NOBITS = 8;
const SHT_INIT_ARRAY = 14;
const SHT_FINI_ARRAY = 15;
const SHF_WRITE = 0x1;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;
const SHF_TLS = 0x400;
const RELA_SIZE = 24;
/** 32 位那一路：`SHT_REL`，一条 8 字节，`r_info` 是「高 24 位符号号 + 低 8 位类型」。 */
const SHT_REL = 9;
const REL32_SIZE = 8;
const R_X86_64_RELATIVE = 8;
const R_AARCH64_RELATIVE = 1027;
const R_386_RELATIVE = 8;
const R_ARM_RELATIVE = 23;
/** `pe_build_reloc` 里那个 `PE_IMAGE_REL`：64 位是 `DIR64`，32 位是 `HIGHLOW`。 */
const IMAGE_REL_BASED_HIGHLOW = 3;
const IMAGE_REL_BASED_DIR64 = 10;

const SHN_UNDEF = 0;
const SHN_COMMON = 0xfff2;
const STT_NOTYPE = 0;
const STT_FUNC = 2;
const STB_GLOBAL = 1;
const ST_PE_EXPORT = 0x10;
const ST_PE_IMPORT = 0x20;
const ST_PE_STDCALL = 0x40;

const EM_386 = 3;
const EM_X86_64 = 62;
const EM_ARM = 40;
const EM_AARCH64 = 183;

const SECTION_ALIGN = 0x1000;
const FILE_ALIGN = 0x200;
const HDR_SIZE = 392;
const SECHDR_SIZE = 40;

const SCN_CNT_CODE = 0x00000020;
const SCN_CNT_INITIALIZED_DATA = 0x00000040;
const SCN_CNT_UNINITIALIZED_DATA = 0x00000080;
const SCN_MEM_DISCARDABLE = 0x02000000;
const SCN_MEM_EXECUTE = 0x20000000;
const SCN_MEM_READ = 0x40000000;
const SCN_MEM_WRITE = 0x80000000;

/** `tccpe.c` 里那个 `enum`，次序就是重排的次序。 */
export const CLS = {
  text: 0, rdata: 1, data: 2, bss: 3, idata: 4, pdata: 5,
  tls: 6, other: 7, rsrc: 8, debug: 9, reloc: 10, last: 11,
};

/** 一个导入函数的跳转桩占多少字节（`pe_check_symbols`）。 */
function thunkSize(machine) {
  if (machine === EM_AARCH64) return 24;
  if (machine === EM_ARM) return 12;
  if (machine === EM_X86_64 || machine === EM_386) return 8;
  throw new OmniError(`pe: 不认识的架构 0x${machine.toString(16)}`);
}

/** 需要在装载时重定位的那种重定位号（`REL_TYPE_DIRECT`）。 */
function directRelocType(machine) {
  if (machine === EM_AARCH64) return 257;                // R_AARCH64_ABS64
  if (machine === EM_X86_64) return 1;                   // R_X86_64_64
  if (machine === EM_386 || machine === EM_ARM) return 1;// R_386_32 / R_ARM_ABS32
  throw new OmniError(`pe: 不认识的架构 0x${machine.toString(16)}`);
}

const align = (n, to) => Math.ceil(n / to) * to;

/** `pe_section_class`。 */
export function sectionClass(s) {
  if (s.name.startsWith('.stab') || s.name.startsWith('.debug_')) return CLS.debug;
  if ((s.flags & SHF_ALLOC) !== 0) {
    if ((s.flags & SHF_TLS) !== 0) return CLS.tls;
    if (s.type === SHT_PROGBITS || s.type === SHT_INIT_ARRAY || s.type === SHT_FINI_ARRAY) {
      if ((s.flags & SHF_EXECINSTR) !== 0) return CLS.text;
      if ((s.flags & SHF_WRITE) !== 0) return CLS.data;
      if (s.name === '.rsrc') return CLS.rsrc;
      if (s.name === '.iedat') return CLS.idata;
      if (s.name === '.pdata') return CLS.pdata;
      return CLS.rdata;
    }
    if (s.type === SHT_NOBITS) return CLS.bss;
    return CLS.other;
  }
  return s.name === '.reloc' ? CLS.reloc : CLS.last;
}

/**
 * `pe_check_symbols` 里挑导入符号那一段：一个未定义符号要经过最多两次改名去
 * `.def` 那张表里找，找到了就记一条导入，若它是函数还要在 `.text` 里加一个桩。
 *
 * @param syms 并合后的 `.symtab`
 * @param dyn 名字 → `{dll, ordinal}`（`.def` 装出来的那张表）
 * @returns `{dlls, nthunks}`，`dlls` 就是 `buildImports` 要的那个形状
 */
export function collectImports(syms, dyn, opts) {
  const under = (opts ?? {}).leadingUnderscore === true;
  const order = [];                                // dll 名字，按第一次用到的次序
  const byDll = new Map();                         // dll 名字 → [{name, ordinal}]
  const thunkIdx = new Map();                      // 导入符号 → 它的桩是第几个
  const bind = new Map();                          // 并合后的符号名 → 它绑到哪个导入符号
  for (const sym of syms) {
    if (sym.shndx !== SHN_UNDEF || sym.name === '') continue;
    let imp = (sym.other & ST_PE_IMPORT) !== 0;
    let hit = null;
    for (let n = 0; n < 2; n++) {
      /* `pe_export_name`：只有带前导下划线的目标才削那一个 `_`。 */
      let s = exportName(sym, under);
      if (n === 1) {
        if ((sym.other & ST_PE_STDCALL) !== 0) {
          const p = s.lastIndexOf('@');
          if (p < 0 || s[0] !== '_') break;
          s = s.slice(1, p);
        } else if (s[0] !== '_') {
          s = `_${s}`;                             // 试一下带下划线的那个
        } else if (s.startsWith('_imp__') || s.startsWith('__imp_')) {
          s = s.slice(6);
          imp = true;
        } else {
          break;
        }
      }
      const d = dyn.get(s);
      if (d !== undefined) { hit = { key: s, ...d }; break; }
    }
    if (hit === null) continue;                    // 不是导入，留给 relocate_syms 去报错
    if (!byDll.has(hit.dll)) { byDll.set(hit.dll, []); order.push(hit.dll); }
    const list = byDll.get(hit.dll);
    if (!list.some((x) => x.name === hit.key)) list.push({ name: hit.key, ordinal: hit.ordinal });
    /* 汇编来的符号常常没有类型，所以 `STT_NOTYPE` 也算函数 —— 除非它是
     * `__declspec(dllimport)` 标出来的数据。 */
    const func = sym.type === STT_FUNC || (sym.type === STT_NOTYPE && !imp);
    if (func && !thunkIdx.has(hit.key)) thunkIdx.set(hit.key, thunkIdx.size);
    bind.set(sym.name, { key: hit.key, func });
  }
  const dlls = order.map((d) => ({ name: d, syms: byDll.get(d) }));
  /* IAT 里那一格是第几个：一个 dll 的符号排完还空一格（结尾那个 0）。 */
  const slot = new Map();
  let k = 0;
  for (const d of dlls) {
    for (const s of d.syms) slot.set(s.name, k++);
    k++;
  }
  return { dlls, nthunks: thunkIdx.size, thunkIdx, slot, bind };
}

/** `pe_export_name`：只有带前导下划线的目标才削那一个 `_`，`@` 结尾的 stdcall 不削。 */
function exportName(sym, under) {
  return under && sym.name.startsWith('_') && (sym.other & ST_PE_STDCALL) === 0
    ? sym.name.slice(1) : sym.name;
}

/**
 * `pe_build_exports`：导出目录，接在导入表后面（对到 16）。
 *
 * 它**不问**是不是 DLL —— `pe_assign_addresses` 走到 thunk 那一节就无条件调它一次，
 * 所以一份普通的 `.exe` 里只要有 `__declspec(dllexport)` 的符号，一样会摆出这张表，
 * 一样会顺手写出那份 `<输出>.def`。
 *
 * 布局是四张表连着：40 字节的 `IMAGE_EXPORT_DIRECTORY`、每个符号 4 字节的函数 RVA、
 * 每个符号 4 字节的名字 RVA、每个符号 2 字节的序号，然后是 dll 自己的名字与各个符号名
 * （一串 `\0` 结尾的字符串）。次序按名字 `strcmp` 排 —— 不是符号表里的次序。
 *
 * 函数 RVA 那一格是**空着**的：tcc 给它挂一条 `R_XXX_RELATIVE`，落笔时才写进去。我们
 * 把要挂的地方记在 `slots` 里，交给 `peImage`。
 *
 * @param syms 并合后的 `.symtab`（下标要与重定位里的符号号对得上）
 * @param outName 输出文件的路径（`pe->filename`）；表里写的是它的**基名**
 * @param baseO 这一段在 thunk 节里的偏移（已经对到 16）
 * @param rvaBase thunk 节的 RVA
 * @returns `null`（没有导出符号）或 `{at, size, bytes, slots, def}`
 */
export function buildExports(syms, outName, baseO, rvaBase, under) {
  const list = [];
  for (let i = 1; i < syms.length; i++) {
    const s = syms[i];
    if (s === undefined || (s.other & ST_PE_EXPORT) === 0) continue;
    list.push({ index: i, name: exportName(s, under) });
  }
  if (list.length === 0) return null;
  list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (outName === undefined) throw new OmniError('pe: 有导出的符号，要知道输出的文件名');
  const dllName = outName.split(/[\\/]/).pop();

  const n = list.length;
  const funcO = baseO + 40;
  const nameO = funcO + n * 4;
  const ordO = nameO + n * 4;
  const strO = ordO + n * 2;
  const head = new Uint8Array(strO - baseO);
  const dv = new DataView(head.buffer);
  dv.setUint32(12, strO + rvaBase, true);           // Name
  dv.setUint32(16, 1, true);                        // Base
  dv.setUint32(20, n, true);                        // NumberOfFunctions
  dv.setUint32(24, n, true);                        // NumberOfNames
  dv.setUint32(28, funcO + rvaBase, true);          // AddressOfFunctions
  dv.setUint32(32, nameO + rvaBase, true);          // AddressOfNames
  dv.setUint32(36, ordO + rvaBase, true);           // AddressOfNameOrdinals

  const tail = [];
  const putStr = (s) => { for (let i = 0; i < s.length; i++) tail.push(s.charCodeAt(i) & 0xff); tail.push(0); };
  putStr(dllName);
  const slots = [];
  for (let ord = 0; ord < n; ord++) {
    dv.setUint32(nameO - baseO + ord * 4, strO + tail.length + rvaBase, true);
    dv.setUint16(ordO - baseO + ord * 2, ord, true);
    putStr(list[ord].name);
    slots.push({ at: funcO + ord * 4, sym: list[ord].index });
  }

  const bytes = new Uint8Array(head.length + tail.length);
  bytes.set(head, 0);
  bytes.set(new Uint8Array(tail), head.length);
  /* `fprintf(op, "LIBRARY %s\n\nEXPORTS\n", dllname)` 然后一行一个名字 —— 文件是
   * `"wb"` 开的，所以换行就是一个 `\n`，末尾也有一个。 */
  const def = `LIBRARY ${dllName}\n\nEXPORTS\n${list.map((x) => `${x.name}\n`).join('')}`;
  return { at: baseO, size: bytes.length, bytes, slots, def };
}

/** `pe_build_reloc`：把要装载时重定位的地方按 4K 分页摆成一串块。 */
export function buildReloc(entries, type) {
  const kind = type ?? IMAGE_REL_BASED_DIR64;
  const out = [];
  const put16 = (v) => { out.push(v & 0xff, (v >> 8) & 0xff); };
  let count = 0;
  let blockAt = 0;
  let page = 0;
  const close = () => {
    if ((count & 1) !== 0) { put16(0); count++; }   // 对到 4 字节
    const size = count * 2 + 8;
    const dv = new DataView(new ArrayBuffer(8));
    dv.setUint32(0, page >>> 0, true);
    dv.setUint32(4, size, true);
    for (let i = 0; i < 8; i++) out[blockAt + i] = dv.getUint8(i);
    count = 0;
  };
  for (const addr of entries) {
    if (count === 0) {
      blockAt = out.length;
      for (let i = 0; i < 8; i++) out.push(0);
      page = addr & ~0xfff;
    } else if (addr - page >= 0x1000) {
      close();
      blockAt = out.length;
      for (let i = 0; i < 8; i++) out.push(0);
      page = addr & ~0xfff;
    }
    put16((addr - page) | (kind << 12));
    count++;
  }
  if (count !== 0) close();
  return new Uint8Array(out);
}

/**
 * 把并合好的节摆成 PE 的节表。
 *
 * @param inp `{objs, dlls, res, imagebase, dllChars, leadingUnderscore, dll, outName,
 *        subsystem, gui, sectionAlign, fileAlign}`
 *        - `objs`：命令行上那些 `.o` 加上从库里拉出来的成员，字节数组
 *        - `dlls`：`peLoad` 装出来的那几个 `.def`
 *        - `res`：`peLoad` 读出来的那几份资源（`{bytes, relocs}`），一份一节 `.rsrc`
 *        - `debug`：`-g`。输入里的 `.stab` / `.stabstr` 跟着并进来（各自独占一条节表项，
 *          调试那一类**从不与前一节并条**），写文件时再接一张 COFF 符号表
 *        - `dll`：造 DLL（`-shared`）。映像基址换成 `IMAGE_BASE_DLL`、一定有 `.reloc`、
 *          thunk 节里多一张导出表；`outName` 的基名就写进导出表里当 dll 名
 *        - `imagebase` / `subsystem` / `sectionAlign` / `fileAlign` / `dllChars`：
 *          `-Wl,--image-base=` / `-subsystem=` / `--section-alignment=` /
 *          `--file-alignment=` / `--dynamicbase` 那几个开关，不给就按目标取默认值
 * @returns `{machine, infos, entrySecs, imp, exp, nthunks}`；`infos` 每条
 *          `{name, cls, vaddr, vsize, dataSize, ptr, rawSize, flags}`
 */
export function peSections(inp) {
  const merged = mergeObjects(inp.objs, {
    rdata: '.rdata', debug: inp.debug === true, dwarf: inp.dwarf, declare: inp.declare,
  });
  const mo = readObject(merged);
  const machine = mo.machine;
  /* 32 位的目标（i386 / arm-wince）：符号 16 字节、重定位表叫 `.rel.X` 而不是
   * `.rela.X`、一条 8 字节没有加数，装载时重定位那张表里的类型是 `HIGHLOW`。 */
  const c32 = mo.class32 === true;
  const relSize = c32 ? REL32_SIZE : RELA_SIZE;
  const relType = c32 ? SHT_REL : SHT_RELA;
  const relPfx = c32 ? '.rel' : '.rela';
  const syms = readSymbols(mo);
  /* 映像基址与「要不要 `.reloc`」都是按目标定的（`IMAGE_BASE_EXE` 与
   * `DLLCHARACTERISTICS`）：x86_64 是 0x400000 且不带 `DYNAMIC_BASE`，
   * arm64 是 0x140000000 且带。 */
  const arm64 = machine === EM_AARCH64;
  const dll = inp.dll === true;
  /* `DllCharacteristics`：arm64-win32 的默认值是 0x8160（`libtcc.c` 里那个
   * `#if defined TCC_TARGET_ARM64 && defined TCC_TARGET_PE`），别的目标是 0。
   * `-Wl,--dynamicbase` / `--nxcompat` / `--tsaware` / `--high-entropy-va` 改的就是它。 */
  const dllChars = inp.dllChars ?? (arm64 ? 0x8160 : 0);
  /* `.reloc` 那一节：DLL 一定有，可执行文件只在带 `DYNAMIC_BASE`（0x40）时才有 ——
   * arm64 默认就带，所以它默认有；x86_64 要 `-Wl,--dynamicbase` 才有。 */
  const hasReloc = dll || (dllChars & 0x40) !== 0;
  /* `pe_set_options`：DLL 与 GUI 是 2、别的是 3，`-Wl,-subsystem=` 一律盖过。 */
  const subsystem = inp.subsystem ?? (dll || inp.gui === true ? 2 : 3);
  /* subsystem 1（native）那两个对齐都是 0x20，别的是 0x1000 / 0x200。 */
  const sectionAlign = inp.sectionAlign ?? (subsystem === 1 ? 0x20 : SECTION_ALIGN);
  const fileAlign = inp.fileAlign ?? (subsystem === 1 ? 0x20 : FILE_ALIGN);
  /* `IMAGE_BASE_EXE` / `IMAGE_BASE_DLL`：DLL 那一路除了 arm64 都是 0x10000000，
   * 可执行文件那一路 x86_64 与 i386 是 0x400000、arm64 是 0x140000000、arm 是 0x100000。 */
  const BASE_EXE = new Map([[EM_X86_64, 0x400000], [EM_386, 0x400000],
    [EM_AARCH64, 0x140000000], [EM_ARM, 0x100000]]);
  let imagebase = dll
    ? (arm64 ? 0x180000000 : 0x10000000)
    : (BASE_EXE.get(machine) ?? 0x400000);
  if (subsystem >= 10 && subsystem <= 12) imagebase = 0;   // EFI 那三种从 0 起
  /* `-Wl,--image-base=` / `-Wl,-Ttext=`（`s1->has_text_addr`）最后说话。 */
  if (inp.imagebase !== undefined) imagebase = inp.imagebase;

  /* `.def` 那张表：名字 → dll 与序号。同名先到先得（`set_elf_sym` 里未定义的那一条
   * 不会被后来的未定义符号顶掉）。 */
  const dyn = new Map();
  for (const d of inp.dlls ?? []) {
    for (const s of d.syms) if (!dyn.has(s.name)) dyn.set(s.name, { dll: d.dll, ordinal: s.ordinal });
  }
  const imps = collectImports(syms, dyn, inp);
  const { dlls, nthunks } = imps;

  /* 节的工作副本。次序就是并合出来的次序 —— 插入排序是稳定的，靠的正是这个。 */
  const secs = mo.secs.map((s) => ({
    name: s.name, type: s.type, flags: s.flags, size: s.size, bytes: s.bytes,
    link: s.link, info: s.info,
  }));
  const find = (n) => secs.find((s) => s.name === n);

  /* `pe_load_res`：每份资源文件加一节 `.rsrc`（`SHT_PROGBITS | SHF_ALLOC`）、一个
   * 同名的局部符号，再把 COFF 那张重定位表整条改挂成 `R_XXX_RELATIVE` 指向那个符号。
   * 于是资源目录里指向数据的那几格落笔时得到「原地那个节内偏移 + 这一节的 RVA」。
   * `RELATIVE` 不是 `REL_TYPE_DIRECT`，所以这几条**不进** `.reloc`。 */
  for (const rs of inp.res ?? []) {
    const sec = {
      name: '.rsrc', type: SHT_PROGBITS, flags: SHF_ALLOC,
      size: rs.bytes.length, bytes: rs.bytes,
    };
    secs.push(sec);
    const shndx = secs.length;                   // `secs` 是从 1 号节开始摆的
    const symx = syms.length;
    syms.push({ name: '.rsrc', info: 0, bind: 0, type: 0, other: 0, shndx, value: 0, size: 0 });
    const rela = new Uint8Array(rs.relocs.length * relSize);
    const dv = new DataView(rela.buffer);
    const REL = new Map([[EM_AARCH64, R_AARCH64_RELATIVE], [EM_X86_64, R_X86_64_RELATIVE],
      [EM_386, R_386_RELATIVE], [EM_ARM, R_ARM_RELATIVE]]);
    const rel = REL.get(machine);
    if (rel === undefined) throw new OmniError(`pe: 不认识的架构 0x${machine.toString(16)}`);
    for (let i = 0; i < rs.relocs.length; i++) {
      if (c32) {
        dv.setUint32(i * relSize, rs.relocs[i], true);
        dv.setUint32(i * relSize + 4, ((symx << 8) | rel) >>> 0, true);
        continue;
      }
      dv.setBigUint64(i * relSize, BigInt(rs.relocs[i]), true);
      dv.setUint32(i * relSize + 8, rel, true);
      dv.setUint32(i * relSize + 12, symx, true);
    }
    secs.push({
      name: `${relPfx}.rsrc`, type: relType, flags: 0,
      size: rela.length, bytes: rela, info: shndx,
    });
  }

  /* `resolve_common_syms` 里那一半：`SHN_COMMON` 的符号在 `.bss` 里安家。
   * （`tcc -r` 不做这一步，所以并合出来的表里它们还是 COMMON。） */
  const bss = find('.bss');
  const commons = [];
  for (const sym of syms) {
    if (sym.shndx !== SHN_COMMON || sym.size === 0) continue;
    if (bss === undefined) throw new OmniError('pe: 有 COMMON 符号可是没有 .bss');
    const at = align(bss.size, sym.value || 1);    // COMMON 的 st_value 是对齐要求
    bss.size = at + sym.size;
    commons.push({ name: sym.name, sec: bss, off: at });
  }

  /* `tcc_add_linker_symbols`：几个链接器自己提供的符号。注意它跑在 `pe_check_symbols`
   * **之前**，所以 `_etext` 是导入桩还没接上去时的 `.text` 长度。
   *
   * 这些符号是 `set_global_sym` 加的 —— 表里**没有也要新建一条**。以前这一格无所谓
   * （没人引用的符号不影响任何字节），可 `-g` 的时候它们会出现在 COFF 符号表里，
   * 于是「建了没有」看得见了。只有 `set_linker_sym` 那三个的**不带下划线**那一版
   * 是「表里已经有才建」（`f == 1` 那一路）。 */
  const linker = new Map();
  const symOf = (n) => syms.find((x) => x.name === n);
  const define = (name, sec, off) => {
    if (sec === undefined) return;
    const s = symOf(name);
    if (s === undefined) {
      syms.push({
        name, info: STB_GLOBAL * 16, bind: STB_GLOBAL, type: STT_NOTYPE,
        other: 0, shndx: SHN_UNDEF, value: 0, size: 0,
      });
    } else if (s.shndx !== SHN_UNDEF) {
      return;                                      // 已经有定义：tcc 只警告一句就走
    }
    linker.set(name, { sec, off });
  };
  const pair = (name, sec, off) => {
    define(name, sec, off);
    const bare = symOf(name.slice(1));
    if (bare !== undefined && bare.shndx === SHN_UNDEF) define(name.slice(1), sec, off);
  };
  pair('_etext', find('.text'), find('.text')?.size ?? 0);
  pair('_edata', find('.data'), find('.data')?.size ?? 0);
  pair('_end', bss, bss?.size ?? 0);
  for (const nm of ['.preinit_array', '.init_array', '.fini_array']) {
    let s = find(nm);
    let end;
    if (s === undefined || (s.flags & SHF_ALLOC) === 0) { end = 0; s = find('.text'); } else { end = s.size; }
    define(`__${nm.slice(1)}_start`, s, 0);
    define(`__${nm.slice(1)}_end`, s, end);
  }
  for (const s of secs) {
    if ((s.flags & SHF_ALLOC) === 0) continue;
    if (s.type !== SHT_PROGBITS && s.type !== SHT_NOBITS && s.type !== SHT_STRTAB) continue;
    const p0 = s.name.startsWith('.') ? s.name.slice(1) : s.name;
    if (!/^[A-Za-z_$0-9]*$/.test(p0)) continue;    // 名字能不能写成 C 的标识符
    define(`__start_${p0}`, s, 0);
    define(`__stop_${p0}`, s, s.size);
  }
  for (const c of commons) linker.set(c.name, { sec: c.sec, off: c.off });

  /* `.text` 先对到 8，再一个导入函数一个桩。 */
  const text = find('.text');
  if (text === undefined) throw new OmniError('pe: 没有 .text');
  const tsz = thunkSize(machine);
  const thunkAt = align(text.size, 8);
  text.size = thunkAt + nthunks * tsz;
  /* arm64、arm 与 i386 上 `R_XXX_THUNKFIX` 正好**就是** `REL_TYPE_DIRECT` —— 于是每个桩
   * 里指向 IAT 那一格也要进 `.reloc`。只有 x86_64 上它是 PC32，不算。 */
  const THUNKFIX_AT = new Map([[EM_AARCH64, 16], [EM_ARM, 8], [EM_386, 2]]);
  const fixAt = THUNKFIX_AT.get(machine);
  if (fixAt !== undefined) {
    text.extraDirect = [];
    for (let k = 0; k < nthunks; k++) text.extraDirect.push(thunkAt + k * tsz + fixAt);
  }

  const hasTls = secs.some((s) => (s.flags & SHF_TLS) !== 0);
  /* `sizeof(IMAGE_TLS_DIRECTORY)`：四个指针加两个 DWORD —— 32 位上是 24 字节。 */
  const ptrSize = c32 ? 4 : 8;
  const tlsSize = hasTls ? 4 * ptrSize + 8 : 0;

  const reloc = hasReloc
    ? { name: '.reloc', type: SHT_PROGBITS, flags: 0, size: 0, bytes: new Uint8Array(0) }
    : null;
  if (reloc !== null) secs.push(reloc);

  /* 按类插入排序（`pe_assign_addresses` 开头那一段）。 */
  const sorted = [];
  for (const s of secs) {
    const k = sectionClass(s);
    let n = sorted.length;
    while (n > 0 && k < sorted[n - 1].cls) n--;
    sorted.splice(n, 0, { sec: s, cls: k });
  }

  const infos = [];
  let si = null;
  let addr = imagebase + 1;
  let imp = null;
  let exp = null;
  let tls = null;
  let thunk = null;
  for (const { sec, cls } of sorted) {
    if (cls >= CLS.last) continue;
    const c = cls === CLS.bss ? CLS.data : cls;     // PE_MERGE_DATA
    if (si !== null && c === si.cls && c !== CLS.debug) {
      addr = align(addr, 16);                       // 与上一节并成一条
    } else {
      si = null;
      addr = align(addr, sectionAlign);
    }
    sec.vaddr = addr;

    /* 第一个 rdata 类的节就是 thunk 节，导入表接在它屁股后面，导出表再接在导入表后面。 */
    if (thunk === null && c === CLS.rdata) {
      thunk = sec;
      if (dlls.length !== 0) {
        const at = align(sec.size, 16);
        imp = { rva: addr - imagebase, at, dlls, ptr: c32 ? 4 : 8 };
        sec.size = at + buildImports(imp).length;
      }
      /* `pe_build_exports` 是无条件调的 —— 可执行文件里带 `__declspec(dllexport)`
       * 的符号一样进这张表。没有这样的符号时它自己回 `null`。 */
      exp = buildExports(syms, inp.outName, align(sec.size, 16),
        addr - imagebase, inp.leadingUnderscore === true);
      if (exp !== null) sec.size = exp.at + exp.size;
      /* `pe_build_tls(pe, NULL)`：导出表后面再留一份 `IMAGE_TLS_DIRECTORY`（64 位
       * 40 字节、32 位 24 字节），顺手在 `.data` 里划 `PTR_SIZE * 4` 字节
       * （`__tls_index` 加三格），四个指针各挂一条 `REL_TYPE_DIRECT` —— 于是它们
       * 也要进 `.reloc`。 */
      if (tlsSize !== 0) {
        const dataSec = find('.data');
        if (dataSec === undefined) throw new OmniError('pe: 有线程局部的节，可是没有 .data');
        const dir = align(sec.size, 16);
        sec.size = dir + tlsSize;
        const data = align(dataSec.size, 16);
        dataSec.size = data + ptrSize * 4;
        sec.extraDirect = [];
        for (let n = 0; n < 4; n++) sec.extraDirect.push(dir + n * ptrSize);
        linker.set('__tls_index', { sec: dataSec, off: data });
        tls = { dir, size: tlsSize, data, dataSec, start: 0, end: 0, ptr: ptrSize };
      }
    }

    if (sec === reloc) {
      const direct = directRelocType(machine);
      /* `pe_build_reloc` 里那句 `if (dwarf) … continue`：**dwarf 指向 dwarf** 的
       * 那些不进 `.reloc`（`s1->dwlo` 到 `dwhi` 那个区间）。装载时搬动映像不影响
       * 调试信息内部互相指的偏移。 */
      const dw = new Set(DWARF_SECTIONS);
      const entries = [];
      for (const info of infos) {
        for (const s of info.secs) {
          const rela = find(`${relPfx}${s.name}`);
          if (rela !== undefined) {
            const inDwarf = dw.has(s.name);
            const dv = new DataView(rela.bytes.buffer, rela.bytes.byteOffset, rela.bytes.byteLength);
            for (let p = 0; p + relSize <= rela.bytes.length; p += relSize) {
              const info32 = c32 ? dv.getUint32(p + 4, true) : 0;
              const type = c32 ? info32 & 0xff : dv.getUint32(p + 8, true);
              if (type !== direct) continue;
              if (inDwarf) {
                const symx = c32 ? info32 >>> 8 : dv.getUint32(p + 12, true);
                const sym = syms[symx];
                const tgt = sym === undefined || sym.shndx === 0 ? undefined : secs[sym.shndx - 1];
                if (tgt !== undefined && dw.has(tgt.name)) continue;
              }
              const off = c32 ? dv.getUint32(p, true) : Number(dv.getBigUint64(p, true));
              entries.push(s.vaddr - imagebase + off);
            }
          }
          /* 链接时才加的那几条（arm64 的导入桩、TLS 目录里那四个指针）挂在这一节
           * 自己那张重定位表的**末尾**。 */
          for (const at of s.extraDirect ?? []) entries.push(s.vaddr - imagebase + at);
        }
      }
      sec.bytes = buildReloc(entries, c32 ? IMAGE_REL_BASED_HIGHLOW : IMAGE_REL_BASED_DIR64);
      sec.size = sec.bytes.length;
    }

    if (sec.size === 0) continue;                   // 空节不进节表，可地址已经推过了

    if (si === null) {
      si = {
        name: sec.name,
        cls: c,
        vaddr: addr,
        vsize: 0,
        dataSize: 0,
        secs: [],
        flags: peFlags(sec),
      };
      infos.push(si);
    }
    si.secs.push(sec);
    /* `s->sh_info = pe->sec_count`：这一节落在节表里第几条（1 起）。COFF 符号表里
     * 那个 `n_scnum` 要它 —— 并进同一条的几节记的是**同一个**号。 */
    sec.peIndex = infos.length;
    addr += sec.size;
    si.vsize = addr - si.vaddr;
    if (sec.type !== SHT_NOBITS) si.dataSize = si.vsize;

    /* `pe_build_tls(pe, s)`：线程局部那一条在节表里**改名叫 `.tls`**（哪怕并进来的
     * 是 `.tdata` 与 `.tbss` 两节），起点记第一节的地址、终点记最后一节的末尾。 */
    if ((sec.flags & SHF_TLS) !== 0 && tls !== null) {
      si.name = '.tls';
      if (tls.start === 0) tls.start = sec.vaddr;
      tls.end = sec.vaddr + sec.size;
    }
  }

  /* 文件偏移（`pe_write`）：头之后一节一节按 `FileAlignment` 排下去。没有内容的节
   * （`.bss`）不占文件，可 `-vv` 打出来的那一格是**当时的游标**，不是它的
   * `PointerToRawData`（那一格是 0）—— 打印那一句在 `if (si->data_size)` 之前。 */
  let off = align(HDR_SIZE + infos.length * SECHDR_SIZE, fileAlign);
  for (const info of infos) {
    info.filePos = off;
    if (info.dataSize === 0) { info.ptr = 0; info.rawSize = 0; continue; }
    info.ptr = off;
    off = align(off + info.dataSize, fileAlign);
    info.rawSize = off - info.ptr;
  }

  return {
    machine, infos, imp, exp, tls, nthunks, syms, secs, merged, imagebase, fileSize: off,
    imports: imps, text, thunkAt, thunkSize: tsz, thunk, linker, dll, hasReloc,
    dllChars, subsystem, sectionAlign, fileAlign, debug: inp.debug === true,
    class32: c32, relSize, relType,
  };
}

function peFlags(sec) {
  let f = SCN_MEM_READ;
  if ((sec.flags & SHF_EXECINSTR) !== 0) f |= SCN_MEM_EXECUTE | SCN_CNT_CODE;
  else if (sec.type === SHT_NOBITS && (sec.flags & SHF_TLS) === 0) f |= SCN_CNT_UNINITIALIZED_DATA;
  else f |= SCN_CNT_INITIALIZED_DATA;
  if ((sec.flags & SHF_WRITE) !== 0) f |= SCN_MEM_WRITE;
  if ((sec.flags & SHF_ALLOC) === 0) f |= SCN_MEM_DISCARDABLE;
  return f >>> 0;
}
