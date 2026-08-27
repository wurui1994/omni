// REPL 的增量性：**结构性**地钉住，而不是量时间（时间会随机器飘，钉不住）。
//
// 判据：每喂一批，检查器本批新检查的函数个数必须是常数。旧 REPL 是"整段重放"，
// 第 n 批要重检前面 n-1 批的所有函数体，这个数会线性涨；增量之后它必须一直是
// "这一批的新函数 + 这一批的入口"。O(n²) 与 O(n) 的差别就落在这一个数上。
//
// 顺带钉住跨批可见性：第 k 批调第 1 批定义的函数、读第 1 批声明的变量，都必须能过。

import { CheckSession } from '../../stage0/src/hir/check.js';
import { CoreSession } from '../../stage0/src/sexpr/lower.js';
import { InterpSession } from '../../stage0/src/interp/eval.js';
import { loadProgram, newLoadState } from '../../stage0/src/module/load.js';
import { Diagnostics, SourceFile } from '../../stage0/src/source/diag.js';
import { AsySession } from '../../stage0/src/frontend-asy/lower.js';
import { parseAsyBuiltins } from '../../stage0/src/frontend-asy/types.js';
import { readSexpr } from '../../stage0/src/sexpr/read.js';
import { readGrammar } from '../../stage0/src/glr/grammar.js';
import { buildTable } from '../../stage0/src/glr/table.js';
import { lexText } from '../../stage0/src/glr/lex.js';
import { glrParse } from '../../stage0/src/glr/driver.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const N = 40;
let fail = 0;

const bad = (msg) => {
  process.stdout.write(`  FAIL ${msg}\n`);
  fail++;
};

const ok = (msg) => process.stdout.write(`  ok   ${msg}\n`);

// ---------------------------------------------------------------- omni

{
  const state = newLoadState();
  const ck = new CheckSession('dynamic');
  const rt = new InterpSession();
  const counts = [];
  for (let i = 1; i <= N; i++) {
    const diags = new Diagnostics();
    // 每一批：一个新函数 + 一句顶层语句（调它，并且用上第 1 批的东西）。
    // 只有最后一批打印 —— 这条用例要钉的是"每批的工作量"，输出多了反而看不见结论。
    const call = i === N ? `print(f${i}(base));` : `int r${i} = f${i}(base);`;
    const text = i === 1
      ? `int f1(int n) { return n + 1; }\nint base = 100;\nint r1 = f1(base);\n`
      : `int f${i}(int n) { return f${i - 1}(n) + 1; }\n${call}\n`;
    const r = loadProgram({ path: '<repl>', text: text, mode: 'dynamic', diags: diags, state: state });
    diags.throwIfErrors();
    const delta = ck.add({ kind: 'Program', decls: r.decls, imports: r.imports }, diags);
    diags.throwIfErrors();
    rt.install(delta);
    const run = rt.runEntry(delta.entry);
    if (run.failed) bad(`omni 第 ${i} 批跑挂了：${run.err.trim()}`);
    counts.push(delta.funcs.length);
  }
  const first = counts[1];
  const flat = counts.slice(1).every((c) => c === first);
  if (!flat) bad(`omni 每批新检查的函数个数不是常数：${counts.join(',')}`);
  else ok(`omni 40 批，每批新检查 ${first} 个函数（常数，不随会话长度涨）`);
}

// ---------------------------------------------------------------- 核心方言（语法驱动前端走这条）

{
  const cs = new CoreSession();
  const rt = new InterpSession();
  const counts = [];
  for (let i = 1; i <= N; i++) {
    const diags = new Diagnostics();
    const call = i === N ? `(print (call f${i} (var base)))` : `(let r${i} int (call f${i} (var base)))`;
    const text = i === 1
      ? '(fn f1 ((n int)) int (ret (bin "+" (var n) (int 1))))\n(let base int (int 100))\n(let r1 int (call f1 (var base)))\n'
      : `(fn f${i} ((n int)) int (ret (bin "+" (call f${i - 1} (var n)) (int 1))))\n${call}\n`;
    const delta = cs.add(text, diags);
    diags.throwIfErrors();
    rt.install(delta);
    const run = rt.runEntry(delta.entry);
    if (run.failed) bad(`sx 第 ${i} 批跑挂了：${run.err.trim()}`);
    counts.push(delta.funcs.length);
  }
  const first = counts[1];
  const flat = counts.slice(1).every((c) => c === first);
  if (!flat) bad(`sx 每批新降级的函数个数不是常数：${counts.join(',')}`);
  else ok(`sx 40 批，每批新降级 ${first} 个函数（常数）`);
}

// ---------------------------------------------------------------- asy（语法驱动的前端）

{
  const here = dirname(fileURLToPath(import.meta.url));
  const src = join(here, '..', '..', 'stage0', 'src', 'frontend-asy');
  const d0 = new Diagnostics();
  const gtext = readFileSync(join(src, 'asy.grammar'), 'utf8');
  const g = readGrammar(readSexpr(new SourceFile('asy.grammar', gtext), d0), d0);
  d0.throwIfErrors();
  const tb = buildTable(g);
  const builtins = parseAsyBuiltins(readFileSync(join(src, 'builtins.tab'), 'utf8'));
  const as = new AsySession({ path: '<repl>', load: null, builtins: builtins });
  const cs = new CoreSession();
  const rt = new InterpSession();
  const counts = [];
  const M = 20;   // asy 这条腿要建语法表，20 批够看出是不是常数了
  for (let i = 1; i <= M; i++) {
    const diags = new Diagnostics();
    const call = i === M ? `write(f${i}(base));` : `int r${i} = f${i}(base);`;
    const text = i === 1
      ? 'int f1(int n) { return n + 1; }\nint base = 100;\nint r1 = f1(base);\n'
      : `int f${i}(int n) { return f${i - 1}(n) + 1; }\n${call}\n`;
    const toks = lexText(tb.grammar.lex, new SourceFile('<repl>', text), diags);
    diags.throwIfErrors();
    const tree = glrParse(tb, toks, diags);
    diags.throwIfErrors();
    const sx = as.add(tree, diags);
    diags.throwIfErrors();
    const delta = cs.add(sx, diags);
    diags.throwIfErrors();
    rt.install(delta);
    const run = rt.runEntry(delta.entry);
    if (run.failed) bad(`asy 第 ${i} 批跑挂了：${run.err.trim()}`);
    counts.push(delta.funcs.length);
  }
  const first = counts[1];
  const flat = counts.slice(1).every((c) => c === first);
  if (!flat) bad(`asy 每批新降级的函数个数不是常数：${counts.join(',')}`);
  else ok(`asy ${M} 批，每批新降级 ${first} 个函数（常数）`);
}

// ---------------------------------------------------------------- 失败要能回滚

{
  const cs = new CoreSession();
  const snap = cs.snapshot();
  const diags = new Diagnostics();
  cs.add('(print (var nope))\n', diags);
  if (!diags.hasErrors()) bad('未声明的变量居然过了');
  cs.restore(snap);
  const d2 = new Diagnostics();
  const delta = cs.add('(let nope int (int 1))\n(print (var nope))\n', d2);
  if (d2.hasErrors()) bad(`回滚之后同名声明失败了：${d2.text ?? ''}`);
  else if (delta.entry !== 'omni_chunk_1') bad(`回滚之后批号没退回去：${delta.entry}`);
  else ok('失败的一批不留痕迹（批号与顶层作用域都退回上一次成功的样子）');
}

process.stdout.write(fail === 0 ? 'repl incremental: ok\n' : `repl incremental: ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
