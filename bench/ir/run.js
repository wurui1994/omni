// bench/ir/run.js —— **性能基准**：我们的 lua→MLIR→native vs lua / luajit / C
//
// 压力才暴露设计问题（ADR-0043 的判据）。三个负载：
//   fib(30)  —— 函数调用密集（递归）
//   loop     —— 算术密集（1e7 次加法）
//   tab      —— 表读写密集（1e5 次 set + get）
//
// 用法：node bench/ir/run.js [--only NAME]

import { luaToMlir } from '../../src/core/ir/emit-mlir.js';
import { loadGrammarTable } from '../../src/core/glr/load.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';

const MLIR_TRANSLATE = '/opt/homebrew/opt/llvm/bin/mlir-translate';
const WORK = '/tmp/omni-bench-ir';
execSync(`mkdir -p ${WORK}`);

const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1] : null;

/** 运行时编一次 */
function buildRuntime() {
  const impl = `${WORK}/rt.c`;
  writeFileSync(impl, `#include "${process.cwd()}/src/core/ir/lua-rt.h"\n`);
  execSync(`clang -O2 -c ${impl} -o ${WORK}/rt.o`);
  return `${WORK}/rt.o`;
}

/** lua 源码 → 原生可执行；回编译各阶段的墙上时间 */
function compileOurs(name, src, rtObj) {
  const t0 = Date.now();
  const { tb, g } = loadGrammarTable('ext/lua/lua.grammar');
  const diags = new Diagnostics();
  const sf = new SourceFile(name, src);
  const toks = lexText(g.lex, sf, diags);
  const tree = glrParse(tb, toks, { diags });
  const tParse = Date.now() - t0;

  const t1 = Date.now();
  const mlir = luaToMlir(tree);
  const tEmit = Date.now() - t1;
  writeFileSync(`${WORK}/${name}.mlir`, mlir);

  const t2 = Date.now();
  execSync(`${MLIR_TRANSLATE} --mlir-to-llvmir ${WORK}/${name}.mlir > ${WORK}/${name}.ll`);
  const tTranslate = Date.now() - t2;

  const t3 = Date.now();
  execSync(`clang -O2 ${WORK}/${name}.ll ${rtObj} -o ${WORK}/${name} -lm`);
  const tLink = Date.now() - t3;

  return { bin: `${WORK}/${name}`, tParse, tEmit, tTranslate, tLink, mlirBytes: mlir.length };
}

/** 跑 N 次取最小值（墙上时间，毫秒） */
function timeIt(fn, n = 3) {
  let best = Infinity, out = null;
  for (let i = 0; i < n; i++) {
    const t = Date.now();
    out = fn();
    const d = Date.now() - t;
    if (d < best) best = d;
  }
  return { ms: best, out: String(out).trim() };
}

function have(cmd) {
  try { execSync(`which ${cmd}`, { stdio: 'ignore' }); return true; } catch { return false; }
}

const CASES = ['fib', 'loop', 'tab'];
const rtObj = buildRuntime();
const results = [];

for (const name of CASES) {
  if (only && name !== only) continue;
  const path = `bench/ir/${name}.lua`;
  if (!existsSync(path)) { console.log(`skip ${name}: no ${path}`); continue; }
  const src = readFileSync(path, 'utf8');

  const row = { name, ours: null, lua: null, luajit: null };

  // 我们的腿
  try {
    const c = compileOurs(name, src, rtObj);
    const r = timeIt(() => execSync(c.bin).toString());
    row.ours = { ...r, compile: c.tParse + c.tEmit + c.tTranslate + c.tLink,
                 parse: c.tParse, emit: c.tEmit, translate: c.tTranslate, link: c.tLink,
                 mlirBytes: c.mlirBytes };
  } catch (e) {
    row.ours = { err: (e.stderr || e.stdout || e.message).toString().split('\n')
      .filter(l => l.includes('error'))[0] || e.message.split('\n')[0] };
  }

  // 参考：lua / luajit
  for (const exe of ['lua', 'luajit']) {
    if (!have(exe)) continue;
    try {
      row[exe] = timeIt(() => execFileSync(exe, [path]).toString());
    } catch (e) { row[exe] = { err: e.message.split('\n')[0] }; }
  }

  results.push(row);
}

// ---- 印出来 ----
console.log('\n=== Lua → MLIR → native 性能基准 ===\n');
for (const r of results) {
  console.log(`--- ${r.name} ---`);
  if (r.ours?.err) {
    console.log(`  ours    : ERROR ${r.ours.err}`);
  } else if (r.ours) {
    const o = r.ours;
    console.log(`  ours    : run ${o.ms}ms  (编译 ${o.compile}ms = parse ${o.parse} + emit ${o.emit} + translate ${o.translate} + clang ${o.link}; MLIR ${o.mlirBytes}B)`);
    console.log(`            out=${JSON.stringify(o.out.slice(0, 40))}`);
  }
  for (const exe of ['lua', 'luajit']) {
    const v = r[exe];
    if (!v) { console.log(`  ${exe.padEnd(8)}: (未安装)`); continue; }
    if (v.err) { console.log(`  ${exe.padEnd(8)}: ERROR ${v.err}`); continue; }
    const ratio = r.ours?.ms ? (v.ms / r.ours.ms).toFixed(2) : '?';
    console.log(`  ${exe.padEnd(8)}: run ${v.ms}ms  (我们的 ${ratio}x)  out=${JSON.stringify(v.out.slice(0, 40))}`);
  }
  // 一致性
  if (r.ours && !r.ours.err) {
    for (const exe of ['lua', 'luajit']) {
      const v = r[exe];
      if (v && !v.err && v.out !== r.ours.out) {
        console.log(`  ⚠ 输出与 ${exe} 不同：ours=${JSON.stringify(r.ours.out)} ${exe}=${JSON.stringify(v.out)}`);
      }
    }
  }
  console.log('');
}
