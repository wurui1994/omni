#!/usr/bin/env node
// 一条腿跑一份 MIR 单元用例（ADR-0017 第一刀）。
//
//   node tests/mir/unit-leg.mjs units/i32.mjs interp   # 闭包解释器，输出到 stdout
//   node tests/mir/unit-leg.mjs units/i32.mjs ll       # 把 LLVM IR 印到 stdout
//   node tests/mir/unit-leg.mjs units/i32.mjs expected # 把用例自带的期望输出印到 stdout
//
// 单独一个进程而不是在测试主进程里直接调：解释器那条腿的输出走的是运行时那个带缓冲的
// stdout（host/native.js 的 flushOut），在同一个进程里截它要动到宿主层。子进程免费。
// `expected` 这条腿也从这里走 —— 主进程 tests/mir/run.js 要能被我们自己的 JS 前端解析
// （tests/run.js 那条自解析轴），而 `await import()` 不在那个方言里（async/await 未支持）。

import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyMir } from '../../stage0/src/mir/verify.js';
import { runMirModule } from '../../stage0/src/mir/interp.js';
import { emitLlvm } from '../../stage0/src/backend-llvm/emit.js';
import { OIR_STUB } from './mirkit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rel = process.argv[2];
const leg = process.argv[3];
const path = isAbsolute(rel) ? rel : join(here, rel);
const unit = await import(path);
if (leg === 'expected') {
  process.stdout.write(unit.expected);
  process.exit(0);
}
const { mir } = unit.build();

const errs = verifyMir(mir);
if (errs.length > 0) {
  process.stderr.write(`mir 不良构:\n  ${errs.join('\n  ')}\n`);
  process.exit(2);
}

if (leg === 'll') {
  process.stdout.write(emitLlvm(mir));
} else if (leg === 'interp') {
  process.exit(runMirModule(OIR_STUB, mir));
} else {
  process.stderr.write(`unit-leg: 不认识的腿 ${leg}\n`);
  process.exit(2);
}
