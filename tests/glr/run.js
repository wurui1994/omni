#!/usr/bin/env node
// Omni — GLR（第八条测试轴，ADR-0014 决策 2）
//
// 「加一门语言 = 一份 grammar + 一份映射标注」这句话要立得住，得先证三件事：
//
//   1. **表是稳定的**：dumpTable 的输出对上 snapshots/NAME.table。快照测试在这里不是懒 ——
//      项集族、FOLLOW、优先级消歧三者任一改错，症状都是"某个输入分析结果变了"，那种错
//      看不出根因。表钉住了，根因就在表的 diff 里。
//   2. **冲突处刻意分叉**：lookahead.grammar 是 SLR(1) 不够但语言不歧义的形状，
//      两条输入分别走冲突的两支，两条都要过。只过一条 = 驱动退化成 LR 了。
//   3. **真歧义要报错，不许猜**：dangling.grammar 不加优先级，
//      `if a then if b then x else y` 必须撞上 bison 的那条硬边界。
//
// 每条都走 CLI（`omni glr-table` / `omni glr`），不是直接调库函数：这样同一条命令
// 自举链里能让原生编译器再跑一遍，封闭 ABI 违规才有地方被抓住。
//
//   node tests/glr/run.js
//   node tests/glr/run.js expr
//   UPDATE=1 node tests/glr/run.js      重写快照

import { mkdtempSync, writeFileSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '../../stage0/src/cli.js');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const update = process.env.UPDATE === '1';
const dir = mkdtempSync(join(tmpdir(), 'omni-glr-'));
mkdirSync(join(here, 'snapshots'), { recursive: true });

const run = (args) => {
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
// 期望值写成一行，实际输出会按 96 列折行（printSexpr 的排版），所以比较前把空白压平。
// 折行位置不是这条轴要测的东西 —— 树的形状才是。
const norm = (s) => s.trim().replace(/\s+/g, ' ');

let pass = 0;
let fail = 0;
const failures = [];
const ok = (msg) => { pass++; process.stdout.write(`  ok   ${msg}\n`); };
const no = (name, why) => { fail++; failures.push(`${name}\n${why}`); process.stdout.write(`  FAIL ${name}\n`); };

const grammars = readdirSync(join(here, 'grammars')).filter((f) => f.endsWith('.grammar')).sort()
  .filter((f) => !filters.length || filters.some((x) => f.includes(x)));

// ------------------------------------------------------------ 1. 表的快照

// 状态数超过这个门槛就只快照摘要（产生式表 + 剩下的冲突）。asy 那份语法有 429 个状态，
// 整表印出来是半兆文本，进仓库不合适 —— 而回归真正要盯的就是那两段。
const FULL_DUMP_STATES = 64;

for (const file of grammars) {
  const name = basename(file, '.grammar');
  const gpath = join(here, 'grammars', file);
  let r = run(['glr-table', gpath, '--brief']);
  if (r.code === 0) {
    const m = /(\d+) states/.exec(r.out.split('\n')[0]);
    if (m !== null && Number(m[1]) <= FULL_DUMP_STATES) r = run(['glr-table', gpath]);
  }
  if (r.code !== 0) {
    no(`table/${name}`, `    glr-table exit=${r.code}\n${r.err}`);
    continue;
  }
  const snap = join(here, 'snapshots', `${name}.table`);
  const want = read(snap);
  if (update || want === null) {
    writeFileSync(snap, r.out);
    ok(`table/${name} [snapshot ${want === null ? 'created' : 'updated'}] ${r.out.split('\n').length - 1} lines`);
    continue;
  }
  if (r.out !== want) {
    no(`table/${name}`, `    the table changed; rerun with UPDATE=1 if that was intended\n${firstDiff(want, r.out)}`);
    continue;
  }
  ok(`table/${name} [== snapshots/${name}.table] ${r.out.split('\n').length - 1} lines`);
}

/** 快照对不上时印第一处不同就够了 —— 整份表贴出来没人读 */
function firstDiff(want, got) {
  const a = want.split('\n');
  const b = got.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    return `    line ${i + 1}\n    want: ${JSON.stringify(a[i] ?? '<eof>')}\n    got:  ${JSON.stringify(b[i] ?? '<eof>')}`;
  }
  return '    (the files differ only in trailing bytes)';
}

// ------------------------------------------------------------ 2. 分析：每行一条 case

for (const file of grammars) {
  const name = basename(file, '.grammar');
  const text = read(join(here, 'cases', `${name}.cases`));
  if (text === null) {
    no(`cases/${name}`, `    missing cases/${name}.cases`);
    continue;
  }
  const gpath = join(here, 'grammars', file);
  const bad = [];
  const lines = text.split('\n');
  // 该过的那些**一条命令批着跑**：真实语言的表有几百个状态，建一次一两秒，逐条 spawn
  // 的话这一条轴要跑几分钟。该拒的那几条数量少，还是逐条跑 —— 要的就是那句错误文本。
  const okCases = [];
  let errCases = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (line === '' || line.startsWith(';;')) continue;
    const isErr = line.includes('!!>');
    const at = line.indexOf(isErr ? '!!>' : '==>');
    if (at < 0) {
      bad.push(`    line ${li + 1}: neither '==>' nor '!!>' on a non-comment line`);
      continue;
    }
    const input = line.slice(0, at).trim();
    const want = line.slice(at + 3).trim();
    const ipath = join(dir, `${name}-${li}.in`);
    writeFileSync(ipath, input + '\n');
    if (!isErr) { okCases.push({ li, input, want, ipath }); continue; }
    errCases++;
    const r = run(['glr', gpath, ipath]);
    if (r.code === 0) bad.push(`    line ${li + 1}: ${JSON.stringify(input)} should have been rejected, but it parsed as ${r.out.trim()}`);
    else if (!r.err.includes(want)) bad.push(`    line ${li + 1}: ${JSON.stringify(input)} was rejected for the wrong reason\n      want: ${JSON.stringify(want)}\n      got:  ${r.err.trim()}`);
  }
  if (okCases.length > 0) {
    const r = run(['glr', gpath, ...okCases.map((c) => c.ipath)]);
    if (r.code !== 0) {
      // 批跑时一条挂了整批就停，错误文本里带着是哪个文件 —— 够定位
      bad.push(`    the batch stopped on a failing input\n${r.err}`);
    } else {
      const got = splitBatch(r.out, okCases.map((c) => c.ipath));
      for (const c of okCases) {
        const g = got.get(c.ipath);
        if (g === undefined) bad.push(`    line ${c.li + 1}: ${JSON.stringify(c.input)} produced no tree`);
        else if (norm(g) !== norm(c.want)) bad.push(`    line ${c.li + 1}: ${JSON.stringify(c.input)}\n      want: ${norm(c.want)}\n      got:  ${norm(g)}`);
      }
    }
  }
  if (bad.length === 0) ok(`cases/${name} [${okCases.length} accepted, ${errCases} rejected]`);
  else no(`cases/${name}`, bad.join('\n'));
}

/** 批跑的输出按 `;; ==== 路径` 切开。只有一条输入时 CLI 不印那行，所以单独处理。 */
function splitBatch(out, paths) {
  const byPath = new Map();
  if (paths.length === 1) {
    byPath.set(paths[0], out);
    return byPath;
  }
  let cur = null;
  const buf = [];
  const flush = () => { if (cur !== null) byPath.set(cur, buf.join('\n')); buf.length = 0; };
  for (const line of out.split('\n')) {
    if (line.startsWith(';; ==== ')) { flush(); cur = line.slice(8); continue; }
    buf.push(line);
  }
  flush();
  return byPath;
}

// ------------------------------------------------------------ 3. lookahead 必须留下冲突
//
// 反向的门槛：如果哪天有人把表升级成 LALR，这条会红。那不是坏事 —— 它提醒你
// 这份 case 的意义（"冲突处两支都要活"）已经换了地方，得另找一份语法来担。

if (grammars.includes('lookahead.grammar')) {
  const r = run(['glr-table', join(here, 'grammars', 'lookahead.grammar')]);
  if (r.out.includes('conflicts left to the GLR driver: none')) {
    no('lookahead/has-conflicts', '    this grammar is supposed to be beyond SLR(1), but the table came out clean');
  } else {
    ok('lookahead/has-conflicts [the driver really does the splitting]');
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n\n(kept in ${dir})\n`);
  process.exitCode = 1;
}
