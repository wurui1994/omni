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

/** 一段 C 里那个函数 `f` 的机器码，十六进制。`os` 默认 linux（`SYSCALL` 看它分岔）。 */
function textHex(src, arch, os) {
  const host = { arch, os: os === undefined ? 'linux' : os };
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

/* ---- `setjmp`/`longjmp` 那两条（第三格）。行为对不对在容器里量（与 glibc 逐行相同），
 * 这儿钉两件只看字节就能钉住的事：`LONGJMP` 收尾是一句 `jmp r11`（`41 ff e3` —— 落点
 * 必须**先**取进草稿，因为它后面那两条要改 rbp 与 rsp），以及这条腿之外明着报错。 */
const LJ = textHex(`
void f(void *env) {
  __omni_longjmp(env, 7);
}
`, 'x86_64');
has('x86_64：longjmp 收尾是 jmp r11', LJ, '41 ff e3');
const SJ = textHex(`
int f(void *env) {
  return __omni_setjmp(env);
}
`, 'x86_64');
has('x86_64：setjmp 头一条是 mov [r10], rbx', SJ, '49 89 1a');
has('x86_64：setjmp 存了返回地址（[rbp+8] -> [r10+56]）', SJ, '4c 8b 5d 08 4d 89 5a 38');

/* arm64 上这两条存的是另一套（x19-x28 与 d8-d15，AAPCS64 的被调用者保存那一串），
 * 布局与字节都钉住 —— 行为对不对在本机量（探子与 Apple 的 libc 逐行相同），这儿钉的是
 * 「存了哪几个、次序对不对」：
 *   x19 起头（`str x19, [x9]`）、d8 落在 +80（`str d8, [x9, #80]`）、
 *   调用者的 x29 / sp / 返回地址依次进 +144 / +152 / +160。 */
const SJ64 = textHex('int f(void *e) { return __omni_setjmp(e); }', 'arm64', 'osx');
has('arm64：setjmp 头一条是 str x19, [x9]', SJ64, '33 01 00 f9');
has('arm64：d8 存在 +80（str d8, [x9, #80]）', SJ64, '28 29 00 fd');
has('arm64：调用者的 x29 -> +144', SJ64, 'aa 03 40 f9 2a 49 00 f9');
has('arm64：调用者的 sp（x29+16）-> +152', SJ64, 'aa 43 00 91 2a 4d 00 f9');
has('arm64：返回地址（[x29+8]）-> +160', SJ64, 'aa 07 40 f9 2a 51 00 f9');

/* `LONGJMP`：值先算（0 换成 1 是一条 `csinc x0, x10, xzr, ne`），落在 **x0** 而不是
 * x8 —— 落点是调用者那条 `bl` 的下一条，它按 ABI 从 x0 取返回值。量到过：写到 x8 上
 * 的那一版控制流全对、`setjmp` 却回了个地址（47923552）。
 * 收尾三条读完才 `mov sp, x30`，最后 `br x10`。 */
const LJ64 = textHex('void f(void *e) { __omni_longjmp(e, 7); }', 'arm64', 'osx');
has('arm64：0 换成 1 是 csinc x0, x10, xzr, ne（落在 x0）', LJ64, '5f 01 00 f1 40 15 9f 9a');
has('arm64：落点/sp/x29 三条读完才 mov sp（最后 br x10）', LJ64,
  '2a 51 40 f9 3e 4d 40 f9 3d 49 40 f9 df 03 00 91 40 01 1f d6');

/* ---- Darwin（arm64-osx）那一套：号进 **x16**、`svc #0x80`，而且出错是**置进位标志**、
 * x0 里放**正的** errno。op 的约定只有「回负数就是 -errno」，所以后端要多一条
 * `cneg x0, x0, cs` 把进位折进符号 —— 少了它，`open("/nope")` 回的 2 长得跟 fd 2
 * 一模一样。三条都钉住（`mod.os` 那一格就是为这儿立的）。 */
const OSX = textHex(`
void f(void) {
  __omni_syscall(4, 1, 0, 3);
}
`, 'arm64', 'osx');
has('osx：号进 x16（movz x16, #4）', OSX, '90 00 80 d2');
has('osx：svc #0x80', OSX, '01 10 00 d4');
has('osx：紧跟一条 cneg x0, x0, cs（把进位折进符号）', OSX, '01 10 00 d4 00 34 80 da');
has('linux：还是 svc #0（不带 0x80）', textHex(WRITE, 'arm64'), '01 00 00 d4');

/* ---- `SYSCALL2`（第六格）：Darwin 的 `fork` 与 `pipe` 交回**两个**寄存器 —— x0 是
 * pid / 头一个 fd，x1 是「我是不是子进程」/ 第二个 fd。只看 x0 的话父子都以为自己是父
 * （量到过：`system("true")` 之后探子的后四行印了两遍）。所以这一条多两步收尾：
 * 把池的第一格（「x1 写到哪儿」的地址）取进 x9、一条 `str x1, [x9]`，**再**折进位。
 * 次序要钉：`cneg` 只动 x0，可要是先折了再存，读这段代码的人就得自己推一遍 x1 有没有被动。 */
const S2 = textHex(`
int f(void) {
  long c = 0;
  return (int)__omni_syscall2(0x2000002, (long)&c);
}
`, 'arm64', 'osx');
has('osx：syscall2 的号照旧进 x16（movz x16, #2 + movk 0x200）', S2, '50 00 80 d2 10 40 a0 f2');
has('osx：svc #0x80 之后先取地址、再 str x1, [x9]', S2, '01 10 00 d4 e9 03 40 f9 21 01 00 f9');
has('osx：存完 x1 才折进位（cneg 在最后）', S2, '21 01 00 f9 00 34 80 da');

/* 池是空的（一个实参都没给，连「写到哪儿」都没有）明着报错 —— 这一格错了症状是
 * 往地址 0 上写，离病根隔着一次段错。 */
let s2Err = '';
try {
  textHex('int f(void) { return (int)__omni_syscall2(2); }', 'arm64', 'osx');
} catch (e) { s2Err = String(e.message ?? e); }
has('syscall2 少了「第二个返回值写到哪儿」就报错', s2Err, 'syscall2');

/* x86_64 上明着不给：第二个回值该是 rdx，但只有 Darwin 用得上它，而这条腿只有
 * x86_64-linux（那边 `fork` 只交回 rax、`pipe2` 写用户给的数组）。 */
let s2x = '';
try {
  textHex('int f(void) { long c = 0; return (int)__omni_syscall2(57, (long)&c); }', 'x86_64');
} catch (e) { s2x = String(e.message ?? e); }
has('x86_64 上 SYSCALL2 明着报错', s2x, 'SYSCALL2');

/* 别的目标（win32）上仍旧明着报错。 */
let winErr = '';
try {
  lowerCNative('/t.c', WRITE, { arch: 'x86_64', os: 'win32' }, []);
} catch (e) { winErr = String(e.message ?? e); }
has('win32 目标上明着报错', winErr, '只有 linux 与 osx 有');

/* ---- 解释器那条腿（线性内存）也不给：那边 libc 是宿主的 JS，没有内核可谈。 */
let interpErr = '';
try {
  const { lowerC } = await import('../../src/core/frontend-c/tccgen.js');
  lowerC('/t.c', WRITE, { arch: 'x86_64', os: 'linux' }, []);
} catch (e) { interpErr = String(e.message ?? e); }
has('解释器那条腿上明着报错', interpErr, '只有 native');

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
