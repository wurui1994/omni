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

import * as a from '../../stage0/src/arm64/encode.js';

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
