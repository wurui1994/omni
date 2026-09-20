/**
 * 管线判据 —— **整条通道表按 Go 的次序跑一遍**（不是单格）。
 *
 * 判的是三样：
 *   1. `runPasses` 按表跑完不炸，没实现的格子如实标 todo
 *   2. `verifyMir` 干净、解释器答案与不优化时**逐字相同**
 *   3. 指令总数真的下降（现在这三格的合力：mem2reg → deadcode → elim unread autos）
 *
 * 跑：`node src/core/mir/opt/tests/pipeline.test.js`
 */

import { runPasses, checkPassTable, passStatus, PASSES } from '../pass.js';
import '../ssa.js';        // 注册 early phielim and copyelim
import '../deadcode.js';   // 注册八格 *deadcode
import '../rewrite.js';    // 注册 opt / middle opt / late opt
import '../cse.js';        // 注册 zero arg cse / generic cse / lowered cse
import '../dse.js';        // 注册 dse
import '../autos.js';      // 注册 elim unread autos
import { runMirModule } from '../../interp.js';
import { cMir } from '../../../lang/c.js';
import { verifyMir } from '../../verify.js';
import { writeFileSync } from 'node:fs';

let fails = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { console.log('  ✗ ' + m); fails++; } };

const SRC = `
int add3(int a, int b, int c) { return a + b + c; }
int sum(int n) { int s = 0; int i = 0; while (i < n) { s = s + i; i = i + 1; } return s; }
int unread(int n) { int u = n + 1; int v = 2; v = 3; return n; }
int chain(int a) { int x = a + 1; int y = x + 2; int z = y + 3; return z; }
int arr(int n) { int t[4]; t[0] = n; t[1] = n + 1; return t[0] + t[1]; }
int main(void) { return add3(1, 2, 3) + sum(5) + unread(2) + chain(4) + arr(10); }
`;

const path = '/tmp/omni-mir-pipeline-test.c';
writeFileSync(path, SRC);

console.log('== 通道表自检');
ok(checkPassTable() === true, '通道表与次序约束自洽');
const st = passStatus();
console.log(`  共 ${st.total} 格；要做 ${st.want} 格；已实现 ${st.done} 格`);

console.log('== 不优化的那一遍（基准）');
const base = cMir(path, [], [], [], undefined, undefined);
const OIR0 = { structs: [], enums: [], classes: [] };
const want = runMirModule(OIR0, base);
let n0 = 0;
for (const fn of base.funcs) n0 += fn.op.length;
console.log(`  main 回 ${want}，指令总数 ${n0}`);

console.log('== 跑管线（level 1）');
const mod = cMir(path, [], [], [], undefined, undefined);
const log = [];
for (const fn of mod.funcs) runPasses(fn, mod, { level: 1, log });

/* log 里每个函数一段，取第一段看一眼跑了哪些格 */
const seen = [];
for (const e of log) {
  if (seen.indexOf(e.name) >= 0) break;
  seen.push(e.name);
}
const doneNames = [];
for (const e of log) {
  if (!e.todo && doneNames.indexOf(e.name) < 0) doneNames.push(e.name);
}
console.log(`  这一档要跑 ${seen.length} 格，其中有实现的 ${doneNames.length} 格：${doneNames.join(' → ')}`);
ok(doneNames.length >= 3, '至少三格真跑了');
/* 有实现的那几格必须**按通道表的次序**出现（Go 的表就是次序本身） */
let orderOk = true;
let prev = -1;
for (const nm of doneNames) {
  let idx = -1;
  for (let i = 0; i < PASSES.length; i++) if (PASSES[i].name === nm) idx = i;
  if (idx <= prev) orderOk = false;
  prev = idx;
}
ok(orderOk, '跑的次序就是通道表的次序');

let n1 = 0;
for (const fn of mod.funcs) n1 += fn.op.length;

const errs = verifyMir(mod);
ok(errs.length === 0, 'verifyMir 干净' + (errs.length ? '：' + errs.slice(0, 4).join(' / ') : ''));

const got = runMirModule(OIR0, mod);
ok(String(got) === String(want), `答案逐字相同（${got} == ${want}）`);

/* 指令总数**不是**这一条轴的判据 —— `inline` 那一格是拿代码大小换掉一次调用，
   所以总数会涨（`main` 把 add3/sum/unread/chain/arr 全吃进去了）。
   这儿判的是"与机器无关的那几格确实在缩"：没被内联进别人的那几个函数各自变小。 */
let shrank = 0, grew = 0;
for (let i = 0; i < mod.funcs.length; i++) {
  const x = base.funcs[i].op.length, y = mod.funcs[i].op.length;
  if (y < x) shrank++;
  if (y > x) grew++;
}
console.log(`  指令总数 ${n0} → ${n1}（${n1 > n0 ? '涨' : '降'}了 ${Math.abs(n1 - n0)} 条 ——`
  + ` ${shrank} 个函数变小、${grew} 个因为内联变大）`);
ok(shrank >= 3, `至少三个函数变小（实得 ${shrank}）`);

/* 逐函数的账（看得见是哪一类函数在受益） */
for (let i = 0; i < mod.funcs.length; i++) {
  const a = base.funcs[i], b = mod.funcs[i];
  if (a.op.length !== b.op.length) console.log(`  ${b.name}: ${a.op.length} → ${b.op.length}`);
}

console.log('');
if (fails > 0) { console.log(`✗ ${fails} 条不过`); process.exit(1); }
console.log('✓ 全过');
