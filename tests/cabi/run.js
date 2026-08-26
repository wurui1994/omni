#!/usr/bin/env node
// Omni — 外部 C 符号的端到端测试（第六条测试轴，ADR-0014 决策 4）
//
// 前五条轴都建立在"多方逐字节相同"上。这一条**不能**：node 宿主上没有 dlopen、也没有
// C 调用约定，所以 node / omni-js / interp 三条腿按设计都抛错，只有 omni-c 真的调到了
// libc。于是参照不是 node，而是 cases/NAME.expected。
//
// 这份非对称本身就是被测的东西，所以两边都查：
//   - omni-c 的 stdout 必须与 .expected 逐字节相同
//   - 另外三条腿必须**失败**，而且失败原因必须是"原生构建才有"，不是别的什么错
// 后半条才是真正防退化的那一半 —— 少了它，一个把 CCall 悄悄降成 undefined 的 bug
// 会让三条腿都"通过"。
//
//   node tests/cabi/run.js
//   node tests/cabi/run.js libc     只跑名字含 libc 的用例

import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Diagnostics } from '../../stage0/src/source/diag.js';
import { linkJs } from '../../stage0/src/frontend-js/link.js';
import { lowerJs } from '../../stage0/src/frontend-js/lower.js';
import { emitJs } from '../../stage0/src/backend-js/emit.js';
import { emitC } from '../../stage0/src/backend-c/emit.js';
import { runtimeSources, RUNTIME_DIR } from '../../stage0/src/runtime/c_runtime.js';
import { cAbiLibs } from '../../stage0/src/hir/c_abi.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '../../stage0/src/cli.js');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? 1 };
};

// 三条腿各自的拒绝理由。前两条是同一句话（native_c.js 与 backend-js/prelude.js 逐字对齐），
// 解释器那条不同：它连"C 是什么"都不知道，报的是自己那句。
const NATIVE_ONLY = 'is only available in a native build';
const INTERP_ONLY = 'is not supported by the interpreter';

const dir = mkdtempSync(join(tmpdir(), 'omni-cabi-'));
const cc = ['clang', 'cc', 'gcc'].find((x) => run('which', [x]).code === 0);
const cases = readdirSync(join(here, 'cases')).filter((f) => f.endsWith('.js')).sort()
  .filter((f) => !filters.length || filters.some((x) => f.includes(x)));

let pass = 0;
let fail = 0;
const failures = [];
const read = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

for (const file of cases) {
  const name = basename(file, '.js');
  const path = join(here, 'cases', file);
  const want = read(join(here, 'cases', `${name}.expected`));
  const bad = [];
  if (want === null) bad.push(`    missing cases/${name}.expected`);

  const diags = new Diagnostics();
  const ast = linkJs(path, read, diags);
  const mod = diags.hasErrors() ? null : lowerJs(ast, diags);
  if (diags.hasErrors()) {
    fail++;
    failures.push(`${name}\n    lowering failed:\n${diags.format()}`);
    process.stdout.write(`  FAIL ${name} (lower)\n`);
    continue;
  }

  // 用到的条目要记在模块上：C 后端靠它发 extern 原型，链接命令靠它加 -l
  if ((mod.cabi ?? []).length === 0) bad.push('    mod.cabi is empty — the case calls no C symbol?');

  const cPath = join(dir, `${name}.c`);
  writeFileSync(cPath, emitC(mod));
  const exe = join(dir, `${name}.out`);
  const libs = cAbiLibs(mod.cabi ?? []).map((l) => `-l${l}`);
  const build = run(cc, ['-std=c99', '-O1', `-I${RUNTIME_DIR}`, cPath, ...runtimeSources(), '-o', exe, '-lm', ...libs]);
  if (build.code !== 0) bad.push(`    cc failed:\n${build.err}`);
  else {
    const viaC = run(exe, []);
    if (viaC.code !== 0) bad.push(`    omni-c exit=${viaC.code}\n${viaC.err}`);
    else if (viaC.out !== want) bad.push(`    omni-c output differs\n    want: ${JSON.stringify(want)}\n    got:  ${JSON.stringify(viaC.out)}`);
  }

  // 三条腿必须拒绝，而且要拒绝在正确的理由上
  const refuse = (label, r, needle) => {
    if (r.code === 0) bad.push(`    ${label} should have failed, but exited 0`);
    else if (!(r.out + r.err).includes(needle)) bad.push(`    ${label} failed for the wrong reason (want ${JSON.stringify(needle)}):\n${r.err}`);
  };
  refuse('node   ', run(process.execPath, [path]), NATIVE_ONLY);
  const jsPath = join(dir, `${name}.mjs`);
  writeFileSync(jsPath, emitJs(mod));
  refuse('omni-js', run(process.execPath, [jsPath]), NATIVE_ONLY);
  refuse('interp ', run(process.execPath, [cli, 'interp', path]), INTERP_ONLY);

  if (bad.length === 0) {
    pass++;
    const n = want === '' ? 0 : want.replace(/\n$/, '').split('\n').length;
    process.stdout.write(`  ok   ${name} [omni-c == expected, ${n} lines; node/omni-js/interp refuse]\n`);
    continue;
  }
  fail++;
  failures.push(`${name}\n${bad.join('\n')}`);
  process.stdout.write(`  FAIL ${name}\n`);
}

// ------------------------------------------------------------ bad/：编译期就该拒绝的
//
// 查的是**子串**而不是整份快照，因为诊断第一行带的是"传给 CLI 的那个路径"，
// 在这条轴上是临时目录里的绝对路径，逐字节比对会随机器变。要钉住的是消息本身。

const badDir = join(here, 'bad');
for (const file of readdirSync(badDir).filter((f) => f.endsWith('.js')).sort()
  .filter((f) => !filters.length || filters.some((x) => f.includes(x)))) {
  const name = basename(file, '.js');
  const path = join(badDir, file);
  const want = (read(join(badDir, `${name}.expected`)) ?? '').trim();
  const r = run(process.execPath, [cli, 'emit-c', path]);
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
