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
const rounds = Number((argv.find((a) => a.startsWith('--n=')) ?? '').slice(4)) || 9;
const GSL = '/Users/wurui/Documents/Lang/reference/gsl-shell';
/** `--ab=DIR`：与另一份代码（git worktree 或拷贝）同进程配对比。 */
const abDir = (argv.find((a) => a.startsWith('--ab=')) ?? '').slice(5) || undefined;

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

/**
 * 量法（ADR-0030 第 1 节那笔账：先前噪声比要量的差别还大，判据落不到实处）：
 *   1. **先热身**两轮不计时（JIT 要预热，第一轮基本在编译 JS 自己）
 *   2. 再跑 `rounds` 轮，报**最快**与**中位**两个数 —— 只报最快会把偶发的好运当成结论
 *   3. 报**离散度**（最快与中位差多少）：这一格大于 15% 就说明这次测量不算数
 */
function best(label, fn) {
  for (let r = 0; r < 2; r += 1) fn();                 // 热身
  const ts = [];
  let n = 0;
  for (let r = 0; r < rounds; r += 1) {
    const t0 = performance.now();
    n = fn();
    ts.push(performance.now() - t0);
  }
  ts.sort((a, b) => a - b);
  const ms = ts[0];
  const mid = ts[Math.floor(ts.length / 2)];
  const spread = ((mid - ms) / ms) * 100;
  const mbs = ((bytes / 1024) / (ms / 1000)) / 1024;
  console.log(`  ${label.padEnd(10)} 最快 ${ms.toFixed(0).padStart(5)} ms`
    + `　中位 ${mid.toFixed(0).padStart(5)} ms（+${spread.toFixed(0)}%）`
    + `　${mbs.toFixed(2)} MB/s　${(lines / (ms / 1000) / 1000).toFixed(0)} k行/s`
    + (n > 0 ? `　（${n} 份）` : '')
    + (spread > 15 ? '　⚠ 离散度大，这次不算数' : ''));
  return ms;
}

console.log(`语料 ${files.length} 份　${(bytes / 1024).toFixed(0)} KB　${lines} 行`
  + `　热身 2 轮 + 计时 ${rounds} 轮`);

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

// ── 同一个进程里 A/B（ADR-0030 第 1 节那笔明账）─────────────────────────────────
// 跨轮噪声 ±10%，所以 10% 级别的差别只能**同进程配对比**。办法：把另一份代码
// （一个 git worktree 或任何一份拷贝）也 import 进来，两边**交替**跑，报每轮的比值中位数。
// 交替 + 配对能把机器漂移约掉 —— 这比"各跑一轮再比两个数"结实得多。
if (abDir !== undefined) {
  const other = await import(join(process.cwd(), abDir, 'src/core/frontend-engine/parse-driver.js'));
  const otherLang = await import(join(process.cwd(), abDir, 'ext/lua/lang.js'));
  const otherGsl = await import(join(process.cwd(), abDir, 'ext/gsl-shell/lang.js'));
  const runA = () => { for (const f of files) { try { parse(f.src, gslLang); } catch { /* 不认的跳过 */ } } };
  const runB = () => {
    for (const f of files) {
      try { other.parse(f.src, otherGsl.gslLang ?? otherLang.luaLang); } catch { /* 同上 */ }
    }
  };
  runA(); runB(); runA(); runB();                       // 两边都热身
  const ratios = [];
  const as = [];
  const bs = [];
  for (let r = 0; r < rounds; r += 1) {
    const t0 = performance.now();
    runA();
    const a = performance.now() - t0;
    const t1 = performance.now();
    runB();
    const b = performance.now() - t1;
    as.push(a);
    bs.push(b);
    ratios.push(b / a);                                 // >1 说明**这一份更快**
  }
  const mid = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
  console.log(`\n  同进程 A/B（这一份 vs ${abDir}）：`
    + `本份中位 ${mid(as).toFixed(0)} ms　对照中位 ${mid(bs).toFixed(0)} ms`
    + `　配对比值中位 ${mid(ratios).toFixed(2)}×`
    + `${mid(ratios) > 1.1 ? '（这一份更快）' : mid(ratios) < 0.9 ? '（这一份更慢）' : '（在噪声里，等于没动）'}`);
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
