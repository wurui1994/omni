#!/usr/bin/env node
// tests/graph/assertfail.js —— **断言不成立那一路**（第二十九批那格节点的另一半判据）
//
// `tests/graph/run.js` 那张矩阵比的是"每条腿印出来的那几行逐行相同"，而**断言不成立**这件事
// 各腿不同形：interp 与本进程的 js 抛一格哨兵、C 那一侧是 `exit(1)`、wasm 是陷入。
// 退出码**不在图上**（图上没有那一格），所以矩阵那张表比不了它 —— 单开这一格。
//
// 这一格问两句话，两句都是可观察的：
//   1. **那句话印出来了没有**（`assert failed: …` 走的是同一格 print，不是另开一条通道）；
//   2. **后面那一句真的没跑**（"停下来"不是"记一笔然后接着走"）。
//
// 没有这一格的话，`assertok` 那一族里全是**成立**的断言 —— 一个把条件完全忽略掉的实现
// 也能全绿。所以这一格是那一族的另一半，不是补充。
//
//   node tests/graph/assertfail.js

import { node, lit, program } from '../../src/core/graph/graph.js';
import { backends, Gap } from '../../src/core/graph/contract.js';

let pass = 0;
let fail = 0;
let skip = 0;
const ok = (s) => { pass++; process.stdout.write(`  ok   ${s}\n`); };
const no = (s, why) => { fail++; process.stdout.write(`  FAIL ${s}\n       ${why}\n`); };
const gap = (s, why) => { skip++; process.stdout.write(`  skip ${s}：${why}\n`); };

const say = (v) => node('prim', { args: [lit(v)] }, { name: 'print' });

/** 一格手搭的图：印 1、断言不成立、印 2。**印 2 那一句不许跑到**。 */
const G = program([
  say(1),
  node('assert', { cond: lit(false), msg: lit('boom') }),
  say(2),
]);

/** 带消息与不带消息各一格 —— 那两句话不同（`assert failed: boom` / `assert failed`）。 */
const G_NOMSG = program([
  say(1),
  node('assert', { cond: lit(false) }),
  say(2),
]);

function check(name, g, want) {
  for (const b of backends()) {
    let got = null;
    try {
      const low = b.lower(g);
      if (low.run === undefined) { gap(`${name} × ${b.name}`, '这条腿不跑（只落产物）'); continue; }
      got = low.run();
    } catch (err) {
      if (err instanceof Gap) { gap(`${name} × ${b.name}`, err.message); continue; }
      no(`${name} × ${b.name}`, `跑不动：${err.message}`);
      continue;
    }
    const lines = got.out ?? [];
    if (lines.join(' / ') !== want.join(' / ')) {
      no(`${name} × ${b.name}`, `印出来的是 [${lines.join(' / ')}]，要的是 [${want.join(' / ')}]`);
      continue;
    }
    ok(`${name} × ${b.name} [${lines.join(' / ')}]`);
  }
}

check('带消息', G, ['1', 'assert failed: boom']);
check('不带消息', G_NOMSG, ['1', 'assert failed']);

process.stdout.write(`\n${pass} passed, ${fail} failed`
  + `${skip === 0 ? '' : `, ${skip} skipped（缺口，有名有姓）`}`
  + '（断言不成立：那句话印出来 + 后面那一句没跑）\n');
process.exit(fail === 0 ? 0 : 1);
