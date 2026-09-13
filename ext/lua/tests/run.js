// ext/lua/tests/run.js —— **第二条腿**：同一段 Lua，`luajit` 跑一遍、`omni run` 跑一遍
//
// 例子还是生成的（节点 × 洞 × 那类洞里**这一刀收得下**的成员），程序都以 `print` 收尾，
// 于是"跑出来一样吗"这一问有确定答案。三种结果：
//
//   一致    两条腿的输出逐字相同
//   记账    我的降级当场拒（`lower.js` 的 ACCOUNTS），按账号归堆 —— 这是**明账**，不是失败
//   分歧    两边都跑了但输出不同，或者核心方言不收我降出来的东西 ← 只有这个算失败
//
// 用法：node ext/lua/tests/run.js [--show]

import { execFileSync } from 'node:child_process';
import {
  mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { parse } from '../parse.js';
import { render } from '../render.js';
import { luaLang } from '../lang.js';
import { holesOf } from '../lang.js';
import { lower, ACCOUNTS, Refuse } from '../lower.js';

const show = process.argv.includes('--show');
const lang = luaLang;
const WORK = '.omni-cache/test/lua-run';
mkdirSync(WORK, { recursive: true });

// 这一刀收得下的最小实例（与 lower.js 的名单同源：数、局部量、算术、控制流、局部函数）
const name = (v) => ({ kind: 'name', value: v });
const num = (v) => ({ kind: 'number', value: v });
const blk = (...stats) => ({ kind: 'block', stats });
const P = (e) => ({ kind: 'call-stat', call: { kind: 'call', fn: name('print'), args: [e] } });

const MINI = {
  number: () => num(3),
  true: () => ({ kind: 'true' }),
  false: () => ({ kind: 'false' }),
  name: () => name('n'),
  paren: () => ({ kind: 'paren', inner: num(4) }),
  prefix: () => ({ kind: 'prefix', op: '-', a: num(5) }),
  binop: () => ({ kind: 'binop', op: '+', a: name('n'), b: num(2) }),
  call: () => ({ kind: 'call', fn: name('twice'), args: [num(6)] }),
  block: () => blk(P(name('n'))),
  funcbody: () => ({ kind: 'funcbody', names: ['x'], body: blk({ kind: 'return', values: [name('x')] }) }),
  local: () => ({ kind: 'local', names: ['a'], init: [num(7)] }),
  assign: () => ({ kind: 'assign', targets: [name('n')], values: [num(8)] }),
  'call-stat': () => P(num(9)),
  do: () => ({ kind: 'do', body: blk(P(num(10))) }),
  while: () => ({ kind: 'while', cond: { kind: 'false' }, body: blk(P(num(11))) }),
  repeat: () => ({ kind: 'repeat', body: blk(P(num(12))), cond: { kind: 'true' } }),
  if: () => ({ kind: 'if', cond: { kind: 'true' }, then: blk(P(num(13))) }),
  'for-num': () => ({ kind: 'for-num', names: ['i'], from: num(1), to: num(2), body: blk(P(name('i'))) }),
  'local-function': () => ({ kind: 'local-function', names: ['lf'], body: MINI.funcbody() }),
  return: () => ({ kind: 'return' }),
  break: () => ({ kind: 'break' }),
};
const SUBSET = new Set(Object.keys(MINI));
const DEF = { exp: 'number', block: 'block', funcbody: 'funcbody', stat: 'call-stat' };

/** 前奏：一个局部数、一个局部函数 —— 都在这一刀收得下的范围里。 */
const PRE = [
  { kind: 'local', names: ['n'], init: [num(1)] },
  {
    kind: 'local-function',
    names: ['twice'],
    body: {
      kind: 'funcbody',
      names: ['x'],
      body: blk({ kind: 'return', values: [{ kind: 'binop', op: '*', a: name('x'), b: num(2) }] }),
    },
  },
];

/** 把一个节点包成"跑起来看得见"的程序：语句照放，表达式放进 `print`。 */
function program(node) {
  const cls = lang.NODE.get(node.kind).of;
  const tail = P(name('n'));
  if (cls === 'stat') return blk(...PRE, node, tail);
  if (cls === 'block') return blk(...PRE, { kind: 'do', body: node }, tail);
  if (cls === 'funcbody') {
    return blk(...PRE, { kind: 'local-function', names: ['q'], body: node },
      P({ kind: 'call', fn: name('q'), args: [num(21)] }), tail);
  }
  return blk(...PRE, P(node), tail);
}

const cases = [];
for (const n of lang.nodes) {
  if (!SUBSET.has(n.name)) continue;
  const holes = holesOf(n).filter((h) => DEF[h.cls] !== undefined);
  if (holes.length === 0) { cases.push({ what: n.name, node: MINI[n.name]() }); continue; }
  for (const h of holes) {
    for (const m of lang.membersOf(h.cls)) {
      if (!SUBSET.has(m)) continue;
      const node = MINI[n.name]();
      const filler = MINI[m]();
      node[h.name] = h.list === true || h.rep === true ? [filler] : filler;
      if (h.rep === true) {
        for (const o of holes) {
          if (o.rep !== true || o.name === h.name) continue;
          node[o.name] = [MINI[DEF[o.cls]]()];
        }
      }
      cases.push({ what: `${n.name}.${h.name}=${m}`, node });
    }
  }
}

// 语料：`tests/corpus/*.lua`。这不是"手写的期望清单" —— 期望由 luajit 给，
// 这儿只放**写得像真程序**的例子（生成器造不出来的那种：几件事凑在一起）。
const CORPUS = 'ext/lua/tests/corpus';
if (existsSync(CORPUS)) {
  for (const f of readdirSync(CORPUS).sort()) {
    if (!f.endsWith('.lua')) continue;
    cases.push({ what: `语料 ${f}`, src: readFileSync(join(CORPUS, f), 'utf8') });
  }
}

const piles = new Map();
const pile = (k, x) => {
  if (!piles.has(k)) piles.set(k, []);
  piles.get(k).push(x);
};
let same = 0;
let owed = 0;
let bad = 0;

for (const [i, c] of cases.entries()) {
  if (c.src === undefined) c.src = render(program(c.node), lang);
  const luaPath = join(WORK, `c${i}.lua`);
  const sxPath = join(WORK, `c${i}.sx`);
  writeFileSync(luaPath, `${c.src}\n`);
  let want;
  try {
    want = execFileSync('luajit', [luaPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    continue;                                   // luajit 都不收，那是"甲"那一问的事
  }
  let sx;
  try {
    sx = lower(parse(c.src, lang), lang).text;
  } catch (err) {
    if (!(err instanceof Refuse)) throw err;
    owed += 1;
    pile(`记账 ${err.id}｜${ACCOUNTS[err.id].say}`, c.what);
    continue;
  }
  writeFileSync(sxPath, sx);
  let got;
  try {
    got = execFileSync('node', ['src/core/cli.js', 'run', sxPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    bad += 1;
    pile('核心方言不收我降出来的东西', `${c.what}｜${String(err.stdout ?? err.message).trim().split('\n')[0]}`);
    continue;
  }
  if (got === want) { same += 1; continue; }
  bad += 1;
  pile('两条腿输出不一样', `${c.what}｜luajit ${JSON.stringify(want)}｜omni ${JSON.stringify(got)}`);
}

console.log(`两条腿（luajit vs omni run）：例子 ${cases.length} 个`);
console.log(`一致 ${same}　记账 ${owed}　分歧 ${bad}`);
for (const [k, v] of [...piles].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(v.length).padStart(4)}  ${k}`);
  for (const x of v.slice(0, show ? v.length : 2)) console.log(`        ${x}`);
}
process.exitCode = bad === 0 ? 0 : 1;
