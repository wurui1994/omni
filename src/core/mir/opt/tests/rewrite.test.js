/**
 * opt（常量折叠 + 代数化简）的判据：**真 .c 出的 MIR，答案不变、指令真的少了**。
 *
 * 源码里每一行都对着 `generic.rules` 的一条规则，所以这一格红了能直接指到哪条规则。
 *
 * 跑：`node src/core/mir/opt/tests/rewrite.test.js`
 */

import { opt } from '../rewrite.js';
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
int ident(int n) {
  int a = n * 1;          /* :218 Mul x 1 => x */
  int b = a + 0;          /* :684 Add x 0 => x */
  int c = b | 0;          /* :667 Or  x 0 => x */
  int d = c ^ 0;          /* :681 Xor x 0 => x */
  int e = d & -1;         /* :674 And x -1 => x */
  int f = e << 0;         /* :505 Lsh x 0 => x */
  return f;
}
int zeros(int n) {
  int a = n * 0;          /* :686 Mul 0 _ => 0 */
  int b = n - n;          /* :685 Sub x x => 0 */
  int c = n ^ n;          /* :680 Xor x x => 0 */
  int d = n & 0;          /* :675 And 0 _ => 0 */
  return a + b + c + d;
}
int addsub(int n) { return (n + 3) - 3; }        /* :816 Sub (Add x y) y => x */
int negneg(int n) { return -(-n); }              /* :720 Neg (Neg x) => x */
int notnot(int n) { return ~(~n); }              /* :689 Com (Com x) => x */
double fmul(double x) { return x * 1.0; }        /* :1370 MulF x 1 => x */

/* 存储转发（:839 Load of store of same address）。t[1] 那一条写在中间，
   与 t[0] **一定不相交**（同基址、两个常量偏移），所以往回找不许被它挡住。 */
int fwd(int n) { int t[2]; t[0] = n + 1; t[1] = 7; return t[0]; }

int main(void) {
  int s = ident(7) + zeros(9) + addsub(11) + negneg(13) + notnot(15);
  return s + (int)fmul(2.0) + fwd(20);
}
`;

const path = '/tmp/omni-mir-rewrite-test.c';
writeFileSync(path, SRC);

const base = cMir(path, [], [], [], undefined, undefined);
const OIR0 = { structs: [], enums: [], classes: [] };
const want = runMirModule(OIR0, base);
let n0 = 0;
for (const fn of base.funcs) n0 += fn.op.length;
console.log(`== 不优化：main 回 ${want}，指令总数 ${n0}`);

const mod = cMir(path, [], [], [], undefined, undefined);
let fired = 0, killed = 0;
const rows = [];
for (const fn of mod.funcs) {
  const before = fn.op.length;
  const f = opt(fn, mod) || 0;
  const k = deadcode(fn, mod) || 0;
  fired += f; killed += k;
  if (before !== fn.op.length) rows.push(`${fn.name}: ${before} → ${fn.op.length}（命中 ${f} 条规则）`);
}
console.log('== opt + deadcode');
for (const r of rows) console.log('  ' + r);
ok(fired > 0, `一共命中 ${fired} 条规则、删了 ${killed} 条指令`);

let n1 = 0;
for (const fn of mod.funcs) n1 += fn.op.length;
ok(n1 < n0, `指令总数 ${n0} → ${n1}（少了 ${n0 - n1} 条，${((1 - n1 / n0) * 100).toFixed(1)}%）`);

/* 逐条规则的账：这几个函数应该只剩"读形参、返回" */
const iden = mod.funcs.find((f) => f.name === 'ident');
const ic = opCount(iden);
ok((ic.MUL || 0) === 0 && (ic.ADD || 0) === 0 && (ic.BOR || 0) === 0
   && (ic.BXOR || 0) === 0 && (ic.BAND || 0) === 0 && (ic.SHL || 0) === 0,
  'ident 里那六条恒等运算一条不剩');
const as = opCount(mod.funcs.find((f) => f.name === 'addsub'));
ok((as.SUB || 0) === 0, 'addsub 里的 SUB 没了（Sub (Add x y) y => x）');
const nn = opCount(mod.funcs.find((f) => f.name === 'negneg'));
ok((nn.NEG || 0) === 0, 'negneg 里的两条 NEG 都没了');
const tn = opCount(mod.funcs.find((f) => f.name === 'notnot'));
ok((tn.BNOT || 0) === 0, 'notnot 里的两条 BNOT 都没了');
const fm = opCount(mod.funcs.find((f) => f.name === 'fmul'));
ok((fm.MUL || 0) === 0, 'fmul 里的浮点乘 1 没了');
const fw = opCount(mod.funcs.find((f) => f.name === 'fwd'));
ok((fw.MLOAD || 0) === 0, `fwd 里的 MLOAD 被转发掉了（得 ${fw.MLOAD || 0}）`);

const errs = verifyMir(mod);
ok(errs.length === 0, 'verifyMir 干净' + (errs.length ? '：' + errs.slice(0, 4).join(' / ') : ''));
const got = runMirModule(OIR0, mod);
ok(String(got) === String(want), `答案逐字相同（${got} == ${want}）`);

/* 幂等：再跑一遍不该再命中 */
let again = 0;
for (const fn of mod.funcs) again += opt(fn, mod) || 0;
ok(again === 0, `再跑一遍命中 0 条（到了不动点），实得 ${again}`);

console.log('');
if (fails > 0) { console.log(`✗ ${fails} 条不过`); process.exit(1); }
console.log('✓ 全过');
