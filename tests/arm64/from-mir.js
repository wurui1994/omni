/* MIR -> arm64 的对账（ADR-0017 第 10 步，第九刀第四片）。
 *
 * 这一套用例不比字节，**比结果**：把生成的机器码用 `.incbin` 塞进一个 `.s` 里当函数体，
 * 与一个 C 的 `main` 一起交给 clang 链接，跑起来把返回值印出来，与 JS 里用 BigInt
 * 算的期望值比。
 *
 * 为什么要这么绕：这一层的错（帧算错了、符号扩展漏了、条件码接反了）在反汇编上
 * 看着全对，只有**跑一遍**才现形。第九刀第三片之前不能这么做（没有回填），
 * 第十一片之后会更省事（有了目标文件与链接器就不用 `.incbin` 了）。
 *
 * 跑法：`node tests/arm64/from-mir.js`
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MirModule, MirFunc, OP, REF_NONE, T_I64, T_I32, T_BOOL, T_VOID, T_F64,
  CVT_SEXT8, CVT_SEXT16, CVT_TRUNC, CVT_ZEXT,
} from '../../stage0/src/mir/ir.js';
import { codeOf } from '../../stage0/src/arm64/from_mir.js';

const mod = new MirModule('main');
const K = mod.consts;

/** 一个「收两个 long long、回一个 long long」的函数。`body(f, x, y)` 里 x/y 是槽号。 */
function fn(name, body) {
  const f = new MirFunc(name, [], T_I64);
  const sx = f.slot('x', T_I64);
  const sy = f.slot('y', T_I64);
  f.params.push({ name: 'x', t: T_I64, slot: sx });
  f.params.push({ name: 'y', t: T_I64, slot: sy });
  body(f, sx, sy);
  return f;
}

const ld = (f, t, slot) => f.emit(OP.LOAD, t, REF_NONE, REF_NONE, slot);
const ret = (f, t, v) => f.emit(OP.RET, t, v, REF_NONE, 0);

/** @type {{f:MirFunc, args:[bigint,bigint], want:bigint, what:string}[]} */
const cases = [];
let no = 0;
function t(what, args, want, body) {
  const f = fn(`omni_t${no}`, body);
  no++;
  cases.push({ f, args, want, what });
}

// ---- 二目：i64
t('i64 加', [7n, 35n], 42n, (f, x, y) =>
  ret(f, T_I64, f.emit(OP.ADD, T_I64, ld(f, T_I64, x), ld(f, T_I64, y), 0)));
t('i64 减', [7n, 35n], -28n, (f, x, y) =>
  ret(f, T_I64, f.emit(OP.SUB, T_I64, ld(f, T_I64, x), ld(f, T_I64, y), 0)));
t('i64 乘', [-6n, 7n], -42n, (f, x, y) =>
  ret(f, T_I64, f.emit(OP.MUL, T_I64, ld(f, T_I64, x), ld(f, T_I64, y), 0)));
t('i64 除（向零）', [-7n, 2n], -3n, (f, x, y) =>
  ret(f, T_I64, f.emit(OP.DIV, T_I64, ld(f, T_I64, x), ld(f, T_I64, y), 0)));
t('i64 取余（跟着被除数的符号）', [-7n, 2n], -1n, (f, x, y) =>
  ret(f, T_I64, f.emit(OP.MOD, T_I64, ld(f, T_I64, x), ld(f, T_I64, y), 0)));
t('u64 除', [-1n, 2n], 0x7fffffffffffffffn, (f, x, y) =>
  ret(f, T_I64, f.emit(OP.UDIV, T_I64, ld(f, T_I64, x), ld(f, T_I64, y), 0)));
t('u64 取余', [-1n, 10n], 5n, (f, x, y) =>
  ret(f, T_I64, f.emit(OP.UMOD, T_I64, ld(f, T_I64, x), ld(f, T_I64, y), 0)));
t('i64 左移', [1n, 40n], 1n << 40n, (f, x, y) =>
  ret(f, T_I64, f.emit(OP.SHL, T_I64, ld(f, T_I64, x), ld(f, T_I64, y), 0)));
t('i64 算术右移', [-8n, 1n], -4n, (f, x, y) =>
  ret(f, T_I64, f.emit(OP.SHR, T_I64, ld(f, T_I64, x), ld(f, T_I64, y), 0)));
t('i64 逻辑右移', [-8n, 1n], (2n ** 64n - 8n) >> 1n, (f, x, y) =>
  ret(f, T_I64, f.emit(OP.USHR, T_I64, ld(f, T_I64, x), ld(f, T_I64, y), 0)));
t('i64 与或异或', [0xf0f0n, 0x0ff0n], 0x00f0n | 0xfff0n | 0xff00n, (f, x, y) => {
  const lx = ld(f, T_I64, x);
  const ly = ld(f, T_I64, y);
  const and = f.emit(OP.BAND, T_I64, lx, ly, 0);
  const or = f.emit(OP.BOR, T_I64, lx, ly, 0);
  const xor = f.emit(OP.BXOR, T_I64, lx, ly, 0);
  ret(f, T_I64, f.emit(OP.BOR, T_I64, f.emit(OP.BOR, T_I64, and, or, 0), xor, 0));
});

// ---- 单目
t('取负与按位取反', [5n, 0n], -5n + -6n, (f, x) => {
  const lx = ld(f, T_I64, x);
  const n = f.emit(OP.NEG, T_I64, lx, REF_NONE, 0);
  const b = f.emit(OP.BNOT, T_I64, lx, REF_NONE, 0);
  ret(f, T_I64, f.emit(OP.ADD, T_I64, n, b, 0));
});

// ---- i32：结果要回到「符号扩展过的 64 位」这个规范形
t('i32 乘要回绕', [100000n, 100000n], 1410065408n, (f, x, y) => {
  const lx = f.emit(OP.CVT, T_I32, ld(f, T_I64, x), REF_NONE, CVT_TRUNC);
  const ly = f.emit(OP.CVT, T_I32, ld(f, T_I64, y), REF_NONE, CVT_TRUNC);
  ret(f, T_I64, f.emit(OP.MUL, T_I32, lx, ly, 0));
});
t('i32 逻辑右移看的是 32 位', [-8n, 1n], 2147483644n, (f, x, y) => {
  const lx = f.emit(OP.CVT, T_I32, ld(f, T_I64, x), REF_NONE, CVT_TRUNC);
  const ly = f.emit(OP.CVT, T_I32, ld(f, T_I64, y), REF_NONE, CVT_TRUNC);
  ret(f, T_I64, f.emit(OP.USHR, T_I32, lx, ly, 0));
});
t('i32 除是 32 位的除', [-2147483648n, -1n], -2147483648n, (f, x, y) => {
  const lx = f.emit(OP.CVT, T_I32, ld(f, T_I64, x), REF_NONE, CVT_TRUNC);
  const ly = f.emit(OP.CVT, T_I32, ld(f, T_I64, y), REF_NONE, CVT_TRUNC);
  ret(f, T_I64, f.emit(OP.DIV, T_I32, lx, ly, 0));
});

// ---- 宽度转换
t('零扩展抹掉高 32 位', [-1n, 0n], 0xffffffffn, (f, x) =>
  ret(f, T_I64, f.emit(OP.CVT, T_I64, ld(f, T_I64, x), REF_NONE, CVT_ZEXT)));
t('低 8 位符号扩展', [255n, 0n], -1n, (f, x) =>
  ret(f, T_I64, f.emit(OP.CVT, T_I64, ld(f, T_I64, x), REF_NONE, CVT_SEXT8)));
t('低 16 位符号扩展', [0x8000n, 0n], -32768n, (f, x) =>
  ret(f, T_I64, f.emit(OP.CVT, T_I64, ld(f, T_I64, x), REF_NONE, CVT_SEXT16)));

// ---- 比较：有符号与无符号要分得开
for (const [nm, op, args, want] of [
  ['小于（有符号）', OP.LT, [-1n, 1n], 1n],
  ['小于（无符号）', OP.ULT, [-1n, 1n], 0n],
  ['大等（无符号）', OP.UGE, [-1n, 1n], 1n],
  ['相等', OP.EQ, [42n, 42n], 1n],
  ['不等', OP.NE, [42n, 42n], 0n],
  ['大于', OP.GT, [3n, 2n], 1n],
  ['小等', OP.LE, [3n, 2n], 0n],
  ['大等（无符号，相等）', OP.UGT, [2n, 2n], 0n],
]) {
  t(`比较：${nm}`, args, want, (f, x, y) =>
    ret(f, T_I64, f.emit(op, T_I64, ld(f, T_I64, x), ld(f, T_I64, y), 0)));
}
t('逻辑非', [0n, 1n], 1n, (f, x, y) => {
  const c = f.emit(OP.EQ, T_I64, ld(f, T_I64, x), ld(f, T_I64, y), 0);
  ret(f, T_I64, f.emit(OP.NOT, T_BOOL, c, REF_NONE, 0));
});

// ---- 控制流
t('if / else', [5n, 3n], 100n, (f, x, y) => {
  const s = f.slot('r', T_I64);
  const c = f.emit(OP.GT, T_I64, ld(f, T_I64, x), ld(f, T_I64, y), 0);
  f.emit(OP.IF, T_VOID, c, REF_NONE, 0);
  f.emit(OP.STORE, T_I64, K.int(100n), REF_NONE, s);
  f.emit(OP.ELSE, T_VOID, REF_NONE, REF_NONE, 0);
  f.emit(OP.STORE, T_I64, K.int(200n), REF_NONE, s);
  f.emit(OP.END, T_VOID, REF_NONE, REF_NONE, 0);
  ret(f, T_I64, ld(f, T_I64, s));
});
t('if 没有 else，条件假就落到底', [1n, 3n], 7n, (f, x, y) => {
  const s = f.slot('r', T_I64);
  f.emit(OP.STORE, T_I64, K.int(7n), REF_NONE, s);
  const c = f.emit(OP.GT, T_I64, ld(f, T_I64, x), ld(f, T_I64, y), 0);
  f.emit(OP.IF, T_VOID, c, REF_NONE, 0);
  f.emit(OP.STORE, T_I64, K.int(9n), REF_NONE, s);
  f.emit(OP.END, T_VOID, REF_NONE, REF_NONE, 0);
  ret(f, T_I64, ld(f, T_I64, s));
});
t('循环：1 加到 n', [10n, 0n], 55n, (f, x) => {
  const ss = f.slot('sum', T_I64);
  const si = f.slot('i', T_I64);
  f.emit(OP.STORE, T_I64, K.int(0n), REF_NONE, ss);
  f.emit(OP.STORE, T_I64, K.int(1n), REF_NONE, si);
  f.emit(OP.BLOCK, T_VOID, REF_NONE, REF_NONE, 0);
  f.emit(OP.LOOP, T_VOID, REF_NONE, REF_NONE, 0);
  const over = f.emit(OP.GT, T_I64, ld(f, T_I64, si), ld(f, T_I64, x), 0);
  f.emit(OP.BRIF, T_VOID, over, REF_NONE, 1);           // 出 BLOCK
  f.emit(OP.STORE, T_I64,
    f.emit(OP.ADD, T_I64, ld(f, T_I64, ss), ld(f, T_I64, si), 0), REF_NONE, ss);
  f.emit(OP.STORE, T_I64,
    f.emit(OP.ADD, T_I64, ld(f, T_I64, si), K.int(1n), 0), REF_NONE, si);
  f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, 0);         // 回 LOOP 头
  f.emit(OP.END, T_VOID, REF_NONE, REF_NONE, 0);
  f.emit(OP.END, T_VOID, REF_NONE, REF_NONE, 0);
  ret(f, T_I64, ld(f, T_I64, ss));
});
t('两层循环里往外跳两层', [4n, 5n], 20n, (f, x, y) => {
  const ss = f.slot('sum', T_I64);
  const si = f.slot('i', T_I64);
  const sj = f.slot('j', T_I64);
  f.emit(OP.STORE, T_I64, K.int(0n), REF_NONE, ss);
  f.emit(OP.STORE, T_I64, K.int(0n), REF_NONE, si);
  f.emit(OP.BLOCK, T_VOID, REF_NONE, REF_NONE, 0);      // 外 break
  f.emit(OP.LOOP, T_VOID, REF_NONE, REF_NONE, 0);       // 外循环
  const io = f.emit(OP.GE, T_I64, ld(f, T_I64, si), ld(f, T_I64, x), 0);
  f.emit(OP.BRIF, T_VOID, io, REF_NONE, 1);
  f.emit(OP.STORE, T_I64, K.int(0n), REF_NONE, sj);
  f.emit(OP.BLOCK, T_VOID, REF_NONE, REF_NONE, 0);      // 内 break
  f.emit(OP.LOOP, T_VOID, REF_NONE, REF_NONE, 0);       // 内循环
  const jo = f.emit(OP.GE, T_I64, ld(f, T_I64, sj), ld(f, T_I64, y), 0);
  f.emit(OP.BRIF, T_VOID, jo, REF_NONE, 1);
  f.emit(OP.STORE, T_I64,
    f.emit(OP.ADD, T_I64, ld(f, T_I64, ss), K.int(1n), 0), REF_NONE, ss);
  f.emit(OP.STORE, T_I64,
    f.emit(OP.ADD, T_I64, ld(f, T_I64, sj), K.int(1n), 0), REF_NONE, sj);
  f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, 0);
  f.emit(OP.END, T_VOID, REF_NONE, REF_NONE, 0);
  f.emit(OP.END, T_VOID, REF_NONE, REF_NONE, 0);
  f.emit(OP.STORE, T_I64,
    f.emit(OP.ADD, T_I64, ld(f, T_I64, si), K.int(1n), 0), REF_NONE, si);
  f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, 0);
  f.emit(OP.END, T_VOID, REF_NONE, REF_NONE, 0);
  f.emit(OP.END, T_VOID, REF_NONE, REF_NONE, 0);
  ret(f, T_I64, ld(f, T_I64, ss));
});
t('中途 return', [1n, 2n], 11n, (f) => {
  ret(f, T_I64, K.int(11n));
  ret(f, T_I64, K.int(22n));
});

// ---------------------------------------------------------------- 边界
// 还没做的东西必须**明着报**。一个悄悄发错指令的后端比一个报错的后端坏得多。
let bad = 0;
for (const [what, build] of [
  ['浮点', (f) => { const l = ld(f, T_I64, 0); ret(f, T_I64, f.emit(OP.ADD, T_F64, l, l, 0)); }],
  ['调用', (f) => { ret(f, T_I64, f.emit(OP.CALL, T_I64, 0, f.pushArgs([]), 0)); }],
  ['线性内存', (f) => { ret(f, T_I64, f.emit(OP.MLOAD, T_I64, ld(f, T_I64, 0), REF_NONE, 6)); }],
  ['槽号越界', (f) => { ret(f, T_I64, ld(f, T_I64, 99)); }],
]) {
  const f = fn(`omni_bad_${bad}`, build);
  let threw = false;
  try { codeOf(mod, f); } catch { threw = true; }
  if (!threw) {
    process.stdout.write(`  FAIL 「${what}」还没做，可是没报错\n`);
    process.exitCode = 1;
  }
  bad++;
}

// ---------------------------------------------------------------- 跑
const CLANG = ['/usr/bin/clang', '/opt/homebrew/opt/llvm/bin/clang'].find((p) => existsSync(p));
if (CLANG === undefined) {
  process.stdout.write('arm64/from-mir: 没找到 clang，跳过\n');
  process.exit(0);
}
if (process.arch !== 'arm64') {
  process.stdout.write(`arm64/from-mir: 这台机器是 ${process.arch}，跑不了 arm64 码，跳过\n`);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'omni-frommir-'));
let failed = 0;
try {
  const stub = ['.text'];
  const main = ['#include <stdio.h>'];
  const calls = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const bin = join(dir, `f${i}.bin`);
    writeFileSync(bin, codeOf(mod, c.f));
    stub.push('.p2align 2', `.global _${c.f.name}`, `_${c.f.name}:`, `.incbin "${bin}"`);
    main.push(`extern long long ${c.f.name}(long long, long long);`);
    calls.push(`  printf("%lld\\n", ${c.f.name}(${c.args[0]}LL, ${c.args[1]}LL));`);
  }
  main.push('int main(void) {', ...calls, '  return 0;', '}');
  writeFileSync(join(dir, 'stub.s'), stub.join('\n') + '\n');
  writeFileSync(join(dir, 'main.c'), main.join('\n') + '\n');
  execFileSync(CLANG, ['-o', join(dir, 'prog'), join(dir, 'main.c'), join(dir, 'stub.s')]);
  const out = execFileSync(join(dir, 'prog'), { encoding: 'utf8' }).trim().split('\n');
  if (out.length !== cases.length) {
    process.stdout.write(`arm64/from-mir: 印了 ${out.length} 行，用例 ${cases.length} 条\n`);
    process.exit(1);
  }
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    if (BigInt(out[i]) === c.want) continue;
    failed++;
    process.stdout.write(`  FAIL ${c.what}\n    ours ${out[i]}\n    want ${c.want}\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${cases.length - failed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
