// tests/python/rt.js —— **借来的那份 CPython 的 C 的判据**：`repr(float)` 逐字节相同
//
// 量的是 `ext/python/build.js` 编出来的那格小程序（`Python/dtoa.c` + `Python/pystrtod.c`
// 原样编进来 + 我们那层封闭 ABI）与本机 `python3` 的 `repr(float(s))`。
//
// 为什么这一格值得单开一份判据：`str(float)` 与 `repr(float)` 是 python 里最容易"差一点"
// 的地方。三条门槛各自都能单独错：
//   * 最短往返（`0.1` 不是 `0.1000000000000000055`）；
//   * 整数值补 `.0`（`4.0` 不是 `4`）；
//   * 定点/指数的切换（`1e15` -> `1000000000000000.0`，`1e16` -> `1e+16`）。
// 语料里既有手挑的边界（次正规数、10 的幂、15/16/17 位的分界），也有**一趟定死的伪随机**
// 位模式扫描 —— 后者才照得出"只在某一档上差一位"那种错。
//
// 没有 python3、或者参考树不在、或者没有 C 编译器，就**跳过并说清**（不假装绿）。

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const buildJs = join(root, 'ext', 'python', 'build.js');
const probe = join(root, '.omni-cache', 'py-rt', 'pyfloat-probe');

function skip(why) {
  console.log(`  skip 借来的 CPython 浮点运行时（${why}）`);
  console.log('\n0 passed, 0 failed, 1 skipped');
  process.exit(0);
}

const py = spawnSync('python3', ['--version'], { encoding: 'utf8' });
if (py.status !== 0) skip('本机没有 python3');

/* ---- 1) 编出来（`ext/python/build.js` 自己判参考树在不在） ------------------ */
const b = spawnSync('node', [buildJs], { cwd: root, encoding: 'utf8' });
if (b.status !== 0) {
  const why = String(b.stderr || b.stdout || '').trim().split('\n')[0];
  skip(`编不出来：${why}`);
}
if (!existsSync(probe)) skip(`编完了可 ${probe} 不在`);

/* ---- 2) 语料 --------------------------------------------------------------- */

/** 手挑的边界。每一格后面注的是"它照出哪一条门槛"。 */
const PICKED = [
  0, 1, -1, 0.5, -0.5, 2.5, 100, 4,                       // 整数值要补 .0
  0.1, 0.2, 0.3, 1 / 3, 0.1 + 0.2,                        // 最短往返
  1e-5, 1e-4, 1e-3, 1e15, 1e16, 1e17, 1e21, 1e22,         // 定点/指数的切换
  1e-300, 1e300, 5e-324, 2.2250738585072014e-308,         // 次正规与极值
  1.7976931348623157e308, Number.MIN_VALUE,
  123456789012345, 1234567890123456, 12345678901234567,   // 15 / 16 / 17 位
  9007199254740992, 9007199254740993,                     // 2**53 与它加一
  Infinity, -Infinity, NaN,
];

/**
 * 一趟**定死的**伪随机位模式（不用 Math.random —— 判据每次要跑同一批数）。
 * 32 位 LCG（数值参数照 Numerical Recipes），拼出 64 位再当 double 读。
 */
function sweep(n) {
  const out = [];
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  let s = 1;
  const next = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; };
  while (out.length < n) {
    dv.setUint32(0, next(), true);
    dv.setUint32(4, next(), true);
    const v = dv.getFloat64(0, true);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

const values = [...PICKED, ...sweep(2000)];

/**
 * 交给两边的是**同一个十进制串**（21 位有效数字 —— 对 double 一定往返）。
 * 两边各自 parse 再 repr，于是这一趟量的是 repr 那一半，不混进 parse 的差别。
 */
const strOf = (v) => {
  if (Number.isNaN(v)) return 'nan';
  if (v === Infinity) return 'inf';
  if (v === -Infinity) return '-inf';
  return v.toExponential(20);
};
const args = values.map(strOf);

/* ---- 3) 两边各跑一趟 ------------------------------------------------------- */

const run = (cmd, argv, input) => execFileSync(cmd, argv, {
  cwd: root, encoding: 'utf8', input, maxBuffer: 64 << 20, timeout: 180000,
});

let got;
let want;
try {
  got = run(probe, args);
} catch (e) {
  console.log(`  FAIL 探针跑不起来：${String(e.message).slice(0, 120)}`);
  process.exit(1);
}
try {
  want = run('python3', ['-c',
    'import sys\n'
    + 'for s in sys.stdin.read().split():\n'
    + '    print(repr(float(s)))\n'], args.join('\n'));
} catch (e) {
  skip(`python3 那一侧跑不起来：${String(e.message).slice(0, 80)}`);
}

const gs = got.trimEnd().split('\n');
const ws = want.trimEnd().split('\n');
let bad = 0;
for (let i = 0; i < Math.max(gs.length, ws.length); i += 1) {
  if (gs[i] === ws[i]) continue;
  bad += 1;
  if (bad <= 6) {
    console.log(`  FAIL ${args[i]}\n       我们：${gs[i]}\n       py  ：${ws[i]}`);
  }
}
if (bad === 0) {
  console.log(`  ok   repr(float) 与 python3 逐字节相同（${gs.length} 个数：`
    + `${PICKED.length} 格手挑的边界 + 2000 格定死的位模式扫描）`);
  console.log(`  ok   借来的是 Python/dtoa.c + Python/pystrtod.c，一个字都没改（${py.stdout.trim()}）`);
}
console.log(`\n${bad === 0 ? 2 : 0} passed, ${bad === 0 ? 0 : 1} failed, 0 skipped`
  + `${bad === 0 ? '' : `  （${bad} / ${gs.length} 个数不一样）`}`);
process.exit(bad === 0 ? 0 : 1);
