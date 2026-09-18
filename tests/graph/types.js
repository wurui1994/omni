#!/usr/bin/env node
// tests/graph/types.js —— **类型覆盖层的判据**（#40 第二步）
//
// 上游是 `docs/design/node-graph-typed-overlay.md` 第四节那三条判据。这一份落两条：
//
//   * **判据三 · 不许猜**（这一层最大的风险）：推不出来的必须答 `unknown`，
//     而**不是**印一个像样的答案。设计里写着"落地时要有一格**反向证物**" —— 下面第 2 节
//     那七格就是它。原来这一层里有 9 处 `?? 'int'`，现在**只剩一处**（`typeOf` 那一格，
//     它是 core 这条腿今天的口径），这一节把"还剩几处在猜"变成数得出来的账。
//   * **词汇闭合**：这一层答的话只许落在设计第二节那张词汇表里。拿 142 份语言例子
//     整棵图问一遍 —— 哪天有人在这一层多编一个词出来（`i64` / `any` / `Box`），这儿当场红。
//
// **判据一（三处说同一句话）还没落**，理由是次序：wat 那条腿的 `kindOf` 是 `emitWat`
// 里的闭包，今天**没法从外头问它**。让它问覆盖层是设计第六节的第三步 ——
// 到那一步这两处才有得比。不在这儿摆一个假的对照。
//
//   node tests/graph/types.js

import { loadGrammarTable } from '../../src/core/glr/load.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { readText } from '../../src/core/host/native.js';
import { node, lit } from '../../src/core/graph/graph.js';
import { Gap } from '../../src/core/graph/backend-wat.js';
import { watKindOf } from '../../src/core/graph/backend-wat.js';
import { inferType, typeOf, UNKNOWN } from '../../src/core/graph/types.js';
import { CASES } from './cases.js';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = `${HERE}../../`;
let pass = 0;
let fail = 0;
const ok = (s) => { pass++; process.stdout.write(`  ok   ${s}\n`); };
const no = (s, why) => { fail++; process.stdout.write(`  FAIL ${s}\n       ${why}\n`); };

/** 一格最小的登记处：形状表 + 登记 + 报缺口（后端交的那三样，见 types.js 文件头）。 */
function mkCtx() {
  const ctx = { byKey: new Map(), shapes: new Map(), decls: [] };
  ctx.gap = (why) => { throw new Gap(`types 判据：${why}`); };
  ctx.shapeOf = (names, types, multi) => {
    const key = `${multi ? 'm' : 'r'}|${names.map((n, i) => `${n}:${types[i]}`).join('|')}`;
    let shape = ctx.byKey.get(key);
    if (shape !== undefined) return shape;
    shape = { tag: `${multi ? 'm' : 'r'}${ctx.byKey.size + 1}`, names, types: new Map(), multi };
    for (let i = 0; i < names.length; i++) shape.types.set(names[i], types[i]);
    ctx.byKey.set(key, shape);
    ctx.shapes.set(shape.tag, shape);
    return shape;
  };
  return ctx;
}

const num = (v) => node('const', {}, { value: v });
const prim = (name, args) => node('prim', { args }, { name });
const ref = (n) => node('ref', {}, { name: n });

const said = (label, x, want, env = new Map()) => {
  let got;
  try {
    got = inferType(x, env, mkCtx());
  } catch (err) {
    got = `<缺口: ${err.message}>`;
  }
  if (got === want) ok(`${label} [${got}]`);
  else no(label, `期望 ${want}，答的是 ${got}`);
};

// ---- 1) 正向：推得出来的那几档，答案要对得上 ------------------------------------
{
  said('字面量〔整〕', num(7), 'int');
  said('字面量〔带小数点〕', lit(1.5), 'real');
  said('字面量〔串〕', lit('a'), 'string');
  said('字面量〔真假〕', num(true), 'bool');
  said('比较出真假', prim('<', [num(1), num(2)]), 'bool');
  said('len 出整数', prim('len', [ref('xs')]), 'int');
  said('串接出串', prim('concat', [num(1), lit('x')]), 'string');
  /* V 与 go 的**串接也写成 `+`** —— 这一格咬过一次（说成 int，方言当场骂一句错误）。 */
  said("'a' + 'b' 是串接", prim('+', [lit('a'), lit('b')]), 'string');
  said('一边是实数就出实数', prim('+', [num(1), lit(1.5)]), 'real');
  said('位运算出整数', prim('shl', [num(1), num(3)]), 'int');
  said('表示转换看 to 那一栏', node('conv', { value: num(1) }, { to: 'float' }), 'real');
  said('名字从 env 里查', ref('s'), 'string', new Map([['s', 'string']]));
  said('下标取元素', node('index-get', { obj: ref('xs'), index: num(0) }, {}),
    'int', new Map([['xs', '(arr int)']]));
  said('按键取值', node('map-get', { obj: ref('m'), key: lit('k') }, {}),
    'string', new Map([['m', '(dict string string)']]));
  said('在不在只答真假', node('map-has', { obj: ref('m'), key: lit('k') }, {}), 'bool');
  /* 表达式位置上的 branch（V 的 `match` 当表达式用）—— 这一格也咬过一次。 */
  said('branch 看一支就够', node('branch', { cond: num(true), then: lit('y'), else: lit('n') }, {}),
    'string');
}

// ---- 2) 反向证物（判据三 · 不许猜）--------------------------------------------
//
// 这七格是**故意推不出来**的。它们每一格原来都答 `int` —— 那不是答案，是猜。
// 判据是两句话：`inferType` 必须答 `unknown`；而**同一格**经 `typeOf` 才是 `int`
// （那一处是 core 今天的口径，见 types.js 里 `typeOf` 上面那段注）。
{
  const witnesses = [
    ['没绑过的名字（跨文件那一族的根）', ref('未知的名字')],
    ['调一个不知道返回什么的函数', node('call', { fn: ref('f'), args: [] }, {})],
    ['说不清类型的字面量（null）', lit(null)],
    ['在说不清形状的东西上取下标', node('index-get', { obj: ref('未知'), index: num(0) }, {})],
    ['在说不清形状的东西上按键取值', node('map-get', { obj: ref('未知'), key: lit('k') }, {})],
    ['算术的一边推不出来', prim('+', [ref('未知'), num(1)])],
    ['这一层不认识的节点（slice）',
      node('slice', { obj: ref('xs'), from: num(0), to: num(1) }, {})],
  ];
  for (const [label, x] of witnesses) {
    said(`反向证物〔${label}〕`, x, UNKNOWN);
    const t = typeOf(x, new Map(), mkCtx());
    if (t === 'int') ok(`反向证物〔${label}〕经 typeOf 当 int（那一处就是还剩的一格猜）`);
    else no(`反向证物〔${label}〕经 typeOf`, `期望 int（今天的口径），答的是 ${t}`);
  }
}

// ---- 3) 词汇闭合：这一层答的话只许落在设计第二节那张表里 --------------------------
//
// 为什么拿整棵图问（而不是只问值位置那几格）：这一条要抓的是"多编了一个词出来"，
// 那种事在哪一格上都可能发生。语句位置上的节点答 `unknown` 是**对的**（它没有值）。
const SCALARS = new Set(['int', 'real', 'string', 'bool', UNKNOWN]);
/* `(ptr rN)` 是**记录**那一格的写法（`types.js` 的 `shapeType`：图上记录是引用，方言里
   对得上的是指针）—— 它与 `mN` 一样是词汇表里的一个词，不是"多编出来的"。 */
const inVocab = (t) => (typeof t === 'string'
  && (SCALARS.has(t) || t.startsWith('(arr ') || t.startsWith('(dict ')
    || /^[rm][0-9]+$/.test(t) || /^\(ptr r[0-9]+\)$/.test(t) || t === null));
{
  const tally = new Map();
  const bump = (k) => tally.set(k, (tally.get(k) ?? 0) + 1);
  const bad = [];
  let asked = 0;
  const walk = (x, ctx) => {
    if (x === null || x === undefined) return;
    if (Array.isArray(x)) { for (const y of x) walk(y, ctx); return; }
    if (x.kind === 'graph') { walk(x.body, ctx); return; }
    if (x.lit === undefined && x.op === undefined) return;
    let t;
    try {
      t = inferType(x, new Map(), ctx);
    } catch (err) {
      if (!(err instanceof Gap)) throw err;
      bump('报缺口');           // 报缺口是合格的答法（有名有姓，不是猜）
      t = null;
    }
    if (t !== null) {
      asked++;
      bump(inVocab(t) ? (SCALARS.has(t) ? t : t.replace(/^\((arr|dict) .*$/, '($1 …)')) : `× ${t}`);
      if (!inVocab(t)) bad.push(`${x.op ?? '字面量'} -> ${JSON.stringify(t)}`);
    }
    for (const k of Object.values(x.ins ?? {})) walk(k, ctx);
  };
  for (const c of CASES) {
    let g = null;
    try {
      const { tb } = loadGrammarTable(`${ROOT}${c.grammar}`);
      const text = readText(`${ROOT}${c.file}`);
      const diags = new Diagnostics();
      const toks = lexText(tb.grammar.lex, new SourceFile(c.file, text), diags);
      const tree = glrParse(tb, toks, diags);
      g = c.toGraph(tree);
    } catch (err) {
      no(`词汇闭合〔${c.name}〕`, `建图炸了：${err.message}`);
      continue;
    }
    walk(g, mkCtx());
  }
  const account = [...tally].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ');
  if (bad.length === 0) ok(`词汇闭合〔${CASES.length} 份例子问了 ${asked} 格〕[${account}]`);
  else no('词汇闭合', `这几格答出了词汇表以外的东西：\n       ${bad.slice(0, 5).join('\n       ')}`);
}

// ---- 4) 还剩几处在猜：数出来，不是记着 ------------------------------------------
//
// 设计里判据三那句可执行的话是"**`unknown` 不许被默认值吞掉**"。今天还有吞的地方
// （core 的口径：形参与返回默认 int），所以这一节不是"必须为 0"，是**必须数得出来**：
// 数字变了就得有人来改这一行 —— 那正是"账不许悄悄涨"。
{
  /* `retTypeOf` 里剩的那 2 处（`litLeaningType(v) ?? 'int'` 与 `return 'int'`）以及
     `typeOf` 里那 1 处（`UNKNOWN ? 'int'`）—— 合计 4 处。regex 里既匹配 `?? 'int'`
     也匹配 `UNKNOWN ? 'int'`（写在 `typeOf` 那一格的）。
     retTypeOf 的那两处原因一样：**它跑得早**（调用点扫函数签名那一趟），形状还没登记全，
     问 typeOf 那一档会报缺口（method 那一族当场红过）。它不猜"表达式是什么类型"
     （那件事归 inferType），它猜的是"函数返回什么类型" —— 两件事换不了：
     用 inferType 代替 litLeaningType 就会问形状表，那张表在这一趟空的。
     所以这 3 处是目前 types.js 里**正当的**猜。*/
  /* 实际匹配的两处：
     1. `typeOf` 里的 `t === UNKNOWN ? 'int' : t`
     2. `retTypeOf` 里的 `litLeaningType(v) ?? 'int'`
     （`retTypeOf` 尾部那行 `return 'int'` 是一个裸 `return`，不是 `??`，regex 碰不到它 ——
     但它也是一处猜。这里只数 regex 能碰到的 2 处就够了 —— 那行 `return` 改的时候
     WANT 也要改。三处猜的理由都写在 types.js 的注里。）*/
  const WANT = 2;
  const tySrc = readText(`${ROOT}src/core/graph/types.js`);
  const got = (tySrc.match(/ \?\? 'int'|UNKNOWN \? 'int'/g) ?? []).length;
  if (got === WANT) ok(`吞掉 unknown 的地方 [${got} 处 —— 抽出来那天是 9 处]`);
  else {
    no('吞掉 unknown 的地方', `数出来 ${got} 处，这一行写着 ${WANT} 处 —— `
      + '要么是又多了一处猜（那得说清为什么），要么是治好了一处（那就把这个数改小）');
  }
  /* **core 后端那两处不算覆盖层的猜**：它们查的是 `ctx.args`（从调用点收上来的实参类型）
     和 `env['fn:…']`（从函数体里 retTypeOf 推出来的返回类型）。两样都是 core **自己那条
     两趟收集链**的产物 —— 收不到的落回 int 是"方言的形参默认 int"那条口径，
     不是类型推断层的猜。那两处归下一步治（hints 喂进来之后就不用收了）。 */
  const core = readText(`${ROOT}src/core/graph/backend-core.js`);
  const leaked = (core.match(/ \?\? 'int'/g) ?? []).length;
  const CORE_WANT = 2;
  if (leaked === CORE_WANT) ok(`core 那条腿里 ${leaked} 处收集链默认值（不是覆盖层的猜）`);
  else no('core 那条腿', `期望 ${CORE_WANT} 处，数出来 ${leaked} 处 —— 变了就得说清`);
}

// ---- 5) 判据一 · 三处必须说同一句话（这一步只落 wat 那一处）------------------------
//
// 设计第四节判据一的原话：「wat 那三档是覆盖层的粗化：`string`->str、`real`->real、
// 别的 ->int」。第三步把 wat 的 `kindOf` 提到了顶层（`watKindOf`）—— 于是这一条**问得着**了。
//
// 比法：拿每份例子的每一格节点，两边各问一次（都用空的名字表 —— 名字那一档两边的存法
// 本来就不同形：wat 是作用域链、覆盖层是一张平表，那是**粗化的边界**不是分叉）。
// 对不上的必须落进下面这几类**写下来的**差里；落不进就是有一处错，当场红。
{
  const ARITH = new Set(['+', '-', '*', '/', '%', '^']);
  const coarse = (t) => (t === 'string' ? 'str' : (t === 'real' ? 'real' : 'int'));
  const emptySc = { lookup: () => null, kindOf: () => 'int' };
  const emptyGk = new Map();
  /** 写下来的那几类差（每一类一句为什么）。回 null = 说不清 = 当场红。 */
  const classifyOwn = (x, watAns, ovAns) => {
    if (ovAns === '<缺口>') return 'conv/字段那几格覆盖层报缺口（方言接不住，wat 当 i64 接得住）';
    if (x.op === 'branch' && watAns === 'mix') return 'branch 两支不同型：wat 要答 mix（wasm 的值类型只有一种），覆盖层没有这一档';
    if (x.op === 'prim' && !ARITH.has(x.attrs.name) && x.attrs.name !== 'concat') {
      return '非算术内建：wat 一律当 i64（那一格的值不往外流），覆盖层照实参说';
    }
    return null;
  };
  /**
   * **顺着"透传"那几格往上传的差**：`branch` 与 `region` 交出来的就是里头那一格的类型，
   * 所以里头那一格的差会原样冒上来（量到的就是它：`match` 的一支里有一格非算术内建，
   * 于是 wat 说 int、覆盖层说 str）。只顺**透传**那几条边往下找 —— 别的边不传类型，
   * 顺着它们找就等于把这条判据放水。
   */
  const throughs = (x) => (x.op === 'branch' ? [x.ins.then, x.ins.else]
    : (x.op === 'region' ? [x.ins.body] : []));
  const fromBelow = (x) => {
    for (let kid of throughs(x)) {
      if (Array.isArray(kid)) kid = kid[kid.length - 1];
      if (kid === null || kid === undefined || typeof kid !== 'object') continue;
      if (kid.op === undefined) continue;
      let ov;
      try {
        ov = coarse(inferType(kid, new Map(), mkCtx()));
      } catch {
        ov = '<缺口>';
      }
      const wat = watKindOf(kid, emptySc, emptyGk);
      if (ov !== wat && (classifyOwn(kid, wat, ov) !== null || fromBelow(kid))) return true;
    }
    return false;
  };
  const classify = (x, watAns, ovAns) => classifyOwn(x, watAns, ovAns)
    ?? (fromBelow(x) ? '透传那几格（branch / region）把里头那一格的差原样冒上来' : null);
  const tally = new Map();
  const bump = (k) => tally.set(k, (tally.get(k) ?? 0) + 1);
  const unexplained = [];
  let compared = 0;
  const walk = (x, ctx) => {
    if (x === null || x === undefined) return;
    if (Array.isArray(x)) { for (const y of x) walk(y, ctx); return; }
    if (x.kind === 'graph') { walk(x.body, ctx); return; }
    if (x.lit === undefined && x.op === undefined) return;
    let ov;
    try {
      ov = coarse(inferType(x, new Map(), ctx));
    } catch (err) {
      if (!(err instanceof Gap)) throw err;
      ov = '<缺口>';
    }
    const wat = watKindOf(x, emptySc, emptyGk);
    compared++;
    if (ov === wat) bump(`一致 ${wat}`);
    else {
      const why = classify(x, wat, ov);
      if (why === null) unexplained.push(`${x.op ?? '字面量'}: wat ${wat} / 覆盖层 ${ov}`);
      else bump(`差〔${why.slice(0, 12)}…〕`);
    }
    for (const k of Object.values(x.ins ?? {})) walk(k, ctx);
  };
  for (const c of CASES) {
    let g = null;
    try {
      const { tb } = loadGrammarTable(`${ROOT}${c.grammar}`);
      const text = readText(`${ROOT}${c.file}`);
      const diags = new Diagnostics();
      const toks = lexText(tb.grammar.lex, new SourceFile(c.file, text), diags);
      const tree = glrParse(tb, toks, diags);
      g = c.toGraph(tree);
    } catch {
      continue;   // 建图炸了那一格上面第 3 节已经红过，不重复记
    }
    walk(g, mkCtx());
  }
  const account = [...tally].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ');
  if (unexplained.length === 0) ok(`判据一〔wat 与覆盖层比了 ${compared} 格〕[${account}]`);
  else {
    no('判据一〔wat 与覆盖层〕', `这几格对不上，而且不属于写下来的任何一类差：\n       `
      + unexplained.slice(0, 8).join('\n       '));
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed（类型覆盖层：推不出来就说不知道 · 词汇闭合 · 与 wat 同一句话）\n`);
if (fail > 0) process.exit(1);
