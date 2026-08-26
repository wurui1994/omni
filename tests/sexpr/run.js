#!/usr/bin/env node
// Omni — 核心 S 表达式方言（第十三条测试轴，ADR-0014 决策 1 的验收）
//
// 这条轴要证的那句话是：「加一门语言 = 一份 grammar + 一份映射标注」。
// 它比 WAT 那条轴更进一步 —— WAT 前端降的是 wasm 自己的方言，语言特有的东西
// （栈机、位宽、br 层数）都在那份降级里；这里降的是**语言中立**的核心方言，
// 而 mini 这门语言除了 tests/glr/grammars/mini.grammar 之外没有任何实现文件。
//
// 四件事：
//   1. **方言本身能跑**：cases/*.sx 在 run / run-c / interp / interp --mir 四个执行器上
//      逐字节相同，且等于 .expected。四方一致比对上期望值更强 —— 期望值只钉住答案，
//      四方一致同时钉住"哪一条腿偏了"。
//   2. **grammar 出来的树也能跑**：mini/*.mini 经 `omni glr` 得到核心方言文本，
//      再喂给同样四个执行器，同样对上 .expected。这中间没有一行为 mini 写的代码。
//   3. **硬指标**：编译器源码里不存在 'mini' 这个词。这条断言是决策 1 的验收本体 ——
//      哪天有人为了让 mini 跑通去 stage0/src 里加个特例，这条会红。
//   4. **bad/ 里的必须被拒绝，且拒在正确的理由上**：类型不推导只检查、条件不真值化、
//      缺入口 —— 这些是刻意划的边界，不是没做完。
//
//   node tests/sexpr/run.js
//   node tests/sexpr/run.js numeric

import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const cli = join(root, 'stage0', 'src', 'cli.js');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const dir = mkdtempSync(join(tmpdir(), 'omni-sexpr-'));

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

/** 四条腿：同一份 .sx，四个执行器，stdout 必须逐字节相同 */
const LEGS = [
  { tag: 'run', args: (p) => ['run', p] },
  { tag: 'run-c', args: (p) => ['run-c', p] },
  { tag: 'interp', args: (p) => ['interp', p] },
  { tag: 'interp --mir', args: (p) => ['interp', p, '--mir'] },
];

/** 一份 .sx + 一份期望值 -> 四方一致 + 对上期望值。返回失败明细（空数组 = 过） */
function agree(sx, expected) {
  const bad = [];
  const first = cmd(LEGS[0].args(sx));
  if (first.code !== 0) bad.push(`    ${LEGS[0].tag} exit=${first.code}\n${first.err}`);
  for (const leg of LEGS.slice(1)) {
    const r = cmd(leg.args(sx));
    if (r.code !== 0) { bad.push(`    ${leg.tag} exit=${r.code}\n${r.err}`); continue; }
    if (r.out !== first.out) {
      bad.push(`    ${leg.tag} 与 ${LEGS[0].tag} 不同\n      ${LEGS[0].tag}: ${JSON.stringify(first.out)}\n      ${leg.tag}: ${JSON.stringify(r.out)}`);
    }
  }
  if (expected === null) bad.push('    缺 .expected');
  else if (first.out !== expected) {
    bad.push(`    对不上期望值\n      want: ${JSON.stringify(expected)}\n      got:  ${JSON.stringify(first.out)}`);
  }
  return bad;
}

// ------------------------------------------------- 1. 方言本身：cases/*.sx

for (const f of readdirSync(join(here, 'cases')).filter((x) => x.endsWith('.sx')).sort()) {
  if (!want(f)) continue;
  const name = basename(f, '.sx');
  const bad = agree(join(here, 'cases', f), read(join(here, 'cases', `${name}.expected`)));
  if (bad.length === 0) ok(`core/${name} [四方一致 == ${name}.expected]`);
  else no(`core/${name}`, bad.join('\n'));
}

// ------------------------------------------------- 2. grammar -> 方言 -> 四方一致
//
// mini 只有 grammar：`omni glr` 的动作模板（`(bin "+" $1 $3)`、`(fn $2 $4 $6 $*7)`）
// 直接拼出核心方言，印出来就是一份合法的 .sx。

const gram = join(root, 'tests', 'glr', 'grammars', 'mini.grammar');
/** LLVM 后端第一阶段只降标量，所以这份额外多跑一条腿 */
const LLVM_OK = new Set(['02-numeric']);

for (const f of readdirSync(join(here, 'mini')).filter((x) => x.endsWith('.mini')).sort()) {
  if (!want(f)) continue;
  const name = basename(f, '.mini');
  const g = cmd(['glr', gram, join(here, 'mini', f)]);
  if (g.code !== 0) { no(`mini/${name}`, `    glr exit=${g.code}\n${g.err}`); continue; }
  const sx = join(dir, `${name}.sx`);
  writeFileSync(sx, g.out);
  const bad = agree(sx, read(join(here, 'mini', `${name}.expected`)));
  if (LLVM_OK.has(name)) {
    const l = cmd(['run-llvm', sx]);
    if (l.code !== 0) bad.push(`    run-llvm exit=${l.code}\n${l.err}`);
    else if (l.out !== read(join(here, 'mini', `${name}.expected`))) {
      bad.push(`    run-llvm 对不上期望值\n      got: ${JSON.stringify(l.out)}`);
    }
  }
  if (bad.length === 0) ok(`mini/${name} [grammar -> 核心方言 -> ${LLVM_OK.has(name) ? '五' : '四'}方一致]`);
  else no(`mini/${name}`, bad.join('\n'));
}

// ------------------------------------------------- 3. 硬指标：编译器里没有 mini
//
// 决策 1 的验收本体。grep 而不是别的手段，是因为要拦的正是"偷偷加个特例"这件事，
// 而任何特例都得提到这门语言的名字。

const hits = [];
walk(join(root, 'stage0', 'src'), (p) => {
  if (!p.endsWith('.js')) return;
  const text = read(p);
  if (text !== null && /\bmini\b/i.test(text)) hits.push(p.slice(root.length + 1));
});
if (hits.length > 0) no('no-per-language-code', `    编译器源码里出现了 mini —— 决策 1 的门槛就是"不许有"：\n${hits.map((h) => `      ${h}`).join('\n')}`);
else ok('no-per-language-code [stage0/src 里没有一处 mini：这门语言只有 grammar]');

function walk(d, fn) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, fn);
    else fn(p);
  }
}

// ------------------------------------------------- 4. bad/：拒绝，且理由正确

for (const f of readdirSync(join(here, 'bad')).filter((x) => x.endsWith('.sx')).sort()) {
  if (!want(f)) continue;
  const name = basename(f, '.sx');
  const exp = read(join(here, 'bad', `${name}.expected`));
  const r = cmd(['run', join(here, 'bad', f)]);
  if (exp === null) { no(`bad/${name}`, `    缺 ${name}.expected`); continue; }
  if (r.code === 0) { no(`bad/${name}`, '    居然通过了 —— 这条边界是刻意划的'); continue; }
  if (!r.err.includes(exp.trim())) {
    no(`bad/${name}`, `    拒的理由不对\n      want: ${JSON.stringify(exp.trim())}\n      got:  ${JSON.stringify(r.err.split('\n')[0])}`);
    continue;
  }
  ok(`bad/${name} [拒绝：${exp.trim()}]`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n\n(kept in ${dir})\n`);
  process.exitCode = 1;
}
