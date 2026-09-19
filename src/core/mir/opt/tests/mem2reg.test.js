/**
 * mem2reg 的判据：**拿真的 MIR（C 前端出的）跑两遍解释器，答案必须一样**。
 * 手搓的 IR 证明不了"能接真产物"，所以这一格从 `.c` 出发。
 *
 * 跑：`node src/core/mir/opt/tests/mem2reg.test.js`
 */

import { mem2reg } from '../ssa.js';
import { OP, OP_NAMES } from '../../ir.js';
import { runMirModule } from '../../interp.js';
import { printMir } from '../../print.js';
import { cMir } from '../../../lang/c.js';
import { verifyMir } from '../../verify.js';

let fails = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { console.log('  ✗ ' + m); fails++; } };

/** 数一数各 op 出现几次 */
function opCount(fn) {
  const c = {};
  for (const o of fn.op) { const n = OP_NAMES[o]; c[n] = (c[n] || 0) + 1; }
  return c;
}

const SRC = `
int sum(int n) { int s = 0; int i = 0; while (i < n) { s = s + i; i = i + 1; } return s; }
int straight(int a, int b) { int x = a + b; int y = x * 2; int z = y - a; return z; }
int main(void) { return straight(3, 4) + sum(5); }
`;

import { writeFileSync } from 'node:fs';
const path = '/tmp/omni-mir-opt-test.c';
writeFileSync(path, SRC);

console.log('== 从 .c 拿真 MIR');
const mod = cMir(path, [], [], [], undefined, undefined);
ok(mod.funcs.length >= 3, `拿到 ${mod.funcs.length} 个函数`);

/* ---- 优化前：解释器跑一遍 ---- */
const OIR0 = { structs: [], enums: [], classes: [] };  // C 那条腿没有 OIR，给个空的
const before = runMirModule(OIR0, mod);
console.log(`  优化前 main 回 ${before}`);

/* ---- 各函数逐个 mem2reg ---- */
let total = 0;
const perFn = [];
for (const fn of mod.funcs) {
  const c0 = opCount(fn);
  const n = mem2reg(fn, mod) || 0;
  const c1 = opCount(fn);
  total += n;
  perFn.push({
    name: fn.name, changed: n,
    load: (c0.LOAD || 0) + ' → ' + (c1.LOAD || 0),
    store: (c0.STORE || 0) + ' → ' + (c1.STORE || 0),
  });
}
for (const r of perFn) console.log(`  ${r.name}: 改写 ${r.changed} 处引用（LOAD ${r.load}，STORE ${r.store} —— 指令一条不删）`);
ok(total > 0, `一共改写了 ${total} 处引用（LOAD 变成直接引用那个值）`);

/* ---- 优化后：先过 verifier（改图不许改坏形状），再跑解释器 ---- */
const errs = verifyMir(mod);
ok(errs.length === 0, 'verifyMir 干净' + (errs.length ? '：' + errs.slice(0, 3).join(' / ') : ''));

const after = runMirModule(OIR0, mod);
console.log(`  优化后 main 回 ${after}`);
ok(String(before) === String(after), `答案不变（${before} == ${after}）`);

console.log('');
if (fails > 0) { console.log(`✗ ${fails} 条不过`); process.exit(1); }
console.log('✓ 全过');
