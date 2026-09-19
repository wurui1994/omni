/**
 * MIR 优化管线的入口（ADR-0039）。**一处 import 全部通道**，别处只看这一格。
 *
 * 为什么要有这个文件：通道是靠各自模块顶层的 `registerPass` 挂上去的，所以"谁都没
 * import 过某个 pass 文件"= 那一格静悄悄不跑。入口这儿把它们全拉一遍，通道表就是
 * 权威的那一份（`passStatus()` 印出来的"已实现 N 格"于是可信）。
 *
 * 档位：`OMNI_MIR_OPT=0..3`，缺省 **0 = 不跑**（连 required 的也不跑）。
 * 与 Go 的差别只在这儿一格：它没有"整条管线关掉"这档，我们要，因为四条后端腿现在
 * 都有"同一份输入两次编译逐字节相同"的判据（ADR-0014 决策 5），而优化会改字节 ——
 * 默认关着，开的那一档自己带判据。
 */

import { runPasses, passStatus, checkPassTable } from './pass.js';

/* 注册各格（顺序无关：位置在通道表里，不在 import 的次序上）。 */
import './ssa.js';       // early phielim and copyelim
import './deadcode.js';  // 八格 *deadcode
import './rewrite.js';   // opt / middle opt / late opt
import './cse.js';       // zero arg cse / generic cse / lowered cse
import './autos.js';     // elim unread autos

export { passStatus, checkPassTable };

/** `OMNI_MIR_OPT` 的文本 -> 档位。认不出来的当 0（不跑），不猜。 */
export function mirOptLevel(text) {
  if (text === undefined || text === null || text === '') return 0;
  if (text === '1') return 1;
  if (text === '2') return 2;
  if (text === '3') return 3;
  return 0;
}

/**
 * 整个模块跑一遍管线。回统计 `{funcs, before, after, log}`。
 *
 * `extern` 与 `decl` 的函数没有函数体，跳过 —— 它们的 `op` 数组是空的，
 * 跑过去不炸但白费。
 */
export function optimizeMir(mod, opts) {
  const o = opts || {};
  const level = o.level === undefined ? 0 : o.level;
  if (level <= 0) return { funcs: 0, before: 0, after: 0, log: [] };
  const log = o.log === undefined ? null : o.log;
  let before = 0, after = 0, n = 0;
  for (const fn of mod.funcs) {
    if (fn.extern === true || fn.decl === true) continue;
    if (fn.op.length === 0) continue;
    before += fn.op.length;
    runPasses(fn, mod, { level, only: o.only, log });
    after += fn.op.length;
    n++;
  }
  return { funcs: n, before, after, log: log === null ? [] : log };
}
