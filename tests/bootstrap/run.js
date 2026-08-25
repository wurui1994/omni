#!/usr/bin/env node
// Omni — 自举测试（第六条测试轴）
//
// 前五条轴测的都是"编译器 C0（node 直接跑 stage0/src）输出对不对"。这一条测的是**编译器
// 自己**：让 C0 编译自己得到 C1，再让 C1 编译自己得到 C2。
//
//   C0 = node stage0/src/cli.js
//   C1 = node <C0 emit-js stage0/src/cli.js>
//   C2 = node <C1 emit-js stage0/src/cli.js>
//
// 要求：
//   1. C1 == C2 逐字节相同（不动点 —— 说明 C1 是个和 C0 语义等价的编译器）
//   2. 每个 js-exec / omni 用例，C1 的产物和 C0 的产物逐字节相同
//   3. C 路径与 stage2：交给编译器的内置命令 `omni bootstrap`（stage0/src/bootstrap.js）——
//      它摆出可安装的产物树、验证 N1 的产出等于 C0、并让 N1 编译出 N2 再比对两代的产出
//
//   node tests/bootstrap/run.js
//   node tests/bootstrap/run.js -q     只测 JS 侧的不动点，跳过逐用例对照与 C 路径

import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const quick = process.argv.includes('-q');
const cli = join(root, 'stage0', 'src', 'cli.js');
const dir = mkdtempSync(join(tmpdir(), 'omni-boot-'));

// C1/C2 是"另一个安装位置的编译器"，得按安装布局摆：std 的根是 installDir()/../../lib
// （module/load.js），而 installDir() 在 node 上就是镜像所在目录。摆错了 import "std/..."
// 就找不到 —— 那是布局问题，不是编译器问题。
const binDir = join(dir, 'src', 'host');
mkdirSync(binDir, { recursive: true });
symlinkSync(join(root, 'stage0', 'lib'), join(dir, 'lib'));

const node = (args) => {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? 1 };
};

let pass = 0;
let fail = 0;
const failures = [];
const ok = (msg) => {
  pass++;
  process.stdout.write(`  ok   ${msg}\n`);
};
const bad = (msg, detail) => {
  fail++;
  failures.push(`${msg}\n${detail}`);
  process.stdout.write(`  FAIL ${msg}\n`);
};

// ---- 阶段 1/2：C0 -> C1 -> C2 -------------------------------------------------
const stages = [];
let prev = ['node', cli]; // C0 的调用方式：node stage0/src/cli.js
for (const gen of [1, 2]) {
  const t0 = Date.now();
  const r = node([...prev.slice(1), 'emit-js', cli]);
  const ms = Date.now() - t0;
  if (r.code !== 0 || !r.out) {
    bad(`C${gen} = C${gen - 1} emit-js cli.js`, `    exit=${r.code}\n${r.err}`);
    break;
  }
  const path = join(binDir, `omni-c${gen}.mjs`);
  writeFileSync(path, r.out);
  stages.push({ gen, path, text: r.out, ms });
  ok(`C${gen} = C${gen - 1} emit-js cli.js  ${r.out.length} bytes, ${(ms / 1000).toFixed(1)}s`);
  prev = ['node', path];
}

// ---- 阶段 3：不动点 -----------------------------------------------------------
if (stages.length === 2) {
  const [c1, c2] = stages;
  if (c1.text === c2.text) ok(`fixpoint C1 == C2  ${c1.text.split('\n').length} lines`);
  else {
    const a = c1.text.split('\n');
    const b = c2.text.split('\n');
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    bad('fixpoint C1 == C2', `    first difference at line ${i + 1}\n    C1: ${a[i]}\n    C2: ${b[i]}`);
  }
}

// ---- 阶段 4：逐用例，C1 的产物必须和 C0 的产物相同 -----------------------------
const c1 = stages[0];
if (c1 && !quick) {
  const inputs = [];
  const jsDir = join(root, 'tests', 'js-exec', 'cases');
  for (const f of readdirSync(jsDir).filter((x) => x.endsWith('.js')).sort()) {
    inputs.push({ name: `js-exec/${basename(f, '.js')}`, path: join(jsDir, f) });
  }
  const omniDir = join(root, 'tests', 'cases');
  for (const f of readdirSync(omniDir).filter((x) => x.endsWith('.omni')).sort()) {
    inputs.push({ name: `cases/${basename(f, '.omni')}`, path: join(omniDir, f) });
  }

  for (const { name, path } of inputs) {
    const ref = node([cli, 'emit-js', path]);
    const via = node([c1.path, 'emit-js', path]);
    if (ref.code !== 0) {
      bad(name, `    C0 itself failed: exit=${ref.code}\n${ref.err}`);
      continue;
    }
    if (via.code !== 0) {
      bad(name, `    C1 exit=${via.code}\n${via.err}`);
      continue;
    }
    if (via.out !== ref.out) {
      bad(name, `    C0 ${ref.out.length} bytes != C1 ${via.out.length} bytes`);
      continue;
    }
    ok(`${name}  C0 == C1  ${ref.out.length} bytes`);
  }

  // C1 真的能跑一个 .omni 程序（不只是产出文本）
  const sample = join(omniDir, '01_basics.omni');
  const expected = readFileSync(join(omniDir, '01_basics.expected'), 'utf8');
  const r = node([c1.path, 'run', sample]);
  if (r.code === 0 && expected.includes(r.out.trim().split('\n')[0])) ok('C1 run cases/01_basics');
  else bad('C1 run cases/01_basics', `    exit=${r.code}\n${r.out}${r.err}`);
}

// ---- 阶段 5：C 路径 + stage2 -----------------------------------------------
// 这一段**不再自己实现**：自举是编译器的内置命令（`omni bootstrap`，见 stage0/src/bootstrap.js），
// 测试只负责调用它并检查退出码。它比这里原来那段多做两件事 —— 摆出可安装的产物树、
// 让 N1 编译出 N2 并比对两代原生编译器的产出（真正的 stage2）。
if (c1 && !quick) {
  const r = node([cli, 'bootstrap', '-o', join(dir, 'dist')]);
  for (const line of r.out.split('\n')) {
    if (line.trim()) process.stdout.write(`    ${line.trim()}\n`);
  }
  if (r.code === 0) ok('omni bootstrap  layout + C1/C2 + C path + stage2');
  else bad('omni bootstrap', `    exit=${r.code}\n${r.err}`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n\n(kept in ${dir})\n`);
  process.exitCode = 1;
}
