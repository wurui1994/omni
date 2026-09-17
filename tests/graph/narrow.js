#!/usr/bin/env node
// tests/graph/narrow.js —— **数值窄化**：只装数的局部量落 `double`，不落 16 字节的 `gv`
//
// `docs/design/node-graph-shrink.md` 第五节第 3 条要的东西。算在 `backend-c.js` 的
// `numLocals` + `dOf`，判据在这儿。四件事：
//
//   1. **窄得动**：`bind` 初值是数、每次 `set` 也是数 -> `double v_x`，算术直接是 C 的算术
//   2. **不该窄的不窄**：初值是串、或者后来被赋成串 -> 还是 `gv`（不动点要转到这一步）
//   3. **值位置要装回去**：`print(x)` 那一格得是 `g_num(v_x)` —— 少了它就是发一份编不动的 C
//   4. **跑起来一样**：同一张图，C 那条腿的输出与解释器逐格相同（窄化不许改语义）
//
// 外加一格是文档点了名的那一行（`ext/lua/examples/intmath.lua`）：
// `g_d(g_num(1.0))` 那趟往返没了，而 `g_num(g_d(` 还剩几次 —— 剩的那几次在**形参**
// 与**返回值**那一侧，要归零得做跨函数的那一刀。**这一格把数字钉住**，别让账糊过去。
//
//   node tests/graph/narrow.js

import { loadGrammarTable } from '../../src/core/glr/load.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { readText } from '../../src/core/host/native.js';
import { node, lit, program } from '../../src/core/graph/graph.js';
import { backends } from '../../src/core/graph/contract.js';
import { evalGraph } from '../../src/core/graph/eval.js';
import { LANGS } from '../../src/core/graph/langs.js';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = `${HERE}../../`;
let pass = 0;
let fail = 0;
const ok = (s) => { pass++; process.stdout.write(`  ok   ${s}\n`); };
const no = (s, why) => { fail++; process.stdout.write(`  FAIL ${s}\n       ${why}\n`); };
const has = (label, text, needle) => {
  if (text.includes(needle)) ok(`${label} [${needle}]`);
  else no(label, `这份 C 里找不到 ${JSON.stringify(needle)}`);
};
const hasnt = (label, text, needle) => {
  if (!text.includes(needle)) ok(`${label} [没有 ${needle}]`);
  else no(label, `这份 C 里还有 ${JSON.stringify(needle)}`);
};

const cBack = backends().find((b) => b.name === 'c');
const num = (v) => node('const', {}, { value: v });
const prim = (name, args) => node('prim', { args }, { name });
const ref = (n) => node('ref', {}, { name: n });
const cOf = (g) => cBack.lower(g).text;

// ---- 1) 窄得动 + 3) 值位置装回去 + 4) 跑起来一样
{
  const g = program([
    node('bind', { init: num(1) }, { name: 'i' }),
    node('set', { value: prim('+', [ref('i'), lit(2)]) }, { name: 'i' }),
    prim('print', [ref('i')]),
  ]);
  const c = cOf(g);
  has('窄〔局部量落 double〕', c, 'double v_i = 1.0;');
  has('窄〔算术就是 C 的算术〕', c, 'v_i = (v_i + 2.0);');
  has('窄〔值位置装回去〕', c, 'g_num(v_i)');
  hasnt('窄〔不再是 gv〕', c, 'gv v_i');
  const want = evalGraph(g).out.join('|');
  const got = cBack.lower(g).run().out.join('|');
  if (got === want && want === '3') ok(`窄〔C 腿跑出来一样：${got}〕`);
  else no('窄〔C 腿跑出来一样〕', `解释器 ${want}，C ${got}`);
}

// ---- 2) 不该窄的不窄（两条：一开始就不是数 / 后来被赋成串）
{
  const g = program([
    node('bind', { init: lit('hi') }, { name: 's' }),
    prim('print', [ref('s')]),
  ]);
  const c = cOf(g);
  has('不窄〔初值是串：还是 gv〕', c, 'gv v_s = g_str("hi");');
}
{
  /* 不动点那一条：初值是数，可是后面被赋成了串 —— 一轮下来这个候选要被去掉。 */
  const g = program([
    node('bind', { init: num(1) }, { name: 'x' }),
    node('set', { value: lit('no') }, { name: 'x' }),
    prim('print', [ref('x')]),
  ]);
  const c = cOf(g);
  has('不窄〔后来被赋成串：还是 gv〕', c, 'gv v_x = g_num(1.0);');
  hasnt('不窄〔没有 double v_x〕', c, 'double v_x');
  const want = evalGraph(g).out.join('|');
  const got = cBack.lower(g).run().out.join('|');
  if (got === want && want === 'no') ok(`不窄〔C 腿跑出来一样：${got}〕`);
  else no('不窄〔C 腿跑出来一样〕', `解释器 ${want}，C ${got}`);
}
{
  /* 一格名字**绑两次**就不窄（C 那侧是两层块里两格声明，这儿一张按名字的表分不开）。 */
  const g = program([
    node('bind', { init: num(1) }, { name: 'y' }),
    node('region', { body: [node('bind', { init: lit('s') }, { name: 'y' }), prim('print', [ref('y')])] }),
    prim('print', [ref('y')]),
  ]);
  const c = cOf(g);
  hasnt('不窄〔同名绑两次：一格都不窄〕', c, 'double v_y');
  const want = evalGraph(g).out.join('|');
  const got = cBack.lower(g).run().out.join('|');
  if (got === want) ok(`不窄〔同名绑两次：C 腿跑出来一样（${got}）〕`);
  else no('不窄〔同名绑两次：C 腿一样〕', `解释器 ${want}，C ${got}`);
}

// ---- 文档点名那一行：`ext/lua/examples/intmath.lua`
{
  const d = LANGS.get('lua');
  const { tb } = loadGrammarTable(`${ROOT}${d.grammar}`);
  const f = 'ext/lua/examples/intmath.lua';
  const diags = new Diagnostics();
  const toks = lexText(tb.grammar.lex, new SourceFile(f, readText(`${ROOT}${f}`)), diags);
  const g = d.toGraph(glrParse(tb, toks, diags));
  const c = cOf(g);
  hasnt('intmath〔字面量不再装了又拆〕', c, 'g_d(g_num(1.0))');
  has('intmath〔循环那两格量窄了〕', c, 'double v_acc = 0.0;');
  has('intmath〔累加就是 C 的加法〕', c, 'v_acc = (v_acc + v_i);');
  /* 剩下的往返**有数**：3 次，全在形参 / 返回值那一侧（跨函数那一刀还没做）。
   * 写等号而不是「<= 3」：它变小了是好事，可是那时候这条账要跟着改，不许悄悄漂。 */
  const round = c.split('g_num(g_d(').length - 1;
  if (round === 3) ok('intmath〔g_num(g_d( 还剩 3 次：形参与返回值那一侧，跨函数那一刀还没做〕');
  else no('intmath〔g_num(g_d( 的次数〕', `量到 ${round} 次，账上写的是 3 —— 改了就把账一起改`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed（数值窄化：窄得动 · 不该窄的不窄 · 装回去 · 跑起来一样）\n`);
if (fail > 0) process.exit(1);
