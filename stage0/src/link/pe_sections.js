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
 *  - 第一个 rdata 类的节就是 thunk 节，导入表接在它后面（对到 16）。
 *  - `.reloc` 只在 DLL 或者 `DYNAMIC_BASE` 时才有（arm64-win32 默认有，x86_64 没有）。
 *    里面是按 4K 分页的块：8 字节的头 + 每条 2 字节，块尾对到 4 字节。
 */

import { OmniError } from '../source/diag.js';
import { readObject } from './elf.js';
import { mergeObjects } from './elf_merge.js';
import { readSymbols } from './pe_load.js';
import { buildImports } from './pe.js';

const SHT_PROGBITS = 1;
const SHT_NOBITS = 8;
const SHT_INIT_ARRAY = 14;
const SHT_FINI_ARRAY = 15;
const SHF_WRITE = 0x1;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;
const SHF_TLS = 0x400;

const SHN_UNDEF = 0;
const STT_NOTYPE = 0;
const STT_FUNC = 2;
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
  const thunked = new Set();                       // 已经有桩的那些导入符号
  let nthunks = 0;
  for (const sym of syms) {
    if (sym.shndx !== SHN_UNDEF || sym.name === '') continue;
    let imp = (sym.other & ST_PE_IMPORT) !== 0;
    let hit = null;
    for (let n = 0; n < 2; n++) {
      /* `pe_export_name`：只有带前导下划线的目标才削那一个 `_`。 */
      let s = under && sym.name.startsWith('_') && (sym.other & ST_PE_STDCALL) === 0
        ? sym.name.slice(1) : sym.name;
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
    if (sym.type === STT_FUNC || (sym.type === STT_NOTYPE && !imp)) {
      if (!thunked.has(hit.key)) { thunked.add(hit.key); nthunks++; }
    }
  }
  return { dlls: order.map((d) => ({ name: d, syms: byDll.get(d) })), nthunks };
}

/** `pe_build_reloc`：把要装载时重定位的地方按 4K 分页摆成一串块。 */
export function buildReloc(entries) {
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
    put16((addr - page) | (10 << 12));              // IMAGE_REL_BASED_DIR64
    count++;
  }
  if (count !== 0) close();
  return new Uint8Array(out);
}

/**
 * 把并合好的节摆成 PE 的节表。
 *
 * @param inp `{objs, dlls, imagebase, dynamicBase, leadingUnderscore}`
 *        - `objs`：命令行上那些 `.o` 加上从库里拉出来的成员，字节数组
 *        - `dlls`：`peLoad` 装出来的那几个 `.def`
 * @returns `{machine, infos, entrySecs, imp, nthunks}`；`infos` 每条
 *          `{name, cls, vaddr, vsize, dataSize, ptr, rawSize, flags}`
 */
export function peSections(inp) {
  const imagebase = inp.imagebase ?? 0x400000;
  const merged = mergeObjects(inp.objs, { rdata: '.rdata' });
  const mo = readObject(merged);
  const machine = mo.machine;
  const syms = readSymbols(mo);

  /* `.def` 那张表：名字 → dll 与序号。同名先到先得（`set_elf_sym` 里未定义的那一条
   * 不会被后来的未定义符号顶掉）。 */
  const dyn = new Map();
  for (const d of inp.dlls ?? []) {
    for (const s of d.syms) if (!dyn.has(s.name)) dyn.set(s.name, { dll: d.dll, ordinal: s.ordinal });
  }
  const { dlls, nthunks } = collectImports(syms, dyn, inp);

  /* 节的工作副本。次序就是并合出来的次序 —— 插入排序是稳定的，靠的正是这个。 */
  const secs = mo.secs.map((s) => ({
    name: s.name, type: s.type, flags: s.flags, size: s.size, bytes: s.bytes,
  }));
  const find = (n) => secs.find((s) => s.name === n);

  /* `.text` 先对到 8，再一个导入函数一个桩。 */
  const text = find('.text');
  if (text === undefined) throw new OmniError('pe: 没有 .text');
  const tsz = thunkSize(machine);
  const thunkAt = align(text.size, 8);
  text.size = thunkAt + nthunks * tsz;
  /* arm64（与 arm）上 `R_XXX_THUNKFIX` 正好**就是** `REL_TYPE_DIRECT` —— 于是每个桩
   * 里指向 IAT 那一格也要进 `.reloc`。x86_64 上它是 PC32，不算。 */
  if (machine === EM_AARCH64 || machine === EM_ARM) {
    const fixAt = machine === EM_AARCH64 ? 16 : 8;
    text.extraDirect = [];
    for (let k = 0; k < nthunks; k++) text.extraDirect.push(thunkAt + k * tsz + fixAt);
  }

  const reloc = inp.dynamicBase === true
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
  let thunk = null;
  for (const { sec, cls } of sorted) {
    if (cls >= CLS.last) continue;
    const c = cls === CLS.bss ? CLS.data : cls;     // PE_MERGE_DATA
    if (si !== null && c === si.cls && c !== CLS.debug) {
      addr = align(addr, 16);                       // 与上一节并成一条
    } else {
      si = null;
      addr = align(addr, SECTION_ALIGN);
    }
    sec.vaddr = addr;

    /* 第一个 rdata 类的节就是 thunk 节，导入表接在它屁股后面。 */
    if (thunk === null && c === CLS.rdata) {
      thunk = sec;
      if (dlls.length !== 0) {
        const at = align(sec.size, 16);
        imp = { rva: addr - imagebase, at, dlls };
        sec.size = at + buildImports(imp).length;
      }
    }

    if (sec === reloc) {
      const direct = directRelocType(machine);
      const entries = [];
      for (const info of infos) {
        for (const s of info.secs) {
          const rela = find(`.rela${s.name}`);
          if (rela === undefined) continue;
          const dv = new DataView(rela.bytes.buffer, rela.bytes.byteOffset, rela.bytes.byteLength);
          for (let p = 0; p + 24 <= rela.bytes.length; p += 24) {
            if (dv.getUint32(p + 8, true) !== direct) continue;
            entries.push(s.vaddr - imagebase + Number(dv.getBigUint64(p, true)));
          }
        }
        /* 导入桩那几条重定位是链接时加在 `.rela.text` **末尾**的。 */
        for (const s of info.secs) {
          for (const at of s.extraDirect ?? []) entries.push(s.vaddr - imagebase + at);
        }
      }
      sec.bytes = buildReloc(entries);
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
    addr += sec.size;
    si.vsize = addr - si.vaddr;
    if (sec.type !== SHT_NOBITS) si.dataSize = si.vsize;
  }

  /* 文件偏移（`pe_write`）：头之后一节一节按 `FileAlignment` 排下去。没有内容的节
   * （`.bss`）不占文件，可 `-vv` 打出来的那一格是**当时的游标**，不是它的
   * `PointerToRawData`（那一格是 0）—— 打印那一句在 `if (si->data_size)` 之前。 */
  let off = align(HDR_SIZE + infos.length * SECHDR_SIZE, FILE_ALIGN);
  for (const info of infos) {
    info.filePos = off;
    if (info.dataSize === 0) { info.ptr = 0; info.rawSize = 0; continue; }
    info.ptr = off;
    off = align(off + info.dataSize, FILE_ALIGN);
    info.rawSize = off - info.ptr;
  }

  return { machine, infos, imp, nthunks, syms, secs, merged, imagebase, fileSize: off };
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
