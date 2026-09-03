/* MIR -> x86_64 的对账（第九刀第十六片）。
 *
 * 与 arm64 那一份（`tests/arm64/from-mir.js`）同一个验法，也是同一个梯子的最后一格：
 * **生成 -> 写 .o -> 链接 -> 在真机器上跑 -> 对结果**。Apple Silicon 上 x86_64 那条腿
 * 靠 `clang -arch x86_64` 加 Rosetta。
 *
 * 用例挑的是「两条腿容易不一样」的地方：除法与取余（x86 要 `cqo`、商在 rax 余数在 rdx）、
 * 移位（只认 `cl`）、无符号比较、浮点比较遇上 NaN、变参调用的 `al`、i32 的规范形。
 *
 * 跑法：`node tests/x64/from-mir.js`
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MirModule, MirFunc, OP, REF_NONE, T_I64, T_I32, T_BOOL, T_F64, T_F32,
  CVT_SEXT8, CVT_SEXT16, CVT_TRUNC, CVT_ZEXT,
  CVT_I2F, CVT_U2F, CVT_F2I, CVT_FCVT, CVT_BITCAST, memDesc,
} from '../../stage0/src/mir/ir.js';
import { codeOf, genModule } from '../../stage0/src/x64/from_mir.js';
import { f80Bytes } from '../../stage0/src/frontend-c/f80.js';
import { writeObject } from '../../stage0/src/link/macho.js';
import { utf8Bytes } from '../../stage0/src/host/utf8.js';

const mod = new MirModule('main');
const K = mod.consts;

function mkFunc(m, name, nparams, body, pt) {
  const ty = pt === undefined ? T_I64 : pt;
  const f = new MirFunc(name, [], ty);
  const slots = [];
  for (let i = 0; i < nparams; i++) {
    const s = f.slot(`p${i}`, ty);
    f.params.push({ name: `p${i}`, t: ty, slot: s });
    slots.push(s);
  }
  const no = m.addFunc(f);
  body(f, slots, no);
  return f;
}

const fn = (name, body) => mkFunc(mod, name, 2, (f, s, no) => body(f, s[0], s[1], no));
const ld = (f, t, slot) => f.emit(OP.LOAD, t, REF_NONE, REF_NONE, slot);
const ret = (f, t, v) => f.emit(OP.RET, t, v, REF_NONE, 0);

const cases = [];
let no = 0;
function t(what, args, want, body) {
  const f = fn(`omni_t${no}`, body);
  no++;
  cases.push({ f, args, want, what });
}

// ---- 二目：i64
const bin2 = (op, t2) => (f, xs, ys) =>
  ret(f, t2, f.emit(op, t2, ld(f, t2, xs), ld(f, t2, ys), 0));
t('i64 加', [7n, 35n], 42n, bin2(OP.ADD, T_I64));
t('i64 减', [7n, 35n], -28n, bin2(OP.SUB, T_I64));
t('i64 乘', [-6n, 7n], -42n, bin2(OP.MUL, T_I64));
/* 除法这一族在 x86 上要 `cqo` 铺符号、商在 rax、余数在 rdx —— 四条各一个用例。 */
t('i64 除（向零）', [-7n, 2n], -3n, bin2(OP.DIV, T_I64));
t('i64 取余（跟着被除数的符号）', [-7n, 2n], -1n, bin2(OP.MOD, T_I64));
t('u64 除', [-1n, 2n], 0x7fffffffffffffffn, bin2(OP.UDIV, T_I64));
t('u64 取余', [-1n, 3n], 0n, bin2(OP.UMOD, T_I64));
/* 移位数只认 `cl` —— 这三条查的是「有没有把它搬进 rcx」。 */
t('左移', [1n, 40n], 0x10000000000n, bin2(OP.SHL, T_I64));
t('算术右移（保号）', [-16n, 2n], -4n, bin2(OP.SHR, T_I64));
t('逻辑右移', [-1n, 60n], 15n, bin2(OP.USHR, T_I64));
t('与', [0xff0fn, 0x0ff0n], 0x0f00n, bin2(OP.BAND, T_I64));
t('或', [0xff00n, 0x00ffn], 0xffffn, bin2(OP.BOR, T_I64));
t('异或', [0xff0fn, 0x0ff0n], 0xf0ffn, bin2(OP.BXOR, T_I64));

// ---- 单目
t('取负', [42n, 0n], -42n, (f, xs) =>
  ret(f, T_I64, f.emit(OP.NEG, T_I64, ld(f, T_I64, xs), REF_NONE, 0)));
t('按位取反', [0n, 0n], -1n, (f, xs) =>
  ret(f, T_I64, f.emit(OP.BNOT, T_I64, ld(f, T_I64, xs), REF_NONE, 0)));
t('逻辑非', [0n, 1n], 1n, (f, xs, ys) => {
  const e = f.emit(OP.EQ, T_I64, ld(f, T_I64, xs), ld(f, T_I64, ys), 0);
  ret(f, T_I64, f.emit(OP.NOT, T_BOOL, e, REF_NONE, 0));
});

// ---- i32：规范形是**符号扩展过的 64 位**，所以每条 32 位运算之后都要补一条 movslq
t('i32 加会溢出回绕', [0x7fffffffn, 1n], -2147483648n, (f, xs, ys) => {
  const a1 = f.emit(OP.CVT, T_I32, ld(f, T_I64, xs), REF_NONE, CVT_TRUNC);
  const b1 = f.emit(OP.CVT, T_I32, ld(f, T_I64, ys), REF_NONE, CVT_TRUNC);
  ret(f, T_I64, f.emit(OP.ADD, T_I32, a1, b1, 0));
});
t('i32 除', [-7n, 2n], -3n, (f, xs, ys) => {
  const a1 = f.emit(OP.CVT, T_I32, ld(f, T_I64, xs), REF_NONE, CVT_TRUNC);
  const b1 = f.emit(OP.CVT, T_I32, ld(f, T_I64, ys), REF_NONE, CVT_TRUNC);
  ret(f, T_I64, f.emit(OP.DIV, T_I32, a1, b1, 0));
});
t('i32 零扩展（高位要抹掉，而 and 的立即数是符号扩展的）', [-1n, 0n], 4294967295n, (f, xs) =>
  ret(f, T_I64, f.emit(OP.CVT, T_I64, ld(f, T_I64, xs), REF_NONE, CVT_ZEXT)));
t('八位符号扩展', [0xffn, 0n], -1n, (f, xs) =>
  ret(f, T_I64, f.emit(OP.CVT, T_I64, ld(f, T_I64, xs), REF_NONE, CVT_SEXT8)));
t('十六位符号扩展', [0x8000n, 0n], -32768n, (f, xs) =>
  ret(f, T_I64, f.emit(OP.CVT, T_I64, ld(f, T_I64, xs), REF_NONE, CVT_SEXT16)));

// ---- 比较：十条，无符号那四条尤其要看（`b`/`ae`/`be`/`a`）
const cmp = (op) => (f, xs, ys) =>
  ret(f, T_I64, f.emit(op, T_I64, ld(f, T_I64, xs), ld(f, T_I64, ys), 0));
t('等', [3n, 3n], 1n, cmp(OP.EQ));
t('不等', [3n, 3n], 0n, cmp(OP.NE));
t('小于', [-1n, 1n], 1n, cmp(OP.LT));
t('大于等于', [-1n, 1n], 0n, cmp(OP.GE));
t('小于等于', [1n, 1n], 1n, cmp(OP.LE));
t('大于', [2n, 1n], 1n, cmp(OP.GT));
t('无符号小于（-1 是最大的）', [-1n, 1n], 0n, cmp(OP.ULT));
t('无符号大于等于', [-1n, 1n], 1n, cmp(OP.UGE));
t('无符号小于等于', [1n, 1n], 1n, cmp(OP.ULE));
t('无符号大于', [-1n, 1n], 1n, cmp(OP.UGT));

// ---- 控制流
t('IF/ELSE', [5n, 3n], 5n, (f, xs, ys) => {
  const c = f.emit(OP.GT, T_I64, ld(f, T_I64, xs), ld(f, T_I64, ys), 0);
  f.emit(OP.IF, T_I64, c, REF_NONE, 0);
  f.emit(OP.STORE, T_I64, ld(f, T_I64, xs), REF_NONE, xs);
  f.emit(OP.ELSE, T_I64, REF_NONE, REF_NONE, 0);
  f.emit(OP.STORE, T_I64, ld(f, T_I64, ys), REF_NONE, xs);
  f.emit(OP.END, T_I64, REF_NONE, REF_NONE, 0);
  ret(f, T_I64, ld(f, T_I64, xs));
});
t('没有 ELSE 的 IF（条件假就落到 END）', [1n, 0n], 1n, (f, xs, ys) => {
  f.emit(OP.IF, T_I64, ld(f, T_I64, ys), REF_NONE, 0);
  f.emit(OP.STORE, T_I64, K.int(99n), REF_NONE, xs);
  f.emit(OP.END, T_I64, REF_NONE, REF_NONE, 0);
  ret(f, T_I64, ld(f, T_I64, xs));
});
/* 循环：`sum = 0; while (n > 0) { sum += n; n-- }`。BLOCK/LOOP/BRIF/BR 四样一齐。 */
t('循环累加', [5n, 0n], 15n, (f, xs, ys) => {
  f.emit(OP.STORE, T_I64, K.int(0n), REF_NONE, ys);
  f.emit(OP.BLOCK, T_I64, REF_NONE, REF_NONE, 0);
  f.emit(OP.LOOP, T_I64, REF_NONE, REF_NONE, 0);
  const done = f.emit(OP.LE, T_I64, ld(f, T_I64, xs), K.int(0n), 0);
  f.emit(OP.BRIF, T_I64, done, REF_NONE, 1);      // 往外两层 = 跳出 BLOCK
  f.emit(OP.STORE, T_I64,
    f.emit(OP.ADD, T_I64, ld(f, T_I64, ys), ld(f, T_I64, xs), 0), REF_NONE, ys);
  f.emit(OP.STORE, T_I64,
    f.emit(OP.SUB, T_I64, ld(f, T_I64, xs), K.int(1n), 0), REF_NONE, xs);
  f.emit(OP.BR, T_I64, REF_NONE, REF_NONE, 0);    // 回到 LOOP 的头
  f.emit(OP.END, T_I64, REF_NONE, REF_NONE, 0);
  f.emit(OP.END, T_I64, REF_NONE, REF_NONE, 0);
  ret(f, T_I64, ld(f, T_I64, ys));
});

// ---- 调用
{
  const triple = mkFunc(mod, 'omni_x_triple', 1, (f, s) =>
    ret(f, T_I64, f.emit(OP.MUL, T_I64, ld(f, T_I64, s[0]), K.int(3n), 0)));
  const tno = mod.funcs.indexOf(triple);
  t('模块内的调用', [5n, 1n], 16n, (f, xs, ys) => {
    const v = f.emit(OP.CALL, T_I64, tno, f.pushArgs([ld(f, T_I64, xs)]), 0);
    ret(f, T_I64, f.emit(OP.ADD, T_I64, v, ld(f, T_I64, ys), 0));
  });
}
t('调 libc 的 llabs', [-5n, 0n], 5n, (f, xs) =>
  ret(f, T_I64, f.emit(OP.CCALL, T_I64, mod.cabiNo('llabs'),
    f.pushArgs([ld(f, T_I64, xs)]), 0)));
t('六个整数实参（SysV 只有六个寄存器）', [1n, 2n], 21n, (f) =>
  ret(f, T_I64, f.emit(OP.CCALL, T_I64, mod.cabiNo('omni_ext_six'),
    f.pushArgs([K.int(1n), K.int(2n), K.int(3n), K.int(4n), K.int(5n), K.int(6n)]), 0)));
/* 再多一个就得由**调用方**摆到 rsp 上去。两条的期望值都是 Σ i·i（i = 1..10）= 385。 */
t('十个整数实参（后四个走栈）', [0n, 0n], 385n, (f) =>
  ret(f, T_I64, f.emit(OP.CCALL, T_I64, mod.cabiNo('omni_ext_ten'),
    f.pushArgs([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n].map((v) => K.int(v))), 0)));
t('十个 double 实参（后两个走栈）', [0n, 0n], 385n, (f) => {
  const d = f.emit(OP.CCALL, T_F64, mod.cabiNo('omni_ext_tend'),
    f.pushArgs(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].map((v) => K.real(v))), 0);
  ret(f, T_I64, f.emit(OP.CVT, T_I64, d, REF_NONE, CVT_F2I));
});

// ---- 浮点
function d2b(v) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, v, true);
  return dv.getBigUint64(0, true);
}
function f2b(v) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat32(0, v, true);
  return BigInt(dv.getUint32(0, true));
}

const dcases = [];
let dno = 0;
function td(what, args, want, body) {
  const f = mkFunc(mod, `omni_d${dno}`, 2, (fx, s) => body(fx, s[0], s[1]), T_F64);
  dno++;
  dcases.push({ f, args, want, what });
}
const fbin = (op) => (f, xs, ys) =>
  ret(f, T_F64, f.emit(op, T_F64, ld(f, T_F64, xs), ld(f, T_F64, ys), 0));
td('double 加', [1.5, 2.25], 3.75, fbin(OP.ADD));
td('double 减', [1.5, 2.25], -0.75, fbin(OP.SUB));
td('double 乘', [1.5, 2.25], 3.375, fbin(OP.MUL));
td('double 除', [1.5, 0.5], 3, fbin(OP.DIV));
td('double 取负', [2.5, 0], -2.5, (f, xs) =>
  ret(f, T_F64, f.emit(OP.NEG, T_F64, ld(f, T_F64, xs), REF_NONE, 0)));

/* 浮点比较：结果是 bool，用 `t` 那一批的形状不好传 double，所以单独一批
 * ——「两个 double 进、一个 long long 出」。NaN 那几条是这一批的重点。 */
const bcases = [];
let bno = 0;
function tb(what, args, want, body) {
  const f = new MirFunc(`omni_b${bno}`, [], T_I64);
  const s = [f.slot('p0', T_F64), f.slot('p1', T_F64)];
  f.params.push({ name: 'p0', t: T_F64, slot: s[0] });
  f.params.push({ name: 'p1', t: T_F64, slot: s[1] });
  mod.addFunc(f);
  body(f, s[0], s[1]);
  bno++;
  bcases.push({ f, args, want, what });
}
const fcmp = (op) => (f, xs, ys) =>
  ret(f, T_I64, f.emit(op, T_F64, ld(f, T_F64, xs), ld(f, T_F64, ys), 0));
tb('double 小于', [1.5, 2.5], 1n, fcmp(OP.LT));
tb('double 小于（反）', [2.5, 1.5], 0n, fcmp(OP.LT));
tb('double 小于等于（相等也算）', [1.5, 1.5], 1n, fcmp(OP.LE));
tb('double 大于', [2.5, 1.5], 1n, fcmp(OP.GT));
tb('double 大于等于', [1.5, 1.5], 1n, fcmp(OP.GE));
tb('double 相等', [1.5, 1.5], 1n, fcmp(OP.EQ));
tb('double 不等', [1.5, 2.5], 1n, fcmp(OP.NE));
/* NaN：除了 `!=` 之外**所有**比较都是假。照抄整数条件码会在这四条上错。 */
tb('NaN 小于是假', [NaN, 1.5], 0n, fcmp(OP.LT));
tb('NaN 小于等于是假', [NaN, 1.5], 0n, fcmp(OP.LE));
tb('NaN 大于是假', [NaN, 1.5], 0n, fcmp(OP.GT));
tb('NaN 相等是假', [NaN, NaN], 0n, fcmp(OP.EQ));
tb('NaN 不等是真', [NaN, NaN], 1n, fcmp(OP.NE));

// ---- 浮点与整数之间的转换
t('整数 -> double -> 整数', [7n, 2n], 3n, (f, xs, ys) => {
  const a1 = f.emit(OP.CVT, T_F64, ld(f, T_I64, xs), REF_NONE, CVT_I2F);
  const b1 = f.emit(OP.CVT, T_F64, ld(f, T_I64, ys), REF_NONE, CVT_I2F);
  const q = f.emit(OP.DIV, T_F64, a1, b1, 0);
  ret(f, T_I64, f.emit(OP.CVT, T_I64, q, REF_NONE, CVT_F2I));
});
t('浮点转整数是**向零**截断（2.7 -> 2）', [27n, 10n], 2n, (f, xs, ys) => {
  const a1 = f.emit(OP.CVT, T_F64, ld(f, T_I64, xs), REF_NONE, CVT_I2F);
  const b1 = f.emit(OP.CVT, T_F64, ld(f, T_I64, ys), REF_NONE, CVT_I2F);
  ret(f, T_I64, f.emit(OP.CVT, T_I64, f.emit(OP.DIV, T_F64, a1, b1, 0), REF_NONE, CVT_F2I));
});
t('无符号 32 位 -> double（x86 没有这条指令，要先零扩展）', [-1n, 0n], 4294967295n, (f, xs) => {
  const w = f.emit(OP.CVT, T_I32, ld(f, T_I64, xs), REF_NONE, CVT_TRUNC);
  const d = f.emit(OP.CVT, T_F64, w, REF_NONE, CVT_U2F);
  ret(f, T_I64, f.emit(OP.CVT, T_I64, d, REF_NONE, CVT_F2I));
});
t('double -> float -> double（精度会掉）', [0n, 0n], d2b(Math.fround(0.1)), (f) => {
  const s = f.emit(OP.CVT, T_F32, K.real('0.1'), REF_NONE, CVT_FCVT);
  const d = f.emit(OP.CVT, T_F64, s, REF_NONE, CVT_FCVT);
  ret(f, T_I64, f.emit(OP.CVT, T_I64, d, REF_NONE, CVT_BITCAST));
});
/* u64 -> double：x86 只有「有符号 -> 浮点」，64 位那一档得自己拼（`u64ToFloat`）。
 * 两条各查一头：最高位是 1 的那种（0xFFFF…F 收到 2^64），以及正好 2^63（精确）。 */
t('u64 -> double（最高位是 1，舍到 2^64）', [-1n, 0n], d2b(18446744073709551616), (f, xs) =>
  ret(f, T_I64, f.emit(OP.CVT, T_I64,
    f.emit(OP.CVT, T_F64, ld(f, T_I64, xs), REF_NONE, CVT_U2F), REF_NONE, CVT_BITCAST)));
t('u64 -> double（2^63 是精确的）', [-(2n ** 63n), 0n], d2b(9223372036854775808), (f, xs) =>
  ret(f, T_I64, f.emit(OP.CVT, T_I64,
    f.emit(OP.CVT, T_F64, ld(f, T_I64, xs), REF_NONE, CVT_U2F), REF_NONE, CVT_BITCAST)));
t('float 的算术只有单精度', [0n, 0n], f2b(Math.fround(0.1) + Math.fround(0.2)), (f) =>
  ret(f, T_I64, f.emit(OP.CVT, T_I64,
    f.emit(OP.ADD, T_F32, K.f32(String(Math.fround(0.1))), K.f32(String(Math.fround(0.2))), 0),
    REF_NONE, CVT_BITCAST)));

// ---- 变参调用：SysV 要 `al` = 用掉的 xmm 个数。少那一条，真机器上会崩。
t('变参调用（al 要报 xmm 的个数）', [0n, 0n], 4n, (f) => {
  const d = f.emit(OP.CCALL, T_F64, mod.cabiNo('omni_ext_vsum'),
    f.pushArgs([K.int(2n), K.real('1.5'), K.real('2.5')]), 0);
  ret(f, T_I64, f.emit(OP.CVT, T_I64, d, REF_NONE, CVT_F2I));
});

// ---- 存取：地址就是真指针
const mcases = [];
let mno = 0;
function tm(what, args, want, body) {
  const f = fn(`omni_m${mno}`, body);
  mno++;
  mcases.push({ f, args, want, what });
}
const LDK = { i8s: 0, i8u: 1, i16s: 2, i16u: 3, i32s: 4, i32u: 5, i64: 6, f32: 7, f64: 8, f80: 9 };
const STK = { i8: 0, i16: 1, i32: 2, i64: 3, f32: 4, f64: 5, f80: 6 };
const mst = (f, t2, addr, v, kind, off) =>
  f.emit(OP.MSTORE, t2, addr, v, memDesc(STK[kind], off === undefined ? 0 : off));
const mld = (f, t2, addr, kind, off) =>
  f.emit(OP.MLOAD, t2, addr, REF_NONE, memDesc(LDK[kind], off === undefined ? 0 : off));

tm('存取 i64', [8n, -12345678901n], -12345678901n, (f, xs, ys) => {
  mst(f, T_I64, ld(f, T_I64, xs), ld(f, T_I64, ys), 'i64');
  ret(f, T_I64, mld(f, T_I64, ld(f, T_I64, xs), 'i64'));
});
tm('存一个字节，按有符号读', [24n, 255n], -1n, (f, xs, ys) => {
  mst(f, T_I64, ld(f, T_I64, xs), ld(f, T_I64, ys), 'i8');
  ret(f, T_I64, mld(f, T_I64, ld(f, T_I64, xs), 'i8s'));
});
tm('存一个字节，按无符号读', [32n, 255n], 255n, (f, xs, ys) => {
  mst(f, T_I64, ld(f, T_I64, xs), ld(f, T_I64, ys), 'i8');
  ret(f, T_I64, mld(f, T_I64, ld(f, T_I64, xs), 'i8u'));
});
tm('存半字，按有符号读', [40n, 0x8000n], -32768n, (f, xs, ys) => {
  mst(f, T_I64, ld(f, T_I64, xs), ld(f, T_I64, ys), 'i16');
  ret(f, T_I64, mld(f, T_I64, ld(f, T_I64, xs), 'i16s'));
});
tm('存四字节，按无符号读', [48n, -1n], 4294967295n, (f, xs, ys) => {
  mst(f, T_I64, ld(f, T_I64, xs), ld(f, T_I64, ys), 'i32');
  ret(f, T_I64, mld(f, T_I64, ld(f, T_I64, xs), 'i32u'));
});
tm('存四字节，按有符号读', [56n, -1n], -1n, (f, xs, ys) => {
  mst(f, T_I64, ld(f, T_I64, xs), ld(f, T_I64, ys), 'i32');
  ret(f, T_I64, mld(f, T_I64, ld(f, T_I64, xs), 'i32s'));
});
tm('静态偏移（p->field 就落这一格）', [64n, 7777n], 7777n, (f, xs, ys) => {
  mst(f, T_I64, ld(f, T_I64, xs), ld(f, T_I64, ys), 'i64', 40);
  ret(f, T_I64, mld(f, T_I64, ld(f, T_I64, xs), 'i64', 40));
});
tm('double 过一趟内存再加 1', [160n, 0n], d2b(2.5 + 1), (f, xs) => {
  mst(f, T_F64, ld(f, T_I64, xs), K.real('2.5'), 'f64');
  const v = mld(f, T_F64, ld(f, T_I64, xs), 'f64');
  ret(f, T_I64, f.emit(OP.CVT, T_I64,
    f.emit(OP.ADD, T_F64, v, K.real('1'), 0), REF_NONE, CVT_BITCAST));
});

// ---- 帧上的一块（第十八片）：`&x` 在 native 上的落脚点。一条 `lea rax, [rbp - off]`。
t('帧块：存进去再读回来', [-12345678901n, 0n], -12345678901n, (f, xs) => {
  const p = f.emit(OP.FRAME, T_I64, REF_NONE, REF_NONE, f.frame('a', 8));
  mst(f, T_I64, p, ld(f, T_I64, xs), 'i64');
  ret(f, T_I64, mld(f, T_I64, p, 'i64'));
});
t('帧块：两块互不重叠', [111n, 222n], 111n, (f, xs, ys) => {
  const p = f.emit(OP.FRAME, T_I64, REF_NONE, REF_NONE, f.frame('a', 8));
  const q = f.emit(OP.FRAME, T_I64, REF_NONE, REF_NONE, f.frame('b', 8));
  mst(f, T_I64, p, ld(f, T_I64, xs), 'i64');
  mst(f, T_I64, q, ld(f, T_I64, ys), 'i64');
  ret(f, T_I64, mld(f, T_I64, p, 'i64'));
});
/* 一字节的块之后，八字节的块还得是八对齐 —— 这一条查的是布局，不是指令。 */
t('帧块：一字节的块不会把后面的块挤歪', [0n, 0n], 0n, (f) => {
  f.frame('c', 1);
  const q = f.emit(OP.FRAME, T_I64, REF_NONE, REF_NONE, f.frame('q', 8));
  ret(f, T_I64, f.emit(OP.BAND, T_I64, q, K.int(7n), 0));
});
t('帧块：要 16 对齐就给 16 对齐', [0n, 0n], 0n, (f) => {
  f.frame('c', 3);
  const v = f.emit(OP.FRAME, T_I64, REF_NONE, REF_NONE, f.frame('v', 16, 16));
  ret(f, T_I64, f.emit(OP.BAND, T_I64, v, K.int(15n), 0));
});
/* **交给真的 libc**：只有真地址才过得了这两关（线性内存里的偏移过不了）。 */
t('帧块：地址交给 strlen', [0n, 0n], 3n, (f) => {
  const p = f.emit(OP.FRAME, T_I64, REF_NONE, REF_NONE, f.frame('buf', 8));
  mst(f, T_I64, p, K.int(97n), 'i8', 0);
  mst(f, T_I64, p, K.int(98n), 'i8', 1);
  mst(f, T_I64, p, K.int(99n), 'i8', 2);
  mst(f, T_I64, p, K.int(0n), 'i8', 3);
  ret(f, T_I64, f.emit(OP.CCALL, T_I64, mod.cabiNo('strlen'), f.pushArgs([p]), 0));
});
t('帧块：memcpy 把串常量搬到帧上，再 strlen', [0n, 0n], 5n, (f) => {
  const p = f.emit(OP.FRAME, T_I64, REF_NONE, REF_NONE, f.frame('buf', 8));
  f.emit(OP.CCALL, T_I64, mod.cabiNo('memcpy'),
    f.pushArgs([p, K.str('hello'), K.int(6n)]), 0);
  ret(f, T_I64, f.emit(OP.CCALL, T_I64, mod.cabiNo('strlen'), f.pushArgs([p]), 0));
});

// ---- 80 位那一格（第一百一十片）：x86_64 的 `long double` 是 x87 的十个字节。
// 值本身仍是 double —— `f80` 这个描述符只管「内存里那十个字节的形状」，
// 读的时候硬件收成 double、写的时候摊成 80 位。地址得是**真地址**，所以用帧上的块。
t('f80：2.5 存成十个字节再读回来', [0n, 0n], d2b(2.5), (f) => {
  const p = f.emit(OP.FRAME, T_I64, REF_NONE, REF_NONE, f.frame('ld', 16, 16));
  mst(f, T_F64, p, K.real('2.5'), 'f80');
  ret(f, T_I64, f.emit(OP.CVT, T_I64, mld(f, T_F64, p, 'f80'), REF_NONE, CVT_BITCAST));
});
/* 0.1 这一条要紧：80 位的尾数比 double 宽 11 位，所以来回一趟必须**一位不掉**
 * （反过来若走了 float 那一档，这一条立刻答成 fround(0.1)）。 */
t('f80：0.1 来回一趟一位不掉', [0n, 0n], d2b(0.1), (f) => {
  const p = f.emit(OP.FRAME, T_I64, REF_NONE, REF_NONE, f.frame('ld', 16, 16));
  mst(f, T_F64, p, K.real('0.1'), 'f80');
  ret(f, T_I64, f.emit(OP.CVT, T_I64, mld(f, T_F64, p, 'f80'), REF_NONE, CVT_BITCAST));
});
/* 写出来的**字节**与 `f80Bytes`（第一百〇九片，尺子称过的那一份）逐个相同 ——
 * 十个字节各读一遍、与期望值异或、全 or 起来，答 0 才算过。 */
t('f80：写出来的十个字节与 f80Bytes(1.5) 逐个相同', [0n, 0n], 0n, (f) => {
  const p = f.emit(OP.FRAME, T_I64, REF_NONE, REF_NONE, f.frame('ld', 16, 16));
  mst(f, T_F64, p, K.real('1.5'), 'f80');
  const want = f80Bytes(1.5, 10);
  let acc = K.int(0n);
  for (let k = 0; k < 10; k++) {
    const b = mld(f, T_I64, p, 'i8u', k);
    acc = f.emit(OP.BOR, T_I64, acc,
      f.emit(OP.BXOR, T_I64, b, K.int(BigInt(want[k])), 0), 0);
  }
  ret(f, T_I64, acc);
});

// ---- 模块级变量与串常量
{
  const gi = mod.globalNo('omni_xg_i64');
  mod.setGlobalTy(gi, T_I64);
  const gw = mod.globalNo('omni_xg_i32');
  mod.setGlobalTy(gw, T_I32);
  t('全局：写进去再读回来', [-9876543210n, 0n], -9876543210n, (f, xs) => {
    f.emit(OP.GSTORE, T_I64, ld(f, T_I64, xs), REF_NONE, gi);
    ret(f, T_I64, f.emit(OP.GLOAD, T_I64, REF_NONE, REF_NONE, gi));
  });
  t('全局：i32 只占四字节、读回来是符号扩展的', [-1n, 0n], -1n, (f, xs) => {
    const v = f.emit(OP.CVT, T_I32, ld(f, T_I64, xs), REF_NONE, CVT_TRUNC);
    f.emit(OP.GSTORE, T_I32, v, REF_NONE, gw);
    ret(f, T_I64, f.emit(OP.GLOAD, T_I32, REF_NONE, REF_NONE, gw));
  });
  t('全局：i32 那格的高四字节不许被踩', [0x7fffffffn, 0n], 0x7fffffffn, (f, xs) => {
    f.emit(OP.GSTORE, T_I64, K.int(-1n), REF_NONE, gi);
    const v = f.emit(OP.CVT, T_I32, ld(f, T_I64, xs), REF_NONE, CVT_TRUNC);
    f.emit(OP.GSTORE, T_I32, v, REF_NONE, gw);
    ret(f, T_I64, f.emit(OP.GLOAD, T_I32, REF_NONE, REF_NONE, gw));
  });

  const HELLO = 'hello, 世界';
  t('串常量：strlen 数出来的是 UTF-8 的字节数', [0n, 0n],
    BigInt(utf8Bytes(HELLO).length), (f) =>
      ret(f, T_I64, f.emit(OP.CCALL, T_I64, mod.cabiNo('strlen'),
        f.pushArgs([K.str(HELLO)]), 0)));
  t('串常量：按字节读得到', [0n, 0n], 0xe4n, (f) =>
    ret(f, T_I64, mld(f, T_I64, K.str(HELLO), 'i8u', 7)));
}

/* ---- 变参函数的**定义**（第二十四片）。SysV 的 `va_list` 是个 24 字节的结构，
 * `va_arg` 分两路（寄存器保存区 / 已溢到栈上）—— 所以这一批里两路都要走到：
 * 前两条只用寄存器那一路，后两条实参多到溢出去。调用方是 clang 编的 `main`。 */
const vcases = [];
let vno = 0;
function tv(what, decl, call, want, body) {
  const name = `omni_v${vno}`;
  vno++;
  const f = new MirFunc(name, [], T_I64);
  const s = f.slot('p0', T_I64);
  f.params.push({ name: 'p0', t: T_I64, slot: s });
  f.setVariadic();
  mod.addFunc(f);
  body(f, s);
  vcases.push({ f, decl: decl.replace('$', name), call: call.replace('$', name), want, what });
}
/** 起个头：回 `va_list` 那一格的地址（帧上的 8 字节）。 */
const vaOpen = (f) => {
  const ap = f.emit(OP.FRAME, T_I64, REF_NONE, REF_NONE, f.frame('ap', 8, 8));
  f.emit(OP.VASTART, T_I64, ap, REF_NONE, 0);
  return ap;
};
/** 取 n 个变参、按 1..n 加权求和，再加上固定实参。 */
const vaSum = (f, s, ap, ty, n) => {
  let v = ld(f, T_I64, s);
  for (let k = 1; k <= n; k++) {
    let a1 = f.emit(OP.VAARG, ty, ap, REF_NONE, 0);
    if (ty === T_F64) a1 = f.emit(OP.CVT, T_I64, a1, REF_NONE, CVT_F2I);
    v = f.emit(OP.ADD, T_I64, v, f.emit(OP.MUL, T_I64, a1, K.int(BigInt(k)), 0), 0);
  }
  ret(f, T_I64, v);
};
/* 1 + 2*1 + 3*2 + 4（4.5 截断）*3 = 21。三个变参都还在寄存器保存区里。 */
tv('变参的定义：两个 i64 与一个 double（都在寄存器里）',
  'extern long long $(long long, ...);', '$(1LL, 2LL, 3LL, 4.5)', 21n, (f, s) => {
    const ap = vaOpen(f);
    const x1 = f.emit(OP.VAARG, T_I64, ap, REF_NONE, 0);
    const y1 = f.emit(OP.VAARG, T_I64, ap, REF_NONE, 0);
    const d = f.emit(OP.VAARG, T_F64, ap, REF_NONE, 0);
    let v = f.emit(OP.ADD, T_I64, ld(f, T_I64, s), f.emit(OP.MUL, T_I64, x1, K.int(1n), 0), 0);
    v = f.emit(OP.ADD, T_I64, v, f.emit(OP.MUL, T_I64, y1, K.int(2n), 0), 0);
    v = f.emit(OP.ADD, T_I64, v, f.emit(OP.MUL, T_I64,
      f.emit(OP.CVT, T_I64, d, REF_NONE, CVT_F2I), K.int(3n), 0), 0);
    ret(f, T_I64, v);
  });
/* `int` 的变参：负数那个查的是「按符号扩展读」。2 + 7*1 + (-9)*2 = -9。 */
tv('变参的定义：i32（负数查符号扩展）', 'extern long long $(long long, ...);',
  '$(2LL, 7, -9)', -9n, (f, s) => vaSum(f, s, vaOpen(f), T_I32, 2));
/* 八个 i64 的变参：五个进 rsi/rdx/rcx/r8/r9，剩下三个**溢到栈上** ——
 * 1 + Σ k² (k=1..8) = 205。走的是 `va_arg` 的另一路。 */
tv('变参的定义：八个 i64（后三个溢到栈上）', 'extern long long $(long long, ...);',
  '$(1LL, 1LL, 2LL, 3LL, 4LL, 5LL, 6LL, 7LL, 8LL)', 205n,
  (f, s) => vaSum(f, s, vaOpen(f), T_I64, 8));
/* 十个 double：八个进 xmm0-7，后两个溢到栈上 —— 1 + Σ k² (k=1..10) = 386。 */
tv('变参的定义：十个 double（后两个溢到栈上）', 'extern long long $(long long, ...);',
  '$(1LL, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0)', 386n,
  (f, s) => vaSum(f, s, vaOpen(f), T_F64, 10));

// ---- 边界：还没做的东西必须明着报
const badMod = new MirModule('bad');
let bad = 0;
for (const [what, build] of [
  ['浮点的取余', (f) => {
    const l = ld(f, T_F64, 0);
    ret(f, T_I64, f.emit(OP.MOD, T_F64, l, l, 0));
  }],
  ['内存的页数', (f) => { ret(f, T_I64, f.emit(OP.MSIZE, T_I64, REF_NONE, REF_NONE, 0)); }],
  ['槽号越界', (f) => { ret(f, T_I64, ld(f, T_I64, 99)); }],
  ['单个函数里的 CALL 没有落点',
    (f) => { ret(f, T_I64, f.emit(OP.CALL, T_I64, 0, f.pushArgs([]), 0)); }],
  ['单个函数里的串常量没有数据段',
    (f) => { ret(f, T_I64, badMod.consts.str('nope')); }],
  ['帧块号越界', (f) => { ret(f, T_I64, f.emit(OP.FRAME, T_I64, REF_NONE, REF_NONE, 3)); }],
]) {
  const f = mkFunc(badMod, `omni_bad_${bad}`, 2, build);
  let threw = false;
  try {
    codeOf(badMod, f);
  } catch { threw = true; }
  if (!threw) {
    process.stdout.write(`  FAIL 「${what}」还没做，可是没报错\n`);
    process.exitCode = 1;
  }
  bad++;
}

// ---------------------------------------------------------------- 跑
const CLANG = ['/usr/bin/clang', '/opt/homebrew/opt/llvm/bin/clang'].find((p) => existsSync(p));
if (CLANG === undefined) {
  process.stdout.write('x64/from-mir: 没找到 clang，跳过\n');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'omni-x64mir-'));
let failed = 0;
let total = 0;
try {
  const blob = genModule(mod);
  const objPath = join(dir, 'omni.o');
  const defs = [];
  for (let k = 0; k < mod.funcs.length; k++) {
    defs.push({ name: mod.funcs[k].name, off: blob.offsets[k] });
  }
  writeFileSync(objPath, writeObject(blob.bytes, blob.data,
    [...defs, ...blob.dataSyms], blob.relocs, 'x86_64'));

  const main = ['#include <stdio.h>', '#include <string.h>', '#include <stdarg.h>',
    'static double b2d(unsigned long long b){ double d; memcpy(&d,&b,8); return d; }',
    'static unsigned long long d2b(double d){ unsigned long long b; memcpy(&b,&d,8); return b; }',
    'static char membuf[4096];',
    'long long omni_ext_six(long long a,long long b,long long c,'
      + 'long long d,long long e,long long f){ return a+b+c+d+e+f; }',
    'double omni_ext_vsum(int n, ...){ va_list ap; va_start(ap,n); double s=0;'
      + ' for(int i=0;i<n;i++) s += va_arg(ap,double); va_end(ap); return s; }',
    'long long omni_ext_ten(long long a, long long b, long long c, long long d, long long e,'
      + ' long long f, long long g, long long h, long long i, long long j){'
      + ' return a + b*2 + c*3 + d*4 + e*5 + f*6 + g*7 + h*8 + i*9 + j*10; }',
    'double omni_ext_tend(double a, double b, double c, double d, double e,'
      + ' double f, double g, double h, double i, double j){'
      + ' return a + b*2 + c*3 + d*4 + e*5 + f*6 + g*7 + h*8 + i*9 + j*10; }'];
  const calls = [];
  for (const c of cases) {
    main.push(`extern long long ${c.f.name}(long long, long long);`);
    calls.push(`  printf("%lld\\n", ${c.f.name}(${c.args[0]}LL, ${c.args[1]}LL));`);
  }
  for (const c of dcases) {
    main.push(`extern double ${c.f.name}(double, double);`);
    calls.push(`  printf("%llu\\n", d2b(${c.f.name}(b2d(${d2b(c.args[0])}ULL),`
      + ` b2d(${d2b(c.args[1])}ULL))));`);
  }
  for (const c of bcases) {
    main.push(`extern long long ${c.f.name}(double, double);`);
    calls.push(`  printf("%lld\\n", ${c.f.name}(b2d(${d2b(c.args[0])}ULL),`
      + ` b2d(${d2b(c.args[1])}ULL)));`);
  }
  /* 存取那批：第一个实参是**真指针**（native 上没有线性内存）。 */
  for (const c of mcases) {
    main.push(`extern long long ${c.f.name}(char *, long long);`);
    calls.push(`  printf("%lld\\n", ${c.f.name}(membuf + ${c.args[0]}, ${c.args[1]}LL));`);
  }
  /* 变参的定义那批：调用点由用例自己写（实参个数与类型各不相同）。 */
  for (const c of vcases) {
    main.push(c.decl);
    calls.push(`  printf("%lld\\n", ${c.call});`);
  }
  const mainSrc = `${main.join('\n')}\nint main(void){\n${calls.join('\n')}\n  return 0;\n}\n`;
  const mainPath = join(dir, 'main.c');
  writeFileSync(mainPath, mainSrc);
  const progPath = join(dir, 'prog');
  execFileSync(CLANG, ['-arch', 'x86_64', mainPath, objPath, '-o', progPath], { stdio: 'pipe' });
  const out = execFileSync(progPath, [], { encoding: 'utf8' }).trim().split('\n');

  const all = [
    ...cases.map((c) => ({ what: c.what, want: c.want })),
    ...dcases.map((c) => ({ what: c.what, want: d2b(c.want) })),
    ...bcases.map((c) => ({ what: c.what, want: c.want })),
    ...mcases.map((c) => ({ what: c.what, want: c.want })),
    ...vcases.map((c) => ({ what: c.what, want: c.want })),
  ];
  if (out.length !== all.length) {
    process.stdout.write(`x64/from-mir: 印出来 ${out.length} 行，用例 ${all.length} 条\n`);
    process.exit(1);
  }
  for (let i = 0; i < all.length; i++) {
    total++;
    /* 两边都按无符号 64 位比 —— `%lld` 印出来的位模式是有符号的。 */
    if (BigInt.asUintN(64, BigInt(out[i])) === BigInt.asUintN(64, all[i].want)) continue;
    failed++;
    process.stdout.write(`  FAIL ${all[i].what}\n    ours ${out[i]}\n    want ${all[i].want}\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${total - failed} passed, ${failed} failed\n`);
if (failed !== 0) process.exitCode = 1;
