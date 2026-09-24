// ext/r/rt/ffi.js —— **R 的数值运行时这一格的自动 FFI**
//
// 一句话：拿 `cap('c.declsOf')` 读**我们自己生成的那份** `Rmath.h`，出一张
// `名字 → {ret, params}` 表。adapter 照这张表发 `(cabi …)` 与 `(ccall …)`，
// 于是 R 的 `round` / `signif` / `dnorm` 由 **R 自己的 C 代码**答。
//
// ## 三条纪律
//
//   1. **签名不手抄。** 一份 271 条声明的头，手抄一遍就是手抄一遍的错，而那种错的症状是
//      "调用约定对不上，值是垃圾"——没有根因可查。这条路与 jnc 的 `import "lib" with "h.h"`
//      是**同一条**（`frontend-jnc/lower.js` 的 `impWith`），不新开。
//   2. **读的是生成出来的那份头，不是装好的 R 的。** 那份头与 `libomniRmath` 出自同一棵
//      源码树、同一次构建 —— 签名与二进制必须是同一个来源，不然就是"拿 A 的头调 B 的库"。
//   3. **缺了就现场编。** `omni run x.R` 不该要求人先记住去敲一句构建命令；
//      编不出来当场报，并且把那句命令印出来 —— 不许悄悄退回"我们自己算"（那正是这一版
//      要去掉的东西）。

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cDeclsOf, cSysInclude } from '../../../src/core/lang/c.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const OUT = join(ROOT, '.omni-cache', 'r-rt');
const GEN = join(OUT, 'include');
const HDR = join(GEN, 'Rmath.h');

/** `libomniRmath` 落在哪儿。与 `ext/r/build.js` 里那一格必须是同一条路径。 */
export const RMATH_LIB = join(OUT, `libomniRmath${process.platform === 'darwin' ? '.dylib' : '.so'}`);

/** 一趟里只编一次、只读一次那份头。 */
let sigs = null;
let built = false;

/**
 * 保证 `libomniRmath` 与那份 `Rmath.h` 在。不在就跑一遍 `ext/r/build.js`。
 *
 * 为什么是 spawn 而不是 import 那份 build.js：它是**一份程序**（有 `b.run(process.argv)`），
 * import 它等于在我们的进程里执行别人的 main —— 与 `omni ninja` 把 `.js` 入口转交
 * `node build.js` 同一条理由（`build/cli.js` 文件头）。
 */
function ensure() {
  if (existsSync(HDR) && existsSync(RMATH_LIB)) return;
  if (built) {
    throw new Error(`r->IR: R 的 C 运行时编不出来 —— 手敲一遍看它说什么：\n`
      + `  node ext/r/build.js`);
  }
  built = true;
  const r = spawnSync(process.execPath, [join(HERE, '..', 'build.js'), '-j', '8'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 << 20,
  });
  if (r.status !== 0 || !existsSync(HDR) || !existsSync(RMATH_LIB)) {
    throw new Error('r->IR: R 的 C 运行时编不出来 —— '
      + `${String(r.stderr ?? '').split('\n').filter((s) => s !== '').slice(-3).join(' / ')}\n`
      + '  （手敲一遍：node ext/r/build.js）');
  }
}

/**
 * 那两份头里所有函数声明：`名字 → {ret, params}`（`params` 是 `(cabi …)` 那套类型词
 * `i32 i64 f64 ptr void`，`c.declsOf` 已经折好了）。
 *
 * 两份：R 的 `Rmath.h`（生成出来的那一份）与**我们自己那一份** `omni_rna.h`
 * （`NA` / `NaN` / `Inf` 三格真值 —— 它们在 R 那边属于解释器，nmath 里没有）。
 * 两份都过同一个 `c.declsOf`：签名只有"从头里读"这一个来源，我们自己那几格也不手抄。
 */
export function rmathSigs() {
  if (sigs !== null) return sigs;
  ensure();
  const opts = { includeDirs: [GEN, join(HERE)], sysIncludeDirs: cSysInclude() };
  sigs = new Map();
  for (const h of [HDR, join(HERE, 'omni_rna.h')]) {
    const got = cDeclsOf(h, opts, [['MATHLIB_STANDALONE', '1']]);
    for (const d of got.decls) {
      sigs.set(d.name, { ret: d.ret, params: d.params, variadic: d.variadic === true });
    }
  }
  return sigs;
}

/**
 * 一格签名，查不到当场报 —— 报的话把"那份头里有没有它"这件事说清。
 * 查不到的两种真原因：R 改了名字（`dnorm` 在头里叫 `dnorm4`），或者那棵树版本不对。
 */
export function rmathSig(sym) {
  const s = rmathSigs().get(sym);
  if (s === undefined) {
    throw new Error(`r->IR: ${sym} 不在 R 的 Rmath.h 里（读到 ${rmathSigs().size} 条声明）——`
      + ' 要么名字写错了（`dnorm` 在头里叫 `dnorm4`），要么参考树的版本不对');
  }
  return s;
}
