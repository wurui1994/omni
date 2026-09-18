#!/usr/bin/env node
// Omni — 核心 S 表达式方言（第十三条测试轴，ADR-0014 决策 1 的验收）
//
// 这条轴要证的那句话是：「加一门语言 = 一份 grammar + 一份映射标注」。
// 它比 WAT 那条轴更进一步 —— WAT 前端降的是 wasm 自己的方言，语言特有的东西
// （栈机、位宽、br 层数）都在那份降级里；这里降的是**语言中立**的核心方言，
// 而 mini 这门语言除了 tests/glr/grammars/mini.grammar 之外没有任何实现文件。
//
// 五件事：
//   1. **方言本身能跑**：cases/*.sx 在 run / run-c / interp / interp --mir / run-llvm
//      五个执行器上逐字节相同，且等于 .expected。五方一致比对上期望值更强 ——
//      期望值只钉住答案，多方一致同时钉住"哪一条腿偏了"。
//   2. **grammar 出来的树也能跑**：mini/*.mini 经 `omni glr` 得到核心方言文本，
//      再喂给同样五个执行器，同样对上 .expected。这中间没有一行为 mini 写的代码。
//   3. **硬指标**：编译器源码里不存在 'mini' 这个词。这条断言是决策 1 的验收本体 ——
//      哪天有人为了让 mini 跑通去 src/core 里加个特例，这条会红。
//   4. **bad/ 里的必须被拒绝，且拒在正确的理由上**：类型不推导只检查、条件不真值化、
//      缺入口 —— 这些是刻意划的边界，不是没做完。
//   5. **rt/ 里的必须在五条腿上报同一句话**：运行期错误的消息在五条腿上各有一份实现，
//      而它是"两套指针实现"之间唯一还能观测到的东西（ADR-0016）。
//
//   node tests/sexpr/run.js
//   node tests/sexpr/run.js numeric

import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { workDir } from '../work.js';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunCache } from '../lib/incr.js';
import { pickLegs, legNote } from '../lib/legs.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const cli = join(root, 'src', 'core', 'cli.js');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const dir = workDir('sexpr');

// 走**运行缓存**（ADR-0023 的 S3）：一次调用的输入是 {命令行, 那份 .sx, 装载过的模块,
// 数据文件}，一个字节没变就把上次的输出交出来。这条轴 36×5 + 6×5 + 38 ≈ 250 次子进程，
// 而其中绝大多数在两次之间一模一样。
const cache = new RunCache('sexpr');

const cmd = (args) => {
  // cwd 钉在仓库根上：cases 里有一份要**读文件**的（19-readtext），它的路径是相对仓库根
  // 写的，而这份 run.js 可能从任何目录被叫起来（tests/run.js 就是从根叫的）。
  const r = cache.run([cli, ...args], { cwd: root });
  return { out: r.out, err: r.err, code: r.code };
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
const t0all = Date.now();
const ok = (msg) => { pass++; process.stdout.write(`  ok   ${msg}\n`); };
const no = (name, why) => { fail++; failures.push(`${name}\n${why}`); process.stdout.write(`  FAIL ${name}\n`); };
const want = (f) => (!filters.length || filters.some((x) => f.includes(x)));

/**
 * 五条腿：同一份 .sx，五个执行器，stdout 必须逐字节相同。
 *
 * `run-llvm` 是从 LLVM 后端第二阶段（字符串）起加进来的 —— 在那之前核心方言里只要
 * 出现一个 string 就降不下去。现在整套方言（int/real/bool/string，无容器无 dyn）
 * 都能降，所以这条轴顺带成了「后端支持面覆盖整个汇聚层」的断言：
 * 哪天方言加了新节点而 LLVM 那边没跟上，这里立刻红。
 * `run-jit` 不在这里 —— 它要 libLLVM，可能不在环境里，由 tests/jit 那条轴管。
 */
const ALL_LEGS = [
  { tag: 'run', args: (p) => ['run', p] },
  { tag: 'run-c', args: (p) => ['run-c', p] },
  { tag: 'interp', args: (p) => ['interp', p] },
  { tag: 'interp --mir', args: (p) => ['interp', p, '--mir'] },
  { tag: 'run-llvm', args: (p) => ['run-llvm', p] },
];

/**
 * 平时跑哪几条：开关在 tests/lib/legs.js（`OMNI_LEGS=all` 跑齐五条，提交前那一遍用它）。
 *
 * 这条轴留 `run` 与 `run-llvm`。这里没有"原生执行路径"可言 —— 核心方言是我们自己的汇聚层，
 * 它的真实消费者就是那几个后端。所以留最快的那条当基准（`run`，也是 `omni run` 的默认路径）
 * 加优先级最高的那个后端（`run-llvm`，这条轴那句"后端支持面覆盖整个汇聚层"就挂在它上面）。
 * 中间那三条（run-c / interp / interp --mir）是提交前那一遍的活。
 */
const LEGS = pickLegs(ALL_LEGS, ['run', 'run-llvm']);

/** 报告里那句"几方一致"要跟真跑了几条腿对上 —— 不跑齐就写它们的名字，别虚报 */
const AGREE = LEGS.length === ALL_LEGS.length ? '五方一致' : LEGS.map((l) => l.tag).join(' == ');

/**
 * **一份 case 跑不了哪条腿，以及为什么。**
 *
 * 这张表是有代价的：上面那句"方言加了新节点而 LLVM 那边没跟上，这里立刻红"在这几格上
 * 不成立。所以每一格都要说清**欠在哪儿**、以及**主语言是不是也欠** —— 欠在后端而不是欠在
 * 方言这一侧，才轮得到这张表。而且 `ok` 那行会把它印出来：看不见的例外过一阵就没人记得，
 * 那比红更坏。
 */
const CANT = {
  // `cases/` 与 `rt/` 两处都认这张表（bad/ 只用 `run` 一条腿，用不着）。
  '44-dicts': {
    legs: ['run-llvm'],
    why: 'LLVM 后端不支持聚合容器（dict / list / set）。**主语言也一样** ——'
      + '`dict<string,int> m;` 走 run-llvm 报「llvm 后端目前不支持聚合 dict」，'
      + '所以这是后端那一侧的既有缺口，不是方言这一格新欠的',
  },
  '48-dyn': {
    legs: ['run-llvm'],
    why: 'LLVM 后端不支持 dyn（24 字节，clang 走间接传：入参 ptr、返回 sret —— '
      + '那份账写在 backend-llvm/emit.js 的文件头上）。**主语言也一样** ——'
      + '`string t(dynamic v)` 走 run-llvm 报的是同一句「llvm 后端目前不支持 dyn：参数 v」，'
      + '所以这是后端那一侧的既有缺口，不是方言这一格新欠的',
  },
  'dyn-wrong-tag': {
    legs: ['run-llvm'],
    why: '同 48-dyn：LLVM 后端连一格 dyn 的槽位都落不下去，它报的是'
      + '「llvm 后端目前不支持 dyn：槽位 d」，不是这份用例要钉的那句拆箱错误',
  },
};

/** 这份 case 这一趟真跑哪几条腿。基准（第一条）被排掉就整格判不了 —— 那时照旧全跑，让它红。 */
function legsFor(name) {
  const c = CANT[name];
  if (c === undefined) return { legs: LEGS, note: '' };
  const legs = LEGS.filter((l) => !c.legs.includes(l.tag));
  if (legs.length === 0) return { legs: LEGS, note: '' };
  return { legs, note: ` · 少跑 ${c.legs.join(' / ')}：${c.why}` };
}

/** 一份 .sx + 一份期望值 -> 几方一致 + 对上期望值。返回失败明细（空数组 = 过） */
function agree(sx, expected, legs = LEGS) {
  const bad = [];
  const first = cmd(legs[0].args(sx));
  if (first.code !== 0) bad.push(`    ${legs[0].tag} exit=${first.code}\n${first.err}`);
  for (const leg of legs.slice(1)) {
    const r = cmd(leg.args(sx));
    if (r.code !== 0) { bad.push(`    ${leg.tag} exit=${r.code}\n${r.err}`); continue; }
    if (r.out !== first.out) {
      bad.push(`    ${leg.tag} 与 ${legs[0].tag} 不同\n      ${legs[0].tag}: ${JSON.stringify(first.out)}\n      ${leg.tag}: ${JSON.stringify(r.out)}`);
    }
  }
  if (expected === null) bad.push('    缺 .expected');
  else if (first.out !== expected) {
    bad.push(`    对不上期望值\n      want: ${JSON.stringify(expected)}\n      got:  ${JSON.stringify(first.out)}`);
  }
  return bad;
}

// -------------------------------- 0. 预热：这一趟要跑的子进程里没命中的那些，先并行跑掉
//
// 判定是顺序的（第一条腿当基准），但贵的是子进程。mini 那一节不进来：它要先由 glr 生成
// .sx 才知道跑什么，只把生成那一步预热掉。
{
  const argLists = [];
  for (const f of readdirSync(join(here, 'cases')).filter((x) => x.endsWith('.sx')).sort()) {
    if (!want(f)) continue;
    for (const leg of legsFor(basename(f, '.sx')).legs) {
      argLists.push([cli, ...leg.args(join(here, 'cases', f))]);
    }
  }
  for (const f of readdirSync(join(here, 'rt')).filter((x) => x.endsWith('.sx')).sort()) {
    if (!want(f)) continue;
    for (const leg of legsFor(basename(f, '.sx')).legs) {
      argLists.push([cli, ...leg.args(join(here, 'rt', f))]);
    }
  }
  for (const f of readdirSync(join(here, 'bad')).filter((x) => x.endsWith('.sx')).sort()) {
    if (!want(f)) continue;
    argLists.push([cli, 'run', join(here, 'bad', f)]);
  }
  for (const f of readdirSync(join(here, 'mini')).filter((x) => x.endsWith('.mini')).sort()) {
    if (!want(f)) continue;
    argLists.push([cli, 'glr', join(root, 'tests', 'glr', 'grammars', 'mini.grammar'),
      join(here, 'mini', f)]);
  }
  await cache.warm(argLists, { cwd: root });
  if ((cache.warmed ?? 0) > 0) {
    process.stdout.write(`  --   预热 ${cache.warmed} 次子进程（并行）\n`);
  }
}

// ------------------------------------------------- 1. 方言本身：cases/*.sx

for (const f of readdirSync(join(here, 'cases')).filter((x) => x.endsWith('.sx')).sort()) {
  if (!want(f)) continue;
  const name = basename(f, '.sx');
  const pick = legsFor(name);
  const bad = agree(join(here, 'cases', f), read(join(here, 'cases', `${name}.expected`)), pick.legs);
  const agreeNote = pick.legs.length === ALL_LEGS.length ? '五方一致' : pick.legs.map((l) => l.tag).join(' == ');
  if (bad.length === 0) ok(`core/${name} [${agreeNote} == ${name}.expected${pick.note}]`);
  else no(`core/${name}`, bad.join('\n'));
}

// ------------------------------------------------- 2. grammar -> 方言 -> 五方一致
//
// mini 只有 grammar：`omni glr` 的动作模板（`(bin "+" $1 $3)`、`(fn $2 $4 $6 $*7)`）
// 直接拼出核心方言，印出来就是一份合法的 .sx。

const gram = join(root, 'tests', 'glr', 'grammars', 'mini.grammar');

for (const f of readdirSync(join(here, 'mini')).filter((x) => x.endsWith('.mini')).sort()) {
  if (!want(f)) continue;
  const name = basename(f, '.mini');
  const g = cmd(['glr', gram, join(here, 'mini', f)]);
  if (g.code !== 0) { no(`mini/${name}`, `    glr exit=${g.code}\n${g.err}`); continue; }
  const sx = join(dir, `${name}.sx`);
  writeFileSync(sx, g.out);
  const bad = agree(sx, read(join(here, 'mini', `${name}.expected`)));
  if (bad.length === 0) ok(`mini/${name} [grammar -> 核心方言 -> ${AGREE}]`);
  else no(`mini/${name}`, bad.join('\n'));
}

// ------------------------------------------------- 3. 硬指标：编译器里没有 mini
//
// 决策 1 的验收本体。grep 而不是别的手段，是因为要拦的正是"偷偷加个特例"这件事，
// 而任何特例都得提到这门语言的名字。

const hits = [];
walk(join(root, 'src', 'core'), (p) => {
  if (!p.endsWith('.js')) return;
  const text = read(p);
  if (text !== null && /\bmini\b/i.test(text)) hits.push(p.slice(root.length + 1));
});
if (hits.length > 0) no('no-per-language-code', `    编译器源码里出现了 mini —— 决策 1 的门槛就是"不许有"：\n${hits.map((h) => `      ${h}`).join('\n')}`);
else ok('no-per-language-code [src/core 里没有一处 mini：这门语言只有 grammar]');

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

// ------------------------------------------------- 5. rt/：运行期错误，五条腿同一句话
//
// 与 bad/ 的差别是"什么时候错"：bad/ 是编译期拒绝（一条腿就问得清），rt/ 是**跑起来**
// 才报的错，而错误消息在五条腿上各有一份实现（prelude 的 $rt_error、interp/builtin.js
// 的 rtError、omni_*.c 的 omni_error/omni_errorf）。指针那一刀（ADR-0016）之后这一组
// 才立起来：那三条消息是"两套指针实现"之间唯一还能观测到的东西，逐字节相同不是巧合，
// 是判据 —— 有人在某条腿上把消息改顺口了，这里立刻红。
for (const f of readdirSync(join(here, 'rt')).filter((x) => x.endsWith('.sx')).sort()) {
  if (!want(f)) continue;
  const name = basename(f, '.sx');
  const exp = read(join(here, 'rt', `${name}.expected`));
  if (exp === null) { no(`rt/${name}`, `    缺 ${name}.expected`); continue; }
  const bad = [];
  // `rt/` 也认那张"跑不了哪条腿"的表（`CANT`）：一格形状在某条后端上根本落不下去，
  // 那条腿报的就是"这个后端还不支持 X"，不是这份用例要钉的那句运行期错误。
  const pick = legsFor(name);
  for (const leg of pick.legs) {
    const r = cmd(leg.args(join(here, 'rt', f)));
    if (r.code === 0) { bad.push(`    ${leg.tag} 居然跑完了 —— 这里该报运行期错误`); continue; }
    if (!r.err.includes(exp.trim())) {
      bad.push(`    ${leg.tag} 的消息不对\n      want: ${JSON.stringify(exp.trim())}\n      got:  ${JSON.stringify(r.err.trim())}`);
    }
  }
  if (bad.length === 0) ok(`rt/${name} [${pick.legs.length} 条腿同一句：${exp.trim()}${pick.note}]`);
  else no(`rt/${name}`, bad.join('\n'));
}

const rep = cache.report();
const note = legNote(LEGS);
process.stdout.write(`\n${pass} passed, ${fail} failed${rep === '' ? '' : `  （${rep}）`}`
  + `${note === '' ? '' : `  ${note}`}  总 ${((Date.now() - t0all) / 1000).toFixed(1)}s\n`);
const hot = cache.slowest();
if (hot !== '') process.stdout.write(`  最贵的子进程：${hot}\n`);
const per = cache.byCmd();
if (per !== '') process.stdout.write(`  按腿分的真跑耗时：${per}\n`);

if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n\n(kept in ${dir})\n`);
  process.exitCode = 1;
}
