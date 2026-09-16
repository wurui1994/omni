#!/usr/bin/env node
// Omni — 跨语言对照测试（oracle tests）
//
// 与 tests/run.js 的分工：
//   tests/run.js   js 后端 vs c 后端  —— 只能发现两边**不一致**
//   tests/oracle   omni vs python3/node —— 发现两边**一起错**
//
// 每个用例是一组等价程序：`X.omni` + `X.py`（+ 可选 `X.js`），
// 它们的 stdout 必须逐字节相同。参照实现刻意用各语言的原生设施：
//   json      -> Python 的 json 模块 / Node 的 JSON
//   %.6g      -> Python 的 '%.6g'（就是 C 的 printf）
//   i64       -> Python 的 bignum + 显式掩码（照 ADR-0005 的规格算一遍）
//   插入序    -> Python 的 dict（同样保插入序）
//
//   node tests/oracle/run.js            跑全部
//   node tests/oracle/run.js json       只跑名字含 json 的

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mixedRunner } from '../lib/incr.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const { cache, run: mixedRun } = mixedRunner('oracle');
const CLI = process.env.OMNI_CLI || join(root, 'src', 'core', 'cli.js');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));

function have(cmd) {
  return spawnSync('which', [cmd], { encoding: 'utf8' }).status === 0;
}

const HAS_PY = have('python3');

/** @returns {{out: string, err: string, code: number}}
 *  node 那几次走 RunCache（只记依赖、不缓存，ADR-0023 的 S7）—— 轴级指纹要"这一趟装了
 *  哪些模块"这一份；qjs / clang 那些外部工具照旧原样跑。 */
function run(cmd, args) {
  const r = mixedRun(cmd, args, { cwd: root });
  return { out: r.out, err: r.err, code: r.status === null ? -1 : r.status };
}

function firstDiff(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) {
      return `line ${i + 1}:\n      ${JSON.stringify(la[i])}\n      ${JSON.stringify(lb[i])}`;
    }
  }
  return '(only trailing whitespace differs)';
}

let pass = 0;
let fail = 0;
const failures = [];

for (const f of readdirSync(here).filter((f) => f.endsWith('.omni')).sort()) {
  const name = f.replace(/\.omni$/, '');
  if (filters.length && !filters.some((x) => name.includes(x))) continue;

  /** @type {{label: string, out: string, code: number, err: string}[]} */
  const results = [];
  const omniRel = join('tests', 'oracle', f);
  /* `omni-js` 这条腿**明着点后端**：它就是「生成 JS 在本进程里跑」，从前是 `run` 的
   * 默认。默认一旦改成 c，不写这一句这一行就变成第二份 `omni-c` —— 三方比对里少一方。 */
  results.push({ label: 'omni-js', ...norm(run(process.execPath, [CLI, 'run', omniRel, '--backend', 'js'])) });
  results.push({ label: 'omni-c', ...norm(run(process.execPath, [CLI, 'run-c', omniRel])) });

  const py = join(here, `${name}.py`);
  if (existsSync(py)) {
    if (HAS_PY) results.push({ label: 'python3', ...norm(run('python3', [py])) });
    else process.stdout.write(`  skip ${name} [python3 not found]\n`);
  }
  const js = join(here, `${name}.js`);
  if (existsSync(js)) results.push({ label: 'node', ...norm(run(process.execPath, [js])) });

  const broken = results.filter((r) => r.code !== 0);
  if (broken.length) {
    record(name, false, broken.map((r) => `  ${r.label} exited ${r.code}\n${indent(r.err)}`).join('\n'));
    continue;
  }
  const base = results[0];
  const bad = results.filter((r) => r.out !== base.out);
  if (bad.length) {
    const detail = bad
      .map((r) => `  ${base.label} vs ${r.label}, first difference at ${firstDiff(base.out, r.out)}`)
      .join('\n');
    record(name, false, detail);
    continue;
  }
  const lines = base.out ? base.out.trimEnd().split('\n').length : 0;
  record(`${name} [${results.map((r) => r.label).join(' == ')}] ${lines} lines`, true, '');
}

/** 参照实现的行尾可能带 \r（Windows 上的 python），统一掉；末尾空行也统一 */
function norm(r) {
  return { out: r.out.replace(/\r\n/g, '\n').replace(/\n+$/, '\n'), err: r.err, code: r.code };
}

function indent(s) {
  return s.split('\n').map((l) => (l ? `    ${l}` : l)).join('\n');
}

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

const rep = cache.report();
process.stdout.write(`\n${pass} passed, ${fail} failed${rep === '' ? '' : `  （${rep}）`}\n`);

if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
}
