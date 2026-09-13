// ext/lua/tests/bench.js —— **规则化到底慢多少**：读表的驱动器 vs 手写的解析器
//
// 问题是明摆着的：`matchSyn` 每一步都在读 `syn` 的数组、`lang.SIMPLE` 里挨个试候选、
// 有序选择还要回溯。这比一棵手写的递归下降分支树慢，慢多少得量。
//
// 量三段（都在同一份语料上：gsl-shell 的 112 个 `.lua`，约 1MB）：
//   词法      lex(src, lang)
//   语法      parse(src, lang)（含词法）
//   写回      render(ast, lang)
//   降级      lower(ast, lang)（只算降得下来的那些）
// 外面那把尺子：`luajit -b`（它自己的词法 + 语法 + 生成字节码）在同一批文件上的墙上时间。
//
// 用法：node ext/lua/tests/bench.js [--n 轮数]

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { lex } from '../../../src/core/frontend-engine/lexrules.js';
import { parse } from '../../../src/core/frontend-engine/parse-driver.js';
import { render } from '../../../src/core/frontend-engine/render.js';
import { luaLang } from '../lang.js';
import { gslLang } from '../../gsl-shell/lang.js';
import { lower, Refuse } from '../lower.js';

const argv = process.argv.slice(2);
const rounds = Number((argv.find((a) => a.startsWith('--n=')) ?? '').slice(4)) || 3;
const GSL = '/Users/wurui/Documents/Lang/reference/gsl-shell';

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (e.endsWith('.lua')) out.push(p);
  }
  return out;
}

const files = walk(GSL).sort().map((p) => ({ p, src: readFileSync(p, 'utf8') }));
const bytes = files.reduce((a, f) => a + f.src.length, 0);
const lines = files.reduce((a, f) => a + f.src.split('\n').length, 0);

/** 跑 `rounds` 轮取最快的一轮（噪声按下界算）。 */
function best(label, fn) {
  let ms = Infinity;
  let n = 0;
  for (let r = 0; r < rounds; r += 1) {
    const t0 = performance.now();
    n = fn();
    const dt = performance.now() - t0;
    if (dt < ms) ms = dt;
  }
  const kbs = (bytes / 1024) / (ms / 1000);
  console.log(`  ${label.padEnd(10)} ${ms.toFixed(0).padStart(6)} ms`
    + `　${(kbs / 1024).toFixed(2)} MB/s　${(lines / (ms / 1000) / 1000).toFixed(0)} k行/s`
    + (n > 0 ? `　（${n} 份）` : ''));
  return ms;
}

console.log(`语料 ${files.length} 份　${(bytes / 1024).toFixed(0)} KB　${lines} 行　取 ${rounds} 轮最快的一轮`);

let toks = 0;
const msLex = best('词法', () => {
  toks = 0;
  let ok = 0;
  for (const f of files) {
    try { toks += lex(f.src, gslLang).length; ok += 1; } catch { /* 不认的跳过 */ }
  }
  return ok;
});
console.log(`             记号 ${toks} 个　${(toks / (msLex / 1000) / 1e6).toFixed(2)} M记号/s`);

const asts = [];
best('语法', () => {
  asts.length = 0;
  for (const f of files) {
    try { asts.push({ p: f.p, ast: parse(f.src, gslLang) }); } catch { /* 同上 */ }
  }
  return asts.length;
});

best('写回', () => {
  let ok = 0;
  for (const a of asts) { render(a.ast, gslLang); ok += 1; }
  return ok;
});

best('降级', () => {
  let ok = 0;
  for (const a of asts) {
    try { lower(a.ast, gslLang); ok += 1; } catch (err) { if (!(err instanceof Refuse)) throw err; }
  }
  return ok;
});

// 外面那把尺子：luajit 自己的前端（词法 + 语法 + 生成字节码）。
{
  let ms = Infinity;
  for (let r = 0; r < rounds; r += 1) {
    const t0 = performance.now();
    try {
      execFileSync('luajit', ['-b', '-o', 'null', ...files.map((f) => f.p)], { stdio: 'ignore' });
    } catch { /* 有些文件它也不收（`|x| e` 那批），时间照算 */ }
    const dt = performance.now() - t0;
    if (dt < ms) ms = dt;
  }
  console.log(`  luajit -b  ${ms.toFixed(0).padStart(6)} ms`
    + `　${(((bytes / 1024) / (ms / 1000)) / 1024).toFixed(2)} MB/s（含生成字节码，含进程启动）`);
}

// fib.lua 那条端到端：两条腿各跑一次。
{
  const fib = 'bench/fib.lua';
  const t0 = performance.now();
  execFileSync('luajit', [fib], { stdio: 'ignore' });
  const a = performance.now() - t0;
  const t1 = performance.now();
  let b = null;
  try {
    execFileSync('node', ['src/core/cli.js', 'run', fib], { stdio: 'ignore', timeout: 120000 });
    b = performance.now() - t1;
  } catch { /* 还没接上 */ }
  console.log(`\n  bench/fib.lua　luajit ${a.toFixed(0)} ms`
    + `　omni run ${b === null ? '（还没接上 .lua）' : `${b.toFixed(0)} ms`}`);
}
