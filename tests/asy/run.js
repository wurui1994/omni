#!/usr/bin/env node
// Omni — asymptote 前端（第十五条测试轴，ADR-0014 的第二道门槛）
//
// 第一道门槛是"读得进"（tests/glr 那条轴：84/84 个标准模块只出一棵树）；这一条是
// **跑得对**，而且判分的人不是我：
//
//   1. **五方一致**：cases/*.asy 经 asy 前端降到核心方言，再在 run / run-c / interp /
//      interp --mir / run-llvm 上跑，五条腿逐字节相同，且等于 .expected。
//   2. **.expected 是真 asy 的输出**：装了 asymptote 就当场用 `asy -noV` 重新生成一遍
//      比对 —— 期望值不是我写的，是量出来的。没装就跳过这一节并打印 skip（这条轴仍然
//      靠 .expected 把答案钉住，不会因为环境缺工具就什么都不查）。
//   3. **bad/ 里的必须被拒绝，且拒在正确的理由上**。这一刀故意没做的东西（数组、struct、
//      pair、重载、模块、隐式缩放、全局量、超越函数、循环条件里的 `? :`）都在这里，
//      每条都带 ASY_NOPE 前缀 —— "还没做"和"做错了"必须能一眼分开。
//
//   node tests/asy/run.js
//   node tests/asy/run.js arith
//   ASY_BIN=/opt/homebrew/bin/asy node tests/asy/run.js

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { ASY_NOPE } from '../../stage0/src/frontend-asy/lower.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const cli = join(root, 'stage0', 'src', 'cli.js');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const cmd = (args) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? 1 };
};
const read = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

let pass = 0;
let fail = 0;
const failures = [];
const ok = (msg) => { pass++; process.stdout.write(`  ok   ${msg}\n`); };
const no = (name, why) => { fail++; failures.push(`${name}\n${why}`); process.stdout.write(`  FAIL ${name}\n`); };
const want = (f) => (!filters.length || filters.some((x) => f.includes(x)));

/** 五条腿，跟 tests/sexpr 那条轴同一份名单 —— 那边喂 .sx，这边喂 .asy */
const LEGS = [
  { tag: 'run', args: (p) => ['run', p] },
  { tag: 'run-c', args: (p) => ['run-c', p] },
  { tag: 'interp', args: (p) => ['interp', p] },
  { tag: 'interp --mir', args: (p) => ['interp', p, '--mir'] },
  { tag: 'run-llvm', args: (p) => ['run-llvm', p] },
];

/** 真 asy 在不在。装了就用它当判分的人，没装就把这一节标成 skip。 */
function findAsy() {
  const cands = [process.env.ASY_BIN, 'asy', '/opt/homebrew/bin/asy', '/usr/local/bin/asy'];
  for (const c of cands) {
    if (c === undefined || c === null || c === '') continue;
    const r = spawnSync(c, ['-version'], { encoding: 'utf8' });
    if (r.error === undefined || r.error === null) return c;
  }
  return null;
}
const asyBin = findAsy();

// ------------------------------------------------- 1+2. cases/：五方一致 + 真 asy 判分

for (const f of readdirSync(join(here, 'cases')).filter((x) => x.endsWith('.asy')).sort()) {
  if (!want(f)) continue;
  const name = basename(f, '.asy');
  const path = join(here, 'cases', f);
  const expected = read(join(here, 'cases', `${name}.expected`));
  const bad = [];

  const first = cmd(LEGS[0].args(path));
  if (first.code !== 0) bad.push(`    ${LEGS[0].tag} exit=${first.code}\n${first.err}`);
  for (const leg of LEGS.slice(1)) {
    const r = cmd(leg.args(path));
    if (r.code !== 0) { bad.push(`    ${leg.tag} exit=${r.code}\n${r.err}`); continue; }
    if (r.out !== first.out) {
      bad.push(`    ${leg.tag} 与 ${LEGS[0].tag} 不同\n      ${LEGS[0].tag}: ${JSON.stringify(first.out)}\n      ${leg.tag}: ${JSON.stringify(r.out)}`);
    }
  }
  if (expected === null) bad.push('    缺 .expected');
  else if (first.out !== expected) {
    bad.push(`    对不上期望值\n      want: ${JSON.stringify(expected)}\n      got:  ${JSON.stringify(first.out)}`);
  }

  let judged = '';
  if (asyBin !== null) {
    const r = spawnSync(asyBin, ['-noV', path], { encoding: 'utf8' });
    const real = (r.stdout ?? '') + (r.stderr ?? '');
    if ((r.status ?? 1) !== 0) bad.push(`    真 asy 自己就跑不过 exit=${r.status}\n${real}`);
    else if (real !== first.out) {
      bad.push(`    与真 asy 逐字节比对不同\n      asy:  ${JSON.stringify(real)}\n      omni: ${JSON.stringify(first.out)}`);
    } else judged = ' == asy -noV';
  }

  if (bad.length === 0) ok(`cases/${name} [五方一致 == ${name}.expected${judged}]`);
  else no(`cases/${name}`, bad.join('\n'));
}

if (asyBin === null) {
  process.stdout.write('  skip asy 二进制不在（装 asymptote 或设 ASY_BIN 就会拿它逐字节判分）\n');
}

// ------------------------------------------------- 3. bad/：拒绝，理由正确，且带 ASY_NOPE

for (const f of readdirSync(join(here, 'bad')).filter((x) => x.endsWith('.asy')).sort()) {
  if (!want(f)) continue;
  const name = basename(f, '.asy');
  const exp = read(join(here, 'bad', `${name}.expected`));
  if (exp === null) { no(`bad/${name}`, `    缺 ${name}.expected`); continue; }
  const msg = exp.trim();
  if (!msg.startsWith(ASY_NOPE)) {
    no(`bad/${name}`, `    期望值没带 "${ASY_NOPE}" —— 这一节收的是"刻意还没做"，不是"写错了"`);
    continue;
  }
  const r = cmd(['run', join(here, 'bad', f)]);
  if (r.code === 0) { no(`bad/${name}`, '    居然通过了 —— 这条边界是刻意划的'); continue; }
  if (!r.err.includes(msg)) {
    no(`bad/${name}`, `    拒的理由不对\n      want: ${JSON.stringify(msg)}\n      got:  ${JSON.stringify(r.err.split('\n')[0])}`);
    continue;
  }
  ok(`bad/${name} [拒绝：${msg.slice(ASY_NOPE.length + 1)}]`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
}
