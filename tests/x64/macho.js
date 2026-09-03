/* x86_64 的目标文件写出（第九刀第十五片）。
 *
 * 这一片没有新的「代码生成」—— 函数体是**手写**的（用 `CodeBuf` 一条条发），
 * 要验的是三件别的事：
 *
 * 1. `writeObject(..., 'x86_64')` 写出来的 `.o` 系统链接器认不认；
 * 2. `X86_64_RELOC_BRANCH`（`call` 到 libc）与 `X86_64_RELOC_SIGNED`（RIP 相对取址、
 *    读写全局）这两笔账，链接器填得对不对；
 * 3. 我们发的指令在**真机器**上跑起来对不对 —— Apple Silicon 上靠
 *    `clang -arch x86_64` 加 Rosetta。
 *
 * 手写函数体这件事本身是有意的：第 10 步在 x86_64 这条腿上还没做（`from_mir` 只有
 * arm64 那一份），而目标文件这一层不该等它。反过来说，等 x86_64 的 `from_mir` 落地，
 * 这一份测里的手写序言/收场正好是那一层要照着发的样子。
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as x from '../../src/core/x64/encode.js';
import { REG as R, ALU, CC, FOP, XMM } from '../../src/core/x64/encode.js';
import { CodeBuf } from '../../src/core/x64/asm.js';
import { writeObject } from '../../src/core/link/macho.js';
import { utf8Bytes } from '../../src/core/host/utf8.js';

let failed = 0;
let total = 0;
function ok(what, cond) {
  total++;
  if (cond) return;
  failed++;
  process.stdout.write(`  FAIL ${what}\n`);
}

/* SysV 的传参：整数实参 `rdi rsi rdx rcx r8 r9`，浮点 `xmm0-7`，返回 `rax`/`xmm0`。
 * 与 arm64 的「x0-x7 八个、v0-v7 八个」不同 —— 整数只有**六个**。 */
const ARG = [R.rdi, R.rsi, R.rdx, R.rcx, R.r8, R.r9];

const buf = new CodeBuf();
const defs = [];
const data = [];
const dataSyms = [];

/** 一个函数：序言、`body`、收场。序言/收场照 SysV 的样子（`rbp` 链 + 16 字节对齐）。 */
function fn(name, body) {
  defs.push({ name, off: buf.pos, sect: 1 });
  buf.emit(x.push(R.rbp));
  buf.emit(x.movRR(8, R.rbp, R.rsp));
  /* 帧里留 32 个字节的草稿位。`call` 之前 `rsp` 必须是 16 的倍数 ——
   * 进来时 `rsp % 16 == 8`（返回地址占了 8），`push rbp` 补回 16，再减 32 还是 16 的倍数。 */
  buf.emit(x.aluRI(ALU.sub, 8, R.rsp, 32));
  body();
  buf.emit(x.movRR(8, R.rsp, R.rbp));
  buf.emit(x.pop(R.rbp));
  buf.emit(x.ret());
}

// ---- 1. 最简单的：两个整数实参相加
fn('omni_x1_add', () => {
  buf.emit(x.movRR(8, R.rax, ARG[0]));
  buf.emit(x.aluRR(ALU.add, 8, R.rax, ARG[1]));
});

// ---- 2. 立即数、乘、除（`idiv` 前要 `cqo` 把符号铺进 rdx）
fn('omni_x2_muldiv', () => {
  buf.emit(x.movRR(8, R.rax, ARG[0]));
  buf.emit(x.imulRR(8, R.rax, ARG[1]));
  buf.emit(x.movRI(8, R.rcx, 3));
  buf.emit(x.cqo());
  buf.emit(x.idivR(8, R.rcx));       // rax = rax / 3，余数在 rdx
});

// ---- 3. 条件与跳转：`x < y ? x : y`，走 `cmp` + `jcc` + 标签
fn('omni_x3_min', () => {
  const less = buf.label();
  const out = buf.label();
  buf.emit(x.aluRR(ALU.cmp, 8, ARG[0], ARG[1]));
  buf.jcc(CC.l, less);
  buf.emit(x.movRR(8, R.rax, ARG[1]));
  buf.jmp(out);
  buf.place(less);
  buf.emit(x.movRR(8, R.rax, ARG[0]));
  buf.place(out);
});

// ---- 4. `setcc`：比较的结果当 0/1 用（movzx 是因为 setcc 只写一个字节）
fn('omni_x4_lt', () => {
  buf.emit(x.aluRR(ALU.cmp, 8, ARG[0], ARG[1]));
  buf.emit(x.setcc(CC.l, R.rax));
  buf.emit(x.movzx(8, 1, R.rax, R.rax));
});

// ---- 5. 帧里的存取：把两个实参写进草稿位再读回来相减
fn('omni_x5_frame', () => {
  buf.emit(x.movMR(8, R.rbp, -8, ARG[0]));
  buf.emit(x.movMR(8, R.rbp, -16, ARG[1]));
  buf.emit(x.movRM(8, R.rax, R.rbp, -8));
  buf.emit(x.aluRM(ALU.sub, 8, R.rax, R.rbp, -16));
});

// ---- 6. 调 libc：`llabs`（一笔 X86_64_RELOC_BRANCH）
fn('omni_x6_abs', () => {
  buf.callSym('llabs');
});

// ---- 7. 串常量：RIP 相对取址，交给 `strlen`（BRANCH + SIGNED 各一笔）
let strLen = 0;
{
  const bytes = utf8Bytes('hello, 世界');
  strLen = bytes.length;
  dataSyms.push({ name: 'omni_x_str', off: data.length, sect: 2 });
  for (const b of bytes) data.push(b);
  data.push(0);
  fn('omni_x7_strlen', () => {
    buf.leaSym(ARG[0], 'omni_x_str');
    buf.callSym('strlen');
  });
}

// ---- 8. 全局：写进去再读回来（两笔 SIGNED），并让 C 那边也看得见
while (data.length % 8 !== 0) data.push(0);
dataSyms.push({ name: 'omni_x_g', off: data.length, sect: 2 });
for (let i = 0; i < 8; i++) data.push(0);
fn('omni_x8_global', () => {
  buf.storeSym(8, 'omni_x_g', ARG[0]);
  buf.loadSym(8, R.rax, 'omni_x_g');
});

// ---- 9. 浮点：两个 double 相乘再加 1（xmm0/xmm1 进、xmm0 出）
fn('omni_x9_scale', () => {
  buf.emit(x.fbin(FOP.mul, true, XMM.xmm0, XMM.xmm1));
  /* 1.0 的位模式先进整数寄存器，再 `movq` 搬进 xmm —— 与 arm64 那边同一个路子
   * （常量走整数寄存器，浮点寄存器不碰立即数）。 */
  buf.emit(x.movAbs(R.rax, 0x3ff0000000000000n));
  buf.emit(x.movqToXmm(XMM.xmm2, R.rax));
  buf.emit(x.fbin(FOP.add, true, XMM.xmm0, XMM.xmm2));
});

// ---- 10. 浮点比较：`x < y` 要 `ucomisd` 加 `setb`（**换操作数**那一侧才有 b/a 可用）
fn('omni_x10_flt', () => {
  buf.emit(x.fcmp(true, XMM.xmm1, XMM.xmm0));   // 比的是 y ? x，于是 CF=1 表示 x < y
  buf.emit(x.setcc(CC.a, R.rax));
  buf.emit(x.movzx(8, 1, R.rax, R.rax));
});

buf.finish();

// ---------------------------------------------------------------- 跑
const CLANG = ['/usr/bin/clang', '/opt/homebrew/opt/llvm/bin/clang'].find((p) => existsSync(p));
if (CLANG === undefined) {
  process.stdout.write('x64/macho: 没找到 clang，跳过\n');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'omni-x64obj-'));
try {
  const objPath = join(dir, 'omni.o');
  const obj = writeObject(buf.bytes(), new Uint8Array(data),
    [...defs, ...dataSyms], buf.relocs, 'x86_64');
  writeFileSync(objPath, obj);
  ok('写出来的是 x86_64 的 .o（cputype = 0x01000007）',
    obj[4] === 0x07 && obj[5] === 0x00 && obj[6] === 0x00 && obj[7] === 0x01);

  const main = [
    '#include <stdio.h>',
    '#include <string.h>',
    'extern long long omni_x1_add(long long, long long);',
    'extern long long omni_x2_muldiv(long long, long long);',
    'extern long long omni_x3_min(long long, long long);',
    'extern long long omni_x4_lt(long long, long long);',
    'extern long long omni_x5_frame(long long, long long);',
    'extern long long omni_x6_abs(long long);',
    'extern long long omni_x7_strlen(void);',
    'extern long long omni_x8_global(long long);',
    'extern double omni_x9_scale(double, double);',
    'extern long long omni_x10_flt(double, double);',
    'extern long long omni_x_g;',
    'extern char omni_x_str[];',
    'int main(void){',
    '  printf("%lld\\n", omni_x1_add(3, 4));',
    '  printf("%lld\\n", omni_x2_muldiv(7, 6));',
    '  printf("%lld\\n", omni_x3_min(9, -2));',
    '  printf("%lld\\n", omni_x4_lt(1, 2));',
    '  printf("%lld\\n", omni_x4_lt(2, 1));',
    '  printf("%lld\\n", omni_x5_frame(10, 4));',
    '  printf("%lld\\n", omni_x6_abs(-5));',
    '  printf("%lld\\n", omni_x7_strlen());',
    '  printf("%lld\\n", omni_x8_global(-9876543210LL));',
    '  printf("%lld\\n", omni_x_g);',
    '  printf("%d\\n", (int)strlen(omni_x_str));',
    '  printf("%lld\\n", (long long)(omni_x9_scale(2.5, 4.0) * 100));',
    '  printf("%lld\\n", omni_x10_flt(1.5, 2.5));',
    '  printf("%lld\\n", omni_x10_flt(2.5, 1.5));',
    '  return 0;',
    '}',
  ].join('\n');
  const mainPath = join(dir, 'main.c');
  writeFileSync(mainPath, `${main}\n`);
  const progPath = join(dir, 'prog');
  execFileSync(CLANG, ['-arch', 'x86_64', mainPath, objPath, '-o', progPath], { stdio: 'pipe' });
  const out = execFileSync(progPath, [], { encoding: 'utf8' }).trim().split('\n');
  const L = String(strLen);
  const want = ['7', '14', '-2', '1', '0', '6', '5', L, '-9876543210', '-9876543210', L, '1100', '1', '0'];
  const what = [
    '整数相加（rdi/rsi 进、rax 出）', '乘与 idiv（cqo 铺符号）', '条件跳转与标签',
    'setcc + movzx（真）', 'setcc + movzx（假）', '帧里的存取',
    '调 libc 的 llabs（BRANCH）', '串常量的 strlen（SIGNED + BRANCH）',
    '全局：写进去再读回来（两笔 SIGNED）', '全局：C 那边读得到',
    '串常量：C 那边读得到', 'double 的乘加（xmm0/xmm1）',
    'ucomisd + setb（真）', 'ucomisd + setb（假）',
  ];
  for (let i = 0; i < want.length; i++) ok(`跑：${what[i]}`, out[i] === want[i]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${total - failed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
