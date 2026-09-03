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
  MirModule, MirFunc, OP, REF_NONE, T_I64, T_I32, T_BOOL, T_VOID, T_F64, T_F32,
  CVT_SEXT8, CVT_SEXT16, CVT_TRUNC, CVT_ZEXT,
  CVT_I2F, CVT_U2F, CVT_F2I, CVT_FCVT, CVT_BITCAST, memDesc,
} from '../../stage0/src/mir/ir.js';
import { codeOf, genModule } from '../../stage0/src/arm64/from_mir.js';
import { writeObject } from '../../stage0/src/link/macho.js';
import { utf8Bytes } from '../../stage0/src/host/utf8.js';

const mod = new MirModule('main');
const K = mod.consts;

/** 收 n 个形参的函数，登记进模块（CALL 的 a 就是这个下标）。`pt` 是形参与返回的类型。 */
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

/** 一个「收两个 long long、回一个 long long」的函数。`body(f, x, y)` 里 x/y 是槽号。 */
function fn(name, body) {
  return mkFunc(mod, name, 2, (f, s, no) => body(f, s[0], s[1], no));
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

// ---- 调用（第九刀第五片）。同一个模块里的函数之间走标签，不欠链接器的账。
{
  /* 递归：阶乘。自己叫自己 —— 函数号就是自己的下标，`no` 是 mkFunc 给的。 */
  const fact = mkFunc(mod, 'omni_fact', 1, (f, s, no) => {
    const n = ld(f, T_I64, s[0]);
    const small = f.emit(OP.LE, T_I64, n, K.int(1n), 0);
    f.emit(OP.IF, T_VOID, small, REF_NONE, 0);
    ret(f, T_I64, K.int(1n));
    f.emit(OP.END, T_VOID, REF_NONE, REF_NONE, 0);
    const sub = f.emit(OP.SUB, T_I64, ld(f, T_I64, s[0]), K.int(1n), 0);
    const rec = f.emit(OP.CALL, T_I64, no, f.pushArgs([sub]), 0);
    ret(f, T_I64, f.emit(OP.MUL, T_I64, ld(f, T_I64, s[0]), rec, 0));
  });
  const factNo = mod.funcIndex.get(fact.name);
  t('递归：阶乘', [10n, 0n], 3628800n, (f, x) =>
    ret(f, T_I64, f.emit(OP.CALL, T_I64, factNo, f.pushArgs([ld(f, T_I64, x)]), 0)));

  /* 八个实参正好占满 x0-x7。少一个多一个都错得很像，所以这条要有。 */
  const sum8 = mkFunc(mod, 'omni_sum8', 8, (f, s) => {
    let acc = ld(f, T_I64, s[0]);
    for (let i = 1; i < 8; i++) {
      acc = f.emit(OP.ADD, T_I64, acc, f.emit(OP.MUL, T_I64, ld(f, T_I64, s[i]),
        K.int(BigInt(10 ** i)), 0), 0);
    }
    ret(f, T_I64, acc);
  });
  const sum8No = mod.funcIndex.get(sum8.name);
  t('八个实参', [0n, 0n], 87654321n, (f) =>
    ret(f, T_I64, f.emit(OP.CALL, T_I64, sum8No, f.pushArgs([
      K.int(1n), K.int(2n), K.int(3n), K.int(4n),
      K.int(5n), K.int(6n), K.int(7n), K.int(8n),
    ]), 0)));

  /* 调用点前后的值都在栈位上，所以 callee 把寄存器搅乱了也不影响 —— 这条查的正是它：
   * 两次调用之间还夹着一个活着的值。 */
  const twice = mkFunc(mod, 'omni_dbl', 1, (f, s) =>
    ret(f, T_I64, f.emit(OP.MUL, T_I64, ld(f, T_I64, s[0]), K.int(2n), 0)));
  const twiceNo = mod.funcIndex.get(twice.name);
  t('调用夹着活着的值', [3n, 5n], 6n * 10n + 1n, (f, x, y) => {
    const lx = ld(f, T_I64, x);
    const ly = ld(f, T_I64, y);
    const dx = f.emit(OP.CALL, T_I64, twiceNo, f.pushArgs([lx]), 0);
    const dy = f.emit(OP.CALL, T_I64, twiceNo, f.pushArgs([ly]), 0);
    /* dx*10 + (dy - dx - 3) = 60 + (10 - 9) = 61 */
    const t1 = f.emit(OP.MUL, T_I64, dx, K.int(10n), 0);
    const t2 = f.emit(OP.SUB, T_I64, dy, f.emit(OP.ADD, T_I64, dx, K.int(3n), 0), 0);
    ret(f, T_I64, f.emit(OP.ADD, T_I64, t1, t2, 0));
  });

  /* i32 的返回值：AAPCS 只保证 w0 有值，所以调用点要按规范形符号扩展一次。 */
  const neg32 = mkFunc(mod, 'omni_neg32', 1, (f, s) => {
    const v = f.emit(OP.CVT, T_I32, ld(f, T_I64, s[0]), REF_NONE, CVT_TRUNC);
    f.emit(OP.RET, T_I32, f.emit(OP.NEG, T_I32, v, REF_NONE, 0), REF_NONE, 0);
  });
  const neg32No = mod.funcIndex.get(neg32.name);
  t('i32 的返回值要按规范形扩展', [5n, 0n], -5n, (f, x) =>
    ret(f, T_I64, f.emit(OP.CALL, T_I32, neg32No, f.pushArgs([ld(f, T_I64, x)]), 0)));
}

// ---- 浮点（第九刀第六片）
/** 一个 double 的位模式。用例的期望值一律比**位**，不比十进制文本。 */
function d2b(x) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x, true);
  return dv.getBigUint64(0, true);
}
function f2b(x) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat32(0, Math.fround(x), true);
  return BigInt(dv.getUint32(0, true));
}

/* 先用整数那套壳子验「算得对不对」：进出都是位模式，中间是浮点。 */
t('double 加：0.1 + 0.2', [0n, 0n], d2b(0.1 + 0.2), (f) =>
  ret(f, T_I64, f.emit(OP.CVT, T_I64,
    f.emit(OP.ADD, T_F64, K.real('0.1'), K.real('0.2'), 0), REF_NONE, CVT_BITCAST)));
t('double 除：1/3', [0n, 0n], d2b(1 / 3), (f) =>
  ret(f, T_I64, f.emit(OP.CVT, T_I64,
    f.emit(OP.DIV, T_F64, K.real('1'), K.real('3'), 0), REF_NONE, CVT_BITCAST)));
t('double 取负', [0n, 0n], d2b(-2.5), (f) =>
  ret(f, T_I64, f.emit(OP.CVT, T_I64,
    f.emit(OP.NEG, T_F64, K.real('2.5'), REF_NONE, 0), REF_NONE, CVT_BITCAST)));
/* f32 的舍入与 double 不同 —— 1/3 在两种宽度下是两个不同的数，这条正查它。 */
t('float 除：1/3 是单精度的那个', [0n, 0n], f2b(1 / 3), (f) =>
  ret(f, T_I64, f.emit(OP.CVT, T_I64,
    f.emit(OP.DIV, T_F32, K.f32('1'), K.f32('3'), 0), REF_NONE, CVT_BITCAST)));
t('整数 -> double -> 整数（向零取整）', [-7n, 2n], -3n, (f, x, y) => {
  const fx = f.emit(OP.CVT, T_F64, ld(f, T_I64, x), REF_NONE, CVT_I2F);
  const fy = f.emit(OP.CVT, T_F64, ld(f, T_I64, y), REF_NONE, CVT_I2F);
  ret(f, T_I64, f.emit(OP.CVT, T_I64, f.emit(OP.DIV, T_F64, fx, fy, 0), REF_NONE, CVT_F2I));
});
t('无符号 -> double', [-1n, 0n], d2b(18446744073709551616), (f, x) => {
  const fx = f.emit(OP.CVT, T_F64, ld(f, T_I64, x), REF_NONE, CVT_U2F);
  /* (double)(u64)-1 舍到 2^64 —— 转回整数会溢出，所以比位模式。 */
  ret(f, T_I64, f.emit(OP.CVT, T_I64, fx, REF_NONE, CVT_BITCAST));
});
t('double -> float -> double 会掉精度', [0n, 0n], d2b(Math.fround(0.1)), (f) => {
  const s = f.emit(OP.CVT, T_F32, K.real('0.1'), REF_NONE, CVT_FCVT);
  const d = f.emit(OP.CVT, T_F64, s, REF_NONE, CVT_FCVT);
  ret(f, T_I64, f.emit(OP.CVT, T_I64, d, REF_NONE, CVT_BITCAST));
});
/* NaN：照抄整数那张条件码表的话 `<` 会为真 —— 这两条是那个错的唯一现场。 */
const NAN_BITS = 0x7ff8000000000000n;
t('NaN < 1.0 是假', [0n, 0n], 0n, (f) => {
  const nan = f.emit(OP.CVT, T_F64, K.int(NAN_BITS), REF_NONE, CVT_BITCAST);
  ret(f, T_I64, f.emit(OP.LT, T_F64, nan, K.real('1'), 0));
});
t('NaN <= 1.0 是假', [0n, 0n], 0n, (f) => {
  const nan = f.emit(OP.CVT, T_F64, K.int(NAN_BITS), REF_NONE, CVT_BITCAST);
  ret(f, T_I64, f.emit(OP.LE, T_F64, nan, K.real('1'), 0));
});
t('NaN != NaN 是真', [0n, 0n], 1n, (f) => {
  const nan = f.emit(OP.CVT, T_F64, K.int(NAN_BITS), REF_NONE, CVT_BITCAST);
  ret(f, T_I64, f.emit(OP.NE, T_F64, nan, nan, 0));
});
t('2.5 > 1.5 是真，1.5 >= 2.5 是假', [0n, 0n], 1n, (f) => {
  const gt = f.emit(OP.GT, T_F64, K.real('2.5'), K.real('1.5'), 0);
  const ge = f.emit(OP.GE, T_F64, K.real('1.5'), K.real('2.5'), 0);
  ret(f, T_I64, f.emit(OP.SUB, T_I64, gt, ge, 0));
});

/* 再验浮点的 ABI：形参在 d0-d7、返回值在 d0，与整数**各自从 0 起数**。 */
/** @type {{f:MirFunc, args:[number,number], want:bigint, what:string}[]} */
const dcases = [];
let dno = 0;
function td(what, args, want, body) {
  const f = mkFunc(mod, `omni_d${dno}`, 2, (g, s, n) => body(g, s[0], s[1], n), T_F64);
  dno++;
  dcases.push({ f, args, want, what });
}

td('double 的形参与返回值', [1.5, 0.25], d2b(1.5 * 0.25), (f, x, y) =>
  ret(f, T_F64, f.emit(OP.MUL, T_F64, ld(f, T_F64, x), ld(f, T_F64, y), 0)));
td('double 的减法（次序不能反）', [1.5, 0.25], d2b(1.5 - 0.25), (f, x, y) =>
  ret(f, T_F64, f.emit(OP.SUB, T_F64, ld(f, T_F64, x), ld(f, T_F64, y), 0)));
{
  /* 混着传：整数与浮点的实参各占自己那一串寄存器。 */
  const mix = mkFunc(mod, 'omni_mix', 4, (f, s) => {
    /* p0/p2 当 double 用，p1/p3 当 i64 用 —— 形参类型是逐个说的，不是一刀切。 */
    ret(f, T_F64, f.emit(OP.ADD, T_F64, ld(f, T_F64, s[0]), ld(f, T_F64, s[2]), 0));
  }, T_F64);
  mix.params[1] = { name: 'p1', t: T_I64, slot: mix.params[1].slot };
  mix.params[3] = { name: 'p3', t: T_I64, slot: mix.params[3].slot };
  const mixNo = mod.funcIndex.get(mix.name);
  td('整数与浮点实参各数一串', [2.5, 0.5], d2b(2.5 + 0.5), (f, x, y) =>
    ret(f, T_F64, f.emit(OP.CALL, T_F64, mixNo, f.pushArgs([
      ld(f, T_F64, x), K.int(7n), ld(f, T_F64, y), K.int(9n),
    ]), 0)));
}

// ---- 真指针的存取（第九刀第七片）。**native 这条腿上没有线性内存**：MLOAD/MSTORE 的
// 地址就是真地址，所以测里第一个实参直接是 `membuf + 偏移`。
/** @type {{f:MirFunc, args:[bigint,bigint], want:bigint, what:string}[]} */
const mcases = [];
let mno = 0;
function tm(what, args, want, body) {
  const f = mkFunc(mod, `omni_m${mno}`, 2, (g, s, n) => body(g, s[0], s[1], n));
  mno++;
  mcases.push({ f, args, want, what });
}
/** 宽度符号 -> 描述符里的号（两张表的下标，见 `ir.js`）。 */
const LDK = { i8s: 0, i8u: 1, i16s: 2, i16u: 3, i32s: 4, i32u: 5, i64: 6, f32: 7, f64: 8 };
const STK = { i8: 0, i16: 1, i32: 2, i64: 3, f32: 4, f64: 5 };
const mst = (f, t, addr, v, kind, off) =>
  f.emit(OP.MSTORE, t, addr, v, memDesc(STK[kind], off === undefined ? 0 : off));
const mld = (f, t, addr, kind, off) =>
  f.emit(OP.MLOAD, t, addr, REF_NONE, memDesc(LDK[kind], off === undefined ? 0 : off));

tm('存取 i64', [8n, -12345678901n], -12345678901n, (f, x, y) => {
  mst(f, T_I64, ld(f, T_I64, x), ld(f, T_I64, y), 'i64');
  ret(f, T_I64, mld(f, T_I64, ld(f, T_I64, x), 'i64'));
});
tm('存一个字节，按有符号读', [3n, 255n], -1n, (f, x, y) => {
  mst(f, T_I64, ld(f, T_I64, x), ld(f, T_I64, y), 'i8');
  ret(f, T_I64, mld(f, T_I64, ld(f, T_I64, x), 'i8s'));
});
tm('存一个字节，按无符号读', [4n, 255n], 255n, (f, x, y) => {
  mst(f, T_I64, ld(f, T_I64, x), ld(f, T_I64, y), 'i8');
  ret(f, T_I64, mld(f, T_I64, ld(f, T_I64, x), 'i8u'));
});
tm('存半字，按有符号读', [6n, 0x8000n], -32768n, (f, x, y) => {
  mst(f, T_I64, ld(f, T_I64, x), ld(f, T_I64, y), 'i16');
  ret(f, T_I64, mld(f, T_I64, ld(f, T_I64, x), 'i16s'));
});
tm('存四字节，按无符号读', [16n, -1n], 4294967295n, (f, x, y) => {
  mst(f, T_I64, ld(f, T_I64, x), ld(f, T_I64, y), 'i32');
  ret(f, T_I64, mld(f, T_I64, ld(f, T_I64, x), 'i32u'));
});
tm('存四字节，按有符号读', [24n, -1n], -1n, (f, x, y) => {
  mst(f, T_I64, ld(f, T_I64, x), ld(f, T_I64, y), 'i32');
  ret(f, T_I64, mld(f, T_I64, ld(f, T_I64, x), 'i32s'));
});
tm('静态偏移在描述符上（p->field 就落这一格）', [32n, 7777n], 7777n, (f, x, y) => {
  mst(f, T_I64, ld(f, T_I64, x), ld(f, T_I64, y), 'i64', 40);
  ret(f, T_I64, mld(f, T_I64, ld(f, T_I64, x), 'i64', 40));
});
tm('静态偏移大过一格立即数（要先造出来）', [64n, 4242n], 4242n, (f, x, y) => {
  mst(f, T_I64, ld(f, T_I64, x), ld(f, T_I64, y), 'i64', 5000);
  ret(f, T_I64, mld(f, T_I64, ld(f, T_I64, x), 'i64', 5000));
});
tm('没对齐的 i64（arm64 的普通存取不挑对齐）', [131n, 0x1122334455667788n],
  0x1122334455667788n, (f, x, y) => {
    mst(f, T_I64, ld(f, T_I64, x), ld(f, T_I64, y), 'i64');
    ret(f, T_I64, mld(f, T_I64, ld(f, T_I64, x), 'i64'));
  });
tm('double 过一趟内存再加 1', [200n, 0n], d2b(2.5 + 1), (f, x) => {
  mst(f, T_F64, ld(f, T_I64, x), K.real('2.5'), 'f64');
  const v = mld(f, T_F64, ld(f, T_I64, x), 'f64');
  const s = f.emit(OP.ADD, T_F64, v, K.real('1'), 0);
  ret(f, T_I64, f.emit(OP.CVT, T_I64, s, REF_NONE, CVT_BITCAST));
});
tm('float 过一趟内存（只占四个字节）', [208n, 0n], f2b(0.5), (f, x) => {
  mst(f, T_F32, ld(f, T_I64, x), K.f32('0.5'), 'f32');
  ret(f, T_I64, f.emit(OP.CVT, T_I64, mld(f, T_F32, ld(f, T_I64, x), 'f32'),
    REF_NONE, CVT_BITCAST));
});

// ---- 外部符号的调用（第九刀第八片）。CCALL 落成 `bl <符号>`，那一格由链接器填。
t('调外部的 C 函数', [3n, 4n], 7n, (f, x, y) =>
  ret(f, T_I64, f.emit(OP.CCALL, T_I64, mod.cabiNo('omni_ext_add'),
    f.pushArgs([ld(f, T_I64, x), ld(f, T_I64, y)]), 0)));
t('调 libc 的 llabs', [-5n, 0n], 5n, (f, x) =>
  ret(f, T_I64, f.emit(OP.CCALL, T_I64, mod.cabiNo('llabs'),
    f.pushArgs([ld(f, T_I64, x)]), 0)));
t('同一个外部符号叫两次只占一条重定位符号', [10n, 20n], 60n, (f, x, y) => {
  const no = mod.cabiNo('omni_ext_add');
  const a1 = f.emit(OP.CCALL, T_I64, no, f.pushArgs([ld(f, T_I64, x), ld(f, T_I64, y)]), 0);
  ret(f, T_I64, f.emit(OP.CCALL, T_I64, no, f.pushArgs([a1, a1]), 0));
});
td('外部的 double 函数（实参走 d0/d1、返回走 d0）', [2.5, 4.0], d2b(2.5 * 4 + 1),
  (f, x, y) => ret(f, T_F64, f.emit(OP.CCALL, T_F64, mod.cabiNo('omni_ext_scale'),
    f.pushArgs([ld(f, T_F64, x), ld(f, T_F64, y)]), 0)));

/* 十个实参：八个进 x0-x7 / d0-d7，剩下两个得由**调用方**摆到 sp 上去。
 * 期望值都是 Σ i·i（i = 1..10）= 385 —— 摆错位置就会差在最后那两项上。 */
t('十个整数实参（后两个走栈）', [0n, 0n], 385n, (f) =>
  ret(f, T_I64, f.emit(OP.CCALL, T_I64, mod.cabiNo('omni_ext_ten'),
    f.pushArgs([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n].map((v) => K.int(v))), 0)));
t('十个 double 实参（后两个走栈）', [0n, 0n], 385n, (f) => {
  const d = f.emit(OP.CCALL, T_F64, mod.cabiNo('omni_ext_tend'),
    f.pushArgs(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].map((v) => K.real(v))), 0);
  ret(f, T_I64, f.emit(OP.CVT, T_I64, d, REF_NONE, CVT_F2I));
});

/* ---- 变参函数的**定义**（第二十四片）。调用方是 clang 编的 `main`，所以这一批查的是
 * 真 ABI：苹果的 arm64 把 `...` 后面的实参一律摆在栈上、一格 8 字节（`ldr w9, [x8], #8`
 * ——`int` 也占满一格），`va_list` 就是指着第一格的一个指针。 */
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
/* 1 + 2*10 + 3*100 + 4（4.5 向零截断）*1000 = 4321。权重不同，读串一格就露。 */
tv('变参的定义：两个 i64 与一个 double', 'extern long long $(long long, ...);',
  '$(1LL, 2LL, 3LL, 4.5)', 4321n, (f, s) => {
    const ap = f.emit(OP.FRAME, T_I64, REF_NONE, REF_NONE, f.frame('ap', 8, 8));
    f.emit(OP.VASTART, T_I64, ap, REF_NONE, 0);
    const x = f.emit(OP.VAARG, T_I64, ap, REF_NONE, 0);
    const y = f.emit(OP.VAARG, T_I64, ap, REF_NONE, 0);
    const d = f.emit(OP.VAARG, T_F64, ap, REF_NONE, 0);
    let v = f.emit(OP.ADD, T_I64, ld(f, T_I64, s),
      f.emit(OP.MUL, T_I64, x, K.int(10n), 0), 0);
    v = f.emit(OP.ADD, T_I64, v, f.emit(OP.MUL, T_I64, y, K.int(100n), 0), 0);
    v = f.emit(OP.ADD, T_I64, v, f.emit(OP.MUL, T_I64,
      f.emit(OP.CVT, T_I64, d, REF_NONE, CVT_F2I), K.int(1000n), 0), 0);
    ret(f, T_I64, v);
  });
/* `int` 的变参：默认提升之后还是 int，占一格 8 字节、只有低四字节有意义。
 * 负数那个查的是「按符号扩展读」——零扩展的话答案会大出 2^32。 */
tv('变参的定义：i32（负数查符号扩展）', 'extern long long $(long long, ...);',
  '$(2LL, 7, -9)', -828n, (f, s) => {
    const ap = f.emit(OP.FRAME, T_I64, REF_NONE, REF_NONE, f.frame('ap', 8, 8));
    f.emit(OP.VASTART, T_I64, ap, REF_NONE, 0);
    const x = f.emit(OP.VAARG, T_I32, ap, REF_NONE, 0);
    const y = f.emit(OP.VAARG, T_I32, ap, REF_NONE, 0);
    let v = f.emit(OP.ADD, T_I64, ld(f, T_I64, s),
      f.emit(OP.MUL, T_I64, x, K.int(10n), 0), 0);
    v = f.emit(OP.ADD, T_I64, v, f.emit(OP.MUL, T_I64, y, K.int(100n), 0), 0);
    ret(f, T_I64, v);
  });

// ---- 模块级变量（第九刀第九片）。落在 __DATA 里、靠 adrp/add 取址，每个都是真符号。
{
  const gi = mod.globalNo('omni_g_i64');
  mod.setGlobalTy(gi, T_I64);
  const gw = mod.globalNo('omni_g_i32');
  mod.setGlobalTy(gw, T_I32);
  const gd = mod.globalNo('omni_g_f64');
  mod.setGlobalTy(gd, T_F64);

  t('全局：写进去再读回来', [-9876543210n, 0n], -9876543210n, (f, x) => {
    f.emit(OP.GSTORE, T_I64, ld(f, T_I64, x), REF_NONE, gi);
    ret(f, T_I64, f.emit(OP.GLOAD, T_I64, REF_NONE, REF_NONE, gi));
  });
  t('全局：i32 的那格只占四字节、读回来是符号扩展的', [-1n, 0n], -1n, (f, x) => {
    const v = f.emit(OP.CVT, T_I32, ld(f, T_I64, x), REF_NONE, CVT_TRUNC);
    f.emit(OP.GSTORE, T_I32, v, REF_NONE, gw);
    ret(f, T_I64, f.emit(OP.GLOAD, T_I32, REF_NONE, REF_NONE, gw));
  });
  t('全局：i32 那格的高四字节不许被踩', [0x7fffffffn, 0n], 0x7fffffffn, (f, x) => {
    /* 先把整个八字节铺满 1，再只写低四字节 —— 写宽了这条就露。 */
    f.emit(OP.GSTORE, T_I64, K.int(-1n), REF_NONE, gi);
    const v = f.emit(OP.CVT, T_I32, ld(f, T_I64, x), REF_NONE, CVT_TRUNC);
    f.emit(OP.GSTORE, T_I32, v, REF_NONE, gw);
    ret(f, T_I64, f.emit(OP.GLOAD, T_I32, REF_NONE, REF_NONE, gw));
  });
  t('全局：double 过一趟', [0n, 0n], d2b(2.5 * 4), (f) => {
    f.emit(OP.GSTORE, T_F64, K.real('2.5'), REF_NONE, gd);
    const v = f.emit(OP.GLOAD, T_F64, REF_NONE, REF_NONE, gd);
    ret(f, T_I64, f.emit(OP.CVT, T_I64,
      f.emit(OP.MUL, T_F64, v, K.real('4'), 0), REF_NONE, CVT_BITCAST));
  });
  /* C 那边看得见这个符号吗 —— 这条查的是「我们定义的数据符号是真符号」。 */
  t('全局：C 那边读得到', [12345n, 0n], 12345n, (f, x) => {
    f.emit(OP.GSTORE, T_I64, ld(f, T_I64, x), REF_NONE, gi);
    ret(f, T_I64, K.int(12345n));
  });
}

// ---- 字符串字面量（第九刀第十片）。字节进 __DATA，用到的地方取的是**地址**。
{
  const HELLO = 'hello, 世界';
  const hi = K.str(HELLO);
  t('串常量：strlen 数出来的是 UTF-8 的字节数', [0n, 0n],
    BigInt(utf8Bytes(HELLO).length), (f) =>
      ret(f, T_I64, f.emit(OP.CCALL, T_I64, mod.cabiNo('strlen'), f.pushArgs([hi]), 0)));
  /* 末尾那个 0 是我们补的 —— 没补的话 `strlen("")` 会一路数到下一段数据里去。 */
  t('串常量：末尾有 0（空串的 strlen 是 0）', [0n, 0n], 0n, (f) =>
    ret(f, T_I64, f.emit(OP.CCALL, T_I64, mod.cabiNo('strlen'), f.pushArgs([K.str('')]), 0)));
  t('串常量：第一个字节读得到', [0n, 0n], 104n, (f) =>
    ret(f, T_I64, mld(f, T_I64, hi, 'i8u')));
  /* 第 7 个字节是「世」的第一节（U+4E16 -> e4 b8 96）—— 这一条同时查 UTF-8 与静态偏移。 */
  t('串常量：多字节字符按字节躺着', [0n, 0n], 0xe4n, (f) =>
    ret(f, T_I64, mld(f, T_I64, hi, 'i8u', 7)));
  /* 同一份文本在常量池里只有一条 ref，于是只有一个符号、一份字节 —— 两个地址相减是 0。 */
  t('串常量：同一份文本只有一个符号', [0n, 0n], 0n, (f) =>
    ret(f, T_I64, f.emit(OP.SUB, T_I64, K.str(HELLO), K.str(HELLO), 0)));
  /* 不同的文本是不同的符号、不同的字节：两个长度差 1。 */
  t('串常量：不同的文本是两个符号', [0n, 0n], 1n, (f) => {
    const no1 = mod.cabiNo('strlen');
    const l1 = f.emit(OP.CCALL, T_I64, no1, f.pushArgs([K.str('abcd')]), 0);
    const l2 = f.emit(OP.CCALL, T_I64, no1, f.pushArgs([K.str('abc')]), 0);
    ret(f, T_I64, f.emit(OP.SUB, T_I64, l1, l2, 0));
  });
  /* 串常量当实参传给自家写的 C 函数：地址就是真指针，`strcmp` 那边认得。 */
  t('串常量：传给外部 C 函数比对内容', [0n, 0n], 1n, (f) =>
    ret(f, T_I64, f.emit(OP.CCALL, T_I64, mod.cabiNo('omni_ext_same'),
      f.pushArgs([K.str('abcd'), K.str('abcd')]), 0)));
}

// ---- 帧上的一块（第九刀第十八片）。**`&x` 在 native 上的落脚点**：`add x0, sp, #off`，
// 得到的是真地址 —— 交给 libc 也认（线性内存里的那个偏移不认）。
{
  const fr = (f, name, size, align) =>
    f.emit(OP.FRAME, T_I64, REF_NONE, REF_NONE, f.frame(name, size, align));
  t('帧块：存进去再读回来', [-12345678901n, 0n], -12345678901n, (f, x) => {
    const p = fr(f, 'a', 8);
    mst(f, T_I64, p, ld(f, T_I64, x), 'i64');
    ret(f, T_I64, mld(f, T_I64, p, 'i64'));
  });
  t('帧块：两块互不重叠', [111n, 222n], 111n, (f, x, y) => {
    const p = fr(f, 'a', 8);
    const q = fr(f, 'b', 8);
    mst(f, T_I64, p, ld(f, T_I64, x), 'i64');
    mst(f, T_I64, q, ld(f, T_I64, y), 'i64');
    ret(f, T_I64, mld(f, T_I64, p, 'i64'));
  });
  /* 布局，不是指令：一字节的块之后，八字节的块还得八对齐。`sp` 本身 16 对齐，
   * 所以「偏移是 8 的倍数」就等于「地址是 8 对齐的」。 */
  t('帧块：一字节的块不会把后面的块挤歪', [0n, 0n], 0n, (f) => {
    f.frame('c', 1);
    ret(f, T_I64, f.emit(OP.BAND, T_I64, fr(f, 'q', 8), K.int(7n), 0));
  });
  t('帧块：要 16 对齐就给 16 对齐', [0n, 0n], 0n, (f) => {
    f.frame('c', 3);
    ret(f, T_I64, f.emit(OP.BAND, T_I64, fr(f, 'v', 16, 16), K.int(15n), 0));
  });
  t('帧块：地址交给 strlen', [0n, 0n], 3n, (f) => {
    const p = fr(f, 'buf', 8);
    mst(f, T_I64, p, K.int(97n), 'i8', 0);
    mst(f, T_I64, p, K.int(98n), 'i8', 1);
    mst(f, T_I64, p, K.int(99n), 'i8', 2);
    mst(f, T_I64, p, K.int(0n), 'i8', 3);
    ret(f, T_I64, f.emit(OP.CCALL, T_I64, mod.cabiNo('strlen'), f.pushArgs([p]), 0));
  });
  t('帧块：memcpy 把串常量搬到帧上，再 strlen', [0n, 0n], 5n, (f) => {
    const p = fr(f, 'buf', 8);
    f.emit(OP.CCALL, T_I64, mod.cabiNo('memcpy'),
      f.pushArgs([p, K.str('hello'), K.int(6n)]), 0);
    ret(f, T_I64, f.emit(OP.CCALL, T_I64, mod.cabiNo('strlen'), f.pushArgs([p]), 0));
  });
}

// ---------------------------------------------------------------- 边界
// 还没做的东西必须**明着报**。一个悄悄发错指令的后端比一个报错的后端坏得多。
// 这些函数不进 `mod` —— 它们发不出来，混进去会把整个模块的生成一起拖倒。
const badMod = new MirModule('bad');
let bad = 0;
for (const [what, build] of [
  ['浮点的取余（没有单条指令，也还没落到 fmod）',
    (f) => { const l = ld(f, T_F64, 0); ret(f, T_I64, f.emit(OP.MOD, T_F64, l, l, 0)); }],
  ['内存的页数与扩容（没有运行期，谈不上 grow）',
    (f) => { ret(f, T_I64, f.emit(OP.MSIZE, T_I64, REF_NONE, REF_NONE, 0)); }],
  ['槽号越界', (f) => { ret(f, T_I64, ld(f, T_I64, 99)); }],
  ['单个函数里的 CALL 没有落点',
    (f) => { ret(f, T_I64, f.emit(OP.CALL, T_I64, 0, f.pushArgs([]), 0)); }],
  /* 单个函数编不出数据段，于是串常量在那条路上没有落点 —— 必须明着报，
   * 不能悄悄发一条指着 0 的 `adrp`。 */
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
  process.stdout.write('arm64/from-mir: 没找到 clang，跳过\n');
  process.exit(0);
}
if (process.arch !== 'arm64') {
  process.stdout.write(`arm64/from-mir: 这台机器是 ${process.arch}，跑不了 arm64 码，跳过\n`);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'omni-frommir-'));
let failed = 0;
let total = 0;
try {
  /* 整个模块生成一段连着的字节，函数之间的 `bl` 已经在里头回填好了；跨模块的符号
   * （`CCALL` 记的那些）交给链接器 —— 我们自己写一个 Mach-O 的 `.o` 出去。
   * 第八片之前这儿是 `.incbin` 的脚手架，现在整段退役了。 */
  const blob = genModule(mod);
  const objPath = join(dir, 'omni.o');
  const defs = [];
  for (let k = 0; k < mod.funcs.length; k++) {
    defs.push({ name: mod.funcs[k].name, off: blob.offsets[k] });
  }
  writeFileSync(objPath, writeObject(blob.bytes, blob.data,
    [...defs, ...blob.dataSyms], blob.relocs, 'arm64', blob.dataAlign,
    { rodata: blob.rodata }));
  const main = ['#include <stdio.h>', '#include <string.h>',
    'static double b2d(unsigned long long b){ double d; memcpy(&d,&b,8); return d; }',
    'static unsigned long long d2b(double d){ unsigned long long b; memcpy(&b,&d,8); return b; }',
    'long long omni_ext_add(long long a, long long b){ return a + b; }',
    'long long omni_ext_same(const char *a, const char *b){ return strcmp(a, b) == 0; }',
    'double omni_ext_scale(double a, double b){ return a * b + 1.0; }',
    /* 十个整数实参：第九、十个走栈（第二十三片）。权重不同，串位一眼看得出来。 */
    'long long omni_ext_ten(long long a, long long b, long long c, long long d, long long e,'
      + ' long long f, long long g, long long h, long long i, long long j){'
      + ' return a + b*2 + c*3 + d*4 + e*5 + f*6 + g*7 + h*8 + i*9 + j*10; }',
    /* 十个 double：第九、十个走栈。 */
    'double omni_ext_tend(double a, double b, double c, double d, double e,'
      + ' double f, double g, double h, double i, double j){'
      + ' return a + b*2 + c*3 + d*4 + e*5 + f*6 + g*7 + h*8 + i*9 + j*10; }'];
  const calls = [];
  for (const c of cases) {
    main.push(`extern long long ${c.f.name}(long long, long long);`);
    calls.push(`  printf("%lld\\n", ${c.f.name}(${c.args[0]}LL, ${c.args[1]}LL));`);
  }
  /* 浮点那批：实参与期望值都按**位模式**过手，十进制文本一次都不经过。 */
  for (const c of dcases) {
    main.push(`extern double ${c.f.name}(double, double);`);
    calls.push(`  printf("%llu\\n", d2b(${c.f.name}(b2d(${d2b(c.args[0])}ULL),`
      + ` b2d(${d2b(c.args[1])}ULL))));`);
  }
  /* 存取那批：**地址就是真指针**（native 这条腿上没有线性内存），所以第一个实参直接传
   * `membuf + 偏移`，不需要任何基址寄存器、也不需要蹦床。 */
  if (mcases.length > 0) {
    main.push('static char membuf[65536];');
    for (const c of mcases) {
      main.push(`extern long long ${c.f.name}(long long, long long);`);
      calls.push(`  printf("%lld\\n", ${c.f.name}((long long)(membuf + ${c.args[0]}),`
        + ` ${c.args[1]}LL));`);
    }
  }
  /* 变参的定义那批：调用点由用例自己写（实参个数与类型各不相同）。 */
  for (const c of vcases) {
    main.push(c.decl);
    calls.push(`  printf("%lld\\n", ${c.call});`);
  }
  /* 最后一格不是「调一个函数」，而是**从 C 那边直接读我们定义的数据符号** ——
   * 上一条用例刚把 12345 存进 `omni_g_i64`。这条查的是「__DATA 里那格是个真符号」。 */
  main.push('extern long long omni_g_i64;');
  calls.push('  printf("%lld\\n", omni_g_i64);');
  main.push('int main(void) {', ...calls, '  return 0;', '}');
  writeFileSync(join(dir, 'main.c'), main.join('\n') + '\n');
  execFileSync(CLANG, ['-o', join(dir, 'prog'), join(dir, 'main.c'), objPath]);
  const out = execFileSync(join(dir, 'prog'), { encoding: 'utf8' }).trim().split('\n');
  const all = [...cases, ...dcases, ...mcases, ...vcases,
    { what: 'C 那边直接读 __DATA 里的符号', want: 12345n }];
  if (out.length !== all.length) {
    process.stdout.write(`arm64/from-mir: 印了 ${out.length} 行，用例 ${all.length} 条\n`);
    process.exit(1);
  }
  total = all.length;
  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    /* 位模式那几条印出来是**有符号**的十进制（`%lld`），所以两边都按 64 位无符号看齐。 */
    if (BigInt.asUintN(64, BigInt(out[i])) === BigInt.asUintN(64, c.want)) continue;
    failed++;
    process.stdout.write(`  FAIL ${c.what}\n    ours ${out[i]}\n    want ${c.want}\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${total - failed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
