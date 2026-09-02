/* Mach-O 目标文件的写出 —— ADR-0017 第 11 步，第九刀第八片；第十五片起两种架构都写。
 *
 * 只写 **MH_OBJECT**（`.o`），arm64 与 x86_64。写出来的东西要能被系统链接器
 * （`ld`/`clang`）吃下去 —— 验法就是「clang 把我们的 .o 与一个 C 的 main 链起来，
 * 跑，对结果」。x86_64 那条腿在 Apple Silicon 上靠 `clang -arch x86_64` 加 Rosetta 跑。
 *
 * 两种架构只差三格（cpu 类型、子类型、重定位的类型号），段/节/符号表/字符串表的形状
 * 与次序完全一样 —— 所以这个文件没有按架构分叉，只多一张 `ARCH` 表。
 *
 * 为什么先写 .o 而不是直接写可执行文件
 * ------------------------------------
 * 一个可执行文件要自己解决 dyld 的那一整摊（`LC_LOAD_DYLINKER`、`LC_MAIN`、
 * `LC_LOAD_DYLIB`、绑定信息、代码签名 —— macOS 上 arm64 的可执行文件**必须**签名），
 * 而这些与「我们编出来的指令对不对」无关。目标文件只要说清三件事：字节、符号、
 * 哪几个字节要等符号定下来再填。tcc 也是先有 `.o` 再有链接器（`tccelf.c` 在
 * `tccrun.c` 之前）。
 *
 * 结构照 `<mach-o/loader.h>` 与 `<mach-o/nlist.h>`、`<mach-o/reloc.h>`。
 * 全部小端。**不抄任何代码**，只照字段布局（ADR-0017 的规矩）。
 *
 * 布局（一段一节，__TEXT,__text）：
 *
 *   mach_header_64            32
 *   LC_SEGMENT_64             72 + 80（一节）
 *   LC_BUILD_VERSION          24
 *   LC_SYMTAB                 24
 *   LC_DYSYMTAB               80
 *   ---- 以上是头，共 312 字节
 *   代码字节
 *   重定位表（每条 8 字节）
 *   符号表（每条 16 字节）
 *   字符串表
 */

import { OmniError } from '../source/diag.js';
import { RELOC } from '../arm64/asm.js';

/* ---------------------------------------------------------------- 常量
 * 名字与值都照 <mach-o/loader.h>。 */
const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_SUBTYPE_ARM64_ALL = 0;
const CPU_TYPE_X86_64 = 0x01000007;
/** x86_64 的子类型是 `CPU_SUBTYPE_X86_ALL = 3`，不是 0 —— 填 0 的话 `ld` 说架构不认识。 */
const CPU_SUBTYPE_X86_64_ALL = 3;
const MH_OBJECT = 1;
/** 「每个符号自成一个子段」—— 汇编器一律打这一位，链接器靠它做死代码剔除。 */
const MH_SUBSECTIONS_VIA_SYMBOLS = 0x2000;

const LC_SEGMENT_64 = 0x19;
const LC_SYMTAB = 0x02;
const LC_DYSYMTAB = 0x0b;
const LC_BUILD_VERSION = 0x32;

const VM_PROT_ALL = 7;   // 读写执行。目标文件里这一格不真生效，汇编器也填 7。

/** 节的属性：纯指令 + 里头有指令。链接器按它决定能不能做代码相关的优化。 */
const S_ATTR_PURE_INSTRUCTIONS = 0x80000000;
const S_ATTR_SOME_INSTRUCTIONS = 0x00000400;

const PLATFORM_MACOS = 1;

/* <mach-o/reloc.h> 的 arm64 那一族。 */
const ARM64_RELOC_BRANCH26 = 2;
const ARM64_RELOC_PAGE21 = 3;
const ARM64_RELOC_PAGEOFF12 = 4;

/* <mach-o/reloc.h> 的 x86_64 那一族。`SIGNED` 是「RIP 相对、带符号的四字节」，
 * `BRANCH` 是 `call`/`jmp` 的那一格 —— 两者的 pcrel 都是 1。 */
const X86_64_RELOC_UNSIGNED = 0;
const X86_64_RELOC_SIGNED = 1;
const X86_64_RELOC_BRANCH = 2;

/* <mach-o/nlist.h>：n_type 的位。 */
const N_EXT = 0x01;
const N_SECT = 0x0e;
const N_UNDF = 0x00;

/* ---------------------------------------------------------------- 写字节
 * 定长记录一格一格填。用 DataView 而不是自己拼字节：字段宽度混着 4/8 字节，
 * 手拼一次就会错一格，而错一格的目标文件链接器只会说「malformed object」。 */
class Buf {
  constructor() {
    this.parts = [];
    this.len = 0;
  }

  u8(v) { return this.push(1, (dv) => dv.setUint8(0, v)); }
  u16(v) { return this.push(2, (dv) => dv.setUint16(0, v, true)); }
  u32(v) { return this.push(4, (dv) => dv.setUint32(0, v >>> 0, true)); }
  u64(v) { return this.push(8, (dv) => dv.setBigUint64(0, BigInt(v), true)); }
  i32(v) { return this.push(4, (dv) => dv.setInt32(0, v, true)); }

  push(n, fill) {
    const b = new Uint8Array(n);
    fill(new DataView(b.buffer));
    this.parts.push(b);
    this.len += n;
    return this;
  }

  bytes(b) {
    this.parts.push(b);
    this.len += b.length;
    return this;
  }

  /** 定长的名字格（`segname`/`sectname` 都是 16 字节、不足补 0）。 */
  name16(s) {
    const b = new Uint8Array(16);
    for (let i = 0; i < s.length; i++) {
      if (i >= 16) throw new OmniError(`macho: 名字 '${s}' 超过 16 字节`);
      b[i] = s.charCodeAt(i);
    }
    return this.bytes(b);
  }

  pad(to) {
    while (this.len % to !== 0) this.u8(0);
    return this;
  }

  out() {
    const all = new Uint8Array(this.len);
    let at = 0;
    for (const p of this.parts) {
      all.set(p, at);
      at += p.length;
    }
    return all;
  }
}

/** Mach-O 的符号名带一条下划线前缀（C 的 `printf` 在文件里是 `_printf`）。 */
function macName(name) {
  return `_${name}`;
}

/** 字符串表：0 号是空串，所以从一个 0 字节起头。 */
class StrTab {
  constructor() {
    this.parts = [new Uint8Array(1)];
    this.at = 1;
    this.index = new Map();
  }

  intern(s) {
    const hit = this.index.get(s);
    if (hit !== undefined) return hit;
    const off = this.at;
    const b = new Uint8Array(s.length + 1);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    this.parts.push(b);
    this.at += b.length;
    this.index.set(s, off);
    return off;
  }

  bytes() {
    const all = new Uint8Array(this.at);
    let p = 0;
    for (const x of this.parts) {
      all.set(x, p);
      p += x.length;
    }
    return all;
  }
}

const RELOC_TYPE = {};
RELOC_TYPE[RELOC.BRANCH26] = { type: ARM64_RELOC_BRANCH26, pcrel: 1, len: 2 };
RELOC_TYPE[RELOC.PAGE21] = { type: ARM64_RELOC_PAGE21, pcrel: 1, len: 2 };
RELOC_TYPE[RELOC.PAGEOFF12] = { type: ARM64_RELOC_PAGEOFF12, pcrel: 0, len: 2 };
RELOC_TYPE.X86_64_RELOC_BRANCH = { type: X86_64_RELOC_BRANCH, pcrel: 1, len: 2 };
RELOC_TYPE.X86_64_RELOC_SIGNED = { type: X86_64_RELOC_SIGNED, pcrel: 1, len: 2 };
RELOC_TYPE.X86_64_RELOC_UNSIGNED = { type: X86_64_RELOC_UNSIGNED, pcrel: 0, len: 2 };
/* 数据段里的一个八字节指针（第九刀第二十八片）。两种架构的类型号**都是 0**
 * （`ARM64_RELOC_UNSIGNED` 与 `X86_64_RELOC_UNSIGNED`），语义也一样：
 * 链接器把「原地那八个字节」当加数，加上符号的地址写回去。
 * 所以这一格不分架构，一个名字就够。 */
RELOC_TYPE.POINTER64 = { type: 0, pcrel: 0, len: 3 };

/**
 * 两种架构的头部字段。**除了这三格，两者的目标文件布局一模一样** ——
 * 段、节、符号表、字符串表、重定位表的形状与次序都不分架构，所以这个文件没有分叉，
 * 只是多一张表。（重定位的**类型号**分架构，但它们的名字不同，所以一张 `RELOC_TYPE`
 * 就够；把 arm64 的重定位混进 x86_64 的文件里会在 `kinds` 那一格挡下来。）
 */
const ARCH = {
  arm64: {
    cpu: CPU_TYPE_ARM64,
    sub: CPU_SUBTYPE_ARM64_ALL,
    kinds: [RELOC.BRANCH26, RELOC.PAGE21, RELOC.PAGEOFF12, 'POINTER64'],
  },
  x86_64: {
    cpu: CPU_TYPE_X86_64,
    sub: CPU_SUBTYPE_X86_64_ALL,
    kinds: ['X86_64_RELOC_BRANCH', 'X86_64_RELOC_SIGNED', 'X86_64_RELOC_UNSIGNED', 'POINTER64'],
  },
};

/**
 * 写一个 arm64 的 `.o`。
 *
 * @param text  代码字节（`Uint8Array`）
 * @param data  数据字节（`Uint8Array`，可以是空的 —— 那就不写第二节）
 * @param defs  这个文件**定义**的符号：`[{name, off, sect}]`，`sect` 1 是代码、2 是数据，
 *              `off` 是在那一节里的字节偏移
 * @param relocs 要等链接器填的地方：`[{at, kind, sym, sect}]`，`kind` 是 `RELOC.*`
 *               或 `'POINTER64'`，`sym` 是符号名（不带下划线，这儿加）。
 *               `at` 是**自己那一节里**的偏移，`sect` 1 是代码（默认）、2 是数据。
 * @param arch  `'arm64'`（默认）或 `'x86_64'`
 */
export function writeObject(text, data, defs, relocs, arch) {
  const archName = arch === undefined ? 'arm64' : arch;
  const cpu = ARCH[archName];
  if (cpu === undefined) throw new OmniError(`macho: 还不认识架构 ${archName}`);
  const dataBytes = data === undefined ? new Uint8Array(0) : data;
  const nsects = dataBytes.length === 0 ? 1 : 2;
  /* 节的地址在段里是**接着排**的：代码从 0 起，数据紧跟着（按 8 对齐）。
   * 这个数要先算出来 —— 符号的 `n_value` 是**段里的地址**，不是节里的偏移。
   * 少加这一格的话链接器会说
   * 「_x symbol is ignored, because its address isn't in its designated section」。 */
  const dataAddr = align(text.length, 8);
  const strs = new StrTab();
  /* 符号表的次序是**有讲究**的：局部、定义的外部、未定义的外部，三段各自连着 ——
   * LC_DYSYMTAB 里报的就是这三段的起点与长度。乱了链接器会说符号表坏了。 */
  const syms = [];
  const defNo = new Map();
  for (const d of defs) {
    const sect = d.sect === undefined ? 1 : d.sect;
    defNo.set(d.name, syms.length);
    syms.push({
      strx: strs.intern(macName(d.name)),
      type: N_SECT | N_EXT,
      sect,
      value: d.off + (sect === 2 ? dataAddr : 0),
    });
  }
  const nextdef = defs.length;
  /* 未定义的那些按名字去重：同一个 `printf` 被叫十次也只占一条符号。
   * 已经定义过的名字**不许**再进未定义那一段 —— 自家的全局也是靠符号寻址的。 */
  const undefNo = new Map();
  for (const r of relocs) {
    if (defNo.has(r.sym) || undefNo.has(r.sym)) continue;
    undefNo.set(r.sym, syms.length);
    syms.push({ strx: strs.intern(macName(r.sym)), type: N_UNDF | N_EXT, sect: 0, value: 0 });
  }
  const nundef = syms.length - nextdef;
  const symIndexOf = (name) => {
    const hit = defNo.has(name) ? defNo.get(name) : undefNo.get(name);
    if (hit === undefined) throw new OmniError(`macho: 重定位指着一个没登记的符号 ${name}`);
    return hit;
  };

  const HEAD = 32 + (72 + 80 * nsects) + 24 + 24 + 80;
  const textOff = HEAD;
  /* 数据节在文件里紧跟着代码（地址上的位置是上面那个 `dataAddr`）。 */
  const dataOff = textOff + dataAddr;
  const relOff = dataOff + dataBytes.length;
  /* 重定位按地址升序 —— 汇编器出来的就是这个次序，链接器也认它。
   * **一节一张表**：节头里的 `reloff`/`nreloc` 是那一节自己的，而 `r_address` 是
   * 节里的偏移。混成一张（代码的 0x10 与数据的 0x10 撞在一起）链接器会往代码里填数据的坑。 */
  const byAt = (x, y) => x.at - y.at;
  const rsText = relocs.filter((r) => (r.sect === undefined ? 1 : r.sect) === 1).sort(byAt);
  const rsData = relocs.filter((r) => r.sect === 2).sort(byAt);
  if (rsData.length !== 0 && nsects !== 2) {
    throw new OmniError('macho: 有数据节的重定位，可是数据节是空的');
  }
  const dataRelOff = relOff + rsText.length * 8;
  const symOff = relOff + (rsText.length + rsData.length) * 8;
  const strOff = symOff + syms.length * 16;
  const strBytes = strs.bytes();

  const b = new Buf();
  // ---- mach_header_64
  b.u32(MH_MAGIC_64).u32(cpu.cpu).u32(cpu.sub).u32(MH_OBJECT);
  b.u32(4).u32(HEAD - 32).u32(MH_SUBSECTIONS_VIA_SYMBOLS).u32(0);

  // ---- LC_SEGMENT_64（目标文件里段名是空的，节自己带段名）
  b.u32(LC_SEGMENT_64).u32(72 + 80 * nsects).name16('');
  b.u64(0).u64(dataAddr + dataBytes.length).u64(textOff).u64(dataAddr + dataBytes.length);
  b.u32(VM_PROT_ALL).u32(VM_PROT_ALL).u32(nsects).u32(0);
  // ---- section_64：__TEXT,__text
  b.name16('__text').name16('__TEXT');
  b.u64(0).u64(text.length).u32(textOff).u32(2);   // align = 2^2 = 4，指令的对齐
  b.u32(rsText.length === 0 ? 0 : relOff).u32(rsText.length);
  b.u32(S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS).u32(0).u32(0).u32(0);
  // ---- section_64：__DATA,__data（没有数据就整节不写）
  if (nsects === 2) {
    b.name16('__data').name16('__DATA');
    b.u64(dataAddr).u64(dataBytes.length).u32(dataOff).u32(3);   // align = 8
    b.u32(rsData.length === 0 ? 0 : dataRelOff).u32(rsData.length);
    b.u32(0).u32(0).u32(0).u32(0);
  }

  // ---- LC_BUILD_VERSION。不写的话链接器会嘟囔一句「没有平台信息」。
  b.u32(LC_BUILD_VERSION).u32(24).u32(PLATFORM_MACOS);
  b.u32(11 * 65536).u32(11 * 65536).u32(0);        // minos / sdk = 11.0.0，ntools = 0

  // ---- LC_SYMTAB
  b.u32(LC_SYMTAB).u32(24).u32(symOff).u32(syms.length).u32(strOff).u32(strBytes.length);

  // ---- LC_DYSYMTAB：三段的起点与长度，其余的表一律空
  b.u32(LC_DYSYMTAB).u32(80);
  b.u32(0).u32(0);                 // ilocalsym / nlocalsym
  b.u32(0).u32(nextdef);           // iextdefsym / nextdefsym
  b.u32(nextdef).u32(nundef);      // iundefsym / nundefsym
  b.u32(0).u32(0).u32(0).u32(0).u32(0).u32(0).u32(0).u32(0);
  b.u32(0).u32(0).u32(0).u32(0);

  if (b.len !== HEAD) throw new OmniError(`macho: 头算成了 ${b.len}，说好是 ${HEAD}`);

  // ---- 代码（补到数据节的起点）
  b.bytes(text);
  while (b.len < dataOff) b.u8(0);
  b.bytes(dataBytes);

  // ---- 重定位。第二个字是位域：
  //      低 24 位符号号、24 位 pcrel、25-26 长度、27 extern、28-31 类型。
  for (const r of [...rsText, ...rsData]) {
    const kind = RELOC_TYPE[r.kind];
    if (kind === undefined) throw new OmniError(`macho: 还不认识重定位 ${r.kind}`);
    if (!cpu.kinds.includes(r.kind)) {
      throw new OmniError(`macho: 重定位 ${r.kind} 不是 ${archName} 的`);
    }
    b.u32(r.at);
    /* 位拼装用乘法，不用 `<<` —— `1 << 31` 在 JS 里是负数（arm64 编码器那边同一条）。 */
    b.u32(symIndexOf(r.sym) + kind.pcrel * 2 ** 24 + kind.len * 2 ** 25 + 1 * 2 ** 27
      + kind.type * 2 ** 28);
  }

  // ---- 符号表（nlist_64）
  for (const s of syms) {
    b.u32(s.strx).u8(s.type).u8(s.sect).u16(0).u64(s.value);
  }

  // ---- 字符串表
  b.bytes(strBytes);
  return b.out();
}

function align(n, to) {
  return n % to === 0 ? n : n + (to - (n % to));
}
