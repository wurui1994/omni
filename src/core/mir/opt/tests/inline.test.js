/**
 * inline 的判据。四件事：
 *   1. 直接调用真被展开（`CALL` 少了、指令变多 —— 这一格是拿大小换调用）
 *   2. **答案逐字不变**（解释器腿；里头有多返回点、有循环、有 struct 按值传）
 *   3. 不许碰的那几类一条都没动：递归、变参、`CCALL`（别人的 ABI）
 *   4. `verifyMir` 干净（区域配对、ref 支配、槽号范围都得对）
 *
 * 为什么这一格值得单独一条判据：内联要同时重编号**指令 ref、槽号、帧块号、实参池**
 * 四样，而 `RET` 还得翻成"存进结果槽 + 跳出包的那层 BLOCK"（MIR 的 BR 不带值）。
 * 哪一样错了都是当场的错答案。
 *
 * 跑：`node src/core/mir/opt/tests/inline.test.js`
 */

import { inlineCalls } from '../inline.js';
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
#include <stdio.h>
typedef struct { int a, b, c; } Big;      /* 24 字节以下但 >16：走 ARGMEM/ARGSRET 那条路 */

static int sq(int x) { return x * x; }
/* 多返回点：两条 RET 都要翻成"存结果 + 跳出去" */
static int pick(int a, int b) { if (a > b) return a; return b; }
/* 循环 + 局部块：槽号与帧块号都要重编号 */
static int sum(int n) { int t[2]; t[0] = 0; t[1] = n; for (int i = 0; i < n; i++) t[0] += i; return t[0] + t[1]; }
/* struct 按值传 + 按值返回：实参里是 ARGMEM/ARGSRET，要剥一层拿地址 */
static Big mk(int k) { Big r; r.a = k; r.b = k * 2; r.c = k * 3; return r; }
static int useBig(Big x) { return x.a + x.b + x.c; }
/* 递归：一条都不许展开 */
static int fact(int n) { if (n <= 1) return 1; return n * fact(n - 1); }

int main(void) {
  int s = sq(3) + pick(4, 9) + sum(5) + useBig(mk(2)) + fact(4);
  printf("s=%d\\n", s);
  return s;
}
`;

const path = '/tmp/omni-mir-inline-test.c';
writeFileSync(path, SRC);

const OIR0 = { structs: [], enums: [], classes: [] };
const base = cMir(path, [], [], [], undefined, undefined);
const want = runMirModule(OIR0, base);
const c0 = {};
for (const f of base.funcs) c0[f.name] = opCount(f);

const mod = cMir(path, [], [], [], undefined, undefined);
let sites = 0;
const rows = [];
for (const fn of mod.funcs) {
  const before = fn.op.length;
  const n = inlineCalls(fn, mod) || 0;
  deadcode(fn, mod);
  sites += n;
  if (n > 0) rows.push(`${fn.name}: 展开 ${n} 处，${before} → ${fn.op.length}`);
}
const c1 = {};
for (const f of mod.funcs) c1[f.name] = opCount(f);

console.log('== inline');
for (const r of rows) console.log('  ' + r);
ok(sites > 0, `一共展开 ${sites} 处`);
ok((c1.main.CALL || 0) < (c0.main.CALL || 0),
  `main 里的 CALL 少了（${c0.main.CALL || 0} → ${c1.main.CALL || 0}）`);
/* 递归那一个：`fact` 里对自己的调用一条都不许少 */
ok((c1.fact.CALL || 0) === (c0.fact.CALL || 0), 'fact 里对自己的递归调用没被展开');
/* `CCALL`（C_ABI，别人的 ABI）永远不当调用点展开。
   注意不能按 main 里的条数比：这条腿上 `printf` 在 MIR 里是一个**包装函数**
   （main 里那 7 条全是 `CALL`），内联把那个包装也吃进来了，于是 main 里**多**出一条
   CCALL —— 那是对的。判据因此是"模块里的 CCALL 一条都没少"。 */
let cc0 = 0, cc1 = 0;
for (const f of base.funcs) cc0 += opCount(f).CCALL || 0;
for (const f of mod.funcs) cc1 += opCount(f).CCALL || 0;
ok(cc1 >= cc0, `CCALL 一条都没被当调用点展开（模块里 ${cc0} → ${cc1}）`);

const errs = verifyMir(mod);
ok(errs.length === 0, 'verifyMir 干净' + (errs.length ? '：' + errs.slice(0, 4).join(' / ') : ''));
const got = runMirModule(OIR0, mod);
ok(String(got) === String(want), `答案逐字相同（${got} == ${want}）`);

console.log('');
if (fails > 0) { console.log(`✗ ${fails} 条不过`); process.exit(1); }
console.log('✓ 全过');
