/* x86_64 编码器的对账（第九刀第十二片）。arm64 那一侧的验法照搬：
 * 一条用例 = 一行汇编 + 我们编出来的那串字节，全部拼成一个 `.s` 交给
 * `llvm-mc -triple=x86_64 -filetype=obj` 汇编、`llvm-objdump -d` 反出来，逐条对。
 *
 * 与 arm64 那一份的唯一差别：x86 的指令是**变长**的，所以反汇编那一行里要连
 * 「这条占几个字节」一起读回来 —— 少读一格就整串错位，而错位的报错很难看懂，
 * 所以条数对不上时直接停。
 *
 * 跑法：`node tests/x64/run.js`
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as x from '../../stage0/src/x64/encode.js';
import { REG as R, ALU, CC, SH } from '../../stage0/src/x64/encode.js';

function findLlvm(name) {
  for (const c of [`/opt/homebrew/opt/llvm/bin/${name}`, `/usr/local/opt/llvm/bin/${name}`,
    `/usr/bin/${name}`]) if (existsSync(c)) return c;
  return null;
}

const MC = findLlvm('llvm-mc');
const OBJDUMP = findLlvm('llvm-objdump');
if (MC === null || OBJDUMP === null) {
  process.stdout.write('x64: 没找到 llvm-mc/llvm-objdump，跳过\n');
  process.exit(0);
}

/** @type {{asm:string, bytes:number[]}[]} */
const cases = [];
const t = (asm, bytes) => cases.push({ asm, bytes });

// ---- 搬
t('movabsq $0x1234567890abcdf0, %rax', x.movAbs(R.rax, 0x1234567890abcdf0n));
t('movabsq $-1, %r15', x.movAbs(R.r15, -1n));
t('movq $7, %rax', x.movRI(8, R.rax, 7));
t('movq $-1, %r10', x.movRI(8, R.r10, -1));
t('movl $305419896, %ecx', x.movRI(4, R.rcx, 0x12345678));
t('movw $4660, %dx', x.movRI(2, R.rdx, 0x1234));
t('movb $-5, %bl', x.movRI(1, R.rbx, -5));
t('movb $1, %sil', x.movRI(1, R.rsi, 1));
t('movq %rax, %rcx', x.movRR(8, R.rcx, R.rax));
t('movq %r15, %rax', x.movRR(8, R.rax, R.r15));
t('movq %rax, %r8', x.movRR(8, R.r8, R.rax));
t('movl %eax, %edx', x.movRR(4, R.rdx, R.rax));
t('movw %ax, %dx', x.movRR(2, R.rdx, R.rax));
t('movb %al, %cl', x.movRR(1, R.rcx, R.rax));
t('movb %sil, %dil', x.movRR(1, R.rdi, R.rsi));

// ---- 存取。三处特例都各有一条：rsp 要 SIB、rbp 的 0 位移也要写、位移分一字节与四字节。
t('movq (%rax), %rcx', x.movRM(8, R.rcx, R.rax, 0));
t('movq 8(%rax), %rcx', x.movRM(8, R.rcx, R.rax, 8));
t('movq -8(%rax), %rcx', x.movRM(8, R.rcx, R.rax, -8));
t('movq 4096(%rax), %rcx', x.movRM(8, R.rcx, R.rax, 4096));
t('movq (%rsp), %rax', x.movRM(8, R.rax, R.rsp, 0));
t('movq 16(%rsp), %rax', x.movRM(8, R.rax, R.rsp, 16));
t('movq (%rbp), %rax', x.movRM(8, R.rax, R.rbp, 0));
t('movq -24(%rbp), %rax', x.movRM(8, R.rax, R.rbp, -24));
t('movq (%r12), %rax', x.movRM(8, R.rax, R.r12, 0));
t('movq (%r13), %r14', x.movRM(8, R.r14, R.r13, 0));
t('movl 12(%rsp), %eax', x.movRM(4, R.rax, R.rsp, 12));
t('movb (%rax), %cl', x.movRM(1, R.rcx, R.rax, 0));
t('movq %rcx, (%rax)', x.movMR(8, R.rax, 0, R.rcx));
t('movq %rcx, 8(%rax)', x.movMR(8, R.rax, 8, R.rcx));
t('movq %rax, (%rsp)', x.movMR(8, R.rsp, 0, R.rax));
t('movq %rax, 32(%rsp)', x.movMR(8, R.rsp, 32, R.rax));
t('movl %eax, 4(%rbp)', x.movMR(4, R.rbp, 4, R.rax));
t('movw %ax, (%rbx)', x.movMR(2, R.rbx, 0, R.rax));
t('movb %al, (%rbx)', x.movMR(1, R.rbx, 0, R.rax));
t('movb %sil, (%rsp)', x.movMR(1, R.rsp, 0, R.rsi));
t('leaq 40(%rsp), %rax', x.lea(8, R.rax, R.rsp, 40));
t('leaq -1(%r13), %r9', x.lea(8, R.r9, R.r13, -1));

// ---- 宽度转换
t('movzbl %al, %ecx', x.movzx(4, 1, R.rcx, R.rax));
t('movzbl %sil, %eax', x.movzx(4, 1, R.rax, R.rsi));
t('movzwl %ax, %ecx', x.movzx(4, 2, R.rcx, R.rax));
t('movzbq %al, %rcx', x.movzx(8, 1, R.rcx, R.rax));
t('movsbl %al, %ecx', x.movsx(4, 1, R.rcx, R.rax));
t('movsbq %dil, %rax', x.movsx(8, 1, R.rax, R.rdi));
t('movswq %ax, %rcx', x.movsx(8, 2, R.rcx, R.rax));
t('movslq %eax, %rcx', x.movsx(8, 4, R.rcx, R.rax));
t('movslq %r10d, %r11', x.movsx(8, 4, R.r11, R.r10));

// ---- 算：一族八条，各挑几个宽度与几个特例
t('addq %rcx, %rax', x.aluRR(ALU.add, 8, R.rax, R.rcx));
t('orq %rcx, %rax', x.aluRR(ALU.or, 8, R.rax, R.rcx));
t('andq %rcx, %rax', x.aluRR(ALU.and, 8, R.rax, R.rcx));
t('subq %rcx, %rax', x.aluRR(ALU.sub, 8, R.rax, R.rcx));
t('xorq %rcx, %rax', x.aluRR(ALU.xor, 8, R.rax, R.rcx));
t('cmpq %rcx, %rax', x.aluRR(ALU.cmp, 8, R.rax, R.rcx));
t('adcq %rcx, %rax', x.aluRR(ALU.adc, 8, R.rax, R.rcx));
t('sbbq %rcx, %rax', x.aluRR(ALU.sbb, 8, R.rax, R.rcx));
t('addl %r8d, %eax', x.aluRR(ALU.add, 4, R.rax, R.r8));
t('addb %cl, %al', x.aluRR(ALU.add, 1, R.rax, R.rcx));
t('addw %cx, %ax', x.aluRR(ALU.add, 2, R.rax, R.rcx));
/* 「装得下一字节就用 83」这一格：1 用短的，4096 用长的。 */
t('addq $1, %rax', x.aluRI(ALU.add, 8, R.rax, 1));
t('addq $-1, %rax', x.aluRI(ALU.add, 8, R.rax, -1));
t('addq $4096, %rax', x.aluRI(ALU.add, 8, R.rax, 4096));
t('subq $16, %rsp', x.aluRI(ALU.sub, 8, R.rsp, 16));
t('cmpq $0, %r13', x.aluRI(ALU.cmp, 8, R.r13, 0));
t('andl $255, %eax', x.aluRI(ALU.and, 4, R.rax, 255));
t('cmpb $10, %dil', x.aluRI(ALU.cmp, 1, R.rdi, 10));
t('addq (%rax), %rcx', x.aluRM(ALU.add, 8, R.rcx, R.rax, 0));
t('subq 8(%rsp), %rax', x.aluRM(ALU.sub, 8, R.rax, R.rsp, 8));
t('cmpl -4(%rbp), %eax', x.aluRM(ALU.cmp, 4, R.rax, R.rbp, -4));
t('addq %rcx, (%rax)', x.aluMR(ALU.add, 8, R.rax, 0, R.rcx));
t('orl %eax, 16(%rsp)', x.aluMR(ALU.or, 4, R.rsp, 16, R.rax));
t('testq %rax, %rax', x.testRR(8, R.rax, R.rax));
t('testb %al, %al', x.testRR(1, R.rax, R.rax));
t('negq %rax', x.negR(8, R.rax));
t('notq %r9', x.notR(8, R.r9));
t('idivq %rcx', x.idivR(8, R.rcx));
t('divq %r10', x.divR(8, R.r10));
t('idivl %ecx', x.idivR(4, R.rcx));
t('imulq %rcx, %rax', x.imulRR(8, R.rax, R.rcx));
t('imull %r8d, %eax', x.imulRR(4, R.rax, R.r8));
t('cqto', x.cqo());
t('cltd', x.cdq());

// ---- 移位
t('shlq $3, %rax', x.shiftRI(SH.shl, 8, R.rax, 3));
t('shrq $63, %rax', x.shiftRI(SH.shr, 8, R.rax, 63));
t('sarq $1, %r11', x.shiftRI(SH.sar, 8, R.r11, 1));
t('shll $31, %eax', x.shiftRI(SH.shl, 4, R.rax, 31));
t('shlq %cl, %rax', x.shiftRCl(SH.shl, 8, R.rax));
t('sarq %cl, %r9', x.shiftRCl(SH.sar, 8, R.r9));

// ---- 条件
t('sete %al', x.setcc(CC.e, R.rax));
t('setne %cl', x.setcc(CC.ne, R.rcx));
t('setl %dil', x.setcc(CC.l, R.rdi));
t('setg %r10b', x.setcc(CC.g, R.r10));
t('setb %al', x.setcc(CC.b, R.rax));
t('cmoveq %rcx, %rax', x.cmovcc(CC.e, 8, R.rax, R.rcx));
t('cmovll %ecx, %eax', x.cmovcc(CC.l, 4, R.rax, R.rcx));

// ---- 跳、调、栈。
/* 相对跳转**不进 llvm 那一批**：`jmp 1f` 这种够近的，llvm 会自己缩成两字节的 `EB` 形式
 * （量过：`jmp 1f` + 紧跟的标签编出来是 `eb 00`）。那是汇编器的松弛，不是编码器的账 ——
 * 我们这一层永远发四字节的形式，因为「这一条占几个字节」在回填之前就得定下来，
 * 会变长的编码要么两遍过、要么留个空洞，两样都比多三个字节贵。
 * 所以这几条对着**手写的字节**验：`E9`/`0F 8x`/`E8` 加一个小端的四字节。 */
const rels = [
  { what: 'jmp rel32 = 0', bytes: x.jmpRel(0), want: [0xe9, 0, 0, 0, 0] },
  { what: 'jmp rel32 = -5（跳回本条开头）', bytes: x.jmpRel(-5), want: [0xe9, 0xfb, 0xff, 0xff, 0xff] },
  { what: 'jmp rel32 = 200', bytes: x.jmpRel(200), want: [0xe9, 0xc8, 0, 0, 0] },
  { what: 'je rel32 = 0', bytes: x.jccRel(CC.e, 0), want: [0x0f, 0x84, 0, 0, 0, 0] },
  { what: 'jne rel32 = -6', bytes: x.jccRel(CC.ne, -6), want: [0x0f, 0x85, 0xfa, 0xff, 0xff, 0xff] },
  { what: 'jl rel32 = 16', bytes: x.jccRel(CC.l, 16), want: [0x0f, 0x8c, 16, 0, 0, 0] },
  { what: 'call rel32 = 0', bytes: x.callRel(0), want: [0xe8, 0, 0, 0, 0] },
];
t('callq *%rax', x.callR(R.rax));
t('callq *%r11', x.callR(R.r11));
t('jmpq *%rax', x.jmpR(R.rax));
t('retq', x.ret());
t('nop', x.nop());
t('ud2', x.ud2());
t('pushq %rbp', x.push(R.rbp));
t('pushq %r14', x.push(R.r14));
t('popq %rbp', x.pop(R.rbp));
t('popq %r14', x.pop(R.r14));

// ---- 边界：编不下去的要当场报
const bounds = [
  { what: '寄存器号越界', fn: () => x.movRR(8, 16, 0) },
  { what: '宽度不是 1/2/4/8', fn: () => x.movRR(3, 0, 1) },
  { what: 'imm32 装不下', fn: () => x.movRI(4, R.rax, 2 ** 33) },
  { what: 'imm8 装不下', fn: () => x.movRI(1, R.rax, 300) },
  { what: '移位移过头', fn: () => x.shiftRI(SH.shl, 8, R.rax, 64) },
  { what: '32 位移位移过头', fn: () => x.shiftRI(SH.shl, 4, R.rax, 32) },
  { what: 'lea 没有 8 位', fn: () => x.lea(1, R.rax, R.rsp, 0) },
  { what: 'movzx 的源不能是 32 位', fn: () => x.movzx(8, 4, R.rax, R.rcx) },
  { what: 'movsxd 的目标只有 64 位', fn: () => x.movsx(4, 4, R.rax, R.rcx) },
  { what: '条件码越界', fn: () => x.setcc(16, R.rax) },
  { what: '/digit 越界', fn: () => x.aluRR(8, 8, R.rax, R.rcx) },
  { what: '位移不是整数', fn: () => x.movRM(8, R.rax, R.rcx, 1.5) },
  { what: 'imul 没有 8 位', fn: () => x.imulRR(1, R.rax, R.rcx) },
];

// ---------------------------------------------------------------- 跑
const dir = mkdtempSync(join(tmpdir(), 'omni-x64-'));
const sPath = join(dir, 'cases.s');
const oPath = join(dir, 'cases.o');
let failed = 0;
let passed = 0;
try {
  writeFileSync(sPath, `.text\n${cases.map((c) => c.asm).join('\n')}\n`);
  execFileSync(MC, ['-triple=x86_64', '-filetype=obj', sPath, '-o', oPath]);
  const dis = execFileSync(OBJDUMP, ['-d', oPath], { encoding: 'utf8' });
  /** 反汇编的一行形如 `       0: 48 89 c1    movq %rax, %rcx` —— 字节数不定，
   * 而字节列**填满时最后一个字节后面没有空格**（直接接制表符）。所以按「到制表符为止」
   * 切，不按「每个字节后跟一个空格」切 —— 后者会把十字节的 `movabs` 少读一个字节，
   * 而少读一个字节的报错看上去像编码错，这一格骗过一次。 */
  const got = [];
  for (const line of dis.split('\n')) {
    const m = /^\s+[0-9a-f]+:\s+((?:[0-9a-f]{2} )*[0-9a-f]{2})\s*\t/.exec(line);
    if (m === null) continue;
    got.push(m[1].split(' ').map((b) => parseInt(b, 16)));
  }
  if (got.length !== cases.length) {
    process.stdout.write(`x64: 反出来 ${got.length} 条，用例 ${cases.length} 条 —— 对不上\n`);
    process.exit(1);
  }
  const hex = (bs) => bs.map((b) => b.toString(16).padStart(2, '0')).join(' ');
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    if (hex(c.bytes) === hex(got[i])) { passed++; continue; }
    failed++;
    process.stdout.write(`  FAIL ${c.asm}\n    ours   ${hex(c.bytes)}\n    llvm   ${hex(got[i])}\n`);
  }
  for (const r of rels) {
    if (hex(r.bytes) === hex(r.want)) { passed++; continue; }
    failed++;
    process.stdout.write(`  FAIL ${r.what}\n    ours   ${hex(r.bytes)}\n    手册   ${hex(r.want)}\n`);
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
