/* PE（Windows）映像的读与写 —— ADR-0017 第 11 步，第九刀第四十三片。
 *
 * 这一份对着 `tccpe.c` 的 `pe_write`。为什么可执行文件先写 PE 而不是 Mach-O 或 ELF：
 *
 *  - **PE 是三种里唯一完全确定的**：没有代码签名（macOS 上 arm64 的可执行文件
 *    `tcc` 自己都不签，它 `system("codesign -f -s -")` 让系统去签），也没有 dyld
 *    的那一摊（chained fixups、export trie）。
 *  - 而且**在这台机器上就能对账**：`x86_64-win32-tcc a.o -o a.exe` 能链得出来
 *    （win32 的导入库随 tinycc 源码走，不需要 Windows 的 sysroot），
 *    而 `x86_64-tcc`（Linux）少一个 Linux 的 crt/libc，本机链不了。
 *
 * 这一片先把**容器**立住：读一份 PE 映像，再从**模板**把它写回去 —— 头部除了
 * 「哪几格是算出来的」以外全部来自 `pe_template`，节头表的偏移与大小由
 * `pe_file_align` 现算。字节相同就说明模板的每一格与排布算式都对（`tests/c/pe-roundtrip.js`）。
 * 与第四十一片的 ELF 往返是同一种尺子：**与我们的代码生成无关**。
 *
 * 排布（`pe_write`）：
 *
 *   sizeofheaders = fileAlign(392 + 节数 * 40)      // 392 = DOS 头 128 + 4 + 20 + 240
 *   file_offset   = sizeofheaders
 *   每节：有数据才占文件
 *       PointerToRawData = file_offset
 *       file_offset      = fileAlign(file_offset + 数据长度)
 *       SizeOfRawData    = file_offset - PointerToRawData
 *   SizeOfImage = max(virtAlign(VirtualAddress + VirtualSize))
 *   SizeOfCode / SizeOfInitializedData = 按节的类别累加 SizeOfRawData
 */

import { OmniError } from '../source/diag.js';

const DOS_SIZE = 64;
const STUB_SIZE = 64;
const NT_SIG_OFF = DOS_SIZE + STUB_SIZE;      // 0x80，`e_lfanew` 指着这儿
const NT_SIGNATURE = 0x00004550;              // "PE\0\0"
const FILEHDR_OFF = NT_SIG_OFF + 4;
const FILEHDR_SIZE = 20;
const OPTHDR_OFF = FILEHDR_OFF + FILEHDR_SIZE;
/** PE32+ 的可选头：`0xE0 + (8-4)*4`。 */
const OPTHDR_SIZE = 0xf0;
const HDR_SIZE = OPTHDR_OFF + OPTHDR_SIZE;    // 392
const SECHDR_SIZE = 40;
const NDIRS = 16;

const PE_MAGIC64 = 0x020b;
/** 节里头是代码（`IMAGE_SCN_CNT_CODE`）—— `SizeOfCode` 只数这一类。 */
const SCN_CNT_CODE = 0x00000020;

/** 头里那两格 `SectionAlignment` / `FileAlignment`：**永远是模板里这两个数**。
 * `pe_write` 从来不把 `pe->section_align` / `pe->file_align` 写回头里 —— 于是
 * `-Wl,-subsystem=native`（真按 0x20 摆）出来的文件，头上写的还是 0x1000 / 0x200。 */
const HDR_SECTION_ALIGN = 0x1000;
const HDR_FILE_ALIGN = 0x200;

/** 每个目标的操作系统版本号（`tccpe.c` 开头那一串 `#if`）。 */
const MACHINES = new Map([
  [0x8664, { name: 'x86_64', osVer: 0x0400 }],
  [0xaa64, { name: 'arm64', osVer: 0x0602 }],
  [0x014c, { name: 'i386', osVer: 0x0400 }],
  [0x01c0, { name: 'arm', osVer: 0x0400 }],
]);

/* DOS 头那 64 字节：`pe_template` 里一格一格写死的。 */
const DOS_WORDS = [
  0x5a4d, 0x0090, 0x0003, 0x0000,
  0x0004, 0x0000, 0xffff, 0x0000,
  0x00b8, 0x0000, 0x0000, 0x0000,
  0x0040, 0x0000,
];

/* DOS stub：14 字节的代码 + "This program cannot be run in DOS mode.\r\r\n$" + 6 个 0。 */
const STUB = [
  0x0e, 0x1f, 0xba, 0x0e, 0x00, 0xb4, 0x09, 0xcd, 0x21, 0xb8, 0x01, 0x4c, 0xcd, 0x21, 0x54, 0x68,
  0x69, 0x73, 0x20, 0x70, 0x72, 0x6f, 0x67, 0x72, 0x61, 0x6d, 0x20, 0x63, 0x61, 0x6e, 0x6e, 0x6f,
  0x74, 0x20, 0x62, 0x65, 0x20, 0x72, 0x75, 0x6e, 0x20, 0x69, 0x6e, 0x20, 0x44, 0x4f, 0x53, 0x20,
  0x6d, 0x6f, 0x64, 0x65, 0x2e, 0x0d, 0x0d, 0x0a, 0x24, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

function align(n, to) {
  return n % to === 0 ? n : n + (to - (n % to));
}

/** 一份可以按偏移随便填的字节缓冲（PE 的头部是定长的，算完再回填最省事）。 */
class Image {
  constructor(size) {
    this.b = new Uint8Array(size);
    this.dv = new DataView(this.b.buffer);
  }

  u16(at, v) { this.dv.setUint16(at, v, true); }
  u32(at, v) { this.dv.setUint32(at, v >>> 0, true); }
  u64(at, v) { this.dv.setBigUint64(at, BigInt(v), true); }

  /** 定长的 8 字节节名，不足补 0。超过 8 字节的**就地截断** —— tcc 那一句是
   * `memcpy(psh->Name, sh_name, umin(strlen(sh_name), sizeof psh->Name))`，只有带
   * COFF 字符串表（`-g`）的时候才写成 `/<偏移>`。于是 `.init_array` 在节表里就是
   * `.init_ar`。 */
  name8(at, s) {
    const n = Math.min(s.length, 8);
    for (let i = 0; i < n; i++) this.b[at + i] = s.charCodeAt(i);
  }

  bytes(at, src) {
    this.b.set(src, at);
  }
}

/**
 * 读一份 PE 映像。头部里**算出来的那些格**（各种 SizeOf、PointerToRawData）不留，
 * 写回去的时候现算 —— 留下来的只有「不是算出来的」那些。
 *
 * @param bytes 整个文件
 * @returns `{machine, chars, subsystem, imagebase, entry, stack, dirs, secs}`
 */
export function readImage(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < HDR_SIZE) throw new OmniError('pe: 文件比一个 PE 头还短');
  if (dv.getUint16(0, true) !== 0x5a4d) throw new OmniError('pe: 开头不是 MZ');
  const lfanew = dv.getUint32(60, true);
  if (lfanew !== NT_SIG_OFF) throw new OmniError(`pe: e_lfanew 不是 0x80（是 0x${lfanew.toString(16)}）`);
  if (dv.getUint32(NT_SIG_OFF, true) !== NT_SIGNATURE) throw new OmniError('pe: 少了 "PE\\0\\0"');
  const machine = dv.getUint16(FILEHDR_OFF, true);
  if (!MACHINES.has(machine)) throw new OmniError(`pe: 不认识的机器号 0x${machine.toString(16)}`);
  const nsec = dv.getUint16(FILEHDR_OFF + 2, true);
  if (dv.getUint32(FILEHDR_OFF + 8, true) !== 0) {
    throw new OmniError('pe: 带 COFF 符号表（-g 出来的），这一片不认');
  }
  if (dv.getUint16(FILEHDR_OFF + 16, true) !== OPTHDR_SIZE) {
    throw new OmniError('pe: 可选头不是 PE32+ 的 0xf0 字节');
  }
  if (dv.getUint16(OPTHDR_OFF, true) !== PE_MAGIC64) throw new OmniError('pe: 只认 PE32+');

  const dirs = [];
  for (let i = 0; i < NDIRS; i++) {
    const at = OPTHDR_OFF + 112 + i * 8;
    dirs.push({ addr: dv.getUint32(at, true), size: dv.getUint32(at + 4, true) });
  }

  const secs = [];
  for (let i = 0; i < nsec; i++) {
    const at = HDR_SIZE + i * SECHDR_SIZE;
    let name = '';
    for (let k = 0; k < 8 && bytes[at + k] !== 0; k++) name += String.fromCharCode(bytes[at + k]);
    const rawSize = dv.getUint32(at + 16, true);
    const rawPtr = dv.getUint32(at + 20, true);
    secs.push({
      name,
      vsize: dv.getUint32(at + 8, true),
      vaddr: dv.getUint32(at + 12, true),
      chars: dv.getUint32(at + 36, true),
      /* 文件里那一段原样留着（已经是按 FileAlignment 补齐过的长度）。 */
      bytes: rawSize === 0 ? new Uint8Array(0) : bytes.slice(rawPtr, rawPtr + rawSize),
    });
  }

  return {
    machine,
    chars: dv.getUint16(FILEHDR_OFF + 18, true),
    subsystem: dv.getUint16(OPTHDR_OFF + 68, true),
    dllChars: dv.getUint16(OPTHDR_OFF + 70, true),
    sectionAlign: dv.getUint32(OPTHDR_OFF + 32, true),
    fileAlign: dv.getUint32(OPTHDR_OFF + 36, true),
    imagebase: Number(dv.getBigUint64(OPTHDR_OFF + 24, true)),
    entry: dv.getUint32(OPTHDR_OFF + 16, true),
    stack: Number(dv.getBigUint64(OPTHDR_OFF + 72, true)),
    dirs,
    secs,
  };
}

/**
 * 写一份 PE 映像。头部从**模板**起手（`pe_template`），只有这几格是算出来的：
 * `NumberOfSections`、`SizeOfHeaders`、`SizeOfImage`、`SizeOfCode`、
 * `SizeOfInitializedData`、`BaseOfCode`，以及每节的 `PointerToRawData` /
 * `SizeOfRawData`。
 *
 * @param img `readImage` 那个形状
 * @returns 整个文件的字节
 */
export function writeImage(img) {
  const cpu = MACHINES.get(img.machine);
  if (cpu === undefined) throw new OmniError(`pe: 不认识的机器号 0x${img.machine.toString(16)}`);
  const nsec = img.secs.length;
  const secAlign = img.sectionAlign;
  const filAlign = img.fileAlign;
  const headers = align(HDR_SIZE + nsec * SECHDR_SIZE, filAlign);

  /* 先把每节在文件里的位置算出来 —— 没数据的节（`.bss`）不占文件，两格都留 0。 */
  const place = [];
  let at = headers;
  let sizeOfCode = 0;
  let sizeOfData = 0;
  let sizeOfImage = 0;
  let baseOfCode = 0;
  for (const s of img.secs) {
    const code = (s.chars & SCN_CNT_CODE) !== 0;
    if (code && baseOfCode === 0) baseOfCode = s.vaddr;
    sizeOfImage = Math.max(sizeOfImage, align(s.vaddr + s.vsize, secAlign));
    if (s.bytes.length === 0) {
      place.push({ ptr: 0, size: 0 });
      continue;
    }
    const ptr = at;
    at = align(at + s.bytes.length, filAlign);
    const size = at - ptr;
    place.push({ ptr, size });
    if (code) sizeOfCode += size;
    else sizeOfData += size;
  }

  const out = new Image(at + (img.tail === undefined ? 0 : img.tail.length));
  /* ---- DOS 头 + stub。 */
  for (let i = 0; i < DOS_WORDS.length; i++) out.u16(i * 2, DOS_WORDS[i]);
  out.u32(60, NT_SIG_OFF);
  out.bytes(DOS_SIZE, new Uint8Array(STUB));

  /* ---- COFF 文件头。`TimeDateStamp` tcc 有意留 0（那一行是注掉的）。 */
  out.u32(NT_SIG_OFF, NT_SIGNATURE);
  out.u16(FILEHDR_OFF, img.machine);
  out.u16(FILEHDR_OFF + 2, nsec);
  if (img.symtab !== undefined) {
    out.u32(FILEHDR_OFF + 8, at);                 // PointerToSymbolTable
    out.u32(FILEHDR_OFF + 12, img.symtab.count);  // NumberOfSymbols
  }
  out.u16(FILEHDR_OFF + 16, OPTHDR_SIZE);
  out.u16(FILEHDR_OFF + 18, img.chars);

  /* ---- 可选头。 */
  const o = OPTHDR_OFF;
  out.u16(o, PE_MAGIC64);
  out.b[o + 2] = 6;                      // MajorLinkerVersion
  out.b[o + 3] = 0;                      // MinorLinkerVersion
  out.u32(o + 4, sizeOfCode);
  out.u32(o + 8, sizeOfData);
  out.u32(o + 12, 0);                    // SizeOfUninitializedData：tcc 不填
  out.u32(o + 16, img.entry);
  out.u32(o + 20, baseOfCode);
  out.u64(o + 24, img.imagebase);
  out.u32(o + 32, HDR_SECTION_ALIGN);
  out.u32(o + 36, HDR_FILE_ALIGN);
  out.u16(o + 40, cpu.osVer >> 8);       // MajorOperatingSystemVersion
  out.u16(o + 42, cpu.osVer & 255);
  out.u16(o + 44, 0);                    // MajorImageVersion
  out.u16(o + 46, 0);
  out.u16(o + 48, cpu.osVer >> 8);       // MajorSubsystemVersion
  out.u16(o + 50, cpu.osVer & 255);
  out.u32(o + 52, 0);                    // Win32VersionValue
  out.u32(o + 56, sizeOfImage);
  out.u32(o + 60, headers);
  out.u32(o + 64, 0);                    // CheckSum
  out.u16(o + 68, img.subsystem);
  out.u16(o + 70, img.dllChars);
  out.u64(o + 72, img.stack);            // SizeOfStackReserve
  out.u64(o + 80, 0x1000);               // SizeOfStackCommit
  out.u64(o + 88, 0x100000);             // SizeOfHeapReserve
  out.u64(o + 96, 0x1000);               // SizeOfHeapCommit
  out.u32(o + 104, 0);                   // LoaderFlags
  out.u32(o + 108, NDIRS);
  for (let i = 0; i < NDIRS; i++) {
    out.u32(o + 112 + i * 8, img.dirs[i].addr);
    out.u32(o + 116 + i * 8, img.dirs[i].size);
  }

  /* ---- 节头表，再把每节的字节摆进去。 */
  for (let i = 0; i < nsec; i++) {
    const s = img.secs[i];
    const p = place[i];
    const h = HDR_SIZE + i * SECHDR_SIZE;
    if (typeof s.name === 'string') out.name8(h, s.name);
    else out.bytes(h, s.name);                    // `-g` 时换成 `/<偏移>` 的那 8 字节
    out.u32(h + 8, s.vsize);
    out.u32(h + 12, s.vaddr);
    out.u32(h + 16, p.size);
    out.u32(h + 20, p.ptr);
    out.u32(h + 36, s.chars);
    if (p.size !== 0) out.bytes(p.ptr, s.bytes);
  }
  /* `-g` 时那张 COFF 符号表与字符串表接在最后一节补齐之后，不再补齐 —— 于是整份
   * 文件的长度不是 `FileAlignment` 的整数倍。校验和里那个「加上文件长度」自然
   * 也就把它们算进去了。 */
  if (img.tail !== undefined) out.bytes(at, img.tail);
  out.u32(o + 64, checksum(out.b));
  return out.b;
}

/**
 * PE 的头部校验和（`pe_fwrite` 里那个 `pe->sum`，最后 `pe->sum += file_offset`）。
 *
 * 十六位小端的字一个个加，每加一次就把高半边折回来。tcc 是**边写边加**的，只加
 * 真写出去的那些字节，补齐的 0 不进账 —— 但补的是 0，加进去也一样，连「奇数长度的
 * 最后一个字节单独加」那一格也一样（小端下 `(字节, 0)` 这个字就等于那个字节），
 * 所以这儿直接对整个文件算。算的时候校验和那一格本身是 0（tcc 是写完再回填的）。
 */
function checksum(bytes) {
  let sum = 0;
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    sum += bytes[i] + bytes[i + 1] * 256;
    sum = (sum + (sum >>> 16)) & 0xffff;
  }
  if (bytes.length % 2 !== 0) {
    sum += bytes[bytes.length - 1];
    sum = (sum + (sum >>> 16)) & 0xffff;
  }
  return sum + bytes.length;
}

/* ------------------------------------------------------------------ 导入表
 * `pe_build_imports`（第九刀第四十四片）。它整段接在 thunk 那一节（`.rdata`）的
 * 末尾，一格都不能挪：
 *
 *   dll_ptr = 先把 thunk 补齐到 16 之后的长度
 *   imp_size = (dll 数 + 1) * 20        // 描述符，末尾一条全 0
 *   iat_size = (符号数 + dll 数) * 8    // 每个 dll 的那一串末尾一条 0
 *   thk_ptr = dll_ptr + imp_size        // FirstThunk 那一份（运行时被改写成真地址）
 *   ent_ptr = thk_ptr + iat_size        // OriginalFirstThunk 那一份（原样留着）
 *   再往后：dll 名字、每个符号的「提示字 + 名字」，按 dll、符号的次序一条条接
 *
 * 两份 thunk 数组里填的是同一个值：按名字导入就是「提示字 + 名字」那一处的 RVA，
 * 按序号导入就是 `序号 | 最高位`。
 */

const IMP_DESC_SIZE = 20;
const THUNK_SIZE = 8;
/** 按序号导入的标志位：`(ADDR3264)1 << 63`。 */
const ORDINAL_FLAG = 2n ** 63n;

/**
 * 把一份映像里的导入表读成「哪个 dll、按什么次序导入哪些符号」。
 *
 * @param img `readImage` 的结果
 * @returns `null`（没有导入表）或 `{sec, at, rva, dlls}`：`sec` 是导入表所在节的下标，
 *          `at` 是它在那一节里的起点（`dll_ptr`），`rva` 是那一节的 RVA
 */
export function readImports(img) {
  const dir = img.dirs[1];
  if (dir.size === 0) return null;
  const si = img.secs.findIndex((s) => dir.addr >= s.vaddr && dir.addr < s.vaddr + s.vsize);
  if (si < 0) throw new OmniError('pe: 导入表不在任何一节里');
  const sec = img.secs[si];
  const dv = new DataView(sec.bytes.buffer, sec.bytes.byteOffset, sec.bytes.byteLength);
  /** RVA -> 这一节字节里的下标。 */
  const off = (rva) => rva - sec.vaddr;
  const strAt = (rva) => {
    let e = off(rva);
    while (sec.bytes[e] !== 0) e++;
    let s = '';
    for (let p = off(rva); p < e; p++) s += String.fromCharCode(sec.bytes[p]);
    return s;
  };

  const at = off(dir.addr);
  const dlls = [];
  for (let i = 0; i * IMP_DESC_SIZE + IMP_DESC_SIZE <= dir.size; i++) {
    const p = at + i * IMP_DESC_SIZE;
    const ent = dv.getUint32(p, true);
    const name = dv.getUint32(p + 12, true);
    if (ent === 0 && name === 0) break;                 // 末尾那条全 0
    const syms = [];
    for (let k = 0; ; k++) {
      const v = dv.getBigUint64(off(ent) + k * THUNK_SIZE, true);
      if (v === 0n) break;
      if ((v & ORDINAL_FLAG) !== 0n) syms.push({ ordinal: Number(v & 0xffffffffn) });
      else syms.push({ name: strAt(Number(v) + 2) });    // 前面两个字节是提示字
    }
    dlls.push({ name: strAt(name), syms });
  }
  return { sec: si, at, rva: sec.vaddr, dlls };
}

/**
 * 把导入表写出来。回的是**从 `at` 起**的那一段字节 —— 它整段就是 thunk 那一节的尾巴。
 *
 * @param imp `readImports` 那个形状
 * @returns 从 `at` 到那一节末尾的字节
 */
export function buildImports(imp) {
  const ndlls = imp.dlls.length;
  let nsyms = 0;
  for (const d of imp.dlls) nsyms += d.syms.length;
  const impSize = (ndlls + 1) * IMP_DESC_SIZE;
  const iatSize = (nsyms + ndlls) * THUNK_SIZE;

  /* 先摆下描述符与两份 thunk 数组，名字接在它们后面（`section_ptr_add` 那一句）。 */
  const head = new Uint8Array(impSize + 2 * iatSize);
  const hv = new DataView(head.buffer);
  const tail = [];
  /** 名字区里下一个位置的 RVA。 */
  const nextRva = () => imp.rva + imp.at + head.length + tail.length;
  const put = (s) => {
    const rva = nextRva();
    for (let i = 0; i < s.length; i++) tail.push(s.charCodeAt(i));
    tail.push(0);
    return rva;
  };

  let dllPtr = 0;
  let thkPtr = impSize;
  let entPtr = impSize + iatSize;
  for (const d of imp.dlls) {
    /* dll 的名字先进去 —— tcc 是先 `put_elf_str` 再填描述符的。 */
    const nameRva = put(d.name);
    hv.setUint32(dllPtr, entPtr + imp.rva + imp.at, true);      // OriginalFirstThunk
    hv.setUint32(dllPtr + 12, nameRva, true);                   // Name
    hv.setUint32(dllPtr + 16, thkPtr + imp.rva + imp.at, true); // FirstThunk
    for (let k = 0; k <= d.syms.length; k++) {
      let v = 0n;
      if (k < d.syms.length) {
        const s = d.syms[k];
        /* 序号是**非零**才走序号那条路（tcc 那一句就是 `if (ordinal)`）——
         * `.def` 里没写 `@N` 的符号序号是 0，那要按名字导入。 */
        if (s.ordinal) {
          v = BigInt(s.ordinal) | ORDINAL_FLAG;
        } else {
          v = BigInt(nextRva());
          tail.push(0, 0);                                      // 提示字，没人用
          put(s.name);
        }
      }
      hv.setBigUint64(thkPtr, v, true);
      hv.setBigUint64(entPtr, v, true);
      thkPtr += THUNK_SIZE;
      entPtr += THUNK_SIZE;
    }
    dllPtr += IMP_DESC_SIZE;
  }

  const out = new Uint8Array(head.length + tail.length);
  out.set(head, 0);
  out.set(new Uint8Array(tail), head.length);
  return out;
}

/* ------------------------------------------------------- 异常展开表（第四十五片）
 * `pe_add_unwind_data` / `pe_add_unwind_info`。Windows 上 x86_64 与 arm64 都要它 ——
 * 每个函数在 `.pdata` 里有一条记录，说「这一段代码的栈帧长什么样」。两个目标的形状
 * 不一样：
 *
 *  - x86_64：`.pdata` 一条 12 字节（起、止、展开信息的 RVA）。展开信息（`UNWIND_INFO`，
 *    8 字节）**只有一份**、住在 `.text` 里 —— tcc 的函数帧长得都一样，一条够用。
 *  - arm64：`.pdata` 一条 8 字节（起、`.xdata` 里那一条的 RVA），每个函数在 `.xdata`
 *    里有自己的 8 字节：一个头 + 四个展开码（`set_fp` / `save_fplr_x` / `end` / 一个
 *    补位的 `nop`）。头里装着函数长度（按 4 字节数）、一个 epilog、展开码的字数。
 */

/** x86_64 那一份共用的 `UNWIND_INFO`：版本 1、prolog 4 字节、两条展开码、帧寄存器 rbp。 */
const UW_INFO_X64 = [0x01, 0x04, 0x02, 0x05, 0x04, 0x03, 0x01, 0x50];
/** arm64 每个函数的展开码：`mov x29,sp` / `stp x29,lr,[sp,#-224]!` / 结束 / 补位。 */
const UW_CODES_ARM64 = [0xe1, 0x9b, 0xe4, 0xe3];

/**
 * 读一份映像的异常展开表。
 *
 * @param img `readImage` 的结果
 * @returns `null`（没有）或 `{machine, psec, pat, xsec, xat, xbase, uwRva, funcs}`：
 *          `psec`/`pat` 是 `.pdata` 在哪一节的哪个偏移，`xsec`/`xat`/`xbase` 是 arm64 的
 *          `.xdata`，`uwRva` 是 x86_64 那一份共用展开信息的 RVA
 */
export function readUnwind(img) {
  const dir = img.dirs[3];
  if (dir.size === 0) return null;
  const find = (rva) => img.secs.findIndex((s) => rva >= s.vaddr && rva < s.vaddr + s.vsize);
  const psec = find(dir.addr);
  if (psec < 0) throw new OmniError('pe: .pdata 不在任何一节里');
  const sec = img.secs[psec];
  const pat = dir.addr - sec.vaddr;
  const dv = new DataView(sec.bytes.buffer, sec.bytes.byteOffset, sec.bytes.byteLength);
  const arm64 = img.machine === 0xaa64;
  const stride = arm64 ? 8 : 12;
  if (dir.size % stride !== 0) throw new OmniError(`pe: .pdata 的长度 ${dir.size} 不是 ${stride} 的倍数`);

  const funcs = [];
  for (let i = 0; i * stride < dir.size; i++) {
    const p = pat + i * stride;
    if (arm64) funcs.push({ begin: dv.getUint32(p, true), data: dv.getUint32(p + 4, true) });
    else {
      funcs.push({
        begin: dv.getUint32(p, true),
        end: dv.getUint32(p + 4, true),
        data: dv.getUint32(p + 8, true),
      });
    }
  }
  if (funcs.length === 0) return null;

  if (!arm64) {
    /* x86_64：展开信息**一个目标文件一份** —— `s1->uw_offs` 是编译那一趟的状态，
     * 每个 `.o` 都在自己的 `.text` 里放一份，链完就有好几份（都是同样的 8 字节）。 */
    const uwRvas = [];
    for (const f of funcs) if (!uwRvas.includes(f.data)) uwRvas.push(f.data);
    return { machine: img.machine, psec, pat, uwRvas, funcs };
  }

  /* arm64：每个函数在 `.xdata` 里有自己的一条，函数长度从那个头里取。 */
  const xsec = find(funcs[0].data);
  if (xsec < 0) throw new OmniError('pe: .xdata 不在任何一节里');
  const xs = img.secs[xsec];
  const xdv = new DataView(xs.bytes.buffer, xs.bytes.byteOffset, xs.bytes.byteLength);
  const xbase = funcs[0].data;
  for (const f of funcs) f.funcLen = xdv.getUint32(f.data - xs.vaddr, true) & 0x3ffff;
  return { machine: img.machine, psec, pat, xsec, xat: xbase - xs.vaddr, xbase, funcs };
}

/**
 * 把异常展开表写出来。
 *
 * @param u `readUnwind` 那个形状
 * @returns `{pdata, xdata}`：`xdata` 只有 arm64 有（x86_64 上那一份展开信息在 `.text` 里，
 *          是 `UW_INFO_X64` 那 8 字节）
 */
export function buildUnwind(u) {
  const arm64 = u.machine === 0xaa64;
  const stride = arm64 ? 8 : 12;
  const pdata = new Uint8Array(u.funcs.length * stride);
  const pv = new DataView(pdata.buffer);
  const xdata = arm64 ? new Uint8Array(u.funcs.length * 8) : new Uint8Array(0);
  const xv = new DataView(xdata.buffer);

  for (let i = 0; i < u.funcs.length; i++) {
    const f = u.funcs[i];
    const p = i * stride;
    if (!arm64) {
      pv.setUint32(p, f.begin, true);
      pv.setUint32(p + 4, f.end, true);
      pv.setUint32(p + 8, f.data, true);
      continue;
    }
    /* 每条 `.xdata` 是 4 + code_bytes 字节，code_bytes = (0 + 3 + 3) & ~3 = 4，
     * 所以一条正好 8 字节、天生 4 对齐 —— 于是第 i 个函数的那一条就在 xbase + 8i。 */
    const at = i * 8;
    pv.setUint32(p, f.begin, true);
    pv.setUint32(p + 4, u.xbase + at, true);
    /* 头：函数长度（18 位）| E=1（一个 epilog）| epilog 起点 0 | 展开码的字数。 */
    const header = (f.funcLen & 0x3ffff) | (1 << 21) | (0 << 22) | (1 << 27);
    xv.setUint32(at, header >>> 0, true);
    xdata.set(new Uint8Array(UW_CODES_ARM64), at + 4);
  }
  return { pdata, xdata };
}

/** x86_64 上那一份共用的展开信息（住在 `.text` 里，8 字节）。 */
export function unwindInfoX64() {
  return new Uint8Array(UW_INFO_X64);
}


