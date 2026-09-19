/**
 * dse 的判据：**真 .c 出的 MIR，死存储没了、答案不变、该留的一条不少**。
 *
 * 四个形状：
 *   slots     同一个槽连着写两次（中间没读）⇒ 前一条该删
 *   guarded   两次写中间有读 ⇒ 一条不许删
 *   mem       影子栈上同一个地址连着写两次 ⇒ 前一条该删
 *   viacall   两次写中间有调用（可能读内存）⇒ 一条不许删
 *
 * 跑：`node src/core/mir/opt/tests/dse.test.js`
 */

import { dse } from '../dse.js';
import { mem2reg } from '../ssa.js';
import { cse } from '../cse.js';
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
const find = (mod, n) => mod.funcs.find((f) => f.name === n);

const SRC = `
int seen(int x);

/* 同一个槽连着写三次，中间不读 ⇒ 只该剩最后一条 */
int slots(int n) { int v; v = 1; v = 2; v = n; return v; }

/* 中间有读 ⇒ 两条写都得留着。
   读得放在**循环体里**：循环头有两个前驱，mem2reg 传不过去，那条 LOAD 于是活着 ——
   第一版写的是直线代码 "int a = v;"，mem2reg 把它换成了常量 1、deadcode 收走了 LOAD，
   于是那条 STORE **真的**死了，dse 删对了而判据写错了。 */
int guarded(int n) {
  int v = 1; int a = 0;
  for (int i = 0; i < 2; i++) { a += v; v = n; }
  return a + v;
}

/* 影子栈：同一个下标连着写两次 ⇒ 前一条该删 */
int mem(int n) { int t[2]; t[0] = 1; t[0] = n; t[1] = 2; return t[0] + t[1]; }

/* 中间有调用（可能读内存）⇒ 两条写都得留着 */
int viacall(int n) { int t[1]; t[0] = 1; int r = seen(n); t[0] = 2; return t[0] + r; }

int seen(int x) { return x * 2; }

int main(void) { return slots(3) + guarded(4) + mem(5) + viacall(6); }
`;

const path = '/tmp/omni-mir-dse-test.c';
writeFileSync(path, SRC);

const base = cMir(path, [], [], [], undefined, undefined);
const OIR0 = { structs: [], enums: [], classes: [] };
const want = runMirModule(OIR0, base);
/* 基准也先过 mem2reg/cse/deadcode —— 要量的是 **dse 自己**的战果。
   `generic cse` 必须在 dse 之前（Go 的 passOrder 里就有这一对）：dse 判"同一处"靠
   地址是同一个 ref，而 `t[0]=1; t[0]=n;` 那两处的地址是两串一样的 MUL+ADD。 */
const prep = (mod) => {
  for (const fn of mod.funcs) { mem2reg(fn, mod); deadcode(fn, mod); cse(fn, mod); deadcode(fn, mod); }
};
prep(base);
const c0 = {};
for (const f of base.funcs) c0[f.name] = opCount(f);
let n0 = 0;
for (const fn of base.funcs) n0 += fn.op.length;
console.log(`== 不优化：main 回 ${want}，指令总数 ${n0}`);

const mod = cMir(path, [], [], [], undefined, undefined);
prep(mod);
let killed = 0;
for (const fn of mod.funcs) killed += dse(fn, mod) || 0;
const c1 = {};
for (const f of mod.funcs) c1[f.name] = opCount(f);
let n1 = 0;
for (const fn of mod.funcs) n1 += fn.op.length;
console.log(`== dse：删了 ${killed} 条，指令总数 ${n0} → ${n1}`);
for (const name of ['slots', 'guarded', 'mem', 'viacall']) {
  console.log(`  ${name}: STORE ${c0[name].STORE || 0} → ${c1[name].STORE || 0}`
    + `，MSTORE ${c0[name].MSTORE || 0} → ${c1[name].MSTORE || 0}`);
}

ok((c1.slots.STORE || 0) < (c0.slots.STORE || 0), 'slots 里的死 STORE 删掉了');
ok((c1.guarded.STORE || 0) === (c0.guarded.STORE || 0), 'guarded 里的 STORE 一条不少（中间有读）');
ok((c1.mem.MSTORE || 0) === (c0.mem.MSTORE || 0) - 1, 'mem 里死掉的那条 MSTORE 删了、别的没动');
ok((c1.viacall.MSTORE || 0) === (c0.viacall.MSTORE || 0), 'viacall 里的 MSTORE 一条不少（中间有调用）');

const errs = verifyMir(mod);
ok(errs.length === 0, 'verifyMir 干净' + (errs.length ? '：' + errs.slice(0, 4).join(' / ') : ''));
const got = runMirModule(OIR0, mod);
ok(String(got) === String(want), `答案逐字相同（${got} == ${want}）`);

let again = 0;
for (const fn of mod.funcs) again += dse(fn, mod) || 0;
ok(again === 0, `再跑一遍删 0 条（幂等），实得 ${again}`);

console.log('');
if (fails > 0) { console.log(`✗ ${fails} 条不过`); process.exit(1); }
console.log('✓ 全过');
