// ext/lua/tests/gen.js —— **例子由规则生成**，三问对账，尺子是真的 luajit
//
// 这一份不放手写的用例清单（DESIGN.md 第 7 节）。它读节点表，按"每个节点 × 每个洞 × 那类洞的
// 每种合法填法"造出最小程序，再问三句话，每一句都有个**外部尺子**答：
//
//   甲（收不收）  我的解析器 vs `luajit` 的 `loadstring` —— 两边结论必须一样
//   乙（名字落在哪）scope.js 的配方预测 vs 真跑出来看见的**值**（每个绑定给一个独一无二的数）
//   丙（值有几格）  values.js 的元数契约 vs 真跑出来 `select('#', …)` 数出来的格数
//
// 与 jancy 那张 594 格表的区别：那儿每一格是我**填**的，这儿每一格是**算**的。
// 对不上就是一条失败，要么改规则，要么记一笔账 —— 都不许改期望。
//
// 用法：node ext/lua/tests/gen.js [--gsl] [--show 打印前几个例子]

import { execFileSync } from 'node:child_process';
import { parse, ParseError } from '../../../src/core/frontend-engine/parse-driver.js';
import { render } from '../../../src/core/frontend-engine/render.js';
import { luaLang } from '../lang.js';
import { gslLang } from '../../gsl-shell/lang.js';
import { luajitLang } from '../../luajit/lang.js';
import { holesOf } from '../../../src/core/frontend-engine/language.js';
import { bind, LUA_SCOPE as SCOPE } from '../scope.js';
import { listShape } from '../values.js';

const lang = process.argv.includes('--gsl') ? gslLang
  : process.argv.includes('--luajit') ? luajitLang : luaLang;

/** 这个例子有没有外部尺子：牵涉到的节点里若有 `noOracle`，本机的 luajit 讲的是别的方言。 */
const noOracle = (kinds) => kinds
  .map((k) => lang.NODE.get(k)?.noOracle)
  .find((x) => x !== undefined);
const show = Number((process.argv.find((a) => a.startsWith('--show=')) ?? '').slice(7)) || 0;

// ── 最小实例：每个节点"最小的一个我自己"────────────────────────────────────────
// 这不是用例清单，是**每类洞的填法字典**：生成器要往洞里放东西时问它。
const name = (v) => ({ kind: 'name', value: v });
const num = (v) => ({ kind: 'number', value: v });
const str = (v) => ({ kind: 'string', value: v });
const blk = (...stats) => ({ kind: 'block', stats });
const callOf = (fn, ...args) => ({ kind: 'call', fn: name(fn), args });

const MINI = {
  nil: () => ({ kind: 'nil' }),
  true: () => ({ kind: 'true' }),
  false: () => ({ kind: 'false' }),
  number: () => num(1),
  string: () => str('s'),
  vararg: () => ({ kind: 'vararg' }),
  name: () => name('n'),
  // 规范写法用中括号：`t["k"]`。点写法（`t.k`）是同一个节点的另一张 `syn`（`synDot`），
  // 单独造一个例子（见下面 `dotCases`）—— 生成器按 `syn` 造，就不会造出"点写法 + 表达式键"
  // 这种自相矛盾的东西（先前 30 个例子在 render 里炸，就是这么来的）。
  index: () => ({ kind: 'index', obj: name('t'), key: str('k'), dot: false }),
  call: () => callOf('f', num(1)),
  'method-call': () => ({ kind: 'method-call', obj: name('o'), method: 'm', args: [num(1)] }),
  paren: () => ({ kind: 'paren', inner: num(1) }),
  prefix: () => ({ kind: 'prefix', op: '-', a: num(1) }),
  binop: () => ({ kind: 'binop', op: '+', a: num(1), b: num(2) }),
  'function-exp': () => ({ kind: 'function-exp', body: MINI.funcbody() }),
  table: () => ({ kind: 'table', fields: [] }),
  lambda: () => ({ kind: 'lambda', names: ['x'], body: name('x') }),
  funcbody: () => ({ kind: 'funcbody', names: [], body: blk() }),
  block: () => blk(),
  'field-item': () => ({ kind: 'field-item', v: num(1) }),
  'field-name': () => ({ kind: 'field-name', key: 'a', v: num(1) }),
  'field-index': () => ({ kind: 'field-index', k: str('a'), v: num(1) }),
  local: () => ({ kind: 'local', names: ['a'], init: [num(1)] }),
  assign: () => ({ kind: 'assign', targets: [name('n')], values: [num(1)] }),
  'call-stat': () => ({ kind: 'call-stat', call: callOf('f') }),
  do: () => ({ kind: 'do', body: blk() }),
  while: () => ({ kind: 'while', cond: ({ kind: 'false' }), body: blk() }),
  repeat: () => ({ kind: 'repeat', body: blk(), cond: { kind: 'true' } }),
  if: () => ({ kind: 'if', cond: { kind: 'true' }, then: blk() }),
  'for-num': () => ({ kind: 'for-num', names: ['i'], from: num(1), to: num(1), body: blk() }),
  'for-in': () => ({ kind: 'for-in', names: ['k'], exprs: [callOf('pairs', name('t'))], body: blk() }),
  function: () => ({ kind: 'function', path: ['t', 'fn'], body: MINI.funcbody() }),
  'local-function': () => ({ kind: 'local-function', names: ['lf'], body: MINI.funcbody() }),
  return: () => ({ kind: 'return', values: [num(1)] }),
  break: () => ({ kind: 'break' }),
  goto: () => ({ kind: 'goto', label: 'L' }),
  label: () => ({ kind: 'label', label: 'L' }),
};

/** 前奏：给生成的例子一套现成的全局/局部名字，好让它们真能跑。 */
const PRE = [
  'local function f(...) return select("#", ...) end',
  'local function g() return 1, 2 end',
  'local t = { k = 1, 2 }',
  'local o = { m = function(self, ...) return select("#", ...) end }',
  'local n, s = 1, "s"',
].join('\n');

/** 每类洞的**默认**填法：造例子时"别的洞"用它填。 */
const DEF = {
  exp: 'number',
  prefixexp: 'call',
  var: 'name',
  block: 'block',
  funcbody: 'funcbody',
  field: 'field-item',
  stat: 'call-stat',
};

const mini = (nm) => {
  if (MINI[nm] === undefined) throw new Error(`没有 '${nm}' 的最小实例（节点表加了新节点？）`);
  return MINI[nm]();
};

/** 把一个节点包成一段能跑的程序（按它属于哪类洞）。 */
function wrap(node) {
  const cls = lang.NODE.get(node.kind).of;
  if (cls === 'stat') return blk(node);
  if (cls === 'field') return blk({ kind: 'local', names: ['q'], init: [{ kind: 'table', fields: [node] }] });
  if (cls === 'funcbody') return blk({ kind: 'local', names: ['q'], init: [{ kind: 'function-exp', body: node }] });
  if (cls === 'block') return blk({ kind: 'do', body: node });
  return blk({ kind: 'local', names: ['q'], init: [node] });          // exp / prefixexp / var
}

// ── 尺子：一次 luajit 调用问一批 ─────────────────────────────────────────────
/** 问语法：每段源码 luajit 收不收。答 `['OK'|'ERR …', …]`。 */
function askSyntax(srcs) {
  const probe = ['local S = {'];
  for (const s of srcs) probe.push(`[==[\n${s}\n]==],`);
  probe.push('}', 'for i = 1, #S do',
    '  local fn, err = loadstring(S[i])',
    '  print(fn and "OK" or ("ERR " .. tostring(err):gsub("^%b[]:%d+: ", "")))',
    'end');
  const out = execFileSync('luajit', ['-'], { input: probe.join('\n'), encoding: 'utf8' });
  return out.trimEnd().split('\n');
}

/** 问结果：每段源码跑一遍，把它自己 print 的那一行收回来（跑挂了记 'RUN <错>'）。 */
function askRun(srcs) {
  const probe = ['local S = {'];
  for (const s of srcs) probe.push(`[==[\n${s}\n]==],`);
  probe.push('}', 'for i = 1, #S do',
    '  local fn, err = loadstring(S[i])',
    '  if not fn then print("ERR " .. tostring(err):gsub("^%b[]:%d+: ", ""))',
    '  else',
    '    local got = {}',
    '    local old = print',
    '    print = function(...) local n = select("#", ...) local xs = {} for j = 1, n do xs[j] = tostring((select(j, ...))) end got[#got+1] = table.concat(xs, ",") end',
    '    local ok, e = pcall(fn)',
    '    print = old',
    '    if ok then print("VAL " .. table.concat(got, ";"))',
    '    else print("RUN " .. tostring(e):gsub("^%b[]:%d+: ", "")) end',
    '  end',
    'end');
  const out = execFileSync('luajit', ['-'], { input: probe.join('\n'), encoding: 'utf8' });
  return out.trimEnd().split('\n');
}

// ── 甲：收不收（全部节点 × 全部洞 × 那类洞的全部成员）──────────────────────────
function suiteSyntax() {
  const cases = [];
  for (const n of lang.nodes) {
    const holes = holesOf(n);
    if (holes.length === 0) {                          // 叶子节点：它自己就是一个例子
      cases.push({ what: n.name, node: mini(n.name) });
      continue;
    }
    for (const h of holes) {
      for (const m of lang.membersOf(h.cls)) {
        const node = mini(n.name);
        const filler = mini(m);
        node[h.name] = h.list === true || h.rep === true ? [filler] : filler;
        // 重复组里的洞是**一组**的（`elseif <cond> then <block>`）：填一个就得把同组的都填上，
        // 否则写回去时那一格是空的。同组 = 同样带 `rep` 标记 —— 这一格也是从 syn 读出来的。
        if (h.rep === true) {
          for (const o of holes) {
            if (o.rep !== true || o.name === h.name) continue;
            node[o.name] = [mini(DEF[o.cls])];
          }
        }
          cases.push({ what: `${n.name}.${h.name}=${m}`, node, kinds: [n.name, m] });
      }
    }
  }
  // 另一张 `syn` 的节点（`index` 的点写法）：也来一个例子。**由表决定**：
  // 扫 `synDot` 里的裸名字格（`w`），把它填成名字。
  for (const n of lang.nodes) {
    if (n.synDot === undefined) continue;
    const node = mini(n.name);
    node.dot = true;
    for (const it of n.synDot) if (typeof it === 'object' && it.w !== undefined) node[it.w] = 'k';
    cases.push({ what: `${n.name}（另一张 syn）`, node, kinds: [n.name] });
  }
  const srcs = [];
  const mine = [];
  for (const c of cases) {
    let text;
    try {
      text = render(wrap(c.node), lang);
    } catch (err) {
      mine.push({ v: 'render 炸了', why: err.message });
      srcs.push('');
      continue;
    }
    c.src = `${PRE}\n${text}`;
    srcs.push(c.src);
    try {
      const ast = parse(c.src, lang);
      // "收不收"包括**位置**那一层：`break` 要有循环、`goto` 要有标签（scope.js 的 CTX）。
      const { errors } = bind(ast, lang);
      mine.push(errors.length === 0 ? { v: 'OK' } : { v: 'ERR', why: errors[0].why });
    } catch (err) {
      if (!(err instanceof ParseError) && err.name !== 'LexError') throw err;
      mine.push({ v: 'ERR', why: err.message });
    }
  }
  const theirs = askSyntax(srcs);
  const piles = new Map();
  let same = 0;
  let skip = 0;
  for (const [i, c] of cases.entries()) {
    if (noOracle(c.kinds ?? []) !== undefined) { skip += 1; continue; }
    const mv = mine[i].v;
    const tv = theirs[i].startsWith('OK') ? 'OK' : 'ERR';
    if (mv === tv) { same += 1; continue; }
    const key = `我${mv} 它${tv}：${(mv === 'ERR' ? mine[i].why : theirs[i]).replace(/^\d+ 行：/, '')}`;
    if (!piles.has(key)) piles.set(key, []);
    piles.get(key).push(c.what);
  }
  return { total: cases.length - skip, same, piles, cases, skip };
}

/** 问名字：`luajit -bl` 的字节码里，哪些名字是**全局**读写（GGET/GSET）。 */
function askGlobals(src) {
  const out = execFileSync('luajit', ['-bl', '-'], { input: src, encoding: 'utf8' });
  const got = new Set();
  for (const m of out.matchAll(/\bG(?:GET|SET)\b[^;]*; "([^"]+)"/g)) got.add(m[1]);
  return got;
}

// ── 乙：名字落在哪（每个"绑定型"节点 × 它的每个洞）─────────────────────────────
// 例子是从 **scope.js 的配方**里长出来的：一个节点绑了 `x`，就把探针 `print(x)` 挨个放进
// 它的每个洞里，看那一格看不看得见 `x`。尺子是 luajit 的字节码：看得见就是局部槽，
// 看不见就编成 `GGET "x"`（Lua 里"找不着"= 全局表查）。
function suiteScope() {
  const probeExp = () => callOf('print', name('x'));
  const probeStat = () => ({ kind: 'call-stat', call: probeExp() });
  const cases = [];
  for (const n of lang.nodes) {
    const rule = SCOPE[n.name];
    if (rule === undefined) continue;
    const binder = (rule.steps.find((s) => s.startsWith('bind:')) ?? '').slice(5);
    const inline = rule.steps.some((s) => s.startsWith('inline:'));
    if (binder === '' && !inline) continue;                  // 既不绑名字也没有例外，没什么可问
    for (const h of holesOf(n)) {
      let filler;
      if (h.cls === 'exp') filler = probeExp();
      else if (h.cls === 'block') filler = blk(probeStat());
      else if (h.cls === 'funcbody') filler = { kind: 'funcbody', names: [], body: blk(probeStat()) };
      else continue;                                          // var / prefixexp 的洞放不了探针
      const node = mini(n.name);
      if (binder !== '') node[binder] = ['x'];
      node[h.name] = h.list === true || h.rep === true ? [filler] : filler;
      if (h.rep === true) {
        for (const o of holesOf(n)) {
          if (o.rep !== true || o.name === h.name) continue;
          node[o.name] = [mini(DEF[o.cls])];
        }
      }
      cases.push({ what: `${n.name}.${h.name}`, node, kinds: [n.name] });
    }
    // 还问一句"**漏不漏**"：把探针放在这个节点**后面**的一条语句里。`local x` 该漏
    // （同一块里后面的语句看得见），`for x` / 形参 / `repeat` 里的 local 该不漏。
    if (binder !== '' && n.of === 'stat') {          // "之后"只对语句说得通
      const node = mini(n.name);
      node[binder] = ['x'];
      cases.push({ what: `${n.name} 之后`, node, after: true, kinds: [n.name] });
    }
  }
  const piles = new Map();
  let same = 0;
  let skip = 0;
  for (const c of cases) {
    if (noOracle(c.kinds ?? []) !== undefined) { skip += 1; continue; }
    const body = c.after === true
      ? blk(c.node, { kind: 'call-stat', call: callOf('print', name('x')) })
      : wrap(c.node);
    c.src = render(body, lang);
    const { uses } = bind(parse(c.src, lang), lang);
    const mineGlobal = uses.some((u) => u.name === 'x' && u.found === 'ENV');
    const theirs = askGlobals(c.src);
    const theirGlobal = theirs.has('x');
    if (mineGlobal === theirGlobal) { same += 1; continue; }
    const key = mineGlobal ? '我说全局，它说局部（我的作用域漏了一格）' : '我说局部，它说全局（我多绑了一格）';
    if (!piles.has(key)) piles.set(key, []);
    piles.get(key).push(c.what);
  }
  return { total: cases.length - skip, same, piles, cases, skip };
}

// ── 丙：值有几格（元数契约 vs `select('#', …)` 数出来的）──────────────────────
// 三种能**直接观测**的容器（实参 / return / 表构造）× 三种多值节点 × 在不在最后一格。
// 其余容器（`local a,b = …`、`for … in …`）的规则与这三种**同一条**（`spread: 'last'`），
// 观测起来要另造探针，先记一笔账：没量。
function suiteArity() {
  const MULTI = {
    'call（g()）': { text: 'g()', n: 2, node: callOf('g') },
    'method-call（o:m2()）': { text: 'o:m2()', n: 2, node: { kind: 'method-call', obj: name('o'), method: 'm2', args: [] } },
    'vararg（...）': { text: '...', n: 2, node: { kind: 'vararg' } },
  };
  const BOXES = {
    '实参': (list) => `return count(${list})`,
    'return': (list) => `return select("#", (function(...) return ${list} end)(7, 8))`,
    '表构造': (list) => `local q = {${list}} return #q`,
  };
  const HEAD = [
    'local function g() return 1, 2 end',
    'local o = { m2 = function(self) return 1, 2 end }',
    'local function count(...) return select("#", ...) end',
  ].join('\n');

  const cases = [];
  for (const [bn, box] of Object.entries(BOXES)) {
    for (const [mn, m] of Object.entries(MULTI)) {
      for (const last of [true, false]) {
        const items = last ? [m.node] : [m.node, num(9)];
        const text = items.map((x) => render(x, lang)).join(', ');
        const shape = listShape(items, lang);
        const want = shape.fixed + (shape.spread ? m.n : 0);
        cases.push({
          what: `${bn} ← ${mn}${last ? '（最后一格）' : '（不在最后）'}`,
          want,
          src: `${HEAD}\nlocal r = (function(...)\n${box(text)}\nend)(7, 8)\nprint(r)`,
        });
      }
    }
  }
  const got = askRun(cases.map((c) => c.src));
  const piles = new Map();
  let same = 0;
  for (const [i, c] of cases.entries()) {
    const g = (got[i] ?? '').startsWith('VAL ') ? Number(got[i].slice(4)) : got[i];
    if (g === c.want) { same += 1; continue; }
    const key = `契约说 ${c.want} 格，跑出来 ${g}`;
    if (!piles.has(key)) piles.set(key, []);
    piles.get(key).push(c.what);
  }
  return { total: cases.length, same, piles, cases };
}

const board = (title, r) => {
  const sk = (r.skip ?? 0) > 0 ? `　跳过 ${r.skip}（没外部尺子）` : '';
  console.log(`\n${title}：${r.same}/${r.total} 一致${sk}`);
  for (const [k, v] of [...r.piles].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(v.length).padStart(4)}  ${k}`);
    console.log(`        ${v.slice(0, 4).join('  ')}${v.length > 4 ? ' …' : ''}`);
  }
};

const A = suiteSyntax();
board(`甲 收不收（${lang.name}）`, A);
const B = suiteScope();
board('乙 名字落在哪（尺子：luajit 字节码里的 GGET）', B);
const C = suiteArity();
board('丙 值有几格（尺子：跑出来 select("#")）', C);
if (show > 0) {
  for (const c of A.cases.slice(0, show)) console.log(`\n--- ${c.what}\n${c.src}`);
}
const bad = (A.total - A.same) + (B.total - B.same) + (C.total - C.same);
console.log(`\n合计 ${A.total + B.total + C.total} 格，分歧 ${bad}`);
process.exitCode = bad === 0 ? 0 : 1;
