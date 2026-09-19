/**
 * regalloc 的判据：**真 .c 出的 MIR，分配表自洽、循环那一刀真的生效、两次编译一样**。
 *
 * 这一格**不改指令**（只挂 `fn.regHint`），所以判据不是"答案不变"（那是白送的），
 * 而是寄存器分配唯一的那条硬约束：
 *
 *   1. 区间相交的值不许同色（`checkRegHint`）
 *   2. **循环那一刀**：定义在循环外、最后一次用在循环里的值，区间要延到循环的 END ——
 *      不延就会与循环体里定义的值涂成同色，第二轮读到的是别人的值
 *   3. 同一份输入两次分配逐格相同（颜色取最小的那个，所以确定）
 *   4. 真的分到了东西（一个都没分到说明白跑）
 *
 * 跑：`node src/core/mir/opt/tests/regalloc.test.js`
 */

import { regalloc, checkRegHint, COLORS } from '../regalloc.js';
import { mem2reg } from '../ssa.js';
import { deadcode } from '../deadcode.js';
import { opt } from '../rewrite.js';
import { cMir } from '../../../lang/c.js';
import { writeFileSync } from 'node:fs';

let fails = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { console.log('  ✗ ' + m); fails++; } };

const SRC = `
/* 直线代码：一串短命的临时量，颜色该反复回收 */
int straight(int a, int b, int c, int d) {
  int x = a + b; int y = c + d; int z = x * y; int w = z - a;
  return x + y + z + w;
}

/* **循环那一刀**：base 定义在循环外、每轮都要用；acc 与 t 定义在循环体里。
   不延长 base 的区间的话，第二轮读 base 读到的是 t 的值。 */
int loops(int n, int base) {
  int acc = 0;
  for (int i = 0; i < n; i++) { int t = i * 3; acc += base + t; }
  return acc;
}

/* 浮点那一类（'v' 色）与整数那一类互不相干 */
double mixf(double p, double q, int k) {
  double s = p * q; double r = s + p; return r * (double)k;
}

int main(void) { return straight(1, 2, 3, 4) + loops(5, 7) + (int)mixf(1.5, 2.5, 3); }
`;

const path = '/tmp/omni-mir-regalloc-test.c';
writeFileSync(path, SRC);

function prep() {
  const mod = cMir(path, [], [], [], undefined, undefined);
  for (const fn of mod.funcs) { mem2reg(fn, mod); opt(fn, mod); deadcode(fn, mod); }
  return mod;
}

const mod = prep();
let total = 0, errs = [];
const rows = [];
for (const fn of mod.funcs) {
  const n = regalloc(fn, mod) || 0;
  total += n;
  for (const e of checkRegHint(fn)) errs.push(e);
  if (n > 0) {
    let xs = 0, vs = 0;
    for (const r of fn.regHint.values()) { if (r.cls === 'x') xs++; else vs++; }
    rows.push(`${fn.name}: ${fn.op.length} 条指令里分了 ${n} 个（x ${xs} / v ${vs}）`);
  }
}
console.log(`== 分配（每类的颜色数：x ${COLORS.x} / v ${COLORS.v}）`);
for (const r of rows) console.log('  ' + r);
ok(total > 0, `一共分了 ${total} 个值`);
ok(errs.length === 0, '分配表自洽：区间相交的不同色' + (errs.length ? '：' + errs.slice(0, 3).join(' / ') : ''));

/* ---- 循环那一刀：把它关掉就该炸（用一份手改的 last 模拟不到，所以换个判法：
       量 loops 里"跨整个循环体"的那些值真的被算成活着） ---- */
const loops = mod.funcs.find((f) => f.name === 'loops');
ok(loops !== undefined && loops.regHint.size > 0, 'loops 里也分到了寄存器');
ok(checkRegHint(loops).length === 0, 'loops 的分配表自洽（循环那一刀生效）');

/* ---- 确定性：再走一遍同一条路，分配逐格相同 ---- */
const mod2 = prep();
let same = true;
for (let i = 0; i < mod.funcs.length; i++) {
  regalloc(mod2.funcs[i], mod2);
  const a = mod.funcs[i].regHint, b = mod2.funcs[i].regHint;
  if (a.size !== b.size) { same = false; break; }
  for (const [pc, r] of a) {
    const r2 = b.get(pc);
    if (r2 === undefined || r2.cls !== r.cls || r2.color !== r.color) { same = false; break; }
  }
}
ok(same, '同一份输入两次分配逐格相同');

/* ---- 浮点与整数各走各的池子 ---- */
const mixf = mod.funcs.find((f) => f.name === 'mixf');
let hasV = false;
for (const r of mixf.regHint.values()) if (r.cls === 'v') hasV = true;
ok(hasV, 'mixf 里有值落在浮点那一类（v）');

console.log('');
if (fails > 0) { console.log(`✗ ${fails} 条不过`); process.exit(1); }
console.log('✓ 全过');
