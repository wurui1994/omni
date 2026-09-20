/**
 * cse 的判据：**真 .c 出的 MIR，重复的子表达式只剩一份、答案不变**。
 *
 * 三个形状：块内重复、跨块（支配者在前）、以及**不许合并的那一类**
 * （中间有写，所以两次读不是同一个值）。
 *
 * 跑：`node src/core/mir/opt/tests/cse.test.js`
 */

import { cse } from '../cse.js';
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
/* 块内重复：(a*b) 算了三遍 */
int dup(int a, int b) { return (a * b) + (a * b) + (a * b); }

/* 交换律：a*b 与 b*a 是同一个值（Go 的 Commutative 那一栏） */
int comm(int a, int b) { return (a * b) + (b * a); }

/* 跨块：第一次算在 if 之前（支配后面那一块），分支里再用一次。
   **兄弟分支里的两份不算**：cse 只在支配关系成立时合并，从不把计算往上提
   （Go 的 cse 也不提，提是 licm 那一格的事）。 */
int cross(int a, int b, int c) {
  int r = (a + b) * 2;
  if (c) { r = r + (a + b); }
  return r;
}

/* **不许合并**：中间改了 a，两个 a+b 不是同一个值。
   这个函数里一共四条 ADD（a+b、a+1、a+b、x*10+y 那一条），一条都不许少。 */
int nomerge(int a, int b) { int x = a + b; a = a + 1; int y = a + b; return x * 10 + y; }

int main(void) {
  return dup(3, 4) + comm(3, 4) + cross(1, 2, 1) + nomerge(5, 6);
}
`;

const path = '/tmp/omni-mir-cse-test.c';
writeFileSync(path, SRC);

const base = cMir(path, [], [], [], undefined, undefined);
const OIR0 = { structs: [], enums: [], classes: [] };
const want = runMirModule(OIR0, base);
let n0 = 0;
for (const fn of base.funcs) n0 += fn.op.length;
console.log(`== 不优化：main 回 ${want}，指令总数 ${n0}`);

/* 先 mem2reg + deadcode（把 LOAD 消成直接引用，cse 才认得出"同一个值"），再 cse */
const mod = cMir(path, [], [], [], undefined, undefined);
let moved = 0;
const rows = [];
for (const fn of mod.funcs) {
  mem2reg(fn, mod);
  deadcode(fn, mod);
  const before = fn.op.length;
  const mv = cse(fn, mod) || 0;
  deadcode(fn, mod);
  moved += mv;
  if (before !== fn.op.length) rows.push(`${fn.name}: ${before} → ${fn.op.length}（改了 ${mv} 处引用）`);
}
console.log('== mem2reg + deadcode + cse + deadcode');
for (const r of rows) console.log('  ' + r);
ok(moved > 0, `一共改了 ${moved} 处引用`);

const dup = opCount(mod.funcs.find((f) => f.name === 'dup'));
ok((dup.MUL || 0) === 1, `dup 里只剩一条 MUL（得 ${dup.MUL || 0}）`);
const comm = opCount(mod.funcs.find((f) => f.name === 'comm'));
ok((comm.MUL || 0) === 1, `comm 里只剩一条 MUL（交换律，得 ${comm.MUL || 0}）`);
const cross = opCount(mod.funcs.find((f) => f.name === 'cross'));
/* 三条 ADD：`(a+b)*2` 那一条、if 里那一条 `r + (a+b)`、还有 if 里那份 a+b。
   **合不掉**是成本模型的结果（`cost.js`）：mem2reg 不再把 a/b 的 LOAD 跨屏障转发进
   if 那一块，于是两处的 a+b 用的是两对不同的 LOAD ref，cse 认不出它们是同一个值。
   量出来的账在 cost.js 里：跨屏障的合并在这两条后端上是净亏。 */
ok((cross.ADD || 0) === 3, `cross 里剩三条 ADD（跨屏障不合并，得 ${cross.ADD || 0}）`);
const nm = opCount(mod.funcs.find((f) => f.name === 'nomerge'));
ok((nm.ADD || 0) === 4, `nomerge 里四条 ADD 一条不许少（得 ${nm.ADD || 0}）`);

let n1 = 0;
for (const fn of mod.funcs) n1 += fn.op.length;
ok(n1 < n0, `指令总数 ${n0} → ${n1}（少了 ${n0 - n1} 条，${((1 - n1 / n0) * 100).toFixed(1)}%）`);

const errs = verifyMir(mod);
ok(errs.length === 0, 'verifyMir 干净' + (errs.length ? '：' + errs.slice(0, 4).join(' / ') : ''));
const got = runMirModule(OIR0, mod);
ok(String(got) === String(want), `答案逐字相同（${got} == ${want}）`);

let again = 0;
for (const fn of mod.funcs) again += cse(fn, mod) || 0;
ok(again === 0, `再跑一遍改 0 处（到了不动点），实得 ${again}`);

console.log('');
if (fails > 0) { console.log(`✗ ${fails} 条不过`); process.exit(1); }
console.log('✓ 全过');
