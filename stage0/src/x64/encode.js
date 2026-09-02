/* x86_64 的编码器 —— ADR-0017 第 11 步「x86_64 同两步」的第一步，第九刀第十二片。
 *
 * 与 arm64 那一侧（`../arm64/encode.js`）同一个口径：**纯函数**，一条指令进、字节出，
 * 编不下去当场报错，一格都不许悄悄截断。验法也同一个 —— 对着 `llvm-mc -triple=x86_64`。
 *
 * 与 arm64 不同的三件事，决定了这个文件的形状
 * ------------------------------------------
 * 1. **指令是变长的**，所以返回的是**字节数组**而不是一个 32 位字。arm64 那边
 *    「一条 = 一个 u32」的便利在这里没有。
 * 2. **一族运算共用一个三位的 `/digit`**。`add/or/adc/sbb/and/sub/xor/cmp` 在手册里
 *    就是一张表（Vol.2 的 `Table B-13`：`opcode = 基 + digit * 8`），
 *    所以这里也写成一张表加四个入口（`aluRR`/`aluRI`/`aluRM`/`aluMR`），
 *    而不是三十二个各写一遍的函数。写成三十二个的下场是「改一条忘八条」。
 * 3. **寄存器号高一位在前缀里**。r8-r15 的第四位藏在 REX 的 R/X/B 三格上，
 *    而 REX 又必须在操作码**之前**。于是「先算完 modrm 再决定前缀」是这一层的固定次序。
 *
 * 只做整数那一档：搬、算、比、跳、调、存取、宽度转换。SSE（浮点）是下一片。
 */

import { OmniError } from '../source/diag.js';

/** 寄存器号：rax rcx rdx rbx rsp rbp rsi rdi r8..r15。手册的次序，不是字母序。 */
export const REG = {
  rax: 0, rcx: 1, rdx: 2, rbx: 3, rsp: 4, rbp: 5, rsi: 6, rdi: 7,
  r8: 8, r9: 9, r10: 10, r11: 11, r12: 12, r13: 13, r14: 14, r15: 15,
};

/** `add/or/adc/sbb/and/sub/xor/cmp` 的三位 `/digit`。手册里这一族就是这张表。 */
export const ALU = {
  add: 0, or: 1, adc: 2, sbb: 3, and: 4, sub: 5, xor: 6, cmp: 7,
};

/** 条件码（`jcc`/`setcc`/`cmovcc` 共用的低四位）。`l/le/g/ge` 是有符号那一套。 */
export const CC = {
  o: 0x0, no: 0x1, b: 0x2, ae: 0x3, e: 0x4, ne: 0x5, be: 0x6, a: 0x7,
  s: 0x8, ns: 0x9, p: 0xa, np: 0xb, l: 0xc, ge: 0xd, le: 0xe, g: 0xf,
};

/** `shl/shr/sar` 的 `/digit`（`C1`/`D3` 那一族）。 */
export const SH = { shl: 4, shr: 5, sar: 7 };

function chkReg(r) {
  if (!Number.isInteger(r) || r < 0 || r > 15) throw new OmniError(`x64: 寄存器号 ${r} 越界`);
  return r;
}

function chkSize(size) {
  if (size !== 1 && size !== 2 && size !== 4 && size !== 8) {
    throw new OmniError(`x64: 操作数宽度 ${size} 不是 1/2/4/8`);
  }
  return size;
}

function chkDigit(d) {
  if (!Number.isInteger(d) || d < 0 || d > 7) throw new OmniError(`x64: /digit ${d} 越界`);
  return d;
}

function chkCC(cc) {
  if (!Number.isInteger(cc) || cc < 0 || cc > 15) throw new OmniError(`x64: 条件码 ${cc} 越界`);
  return cc;
}

/* ---------------------------------------------------------------- 立即数
 * 一律用除法与取模拆字节：`>>` 在 32 位的最高位上会拆出负数（arm64 那边同一条）。 */

function imm8Of(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < -128 || n > 255) throw new OmniError(`x64: imm8 装不下 ${v}`);
  return [n < 0 ? n + 256 : n];
}

function imm16Of(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < -32768 || n > 65535) {
    throw new OmniError(`x64: imm16 装不下 ${v}`);
  }
  const u = n < 0 ? n + 65536 : n;
  return [u % 256, Math.floor(u / 256)];
}

function imm32Of(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < -(2 ** 31) || n > 2 ** 32 - 1) {
    throw new OmniError(`x64: imm32 装不下 ${v}`);
  }
  let u = n < 0 ? n + 2 ** 32 : n;
  const out = [];
  for (let i = 0; i < 4; i++) { out.push(u % 256); u = Math.floor(u / 256); }
  return out;
}

function imm64Of(v) {
  let u = BigInt.asUintN(64, BigInt(v));
  const out = [];
  for (let i = 0; i < 8; i++) { out.push(Number(u % 256n)); u /= 256n; }
  return out;
}

/** 装得进有符号一字节吗 —— `add rax, 1` 这一族的短形式全靠这个判断。 */
function fitsI8(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= -128 && n <= 127;
}

/* ---------------------------------------------------------------- 前缀与 ModRM */

/**
 * REX 前缀。`w` 是 64 位操作数，`r`/`x`/`b` 是三个寄存器号的第四位。
 *
 * 返回空数组表示「不需要」。八位操作数那一档有个坑：`spl/bpl/sil/dil`（4-7 号的低字节）
 * **必须**有 REX 才能表示，没有 REX 的话同一格编码指的是 `ah/ch/dh/bh`。
 * 所以八位那一族要把 `force` 打上。
 */
function rex(w, r, x, b, force) {
  const v = 0x40 + (w ? 8 : 0) + (r ? 4 : 0) + (x ? 2 : 0) + (b ? 1 : 0);
  if (v === 0x40 && force !== true) return [];
  return [v];
}

/** 操作数宽度决定的前缀：16 位要 `66`，64 位要 REX.W。 */
function sizePrefix(size) {
  return size === 2 ? [0x66] : [];
}

function modrm(mod, reg, rm) {
  return mod * 64 + (reg % 8) * 8 + (rm % 8);
}

/**
 * 内存操作数 `[base + disp]` 的 ModRM（加上必要的 SIB 与位移）。
 *
 * 三处不能想当然的地方，都是手册里的特例：
 *  - `rsp`/`r12` 当基址时 `rm=100` 被 SIB 占了，必须补一个 SIB 字节（index=100 表示
 *    「没有变址」，base 照填）；
 *  - `rbp`/`r13` 当基址时 `mod=00` 被「RIP 相对」占了，所以哪怕位移是 0 也得写 `mod=01`
 *    加一个 0 字节；
 *  - 位移装得下一字节就用一字节 —— 这不是省字节的小聪明，是 llvm 也这么编，
 *    不这么编就对不上账。
 */
function memOperand(reg, base, disp) {
  chkReg(base);
  const low = base % 8;
  const needSib = low === 4;
  const d = Number(disp);
  if (!Number.isInteger(d)) throw new OmniError(`x64: 位移 ${disp} 不是整数`);
  let mod;
  let dispBytes;
  if (d === 0 && low !== 5) { mod = 0; dispBytes = []; }
  else if (fitsI8(d)) { mod = 1; dispBytes = imm8Of(d); }
  else { mod = 2; dispBytes = imm32Of(d); }
  const out = [modrm(mod, reg, base)];
  if (needSib) out.push(modrm(0, 4, base));   // scale=00 index=100（无）base=低三位
  return [...out, ...dispBytes];
}

/* ---------------------------------------------------------------- 搬 */

/** `mov r64, imm64`（`movabs`）。48+B B8+r 加八个字节。 */
export function movAbs(dst, imm) {
  chkReg(dst);
  return [...rex(true, false, false, dst > 7, false), 0xb8 + (dst % 8), ...imm64Of(imm)];
}

/**
 * `mov r, imm`。
 *
 * 两种形式，界线在**宽度**上：
 *  - 32 位及以下走 `B8+r`（八位是 `B0+r`）—— 操作码里带寄存器号，比 ModRM 那版短一字节；
 *  - 64 位走 `C7 /0` 加一个**符号扩展**的四字节立即数。装不进四字节的要走 `movAbs`。
 *
 * 这不是可选的偏好：llvm 就是这么挑的，不跟着就对不上账（这一格错过一次，
 * 三条用例一齐红 —— 我们发的 `C7` 是合法的、也跑得对，只是与汇编器出来的字节不同）。
 */
export function movRI(size, dst, imm) {
  chkSize(size);
  chkReg(dst);
  const force = size === 1 && dst >= 4 && dst <= 7;
  if (size === 8) {
    return [...rex(true, false, false, dst > 7, false), 0xc7, modrm(3, 0, dst), ...imm32Of(imm)];
  }
  return [
    ...sizePrefix(size),
    ...rex(false, false, false, dst > 7, force),
    (size === 1 ? 0xb0 : 0xb8) + (dst % 8), ...immOf(size, imm),
  ];
}

function immOf(size, imm) {
  if (size === 1) return imm8Of(imm);
  if (size === 2) return imm16Of(imm);
  return imm32Of(imm);
}

/** `mov dst, src`（都是寄存器）。用 `89`（r/m ← r）—— llvm 也用这一个方向。 */
export function movRR(size, dst, src) {
  chkSize(size);
  chkReg(dst);
  chkReg(src);
  const op = size === 1 ? 0x88 : 0x89;
  const force = size === 1 && ((dst >= 4 && dst <= 7) || (src >= 4 && src <= 7));
  return [
    ...sizePrefix(size),
    ...rex(size === 8, src > 7, false, dst > 7, force),
    op, modrm(3, src, dst),
  ];
}

/** `mov reg, [base + disp]`（加载，`8B`）。 */
export function movRM(size, dst, base, disp) {
  chkSize(size);
  chkReg(dst);
  const op = size === 1 ? 0x8a : 0x8b;
  const force = size === 1 && dst >= 4 && dst <= 7;
  return [
    ...sizePrefix(size),
    ...rex(size === 8, dst > 7, false, base > 7, force),
    op, ...memOperand(dst, base, disp),
  ];
}

/** `mov [base + disp], reg`（存，`89`）。 */
export function movMR(size, base, disp, src) {
  chkSize(size);
  chkReg(src);
  const op = size === 1 ? 0x88 : 0x89;
  const force = size === 1 && src >= 4 && src <= 7;
  return [
    ...sizePrefix(size),
    ...rex(size === 8, src > 7, false, base > 7, force),
    op, ...memOperand(src, base, disp),
  ];
}

/** `lea reg, [base + disp]`。取址，不访存 —— 算「基址加偏移」时比 `mov`+`add` 短一条。 */
export function lea(size, dst, base, disp) {
  if (size !== 4 && size !== 8) throw new OmniError('x64: lea 只有 32/64 位');
  chkReg(dst);
  return [
    ...rex(size === 8, dst > 7, false, base > 7, false),
    0x8d, ...memOperand(dst, base, disp),
  ];
}

/* ---------------------------------------------------------------- 宽度转换 */

/** `movzx dst, r/m8|16`（`0F B6`/`0F B7`）。目标是 32 位就够 —— 高 32 位天然清零。 */
export function movzx(dstSize, srcSize, dst, src) {
  if (srcSize !== 1 && srcSize !== 2) throw new OmniError('x64: movzx 的源只有 8/16 位');
  if (dstSize !== 4 && dstSize !== 8) throw new OmniError('x64: movzx 的目标只有 32/64 位');
  chkReg(dst);
  chkReg(src);
  const force = srcSize === 1 && src >= 4 && src <= 7;
  return [
    ...rex(dstSize === 8, dst > 7, false, src > 7, force),
    0x0f, srcSize === 1 ? 0xb6 : 0xb7, modrm(3, dst, src),
  ];
}

/** `movsx dst, r/m8|16`（`0F BE`/`0F BF`）与 `movsxd dst, r/m32`（`63`）。 */
export function movsx(dstSize, srcSize, dst, src) {
  if (dstSize !== 4 && dstSize !== 8) throw new OmniError('x64: movsx 的目标只有 32/64 位');
  chkReg(dst);
  chkReg(src);
  if (srcSize === 4) {
    if (dstSize !== 8) throw new OmniError('x64: movsxd 的目标只有 64 位');
    return [...rex(true, dst > 7, false, src > 7, false), 0x63, modrm(3, dst, src)];
  }
  if (srcSize !== 1 && srcSize !== 2) throw new OmniError('x64: movsx 的源只有 8/16/32 位');
  const force = srcSize === 1 && src >= 4 && src <= 7;
  return [
    ...rex(dstSize === 8, dst > 7, false, src > 7, force),
    0x0f, srcSize === 1 ? 0xbe : 0xbf, modrm(3, dst, src),
  ];
}

/* ---------------------------------------------------------------- 算
 * 这一族的四个入口。`op` 取 `ALU.*` —— 手册里的 `/digit`，也是操作码的步长。 */

/** `<op> dst, src`（都是寄存器）。基码 `01`：r/m ← r/m op r。 */
export function aluRR(op, size, dst, src) {
  chkDigit(op);
  chkSize(size);
  chkReg(dst);
  chkReg(src);
  const base = size === 1 ? 0x00 : 0x01;
  const force = size === 1 && ((dst >= 4 && dst <= 7) || (src >= 4 && src <= 7));
  return [
    ...sizePrefix(size),
    ...rex(size === 8, src > 7, false, dst > 7, force),
    base + op * 8, modrm(3, src, dst),
  ];
}

/**
 * `<op> dst, imm`。三种形式，按「立即数装得下多短」与「目标是不是累加器」挑：
 *  - 装得进有符号一字节：`83 /digit`（八位操作数那一档是 `80 /digit`）；
 *  - 目标是 `rax/eax/ax/al`：`05+digit*8` 那一族**短形式**（操作码里就带着累加器，
 *    省掉一个 ModRM 字节）；
 *  - 其余：`81 /digit`。
 *
 * 三条界线都不是可选的偏好，是照着 llvm 挑的 —— 不跟着就对不上账。
 */
export function aluRI(op, size, dst, imm) {
  chkDigit(op);
  chkSize(size);
  chkReg(dst);
  const force = size === 1 && dst >= 4 && dst <= 7;
  const pre = [...sizePrefix(size), ...rex(size === 8, false, false, dst > 7, force)];
  if (size === 1) {
    if (dst === REG.rax) return [...pre, 0x04 + op * 8, ...imm8Of(imm)];
    return [...pre, 0x80, modrm(3, op, dst), ...imm8Of(imm)];
  }
  if (fitsI8(imm)) return [...pre, 0x83, modrm(3, op, dst), ...imm8Of(imm)];
  if (dst === REG.rax) return [...pre, 0x05 + op * 8, ...immOf(size, imm)];
  return [...pre, 0x81, modrm(3, op, dst), ...immOf(size, imm)];
}

/** `<op> reg, [base + disp]`。基码 `03`：r ← r op r/m。 */
export function aluRM(op, size, dst, base, disp) {
  chkDigit(op);
  chkSize(size);
  chkReg(dst);
  const b = size === 1 ? 0x02 : 0x03;
  const force = size === 1 && dst >= 4 && dst <= 7;
  return [
    ...sizePrefix(size),
    ...rex(size === 8, dst > 7, false, base > 7, force),
    b + op * 8, ...memOperand(dst, base, disp),
  ];
}

/** `<op> [base + disp], reg`。 */
export function aluMR(op, size, base, disp, src) {
  chkDigit(op);
  chkSize(size);
  chkReg(src);
  const b = size === 1 ? 0x00 : 0x01;
  const force = size === 1 && src >= 4 && src <= 7;
  return [
    ...sizePrefix(size),
    ...rex(size === 8, src > 7, false, base > 7, force),
    b + op * 8, ...memOperand(src, base, disp),
  ];
}

/** `test dst, src`（`85`）。与 `cmp` 的差别：它是**按位与**，不动操作数。 */
export function testRR(size, dst, src) {
  chkSize(size);
  chkReg(dst);
  chkReg(src);
  const op = size === 1 ? 0x84 : 0x85;
  const force = size === 1 && ((dst >= 4 && dst <= 7) || (src >= 4 && src <= 7));
  return [
    ...sizePrefix(size),
    ...rex(size === 8, src > 7, false, dst > 7, force),
    op, modrm(3, src, dst),
  ];
}

/** `F7 /digit` 那一族：`not`(2) `neg`(3) `mul`(4) `imul`(5) `div`(6) `idiv`(7)。 */
function f7(size, digit, r) {
  chkSize(size);
  chkReg(r);
  const op = size === 1 ? 0xf6 : 0xf7;
  const force = size === 1 && r >= 4 && r <= 7;
  return [
    ...sizePrefix(size),
    ...rex(size === 8, false, false, r > 7, force),
    op, modrm(3, digit, r),
  ];
}

export const notR = (size, r) => f7(size, 2, r);
export const negR = (size, r) => f7(size, 3, r);
export const mulR = (size, r) => f7(size, 4, r);
export const imulR = (size, r) => f7(size, 5, r);
export const divR = (size, r) => f7(size, 6, r);
export const idivR = (size, r) => f7(size, 7, r);

/** `imul dst, src`（`0F AF`）—— 两操作数的形式，结果只取低半，够我们用。 */
export function imulRR(size, dst, src) {
  if (size !== 4 && size !== 8) throw new OmniError('x64: imul 两操作数形式只有 32/64 位');
  chkReg(dst);
  chkReg(src);
  return [...rex(size === 8, dst > 7, false, src > 7, false), 0x0f, 0xaf, modrm(3, dst, src)];
}

/** `cqo`（`48 99`）/ `cdq`（`99`）：除法前把符号铺进 rdx。少这一条，负数的除法全错。 */
export function cqo() { return [0x48, 0x99]; }
export function cdq() { return [0x99]; }

/**
 * `shl/shr/sar r, imm8`。
 *
 * 移 **1** 位有专门的 `D1 /digit`（立即数藏在操作码里），别的走 `C1 /digit`。
 * 这一格错过一次 —— 原本以为「llvm 也不用短形式」，`sarq $1, %r11` 当场打回来：
 * llvm 编的是 `49 d1 fb`，我们编的是 `49 c1 fb 01`。
 */
export function shiftRI(digit, size, r, count) {
  chkDigit(digit);
  chkSize(size);
  chkReg(r);
  const bits = size * 8;
  const n = Number(count);
  if (!Number.isInteger(n) || n < 0 || n >= bits) {
    throw new OmniError(`x64: 移 ${count} 位超过 ${bits} 位的宽度`);
  }
  const pre = [
    ...sizePrefix(size),
    ...rex(size === 8, false, false, r > 7, size === 1 && r >= 4 && r <= 7),
  ];
  if (n === 1) return [...pre, size === 1 ? 0xd0 : 0xd1, modrm(3, digit, r)];
  return [...pre, size === 1 ? 0xc0 : 0xc1, modrm(3, digit, r), ...imm8Of(n)];
}

/** `shl/shr/sar r, cl`（`D3 /digit`）。移位数只认 `cl`，这是 x86 的老规矩。 */
export function shiftRCl(digit, size, r) {
  chkDigit(digit);
  chkSize(size);
  chkReg(r);
  const op = size === 1 ? 0xd2 : 0xd3;
  return [
    ...sizePrefix(size),
    ...rex(size === 8, false, false, r > 7, size === 1 && r >= 4 && r <= 7),
    op, modrm(3, digit, r),
  ];
}

/* ---------------------------------------------------------------- 条件 */

/** `setcc r8`（`0F 90+cc`）。目标是**八位**寄存器，所以 4-7 号要 REX（见 `rex` 那段）。 */
export function setcc(cc, r) {
  chkCC(cc);
  chkReg(r);
  return [
    ...rex(false, false, false, r > 7, r >= 4 && r <= 7),
    0x0f, 0x90 + cc, modrm(3, 0, r),
  ];
}

/** `cmovcc dst, src`（`0F 40+cc`）。 */
export function cmovcc(cc, size, dst, src) {
  chkCC(cc);
  if (size !== 4 && size !== 8) throw new OmniError('x64: cmov 只有 32/64 位');
  chkReg(dst);
  chkReg(src);
  return [...rex(size === 8, dst > 7, false, src > 7, false), 0x0f, 0x40 + cc, modrm(3, dst, src)];
}

/* ---------------------------------------------------------------- 跳与调
 * 偏移是**从下一条指令算起**的（x86 的 PC 相对以指令末尾为基准，与 arm64 以本条
 * 开头为基准正好差一条指令的长度）。所以这几个入参一律是「已经减掉本条长度」的值 ——
 * 谁算这个减法，由上一层的缓冲决定，编码器只管把数放进去。 */

/** `jmp rel32`（`E9`）。 */
export function jmpRel(rel) {
  return [0xe9, ...imm32Of(rel)];
}

/** `jcc rel32`（`0F 80+cc`）。 */
export function jccRel(cc, rel) {
  chkCC(cc);
  return [0x0f, 0x80 + cc, ...imm32Of(rel)];
}

/** `call rel32`（`E8`）。 */
export function callRel(rel) {
  return [0xe8, ...imm32Of(rel)];
}

/** `call r64`（`FF /2`）与 `jmp r64`（`FF /4`）。间接调用不带 REX.W —— 64 位是默认的。 */
export function callR(r) {
  chkReg(r);
  return [...rex(false, false, false, r > 7, false), 0xff, modrm(3, 2, r)];
}

export function jmpR(r) {
  chkReg(r);
  return [...rex(false, false, false, r > 7, false), 0xff, modrm(3, 4, r)];
}

export function ret() { return [0xc3]; }
export function nop() { return [0x90]; }
export function ud2() { return [0x0f, 0x0b]; }

/** `push r64`（`50+r`）/ `pop r64`（`58+r`）。这两条不带 REX.W。 */
export function push(r) {
  chkReg(r);
  return [...rex(false, false, false, r > 7, false), 0x50 + (r % 8)];
}

export function pop(r) {
  chkReg(r);
  return [...rex(false, false, false, r > 7, false), 0x58 + (r % 8)];
}

/* ---------------------------------------------------------------- SSE（浮点）
 * 第九刀第十三片。x86_64 上的 `double`/`float` 一律走 SSE 的**标量**那一档
 * （`movsd`/`addsd`…… 的 `s` 是 scalar），x87 那一整摊不碰 —— 它是栈式的、
 * 精度还是 80 位，与 C 的 `double` 对不上（tcc 的 x86-64 后端也走 SSE）。
 *
 * 编码的形状：一个**强制前缀**（`F2` 是 double、`F3` 是 float、`66` 是打包的双精度）
 * 加 `0F` 加操作码。次序上强制前缀在 **REX 之前** —— 记反了 llvm 立刻打回来。
 */

/** xmm 寄存器号 0-15。与整数寄存器是两套，第四位一样藏在 REX 的 R/B 上。 */
export const XMM = {
  xmm0: 0, xmm1: 1, xmm2: 2, xmm3: 3, xmm4: 4, xmm5: 5, xmm6: 6, xmm7: 7,
  xmm8: 8, xmm9: 9, xmm10: 10, xmm11: 11, xmm12: 12, xmm13: 13, xmm14: 14, xmm15: 15,
};

/** 标量运算的操作码。`sd`/`ss` 只差强制前缀，所以这一张表两边共用。 */
export const FOP = { add: 0x58, mul: 0x59, sub: 0x5c, min: 0x5d, div: 0x5e, max: 0x5f, sqrt: 0x51 };

function chkXmm(r) {
  if (!Number.isInteger(r) || r < 0 || r > 15) throw new OmniError(`x64: xmm 号 ${r} 越界`);
  return r;
}

/** 前缀 + REX + `0F` + 操作码 + ModRM（寄存器直接形式）。`pre` 是 0 表示没有强制前缀。 */
function sseRR(pre, op, reg, rm, w) {
  chkXmm(reg);
  chkXmm(rm);
  return [
    ...(pre === 0 ? [] : [pre]),
    ...rex(w === true, reg > 7, false, rm > 7, false),
    0x0f, op, modrm(3, reg, rm),
  ];
}

/** 同上，但 r/m 是 `[base + disp]`。 */
function sseRM(pre, op, reg, base, disp, w) {
  chkXmm(reg);
  return [
    ...(pre === 0 ? [] : [pre]),
    ...rex(w === true, reg > 7, false, base > 7, false),
    0x0f, op, ...memOperand(reg, base, disp),
  ];
}

/** `dbl` -> 强制前缀：double 是 `F2`、float 是 `F3`。 */
function fpre(dbl) {
  if (dbl !== true && dbl !== false) throw new OmniError('x64: 浮点宽度要明说 true/false');
  return dbl ? 0xf2 : 0xf3;
}

/** `movsd/movss xmm, xmm`（`0F 10`：目标是 reg 那一格）。 */
export function fmovRR(dbl, dst, src) {
  return sseRR(fpre(dbl), 0x10, dst, src);
}

/** `movsd/movss xmm, [mem]`（加载）。 */
export function fmovRM(dbl, dst, base, disp) {
  return sseRM(fpre(dbl), 0x10, dst, base, disp);
}

/** `movsd/movss [mem], xmm`（存，`0F 11`：方向反过来，xmm 还在 reg 那一格）。 */
export function fmovMR(dbl, base, disp, src) {
  return sseRM(fpre(dbl), 0x11, src, base, disp);
}

/** 标量算术：`addsd`/`subsd`/`mulsd`/`divsd`/`sqrtsd`/`minsd`/`maxsd` 与 `ss` 那一列。 */
export function fbin(op, dbl, dst, src) {
  if (!Number.isInteger(op) || op < 0x50 || op > 0x5f) {
    throw new OmniError(`x64: 不认识浮点操作码 ${op}`);
  }
  return sseRR(fpre(dbl), op, dst, src);
}

/**
 * `ucomisd`/`ucomiss`：比较，把结果放进**标志位**（ZF/PF/CF），不改操作数。
 *
 * 三件事要记住，都是与整数比较不同的地方：
 *  - 不可比（有 NaN）时 `PF=1`，而 ZF/CF 也都是 1 —— 于是「相等」要 `je` **加** `jnp`
 *    两条才对，光看 ZF 会把 NaN 当成相等；
 *  - 它只有「大于」这一侧的条件码好用（`a`/`ae`），所以 `<` 一般靠**换操作数**实现；
 *  - `ucomi` 与 `comi` 的差别只在「静默 NaN 是否发信号」，C 的比较用 `ucomi`。
 */
export function fcmp(dbl, a1, a2) {
  return sseRR(dbl ? 0x66 : 0, 0x2e, a1, a2);
}

/** 整数 -> 浮点（`cvtsi2sd`/`cvtsi2ss`）。`size` 是**源**的宽度（4 或 8）。 */
export function cvtI2F(dbl, size, dst, src) {
  if (size !== 4 && size !== 8) throw new OmniError('x64: cvtsi2s? 的源只有 32/64 位');
  chkXmm(dst);
  chkReg(src);
  return [
    fpre(dbl), ...rex(size === 8, dst > 7, false, src > 7, false),
    0x0f, 0x2a, modrm(3, dst, src),
  ];
}

/**
 * 浮点 -> 整数（`cvttsd2si`/`cvttss2si`）。`size` 是**目标**的宽度。
 *
 * 用 `2C`（`cvtt`，两个 t）而不是 `2D`：前者**向零截断**，后者按 MXCSR 里的舍入模式。
 * C 的 `(int)f` 是截断，所以只有 `2C` 是对的 —— 这两个操作码差一格，错了平时看不出来
 * （`(int)2.5` 两样都是 2），到 `(int)2.7` 才露。
 */
export function cvtF2I(dbl, size, dst, src) {
  if (size !== 4 && size !== 8) throw new OmniError('x64: cvtts?2si 的目标只有 32/64 位');
  chkReg(dst);
  chkXmm(src);
  return [
    fpre(dbl), ...rex(size === 8, dst > 7, false, src > 7, false),
    0x0f, 0x2c, modrm(3, dst, src),
  ];
}

/** `cvtsd2ss`（double -> float）与 `cvtss2sd`（float -> double），都是 `0F 5A`。 */
export function cvtF2F(toFloat, dst, src) {
  return sseRR(toFloat ? 0xf2 : 0xf3, 0x5a, dst, src);
}

/** `movq xmm, r64`（`66 REX.W 0F 6E`）：位模式搬进 xmm，不做任何转换。 */
export function movqToXmm(dst, src) {
  chkXmm(dst);
  chkReg(src);
  return [0x66, ...rex(true, dst > 7, false, src > 7, false), 0x0f, 0x6e, modrm(3, dst, src)];
}

/** `movq r64, xmm`（`66 REX.W 0F 7E`）：位模式搬出来。 */
export function movqFromXmm(dst, src) {
  chkReg(dst);
  chkXmm(src);
  return [0x66, ...rex(true, src > 7, false, dst > 7, false), 0x0f, 0x7e, modrm(3, src, dst)];
}

/** `xorps`（`0F 57`）/ `xorpd`（`66 0F 57`）。取负与清零都靠它。 */
export function fxor(dbl, dst, src) {
  return sseRR(dbl ? 0x66 : 0, 0x57, dst, src);
}

/** `andps`/`andpd`（`0F 54`）。取绝对值靠它（与一个「除了符号位全 1」的掩码）。 */
export function fand(dbl, dst, src) {
  return sseRR(dbl ? 0x66 : 0, 0x54, dst, src);
}

/** `pxor`（`66 0F EF`）。清零一个 xmm 的标准写法。 */
export function pxor(dst, src) {
  return sseRR(0x66, 0xef, dst, src);
}
