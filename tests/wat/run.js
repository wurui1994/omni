#!/usr/bin/env node
// Omni — WAT 前端（第七条测试轴，ADR-0014 决策 1）
//
// 这条轴证的是「一份 S-EXPR -> OIR 的降级」不是口号：在 WAT 前端出现之前，OIR 只有
// JS 前端和 Omni 前端两个生产者，两者同源，接口对不对没有第三方来证。现在有了第三个。
//
// 三件事：
//   1. 读取器的往返：源码 -> 树 -> 文本 -> 树，两棵树必须逐节点相同。这比"读取器不崩"
//      强得多，它同时钉住了词法的两端。
//   2. 同一份 .wat 经三个执行器（omni-js / omni-c / interp）各跑一遍，三方 stdout
//      必须逐字节相同，而且等于 cases/NAME.expected。参照是手算的期望值 —— node 跑不了
//      .wat，这条轴没有外部参照，所以期望值是人算出来写下的。
//   3. bad/ 里的每份都必须被**拒绝**，而且拒在正确的理由上：第一阶段的边界（平铺栈式
//      写法、f32、i64 无符号、跳非最内层标签……）是刻意划的，不是忘了做。
//
//   node tests/wat/run.js
//   node tests/wat/run.js numeric

import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { workDir } from '../work.js';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Diagnostics, SourceFile } from '../../stage0/src/source/diag.js';
import { readSexpr } from '../../stage0/src/sexpr/read.js';
import { printSexpr } from '../../stage0/src/sexpr/print.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '../../stage0/src/cli.js');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? 1 };
};
const read = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

/** 树的比较：只看结构与值，不看 span（往回读一遍的位置本来就不同） */
function sameTree(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'atom') return a.value === b.value;
  if (a.kind === 'string') return a.value === b.value;
  if (a.items.length !== b.items.length) return false;
  for (let i = 0; i < a.items.length; i++) {
    if (!sameTree(a.items[i], b.items[i])) return false;
  }
  return true;
}

let pass = 0;
let fail = 0;
const failures = [];
const dir = workDir('wat');

const pick = (d) => readdirSync(join(here, d)).filter((f) => f.endsWith('.wat')).sort()
  .filter((f) => !filters.length || filters.some((x) => f.includes(x)));

// ------------------------------------------------------------ 1. 读取器往返

for (const file of pick('cases')) {
  const name = basename(file, '.wat');
  const text = read(join(here, 'cases', file));
  const d1 = new Diagnostics();
  const t1 = readSexpr(new SourceFile(file, text), d1);
  if (d1.hasErrors()) {
    fail++;
    failures.push(`roundtrip/${name}\n    the reader rejected its own case:\n${d1.format()}`);
    process.stdout.write(`  FAIL roundtrip/${name}\n`);
    continue;
  }
  const printed = printSexpr(t1);
  const d2 = new Diagnostics();
  const t2 = readSexpr(new SourceFile(`${file}.printed`, printed), d2);
  if (d2.hasErrors() || t1.length !== t2.length || !t1.every((n, i) => sameTree(n, t2[i]))) {
    fail++;
    failures.push(`roundtrip/${name}\n    read -> print -> read is not a fixpoint\n${d2.format()}\n--- printed ---\n${printed}`);
    process.stdout.write(`  FAIL roundtrip/${name}\n`);
    continue;
  }
  pass++;
  process.stdout.write(`  ok   roundtrip/${name} [read == print >> read] ${printed.split('\n').length - 1} lines\n`);
}

// ------------------------------------------------------------ 2. 三个执行器 + 期望值

for (const file of pick('cases')) {
  const name = basename(file, '.wat');
  const path = join(here, 'cases', file);
  const want = read(join(here, 'cases', `${name}.expected`));
  const bad = [];
  if (want === null) bad.push(`    missing cases/${name}.expected`);

  const viaJs = run(process.execPath, [cli, 'run', path]);
  const viaC = run(process.execPath, [cli, 'run-c', path]);
  const viaI = run(process.execPath, [cli, 'interp', path]);
  // 第四个执行器：MIR 上的闭包编译解释器（ADR-0014 决策 7）。.wat 这一支特别值得比 ——
  // wasm 的 block/loop/br 与 MIR 的区域标记是**同一套层数语义**，两边都对了才算真的同一套。
  const viaM = run(process.execPath, [cli, 'interp', path, '--mir']);
  const check = (label, r) => {
    if (r.code !== 0) bad.push(`    ${label} exit=${r.code}\n${r.err}`);
    else if (r.out !== want) bad.push(`    ${label} output differs\n    want: ${JSON.stringify(want)}\n    got:  ${JSON.stringify(r.out)}`);
  };
  check('omni-js', viaJs);
  check('omni-c ', viaC);
  check('interp ', viaI);
  check('interp-mir', viaM);

  if (bad.length === 0) {
    pass++;
    const n = want === '' ? 0 : want.replace(/\n$/, '').split('\n').length;
    process.stdout.write(`  ok   ${name} [omni-js == omni-c == interp == interp-mir == expected] ${n} lines\n`);
    continue;
  }
  fail++;
  failures.push(`${name}\n${bad.join('\n')}`);
  process.stdout.write(`  FAIL ${name}\n`);
}

// ------------------------------------------------------------ 3. bad/：该拒的要拒

for (const file of pick('bad')) {
  const name = basename(file, '.wat');
  const want = (read(join(here, 'bad', `${name}.expected`)) ?? '').trim();
  const r = run(process.execPath, [cli, 'emit-c', join(here, 'bad', file)]);
  if (r.code === 0) {
    fail++;
    failures.push(`bad/${name}\n    expected a compile error, but compilation succeeded`);
    process.stdout.write(`  FAIL bad/${name}\n`);
  } else if (want === '' || !r.err.includes(want)) {
    fail++;
    failures.push(`bad/${name}\n    want ${JSON.stringify(want)}\n    got:\n${r.err}`);
    process.stdout.write(`  FAIL bad/${name}\n`);
  } else {
    pass++;
    process.stdout.write(`  ok   bad/${name} [rejected: ${want}]\n`);
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n\n(kept in ${dir})\n`);
  process.exitCode = 1;
}
