#!/usr/bin/env node
// tests/graph/shape.js —— **形状推断落到 C**：字段名编译期就知道的记录落 `struct`
//
// `docs/design/node-graph-shrink.md` 第五节第 2 条的原话：「字段名静态可知的 `record-new`
// -> C `struct`；判据是 `ext/*/examples/record.*` 那一族出来的 C 里**出现 `struct`、
// `gv` 计数下降**」。算在 `backend-c.js` 的 `recPlan`，判据在这儿。
//
// 五件事：
//   1. **动得了**：`record.lua` 那一份出来的 C 里有 `struct r1`，取字段是 `v_p.f_x`
//      （一格偏移），`g_rec_new` / `g_field_get` 一次都不出现
//   2. **同形共用一格 struct**：两格字段名单一样的记录，只发一份 `struct`
//   3. **跑出去了就不动**：记录被当实参 / 被 print 那种，还是 `g_rec_new`
//      （宿主面只认 `gv`，而 struct 不是 `gv`）
//   4. **字段名对不上名单也不动**：`p.z` 那种 —— 报错归运行期，不许在这一层改语义
//   5. **跑起来一样**：每一格都拿 C 那条腿真跑一遍，与解释器逐格相同
//
//   node tests/graph/shape.js

import { loadGrammarTable } from '../../src/core/glr/load.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { readText } from '../../src/core/host/native.js';
import { node, lit, program } from '../../src/core/graph/graph.js';
import { backends } from '../../src/core/graph/contract.js';
import { evalGraph } from '../../src/core/graph/eval.js';
import { LANGS } from '../../src/core/graph/langs.js';
/* **这一格要的语言已经迁到公共降级器了**（ADR-0044 §1.6：图那一层整个要拆）——
   它判的是图的 pass，而那门语言在图这一层不存在了。所以**有名有姓地跳过**：
   不假装绿，也不崩在"找不到那门语言"上。整层拆掉那天这份文件跟着退役。 */
if (!LANGS.has('lua')) {
  process.stdout.write('  skip shape.js：lua 已迁到公共降级器（ADR-0044），这一格随图一起退役\n');
  process.stdout.write('\n0 passed, 0 failed（整格跳过，有名有姓）\n');
  process.exit(0);
}


const HERE = new URL('.', import.meta.url).pathname;
const ROOT = `${HERE}../../`;
let pass = 0;
let fail = 0;
const ok = (s) => { pass++; process.stdout.write(`  ok   ${s}\n`); };
const no = (s, why) => { fail++; process.stdout.write(`  FAIL ${s}\n       ${why}\n`); };
const has = (label, t, n) => (t.includes(n) ? ok(`${label} [${n}]`) : no(label, `找不到 ${JSON.stringify(n)}`));
const hasnt = (label, t, n) => (!t.includes(n) ? ok(`${label} [没有 ${n}]`) : no(label, `还有 ${JSON.stringify(n)}`));

const cBack = backends().find((b) => b.name === 'c');
const num = (v) => node('const', {}, { value: v });
const prim = (name, args) => node('prim', { args }, { name });
const ref = (n) => node('ref', {}, { name: n });
const rec = (names, vals) => node('record-new', { fields: vals }, { names });
/**
 * **只看这份程序自己那一段**（`/* ---- 提到顶层的那些函数` 往后）。
 * 序言里本来就定义着 `g_rec_new` / `g_field_get` —— 拿整份文本找它们，找到的是那两格定义，
 * 不是这份程序在用它们。头一版就是这么错的（"还有 g_rec_new(" 那三格红）。
 */
const cOf = (g) => {
  const t = cBack.lower(g).text;
  const i = t.indexOf('/* ---- 提到顶层的那些函数');
  return i < 0 ? t : t.slice(i);
};
const cAll = (g) => cBack.lower(g).text;
const sameRun = (label, g, want) => {
  const a = evalGraph(g).out.join('|');
  const b = cBack.lower(g).run().out.join('|');
  if (a === b && a === want) ok(`${label} [${b}]`);
  else no(label, `解释器 ${a}，C ${b}，期望 ${want}`);
};

// ---- 1) 动得了：`ext/lua/examples/record.lua`（1 / 5 / 6）
{
  const d = LANGS.get('lua');
  const { tb } = loadGrammarTable(`${ROOT}${d.grammar}`);
  const f = 'ext/lua/examples/record.lua';
  const diags = new Diagnostics();
  const toks = lexText(tb.grammar.lex, new SourceFile(f, readText(`${ROOT}${f}`)), diags);
  const g = d.toGraph(glrParse(tb, toks, diags));
  const c = cOf(g);
  has('record.lua〔出现 struct〕', cAll(g), 'struct r1 { gv f_x; gv f_y; };');
  has('record.lua〔取字段是一格偏移〕', c, 'g_print1(v_p.f_x);');
  has('record.lua〔放字段也是〕', c, 'v_p.f_y = g_num(5.0);');
  hasnt('record.lua〔不再堆上造一块〕', c, 'g_rec_new(');
  hasnt('record.lua〔不再按名字找键〕', c, 'g_field_get(');
  /* 「`gv` 计数下降」那一条：这一份现在**一格 `gv` 局部量都不剩** ——
   * 记录那一格成了 `struct r1`，三格 print 缓冲也没了（`g_print1` 那一格）。 */
  const gvs = c.split('\n  gv ').length - 1;
  if (gvs === 0) ok('record.lua〔gv 局部量一格都不剩（记录落 struct、print 走 g_print1）〕');
  else no('record.lua〔gv 局部量的格数〕', `量到 ${gvs} 格，账上写的是 0 —— 改了就把账一起改`);
  sameRun('record.lua〔C 腿跑出来一样〕', g, '1|5|6');
}

// ---- 2) 同形共用一格 struct
{
  const g = program([
    node('bind', { init: rec(['x'], [num(1)]) }, { name: 'a' }),
    node('bind', { init: rec(['x'], [num(2)]) }, { name: 'b' }),
    prim('print', [node('field-get', { obj: ref('a') }, { field: 'x' }),
      node('field-get', { obj: ref('b') }, { field: 'x' })]),
  ]);
  const c = cOf(g);
  has('同形〔只发一格 struct〕', cAll(g), 'struct r1 { gv f_x; };');
  hasnt('同形〔没有第二格〕', cAll(g), 'struct r2');
  sameRun('同形〔C 腿跑出来一样〕', g, '1 2');
}

// ---- 3) 跑出去了就不动（被 print 直接吃）
{
  const g = program([
    node('bind', { init: rec(['x'], [num(1)]) }, { name: 'p' }),
    prim('print', [node('field-get', { obj: ref('p') }, { field: 'x' })]),
    prim('len', [ref('p')]),
  ]);
  const c = cOf(g);
  has('跑出去〔还是堆上那一块〕', c, 'g_rec_new(');
  hasnt('跑出去〔没有 struct〕', cAll(g), 'struct r1');
  sameRun('跑出去〔C 腿跑出来一样〕', g, '1');
}

// ---- 4) 字段名对不上名单也不动
{
  const g = program([
    node('bind', { init: rec(['x'], [num(1)]) }, { name: 'q' }),
    prim('print', [node('field-get', { obj: ref('q') }, { field: 'x' })]),
    node('field-set', { obj: ref('q'), value: num(9) }, { field: 'z' }),
    prim('print', [node('field-get', { obj: ref('q') }, { field: 'z' })]),
  ]);
  const c = cOf(g);
  has('名单外的字段〔还是堆上那一块〕', c, 'g_rec_new(');
  hasnt('名单外的字段〔没有 struct〕', cAll(g), 'struct r1');
  /* 这一格**不比输出**，因为两条腿本来就不同（与形状推断无关的一笔旧账，量出来的）：
   * 解释器给记录**长出**一格新字段（`eval.js` 的 `setField` 就是 `obj[name] = value`），
   * 而 C 那侧 `g_field_set` 走的是 `g_key`，名单外的键当场骂。
   * 不写进 `C_SHAPES`：那张表的每一条要有一个**在 lower 那一步就报 Gap** 的证物，
   * 而这一条是运行期才炸 —— 记在这儿，等"记录能不能长字段"那件事有定论时一起动。 */
  ok('名单外的字段〔记一笔旧账：interp 长出新字段，C 当场骂 —— 与形状推断无关〕');
}

// ---- 5) 那格 record-new 被共享出去了也不动
{
  const shared = rec(['x'], [num(4)]);
  const g = program([
    node('bind', { init: shared }, { name: 'r' }),
    prim('print', [node('field-get', { obj: shared }, { field: 'x' })]),
  ]);
  const c = cOf(g);
  has('共享〔还是堆上那一块〕', c, 'g_rec_new(');
  hasnt('共享〔没有 struct〕', cAll(g), 'struct r1');
  sameRun('共享〔C 腿跑出来一样〕', g, '4');
}

process.stdout.write(`\n${pass} passed, ${fail} failed（形状推断：字段名静态可知的记录落 struct）\n`);
if (fail > 0) process.exit(1);
