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

const SECTION_ALIGN = 0x1000;
const FILE_ALIGN = 0x200;

/** 每个目标的三格常量（`tccpe.c` 开头那一串 `#if`）。 */
const MACHINES = new Map([
  [0x8664, { name: 'x86_64', osVer: 0x0400, dllChars: 0 }],
  [0xaa64, { name: 'arm64', osVer: 0x0602, dllChars: 0x8160 }],
  [0x014c, { name: 'i386', osVer: 0x0400, dllChars: 0 }],
  [0x01c0, { name: 'arm', osVer: 0x0400, dllChars: 0 }],
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

  /** 定长的 8 字节节名，不足补 0；超过 8 字节的长名字要 COFF 字符串表，这儿不做。 */
  name8(at, s) {
    if (s.length > 8) throw new OmniError(`pe: 节名 '${s}' 超过 8 字节（长名字要 COFF 字符串表）`);
    for (let i = 0; i < s.length; i++) this.b[at + i] = s.charCodeAt(i);
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
  const headers = align(HDR_SIZE + nsec * SECHDR_SIZE, FILE_ALIGN);

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
    sizeOfImage = Math.max(sizeOfImage, align(s.vaddr + s.vsize, SECTION_ALIGN));
    if (s.bytes.length === 0) {
      place.push({ ptr: 0, size: 0 });
      continue;
    }
    const ptr = at;
    at = align(at + s.bytes.length, FILE_ALIGN);
    const size = at - ptr;
    place.push({ ptr, size });
    if (code) sizeOfCode += size;
    else sizeOfData += size;
  }

  const out = new Image(at);
  /* ---- DOS 头 + stub。 */
  for (let i = 0; i < DOS_WORDS.length; i++) out.u16(i * 2, DOS_WORDS[i]);
  out.u32(60, NT_SIG_OFF);
  out.bytes(DOS_SIZE, new Uint8Array(STUB));

  /* ---- COFF 文件头。`TimeDateStamp` tcc 有意留 0（那一行是注掉的）。 */
  out.u32(NT_SIG_OFF, NT_SIGNATURE);
  out.u16(FILEHDR_OFF, img.machine);
  out.u16(FILEHDR_OFF + 2, nsec);
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
  out.u32(o + 32, SECTION_ALIGN);
  out.u32(o + 36, FILE_ALIGN);
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
  out.u16(o + 70, cpu.dllChars);
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
    out.name8(h, s.name);
    out.u32(h + 8, s.vsize);
    out.u32(h + 12, s.vaddr);
    out.u32(h + 16, p.size);
    out.u32(h + 20, p.ptr);
    out.u32(h + 36, s.chars);
    if (p.size !== 0) out.bytes(p.ptr, s.bytes);
  }
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
