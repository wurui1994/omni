#!/usr/bin/env node
/* 系统调用那条 op 与自带 libc（`OP.SYSCALL`，第一百四十片）。
 *
 * 为什么值得单独一份：自带 libc 的**整个地基**就是这一条 op —— 它错一格，症状是链出来
 * 的东西跑起来才崩（内核拿到的号或实参不对），离病根隔着链接与装载两层。所以这儿钉的是
 * **发出来的字节**：两个内核 ABI 里「号进哪个寄存器、实参进哪几个」是死的，
 * x86_64 是 rax + rdi/rsi/rdx/r10/r8/r9 加一条 `0f 05`，arm64 是 x8 + x0-x5 加一条
 * `svc #0`（`d4000001`）。
 *
 * 跑起来那一半在 `tests/x64/docker-run.sh` 的第 8 笔账里（这台机器是 macOS，
 * Linux 的二进制在这儿跑不了）。
 *
 *   node tests/c/syscall.js
 */

import { lowerCNative } from '../../src/core/frontend-c/tccgen.js';
import { verifyMir } from '../../src/core/mir/verify.js';
import { codeOf } from '../../src/core/x64/from_mir.js';
import { codeOfArm64 } from '../../src/core/arm64/from_mir.js';
import { OmniError } from '../../src/core/source/diag.js';

let pass = 0;
let fail = 0;
const ok = (what) => { pass++; process.stdout.write(`  ok   ${what}\n`); };
const bad = (what, got, want) => {
  fail++;
  process.stdout.write(`  FAIL ${what}\n    got  ${got}\n    want ${want}\n`);
};
const eq = (what, got, want) => {
  if (String(got) === String(want)) ok(what); else bad(what, got, want);
};
const has = (what, hay, needle) => {
  if (String(hay).includes(needle)) ok(what);
  else bad(what, `找不到 ${needle}`, `${String(hay).slice(0, 200)}…`);
};

const hex = (bytes) => Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');

/** 一段 C 里那个函数 `f` 的机器码，十六进制。 */
function textHex(src, arch) {
  const host = { arch, os: 'linux' };
  const mod = lowerCNative('/t.c', src, host, []).mod;
  const errs = verifyMir(mod);
  if (errs.length !== 0) throw new OmniError(`mir 不良构：${errs.join('；')}`);
  const fn = mod.funcs.find((x) => x.name === 'f');
  return hex(arch === 'x86_64' ? codeOf(mod, fn) : codeOfArm64(mod, fn));
}

const WRITE = `
void f(void) {
  __omni_syscall(1, 1, 0, 3);
}
`;

/* ---- x86_64：号进 rax（`48 c7 c0 01`）、实参进 rdi/rsi/rdx（`c7 c7` / `c7 c6` / `c7 c2`），
 * 一条 `0f 05`。摆号那一条在最后 —— rax 也是结果寄存器，中间任何一步都可能拿它当落点。 */
const X = textHex(WRITE, 'x86_64');
has('x86_64：一条 syscall（0f 05）', X, '0f 05');
has('x86_64：第一个实参进 rdi', X, '48 c7 c7 01 00 00 00');
has('x86_64：第三个实参进 rdx', X, '48 c7 c2 03 00 00 00');
has('x86_64：号在 rax 上、紧挨着那条 syscall', X, '48 c7 c0 01 00 00 00 0f 05');

/* 第四个实参走 **r10**（`49 c7 c2`）而不是 rcx（`48 c7 c1`）—— `syscall` 自己要用 rcx
 * 装返回地址，这一格是内核 ABI 与 SysV 唯一不同的地方，最值得钉。 */
const X4 = textHex(`
void f(void) {
  __omni_syscall(72, 1, 2, 3, 4);
}
`, 'x86_64');
has('x86_64：第四个实参进 r10（不是 rcx）', X4, '49 c7 c2 04 00 00 00');
eq('x86_64：一条 rcx 的 mov 都没有', X4.includes('48 c7 c1'), false);

/* ---- arm64：号进 x8、实参进 x0-x5，一条 `svc #0`（小端 `01 00 00 d4`）。 */
const A = textHex(WRITE, 'arm64');
has('arm64：一条 svc #0（01 00 00 d4）', A, '01 00 00 d4');

/* ---- `__builtin_frame_address(0)`（第二格）：x86_64 上就是 rbp 那一个字。
 * crt 靠它把内核放在栈上的 argc/argv 找回来（`[rbp+8]` 是 argc）—— 所以这儿钉
 * 「真的读了 rbp」而不是别的寄存器。 */
const FA = textHex(`
void *f(void) {
  return __builtin_frame_address(0);
}
`, 'x86_64');
has('x86_64：frame_address 就是一句 mov rax, rbp', FA, '48 89 e8');

/* 层数 > 0 与非常量都明着报错（tcc 那边爬得上去，我们只有 crt 一个用户）。 */
let lvErr = '';
try {
  textHex('void *f(void) { return __builtin_frame_address(1); }', 'x86_64');
} catch (e) { lvErr = String(e.message ?? e); }
has('层数不是 0 就报错', lvErr, '只认 0');

/* ---- 目标是 macOS 时不给（那边 BSD 的约定是另一件事：号带类别位、出错看进位标志）。 */
let osxErr = '';
try {
  textHex(WRITE, 'arm64');   // linux，通过
  lowerCNative('/t.c', WRITE, { arch: 'arm64', os: 'osx' }, []);
} catch (e) { osxErr = String(e.message ?? e); }
has('osx 目标上明着报错', osxErr, '只有 linux 目标有');

/* ---- 解释器那条腿（线性内存）也不给：那边 libc 是宿主的 JS，没有内核可谈。 */
let interpErr = '';
try {
  const { lowerC } = await import('../../src/core/frontend-c/tccgen.js');
  lowerC('/t.c', WRITE, { arch: 'x86_64', os: 'linux' }, []);
} catch (e) { interpErr = String(e.message ?? e); }
has('解释器那条腿上明着报错', interpErr, '只有 native');

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
