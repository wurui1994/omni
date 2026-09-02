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

const EM_X86_64 = 62;
const EM_AARCH64 = 183;

/* x86_64 */
const R_X86_64_64 = 1;
const R_X86_64_PC32 = 2;
const R_X86_64_PLT32 = 4;
const R_X86_64_GLOB_DAT = 6;
const R_X86_64_JUMP_SLOT = 7;
const R_X86_64_RELATIVE = 8;
const R_X86_64_GOTPCREL = 9;
const R_X86_64_32 = 10;
const R_X86_64_32S = 11;
const R_X86_64_TPOFF32 = 23;
const R_X86_64_GOTPCRELX = 41;
const R_X86_64_REX_GOTPCRELX = 42;

/* arm64 */
const R_AARCH64_ABS64 = 257;
const R_AARCH64_ABS32 = 258;
const R_AARCH64_PREL32 = 261;
const R_AARCH64_ADR_PREL_PG_HI21 = 275;
const R_AARCH64_ADD_ABS_LO12_NC = 277;
const R_AARCH64_LDST8_ABS_LO12_NC = 278;
const R_AARCH64_TSTBR14 = 279;
const R_AARCH64_CONDBR19 = 280;
const R_AARCH64_JUMP26 = 282;
const R_AARCH64_CALL26 = 283;
const R_AARCH64_LDST16_ABS_LO12_NC = 284;
const R_AARCH64_LDST32_ABS_LO12_NC = 285;
const R_AARCH64_LDST64_ABS_LO12_NC = 286;
const R_AARCH64_LDST128_ABS_LO12_NC = 299;
const R_AARCH64_ADR_GOT_PAGE = 311;
const R_AARCH64_LD64_GOT_LO12_NC = 312;
const R_AARCH64_TLSLE_ADD_TPREL_HI12 = 549;
const R_AARCH64_TLSLE_ADD_TPREL_LO12 = 550;
const R_AARCH64_GLOB_DAT = 1025;const R_AARCH64_JUMP_SLOT = 1026;
const R_AARCH64_RELATIVE = 1027;

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
export function relocateOne(machine, type, b, at, addr, val, imagebase, weakUndef, gotSlot, tls) {
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

  if (machine === EM_X86_64) {
    switch (type) {
      case R_X86_64_64: return add64(val);
      case R_X86_64_32:
      case R_X86_64_32S: return add32(val);
      case R_X86_64_PC32:
      case R_X86_64_PLT32: return add32(val - addr);
      case R_X86_64_RELATIVE: return add32(val - imagebase);
      /* GOT 里那一格的地址 - 这一处 - 4（`- 4` 是 `rip` 相对里指令末尾那一段）。 */
      case R_X86_64_GOTPCREL:
      case R_X86_64_GOTPCRELX:
      case R_X86_64_REX_GOTPCRELX: return add32(slot() - addr - 4);
      /* 往 GOT 那一格里**写**符号的地址（不是加）—— tcc 那两句是 `write64le`。 */
      case R_X86_64_GLOB_DAT:
      case R_X86_64_JUMP_SLOT: return set64(val);
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
  if (machine === EM_AARCH64) {
    switch (type) {
      case R_AARCH64_ABS64: return add64(val);
      case R_AARCH64_ABS32: return add32(val);
      case R_AARCH64_PREL32: return add32(val - addr);
      case R_AARCH64_RELATIVE: return add32(val - imagebase);
      case R_AARCH64_ADR_PREL_PG_HI21: {
        /* 页与页之差，21 位；高 19 位摆在 5..23，低 2 位摆在 29..30。 */
        const off = Math.floor(val / 4096) - Math.floor(addr / 4096);
        if (weakUndef === true && (off < -(1 << 20) || off >= (1 << 20))) {
          /* 地址是 0，`adrp` 从 64 位的映像基址编不出来 —— 直接 `movz xN, #0`。 */
          return dv.setUint32(at, (0xd2800000 | (insn() & 0x1f)) >>> 0, true);
        }
        return put32(0x9f00001f, ((off & 0x1ffffc) << 3 | (off & 3) << 29) >>> 0);
      }
      case R_AARCH64_ADD_ABS_LO12_NC:
      case R_AARCH64_LDST8_ABS_LO12_NC: return put32(0xffc003ff, ((val & 0xfff) << 10) >>> 0);
      case R_AARCH64_LDST16_ABS_LO12_NC: return put32(0xffc003ff, ((val & 0xffe) << 9) >>> 0);
      case R_AARCH64_LDST32_ABS_LO12_NC: return put32(0xffc003ff, ((val & 0xffc) << 8) >>> 0);
      case R_AARCH64_LDST64_ABS_LO12_NC: return put32(0xffc003ff, ((val & 0xff8) << 7) >>> 0);
      case R_AARCH64_LDST128_ABS_LO12_NC: return put32(0xffc003ff, ((val & 0xff0) << 6) >>> 0);
      case R_AARCH64_TSTBR14:                         // tbz/tbnz：14 位，摆在 5..18
        return put32(0xfff8001f, (((val - addr) / 4 & 0x3fff) << 5) >>> 0);
      case R_AARCH64_CONDBR19:                        // b.cond/cbz：19 位，摆在 5..23
        return put32(0xff00001f, (((val - addr) / 4 & 0x7ffff) << 5) >>> 0);
      case R_AARCH64_JUMP26:
      case R_AARCH64_CALL26: {
        const d = (val - addr) / 4;
        if (weakUndef === true && (d < -(1 << 25) || d >= (1 << 25))) {
          return dv.setUint32(at, 0xd503201f, true);   // 够不着，写个 nop
        }
        const link = type === R_AARCH64_CALL26 ? 0x80000000 : 0;
        return dv.setUint32(at, (0x14000000 | link | (d & 0x3ffffff)) >>> 0, true);
      }
      case R_AARCH64_ADR_GOT_PAGE: {
        /* 与上面那条一样的编码，只是指的是 `.got` 里那一格。 */
        const off = Math.floor(slot() / 4096) - Math.floor(addr / 4096);
        return put32(0x9f00001f, ((off & 0x1ffffc) << 3 | (off & 3) << 29) >>> 0);
      }
      case R_AARCH64_LD64_GOT_LO12_NC:
        return put32(0xfff803ff, ((slot() & 0xff8) << 7) >>> 0);
      case R_AARCH64_GLOB_DAT:
      case R_AARCH64_JUMP_SLOT: return set64(val);
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
  throw new OmniError(`reloc: 不认识的架构 0x${machine.toString(16)}`);
}
