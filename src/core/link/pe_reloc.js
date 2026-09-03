/* 重定位的落笔 —— ADR-0017 第 11 步，第九刀第四十九片。
 *
 * `tccelf.c:relocate_section` 加上两条腿的 `relocate()`。这一份只做「把一条重定位写进
 * 字节里」这一件事，符号地址由调用方算好递进来。
 *
 * 两格要记住：
 *
 *  - 加数（`r_addend`）与**原地那个值**都要算进去。tcc 大量用 `add32le` / `add64le`，
 *    也就是「原地的值 + 目标」，编译器在生成代码时先把一部分偏移写在那里了。
 *  - `R_XXX_RELATIVE` 在 PE 上不是「什么都不做」：`add32le(ptr, val - imagebase)`，
 *    也就是往那一格里写 RVA。`.pdata` 里那些指向函数的项就是这么落笔的。
 */

import { OmniError } from '../source/diag.js';

const PREL_EM_386 = 3;
const PREL_EM_ARM = 40;
const PREL_EM_X86_64 = 62;
const PREL_EM_AARCH64 = 183;

/* i386（`i386-link.c` 的 `relocate`）。32 位上一格就是 4 字节，所以「直接」那一号
 * （`REL_TYPE_DIRECT`）也是 `R_386_32` —— 与 x86_64 上的 `PREL_R_X86_64_64` 对应。 */
const R_386_32 = 1;
const R_386_PC32 = 2;
const R_386_GOT32 = 3;
const R_386_PLT32 = 4;
const R_386_GLOB_DAT = 6;
const R_386_JMP_SLOT = 7;
const R_386_RELATIVE = 8;
const R_386_GOTOFF = 9;
const R_386_GOTPC = 10;
const R_386_GOT32X = 43;
const R_386_TLS_LE = 17;

/* arm（`arm-link.c`）。`REL_TYPE_DIRECT` 与 `R_XXX_THUNKFIX` 都是 `R_ARM_ABS32`。 */
const R_ARM_NONE = 0;
const R_ARM_PC24 = 1;
const R_ARM_ABS32 = 2;
const R_ARM_REL32 = 3;
const R_ARM_GLOB_DAT = 21;
const R_ARM_JUMP_SLOT = 22;
const R_ARM_RELATIVE = 23;
const R_ARM_GOTOFF = 24;
const R_ARM_GOTPC = 25;
const R_ARM_GOT32 = 26;
const R_ARM_PLT32 = 27;
const R_ARM_CALL = 28;
const R_ARM_JUMP24 = 29;
const R_ARM_TARGET1 = 38;
const R_ARM_PREL31 = 42;
const R_ARM_TLS_LE32 = 108;

/* riscv64（`riscv64-link.c`）。`R_GLOB_DAT` 与 `R_DATA_PTR` 都是 `R_RISCV_64`。 */
const PREL_EM_RISCV = 243;
const R_RISCV_NONE = 0; const R_RISCV_32 = 1; const R_RISCV_64 = 2;
const R_RISCV_RELATIVE = 3; const R_RISCV_COPY = 4; const R_RISCV_JUMP_SLOT = 5;
const R_RISCV_BRANCH = 16; const R_RISCV_JAL = 17; const R_RISCV_CALL = 18;
const R_RISCV_CALL_PLT = 19; const R_RISCV_GOT_HI20 = 20;
const R_RISCV_PCREL_HI20 = 23; const R_RISCV_PCREL_LO12_I = 24;
const R_RISCV_PCREL_LO12_S = 25;
const R_RISCV_TPREL_HI20 = 29; const R_RISCV_TPREL_LO12_I = 30;
const R_RISCV_ADD16 = 34; const R_RISCV_ADD32 = 35; const R_RISCV_ADD64 = 36;
const R_RISCV_SUB8 = 37; const R_RISCV_SUB16 = 38; const R_RISCV_SUB32 = 39;
const R_RISCV_SUB64 = 40; const R_RISCV_ALIGN = 43;
const R_RISCV_RVC_BRANCH = 44; const R_RISCV_RVC_JUMP = 45; const R_RISCV_RELAX = 51;
const R_RISCV_SUB6 = 52; const R_RISCV_SET6 = 53; const R_RISCV_SET8 = 54;
const R_RISCV_SET16 = 55; const R_RISCV_32_PCREL = 57;
const R_RISCV_SET_ULEB128 = 60; const R_RISCV_SUB_ULEB128 = 61;

/* x86_64 */
const PREL_R_X86_64_64 = 1;
const PREL_R_X86_64_PC32 = 2;
const PREL_R_X86_64_PLT32 = 4;
const PREL_R_X86_64_GLOB_DAT = 6;
const PREL_R_X86_64_JUMP_SLOT = 7;
const PREL_R_X86_64_RELATIVE = 8;
const PREL_R_X86_64_GOTPCREL = 9;
const R_X86_64_32 = 10;
const R_X86_64_32S = 11;
const R_X86_64_TPOFF32 = 23;
const R_X86_64_GOTPCRELX = 41;
const R_X86_64_REX_GOTPCRELX = 42;

/* arm64 */
const PREL_R_AARCH64_ABS64 = 257;
const R_AARCH64_ABS32 = 258;
const R_AARCH64_PREL32 = 261;
const PREL_R_AARCH64_ADR_PREL_PG_HI21 = 275;
const PREL_R_AARCH64_ADD_ABS_LO12_NC = 277;
const PREL_R_AARCH64_LDST8_ABS_LO12_NC = 278;
const R_AARCH64_TSTBR14 = 279;
const R_AARCH64_CONDBR19 = 280;
const R_AARCH64_JUMP26 = 282;
const PREL_R_AARCH64_CALL26 = 283;
const R_AARCH64_LDST16_ABS_LO12_NC = 284;
const R_AARCH64_LDST32_ABS_LO12_NC = 285;
const R_AARCH64_LDST64_ABS_LO12_NC = 286;
const R_AARCH64_LDST128_ABS_LO12_NC = 299;
const PREL_R_AARCH64_ADR_GOT_PAGE = 311;
const PREL_R_AARCH64_LD64_GOT_LO12_NC = 312;
const R_AARCH64_TLSLE_ADD_TPREL_HI12 = 549;
const R_AARCH64_TLSLE_ADD_TPREL_LO12 = 550;
const PREL_R_AARCH64_GLOB_DAT = 1025;const PREL_R_AARCH64_JUMP_SLOT = 1026;
const PREL_R_AARCH64_RELATIVE = 1027;

/**
 * 落一条重定位。
 *
 * @param machine `e_machine`
 * @param type 重定位号
 * @param b 目标节的字节
 * @param at 在这一节里的偏移（`r_offset`）
 * @param addr 这一处的**虚拟地址**（节的地址 + `r_offset`）
 * @param val 符号的值加上加数
 * @param imagebase 映像基址（`R_XXX_RELATIVE` 要它来算 RVA）
 * @param weakUndef 这条重定位指的是不是一个**未定义的弱符号** —— PE 上它的地址是 0，
 *        arm64 的 `adrp` 与 `bl` 都编不出那么远的距离，tcc 于是改写成 `movz`/`nop`
 * @param gotSlot 这个符号在 `.got` 里那一格的**虚拟地址**（走 GOT 的那几号要它）
 * @param tls `{start, end, symSecEnd, tcb}`：PT_TLS 那一段的起止（线程局部那几号要它）；
 *        没有 PT_TLS 的格式（Mach-O）两头都是 0，x86_64 那号退回用 `symSecEnd`
 *        —— 符号所在那一节的末尾。`tcb` 是 tp 指着的那个头有多大，arm64 要加上它：
 *        glibc 的 `tcbhead_t` 是 16 字节，Windows 上 tp 直接指着数据，是 0
 */
export function relocateOne(machine, type, b, at, addr, val, imagebase, weakUndef, gotSlot, tls,
  pcrelHi) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const add32 = (v) => dv.setUint32(at, (dv.getUint32(at, true) + v) >>> 0, true);
  const add64 = (v) => dv.setBigUint64(at, dv.getBigUint64(at, true) + BigInt(v), true);
  const set64 = (v) => dv.setBigUint64(at, BigInt(v), true);
  const put32 = (keep, or) => dv.setUint32(at, ((dv.getUint32(at, true) & keep) | or) >>> 0, true);
  const insn = () => dv.getUint32(at, true);
  const slot = () => {
    if (gotSlot === undefined) throw new OmniError(`reloc: ${type} 号要 .got，可它还没造`);
    return gotSlot;
  };
  const tlsSeg = () => {
    if (tls === undefined) throw new OmniError(`reloc: ${type} 号要 PT_TLS，可它还没摆`);
    return tls;
  };
  const tprel = () => { const t = tlsSeg(); return val - t.start + t.tcb; };

  if (machine === PREL_EM_X86_64) {
    switch (type) {
      case PREL_R_X86_64_64: return add64(val);
      case R_X86_64_32:
      case R_X86_64_32S: return add32(val);
      case PREL_R_X86_64_PC32:
      case PREL_R_X86_64_PLT32: return add32(val - addr);
      case PREL_R_X86_64_RELATIVE: return add32(val - imagebase);
      /* GOT 里那一格的地址 - 这一处 - 4（`- 4` 是 `rip` 相对里指令末尾那一段）。 */
      case PREL_R_X86_64_GOTPCREL:
      case R_X86_64_GOTPCRELX:
      case R_X86_64_REX_GOTPCRELX: return add32(slot() - addr - 4);
      /* 往 GOT 那一格里**写**符号的地址（不是加）—— tcc 那两句是 `write64le`。 */
      case PREL_R_X86_64_GLOB_DAT:
      case PREL_R_X86_64_JUMP_SLOT: return set64(val);
      /* 线程局部：偏移是**相对 PT_TLS 那一段的末尾**（x86_64 的 `fs:` 基址指着
       * 线程块的末端，所以这几个偏移都是负数）。Mach-O 上没有 PT_TLS，`tls_end`
       * 是 0，tcc 于是退回「符号所在那一节的末尾」（`val - sec->sh_addr
       * - sec->data_offset`）—— 算出来的偏移没什么用，但字节是这么写的。 */
      case R_X86_64_TPOFF32: {
        const t = tlsSeg();
        return add32(t.end !== 0 ? val - t.end : val - t.symSecEnd);
      }
      default: throw new OmniError(`reloc: x86_64 还不会 ${type} 号`);
    }
  }
  if (machine === PREL_EM_386) {
    switch (type) {
      case R_386_32: return add32(val);
      case R_386_PC32:
      case R_386_PLT32: return add32(val - addr);
      case R_386_RELATIVE: return add32(val - imagebase);
      case R_386_GLOB_DAT:
      case R_386_JMP_SLOT: return dv.setUint32(at, val >>> 0, true);
      case R_386_GOTPC: return add32(slot() - addr);
      case R_386_GOTOFF: return add32(val - slot());
      /* `add32le(ptr, got_offset)`：写的是**这个符号在 GOT 里的偏移**，不是地址。
       * 调用方把那个偏移当 `gotSlot` 递进来。 */
      case R_386_GOT32:
      case R_386_GOT32X: return add32(slot());
      /* 与 x86_64 的 `TPOFF32` 同一个形状：`tls_end` 有就减它，没有就退回符号所在
       * 那一节的末尾（`i386-link.c` 里 `R_386_TLS_LE` 那一段）。 */
      case R_386_TLS_LE: {
        const t = tlsSeg();
        return add32(t.end !== 0 ? val - t.end : val - t.symSecEnd);
      }
      default: throw new OmniError(`reloc: i386 还不会 ${type} 号`);
    }
  }
  if (machine === PREL_EM_AARCH64) {
    switch (type) {
      case PREL_R_AARCH64_ABS64: return add64(val);
      case R_AARCH64_ABS32: return add32(val);
      case R_AARCH64_PREL32: return add32(val - addr);
      case PREL_R_AARCH64_RELATIVE: return add32(val - imagebase);
      case PREL_R_AARCH64_ADR_PREL_PG_HI21: {
        /* 页与页之差，21 位；高 19 位摆在 5..23，低 2 位摆在 29..30。 */
        const off = Math.floor(val / 4096) - Math.floor(addr / 4096);
        if (weakUndef === true && (off < -(1 << 20) || off >= (1 << 20))) {
          /* 地址是 0，`adrp` 从 64 位的映像基址编不出来 —— 直接 `movz xN, #0`。 */
          return dv.setUint32(at, (0xd2800000 | (insn() & 0x1f)) >>> 0, true);
        }
        return put32(0x9f00001f, ((off & 0x1ffffc) << 3 | (off & 3) << 29) >>> 0);
      }
      case PREL_R_AARCH64_ADD_ABS_LO12_NC:
      case PREL_R_AARCH64_LDST8_ABS_LO12_NC: return put32(0xffc003ff, ((val & 0xfff) << 10) >>> 0);
      case R_AARCH64_LDST16_ABS_LO12_NC: return put32(0xffc003ff, ((val & 0xffe) << 9) >>> 0);
      case R_AARCH64_LDST32_ABS_LO12_NC: return put32(0xffc003ff, ((val & 0xffc) << 8) >>> 0);
      case R_AARCH64_LDST64_ABS_LO12_NC: return put32(0xffc003ff, ((val & 0xff8) << 7) >>> 0);
      case R_AARCH64_LDST128_ABS_LO12_NC: return put32(0xffc003ff, ((val & 0xff0) << 6) >>> 0);
      case R_AARCH64_TSTBR14:                         // tbz/tbnz：14 位，摆在 5..18
        return put32(0xfff8001f, (((val - addr) / 4 & 0x3fff) << 5) >>> 0);
      case R_AARCH64_CONDBR19:                        // b.cond/cbz：19 位，摆在 5..23
        return put32(0xff00001f, (((val - addr) / 4 & 0x7ffff) << 5) >>> 0);
      case R_AARCH64_JUMP26:
      case PREL_R_AARCH64_CALL26: {
        const d = (val - addr) / 4;
        if (weakUndef === true && (d < -(1 << 25) || d >= (1 << 25))) {
          return dv.setUint32(at, 0xd503201f, true);   // 够不着，写个 nop
        }
        const link = type === PREL_R_AARCH64_CALL26 ? 0x80000000 : 0;
        return dv.setUint32(at, (0x14000000 | link | (d & 0x3ffffff)) >>> 0, true);
      }
      case PREL_R_AARCH64_ADR_GOT_PAGE: {
        /* 与上面那条一样的编码，只是指的是 `.got` 里那一格。 */
        const off = Math.floor(slot() / 4096) - Math.floor(addr / 4096);
        return put32(0x9f00001f, ((off & 0x1ffffc) << 3 | (off & 3) << 29) >>> 0);
      }
      case PREL_R_AARCH64_LD64_GOT_LO12_NC:
        return put32(0xfff803ff, ((slot() & 0xff8) << 7) >>> 0);
      case PREL_R_AARCH64_GLOB_DAT:
      case PREL_R_AARCH64_JUMP_SLOT: return set64(val);
      /* 线程局部：arm64 上偏移是「离 PT_TLS 起点的距离 + tp 指着的那个头」。
       * glibc 里 `tpidr_el0` 指着线程控制块（`tcbhead_t`）的开头、数据接在它后面，
       * 那个头是 16 字节；Windows 上 tcc 不加这一段（`#if TCC_TARGET_PE`）。 */
      case R_AARCH64_TLSLE_ADD_TPREL_HI12:
        return put32(0xffc003ff, ((Math.floor(tprel() / 4096) & 0xfff) << 10) >>> 0);
      case R_AARCH64_TLSLE_ADD_TPREL_LO12:
        return put32(0xffc003ff, ((tprel() & 0xfff) << 10) >>> 0);
      default: throw new OmniError(`reloc: arm64 还不会 ${type} 号`);
    }
  }
  if (machine === PREL_EM_ARM) {
    switch (type) {
      case R_ARM_NONE: return undefined;
      /* `bl` / `b` 那一族：26 位（存的是右移 2 位的字数），原地那 24 位是加数。
       * `val & 1` 是 thumb，那时 `bl` 换成 `blx`（0xfa000000）并把第 1 位挪到 24 位上。 */
      case R_ARM_PC24:
      case R_ARM_PLT32:
      case R_ARM_CALL:
      case R_ARM_JUMP24: {
        const code = insn();
        let x = (code & 0x00ffffff) << 2;
        if ((x & 0x2000000) !== 0) x -= 0x4000000;
        x += val - addr;
        if (x >= 0x2000000 || x < -0x2000000) {
          throw new OmniError(`reloc: arm 的 ${type} 号跳不到 0x${(val >>> 0).toString(16)}`);
        }
        const thumb = (val & 1) !== 0;
        const h = x & 2;
        const base = thumb ? 0xfa000000 : (code & 0xff000000) >>> 0;
        const imm = ((x >> 2) & 0xffffff) | (thumb ? h << 24 : 0);
        return dv.setUint32(at, (base | imm) >>> 0, true);
      }
      case R_ARM_ABS32:
      case R_ARM_TARGET1: return add32(val);
      case R_ARM_REL32: return add32(val - addr);
      case R_ARM_RELATIVE: return add32(val - imagebase);
      case R_ARM_GLOB_DAT:
      case R_ARM_JUMP_SLOT: return dv.setUint32(at, val >>> 0, true);
      case R_ARM_GOTPC: return add32(slot() - addr);
      case R_ARM_GOTOFF: return add32(val - slot());
      case R_ARM_GOT32: return add32(slot());
      /* `.ARM.exidx` 里那种「31 位的自相对偏移」，最高位原样留着。 */
      case R_ARM_PREL31: {
        const old = insn();
        const x = (((old & 0x7fffffff) << 1) >> 1) + (val - addr);
        return dv.setUint32(at, ((old & 0x80000000) | (x & 0x7fffffff)) >>> 0, true);
      }
      /* arm 的线程局部**多 8 字节**（`x = val - tls_start + 8`）—— 与 x86 那两个不同。 */
      case R_ARM_TLS_LE32: {
        const t = tlsSeg();
        return add32((t.end !== 0 ? val - t.start : val - t.symSecEnd) + 8);
      }
      default: throw new OmniError(`reloc: arm 还不会 ${type} 号`);
    }
  }
  if (machine === PREL_EM_RISCV) {
    const hiMap = () => {
      if (pcrelHi === undefined) throw new OmniError('reloc: riscv 的 hi/lo 配对要一张表');
      return pcrelHi;
    };
    /* `riscv64_lookup_pcrel_hi`：`LO12` 那条的**符号值就是 `HI20` 那条的地址**，
     * 拿它去查刚才记下的 val（`unsupported hi/lo pcrel reloc scheme` 就是查不着）。 */
    const lookupHi = () => {
      const v = hiMap().get(val);
      if (v === undefined) throw new OmniError('reloc: riscv 的 hi/lo 配对查不着');
      return v - val;
    };
    const set16 = (v) => dv.setUint16(at, v & 0xffff, true);
    const ins16 = () => dv.getUint16(at, true);
    switch (type) {
      case R_RISCV_NONE:
      case R_RISCV_ALIGN:
      case R_RISCV_RELAX:
      case R_RISCV_COPY:
      case R_RISCV_RELATIVE:
      case R_RISCV_SET_ULEB128:
      case R_RISCV_SUB_ULEB128: return undefined;
      /* 条件跳转：12 位（存的是右移 1 位的字节数），位散在四处。 */
      case R_RISCV_BRANCH: {
        const off = (val - addr) >> 1;
        return put32(~0xfe000f80, (((off & 0x800) << 20) | ((off & 0x3f0) << 21)
          | ((off & 0x00f) << 8) | ((off & 0x400) >> 3)) >>> 0);
      }
      case R_RISCV_JAL: {
        const off = val - addr;
        return put32(0xfff, ((((off >> 12) & 0xff) << 12) | (((off >> 11) & 1) << 20)
          | (((off >> 1) & 0x3ff) << 21) | (((off >> 20) & 1) << 31)) >>> 0);
      }
      /* `auipc` + `jalr` 一对：高 20 位带 0x800 的进位补偿，低 12 位落在第二条上。 */
      case R_RISCV_CALL:
      case R_RISCV_CALL_PLT: {
        put32(0xfff, ((val - addr + 0x800) & ~0xfff) >>> 0);
        return dv.setUint32(at + 4, ((dv.getUint32(at + 4, true) & 0xfffff)
          | (((val - addr) & 0xfff) << 20)) >>> 0, true);
      }
      case R_RISCV_PCREL_HI20:
      case R_RISCV_GOT_HI20: {
        const v = type === R_RISCV_GOT_HI20 ? slot() : val;
        const off = (v - addr + 0x800) >> 12;
        hiMap().set(addr, v);
        return put32(0xfff, ((off & 0xfffff) << 12) >>> 0);
      }
      case R_RISCV_PCREL_LO12_I:
        return put32(0xfffff, ((lookupHi() & 0xfff) << 20) >>> 0);
      case R_RISCV_PCREL_LO12_S: {
        const off = lookupHi();
        return put32(~0xfe000f80, (((off & 0xfe0) << 20) | ((off & 0x01f) << 7)) >>> 0);
      }
      case R_RISCV_RVC_BRANCH: {
        const off = val - addr;
        return set16((ins16() & 0xe383) | (((off >> 5) & 1) << 2) | (((off >> 1) & 3) << 3)
          | (((off >> 6) & 3) << 5) | (((off >> 3) & 3) << 10) | (((off >> 8) & 1) << 12));
      }
      case R_RISCV_RVC_JUMP: {
        const off = val - addr;
        return set16((ins16() & 0xe003) | (((off >> 5) & 1) << 2) | (((off >> 1) & 7) << 3)
          | (((off >> 7) & 1) << 6) | (((off >> 6) & 1) << 7) | (((off >> 10) & 1) << 8)
          | (((off >> 8) & 3) << 9) | (((off >> 4) & 1) << 11) | (((off >> 11) & 1) << 12));
      }
      case R_RISCV_32:
      case R_RISCV_ADD32: return add32(val);
      case R_RISCV_64:
      case R_RISCV_JUMP_SLOT:
      case R_RISCV_ADD64: return add64(val);
      case R_RISCV_SUB32: return add32(-val);
      case R_RISCV_SUB64: return add64(-val);
      case R_RISCV_ADD16: return set16(ins16() + val);
      case R_RISCV_SUB16: return set16(ins16() - val);
      case R_RISCV_SET16: return set16(val);
      case R_RISCV_SUB8: return dv.setUint8(at, (dv.getUint8(at) - val) & 0xff);
      case R_RISCV_SET8: return dv.setUint8(at, val & 0xff);
      case R_RISCV_SET6:
        return dv.setUint8(at, (dv.getUint8(at) & ~0x3f) | (val & 0x3f));
      case R_RISCV_SUB6:
        return dv.setUint8(at, (dv.getUint8(at) & ~0x3f) | ((dv.getUint8(at) - val) & 0x3f));
      case R_RISCV_32_PCREL: return add32(val - addr);
      /* 线程局部：偏移是**相对 PT_TLS 的起点**（riscv 的 tp 指着数据头），高 20 位
       * 与低 12 位分两条写。 */
      case R_RISCV_TPREL_HI20: {
        const off = (val - tlsSeg().start + 0x800) >> 12;
        return put32(0xfff, ((off & 0xfffff) << 12) >>> 0);
      }
      case R_RISCV_TPREL_LO12_I:
        return put32(0xfffff, (((val - tlsSeg().start) & 0xfff) << 20) >>> 0);
      default: throw new OmniError(`reloc: riscv 还不会 ${type} 号`);
    }
  }
  throw new OmniError(`reloc: 不认识的架构 0x${machine.toString(16)}`);
}
