/* **栈位按活跃区间复用**（第一百四十四片）—— `regalloc.js` 的 `assignStackHomes`。
 *
 * 为什么要单独一条判据：两个后端的口径是"每个 MIR 值一个栈位"，于是帧的大小正比于
 * **指令条数**。几万条指令的函数上这是"跑不起来"级的问题，而不是"慢一点"——
 * CPython 的 `_PyEval_EvalFrameDefault`（`generated_cases.c.h` 展开出几千个 case，
 * 52438 条 MIR）要 **451KB** 的帧，8MB 的主线程栈递归十几层就踩穿：我们自己编出来的
 * python 崩在那个函数序言的第一条 `str`。复用之后 52438 个值只用 **234** 格。
 *
 * 这一条量的是**那张表本身**（后端怎么用它由 `tests/c` 那 300 份真跑的用例兜住）：
 *   1. 一串"用完就死"的值 —— 格子数与指令条数**无关**（几格就够）；
 *   2. 一串"活到最后"的值 —— 一个都不许省（每个值一格）；
 *   3. 循环里那一格：定义在循环外、循环里还要用的值，区间要延到 `END`，
 *      所以循环体里新定义的值**不许**与它同格（那是 `extendForLoops` 守的东西，
 *      这儿再钉一遍，因为栈位这一侧共用同一份区间）。
 *
 * 跑法：`node tests/mir/stackhome.js`
 */

import {
  MirModule, MirFunc, OP, REF_NONE, REF_BIAS, T_I64, T_VOID,
} from '../../src/core/mir/ir.js';
import { assignStackHomes } from '../../src/core/mir/opt/regalloc.js';

let failed = 0;
let total = 0;
const ok = (what, cond, got) => {
  total += 1;
  if (cond) { process.stdout.write(`  ok   ${what}${got === undefined ? '' : ` [${got}]`}\n`); return; }
  failed += 1;
  process.stdout.write(`  FAIL ${what}${got === undefined ? '' : ` [${got}]`}\n`);
};

const mod = new MirModule('m');
const K = mod.consts;

/* ---- 一、用完就死的一长串：a = k + k; b = a + a; c = b + b; … */
{
  const f = new MirFunc('chain', [], T_I64);
  let v = f.emit(OP.ADD, T_I64, K.int(1n), K.int(2n), 0);
  for (let i = 0; i < 500; i++) v = f.emit(OP.ADD, T_I64, v, v, 0);
  f.emit(OP.RET, T_VOID, v, REF_NONE, 0);
  const homes = assignStackHomes(f);
  ok('用完就死的 502 条：格子数与条数无关', homes <= 4, `${f.count()} 条 -> ${homes} 格`);
}

/* ---- 二、全都活到最后：把 N 个值一起喂给一次调用（`ARGS` 那一族用 args 表） */
{
  const f = new MirFunc('allLive', [], T_I64);
  const vs = [];
  for (let i = 0; i < 64; i++) vs.push(f.emit(OP.ADD, T_I64, K.int(BigInt(i)), K.int(1n), 0));
  /* 最后一条把每一个都再用一次 —— 于是 64 个区间全都盖到这一条上，一格都省不掉。 */
  let acc = vs[0];
  for (let i = 1; i < vs.length; i++) acc = f.emit(OP.ADD, T_I64, acc, vs[i], 0);
  f.emit(OP.RET, T_VOID, acc, REF_NONE, 0);
  const homes = assignStackHomes(f);
  /* 64 个值的区间都盖到"用它那一条"，而那 63 条累加自己也各要一格 —— 只要求
   * "省不下前 64 个"：格子数不少于 64。 */
  ok('活到最后的 64 个：一个都不许省', homes >= 64, `${f.count()} 条 -> ${homes} 格`);
}

/* ---- 三、循环那一格：x 定义在循环外、循环里用；循环里的 y 不许与 x 同格 */
{
  const f = new MirFunc('loop', [], T_I64);
  const x = f.emit(OP.ADD, T_I64, K.int(7n), K.int(0n), 0);
  f.emit(OP.LOOP, T_VOID, REF_NONE, REF_NONE, 0);
  const useX = f.emit(OP.ADD, T_I64, x, K.int(1n), 0);       // x 的"最后一次使用"
  const y = f.emit(OP.ADD, T_I64, K.int(2n), K.int(3n), 0);  // 定义在 x 死后
  const useY = f.emit(OP.ADD, T_I64, y, y, 0);
  f.emit(OP.BRIF, T_VOID, useY, REF_NONE, 0);
  f.emit(OP.END, T_VOID, REF_NONE, REF_NONE, 0);
  f.emit(OP.RET, T_VOID, useX, REF_NONE, 0);
  assignStackHomes(f);
  const at = (ref) => ref - REF_BIAS;
  ok('循环里那一格：x 与 y 不同格',
    f.valHome[at(x)] !== f.valHome[at(y)],
    `x@${f.valHome[at(x)]} y@${f.valHome[at(y)]}`);
}

/* ---- 四、算过一遍就不再算（后端会叫第二遍） */
{
  const f = new MirFunc('idem', [], T_I64);
  const v = f.emit(OP.ADD, T_I64, K.int(1n), K.int(2n), 0);
  f.emit(OP.RET, T_VOID, v, REF_NONE, 0);
  const a = assignStackHomes(f);
  const first = f.valHome;
  const b = assignStackHomes(f);
  ok('第二遍不重算（同一张表、同一个数）', a === b && f.valHome === first, `${a} 格`);
}

process.stdout.write(`\n${total - failed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
