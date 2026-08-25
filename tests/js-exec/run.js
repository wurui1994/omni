#!/usr/bin/env node
// Omni — JS 程序的端到端对照测试（第五条测试轴）
//
// 前四条轴测的是"op 的语义对不对"（tests/oir 手搭 OIR）与"Omni 侧的语义"。这一条测
// 的是**降级器**：一段真的 JS 源码，node 跑一遍当参照，再经 frontend-js/parser.js ->
// lower.js -> 两个后端各跑一遍，三方的 stdout 必须逐字节相同。
//
//   node tests/js-exec/run.js
//   node tests/js-exec/run.js loop     只跑名字含 loop 的用例
//
// 用例是 cases/*.js，每个都是能直接被 node 执行的普通脚本（只用 lower.js 支持的那部分
// JS，见 ADR-0011）。输出一律用 console.log(单个字符串)。

import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SourceFile, Diagnostics } from '../../stage0/src/source/diag.js';
import { parseJs } from '../../stage0/src/frontend-js/parser.js';
import { lowerJs } from '../../stage0/src/frontend-js/lower.js';
import { emitJs } from '../../stage0/src/backend-js/emit.js';
import { emitC } from '../../stage0/src/backend-c/emit.js';
import { runtimeSources, RUNTIME_DIR } from '../../stage0/src/runtime/c_runtime.js';

const here = dirname(fileURLToPath(import.meta.url));
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? 1 };
};

const dir = mkdtempSync(join(tmpdir(), 'omni-jsexec-'));
const cc = ['clang', 'cc', 'gcc'].find((x) => run('which', [x]).code === 0);
const cases = readdirSync(join(here, 'cases')).filter((f) => f.endsWith('.js')).sort()
  .filter((f) => !filters.length || filters.some((x) => f.includes(x)));

let pass = 0;
let fail = 0;
const failures = [];

for (const file of cases) {
  const name = basename(file, '.js');
  const path = join(here, 'cases', file);
  const text = readFileSync(path, 'utf8');

  const ref = run(process.execPath, [path]);
  if (ref.code !== 0) {
    fail++;
    failures.push(`${name}\n    node itself failed:\n${ref.err}`);
    process.stdout.write(`  FAIL ${name} (node)\n`);
    continue;
  }

  const diags = new Diagnostics();
  const ast = parseJs(new SourceFile(path, text), diags);
  const mod = diags.hasErrors ? null : lowerJs(ast, diags);
  if (diags.hasErrors) {
    fail++;
    failures.push(`${name}\n    lowering failed:\n${diags.format()}`);
    process.stdout.write(`  FAIL ${name} (lower)\n`);
    continue;
  }

  const jsPath = join(dir, `${name}.mjs`);
  writeFileSync(jsPath, emitJs(mod));
  const viaJs = run(process.execPath, [jsPath]);

  const cPath = join(dir, `${name}.c`);
  writeFileSync(cPath, emitC(mod));
  const exe = join(dir, `${name}.out`);
  const build = run(cc, ['-std=c99', '-O1', `-I${RUNTIME_DIR}`, cPath, ...runtimeSources(), '-o', exe, '-lm']);
  const viaC = build.code === 0 ? run(exe, []) : { out: '', err: build.err, code: build.code };

  const okJs = viaJs.code === 0 && viaJs.out === ref.out;
  const okC = viaC.code === 0 && viaC.out === ref.out;
  if (okJs && okC) {
    pass++;
    const n = ref.out === '' ? 0 : ref.out.replace(/\n$/, '').split('\n').length;
    process.stdout.write(`  ok   ${name} [node == omni-js == omni-c] ${n} lines\n`);
    continue;
  }
  fail++;
  const show = (label, r) => `    ${label} exit=${r.code}\n${r.out}${r.err ? `    stderr: ${r.err}` : ''}`;
  failures.push(`${name}\n    node    exit=${ref.code}\n${ref.out}${show('omni-js', viaJs)}${show('omni-c ', viaC)}`);
  process.stdout.write(`  FAIL ${name}\n`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n\n(kept in ${dir})\n`);
  process.exitCode = 1;
}
