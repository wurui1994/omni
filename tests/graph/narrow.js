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

// ---- 条件位置：两边都是数时，四趟（装箱 / 比较 / 再装箱 / 拆箱）塌成一条 C 的条件
{
  const g = program([
    node('bind', { init: num(0) }, { name: 'i' }),
    node('loop', {
      cond: prim('<', [ref('i'), num(3)]),
      body: [node('set', { value: prim('+', [ref('i'), num(1)]) }, { name: 'i' })],
    }),
    prim('print', [ref('i')]),
  ]);
  const c = cOf(g);
  has('条件〔循环那一句就是 C 的比较〕', c, 'if (!((v_i < 3.0))) break;');
  hasnt('条件〔不再绕 g_truthy(g_bool(〕', c, 'g_truthy(g_bool(');
  const want = evalGraph(g).out.join('|');
  const got = cBack.lower(g).run().out.join('|');
  if (got === want && want === '3') ok(`条件〔C 腿跑出来一样：${got}〕`);
  else no('条件〔C 腿跑出来一样〕', `解释器 ${want}，C ${got}`);
}
{
  /* `not` 与常量两条：真值观**只有 false / nil 是假**，所以 `0` 也真（`g_truthy` 那一格）。 */
  const g = program([
    node('bind', { init: num(1) }, { name: 'k' }),
    node('branch', {
      cond: prim('not', [prim('=', [ref('k'), num(2)])]),
      then: [prim('print', [lit('ne')])],
      else: [prim('print', [lit('eq')])],
    }),
    node('branch', { cond: lit(0), then: [prim('print', [lit('zero-is-true')])] }),
  ]);
  const c = cOf(g);
  has('条件〔not 就是 C 的取反〕', c, 'if ((!((v_k == 2.0)))) {');
  has('条件〔常量 0 是真（真值观只有 false/nil 假）〕', c, 'if (1) {');
  const want = evalGraph(g).out.join('|');
  const got = cBack.lower(g).run().out.join('|');
  if (got === want && want === 'ne|zero-is-true') ok(`条件〔C 腿跑出来一样：${got}〕`);
  else no('条件〔C 腿跑出来一样〕', `解释器 ${want}，C ${got}`);
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
  has('intmath〔循环条件也是 C 的比较〕', c, 'if (!((v_i <= v_n))) break;');
  has('intmath〔形参也窄了〕', c, 'static gv fn2_fact(double v_n)');
  has('intmath〔调用点递的就是数〕', c, 'fn2_fact(5.0)');
  has('intmath〔递归那一句〕', c, 'fn2_fact((v_n - 1.0))');
  /* 判据 3 的原话是「`intmath` 那一族的 `g_num(g_d(` 往返归零」——**现在是 0**。
   *
   * 而这个 0 的来历要说清，不然会被当成比实际更强的战果：那最后一次往返住在**序言的
   * `g_add` 里**（`return g_num(g_d(a) + g_d(b));`），窄化把这一份里的加法变成了 C 的加法，
   * 于是 `g_add` 没人用了，序言那一裁（第七节第 1 条）把它一起带走了。
   *
   * 剩下的装箱**还在**，只是不长这个样子：`g_num(v_n * g_d(fn2_fact((v_n - 1.0))))` ——
   * 那是**返回值**那一侧（函数回 `gv`）。要它也没，得先证「每条路都回数」。 */
  const round = c.split('g_num(g_d(').length - 1;
  if (round === 0) ok('intmath〔g_num(g_d( 归零（最后一次住在序言的 g_add 里，跟着裁掉了）〕');
  else no('intmath〔g_num(g_d( 的次数〕', `量到 ${round} 次，账上写的是 0 —— 改了就把账一起改`);
  has('intmath〔返回值那一侧的装箱还在（有名有姓）〕', c, 'g_num(v_n * g_d(fn2_fact((v_n - 1.0))))');
}

// ---- 形参不该窄的不窄：有一个调用点递的不是数
{
  const g = program([
    node('bind', {
      init: node('func', { body: [node('ret', { value: ref('a') })] }, { params: ['a'] }),
    }, { name: 'id' }),
    prim('print', [node('call', { fn: ref('id'), args: [num(1)] })]),
    prim('print', [node('call', { fn: ref('id'), args: [lit('s')] })]),
  ]);
  const c = cOf(g);
  has('形参〔有一个调用点递的是串：还是 gv〕', c, '(gv v_a)');
  const want = evalGraph(g).out.join('|');
  const got = cBack.lower(g).run().out.join('|');
  if (got === want && want === '1|s') ok(`形参〔C 腿跑出来一样：${got}〕`);
  else no('形参〔C 腿跑出来一样〕', `解释器 ${want}，C ${got}`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed（数值窄化：窄得动 · 不该窄的不窄 · 装回去 · 跑起来一样）\n`);
if (fail > 0) process.exit(1);
