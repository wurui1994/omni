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

function chkReg(r) {
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
    + chkReg(rn) * 2 ** 5 + chkReg(rd));
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
    + chkU(imm16, 16, 'imm16') * 2 ** 5 + chkReg(rd));
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
    + shift * 2 ** 22 + chkReg(rm) * 2 ** 16 + chkU(imm6, 6, 'imm6') * 2 ** 10
    + chkReg(rn) * 2 ** 5 + chkReg(rd));
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
    + chkReg(rm) * 2 ** 16 + chkU(imm6, 6, 'imm6') * 2 ** 10
    + chkReg(rn) * 2 ** 5 + chkReg(rd));
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
  u32(sf * 2 ** 31 + 0x1b * 2 ** 24 + chkReg(rm) * 2 ** 16 + chkReg(ra) * 2 ** 10
    + chkReg(rn) * 2 ** 5 + chkReg(rd));
export const msub = (sf, rd, rn, rm, ra) =>
  u32(sf * 2 ** 31 + 0x1b * 2 ** 24 + chkReg(rm) * 2 ** 16 + 2 ** 15 + chkReg(ra) * 2 ** 10
    + chkReg(rn) * 2 ** 5 + chkReg(rd));
/** `mul Rd, Rn, Rm` = `madd Rd, Rn, Rm, xzr`。 */
export const mul = (sf, rd, rn, rm) => madd(sf, rd, rn, rm, 31);

/* C4.1.5 Data-processing (2 source)：sf 0 0 1 1 0 1 0 1 1 0 Rm opcode Rn Rd */
function dp2(sf, opcode, rm, rn, rd) {
  return u32(sf * 2 ** 31 + 0xd6 * 2 ** 21 + chkReg(rm) * 2 ** 16
    + chkU(opcode, 6, 'opcode') * 2 ** 10 + chkReg(rn) * 2 ** 5 + chkReg(rd));
}

export const udiv = (sf, rd, rn, rm) => dp2(sf, 0x02, rm, rn, rd);
export const sdiv = (sf, rd, rn, rm) => dp2(sf, 0x03, rm, rn, rd);
export const lslv = (sf, rd, rn, rm) => dp2(sf, 0x08, rm, rn, rd);
export const lsrv = (sf, rd, rn, rm) => dp2(sf, 0x09, rm, rn, rd);
export const asrv = (sf, rd, rn, rm) => dp2(sf, 0x0a, rm, rn, rd);

/* ---------------------------------------------------------------- 条件选择
 * C4.1.5 Conditional select：sf op 0 1 1 0 1 0 1 0 0 Rm cond op2 Rn Rd */
function csel4(sf, op, op2, rm, cond, rn, rd) {
  return u32(sf * 2 ** 31 + op * 2 ** 30 + 0xd4 * 2 ** 21 + chkReg(rm) * 2 ** 16
    + chkU(cond, 4, 'cond') * 2 ** 12 + op2 * 2 ** 10 + chkReg(rn) * 2 ** 5 + chkReg(rd));
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
  return u32(op * 2 ** 31 + lo * 2 ** 29 + 0x10 * 2 ** 24 + hi * 2 ** 5 + chkReg(rd));
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
    + chkU(imm12, 12, 'imm12') * 2 ** 10 + chkReg(rn) * 2 ** 5 + chkReg(rt));
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
    + chkS(imm9, 9, 'imm9') * 2 ** 12 + idx * 2 ** 10 + chkReg(rn) * 2 ** 5 + chkReg(rt));
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
    + chkReg(rm) * 2 ** 16 + option * 2 ** 13 + S * 2 ** 12 + 2 ** 11
    + chkReg(rn) * 2 ** 5 + chkReg(rt));
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
    + chkS(imm7, 7, 'imm7') * 2 ** 15 + chkReg(rt2) * 2 ** 10
    + chkReg(rn) * 2 ** 5 + chkReg(rt));
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
    + chkS(off / 4, 19, 'imm19') * 2 ** 5 + chkReg(rt));
}

export const cbz = (sf, rt, off) => cmpBranch(sf, 0, off, rt);
export const cbnz = (sf, rt, off) => cmpBranch(sf, 1, off, rt);

/* C4.1.6 Unconditional branch (register)：1 1 0 1 0 1 1 0 opc 1 1 1 1 1 0 0 0 0 0 0 Rn 0 0 0 0 0 */
function branchReg(opc, rn) {
  return u32(0xd6 * 2 ** 24 + opc * 2 ** 21 + 0x1f * 2 ** 16 + chkReg(rn) * 2 ** 5);
}

export const br = (rn) => branchReg(0, rn);
export const blr = (rn) => branchReg(1, rn);
/** `ret` 默认回 x30（C6.2.219：不写寄存器就是 x30）。 */
export const ret = (rn = 30) => branchReg(2, rn);

/** `nop` 是 hint #0（C6.2.203）。 */
export const nop = () => 0xd503201f;
