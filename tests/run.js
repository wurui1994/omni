#!/usr/bin/env node
// Omni stage0 — 差分测试 + 快照测试
//
// 两类断言：
//   1) 差分：同一份 .omni 在 JS 后端与 C 后端上的 stdout/stderr/exit code 必须逐字节一致。
//      这是整个架构的安全网 —— 后端一多，唯一可靠的正确性来源就是"互相对照"。
//   2) 快照：与 .expected 比对，防止两边一起变坏。
//
// 三组用例：cases/ 可执行（差分+快照）、errors/ 只看编译期诊断、repl/ 脚本化会话喂给 stdin。
//
//   node tests/run.js            跑全部
//   node tests/run.js basics     只跑名字含 basics 的
//   node tests/run.js --update   重写快照

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CLI = join(root, 'stage0', 'src', 'cli.js');
const args = process.argv.slice(2);
const update = args.includes('--update');
const filters = args.filter((a) => !a.startsWith('-'));

/** 三种类型模式对应三个后缀（ADR-0008）：.omni 混合 / .omnid 纯动态 / .omnis 纯静态 */
const SRC_EXT = /\.omni[ds]?$/;

/** 用相对路径 + 固定 cwd 运行，保证诊断快照里不出现机器相关的绝对路径 */
function run(cmd, file) {
  const rel = relative(root, file);
  const r = spawnSync(process.execPath, [CLI, cmd, rel], { encoding: 'utf8', cwd: root });
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    code: r.status ?? -1,
  };
}

function show(label, r) {
  return `--- ${label} (exit ${r.code}) ---\nstdout:\n${r.stdout}stderr:\n${r.stderr}`;
}

function diffLine(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) {
      return `  first difference at line ${i + 1}:\n    js: ${JSON.stringify(la[i])}\n    c : ${JSON.stringify(lb[i])}`;
    }
  }
  return '';
}

/** 编译器/运行时自己崩了（Node 栈回溯）而不是报出 omni 诊断。
 *  两个后端会一起崩（比如 prelude.js 里一个语法错），差分因此"一致通过"，
 *  快照又把崩溃文本原样存下来 —— 必须单独挡一道。 */
function hostCrash(stderr) {
  return /\n\s+at .+:\d+:\d+/.test(stderr) || /^Node\.js v/m.test(stderr);
}

let pass = 0;
let fail = 0;
const failures = [];

function record(name, ok, detail) {
  if (ok) {
    pass++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    fail++;
    failures.push(`${name}\n${detail}`);
    process.stdout.write(`  FAIL ${name}\n`);
  }
}

function checkSnapshot(name, expectedPath, actual) {
  if (update || !existsSync(expectedPath)) {
    writeFileSync(expectedPath, actual);
    process.stdout.write(`  ==   ${name} (snapshot written)\n`);
    return true;
  }
  const expected = readFileSync(expectedPath, 'utf8');
  if (expected === actual) return true;
  record(`${name} [snapshot]`, false, `  snapshot mismatch (${expectedPath})\n${diffLine(expected, actual)}`);
  return false;
}

// ------------------------------------------------------------ 可执行用例：差分 + 快照

const casesDir = join(here, 'cases');
process.stdout.write('differential (js vs c) + snapshot\n');
for (const f of readdirSync(casesDir).filter((f) => SRC_EXT.test(f)).sort()) {
  if (filters.length && !filters.some((x) => f.includes(x))) continue;
  const path = join(casesDir, f);
  const js = run('run', path);
  const c = run('run-c', path);

  const crashed = [['js', js], ['c', c]].filter(([, r]) => hostCrash(r.stderr));
  if (crashed.length) {
    record(`${f} [host crash]`, false, crashed.map(([l, r]) => show(l, r)).join('\n'));
    continue;
  }

  const same = js.stdout === c.stdout && js.code === c.code && js.stderr === c.stderr;
  record(`${f} [js==c]`, same, same ? '' : `${show('js', js)}\n${show('c', c)}\n${diffLine(js.stdout, c.stdout)}`);
  if (same) checkSnapshot(f, path.replace(SRC_EXT, '.expected'), `exit ${js.code}\n--- stdout ---\n${js.stdout}--- stderr ---\n${js.stderr}`);
}

// ------------------------------------------------------------ 诊断用例：只比对编译期错误文本

const errorsDir = join(here, 'errors');
if (existsSync(errorsDir)) {
  process.stdout.write('diagnostics (snapshot)\n');
  for (const f of readdirSync(errorsDir).filter((f) => SRC_EXT.test(f)).sort()) {
    if (filters.length && !filters.some((x) => f.includes(x))) continue;
    const path = join(errorsDir, f);
    const r = run('run', path);
    if (hostCrash(r.stderr)) {
      record(`${f} [host crash]`, false, show('js', r));
      continue;
    }
    if (r.code === 0) {
      record(`${f} [should fail]`, false, '  expected a compile error, but compilation succeeded');
      continue;
    }
    if (checkSnapshot(f, path.replace(SRC_EXT, '.expected'), r.stderr)) record(`${f} [diagnostics]`, true, '');
  }
}

// ------------------------------------------------------------ REPL：脚本化会话 + 快照

const replDir = join(here, 'repl');
if (existsSync(replDir)) {
  process.stdout.write('repl (snapshot)\n');
  for (const f of readdirSync(replDir).filter((f) => f.endsWith('.in')).sort()) {
    if (filters.length && !filters.some((x) => f.includes(x))) continue;
    const path = join(replDir, f);
    // 管道输入时 REPL 不打提示符，所以 stdout 可以逐字节比对
    const r = spawnSync(process.execPath, [CLI, 'repl'], {
      encoding: 'utf8', cwd: root, input: readFileSync(path, 'utf8'),
    });
    const got = { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? -1 };
    if (hostCrash(got.stderr)) {
      record(`${f} [host crash]`, false, show('repl', got));
      continue;
    }
    const actual = `exit ${got.code}\n--- stdout ---\n${got.stdout}--- stderr ---\n${got.stderr}`;
    if (checkSnapshot(f, path.replace(/\.in$/, '.expected'), actual)) record(`${f} [repl]`, true, '');
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
}
