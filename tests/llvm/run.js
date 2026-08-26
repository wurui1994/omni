#!/usr/bin/env node
// Omni — LLVM 后端（第十二条测试轴，ADR-0014 决策 3 第一阶段）
//
// 第一阶段只降标量：i64 / f64 / bool / void。所以这条轴要同时钉两件事，缺一件都不行：
//
//   1. **能降的必须给出同一个答案**：`run-llvm` == `interp` == `run-c`，
//      stdout / stderr / 退出码三样都比。错误路径也在里面（除零那份 case 走的是
//      IR 里的 @omni_ll_div 辅助函数 -> omni_error -> 退出码 70）。
//   2. **不能降的必须报错，而且报在正确的理由上**。这是 WAT 轴 `bad/` 那条规矩的翻版：
//      边界是划出来的，不是忘了做。所以「哪些 case 现在能降」写成一张显式清单 ——
//      支持面扩大时必须来改这张表，而不是让它悄悄漂移。
//
//   node tests/llvm/run.js
//   node tests/llvm/run.js --update      # 重写 IR 快照

import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED } from './supported.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const cli = join(root, 'stage0', 'src', 'cli.js');
const update = process.argv.includes('--update');

let pass = 0;
let fail = 0;
const failures = [];
const ok = (msg) => { pass++; process.stdout.write(`  ok   ${msg}\n`); };
const bad = (label, detail) => {
  fail++;
  failures.push(`${label}\n${detail}`);
  process.stdout.write(`  FAIL ${label}\n`);
};

/** 第一阶段能降的那些在 supported.js 里 —— tests/jit 也读同一份，见那个文件的头 */

function run(args) {
  const r = spawnSync('node', [cli, ...args], { encoding: 'utf8' });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

// ------------------------------------------------- 1. 三方一致（llvm / interp / c）

for (const rel of SUPPORTED) {
  const src = join(root, rel);
  const name = basename(rel);
  const ll = run(['run-llvm', src]);
  const ip = run(['interp', src]);
  const c = run(['run-c', src]);
  const detail = [];
  if (ll.out !== ip.out) detail.push(`    stdout 与 interp 不同\n      interp ${JSON.stringify(ip.out)}\n      llvm   ${JSON.stringify(ll.out)}`);
  if (ll.out !== c.out) detail.push(`    stdout 与 omni-c 不同\n      omni-c ${JSON.stringify(c.out)}\n      llvm   ${JSON.stringify(ll.out)}`);
  if (ll.code !== ip.code || ll.code !== c.code) {
    detail.push(`    退出码不同：llvm ${ll.code}, interp ${ip.code}, omni-c ${c.code}`);
  }
  // 错误路径：诊断走 stderr，也要一样（除零那份就在这里被卡住）
  if (ll.err !== c.err) detail.push(`    stderr 与 omni-c 不同\n      omni-c ${JSON.stringify(c.err)}\n      llvm   ${JSON.stringify(ll.err)}`);
  if (detail.length > 0) bad(`three-way/${name}`, detail.join('\n'));
  else ok(`three-way/${name} [llvm == interp == omni-c] exit=${ll.code}, ${ll.out.length} bytes`);
}

// ------------------------------------------------- 2. 边界：降不了的要报错

const others = [];
for (const f of readdirSync(join(root, 'tests', 'cases')).sort()) {
  if (!/\.(omni|omnid|omnis)$/.test(f)) continue;
  const rel = join('tests', 'cases', f);
  if (!SUPPORTED.includes(rel)) others.push(rel);
}

let declined = 0;
const wrong = [];
for (const rel of others) {
  const r = run(['emit-llvm', join(root, rel)]);
  if (r.code === 0) { wrong.push(`    ${rel} 居然降下来了 —— 要么真支持了（那就加进 SUPPORTED），要么是在悄悄给错答案`); continue; }
  // 报错必须说清是阶段边界，而不是随便崩一个
  if (!r.err.includes('llvm 后端目前不支持')) wrong.push(`    ${rel} 报错的理由不对：${JSON.stringify(r.err.slice(0, 120))}`);
  else declined++;
}
if (wrong.length > 0) bad('boundary/declared', wrong.join('\n'));
else ok(`boundary/declared [${declined} 份 case 被明确拒绝，理由都是阶段边界]`);

// ------------------------------------------------- 3. IR 形状快照

// 选 02-control：结构化控制流拆成基本块是这一层唯一会出错又不容易看出来的地方
// （层数算错、汇合点接错、死块没落标签），快照能一眼看出来。
const snapSrc = join(root, 'tests', 'wat', 'cases', '02-control.wat');
const snapPath = join(here, 'snapshots', '02-control.ll');
const got = execFileSync('node', [cli, 'emit-llvm', snapSrc], { encoding: 'utf8' });
if (update) {
  writeFileSync(snapPath, got);
  ok(`snapshot/02-control [written] ${got.split('\n').length - 1} lines`);
} else if (!existsSync(snapPath)) {
  bad('snapshot/02-control', `    缺快照 ${snapPath}（用 --update 生成）`);
} else {
  const want = readFileSync(snapPath, 'utf8');
  if (want === got) ok(`snapshot/02-control [== snapshots/02-control.ll] ${got.split('\n').length - 1} lines`);
  else {
    const wl = want.split('\n');
    const gl = got.split('\n');
    let i = 0;
    while (i < wl.length && i < gl.length && wl[i] === gl[i]) i++;
    bad('snapshot/02-control', `    第 ${i + 1} 行起不同\n    want: ${JSON.stringify(wl[i])}\n    got:  ${JSON.stringify(gl[i])}`);
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
}
