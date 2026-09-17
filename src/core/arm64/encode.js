/* arm64（AArch64）指令编码器 —— ADR-0017 的第 9 步，第九刀第一片。
 *
 * 这一层只做一件事：**把一条指令变成一个 32 位的字**。不管符号、不管重定位、
 * 不管往哪儿写 —— 那些是下一层（汇编器/链接器）的事。
 *
 * 口径与验法
 * ----------
 * oracle 是 `llvm-mc -triple=arm64 --show-encoding`（ADR 第 9 步原话「对着 llvm-mc 验」）。
 * 每个函数在 `tests/arm64/run.js` 里都有一条对应的汇编文本，两边的四个字节必须一样。
 * 字段的位置照 ARM 架构参考手册（ARM DDI 0487，C4.1 "A64 instruction set encoding"）；
 * 这里不抄 tcc 的 `arm64-gen.c`（ADR-0017 决策：行为复刻、代码自写），tcc 那边是
 * 一条条 `o(0x91000000 | ...)` 的立即数，我们把字段拆开写成函数。
 *
 * 约定
 * ----
 * - 寄存器号 0-30 是 x0-x30，31 在不同指令里是 `xzr` 或 `sp`（谁是谁由指令定，
 *   ARM 手册管这叫 `Rn|SP` 与 `Rd|ZR`）—— 我们不替调用方判断，传 31 就编 31。
 * - `sf` 是「64 位吗」：1 是 x 系，0 是 w 系。所有带 sf 的函数第一个参数都是它。
 * - 回的是 **JS number**（无符号 32 位）。移位用 `* 2**n` 而不是 `<< n`：
 *   `1 << 31` 在 JS 里是负数，而我们要的是无符号的那个数（这一条踩过一次）。
 */

import { OmniError } from '../source/diag.js';

/** 编码不下去时抛 —— 越界的立即数、对不齐的偏移，都要当场报，不许悄悄截断。 */
function bad(what) {
  throw new OmniError(`arm64: ${what}`);
}

/** 无符号 32 位收尾。位域拼装全程用加法与乘法，最后过这一道。 */
function u32(x) {
  return x >>> 0;
}

function arm64ChkReg(r) {
  if (!Number.isInteger(r) || r < 0 || r > 31) bad(`寄存器号 ${r} 不在 0-31`);
  return r;
}

function chkU(v, bits, what) {
  if (!Number.isInteger(v) || v < 0 || v >= 2 ** bits) bad(`${what} ${v} 装不进 ${bits} 位无符号`);
  return v;
}

function chkS(v, bits, what) {
  const lim = 2 ** (bits - 1);
  if (!Number.isInteger(v) || v < -lim || v >= lim) bad(`${what} ${v} 装不进 ${bits} 位有符号`);
  return v >= 0 ? v : v + 2 ** bits;
}

/* ---------------------------------------------------------------- 条件码
 * ARM 手册 C1.2.4。`b.cond`、`csel`、`cset` 共用这四位。 */
export const COND = {
  eq: 0, ne: 1, cs: 2, cc: 3, mi: 4, pl: 5, vs: 6, vc: 7,
  hi: 8, ls: 9, ge: 10, lt: 11, gt: 12, le: 13, al: 14, nv: 15,
};

export function condNo(name) {
  const c = COND[name];
  if (c === undefined) bad(`不认识的条件码 '${name}'`);
  return c;
}

/* ---------------------------------------------------------------- 立即数运算
 * C4.1.4 "Data Processing -- Immediate"，Add/subtract (immediate)：
 *   sf op S 1 0 0 0 1 0 sh imm12 Rn Rd
 * `sh` 是「imm12 左移 12 位」那一格 —— arm64 的立即数运算只有这两档，别的数要先
 * 用 movz/movk 搬进寄存器（tcc 的 `arm64_movimm` 就是干这个的）。 */
function addSubImm(sf, op, S, sh, imm12, rn, rd) {
  return u32(sf * 2 ** 31 + op * 2 ** 30 + S * 2 ** 29 + 0x11 * 2 ** 24
    + sh * 2 ** 22 + chkU(imm12, 12, 'imm12') * 2 ** 10
    + arm64ChkReg(rn) * 2 ** 5 + arm64ChkReg(rd));
}

export const addImm = (sf, rd, rn, imm12, sh = 0) => addSubImm(sf, 0, 0, sh, imm12, rn, rd);
export const addsImm = (sf, rd, rn, imm12, sh = 0) => addSubImm(sf, 0, 1, sh, imm12, rn, rd);
export const subImm = (sf, rd, rn, imm12, sh = 0) => addSubImm(sf, 1, 0, sh, imm12, rn, rd);
export const subsImm = (sf, rd, rn, imm12, sh = 0) => addSubImm(sf, 1, 1, sh, imm12, rn, rd);
/** `cmp Rn, #imm` 就是 `subs xzr, Rn, #imm`（C6.2.65 的别名）。 */
export const cmpImm = (sf, rn, imm12, sh = 0) => subsImm(sf, 31, rn, imm12, sh);
/** `cmn Rn, #imm` 就是 `adds xzr, Rn, #imm`。 */
export const cmnImm = (sf, rn, imm12, sh = 0) => addsImm(sf, 31, rn, imm12, sh);
/** `mov Rd, Rn`（两个都可能是 sp）用的是 `add Rd, Rn, #0` —— 与寄存器版的 `orr` 不同，
 * 这一版才认得 sp（C6.2.187 的两条别名规则）。 */
export const movSp = (sf, rd, rn) => addImm(sf, rd, rn, 0);

/* ---------------------------------------------------------------- 搬立即数
 * C4.1.4 Move wide (immediate)：sf opc 1 0 0 1 0 1 hw imm16 Rd
 * opc: 00 = movn, 10 = movz, 11 = movk。`hw` 是往左移几个 16 位。 */
function movWide(sf, opc, hw, imm16, rd) {
  if (sf === 0 && hw > 1) bad(`movz/movk 的 w 系只有 hw=0/1，给了 ${hw}`);
  return u32(sf * 2 ** 31 + opc * 2 ** 29 + 0x25 * 2 ** 23 + chkU(hw, 2, 'hw') * 2 ** 21
    + chkU(imm16, 16, 'imm16') * 2 ** 5 + arm64ChkReg(rd));
}

export const movz = (sf, rd, imm16, hw = 0) => movWide(sf, 2, hw, imm16, rd);
export const movk = (sf, rd, imm16, hw = 0) => movWide(sf, 3, hw, imm16, rd);
export const movn = (sf, rd, imm16, hw = 0) => movWide(sf, 0, hw, imm16, rd);

/* ---------------------------------------------------------------- 寄存器运算
 * C4.1.5 Add/subtract (shifted register)：
 *   sf op S 0 1 0 1 1 shift 0 Rm imm6 Rn Rd
 * shift: 00 lsl, 01 lsr, 10 asr。 */
function addSubReg(sf, op, S, shift, rm, imm6, rn, rd) {
  return u32(sf * 2 ** 31 + op * 2 ** 30 + S * 2 ** 29 + 0x0b * 2 ** 24
    + shift * 2 ** 22 + arm64ChkReg(rm) * 2 ** 16 + chkU(imm6, 6, 'imm6') * 2 ** 10
    + arm64ChkReg(rn) * 2 ** 5 + arm64ChkReg(rd));
}

export const addReg = (sf, rd, rn, rm, shift = 0, amt = 0) =>
  addSubReg(sf, 0, 0, shift, rm, amt, rn, rd);
export const addsReg = (sf, rd, rn, rm, shift = 0, amt = 0) =>
  addSubReg(sf, 0, 1, shift, rm, amt, rn, rd);
export const subReg = (sf, rd, rn, rm, shift = 0, amt = 0) =>
  addSubReg(sf, 1, 0, shift, rm, amt, rn, rd);
export const subsReg = (sf, rd, rn, rm, shift = 0, amt = 0) =>
  addSubReg(sf, 1, 1, shift, rm, amt, rn, rd);
export const cmpReg = (sf, rn, rm, shift = 0, amt = 0) => subsReg(sf, 31, rn, rm, shift, amt);
/** `neg Rd, Rm` = `sub Rd, xzr, Rm`。 */
export const neg = (sf, rd, rm) => subReg(sf, rd, 31, rm);

/* C4.1.5 Logical (shifted register)：
 *   sf opc 0 1 0 1 0 shift N Rm imm6 Rn Rd
 * opc: 00 and, 01 orr, 10 eor, 11 ands；N=1 时是 bic/orn/eon/bics。 */
function logicReg(sf, opc, N, shift, rm, imm6, rn, rd) {
  return u32(sf * 2 ** 31 + opc * 2 ** 29 + 0x0a * 2 ** 24 + shift * 2 ** 22 + N * 2 ** 21
    + arm64ChkReg(rm) * 2 ** 16 + chkU(imm6, 6, 'imm6') * 2 ** 10
    + arm64ChkReg(rn) * 2 ** 5 + arm64ChkReg(rd));
}

export const andReg = (sf, rd, rn, rm, shift = 0, amt = 0) =>
  logicReg(sf, 0, 0, shift, rm, amt, rn, rd);
export const orrReg = (sf, rd, rn, rm, shift = 0, amt = 0) =>
  logicReg(sf, 1, 0, shift, rm, amt, rn, rd);
export const eorReg = (sf, rd, rn, rm, shift = 0, amt = 0) =>
  logicReg(sf, 2, 0, shift, rm, amt, rn, rd);
export const andsReg = (sf, rd, rn, rm, shift = 0, amt = 0) =>
  logicReg(sf, 3, 0, shift, rm, amt, rn, rd);
export const bicReg = (sf, rd, rn, rm, shift = 0, amt = 0) =>
  logicReg(sf, 0, 1, shift, rm, amt, rn, rd);
/** `tst Rn, Rm` = `ands xzr, Rn, Rm`。 */
export const tstReg = (sf, rn, rm) => andsReg(sf, 31, rn, rm);
/** `mov Rd, Rm`（不碰 sp 的那一版）= `orr Rd, xzr, Rm`。 */
export const movReg = (sf, rd, rm) => orrReg(sf, rd, 31, rm);
/** `mvn Rd, Rm` = `orn Rd, xzr, Rm`。 */
export const mvn = (sf, rd, rm) => logicReg(sf, 1, 1, 0, rm, 0, 31, rd);

/* ---------------------------------------------------------------- 乘除与变位
 * C4.1.5 Data-processing (3 source)：sf 00 11011 000 Rm o0 Ra Rn Rd */
export const madd = (sf, rd, rn, rm, ra) =>
  u32(sf * 2 ** 31 + 0x1b * 2 ** 24 + arm64ChkReg(rm) * 2 ** 16 + arm64ChkReg(ra) * 2 ** 10
    + arm64ChkReg(rn) * 2 ** 5 + arm64ChkReg(rd));
export const msub = (sf, rd, rn, rm, ra) =>
  u32(sf * 2 ** 31 + 0x1b * 2 ** 24 + arm64ChkReg(rm) * 2 ** 16 + 2 ** 15 + arm64ChkReg(ra) * 2 ** 10
    + arm64ChkReg(rn) * 2 ** 5 + arm64ChkReg(rd));
/** `mul Rd, Rn, Rm` = `madd Rd, Rn, Rm, xzr`。 */
export const mul = (sf, rd, rn, rm) => madd(sf, rd, rn, rm, 31);

/* C4.1.5 Data-processing (2 source)：sf 0 0 1 1 0 1 0 1 1 0 Rm opcode Rn Rd */
function dp2(sf, opcode, rm, rn, rd) {
  return u32(sf * 2 ** 31 + 0xd6 * 2 ** 21 + arm64ChkReg(rm) * 2 ** 16
    + chkU(opcode, 6, 'opcode') * 2 ** 10 + arm64ChkReg(rn) * 2 ** 5 + arm64ChkReg(rd));
}

export const udiv = (sf, rd, rn, rm) => dp2(sf, 0x02, rm, rn, rd);
export const sdiv = (sf, rd, rn, rm) => dp2(sf, 0x03, rm, rn, rd);
export const lslv = (sf, rd, rn, rm) => dp2(sf, 0x08, rm, rn, rd);
export const lsrv = (sf, rd, rn, rm) => dp2(sf, 0x09, rm, rn, rd);
export const asrv = (sf, rd, rn, rm) => dp2(sf, 0x0a, rm, rn, rd);

/* ---------------------------------------------------------------- 条件选择
 * C4.1.5 Conditional select：sf op 0 1 1 0 1 0 1 0 0 Rm cond op2 Rn Rd */
function csel4(sf, op, op2, rm, cond, rn, rd) {
  return u32(sf * 2 ** 31 + op * 2 ** 30 + 0xd4 * 2 ** 21 + arm64ChkReg(rm) * 2 ** 16
    + chkU(cond, 4, 'cond') * 2 ** 12 + op2 * 2 ** 10 + arm64ChkReg(rn) * 2 ** 5 + arm64ChkReg(rd));
}

export const csel = (sf, rd, rn, rm, cond) => csel4(sf, 0, 0, rm, cond, rn, rd);
export const csinc = (sf, rd, rn, rm, cond) => csel4(sf, 0, 1, rm, cond, rn, rd);
/** `cset Rd, cond` = `csinc Rd, xzr, xzr, invert(cond)` —— 条件要**取反**
 * （C6.2.72 的别名规则），取反就是最低位翻一下。 */
export const cset = (sf, rd, cond) => csinc(sf, rd, 31, 31, cond ^ 1);

/* ---------------------------------------------------------------- 取地址
 * C4.1.4 PC-rel. addressing：op immlo 1 0 0 0 0 immhi Rd
 * adrp 的立即数是**页号**的差（21 位有符号，单位 4096）。 */
function pcRel(op, imm21, rd) {
  const v = chkS(imm21, 21, 'imm21');
  const lo = v % 4;
  const hi = (v - lo) / 4;
  return u32(op * 2 ** 31 + lo * 2 ** 29 + 0x10 * 2 ** 24 + hi * 2 ** 5 + arm64ChkReg(rd));
}

export const adr = (rd, off) => pcRel(0, off, rd);
export const adrp = (rd, pages) => pcRel(1, pages, rd);

/* ---------------------------------------------------------------- 存取
 * C4.1.3 Load/store register (unsigned immediate)：
 *   size 1 1 1 0 0 1 opc imm12 Rn Rt
 * `imm12` 是**按宽度缩放**过的偏移（x 系除以 8、w 系除以 4……），所以这儿收的是
 * 字节偏移、自己除，除不尽就报错 —— 那种偏移只能走 `ldur`（下一片）。
 * opc: 00 = str, 01 = ldr（零扩展），10 = ldrs 到 64 位，11 = ldrs 到 32 位。 */
function ldstUimm(size, opc, imm12, rn, rt) {
  return u32(size * 2 ** 30 + 0x39 * 2 ** 24 + opc * 2 ** 22
    + chkU(imm12, 12, 'imm12') * 2 ** 10 + arm64ChkReg(rn) * 2 ** 5 + arm64ChkReg(rt));
}

function scaled(off, size) {
  const unit = 2 ** size;
  if (off % unit !== 0) bad(`偏移 ${off} 不是 ${unit} 的倍数（要走 ldur/stur）`);
  return off / unit;
}

/** `size` 是宽度的对数：0=byte, 1=half, 2=word, 3=doubleword。 */
export const strU = (size, rt, rn, off) => ldstUimm(size, 0, scaled(off, size), rn, rt);
export const ldrU = (size, rt, rn, off) => ldstUimm(size, 1, scaled(off, size), rn, rt);
/** 带符号扩展的加载。`to64` 为真是扩到 x，假是扩到 w。 */
export const ldrsU = (size, rt, rn, off, to64 = true) =>
  ldstUimm(size, to64 ? 2 : 3, scaled(off, size), rn, rt);

/* C4.1.3 Load/store register (immediate post/pre-indexed)：
 *   size 1 1 1 0 0 0 opc 0 imm9 idx 1 Rn Rt
 * idx: 01 = post-index, 11 = pre-index。偏移是 9 位有符号、**不缩放**。
 * 帧的开合（`stp`/`ldp` 之外）与 `str x, [sp, #-16]!` 靠这一族。 */
function ldstImm9(size, opc, imm9, idx, rn, rt) {
  return u32(size * 2 ** 30 + 0x38 * 2 ** 24 + opc * 2 ** 22
    + chkS(imm9, 9, 'imm9') * 2 ** 12 + idx * 2 ** 10 + arm64ChkReg(rn) * 2 ** 5 + arm64ChkReg(rt));
}

export const strPre = (size, rt, rn, off) => ldstImm9(size, 0, off, 3, rn, rt);
export const strPost = (size, rt, rn, off) => ldstImm9(size, 0, off, 1, rn, rt);
export const ldrPre = (size, rt, rn, off) => ldstImm9(size, 1, off, 3, rn, rt);
export const ldrPost = (size, rt, rn, off) => ldstImm9(size, 1, off, 1, rn, rt);
/** 不缩放、不改基址的那一版（`idx` 那两位是 00）。 */
export const stur = (size, rt, rn, off) => ldstImm9(size, 0, off, 0, rn, rt);
export const ldur = (size, rt, rn, off) => ldstImm9(size, 1, off, 0, rn, rt);

/* C4.1.3 Load/store register (register offset)：
 *   size 1 1 1 0 0 0 opc 1 Rm option S 1 0 Rn Rt
 * option: 011 = lsl（Rm 当 64 位用），010 = uxtw，110 = sxtw，111 = sxtx。 */
function ldstReg(size, opc, rm, option, S, rn, rt) {
  return u32(size * 2 ** 30 + 0x38 * 2 ** 24 + opc * 2 ** 22 + 2 ** 21
    + arm64ChkReg(rm) * 2 ** 16 + option * 2 ** 13 + S * 2 ** 12 + 2 ** 11
    + arm64ChkReg(rn) * 2 ** 5 + arm64ChkReg(rt));
}

export const strRegOff = (size, rt, rn, rm, option = 3, S = 0) =>
  ldstReg(size, 0, rm, option, S, rn, rt);
export const ldrRegOff = (size, rt, rn, rm, option = 3, S = 0) =>
  ldstReg(size, 1, rm, option, S, rn, rt);

/* C4.1.3 Load/store pair：opc 1 0 1 V 0 idx L imm7 Rt2 Rn Rt
 * `stp x29, x30, [sp, #-16]!` 是每个函数序言的第一条，所以这一族要有。
 * imm7 是**按宽度缩放**的 7 位有符号。 */
function ldstPair(opc, idx, L, imm7, rt2, rn, rt) {
  return u32(opc * 2 ** 30 + 0x14 * 2 ** 25 + idx * 2 ** 23 + L * 2 ** 22
    + chkS(imm7, 7, 'imm7') * 2 ** 15 + arm64ChkReg(rt2) * 2 ** 10
    + arm64ChkReg(rn) * 2 ** 5 + arm64ChkReg(rt));
}

/** `sf` 为真是 x 系（缩放 8），假是 w 系（缩放 4）。 */
function pairOff(off, sf) {
  const unit = sf ? 8 : 4;
  if (off % unit !== 0) bad(`stp/ldp 的偏移 ${off} 不是 ${unit} 的倍数`);
  return off / unit;
}

export const stp = (sf, rt, rt2, rn, off) => ldstPair(sf ? 2 : 0, 2, 0, pairOff(off, sf), rt2, rn, rt);
export const ldp = (sf, rt, rt2, rn, off) => ldstPair(sf ? 2 : 0, 2, 1, pairOff(off, sf), rt2, rn, rt);
export const stpPre = (sf, rt, rt2, rn, off) => ldstPair(sf ? 2 : 0, 3, 0, pairOff(off, sf), rt2, rn, rt);
export const ldpPost = (sf, rt, rt2, rn, off) => ldstPair(sf ? 2 : 0, 1, 1, pairOff(off, sf), rt2, rn, rt);

/* ---------------------------------------------------------------- 跳转
 * C4.1.6 Unconditional branch (immediate)：op 0 0 1 0 1 imm26
 * 立即数是**指令数**（字节偏移除以 4），相对这条指令自己。 */
function branchImm26(op, off) {
  if (off % 4 !== 0) bad(`跳转偏移 ${off} 不是 4 的倍数`);
  return u32(op * 2 ** 31 + 5 * 2 ** 26 + chkS(off / 4, 26, 'imm26'));
}

export const b = (off) => branchImm26(0, off);
export const bl = (off) => branchImm26(1, off);

/** Conditional branch：0 1 0 1 0 1 0 0 imm19 0 cond */
export function bcond(cond, off) {
  if (off % 4 !== 0) bad(`b.cond 偏移 ${off} 不是 4 的倍数`);
  return u32(0x54 * 2 ** 24 + chkS(off / 4, 19, 'imm19') * 2 ** 5 + chkU(cond, 4, 'cond'));
}

/** Compare and branch：sf 0 1 1 0 1 0 op imm19 Rt */
function cmpBranch(sf, op, off, rt) {
  if (off % 4 !== 0) bad(`cbz/cbnz 偏移 ${off} 不是 4 的倍数`);
  return u32(sf * 2 ** 31 + 0x1a * 2 ** 25 + op * 2 ** 24
    + chkS(off / 4, 19, 'imm19') * 2 ** 5 + arm64ChkReg(rt));
}

export const cbz = (sf, rt, off) => cmpBranch(sf, 0, off, rt);
export const cbnz = (sf, rt, off) => cmpBranch(sf, 1, off, rt);

/* C4.1.6 Unconditional branch (register)：1 1 0 1 0 1 1 0 opc 1 1 1 1 1 0 0 0 0 0 0 Rn 0 0 0 0 0 */
function branchReg(opc, rn) {
  return u32(0xd6 * 2 ** 24 + opc * 2 ** 21 + 0x1f * 2 ** 16 + arm64ChkReg(rn) * 2 ** 5);
}

export const br = (rn) => branchReg(0, rn);
export const blr = (rn) => branchReg(1, rn);
/** `retArm64` 默认回 x30（C6.2.219：不写寄存器就是 x30）。 */
export const retArm64 = (rn = 30) => branchReg(2, rn);

/** `nopArm64` 是 hint #0（C6.2.203）。 */
export const nopArm64 = () => 0xd503201f;

/** `svc #imm16`（C6.2.256：`1101 0100 000 imm16 00001`，第一百四十片）。
 *  Linux 的 arm64 上系统调用就是 `svc #0`：号在 x8、实参在 x0-x5、回值在 x0
 *  （失败是 `-errno`）。macOS 的 BSD 约定是另一件事（x16 + `svc #0x80`），
 *  那边我们走 libSystem，所以这一格只出 Linux 那一种。 */
export const svcArm64 = (imm = 0) => u32(0xd4 * 2 ** 24 + chkU(imm, 16, 'imm16') * 2 ** 5 + 1);

/* ================================================================ 第九刀第二片
 * 逻辑立即数、位段、单目位运算、浮点、单向屏障的存取。 */

/* ---------------------------------------------------------------- 逻辑立即数
 * C4.1.4 Logical (immediate)：sf opc 1 0 0 1 0 0 N immr imms Rn Rd
 *
 * arm64 最绕的一格：立即数不是照原样存的，存的是「**一段连着的 1**，转一下，
 * 再按某个长度重复铺满」这三件事的编码（N:immr:imms 一共 13 位，能表示 5334 个
 * 不同的 64 位值）。所以 `and x0, x1, #0xff` 编得下去，`and x0, x1, #0xff00ff` 也
 * 编得下去（重复的），`and x0, x1, #0x3ff0` 也编得下去（转过 4 位的十个 1），而
 * `and x0, x1, #0x1234` 编不下去 —— 1 分成了好几段，怎么转都凑不成一段。
 *
 * 编法（ARM 手册 J1 的 `DecodeBitMasks` 反过来）：
 *   1. 猜元素长度 e ∈ {2,4,8,16,32,64}：值必须是「每 e 位一个样」；
 *   2. 元素里必须是「若干个 1 连成一段，绕着 e 位转过某个角度」；
 *   3. imms = (那段 1 的个数 - 1) | 掩掉 e 的那几位，immr = 转的角度，N = (e === 64)。
 * 编不下去的当场报 —— 调用方该改走 movz/movk 再 and 那条路（tcc 也是这么分的）。
 */
/* 这一格里所有 64 位宽的中间量都要**按位模式**算，不能指望 `1n << 64n` 是 2^64 ——
 * 我们这个值域里的 int 是 **i64**（ADR-0005），移位的位数照硬件取模 64，于是
 * `1n << 64n === 1n`、`(1n << 64n) - 1n === 0n`。node 上跑同一份源码时它是真 BigInt，
 * 于是 mask 是 2^64-1 —— **同一份代码两种答案**。
 *
 * 踩过的那一脚（第一百四十片）：e === 64 时 mask 算成 0，`first` 于是是 0，
 * 而 `while ((x & 1n) === 0n) { x >>= 1n; rot++; }` 永远到不了头 ——
 * 装好的编译器一编「带循环的 C」（循环要 `eor` 的逻辑立即数）就在这儿转圈，
 * 而 node 上一切正常。所以：宽掩码走 `asUintN`，左移的结果一律再 `asUintN(64)` 归一。 */
const ONES64 = BigInt.asUintN(64, -1n);
/** n 个 1（n 可以是 64）。 */
const onesOf = (n) => (n >= 64n ? ONES64 : (1n << n) - 1n);
/** 归一到 64 位的无符号位模式：两条腿上都是同一个值。 */
const u64 = (x) => BigInt.asUintN(64, x);

export function bitmaskImm(sf, value) {
  const width = sf ? 64n : 32n;
  let v = BigInt.asUintN(Number(width), BigInt(value));
  if (v === 0n || v === BigInt.asUintN(Number(width), -1n)) {
    bad(`逻辑立即数 0x${v.toString(16)} 全 0 或全 1，编不了`);
  }
  for (let e = 2n; e <= width; e *= 2n) {
    /* 一、每 e 位一个样吗 */
    const mask = onesOf(e);
    const first = v & mask;
    let uniform = true;
    for (let i = e; i < width; i += e) {
      if (((v >> i) & mask) !== first) { uniform = false; break; }
    }
    if (!uniform) continue;
    /* 二、元素里是不是「一段 1 转过某个角度」。先数低位有几个 0（那就是转角），
     * 转回去之后必须是 0b0…011…1 那个形状。 */
    let rot = 0n;
    let x = first;
    while ((x & 1n) === 0n) { x >>= 1n; rot++; }
    /* 转回来：把低位那段 1 挪到最低位。`x` 现在最低位是 1。 */
    let ones = 0n;
    let y = x;
    while ((y & 1n) === 1n) { y >>= 1n; ones++; }
    if (y !== 0n) {
      /* 低位那段 1 上面还有 1 —— 只有「1 在两头、0 在中间」这一种还有救：
       * 那说明这一段 1 是**绕过元素边界**的，转角要从高位那头数。 */
      let hi = 0n;
      let bit = e - 1n;
      while (bit >= 0n && ((first >> bit) & 1n) === 1n) { hi++; bit--; }
      let lo = 0n;
      let z = first;
      while ((z & 1n) === 1n) { z >>= 1n; lo++; }
      if (hi === 0n || lo === 0n) continue;
      /* 该长什么样：高 hi 位全 1、低 lo 位全 1、中间全 0。不是这个形状就换下一个 e。
       * 左移的结果过一次 `u64` —— e === 64 时 `onesOf(hi) << (e - hi)` 会漫过 64 位，
       * 在 i64 上回卷、在 node 上不回卷，归一之后两条腿才是同一个值。 */
      const want = u64(onesOf(hi) << (e - hi)) | onesOf(lo);
      if (first !== want) continue;
      ones = hi + lo;
      rot = e - hi;
    }
    if (ones === 0n || ones >= e) continue;
    const N = e === 64n ? 1 : 0;
    /* imms 的高几位是 `NOT e` 的那串 1（手册里管这叫 "the element size is encoded
     * in the upper bits of imms"）。 */
    const immsHi = e === 64n ? 0n : (0x7en & ~((e * 2n) - 1n)) & 0x3fn;
    const imms = Number(immsHi | (ones - 1n));
    /* `immr` 是**右**转的角度（手册 J1 的 `DecodeBitMasks` 里是 `ROR(welem, R)`），
     * 而上面数出来的 `rot` 是「那段 1 从最低位往左挪了多少」—— 两者互为补角。
     * 这一格错过一次：`and x0, x1, #0x8000000000000000` 编成了 immr=63，llvm 说是 1。 */
    const immr = Number((e - (rot % e)) % e);
    return { N, immr, imms };
  }
  return bad(`逻辑立即数 0x${v.toString(16)} 不是「一段 1 转一下再铺满」的形状`);
}

function logicImmRaw(sf, opc, N, immr, imms, rn, rd) {
  return u32(sf * 2 ** 31 + opc * 2 ** 29 + 0x24 * 2 ** 23 + N * 2 ** 22
    + chkU(immr, 6, 'immr') * 2 ** 16 + chkU(imms, 6, 'imms') * 2 ** 10
    + arm64ChkReg(rn) * 2 ** 5 + arm64ChkReg(rd));
}

function logicImm(sf, opc, rd, rn, value) {
  /* w 系不会走出 N=1 —— 上面的循环在 width=32 时最大只试到 e=32，而 N 只在 e=64
   * 时是 1。所以「w 系用了 N=1」这件事根本不可能发生，不必再挡一道。 */
  const m = bitmaskImm(sf, value);
  return logicImmRaw(sf, opc, m.N, m.immr, m.imms, rn, rd);
}

export const andImm = (sf, rd, rn, v) => logicImm(sf, 0, rd, rn, v);
export const orrImm = (sf, rd, rn, v) => logicImm(sf, 1, rd, rn, v);
export const eorImm = (sf, rd, rn, v) => logicImm(sf, 2, rd, rn, v);
export const andsImm = (sf, rd, rn, v) => logicImm(sf, 3, rd, rn, v);
/** `tst Rn, #imm` = `ands xzr, Rn, #imm`。 */
export const tstImm = (sf, rn, v) => andsImm(sf, 31, rn, v);

/* ---------------------------------------------------------------- 位段
 * C4.1.4 Bitfield：sf opc 1 0 0 1 1 0 N immr imms Rn Rd
 * opc: 00 sbfm, 01 bfm, 10 ubfm。`lsl`/`lsr`/`asr` 的立即数版、`sxtb`/`uxth`、
 * `ubfx`/`sbfx`/`bfi` 全是这三条的别名 —— 别名多是因为 arm64 根本没有独立的
 * 「移位立即数」指令。 */
function bfm(sf, opc, immr, imms, rn, rd) {
  return u32(sf * 2 ** 31 + opc * 2 ** 29 + 0x26 * 2 ** 23 + sf * 2 ** 22
    + chkU(immr, 6, 'immr') * 2 ** 16 + chkU(imms, 6, 'imms') * 2 ** 10
    + arm64ChkReg(rn) * 2 ** 5 + arm64ChkReg(rd));
}

export const sbfm = (sf, rd, rn, immr, imms) => bfm(sf, 0, immr, imms, rn, rd);
export const bfmIns = (sf, rd, rn, immr, imms) => bfm(sf, 1, immr, imms, rn, rd);
export const ubfm = (sf, rd, rn, immr, imms) => bfm(sf, 2, immr, imms, rn, rd);

/** 查移位量合不合法，回的是**这一档的宽度**（32 或 64）—— 三条别名都要用它算 immr/imms。 */
function shWidth(sf, n) {
  const w = sf ? 64 : 32;
  if (!Number.isInteger(n) || n < 0 || n >= w) bad(`移位 ${n} 不在 0-${w - 1}`);
  return w;
}

/** `lsl Rd, Rn, #n` = `ubfm Rd, Rn, #(-n mod w), #(w-1-n)`（C6.2.178 的别名）。 */
export function lslImm(sf, rd, rn, n) {
  const w = shWidth(sf, n);
  return ubfm(sf, rd, rn, (w - n) % w, w - 1 - n);
}
/** `lsr Rd, Rn, #n` = `ubfm Rd, Rn, #n, #(w-1)`。 */
export function lsrImm(sf, rd, rn, n) {
  const w = shWidth(sf, n);
  return ubfm(sf, rd, rn, n, w - 1);
}
/** `asr Rd, Rn, #n` = `sbfm Rd, Rn, #n, #(w-1)`。 */
export function asrImm(sf, rd, rn, n) {
  const w = shWidth(sf, n);
  return sbfm(sf, rd, rn, n, w - 1);
}
/** `ubfx Rd, Rn, #lsb, #width` = `ubfm Rd, Rn, #lsb, #(lsb+width-1)`。 */
export function ubfx(sf, rd, rn, lsb, width) {
  chkField(sf, lsb, width);
  return ubfm(sf, rd, rn, lsb, lsb + width - 1);
}
export function sbfx(sf, rd, rn, lsb, width) {
  chkField(sf, lsb, width);
  return sbfm(sf, rd, rn, lsb, lsb + width - 1);
}
/** `bfi Rd, Rn, #lsb, #width` = `bfm Rd, Rn, #(-lsb mod w), #(width-1)`。 */
export function bfi(sf, rd, rn, lsb, width) {
  const w = chkField(sf, lsb, width);
  return bfmIns(sf, rd, rn, (w - lsb) % w, width - 1);
}

/** 取/插一段的两个参数：段要在寄存器里放得下，且宽度至少 1。 */
function chkField(sf, lsb, width) {
  const w = sf ? 64 : 32;
  if (!Number.isInteger(lsb) || lsb < 0 || lsb >= w) bad(`位段起点 ${lsb} 不在 0-${w - 1}`);
  if (!Number.isInteger(width) || width < 1 || lsb + width > w) {
    bad(`位段 [${lsb}, +${width}) 出了 ${w} 位`);
  }
  return w;
}
/* 符号/零扩展：`sxtb w0, w1` 就是 `sbfm w0, w1, #0, #7`。注意 `sxtb`/`sxth` 的目标
 * 可以是 x 系（源永远按 w 系读），`uxtb`/`uxth` 只有 w 系（x 系那两个写起来是
 * `and Rd, Rn, #0xff`，因为高 32 位本来就是 0）。 */
export const sxtb = (sf, rd, rn) => sbfm(sf, rd, rn, 0, 7);
export const sxth = (sf, rd, rn) => sbfm(sf, rd, rn, 0, 15);
export const sxtw = (rd, rn) => sbfm(1, rd, rn, 0, 31);
export const uxtb = (rd, rn) => ubfm(0, rd, rn, 0, 7);
export const uxth = (rd, rn) => ubfm(0, rd, rn, 0, 15);

/** `extr Rd, Rn, Rm, #lsb`（C4.1.4 Extract）：两个寄存器接起来取一段，
 * `ror Rd, Rn, #n` 就是它的 Rn===Rm 那一种。 */
export function extr(sf, rd, rn, rm, lsb) {
  return u32(sf * 2 ** 31 + 0x27 * 2 ** 23 + sf * 2 ** 22 + arm64ChkReg(rm) * 2 ** 16
    + chkU(lsb, 6, 'lsb') * 2 ** 10 + arm64ChkReg(rn) * 2 ** 5 + arm64ChkReg(rd));
}
export const rorImm = (sf, rd, rn, n) => extr(sf, rd, rn, rn, n);

/* ---------------------------------------------------------------- 单目位运算
 * C4.1.5 Data-processing (1 source)：sf 1 0 1 1 0 1 0 1 1 0 0 0 0 0 opcode(6) Rn Rd */
function dp1(sf, opcode, rn, rd) {
  return u32(sf * 2 ** 31 + 0x2d6 * 2 ** 21 + chkU(opcode, 6, 'opcode') * 2 ** 10
    + arm64ChkReg(rn) * 2 ** 5 + arm64ChkReg(rd));
}

export const rbit = (sf, rd, rn) => dp1(sf, 0x00, rn, rd);
export const rev16 = (sf, rd, rn) => dp1(sf, 0x01, rn, rd);
/** `rev` 的 opcode 随宽度变：w 系是 2（32 位翻转），x 系是 3。 */
export const rev = (sf, rd, rn) => dp1(sf, sf ? 0x03 : 0x02, rn, rd);
export const rev32 = (rd, rn) => dp1(1, 0x02, rn, rd);
export const clz = (sf, rd, rn) => dp1(sf, 0x04, rn, rd);
export const cls = (sf, rd, rn) => dp1(sf, 0x05, rn, rd);

/* ---------------------------------------------------------------- 浮点
 * `type` 这两位是宽度：00 单精度、01 双精度（10 保留、11 半精度）。
 * 下面所有函数的第一个参数 `dbl` 就是它（真 = double）。
 *
 * C4.1.9 Floating-point data-processing (2 source)：
 *   0 0 0 1 1 1 1 0 type 1 Rm opcode(4) 1 0 Rn Rd */
function fp2(dbl, opcode, rm, rn, rd) {
  return u32(0x1e * 2 ** 24 + (dbl ? 1 : 0) * 2 ** 22 + 2 ** 21 + arm64ChkReg(rm) * 2 ** 16
    + chkU(opcode, 4, 'opcode') * 2 ** 12 + 2 ** 11 + arm64ChkReg(rn) * 2 ** 5 + arm64ChkReg(rd));
}

export const fmul = (dbl, rd, rn, rm) => fp2(dbl, 0x0, rm, rn, rd);
export const fdiv = (dbl, rd, rn, rm) => fp2(dbl, 0x1, rm, rn, rd);
export const fadd = (dbl, rd, rn, rm) => fp2(dbl, 0x2, rm, rn, rd);
export const fsub = (dbl, rd, rn, rm) => fp2(dbl, 0x3, rm, rn, rd);
export const fmax = (dbl, rd, rn, rm) => fp2(dbl, 0x4, rm, rn, rd);
export const fmin = (dbl, rd, rn, rm) => fp2(dbl, 0x5, rm, rn, rd);
export const fnmul = (dbl, rd, rn, rm) => fp2(dbl, 0x8, rm, rn, rd);

/* Floating-point data-processing (1 source)：
 *   0 0 0 1 1 1 1 0 type 1 opcode(6) 1 0 0 0 0 Rn Rd */
function fp1(dbl, opcode, rn, rd) {
  return u32(0x1e * 2 ** 24 + (dbl ? 1 : 0) * 2 ** 22 + 2 ** 21
    + chkU(opcode, 6, 'opcode') * 2 ** 15 + 0x10 * 2 ** 10
    + arm64ChkReg(rn) * 2 ** 5 + arm64ChkReg(rd));
}

export const fmovFp = (dbl, rd, rn) => fp1(dbl, 0x00, rn, rd);
export const fabsFp = (dbl, rd, rn) => fp1(dbl, 0x01, rn, rd);
export const fneg = (dbl, rd, rn) => fp1(dbl, 0x02, rn, rd);
export const fsqrt = (dbl, rd, rn) => fp1(dbl, 0x03, rn, rd);
/** `fcvt d, s`：源的宽度进 `type`、目标的宽度进 opcode 的低两位（00=S、01=D）。 */
export const fcvtSD = (rd, rn) => fp1(false, 0x05, rn, rd);   // s -> d
export const fcvtDS = (rd, rn) => fp1(true, 0x04, rn, rd);    // d -> s

/* Floating-point compare：0 0 0 1 1 1 1 0 type 1 Rm op(2) 1 0 0 0 Rn opcode2(5) */
function fcmpRaw(dbl, rm, op, opcode2, rn) {
  return u32(0x1e * 2 ** 24 + (dbl ? 1 : 0) * 2 ** 22 + 2 ** 21 + rm * 2 ** 16
    + op * 2 ** 14 + 2 ** 13 + arm64ChkReg(rn) * 2 ** 5 + chkU(opcode2, 5, 'opcode2'));
}

export const fcmpArm64 = (dbl, rn, rm) => fcmpRaw(dbl, arm64ChkReg(rm), 0, 0x00, rn);
export const fcmpZero = (dbl, rn) => fcmpRaw(dbl, 0, 0, 0x08, rn);
export const fcmpe = (dbl, rn, rm) => fcmpRaw(dbl, arm64ChkReg(rm), 0, 0x10, rn);

/* Conversion between floating-point and integer：
 *   sf 0 0 1 1 1 1 0 type 1 rmode(2) opcode(3) 0 0 0 0 0 0 Rn Rd */
function fpInt(sf, dbl, rmode, opcode, rn, rd) {
  return u32(sf * 2 ** 31 + 0x1e * 2 ** 24 + (dbl ? 1 : 0) * 2 ** 22 + 2 ** 21
    + rmode * 2 ** 19 + opcode * 2 ** 16 + arm64ChkReg(rn) * 2 ** 5 + arm64ChkReg(rd));
}

/** 有符号整数 -> 浮点。`sf` 是**源**（整数）那一头的宽度。 */
export const scvtf = (sf, dbl, rd, rn) => fpInt(sf, dbl, 0, 2, rn, rd);
export const ucvtf = (sf, dbl, rd, rn) => fpInt(sf, dbl, 0, 3, rn, rd);
/** 浮点 -> 整数，**向零取整**（C 的强制转换就是这一种）。`sf` 是目标那一头。 */
export const fcvtzs = (sf, dbl, rd, rn) => fpInt(sf, dbl, 3, 0, rn, rd);
export const fcvtzu = (sf, dbl, rd, rn) => fpInt(sf, dbl, 3, 1, rn, rd);
/** 位搬家（不改位）：`fmov x0, d0` 与 `fmov d0, x0`。 */
export const fmovToInt = (sf, dbl, rd, rn) => fpInt(sf, dbl, 0, 6, rn, rd);
export const fmovFromInt = (sf, dbl, rd, rn) => fpInt(sf, dbl, 0, 7, rn, rd);

/* 浮点的存取：与整数那一族同一个编码，多一个 V 位（bit 26）。
 * `size` 照旧是宽度的对数（2 = s、3 = d）。 */
function ldstFpUimm(size, opc, imm12, rn, rt) {
  return u32(size * 2 ** 30 + 0x3d * 2 ** 24 + opc * 2 ** 22
    + chkU(imm12, 12, 'imm12') * 2 ** 10 + arm64ChkReg(rn) * 2 ** 5 + arm64ChkReg(rt));
}

export const strFpU = (size, rt, rn, off) => ldstFpUimm(size, 0, scaled(off, size), rn, rt);
export const ldrFpU = (size, rt, rn, off) => ldstFpUimm(size, 1, scaled(off, size), rn, rt);

/* ---------------------------------------------------------------- 带屏障的存取
 * C4.1.3 Load/store exclusive 里 `o2`=1、`o1`=0、`o0`=1 的那两条（单向屏障）：
 *   size 0 0 1 0 0 0 o2 L o1 (1)(1)(1)(1)(1) o0 (1)(1)(1)(1)(1) Rn Rt
 * `o2`（bit 23）是「带 acquire/release 语义」那一格 —— 漏了它编出来就是普通的
 * `ldxr`/`stxr`（对着 llvm 验的时候正是这一位差了）。
 * `_Atomic` 的读写要靠它们（第八刀还没走到原子那一片，但编码先备好）。 */
function ldstAcqRel(size, L, rn, rt) {
  return u32(size * 2 ** 30 + 0x08 * 2 ** 24 + 2 ** 23 + L * 2 ** 22 + 0x1f * 2 ** 16
    + 2 ** 15 + 0x1f * 2 ** 10 + arm64ChkReg(rn) * 2 ** 5 + arm64ChkReg(rt));
}

export const ldar = (size, rt, rn) => ldstAcqRel(size, 1, rn, rt);
export const stlr = (size, rt, rn) => ldstAcqRel(size, 0, rn, rt);

/** 数据/指令屏障（C6.2.79/C6.2.114）。`dmb ish` 是 0xd5033bbf 那一条。 */
export const dmbIsh = () => 0xd5033bbf;
export const dsbIsh = () => 0xd5033b9f;
export const isb = () => 0xd5033fdf;

