#!/usr/bin/env node
// Omni — JS 语法前端的往返一致性测试（ADR-0001 的第三条测试轴）
//
// 三条轴各能发现什么：
//   tests/run.js       js 后端 vs c 后端  —— 两边**不一致**
//   tests/oracle/      omni vs python3    —— 两边**一起错**
//   这里               js 前端            —— **前端丢了信息**
//
// 两个断言：
//   1) 幂等：gen(parse(gen(parse(x)))) 与 gen(parse(x)) 逐字节相同。
//      AST 丢字段、优先级/结合性写错，第二轮就会漂移。
//   2) 语义一致：把整个 stage0 树重新生成一遍，用**生成出来的编译器**跑 tests/run.js
//      与 tests/oracle/run.js，输出必须与原编译器逐字节相同。
//      这一条才是真验证 —— 它把"前端有没有理解对"变成 35 个既有用例的问题。
//
//   node tests/js-roundtrip/run.js          跑全部
//   node tests/js-roundtrip/run.js --quick  只跑幂等（不跑两遍测试套件）
//
// 生成出来的树留在 .omni-build/js-roundtrip/ 下，方便直接 diff、直接跑。

import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SourceFile, Diagnostics } from '../../src/core/source/diag.js';
import { parseJs } from '../../src/core/frontend-js/parser.js';
import { genJs } from '../../src/core/frontend-js/gen.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const SRC = join(root, 'src', 'core');
const OUT = join(root, '.omni-build', 'js-roundtrip');
const quick = process.argv.includes('--quick');

let pass = 0;
let fail = 0;

function record(name, ok, detail) {
  if (ok) pass++;
  else fail++;
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${name}\n`);
  if (!ok && detail) process.stdout.write(`${detail}\n`);
}

/** 递归收集一棵树里的文件，返回相对 `base` 的路径 */
function walk(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

/** 解析一份 js，返回生成回去的文本；解析报错就抛，让调用方记成失败 */
function regen(path, text) {
  const diags = new Diagnostics();
  const ast = parseJs(new SourceFile(path, text), diags);
  if (diags.hasErrors()) throw new Error(diags.format());
  return genJs(ast);
}

// ------------------------------------------------------- 1) 幂等

process.stdout.write('idempotence (gen∘parse 的第二轮必须不动)\n');
// 闸门覆盖**仓库里所有自己写的 js**，不只是编译器：测试脚本和 bench 也是我们写的 JS，
// 它们用到的语法同样必须被前端支持，否则"支持的子集"就是靠"没去解析"撑起来的。
const TREES = ['src/core', 'tests', 'bench'];
const files = TREES.flatMap((t) => walk(join(root, t)).filter((f) => f.endsWith('.js')).map((f) => join(t, f)));
/** @type {Map<string, string>} src/core 下的相对路径 -> 第一轮生成的文本，第 2 步直接复用 */
const generated = new Map();

for (const f of files) {
  const abs = join(root, f);
  /* `tests/errors/` 下的是**反例**：那些文件存在的意义就是被拒（`js_label_on_empty_stmt.js`
     钉的是"标签打在空语句上要报一条诊断"）。往返这一轴对它们的要求因此翻过来 ——
     解析**报一条诊断**就算过；崩在宿主里（TypeError 那种，没有位置也没有源码行）才算红。
     不把它们整个跳掉：跳掉就等于这一轴对"报错路径"一无所知，而那正是它们的用处。 */
  const negative = f.startsWith(join('tests', 'errors'));
  let g1;
  try {
    g1 = regen(f, readFileSync(abs, 'utf8'));
  } catch (e) {
    const diag = /:\d+:\d+: error:/.test(e.message);
    if (negative && diag) {
      record(`${f} [反例：解析报了诊断]`, true);
      continue;
    }
    record(`${f} [parse]`, false, indent(e.message));
    continue;
  }
  if (negative) {
    // 反例解析得过也行（错在后面的阶段，比如 TDZ）—— 那就照常量往返
    record(`${f} [反例：解析过得去，按往返查]`, true);
  }
  if (f.startsWith('src/core/')) generated.set(relative('src/core', f), g1);
  let g2;
  try {
    g2 = regen(`${f} (generated)`, g1);
  } catch (e) {
    record(`${f} [reparse]`, false, indent(e.message));
    continue;
  }
  if (g1 === g2) {
    record(f, true);
    continue;
  }
  const a = g1.split('\n');
  const b = g2.split('\n');
  const i = a.findIndex((l, k) => l !== b[k]);
  record(f, false, [
    `    first difference at line ${i + 1}:`,
    `      round 1: ${JSON.stringify(a[i])}`,
    `      round 2: ${JSON.stringify(b[i])}`,
  ].join('\n'));
}

function indent(s) {
  return s.split('\n').slice(0, 8).map((l) => `    ${l}`).join('\n');
}

// ------------------------------------------------- 2) 语义一致：用生成出来的编译器跑全套

/** 把编译器那棵树重建到 OUT 下：`src/core` 用生成的文本，runtime / lib 原样拷（它们不是 js） */
function buildTree() {
  rmSync(OUT, { recursive: true, force: true });
  for (const [rel, text] of generated) {
    const dest = join(OUT, 'src', 'core', rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
  }
  // src/core 下的非 js 文件（现在没有，但别默默漏掉）
  for (const rel of walk(SRC)) {
    if (rel.endsWith('.js')) continue;
    const dest = join(OUT, 'src', 'core', rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(join(SRC, rel)));
  }
  /* runtime / lib 与 `src/core` **同一级**（`installDir()` 从 `core/host/native.js` 往上
   * 数两层就到它们），所以重建出来的树也得是 `src/runtime`、`src/lib`。 */
  for (const sub of ['runtime', 'lib']) {
    const from = join(root, 'src', sub);
    for (const rel of walk(from)) {
      const dest = join(OUT, 'src', sub, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(join(from, rel)));
    }
  }
  return join(OUT, 'src', 'core', 'cli.js');
}

function runSuite(script, cli) {
  const env = { ...process.env };
  if (cli) env.OMNI_CLI = cli;
  else delete env.OMNI_CLI;
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', cwd: root, env });
  return { out: `${r.stdout}${r.stderr}`, status: r.status };
}

if (quick) {
  process.stdout.write('\n(--quick：跳过"用生成的编译器跑全套"这一步)\n');
} else {
  process.stdout.write('\nsemantic equivalence (整棵树重新生成，再跑全套)\n');
  const cli = buildTree();
  process.stdout.write(`  regenerated ${generated.size} files -> ${relative(root, cli)}\n`);

  for (const script of ['tests/run.js', 'tests/oracle/run.js']) {
    const base = runSuite(join(root, script), null);
    const gen = runSuite(join(root, script), cli);
    const same = base.out === gen.out && base.status === gen.status;
    if (same) {
      const summary = base.out.trim().split('\n').pop();
      record(`${script} [original == regenerated]`, true);
      process.stdout.write(`       ${summary}\n`);
    } else {
      const a = base.out.split('\n');
      const b = gen.out.split('\n');
      const i = a.findIndex((l, k) => l !== b[k]);
      record(`${script} [original == regenerated]`, false, [
        `    exit ${base.status} vs ${gen.status}, first difference at line ${i + 1}:`,
        `      original:    ${JSON.stringify(a[i])}`,
        `      regenerated: ${JSON.stringify(b[i])}`,
      ].join('\n'));
    }
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail ? 1 : 0;
