/* ELF 目标文件的写出 —— ADR-0017 第 11 步，第九刀第三十八片。
 *
 * 只写 **ET_REL**（`.o`）。尺子换成了 tcc（第三十七片）之后，这个文件是杠杆最长的
 * 那一块：**tcc 的 `-c` 在所有目标上写的都是 ELF** —— arm64-osx、x86_64-osx、
 * x86_64-linux、arm64-linux、x86_64-win32、arm64-win32 六个目标，`.o` 一律
 * `7f 45 4c 46`。Mach-O（`tccmacho.c`）与 PE（`tccpe.c`）只在**可执行文件**那一步
 * 才出场。所以「目标文件与 tcc 逐字节相同」只有一种格式要复刻，六个目标共用，
 * 差别只在三处：`e_machine`、重定位的类型号、符号名要不要那条下划线前缀。
 *
 * 照 `tccelf.c` 的 `elf_output_obj` / `alloc_sec_names` / `tcc_output_elf`。
 * **不抄代码**，只照字段布局与那两条算式（ADR-0017 的规矩）。
 *
 * 节的次序是**写死**的，因为 tcc 那边它也是写死的 —— 节是 `tccelf_new` 按固定
 * 顺序造出来的，序号就是造出来的次序：
 *
 *   0 （全 0 的那一条）
 *   1 .text        PROGBITS  ALLOC|EXECINSTR
 *   2 .data        PROGBITS  ALLOC|WRITE
 *   3 .data.ro     PROGBITS  ALLOC          （osx/linux 叫这个名字，PE 那边叫 .rdata —— 见 `opts.rdata`）
 *   4 .bss         NOBITS    ALLOC|WRITE
 *   5 .symtab      SYMTAB
 *   6 .strtab      STRTAB
 *   7.. .rela.*    RELA                     （谁先要重定位谁先造）
 *       .pdata     PROGBITS                 （win32 的 x86_64 才有 —— 第一个函数收尾时造）
 *   末 .shstrtab   STRTAB                   （`alloc_sec_names` 里最后造，所以在最后）
 *
 * 文件里的排布是两条算式（`elf_output_obj`）：
 *
 *   file_offset = (64 + 3) & -4 + 节数 * 64        // 节头表紧贴 ELF 头
 *   每一节：file_offset = (file_offset + 15) & -16 // 一律 16 对齐，空节也占一个位置
 *
 * NOBITS 的节（`.bss`）拿到 `sh_offset` 但**不推进**游标。文件末尾**不补齐** ——
 * 最后一节的末尾就是文件的末尾。
 */

import { OmniError } from '../source/diag.js';
import { RELOC_ARM64 } from '../arm64/asm.js';

/* ---------------------------------------------------------------- 常量
 * 名字与值照 `<elf.h>`。 */
const ET_REL = 1;
const EV_CURRENT = 1;
const ELFCLASS32 = 1;
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;

const EM_AARCH64 = 183;
const EM_X86_64 = 62;

const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;
const SHT_NOBITS = 8;

const SHF_WRITE = 0x1;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;

const SHN_UNDEF = 0;
const SHN_ABS = 0xfff1;

const STB_LOCAL = 0;
const STB_GLOBAL = 1;
const STB_WEAK = 2;
const STT_NOTYPE = 0;
const STT_OBJECT = 1;
const STT_FUNC = 2;
/** 「这条符号代表某一节」（第一百一十九片）：`.eh_frame` 的 PC Begin 挂在它上头。 */
const STT_SECTION = 3;
const STT_FILE = 4;

const EHDR_SIZE = 64;
const SHDR_SIZE = 64;
const SYM_SIZE = 24;
const RELA_SIZE = 24;

/* 32 位那一套（i386 / arm）。tcc 那边是 `ElfW()` 与 `SHT_RELX` 两个宏一换 ——
 * 头短 12 字节、节头短 24 字节、符号 16 字节，重定位是 `Elf32_Rel`：**没有加数**那一格，
 * 加数写在被修的那几个字节里。 */
const EHDR32_SIZE = 52;
const SHDR32_SIZE = 40;
const SYM32_SIZE = 16;
const REL32_SIZE = 8;
const SHT_REL = 9;

/* aarch64 的那一族（`<elf.h>` 的 `R_AARCH64_*`）。
 * 值得记一笔：**tcc 在 arm64 上取任何数据的地址都过 GOT**（`ADR_GOT_PAGE` +
 * `LD64_GOT_LO12_NC`），连自己文件里的 static 也一样 —— 我们第三十一片走到的
 * 那条路（外部数据只能过 GOT）在 tcc 那边是**所有**数据的默认路。 */
const R_AARCH64_ABS64 = 257;
const R_AARCH64_ADR_PREL_PG_HI21 = 275;
const R_AARCH64_ADD_ABS_LO12_NC = 277;
const R_AARCH64_CALL26 = 283;
const R_AARCH64_ADR_GOT_PAGE = 311;
const R_AARCH64_LD64_GOT_LO12_NC = 312;

/* x86_64 的那一族。 */
const R_X86_64_64 = 1;
const R_X86_64_PC32 = 2;
const R_X86_64_PLT32 = 4;
const R_X86_64_GOTPCREL = 9;
/** win32 的 `.pdata` 里那三个 DWORD 都靠这一号修（`tccpe.c` 的 `R_XXX_RELATIVE`）。 */
const R_X86_64_RELATIVE = 8;

/**
 * 我们那几种重定位到 ELF 类型号的对照。
 *
 * `pcSub` 是**加数的那一格差**：Mach-O 的 pcrel 是「相对指令末尾」，ELF 的
 * `RELA` 是 `S + A - P`，`P` 指的是**那四个字节自己的地址**。四字节的坑落在指令
 * 末尾，所以同一条指令换成 ELF 要把加数写成 `-4`。arm64 那边坑在整条指令里
 * （21/12 位的位域），`P` 就是指令地址，不用这一格。
 *
 * `inPlace` 说的是原地那几个字节算不算加数。Mach-O 把加数藏在原地（数据段里的
 * 八字节指针就是这么走的），ELF 的 `RELA` 有明写的一格 —— 所以要**搬出来**：
 * 读走原地的字节当加数，原地清零。tcc 写出来的 `.data` 就是清过零的。
 */
const RELOC_TYPE = {};
RELOC_TYPE[RELOC_ARM64.BRANCH26] = { arch: 'arm64', type: R_AARCH64_CALL26, pcSub: 0, inPlace: 0 };
RELOC_TYPE[RELOC_ARM64.PAGE21] = { arch: 'arm64', type: R_AARCH64_ADR_PREL_PG_HI21, pcSub: 0, inPlace: 0 };
RELOC_TYPE[RELOC_ARM64.PAGEOFF12] = { arch: 'arm64', type: R_AARCH64_ADD_ABS_LO12_NC, pcSub: 0, inPlace: 0 };
RELOC_TYPE[RELOC_ARM64.GOT_PAGE21] = { arch: 'arm64', type: R_AARCH64_ADR_GOT_PAGE, pcSub: 0, inPlace: 0 };
RELOC_TYPE[RELOC_ARM64.GOT_PAGEOFF12] = {
  arch: 'arm64', type: R_AARCH64_LD64_GOT_LO12_NC, pcSub: 0, inPlace: 0,
};
RELOC_TYPE.X86_64_RELOC_BRANCH = { arch: 'x86_64', type: R_X86_64_PLT32, pcSub: 4, inPlace: 0 };
RELOC_TYPE.X86_64_RELOC_SIGNED = { arch: 'x86_64', type: R_X86_64_PC32, pcSub: 4, inPlace: 0 };
RELOC_TYPE.X86_64_RELOC_GOT_LOAD = { arch: 'x86_64', type: R_X86_64_GOTPCREL, pcSub: 4, inPlace: 0 };
RELOC_TYPE.X86_64_RELOC_UNSIGNED = { arch: 'x86_64', type: R_X86_64_64, pcSub: 0, inPlace: 8 };
/** 数据里的一个八字节绝对地址。两种架构名字不同、语义一样，加数原地躺着。 */
RELOC_TYPE.POINTER64 = { arch: null, type: null, pcSub: 0, inPlace: 8 };

const ARCH = {
  arm64: { machine: EM_AARCH64, ptr64: R_AARCH64_ABS64 },
  x86_64: { machine: EM_X86_64, ptr64: R_X86_64_64 },
};

/* ---------------------------------------------------------------- 写字节 */
class Buf {
  constructor() {
    this.parts = [];
    this.len = 0;
  }

  u8(v) { return this.push(1, (dv) => dv.setUint8(0, v)); }
  u16(v) { return this.push(2, (dv) => dv.setUint16(0, v, true)); }
  u32(v) { return this.push(4, (dv) => dv.setUint32(0, v >>> 0, true)); }
  u64(v) { return this.push(8, (dv) => dv.setBigUint64(0, BigInt(v), true)); }
  i64(v) { return this.push(8, (dv) => dv.setBigInt64(0, BigInt(v), true)); }

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

  /** 补 0 到某个文件偏移 —— tcc 那边是一个 `fputc(0, f)` 的循环。 */
  padTo(off) {
    while (this.len < off) this.u8(0);
    if (this.len !== off) throw new OmniError(`elf: 已经写过了 ${off}（现在 ${this.len}）`);
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

/** 字符串表：0 号是空串，所以从一个 0 字节起头（`put_elf_str` 那边同一条）。 */
class StrTab {
  constructor() {
    this.parts = [new Uint8Array(1)];
    this.at = 1;
    this.index = new Map();
  }

  intern(s) {
    if (s === '') return 0;
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

function align(n, to) {
  return n % to === 0 ? n : n + (to - (n % to));
}

/* ---------------------------------------------------------------- 符号表
 * ELF 的符号表**必须**局部在前、全局在后，`sh_info` 报的就是局部那一段的长度
 * （`sort_syms` 的注释里写着「TCC 生成的时候排不了，只能事后排」）。我们这儿是
 * 一次攒齐再写，所以直接按段攒：
 *
 *   0        全 0 的那一条
 *   1        源文件名（STT_FILE，`st_shndx = SHN_ABS`）
 *   2..      局部的（static 的量、字符串字面量那种没名字的块）
 *   ..       本文件定义的全局
 *   末       只被引用、没有定义的（STB_GLOBAL + STT_NOTYPE）
 *
 * 最后那一段的类型是 NOTYPE 而不是 FUNC，这是 `tccelf_end_file` 里明写的一条：
 * 「未定义的 STT_FUNC 会让 gnu ld 在静态链接 STT_GNU_IFUNC 时犯糊涂」。
 */
function buildSyms(defs, relocs, strs, prefix, uw, ehn) {
  const syms = [{ strx: 0, info: 0, shndx: SHN_UNDEF, value: 0, size: 0 }];
  const no = new Map();
  const put = (d, bind) => {
    const sect = d.sect === undefined ? 1 : d.sect;
    /* `name` 是**这一条在这份 `.o` 里的身份**（重定位按它找符号），`sym` 是真正写进
     * 字符串表的那个名字（第九刀第一百三十三片）。两者不同的只有一种东西：函数体里的
     * `static` —— tcc 写的是**声明时那个名字**（`n`），而同一份 `.o` 里两个函数各有一个
     * `static int n;` 就是两条都叫 `n` 的局部符号。身份还得唯一，所以分成两格。 */
    no.set(d.name, syms.length);
    syms.push({
      strx: strs.intern(prefix + (d.sym === undefined ? d.name : d.sym)),
      info: bind * 16 + (sect === 1 ? STT_FUNC : STT_OBJECT),
      other: d.vis === undefined ? 0 : d.vis,
      shndx: sect,
      value: d.off,
      size: d.size === undefined ? 0 : d.size,
    });
  };
  for (const d of defs) if (d.local === true) put(d, STB_LOCAL);
  /* `.uw_base`（第一百一十七片）：win32 的 `.pdata` 里那三个字段都是**相对代码节起点**的
   * 偏移，于是要有一条指着 `.text` 起点的符号让重定位挂上去（`tccpe.c:1955`）。
   * 名字上**不加**那条下划线前缀 —— 它不是 C 里的名字，是 tcc 自己造的一条局部符号；
   * 类型也不是 FUNC 而是 NOTYPE（`put_elf_sym(symtab_section, 0, 0, 0, 0, ...)`）。 */
  if (uw !== undefined && uw !== null) {
    no.set('.uw_base', syms.length);
    syms.push({
      strx: strs.intern('.uw_base'),
      info: STB_LOCAL * 16 + STT_NOTYPE,
      shndx: 1,
      value: 0,
      size: 0,
    });
  }
  /* 每个 FDE 一条「节符号」（第一百一十九片）：`.eh_frame` 里那个 PC Begin 挂在
   * 一条**没有名字**的 STT_SECTION 上（`dwarf_get_section_sym`）。tcc 每个函数收尾时
   * 都新叫一次 `put_elf_sym`，那个函数不查重 —— 所以 n 个函数就有 n 条一模一样的。 */
  const ehBase = syms.length;
  for (let k = 0; k < (ehn === undefined ? 0 : ehn); k++) {
    syms.push({
      strx: 0,
      info: STB_LOCAL * 16 + STT_SECTION,
      shndx: 1,
      value: 0,
      size: 0,
    });
  }
  const nlocal = syms.length;
  /* 弱定义（第九刀第一百〇四片）：`__attribute__((weak))` 的名字绑定是 STB_WEAK，
   * 与全局的排在同一段里（`sh_info` 只切「局部/非局部」这一刀）。 */
  for (const d of defs) if (d.local !== true) put(d, d.weak === true ? STB_WEAK : STB_GLOBAL);
  /* 没定义的那些按名字去重，次序按第一次被引用 —— 同一个 `printf` 叫十次只占一条。 */
  for (const r of relocs) {
    if (no.has(r.sym)) continue;
    no.set(r.sym, syms.length);
    syms.push({
      strx: strs.intern(prefix + r.sym),
      info: STB_GLOBAL * 16 + STT_NOTYPE,
      shndx: SHN_UNDEF,
      value: 0,
      size: 0,
    });
  }
  return { syms, no, nlocal, ehBase };
}

/**
 * `.eh_frame` 的字节（第九刀第一百一十九片）—— x86_64 的那一份。
 *
 * ELF 这个输出格式上 tcc 默认带展开表（`unwind_tables`，`libtcc.c:887`；
 * `tccelf.c:92-94` 里非 ELF 的输出格式又把它关掉），于是 linux 目标的 `.o` 里多这一节。
 * 与 win32 的 `.pdata` 是同一件事的两种写法：那边是查表，这边是 DWARF 的 CFI。
 *
 * 结构（`tccdbg.c` 的 `tcc_eh_frame_start` / `tcc_debug_frame_end` / `tcc_eh_frame_end`）：
 *
 *   CIE           24 字节，一份，`z`/`R` 两个增广、FDE 的编码是 `0x1b`（pcrel|sdata4）
 *   FDE * n       每个函数 36 字节 —— 长度都一样，因为每一格都是定长的
 *   0x00000000    收尾那四个零字节
 *
 * 一个 FDE 里只有三个数跟函数走：`PC Begin`（挂重定位）、`PC Range`（函数多大）、
 * 还有 `DW_CFA_advance_loc4` 那一格的 `size - 5`。**那几条 CFA 指令是写死的** ——
 * tcc 编出来的函数序言都是 `push rbp`（1 字节）+ `mov rsp,rbp`（3 字节），所以
 * `advance_loc+1` / `advance_loc+3` 这两步与真的字节数对得上；`size - 5` 也不看
 * 收尾那几条指令到底多长，就是这么算的。
 *
 * @param funcs `[{start, size}]`
 * @returns `{bytes, relocs: [{at}]}` —— `at` 是要挂 PC32 的那四个字节在这一节里的偏移
 */
function ehFrameX64(funcs) {
  const b = new Buf();
  /* CIE：这 24 个字节一个不差地照 `tcc_eh_frame_start` 的 x86_64 那一支。 */
  b.u32(20).u32(0).u8(1);
  b.u8(0x7a).u8(0x52).u8(0);            // 'z' 'R' 0
  b.u8(1).u8(0x78).u8(16).u8(1);        // code_align 1 / data_align -8 / ra 列 16 / 增广长 1
  b.u8(0x1b);                           // FDE 的编码：DW_EH_PE_pcrel | sdata4
  b.u8(0x0c).u8(7).u8(8);               // DW_CFA_def_cfa r7(rsp) ofs 8
  b.u8(0x90).u8(1);                     // DW_CFA_offset+16(rip) cfa-8
  b.u8(0).u8(0);                        // 补到 4 的倍数
  const relocs = [];
  for (const f of funcs) {
    const start = b.len;
    b.u32(32).u32(start + 4);           // 长度 / CIE 指针（= 这条离 CIE 起点多远 + 4）
    relocs.push({ at: b.len });
    b.u32(f.start).u32(f.size).u8(0);   // PC Begin（挂重定位）/ PC Range / 增广长 0
    b.u8(0x41).u8(0x0e).u8(16);         // advance_loc+1；def_cfa_offset 16
    b.u8(0x86).u8(2);                   // DW_CFA_offset+6(rbp) cfa-16
    b.u8(0x43).u8(0x0d).u8(6);          // advance_loc+3；def_cfa_register rbp
    b.u8(0x04).u32(f.size - 5);         // advance_loc4 size-5
    b.u8(0x0c).u8(7).u8(8);             // def_cfa r7(rsp) ofs 8
    b.u8(0).u8(0).u8(0);                // 补到 4 的倍数
    if (b.len - start !== 36) throw new OmniError(`elf: FDE 写成了 ${b.len - start} 字节`);
  }
  b.u32(0);                             // `tcc_eh_frame_end`：一条长度为 0 的记录
  return { bytes: b.out(), relocs };
}

/**
 * 写一个 `ET_REL` 的 ELF 目标文件。
 *
 * 入参与 `macho.js` 的 `writeObject` **一样** —— 同一份前端产物喂两个写出器，
 * 一个给 clang 那条「真的能跑」的腿，一个给 tcc 那条「字节相同」的腿。
 *
 * @param text  代码字节（`Uint8Array`）
 * @param data  数据字节（`Uint8Array`）
 * @param defs  本文件定义的符号：`[{name, off, sect, size?, local?}]`，
 *              `sect` 1 是 `.text`、2 是 `.data`
 * @param relocs `[{at, kind, sym, sect}]`，`at` 是**自己那一节里**的偏移
 * @param arch  `'arm64'` 或 `'x86_64'`
 * @param dataAlign 这一格 ELF 用不上（每一节自己的 `sh_addralign` 走 `opts.secAlign`），
 *              留着是为了与 Mach-O 那个写出器同签名
 * @param opts  `{file, prefix, rdata, rodata, unwind, seq}`：`file` 是写进 STT_FILE 那一条的
 *              源文件名；`prefix` 是符号名前缀 —— **只有 osx 是 `'_'`**，linux 与 win32
 *              都是 `''`（`libtcc.c:895-898`：`leading_underscore` 只在 MACHO 上开）；
 *              `rdata` 是只读数据那一节的名字，`rodata` 是它的字节（第一百二十二片）；
 *              `bssSize` 是 `.bss` 那一节的 `sh_size`（第一百三十二片）—— NOBITS，
 *              有大小、在文件里没有字节；`secAlign` 是 `{data, rodata, bss}` 三节各自的
 *              `sh_addralign`（里头对齐最大的那一块，下界 8）；
 *              `unwind` 是 win32 x86_64 的展开表
 *              `{offs, funcs: [{start, end}]}`（第一百一十七片）；`seq` 是
 *              `{text, data, rodata, pdata}` 几节**造出来的次序**上的位置（第一百一十八片）
 */
export function writeElfObject(text, data, defs, relocs, arch, dataAlign, opts) {
  const archName = arch === undefined ? 'arm64' : arch;
  const cpu = ARCH[archName];
  if (cpu === undefined) throw new OmniError(`elf: 还不认识架构 ${archName}`);
  const o = opts === undefined ? {} : opts;
  const prefix = o.prefix === undefined ? '_' : o.prefix;
  /* 只读数据那一节的名字（第一百一十六片）：PE 目标上 tcc 叫它 `.rdata`，别的目标叫
   * `.data.ro`（`tccelf.c:50-56` 那个 `#ifdef TCC_TARGET_PE`）。这是**目标的事实**，
   * 与符号名那条下划线并列 —— 六个目标共用一个写出器，差别就这么几处。
   * 我们的链接器早就有同一格（`elf_merge.js` 的 `opts.rdata`），写 `.o` 这一头之前欠着。 */
  const rdata = o.rdata === undefined ? '.data.ro' : o.rdata;
  /* 展开表（第一百一十七片）：win32 的 x86_64 上每个函数都要在 `.pdata` 里占
   * 一条 12 字节的 `RUNTIME_FUNCTION`。`opts.unwind` 是 `{offs, funcs}` ——
   * `offs` 是那一份共用的 `UNWIND_INFO` 在 `.text` 里的偏移（后端摆的），
   * `funcs` 是每个函数在 `.text` 里的 `[start, end)`。不给这一格就一节也不多。 */
  const uw = o.unwind === undefined ? null : o.unwind;
  /* 展开表的另一种写法（第一百一十九片）：ELF 这个输出格式上是 `.eh_frame`（DWARF 的
   * CFI），`opts.ehFrame` 是 `[{start, size}]`。win32 那边是 `.pdata`，两者不同时有。 */
  const ehFuncs = o.ehFrame === undefined ? null : o.ehFrame;
  /* 数据字节要能改 —— 原地躺着的加数得搬到 `r_addend` 那一格去，原地清零。 */
  const dataBytes = new Uint8Array(data === undefined ? 0 : data.length);
  if (data !== undefined) dataBytes.set(data);
  /* 只读那一节的字节（第一百二十二片）：`const` 的全局量落在这儿，哪怕初值要重定位
   * （`tccgen.c:8397-8413`：剥掉 `VT_PTR|VT_ARRAY` 之后看 `VT_CONSTANT`）。
   * 与 `.data` 同一个待遇 —— 原地的加数也要搬到 `r_addend` 去，所以这一份也得能改。 */
  const roBytes = new Uint8Array(o.rodata === undefined ? 0 : o.rodata.length);
  if (o.rodata !== undefined) roBytes.set(o.rodata);

  const strs = new StrTab();
  const strx = strs.intern(o.file === undefined ? 'a.c' : o.file);
  const { syms, no, nlocal, ehBase } = buildSyms(defs, relocs, strs, prefix, uw,
    ehFuncs === null ? 0 : ehFuncs.length);
  /* STT_FILE 那一条插在 1 号位上，所以上面攒出来的号要整体 +1。 */
  syms.splice(1, 0, { strx, info: STB_LOCAL * 16 + STT_FILE, shndx: SHN_ABS, value: 0, size: 0 });
  const symIndexOf = (name) => {
    const hit = no.get(name);
    if (hit === undefined) throw new OmniError(`elf: 重定位指着一个没登记的符号 ${name}`);
    return hit + 1;
  };
  const strBytes = strs.bytes();

  /* 重定位按节分张表，表内按偏移升序。加数照 `RELOC_TYPE` 的两格算。 */
  const byAt = (x, y) => x.at - y.at;
  const relaOf = (sect) => {
    const rs = relocs.filter((r) => (r.sect === undefined ? 1 : r.sect) === sect).sort(byAt);
    return rs.map((r) => {
      const k = RELOC_TYPE[r.kind];
      if (k === undefined) throw new OmniError(`elf: 还不认识重定位 ${r.kind}`);
      if (k.arch !== null && k.arch !== archName) {
        throw new OmniError(`elf: 重定位 ${r.kind} 不是 ${archName} 的`);
      }
      const type = k.type === null ? cpu.ptr64 : k.type;
      let add = -k.pcSub;
      if (k.inPlace === 8) {
        /* 原地的加数在哪一段里就从那一段捞（第一百二十二片：只读那一节也会有）。 */
        const host = sect === 2 ? dataBytes : sect === 3 ? roBytes : null;
        if (host === null) throw new OmniError(`elf: ${r.kind} 只能落在数据节里`);
        const dv = new DataView(host.buffer, r.at, 8);
        add = dv.getBigInt64(0, true);
        dv.setBigInt64(0, 0n, true);
      }
      return { at: r.at, sym: symIndexOf(r.sym), type, add };
    });
  };
  const raText = relaOf(1);
  const raData = relaOf(2);
  const raRo = relaOf(3);

  /* `.pdata` 的字节与它那张重定位表。一条 `RUNTIME_FUNCTION` 是三个 DWORD
   * （`BeginAddress`/`EndAddress`/`UnwindData`），三个都挂一条指着 `.uw_base`
   * 的 RELATIVE —— 于是链接时整节一挪，三个数跟着挪（`tccpe.c:1997-2005`）。 */
  const pdBuf = new Buf();
  const raPdata = [];
  if (uw !== null) {
    for (const fn of uw.funcs) {
      const o = pdBuf.len;
      pdBuf.u32(fn.start).u32(fn.end).u32(uw.offs);
      for (let k = 0; k < 12; k += 4) {
        raPdata.push({ at: o + k, sym: symIndexOf('.uw_base'), type: R_X86_64_RELATIVE, add: 0 });
      }
    }
  }
  const pdBytes = pdBuf.out();

  /* `.eh_frame` 与它那张重定位表（第一百一十九片）：每个 FDE 的 PC Begin 一条
   * PC32，挂在第 i 条节符号上（`ehBase + i`，STT_FILE 那一条已经把号顶了一位）。 */
  let ehBytes = new Uint8Array(0);
  const raEh = [];
  if (ehFuncs !== null) {
    if (archName !== 'x86_64') throw new OmniError(`elf: .eh_frame 还只写了 x86_64 的（${archName}）`);
    const eh = ehFrameX64(ehFuncs);
    ehBytes = eh.bytes;
    for (let k = 0; k < eh.relocs.length; k++) {
      raEh.push({ at: eh.relocs[k].at, sym: ehBase + 1 + k, type: R_X86_64_PC32, add: 0 });
    }
  }

  /* ---- 节。1..6 是写死的六条，后面接重定位表，最后是 `.shstrtab`。 */
  const shstr = new StrTab();
  const secs = [{ name: '', type: 0, flags: 0, off: 0, size: 0, link: 0, info: 0, al: 0, ent: 0 }];
  const sec = (name, type, flags, size, link, info, al, ent) => {
    secs.push({ name, type, flags, size, link, info, al, ent });
    return secs.length - 1;
  };
  /* 每一节自己的 `sh_addralign`（第一百三十二片）：tcc 写的是「里头对齐要求最大的那一块」，
   * 下界 8 —— 量过 x86_64-linux 上 `int g32 __attribute__((aligned(32))) = 9;` 的 `.data`
   * 是 32、`struct a7 g7[2] __attribute__((aligned(16)));` 的 `.bss` 是 16。从前这三节都
   * 写死 8（`dataAlign` 那一格明着说「ELF 用不上」），那只是先前的探针里最大的对齐正好都是 8。 */
  const sal = o.secAlign === undefined ? {} : o.secAlign;
  sec('.text', SHT_PROGBITS, SHF_ALLOC | SHF_EXECINSTR, text.length, 0, 0, 8, 0);
  sec('.data', SHT_PROGBITS, SHF_ALLOC | SHF_WRITE, dataBytes.length, 0, 0, sal.data ?? 8, 0);
  sec(rdata, SHT_PROGBITS, SHF_ALLOC, roBytes.length, 0, 0, sal.rodata ?? 8, 0);
  sec('.bss', SHT_NOBITS, SHF_ALLOC | SHF_WRITE, o.bssSize === undefined ? 0 : o.bssSize,
    0, 0, sal.bss ?? 8, 0);
  const symtabNo = secs.length;
  sec('.symtab', SHT_SYMTAB, 0, syms.length * SYM_SIZE, symtabNo + 1, nlocal + 1, 8, SYM_SIZE);
  sec('.strtab', SHT_STRTAB, 0, strBytes.length, 0, 0, 1, 0);
  /* 7 号往后是**造出来的次序**（第一百一十七、一百一十八片）：tcc 那边这几节不排序，
   * 谁先造谁在前 —— `.rela.text` 在第一条代码重定位发出来的时候造、`.rela.data` 在第一条
   * 数据重定位落的时候造、`.pdata` 在**第一个函数收尾**那一步造。三件事的位置由上一层
   * 换算到「第几个函数」那把尺子上（`opts.seq`），这儿只管按位置排。 */
  const seq = o.seq === undefined ? {} : o.seq;
  const later = [];
  if (ehFuncs !== null) {
    /* `.eh_frame` 在**一遍过刚开头**就造（`tcc_eh_frame_start` 在翻译单元的开头），
     * 所以它排在这一段的最前；`.rela.eh_frame` 要等第一个函数收尾发第一条 PC32。 */
    later.push({
      pos: seq.eh ?? -1,
      add: () => sec('.eh_frame', SHT_PROGBITS, SHF_ALLOC, ehBytes.length, 0, 0, 8, 0),
    });
    later.push({
      pos: seq.relaEh ?? 0.8,
      add: () => {
        const ehNo = secs.findIndex((s) => s.name === '.eh_frame');
        sec('.rela.eh_frame', SHT_RELA, 0, raEh.length * RELA_SIZE, symtabNo, ehNo, 8, RELA_SIZE);
      },
    });
  }
  if (raText.length > 0) {
    later.push({
      pos: seq.text ?? 0,
      add: () => sec('.rela.text', SHT_RELA, 0, raText.length * RELA_SIZE, symtabNo, 1, 8, RELA_SIZE),
    });
  }
  if (uw !== null) {
    later.push({
      pos: seq.pdata ?? 1,
      add: () => {
        sec('.pdata', SHT_PROGBITS, SHF_ALLOC, pdBytes.length, 0, 0, 4, 0);
        const pdNo = secs.length - 1;
        sec('.rela.pdata', SHT_RELA, 0, raPdata.length * RELA_SIZE, symtabNo, pdNo, 8, RELA_SIZE);
      },
    });
  }
  if (raData.length > 0) {
    later.push({
      pos: seq.data ?? 2,
      add: () => sec('.rela.data', SHT_RELA, 0, raData.length * RELA_SIZE, symtabNo, 2, 8, RELA_SIZE),
    });
  }
  /* 只读那一节也会有重定位（第一百二十二片）：`const char *cp = "cst"` 的初值要一条
   * POINTER64，而 `const` 的东西哪怕初值要重定位也照样进只读节 —— 于是多一张
   * `.rela.data.ro`（PE 上是 `.rela.rdata`），落点还是那把「第几个函数」的尺子。 */
  if (raRo.length > 0) {
    later.push({
      pos: seq.rodata ?? 2,
      add: () => sec(`.rela${rdata}`, SHT_RELA, 0, raRo.length * RELA_SIZE, symtabNo, 3, 8, RELA_SIZE),
    });
  }
  later.sort((a, b) => a.pos - b.pos);
  for (const x of later) x.add();
  sec('.shstrtab', SHT_STRTAB, 0, 0, 0, 0, 1, 0);
  for (let i = 1; i < secs.length; i++) secs[i].strx = shstr.intern(secs[i].name);
  const shstrBytes = shstr.bytes();
  secs[secs.length - 1].size = shstrBytes.length;

  /* 每一节的字节先备齐，排布与写出交给下一层（`writeSections`）—— 那一层不认得
   * 「哪一节是什么」，只管两条算式，所以读回来的东西也能原样写回去。 */
  const symBuf = new Buf();
  for (const s of syms) {
    /* `st_other` 就是可见性那一格（第九刀第一百〇六片）：低两位是 STV_*，
     * `__attribute__((visibility("hidden")))` 落在这儿。 */
    symBuf.u32(s.strx).u8(s.info).u8(s.other ?? 0).u16(s.shndx).u64(s.value).u64(s.size);
  }
  const relaBuf = (rs) => {
    const rb = new Buf();
    /* `r_info` 是「符号号 * 2^32 + 类型号」。用乘法而不是移位 ——
     * JS 的 `<<` 只在 32 位里做（macho.js 那边同一条）。 */
    for (const r of rs) rb.u64(r.at).u64(BigInt(r.sym) * 4294967296n + BigInt(r.type)).i64(r.add);
    return rb.out();
  };
  const bodyOf = (name) => {
    if (name === '.text') return text;
    if (name === '.data') return dataBytes;
    if (name === rdata) return roBytes;
    if (name === `.rela${rdata}`) return relaBuf(raRo);
    if (name === '.symtab') return symBuf.out();
    if (name === '.strtab') return strBytes;
    if (name === '.rela.text') return relaBuf(raText);
    if (name === '.rela.data') return relaBuf(raData);
    if (name === '.pdata') return pdBytes;
    if (name === '.rela.pdata') return relaBuf(raPdata);
    if (name === '.eh_frame') return ehBytes;
    if (name === '.rela.eh_frame') return relaBuf(raEh);
    if (name === '.shstrtab') return shstrBytes;
    return new Uint8Array(0);
  };
  const out = [];
  for (let i = 1; i < secs.length; i++) {
    out.push({
      name: secs[i].name,
      strx: secs[i].strx,
      type: secs[i].type,
      flags: secs[i].flags,
      link: secs[i].link,
      info: secs[i].info,
      al: secs[i].al,
      ent: secs[i].ent,
      /* NOBITS 的节（`.bss`）有大小、没字节（第一百三十二片）—— 下一层认这一格，
       * 不给的话它按字节数算，`sh_size` 就成了 0。 */
      size: secs[i].type === SHT_NOBITS ? secs[i].size : undefined,
      bytes: bodyOf(secs[i].name),
    });
  }
  return writeSections(cpu.machine, out);
}

/**
 * 低一层的写出：节都已经是字节了，这儿只管**排布**与**写字节**。
 *
 * 排布是 `elf_output_obj` 的两条算式，写出是 `tcc_output_elf`：
 *
 *   off = (64 + 3) & -4 + 节数 * 64        // 节头表紧贴 ELF 头，所以 e_shoff = 64
 *   每一节：off = (off + 15) & -16         // 空节也占一个位置；NOBITS 不推进游标
 *
 * 这一层不认得「哪一节是什么」—— 于是**读回来的一份能原样写回去**，
 * 那条往返正好是「我们的 ELF 模型完整不完整」的证据（`tests/c/elf-roundtrip.js`）。
 *
 * @param machine `e_machine`
 * @param secs 1 号起的那些节：`[{strx, type, flags, link, info, al, ent, bytes}]`，
 *             `.shstrtab` 要在**最后**一条（`e_shstrndx = 节数 - 1`）
 * @param opts `{class32, flags}`：32 位的目标（i386 / arm）头与节头都短一截；
 *             `flags` 是 `e_flags` —— arm 那一路写的是
 *             `EF_ARM_EABI_VER5 | EF_ARM_VFP_FLOAT`（`tccelf.c:2697`），别的目标是 0
 */
export function writeSections(machine, secs, opts) {
  const c32 = opts !== undefined && opts.class32 === true;
  const eflags = opts === undefined || opts.flags === undefined ? 0 : opts.flags;
  const ehdr = c32 ? EHDR32_SIZE : EHDR_SIZE;
  const shdr = c32 ? SHDR32_SIZE : SHDR_SIZE;
  const shnum = secs.length + 1;
  /* `sh_size` 与「文件里有多少字节」不是一回事：NOBITS（`.bss`）有大小、没字节。
   * 所以这一层认 `size` 那一格（不给就按字节数算）。 */
  const sizeOf = (s) => (s.size === undefined ? s.bytes.length : s.size);
  const off = [0];
  let at = align(ehdr, 4) + shnum * shdr;
  for (const s of secs) {
    at = align(at, 16);
    off.push(at);
    if (s.type !== SHT_NOBITS) at += s.bytes.length;
  }

  const b = new Buf();
  // ---- ELF 头
  b.u8(0x7f).u8(0x45).u8(0x4c).u8(0x46);
  b.u8(c32 ? ELFCLASS32 : ELFCLASS64).u8(ELFDATA2LSB).u8(EV_CURRENT).u8(0);
  b.u64(0);                                     // e_ident 剩下的八格
  b.u16(ET_REL).u16(machine).u32(EV_CURRENT);
  if (c32) b.u32(0).u32(0).u32(ehdr);           // e_entry / e_phoff / e_shoff
  else b.u64(0).u64(0).u64(ehdr);
  b.u32(eflags).u16(ehdr).u16(0).u16(0);        // e_flags / e_ehsize / e_phentsize / e_phnum
  b.u16(shdr).u16(shnum).u16(shnum - 1);
  if (b.len !== ehdr) throw new OmniError(`elf: 头写成了 ${b.len} 字节`);

  // ---- 节头表。0 号那一条全是 0。
  for (let k = 0; k < shdr; k++) b.u8(0);
  for (let i = 0; i < secs.length; i++) {
    const s = secs[i];
    if (c32) {
      b.u32(s.strx).u32(s.type).u32(s.flags);
      b.u32(0).u32(off[i + 1]).u32(sizeOf(s));       // sh_addr 在 .o 里一律 0
      b.u32(s.link).u32(s.info).u32(s.al).u32(s.ent);
      continue;
    }
    b.u32(s.strx).u32(s.type).u64(s.flags);
    b.u64(0).u64(off[i + 1]).u64(sizeOf(s));         // sh_addr 在 .o 里一律 0
    b.u32(s.link).u32(s.info).u64(s.al).u64(s.ent);
  }

  // ---- 节的内容，一节一节补 0 补到自己的 `sh_offset`
  for (let i = 0; i < secs.length; i++) {
    if (secs[i].type === SHT_NOBITS) continue;
    b.padTo(off[i + 1]);
    b.bytes(secs[i].bytes);
  }
  return b.out();
}

/**
 * 读一个 `ET_REL` 的 ELF：回 `{machine, class32, flags, secs}`，形状与 `writeSections`
 * 的入参一样。
 *
 * 只读节头表与节的字节 —— 符号与重定位**不解释**。链接器要的正是这个粒度：
 * 并合是「把同名的节接起来、把符号表并起来、把重定位的偏移与符号号改一遍」，
 * 而那三件事各自都在字节上做（tcc 的 `tcc_load_object_file` 也是这个粒度）。
 */
export function readObject(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < EHDR32_SIZE || bytes[0] !== 0x7f || bytes[1] !== 0x45
    || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    throw new OmniError('elf: 这不是一个 ELF 文件');
  }
  const c32 = bytes[4] === ELFCLASS32;
  if ((bytes[4] !== ELFCLASS64 && !c32) || bytes[5] !== ELFDATA2LSB) {
    throw new OmniError('elf: 只认小端的 32 位或 64 位');
  }
  const shdrSize = c32 ? SHDR32_SIZE : SHDR_SIZE;
  if (dv.getUint16(16, true) !== ET_REL) throw new OmniError('elf: 只认 ET_REL（目标文件）');
  const machine = dv.getUint16(18, true);
  const shoff = c32 ? dv.getUint32(32, true) : Number(dv.getBigUint64(40, true));
  const shnum = dv.getUint16(c32 ? 48 : 60, true);
  const shstrndx = dv.getUint16(c32 ? 50 : 62, true);
  if (shoff + shnum * shdrSize > bytes.length) throw new OmniError('elf: 节头表越出了文件');
  const shdr = (i) => {
    const o = shoff + i * shdrSize;
    if (c32) {
      return {
        strx: dv.getUint32(o, true),
        type: dv.getUint32(o + 4, true),
        flags: dv.getUint32(o + 8, true),
        off: dv.getUint32(o + 16, true),
        size: dv.getUint32(o + 20, true),
        link: dv.getUint32(o + 24, true),
        info: dv.getUint32(o + 28, true),
        al: dv.getUint32(o + 32, true),
        ent: dv.getUint32(o + 36, true),
      };
    }
    return {
      strx: dv.getUint32(o, true),
      type: dv.getUint32(o + 4, true),
      flags: Number(dv.getBigUint64(o + 8, true)),
      off: Number(dv.getBigUint64(o + 24, true)),
      size: Number(dv.getBigUint64(o + 32, true)),
      link: dv.getUint32(o + 40, true),
      info: dv.getUint32(o + 44, true),
      al: Number(dv.getBigUint64(o + 48, true)),
      ent: Number(dv.getBigUint64(o + 56, true)),
    };
  };
  const strs = shdr(shstrndx);
  const nameOf = (n) => {
    let e = strs.off + n;
    while (e < bytes.length && bytes[e] !== 0) e++;
    let s = '';
    for (let k = strs.off + n; k < e; k++) s += String.fromCharCode(bytes[k]);
    return s;
  };
  const secs = [];
  for (let i = 1; i < shnum; i++) {
    const s = shdr(i);
    /* NOBITS 的节在文件里没有字节（`.bss`），可它的 `sh_size` 不是 0 ——
     * 这一层留一个空数组，长度那一格由 `type` 决定该不该写（`writeSections`）。
     * 于是往返写回去时 `.bss` 的 `sh_size` 会变成 0。真正要并合 `.bss` 的时候
     * 这一格要单独带上，那属于链接器那一片。 */
    let body = null;
    if (s.type === SHT_NOBITS) body = new Uint8Array(0);
    else body = bytes.subarray(s.off, s.off + s.size);
    secs.push({
      name: nameOf(s.strx),
      strx: s.strx,
      type: s.type,
      flags: s.flags,
      link: s.link,
      info: s.info,
      al: s.al,
      ent: s.ent,
      size: s.size,
      bytes: body,
    });
  }
  return { machine, class32: c32, flags: dv.getUint32(c32 ? 36 : 48, true), secs };
}
