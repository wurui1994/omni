/**
 * deadcode 的判据：**真 .c 出的 MIR，mem2reg + deadcode 之后答案不变、指令真的少了**。
 *
 * 三样一起看（少一样就可能是假的）：
 *   1. `verifyMir` 干净 —— 重编号没把 ref 指歪、区域没破
 *   2. 解释器答案与优化前逐字相同
 *   3. 指令条数**下降**（mem2reg 的战果要在这一格才变成真的删）
 *
 * 源码里刻意有：带实参池的调用（重编号要改池里的 ref）、纯的死算术（该删）、
 * 除零风险的除法与数组下标（**不许删**）。
 *
 * 跑：`node src/core/mir/opt/tests/deadcode.test.js`
 */

import { mem2reg } from '../ssa.js';
import { deadcode } from '../deadcode.js';
import { OP_NAMES } from '../../ir.js';
import { runMirModule } from '../../interp.js';
import { cMir } from '../../../lang/c.js';
import { verifyMir } from '../../verify.js';
import { writeFileSync } from 'node:fs';

let fails = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { console.log('  ✗ ' + m); fails++; } };

function opCount(fn) {
  const c = {};
  for (const o of fn.op) { const n = OP_NAMES[o]; c[n] = (c[n] || 0) + 1; }
  return c;
}

const SRC = `
int add3(int a, int b, int c) { return a + b + c; }

int sum(int n) { int s = 0; int i = 0; while (i < n) { s = s + i; i = i + 1; } return s; }

int deadstuff(int a, int b) {
  int live = a + b;
  int dead1 = a * 7;          /* 没人用 —— 该删 */
  int dead2 = dead1 - b;      /* 只被 dead1 那条喂 —— 也该删 */
  int q = a / (b + 1);        /* 除法：没人用也不许删（除零是可观察的） */
  return live;
}

int arr(int n) {
  int t[4];
  t[0] = n; t[1] = n + 1; t[2] = n + 2; t[3] = n + 3;
  return t[0] + t[3];
}

int main(void) {
  return add3(1, 2, 3) + sum(5) + deadstuff(4, 5) + arr(10);
}
`;

const path = '/tmp/omni-mir-deadcode-test.c';
writeFileSync(path, SRC);

console.log('== 从 .c 拿真 MIR');
const mod = cMir(path, [], [], [], undefined, undefined);
ok(mod.funcs.length >= 5, `拿到 ${mod.funcs.length} 个函数`);

const OIR0 = { structs: [], enums: [], classes: [] };
const before = runMirModule(OIR0, mod);
console.log(`  优化前 main 回 ${before}`);

let n0 = 0;
for (const fn of mod.funcs) n0 += fn.op.length;

/* ---- mem2reg（只改引用）+ deadcode（删）---- */
let moved = 0, killed = 0;
const rows = [];
for (const fn of mod.funcs) {
  const c0 = opCount(fn);
  const before0 = fn.op.length;
  const mv = mem2reg(fn, mod) || 0;
  const kl = deadcode(fn, mod) || 0;
  const c1 = opCount(fn);
  moved += mv; killed += kl;
  rows.push({
    name: fn.name, mv, kl, insn: before0 + ' → ' + fn.op.length,
    load: (c0.LOAD || 0) + ' → ' + (c1.LOAD || 0),
    div: (c0.DIV || 0) + ' → ' + (c1.DIV || 0),
  });
}
for (const r of rows) {
  console.log(`  ${r.name}: 改写 ${r.mv} 处、删 ${r.kl} 条（指令 ${r.insn}，LOAD ${r.load}，DIV ${r.div}）`);
}

let n1 = 0;
for (const fn of mod.funcs) n1 += fn.op.length;

ok(killed > 0, `一共删了 ${killed} 条`);
ok(n1 < n0, `指令总数下降：${n0} → ${n1}（少了 ${n0 - n1} 条，${((1 - n1 / n0) * 100).toFixed(1)}%）`);

/* 除法一条不许少（deadstuff 里那个 q 没人用，但除零是可观察的） */
const ds = mod.funcs.find((f) => f.name === 'deadstuff');
ok(ds !== undefined && opCount(ds).DIV >= 1, 'deadstuff 里的 DIV 还在（不许删会报错的指令）');

const errs = verifyMir(mod);
ok(errs.length === 0, 'verifyMir 干净' + (errs.length ? '：' + errs.slice(0, 4).join(' / ') : ''));

const after = runMirModule(OIR0, mod);
console.log(`  优化后 main 回 ${after}`);
ok(String(before) === String(after), `答案不变（${before} == ${after}）`);

/* ---- 幂等：再跑一遍不该再删得掉东西（也顺手验重编号没留下悬空 ref） ---- */
let again = 0;
for (const fn of mod.funcs) again += deadcode(fn, mod) || 0;
ok(again === 0, `再跑一遍删 0 条（幂等），实得 ${again}`);
const after2 = runMirModule(OIR0, mod);
ok(String(after2) === String(before), `两遍之后答案仍然不变（${after2}）`);

console.log('');
if (fails > 0) { console.log(`✗ ${fails} 条不过`); process.exit(1); }
console.log('✓ 全过');
