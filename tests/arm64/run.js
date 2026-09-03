/* arm64 编码器的对账（ADR-0017 第 9 步「对着 llvm-mc 验」，第九刀第一片）。
 *
 * 一条用例 = 一行汇编 + 我们编出来的那个字。全部用例拼成一个 `.s`，交给
 * `llvm-mc -filetype=obj` 汇编、`llvm-objdump -d` 反出来 —— 走 obj 而不是
 * `--show-encoding` 是因为后者不落实 fixup，跳转那一族会印成 `0bAAA00000`。
 *
 * 跑法：`node tests/arm64/run.js`
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import * as a from '../../src/core/arm64/encode.js';
import { CodeBuf, RELOC } from '../../src/core/arm64/asm.js';

/** llvm-mc 在哪。没有就整份跳过 —— 这条链是「有 llvm 的机器上必须过」。 */
function findLlvm(name) {
  const cands = [
    `/opt/homebrew/opt/llvm/bin/${name}`,
    `/usr/local/opt/llvm/bin/${name}`,
    `/usr/bin/${name}`,
  ];
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

const MC = findLlvm('llvm-mc');
const OBJDUMP = findLlvm('llvm-objdump');
if (MC === null || OBJDUMP === null) {
  process.stdout.write('arm64: 没找到 llvm-mc/llvm-objdump，跳过\n');
  process.exit(0);
}

const X = 1;   // sf=1：x 系
const W = 0;   // sf=0：w 系
const SP = 31;
const ZR = 31;

/** @type {{asm:string, word:number}[]} */
const cases = [];
const t = (asm, word) => cases.push({ asm, word });

// ---- 立即数运算
t('add x0, x1, #7', a.addImm(X, 0, 1, 7));
t('add w2, w3, #4095', a.addImm(W, 2, 3, 4095));
t('add x4, x5, #1, lsl #12', a.addImm(X, 4, 5, 1, 1));
t('adds x6, x7, #8', a.addsImm(X, 6, 7, 8));
t('sub w2, w3, #4095', a.subImm(W, 2, 3, 4095));
t('subs x8, x9, #16', a.subsImm(X, 8, 9, 16));
t('sub sp, sp, #64', a.subImm(X, SP, SP, 64));
t('add sp, sp, #64', a.addImm(X, SP, SP, 64));
t('cmp x10, #3', a.cmpImm(X, 10, 3));
t('cmn w11, #3', a.cmnImm(W, 11, 3));
t('mov x12, sp', a.movSp(X, 12, SP));

// ---- 搬立即数
t('movz x13, #0', a.movz(X, 13, 0));
t('movz x14, #65535', a.movz(X, 14, 65535));
t('movz x15, #4660, lsl #16', a.movz(X, 15, 0x1234, 1));
t('movz x16, #4660, lsl #48', a.movz(X, 16, 0x1234, 3));
t('movk x17, #43981, lsl #32', a.movk(X, 17, 0xabcd, 2));
t('movn x18, #0', a.movn(X, 18, 0));
t('movz w19, #291, lsl #16', a.movz(W, 19, 0x123, 1));

// ---- 寄存器运算
t('add x0, x1, x2', a.addReg(X, 0, 1, 2));
t('add x0, x1, x2, lsl #3', a.addReg(X, 0, 1, 2, 0, 3));
t('add w0, w1, w2, asr #7', a.addReg(W, 0, 1, 2, 2, 7));
t('adds x3, x4, x5', a.addsReg(X, 3, 4, 5));
t('sub x6, x7, x8', a.subReg(X, 6, 7, 8));
t('subs w9, w10, w11', a.subsReg(W, 9, 10, 11));
t('cmp x12, x13', a.cmpReg(X, 12, 13));
t('neg x14, x15', a.neg(X, 14, 15));
t('and x0, x1, x2', a.andReg(X, 0, 1, 2));
t('orr w3, w4, w5', a.orrReg(W, 3, 4, 5));
t('eor x6, x7, x8', a.eorReg(X, 6, 7, 8));
t('ands x9, x10, x11', a.andsReg(X, 9, 10, 11));
t('bic x12, x13, x14', a.bicReg(X, 12, 13, 14));
t('tst x15, x16', a.tstReg(X, 15, 16));
t('mov x17, x18', a.movReg(X, 17, 18));
t('mvn w19, w20', a.mvn(W, 19, 20));

// ---- 乘除与变位
t('mul x0, x1, x2', a.mul(X, 0, 1, 2));
t('madd w3, w4, w5, w6', a.madd(W, 3, 4, 5, 6));
t('msub x7, x8, x9, x10', a.msub(X, 7, 8, 9, 10));
t('udiv x11, x12, x13', a.udiv(X, 11, 12, 13));
t('sdiv w14, w15, w16', a.sdiv(W, 14, 15, 16));
t('lsl x17, x18, x19', a.lslv(X, 17, 18, 19));
t('lsr w20, w21, w22', a.lsrv(W, 20, 21, 22));
t('asr x23, x24, x25', a.asrv(X, 23, 24, 25));

// ---- 条件选择
t('csel x0, x1, x2, eq', a.csel(X, 0, 1, 2, a.COND.eq));
t('csinc w3, w4, w5, ne', a.csinc(W, 3, 4, 5, a.COND.ne));
t('cset x6, lt', a.cset(X, 6, a.COND.lt));
t('cset w7, hi', a.cset(W, 7, a.COND.hi));

// ---- 取地址（`. + N` 让汇编器自己算，于是 fixup 落实在 obj 里）
t('adr x0, . + 8', a.adr(0, 8));
/* adrp 写 `. + 4096` 的话 obj 里留的是 ARM64_RELOC_PAGE21，那一格要等链接才填，
 * 反汇编看见的是 0 —— 所以这一族用**立即数形式**问，页数自己写。 */
t('adrp x1, #4096', a.adrp(1, 1));
t('adrp x2, #-8192', a.adrp(2, -2));
t('adrp x3, #0', a.adrp(3, 0));

// ---- 存取：缩放过的无符号偏移
t('str x0, [x1, #16]', a.strU(3, 0, 1, 16));
t('ldr x0, [x1, #16]', a.ldrU(3, 0, 1, 16));
t('str w2, [x3, #4]', a.strU(2, 2, 3, 4));
t('ldr w2, [x3, #16380]', a.ldrU(2, 2, 3, 16380));
t('strh w4, [x5, #2]', a.strU(1, 4, 5, 2));
t('ldrh w4, [x5, #8190]', a.ldrU(1, 4, 5, 8190));
t('strb w6, [x7, #1]', a.strU(0, 6, 7, 1));
t('ldrb w6, [x7, #4095]', a.ldrU(0, 6, 7, 4095));
t('ldrsb x8, [x9, #3]', a.ldrsU(0, 8, 9, 3));
t('ldrsh x10, [x11, #4]', a.ldrsU(1, 10, 11, 4));
t('ldrsw x12, [x13, #8]', a.ldrsU(2, 12, 13, 8));
t('ldrsb w14, [x15, #5]', a.ldrsU(0, 14, 15, 5, false));
t('ldr x0, [sp, #8]', a.ldrU(3, 0, SP, 8));

// ---- 存取：9 位有符号、不缩放
t('stur x0, [x1, #-8]', a.stur(3, 0, 1, -8));
t('ldur w2, [x3, #-1]', a.ldur(2, 2, 3, -1));
t('str x4, [x5, #-16]!', a.strPre(3, 4, 5, -16));
t('ldr x6, [x7], #16', a.ldrPost(3, 6, 7, 16));
t('str w8, [x9], #-4', a.strPost(2, 8, 9, -4));
t('ldr x10, [x11, #255]!', a.ldrPre(3, 10, 11, 255));

// ---- 存取：寄存器偏移
t('ldr x0, [x1, x2, lsl #3]', a.ldrRegOff(3, 0, 1, 2, 3, 1));
t('ldr x0, [x1, x2]', a.ldrRegOff(3, 0, 1, 2, 3, 0));
t('str w3, [x4, w5, uxtw #2]', a.strRegOff(2, 3, 4, 5, 2, 1));
t('ldrb w6, [x7, x8]', a.ldrRegOff(0, 6, 7, 8, 3, 0));

// ---- 成对存取（序言/收场那一对）
t('stp x29, x30, [sp, #-16]!', a.stpPre(X, 29, 30, SP, -16));
t('ldp x29, x30, [sp], #16', a.ldpPost(X, 29, 30, SP, 16));
t('stp x0, x1, [sp, #16]', a.stp(X, 0, 1, SP, 16));
t('ldp w2, w3, [x4, #-8]', a.ldp(W, 2, 3, 4, -8));

// ---- 跳转
t('b . + 8', a.b(8));
t('b . - 4', a.b(-4));
t('bl . + 4096', a.bl(4096));
t('b.eq . + 8', a.bcond(a.COND.eq, 8));
t('b.lt . - 8', a.bcond(a.COND.lt, -8));
t('cbz x0, . + 16', a.cbz(X, 0, 16));
t('cbnz w1, . - 16', a.cbnz(W, 1, -16));
t('br x2', a.br(2));
t('blr x3', a.blr(3));
t('ret', a.ret());
t('ret x4', a.ret(4));
t('nop', a.nop());

// ================================================================ 第九刀第二片

// ---- 逻辑立即数（N/immr/imms 那一族）
t('and x0, x1, #0xff', a.andImm(X, 0, 1, 0xff));
t('and w2, w3, #0xff', a.andImm(W, 2, 3, 0xff));
t('and x4, x5, #0xffff', a.andImm(X, 4, 5, 0xffff));
t('and x6, x7, #0xffffffff', a.andImm(X, 6, 7, 0xffffffff));
t('and x8, x9, #1', a.andImm(X, 8, 9, 1));
t('and x10, x11, #0x8000000000000000', a.andImm(X, 10, 11, -0x8000000000000000n));
t('and x12, x13, #0xff00ff00ff00ff00', a.andImm(X, 12, 13, 0xff00ff00ff00ff00n));
t('and w14, w15, #0xff00ff', a.andImm(W, 14, 15, 0xff00ff));
t('and x16, x17, #0xfffffffffffffff0', a.andImm(X, 16, 17, -16n));
t('and w18, w19, #0xfffffff0', a.andImm(W, 18, 19, 0xfffffff0));
t('and x20, x21, #0xf000000000000003', a.andImm(X, 20, 21, 0xf000000000000003n));
t('and x22, x23, #0x3ff0', a.andImm(X, 22, 23, 0x3ff0));
t('orr x0, x1, #0xfff', a.orrImm(X, 0, 1, 0xfff));
t('orr w2, w3, #0x80000000', a.orrImm(W, 2, 3, 0x80000000));
t('eor x4, x5, #0x5555555555555555', a.eorImm(X, 4, 5, 0x5555555555555555n));
t('eor w6, w7, #0x55555555', a.eorImm(W, 6, 7, 0x55555555));
t('ands x8, x9, #0x3f', a.andsImm(X, 8, 9, 0x3f));
t('tst w10, #7', a.tstImm(W, 10, 7));

// ---- 位段与它的一堆别名
t('sbfm x0, x1, #3, #7', a.sbfm(X, 0, 1, 3, 7));
t('bfm w2, w3, #1, #5', a.bfmIns(W, 2, 3, 1, 5));
t('ubfm x4, x5, #8, #15', a.ubfm(X, 4, 5, 8, 15));
t('lsl x6, x7, #1', a.lslImm(X, 6, 7, 1));
t('lsl x8, x9, #63', a.lslImm(X, 8, 9, 63));
t('lsl w10, w11, #4', a.lslImm(W, 10, 11, 4));
t('lsl x12, x13, #0', a.lslImm(X, 12, 13, 0));
t('lsr x14, x15, #7', a.lsrImm(X, 14, 15, 7));
t('lsr w16, w17, #31', a.lsrImm(W, 16, 17, 31));
t('asr x18, x19, #12', a.asrImm(X, 18, 19, 12));
t('asr w20, w21, #1', a.asrImm(W, 20, 21, 1));
t('ubfx x0, x1, #4, #8', a.ubfx(X, 0, 1, 4, 8));
t('sbfx w2, w3, #2, #6', a.sbfx(W, 2, 3, 2, 6));
t('bfi x4, x5, #8, #16', a.bfi(X, 4, 5, 8, 16));
t('bfi w6, w7, #0, #4', a.bfi(W, 6, 7, 0, 4));
t('sxtb w8, w9', a.sxtb(W, 8, 9));
t('sxtb x10, w11', a.sxtb(X, 10, 11));
t('sxth x12, w13', a.sxth(X, 12, 13));
t('sxtw x14, w15', a.sxtw(14, 15));
t('uxtb w16, w17', a.uxtb(16, 17));
t('uxth w18, w19', a.uxth(18, 19));

// ---- 接起来取一段
t('extr x0, x1, x2, #17', a.extr(X, 0, 1, 2, 17));
t('extr w3, w4, w5, #7', a.extr(W, 3, 4, 5, 7));
t('ror x6, x7, #13', a.rorImm(X, 6, 7, 13));

// ---- 单目位运算
t('rbit x0, x1', a.rbit(X, 0, 1));
t('rbit w2, w3', a.rbit(W, 2, 3));
t('rev16 x4, x5', a.rev16(X, 4, 5));
t('rev w6, w7', a.rev(W, 6, 7));
t('rev x8, x9', a.rev(X, 8, 9));
t('rev32 x10, x11', a.rev32(10, 11));
t('clz x12, x13', a.clz(X, 12, 13));
t('clz w14, w15', a.clz(W, 14, 15));
t('cls x16, x17', a.cls(X, 16, 17));

// ---- 浮点：两目
t('fmul d0, d1, d2', a.fmul(true, 0, 1, 2));
t('fmul s3, s4, s5', a.fmul(false, 3, 4, 5));
t('fdiv d6, d7, d8', a.fdiv(true, 6, 7, 8));
t('fadd d9, d10, d11', a.fadd(true, 9, 10, 11));
t('fsub s12, s13, s14', a.fsub(false, 12, 13, 14));
t('fmax d15, d16, d17', a.fmax(true, 15, 16, 17));
t('fmin d18, d19, d20', a.fmin(true, 18, 19, 20));
t('fnmul d21, d22, d23', a.fnmul(true, 21, 22, 23));

// ---- 浮点：单目与宽度转换
t('fmov d0, d1', a.fmovFp(true, 0, 1));
t('fabs d2, d3', a.fabsFp(true, 2, 3));
t('fneg s4, s5', a.fneg(false, 4, 5));
t('fsqrt d6, d7', a.fsqrt(true, 6, 7));
t('fcvt d8, s9', a.fcvtSD(8, 9));
t('fcvt s10, d11', a.fcvtDS(10, 11));

// ---- 浮点：比较
t('fcmp d0, d1', a.fcmp(true, 0, 1));
t('fcmp s2, s3', a.fcmp(false, 2, 3));
t('fcmp d4, #0.0', a.fcmpZero(true, 4));
t('fcmpe d5, d6', a.fcmpe(true, 5, 6));

// ---- 浮点 <-> 整数
t('scvtf d0, x1', a.scvtf(X, true, 0, 1));
t('scvtf d2, w3', a.scvtf(W, true, 2, 3));
t('scvtf s4, x5', a.scvtf(X, false, 4, 5));
t('ucvtf d6, x7', a.ucvtf(X, true, 6, 7));
t('ucvtf s8, w9', a.ucvtf(W, false, 8, 9));
t('fcvtzs x10, d11', a.fcvtzs(X, true, 10, 11));
t('fcvtzs w12, d13', a.fcvtzs(W, true, 12, 13));
t('fcvtzs x14, s15', a.fcvtzs(X, false, 14, 15));
t('fcvtzu w16, d17', a.fcvtzu(W, true, 16, 17));
t('fmov x18, d19', a.fmovToInt(X, true, 18, 19));
t('fmov w20, s21', a.fmovToInt(W, false, 20, 21));
t('fmov d22, x23', a.fmovFromInt(X, true, 22, 23));
t('fmov s24, w25', a.fmovFromInt(W, false, 24, 25));

// ---- 浮点存取
t('str d0, [x1, #16]', a.strFpU(3, 0, 1, 16));
t('ldr d2, [x3, #32760]', a.ldrFpU(3, 2, 3, 32760));
t('str s4, [x5, #4]', a.strFpU(2, 4, 5, 4));
t('ldr s6, [sp, #8]', a.ldrFpU(2, 6, SP, 8));

// ---- 单向屏障的存取与屏障本身
t('ldar x0, [x1]', a.ldar(3, 0, 1));
t('ldar w2, [x3]', a.ldar(2, 2, 3));
t('ldarb w4, [x5]', a.ldar(0, 4, 5));
t('stlr x6, [x7]', a.stlr(3, 6, 7));
t('stlrh w8, [x9]', a.stlr(1, 8, 9));
t('dmb ish', a.dmbIsh());
t('dsb ish', a.dsbIsh());
t('isb', a.isb());

// ================================================================ 第九刀第三片
// 指令缓冲：标签、往前跳的回填。整段程序与 llvm 汇编同一段带标签的源比。

/** @type {{name:string, asm:string, words:number[]}[]} */
const programs = [];
/** 缓冲收工后的那几个字（小端 -> 无符号 32 位）。 */
const wordsOf = (buf) => [...new Uint32Array(buf.bytes().buffer)];

{
  /* 一个阶乘的循环：往后跳（`b L1`）与往前跳（`cbz L2`、`b.lt L3`）各有，
   * 还有一条 `adr` 指到后面的标签。 */
  const buf = new CodeBuf();
  const L1 = buf.label();
  const L2 = buf.label();
  const L3 = buf.label();
  buf.emit(a.movz(X, 0, 1), a.movz(X, 1, 5));
  buf.place(L1);
  buf.cbz(X, 1, L2);
  buf.emit(a.mul(X, 0, 0, 1), a.subImm(X, 1, 1, 1));
  buf.b(L1);
  buf.place(L2);
  buf.emit(a.cmpImm(X, 0, 100));
  buf.bcond(a.COND.lt, L3);
  buf.emit(a.movz(X, 0, 0));
  buf.adr(2, L3);
  buf.place(L3);
  buf.emit(a.ret());
  programs.push({
    name: '阶乘的循环',
    asm: [
      'mov x0, #1', 'mov x1, #5',
      'L1: cbz x1, L2',
      'mul x0, x0, x1', 'sub x1, x1, #1',
      'b L1',
      'L2: cmp x0, #100',
      'b.lt L3',
      'mov x0, #0',
      'adr x2, L3',
      'L3: ret',
    ].join('\n'),
    words: wordsOf(buf),
  });
}

{
  /* 序言 + 收场，中间一条前后都跳的嵌套。 */
  const buf = new CodeBuf();
  const top = buf.label();
  const out = buf.label();
  buf.emit(a.stpPre(X, 29, 30, SP, -16), a.movSp(X, 29, SP));
  buf.place(top);
  buf.emit(a.subsImm(X, 0, 0, 1));
  buf.bcond(a.COND.eq, out);
  buf.cbnz(X, 0, top);
  buf.place(out);
  buf.emit(a.ldpPost(X, 29, 30, SP, 16), a.ret());
  programs.push({
    name: '序言收场夹一个循环',
    asm: [
      'stp x29, x30, [sp, #-16]!', 'mov x29, sp',
      'top: subs x0, x0, #1',
      'b.eq out',
      'cbnz x0, top',
      'out: ldp x29, x30, [sp], #16', 'ret',
    ].join('\n'),
    words: [...new Uint32Array(buf.bytes().buffer)],
  });
}

// ---- 边界：编不下去的要当场报，不许悄悄截断
/** @type {{what:string, fn:Function}[]} */
const bounds = [
  { what: 'imm12 越界', fn: () => a.addImm(X, 0, 1, 4096) },
  { what: 'ldr 偏移没对齐', fn: () => a.ldrU(3, 0, 1, 4) },
  { what: 'stp 偏移没对齐', fn: () => a.stp(X, 0, 1, SP, 4) },
  { what: '跳转偏移没对齐', fn: () => a.b(2) },
  { what: 'imm9 越界', fn: () => a.stur(3, 0, 1, 256) },
  { what: 'w 系 movz 的 hw', fn: () => a.movz(W, 0, 1, 2) },
  { what: '寄存器号越界', fn: () => a.addReg(X, 32, 0, 0) },
  /* 第九刀第二片 */
  { what: '逻辑立即数编不出来', fn: () => a.andImm(X, 0, 1, 0x1234) },
  { what: '逻辑立即数是两段 1', fn: () => a.andImm(X, 0, 1, 5) },
  { what: '逻辑立即数全 0', fn: () => a.andImm(X, 0, 1, 0) },
  { what: '逻辑立即数全 1', fn: () => a.andImm(X, 0, 1, -1n) },
  { what: 'lsl 移过头', fn: () => a.lslImm(W, 0, 1, 32) },
  { what: 'asr 移过头', fn: () => a.asrImm(X, 0, 1, 64) },
  { what: 'ubfx 段出了寄存器', fn: () => a.ubfx(W, 0, 1, 28, 8) },
  { what: 'bfi 宽度是 0', fn: () => a.bfi(X, 0, 1, 0, 0) },
  { what: 'extr 的 lsb 越界', fn: () => a.extr(X, 0, 1, 2, 64) },
  { what: '浮点存取偏移没对齐', fn: () => a.ldrFpU(3, 0, 1, 4) },
  /* 第九刀第三片：缓冲自己的边界 */
  { what: '标签从没落地', fn: () => { const b = new CodeBuf(); b.b(b.label()); b.finish(); } },
  { what: '同一个标签落两次', fn: () => { const b = new CodeBuf(); const l = b.label(); b.place(l); b.place(l); } },
  { what: '跳到不存在的标签', fn: () => new CodeBuf().b(7) },
  { what: '往缓冲里塞不是指令字的东西', fn: () => new CodeBuf().word(-1) },
];

// ---------------------------------------------------------------- 跑
const dir = mkdtempSync(join(tmpdir(), 'omni-arm64-'));
const sPath = join(dir, 'cases.s');
const oPath = join(dir, 'cases.o');
let failed = 0;
let passed = 0;
try {
  writeFileSync(sPath, '.text\n' + cases.map((c) => c.asm).join('\n') + '\n');
  execFileSync(MC, ['-triple=arm64', '-filetype=obj', sPath, '-o', oPath]);
  const dis = execFileSync(OBJDUMP, ['-d', oPath], { encoding: 'utf8' });
  /** 反汇编的每一行形如 `       0: 91001c20     	add	x0, x1, #0x7` */
  const words = [];
  for (const line of dis.split('\n')) {
    const m = /^\s+[0-9a-f]+:\s+([0-9a-f]{8})\s/.exec(line);
    if (m !== null) words.push(parseInt(m[1], 16) >>> 0);
  }
  if (words.length !== cases.length) {
    process.stdout.write(`arm64: 反出来 ${words.length} 条，用例 ${cases.length} 条 —— 对不上\n`);
    process.exit(1);
  }
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    if (c.word === words[i]) { passed++; continue; }
    failed++;
    process.stdout.write(`  FAIL ${c.asm}\n    ours   ${c.word.toString(16).padStart(8, '0')}`
      + `\n    llvm   ${words[i].toString(16).padStart(8, '0')}\n`);
  }
  for (const p of programs) {
    const ps = join(dir, 'prog.s');
    const po = join(dir, 'prog.o');
    writeFileSync(ps, '.text\n' + p.asm + '\n');
    execFileSync(MC, ['-triple=arm64', '-filetype=obj', ps, '-o', po]);
    const pd = execFileSync(OBJDUMP, ['-d', po], { encoding: 'utf8' });
    const want = [];
    for (const line of pd.split('\n')) {
      const m = /^\s+[0-9a-f]+:\s+([0-9a-f]{8})\s/.exec(line);
      if (m !== null) want.push(parseInt(m[1], 16) >>> 0);
    }
    if (want.length !== p.words.length) {
      failed++;
      process.stdout.write(`  FAIL 程序「${p.name}」条数对不上：ours ${p.words.length}，llvm ${want.length}\n`);
      continue;
    }
    let same = true;
    for (let i = 0; i < want.length; i++) {
      if (p.words[i] === want[i]) continue;
      same = false;
      process.stdout.write(`  FAIL 程序「${p.name}」第 ${i} 条`
        + `\n    ours   ${p.words[i].toString(16).padStart(8, '0')}`
        + `\n    llvm   ${want[i].toString(16).padStart(8, '0')}\n`);
    }
    if (same) passed++; else failed++;
  }

  /* 符号那几条只查「记了什么账、字里留的是不是 0」—— 填是第 11 步链接器的事。 */
  {
    const buf = new CodeBuf();
    buf.adrpSym(0, '_msg');
    buf.addSymOff(0, 0, '_msg');
    buf.blSym('_printf');
    const w = wordsOf(buf);
    const wantKinds = [RELOC.PAGE21, RELOC.PAGEOFF12, RELOC.BRANCH26];
    const gotKinds = buf.relocs.map((r) => r.kind);
    const ok = gotKinds.join(',') === wantKinds.join(',')
      && buf.relocs.map((r) => r.at).join(',') === '0,4,8'
      && w[0] === a.adrp(0, 0) && w[1] === a.addImm(1, 0, 0, 0) && w[2] === a.bl(0);
    if (ok) passed++;
    else {
      failed++;
      process.stdout.write(`  FAIL 符号记账：${gotKinds.join(',')} / ${buf.relocs.map((r) => r.at).join(',')}\n`);
    }
  }

  for (const b of bounds) {
    let threw = false;
    try { b.fn(); } catch { threw = true; }
    if (threw) { passed++; continue; }
    failed++;
    process.stdout.write(`  FAIL 边界「${b.what}」没报错\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
