#!/usr/bin/env node
// Omni — MIR（第九条测试轴，ADR-0014 决策 6）
//
// MIR 之下还没有后端，所以这条轴不能靠「跑出来的字节一致」来证。它证三件**结构性**的事，
// 每一件都对应一个后端将来会依赖的不变量：
//
//   1. **降得下来 + 良构**：仓库里每份 .omni/.omnid/.omnis/.wat 加上编译器自己，都要能
//      降成 MIR 并通过 verifier（区域配对、ref 支配、下标范围、条件是 bool）。
//      「编译器自己」是这条里最有价值的一份 —— 939 个函数，比所有 case 加起来大一个量级。
//   2. **形状被钉住**：几份代表性的 case 有文本快照。快照的意义不是"好看"，而是求值顺序、
//      短路的落法、循环的层数这些**只在 MIR 里能看见的决定**改了会立刻暴露。
//   3. **哈希是内容哈希**：同一份源码两次降级得到同一串字节；改一个函数体**不会**改动
//      别的函数的哈希。第二条是增量编译（决策 5）的地基，现在就要钉住，
//      否则等到有缓存层时才发现哈希带了模块顺序，那时改法就大得多。
//
//   node tests/mir/run.js
//   node tests/mir/run.js --update      # 重写快照
//   node tests/mir/run.js basics        # 只跑名字里含 basics 的

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { workDir } from '../work.js';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Diagnostics, SourceFile } from '../../stage0/src/source/diag.js';
import { loadProgram, MODE_BY_EXT } from '../../stage0/src/module/load.js';
import { check } from '../../stage0/src/hir/check.js';
import { linkJs } from '../../stage0/src/frontend-js/link.js';
import { lowerJs } from '../../stage0/src/frontend-js/lower.js';
import { lowerWat } from '../../stage0/src/frontend-wat/lower.js';
import { lowerToMir } from '../../stage0/src/mir/from_oir.js';
import { verifyMir } from '../../stage0/src/mir/verify.js';
import { printMir } from '../../stage0/src/mir/print.js';
import { funcBytes, funcHash, moduleHashes } from '../../stage0/src/mir/bytes.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const update = process.argv.includes('--update');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const keep = (name) => filters.length === 0 || filters.some((x) => name.includes(x));

let pass = 0;
let fail = 0;
const failures = [];
const ok = (msg) => { pass++; process.stdout.write(`  ok   ${msg}\n`); };
const bad = (label, detail) => {
  fail++;
  failures.push(`${label}\n${detail}`);
  process.stdout.write(`  FAIL ${label}\n`);
};

/** 源文件 -> OIR。三个前端各一条路，和 cli.js 里的分派逐条对应。 */
function toOir(path) {
  const diags = new Diagnostics();
  if (path.endsWith('.js')) {
    const ast = linkJs(path, (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null), diags);
    diags.throwIfErrors();
    const mod = lowerJs(ast, diags);
    diags.throwIfErrors();
    return mod;
  }
  if (path.endsWith('.wat')) {
    const mod = lowerWat(new SourceFile(path, readFileSync(path, 'utf8')), diags);
    diags.throwIfErrors();
    return mod;
  }
  const ext = path.slice(path.lastIndexOf('.'));
  const mode = MODE_BY_EXT[ext] ?? 'mixed';
  const { decls, imports } = loadProgram({ path, mode, diags });
  diags.throwIfErrors();
  const mod = check({ kind: 'Program', decls, imports }, diags, mode);
  diags.throwIfErrors();
  return mod;
}

function toMir(path) {
  return lowerToMir(toOir(path));
}

// ------------------------------------------------- 1. 降得下来 + 良构

const cases = [];
for (const f of readdirSync(join(root, 'tests', 'cases')).sort()) {
  if (/\.(omni|omnid|omnis)$/.test(f)) cases.push(join(root, 'tests', 'cases', f));
}
for (const f of readdirSync(join(root, 'tests', 'wat', 'cases')).sort()) {
  if (f.endsWith('.wat')) cases.push(join(root, 'tests', 'wat', 'cases', f));
}
// 编译器自己：这一份的价值等于其余全部加起来 —— 只有它会走到闭包、模块级变量、
// 138 条封闭 ABI op、深层容器这些路径上
cases.push(join(root, 'stage0', 'src', 'cli.js'));

let insns = 0;
let funcs = 0;
for (const path of cases) {
  const name = basename(path);
  if (!keep(name)) continue;
  let mir = null;
  try {
    mir = toMir(path);
  } catch (e) {
    bad(`lower/${name}`, `    ${e.message}`);
    continue;
  }
  const errs = verifyMir(mir);
  if (errs.length > 0) { bad(`verify/${name}`, `    ${errs.slice(0, 8).join('\n    ')}`); continue; }
  let n = 0;
  for (const f of mir.funcs) n += f.count();
  insns += n;
  funcs += mir.funcs.length;
  ok(`verify/${name} [${mir.funcs.length} funcs, ${n} insns, ${mir.consts.items.length} consts]`);
}
if (funcs > 0) process.stdout.write(`  ---- ${funcs} funcs, ${insns} insns（${insns * 8} 字节）总计\n`);

// ------------------------------------------------- 2. 形状快照

// 选这几份是有理由的：basics 覆盖算术/循环/递归，enum 覆盖 tagged union 与 match，
// closures 覆盖捕获与闭包调用，wat 的 02-control 覆盖 BLOCK/LOOP/BR 的层数。
const snaps = [
  ['basics', join(root, 'tests', 'cases', '01_basics.omni')],
  ['enum', join(root, 'tests', 'cases', '25_enum.omni')],
  ['closures', join(root, 'tests', 'cases', '20_closures.omni')],
  ['wat-control', join(root, 'tests', 'wat', 'cases', '02-control.wat')],
];
for (const [name, path] of snaps) {
  if (!keep(name)) continue;
  const snapPath = join(here, 'snapshots', `${name}.mir`);
  const got = printMir(toMir(path));
  if (update) {
    writeFileSync(snapPath, got);
    ok(`snapshot/${name} [written] ${got.split('\n').length - 1} lines`);
    continue;
  }
  const want = existsSync(snapPath) ? readFileSync(snapPath, 'utf8') : null;
  if (want === null) { bad(`snapshot/${name}`, `    缺快照 ${snapPath}（用 --update 生成）`); continue; }
  if (want !== got) {
    const wl = want.split('\n');
    const gl = got.split('\n');
    let i = 0;
    while (i < wl.length && i < gl.length && wl[i] === gl[i]) i++;
    bad(`snapshot/${name}`, `    第 ${i + 1} 行起不同\n    want: ${JSON.stringify(wl[i])}\n    got:  ${JSON.stringify(gl[i])}`);
    continue;
  }
  ok(`snapshot/${name} [== snapshots/${name}.mir] ${got.split('\n').length - 1} lines`);
}

// ------------------------------------------------- 3. 哈希是内容哈希

if (keep('hash')) {
  const dir = workDir('mir');
  const src = (gBody) => [
    'int f(int a) { return a + 1; }',
    `int g(int a) { return ${gBody}; }`,
    'print(f(1) + g(2));',
    '',
  ].join('\n');
  const pa = join(dir, 'a.omni');
  const pb = join(dir, 'b.omni');
  writeFileSync(pa, src('a * 2'));
  writeFileSync(pb, src('a * 3'));

  const m1 = toMir(pa);
  const m2 = toMir(pa);
  const m3 = toMir(pb);
  const detail = [];

  // (a) 同一份源码两次降级：字节逐个相同
  for (let i = 0; i < m1.funcs.length; i++) {
    const b1 = funcBytes(m1.funcs[i]).join(',');
    const b2 = funcBytes(m2.funcs[i]).join(',');
    if (b1 !== b2) detail.push(`    ${m1.funcs[i].name} 两次降级的字节不同`);
  }

  // (b) 改 g 的函数体：g 的哈希要变，f 的不能变。这一条就是决策 5 的地基 ——
  //     哈希里带了模块顺序或别的函数的内容，增量编译就退化成全量。
  const h1 = moduleHashes(m1);
  const h3 = moduleHashes(m3);
  if (h1.get('u_f').body !== h3.get('u_f').body) detail.push('    改了 g，f 的 body 哈希也变了');
  if (h1.get('u_g').body === h3.get('u_g').body) detail.push('    改了 g 的函数体，g 的 body 哈希没变');
  // 签名没动，签名哈希就不能动（「改实现不失效调用者」靠的是这一条）
  if (h1.get('u_g').sig !== h3.get('u_g').sig) detail.push('    只改了函数体，g 的签名哈希却变了');

  if (detail.length > 0) bad('hash/content-addressed', detail.join('\n'));
  else ok(`hash/content-addressed [两次降级逐字节相同；改 g 不动 f：${h1.get('u_f').body}]`);
}

// ------------------------------------------------- 4. MIR 单元用例：两条腿逐字节相同
//
// i32 / f32（ADR-0017 第一刀）现在**没有前端能产出** —— 核心方言只有一格 int、一格 real。
// 所以这一组直接造 MIR（见 mirkit.mjs），在两条腿上跑同一份：闭包解释器（32 位回绕与
// fround 在它里头是显式写出来的）与 LLVM 后端（`add i32` / `fadd float` 由 LLVM 与硬件定）。
// 期望值写在用例里、按 IEEE-754 与 wasm 规范算出来的，不是从任何一条腿抄回来的。
//
// LLVM 那条腿在这里**自己链**：`clang 用例.ll stage0/runtime/*.c`。不走 cli.js 的
// buildLlvm 是因为那条路要一个源文件当输入，而这一组的输入就是 MIR 本身。
{
  const units = readdirSync(join(here, 'units')).filter((x) => x.endsWith('.mjs')).sort();
  const legDir = workDir('mir-units');
  for (const u of units) {
    const name = u.replace(/\.mjs$/, '');
    if (!keep(name)) continue;
    const unitPath = join(here, 'units', u);
    const leg = (which) => spawnSync('node', [join(here, 'unit-leg.mjs'), unitPath, which],
      { encoding: 'utf8' });
    const re = leg('expected');
    if (re.status !== 0) { bad(`unit/${name} expected`, `    exit=${re.status}\n    ${re.stderr.trim()}`); continue; }
    const want = re.stdout;

    const ri = leg('interp');
    if (ri.status !== 0) { bad(`unit/${name} interp`, `    exit=${ri.status}\n    ${ri.stderr.trim()}`); continue; }
    if (ri.stdout !== want) {
      bad(`unit/${name} interp`, `    want: ${JSON.stringify(want)}\n    got:  ${JSON.stringify(ri.stdout)}`);
      continue;
    }

    const rl = leg('ll');
    if (rl.status !== 0) { bad(`unit/${name} llvm-emit`, `    exit=${rl.status}\n    ${rl.stderr.trim()}`); continue; }
    const llPath = join(legDir, `${name}.ll`);
    const exePath = join(legDir, `${name}.out`);
    writeFileSync(llPath, rl.stdout);
    const rc = spawnSync('clang', ['-O0', '-w', '-ffp-contract=off', '-pthread',
      '-I', join(root, 'stage0', 'runtime'), llPath,
      ...readdirSync(join(root, 'stage0', 'runtime')).filter((x) => x.endsWith('.c'))
        .map((x) => join(root, 'stage0', 'runtime', x)),
      '-o', exePath, '-lm'], { encoding: 'utf8' });
    if (rc.status !== 0) {
      bad(`unit/${name} llvm-link`, `    clang 拒收（IR 留在 ${llPath}）\n    ${rc.stderr.trim().split('\n').slice(0, 6).join('\n    ')}`);
      continue;
    }
    const rx = spawnSync(exePath, [], { encoding: 'utf8' });
    if (rx.stdout !== want) {
      bad(`unit/${name} llvm`, `    want: ${JSON.stringify(want)}\n    got:  ${JSON.stringify(rx.stdout)}`);
      continue;
    }
    ok(`unit/${name} [interp == llvm == 期望，${want.split('\n').length - 1} 行]`);
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
}
