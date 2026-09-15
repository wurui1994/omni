// ext/gsl-shell/tests/formula.js —— 公式子语言的尺子：**拿 gsl-shell 自己的解析器对账**
//
// `expr-parse.lua` 的 `actions` 是个参数（它自己就把"语法"与"拿语法干什么"分开了），
// 所以尺子可以这么搭：**语法判断全交给他们的解析器**，动作换成一套中立的、只把树写成
// 规范 S 表达式的动作。于是分歧只可能出在"我的表对不对"上。
//
// 两问：
//   甲 收不收 + 树长什么样：我的 parse → 规范式　vs　他们的 parse（中立动作）→ 规范式
//   乙 写回去幂等：`render(parse(s))` 再 parse 再 render，两次逐字相同
//
// 例子来自两处（都不是手写清单）：
//   1. **语料**：gsl-shell 自己的 `.lua` 与 `doc/**.rst` 里所有带 `~` 的字符串字面量
//   2. **生成**：节点表 × 每个洞 × 那类洞的每个成员（与 ext/lua/tests/gen.js 同一套办法）
//
// 用法：node ext/gsl-shell/tests/formula.js [--show]

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse, ParseError } from '../../../src/core/frontend-engine/parse-driver.js';
import { render } from '../../../src/core/frontend-engine/render.js';
import { LexError } from '../../../src/core/frontend-engine/lexrules.js';
import { formulaLang } from '../formula.js';
import { holesOf } from '../../../src/core/frontend-engine/language.js';
import { refDir } from '../../../tests/lib/refsrc.js';

const GSL = refDir('gsl-shell', 'GSL_SRC');
const show = process.argv.includes('--show');
const lang = formulaLang;

// ── 规范式：两边都写成同一种 S 表达式 ────────────────────────────────────────
const num = (x) => String(Number(x));

function canon(n) {
  switch (n.kind) {
    case 'ident': return `(id ${n.value})`;
    case 'number': return `(num ${num(n.value)})`;
    case 'literal': return `(lit ${n.value})`;
    case 'enum-ref': return `(enum ${n.name})`;
    case 'func-eval': return `(call ${n.func} ${canon(n.arg)})`;
    case 'paren': return canon(n.inner);            // 他们的 AST 里没有括号节点
    case 'prefix': return `(${n.op} ${canon(n.a)})`;
    case 'binop': return `(${n.op} ${canon(n.a)} ${canon(n.b)})`;
    default: throw new Error(`canon：不认得 ${n.kind}`);
  }
}

const list = (xs) => `[${(xs ?? []).map(canon).join(' ')}]`;

function canonTop(n) {
  if (n.kind !== 'schema' && n.kind !== 'schema-multi') return canon(n);
  const ys = n.kind === 'schema' ? [n.y] : n.y;
  const enums = (n.enums ?? []).map((e) => `(id ${e})`).join(' ');
  return `(schema y=${list(ys)} x=${list(n.x)} enums=[${enums}] conds=${list(n.conds)})`;
}

// ── 他们那把尺子（一次 luajit 调用问一批）────────────────────────────────────
const ORACLE = String.raw`
package.path = '${GSL}/?.lua;' .. package.path
local ep = require 'expr-parse'
local A = {
  infix     = function(sym, a, b) return '(' .. sym .. ' ' .. a .. ' ' .. b .. ')' end,
  prefix    = function(sym, a) return '(' .. sym .. ' ' .. a .. ')' end,
  enum      = function(id) return '(enum ' .. id .. ')' end,
  func_eval = function(f, arg) return '(call ' .. f .. ' ' .. arg .. ')' end,
  ident     = function(id) return '(id ' .. id .. ')' end,
  literal   = function(x) return '(lit ' .. x .. ')' end,
  number    = function(x) return '(num ' .. tostring(x) .. ')' end,
  exprlist  = function(a, ls) if ls then ls[#ls+1] = a else ls = {a} end return ls end,
  schema    = function(x, y, conds, enums) return {x=x, y=y, conds=conds, enums=enums} end,
}
local function lst(t)
  local o = {}
  for i = 1, #(t or {}) do o[i] = t[i] end
  return '[' .. table.concat(o, ' ') .. ']'
end
local function top(r)
  if type(r) == 'string' then return r end
  local ys = type(r.y) == 'table' and lst(r.y) or ('[' .. r.y .. ']')
  return '(schema y=' .. ys .. ' x=' .. lst(r.x) .. ' enums=' .. lst(r.enums)
    .. ' conds=' .. lst(r.conds) .. ')'
end
for line in io.lines() do
  local start, s = line:match('^(%S+)\t(.*)$')
  local ok, r = pcall(function()
    if start == 'schema' then return ep.schema(s, A, true)
    elseif start == 'schema-multi' then return ep.schema_multivar(s, A)
    else return ep.expr(s, A) end
  end)
  if ok then
    local ok2, t = pcall(top, r)
    print(ok2 and t or 'ERR 规范式炸了')
  else
    print('ERR')
  end
end
`;

/** 脚本用 `-e` 传、公式从 stdin 喂（luajit 从 stdin 读脚本时 io.lines 就没东西可读了）。 */
function askOracleAll(cases) {
  const input = cases.map((c) => `${c.start}\t${c.src.replace(/[\n\r]/g, ' ')}`).join('\n');
  const out = execFileSync('luajit', ['-e', ORACLE], { input, encoding: 'utf8' });
  return out.trimEnd().split('\n');
}

// ── 例子来源一：语料里所有带 `~` 的字符串 ────────────────────────────────────
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (e.endsWith('.lua') || e.endsWith('.rst')) out.push(p);
  }
  return out;
}

function harvest() {
  const got = new Map();
  for (const f of walk(GSL)) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/(['"])([^'"\n]*~[^'"\n]*)\1/g)) {
      const s = m[2].trim();
      if (s === '' || !/[A-Za-z_[]/.test(s[0])) continue;      // `~=` 之类不是公式
      if (s.includes('~=')) continue;
      const start = s.split('~')[0].includes(',') ? 'schema-multi' : 'schema';
      if (!got.has(s)) got.set(s, { what: `语料 ${f.slice(GSL.length + 1)}`, src: s, start });
    }
  }
  return [...got.values()];
}

// ── 例子来源二：从节点表生成 ─────────────────────────────────────────────────
const MINI = {
  ident: () => ({ kind: 'ident', value: 'a' }),
  number: () => ({ kind: 'number', value: '2' }),
  literal: () => ({ kind: 'literal', value: 'L' }),
  'enum-ref': () => ({ kind: 'enum-ref', name: 'e' }),
  'func-eval': () => ({ kind: 'func-eval', func: 'f', arg: { kind: 'ident', value: 'b' } }),
  paren: () => ({ kind: 'paren', inner: { kind: 'number', value: '3' } }),
  prefix: () => ({ kind: 'prefix', op: '-', a: { kind: 'ident', value: 'c' } }),
  binop: () => ({ kind: 'binop', op: '+', a: { kind: 'ident', value: 'p' }, b: { kind: 'number', value: '1' } }),
  schema: () => ({ kind: 'schema', y: MINI.ident(), x: [MINI.ident()] }),
  'schema-multi': () => ({ kind: 'schema-multi', y: [MINI.ident()], x: [MINI.ident()] }),
};

function generated() {
  const out = [];
  for (const n of lang.nodes) {
    const holes = holesOf(n);
    const top = n.of === 'top' ? n.name : 'schema';
    const mk = (node) => (n.of === 'top' ? node : { kind: 'schema', y: MINI.ident(), x: [node] });
    if (holes.length === 0) { out.push({ what: n.name, node: mk(MINI[n.name]()), start: top }); continue; }
    for (const h of holes) {
      for (const m of lang.membersOf(h.cls)) {
        const node = MINI[n.name]();
        const filler = MINI[m]();
        node[h.name] = h.list === true ? [filler] : filler;
        out.push({ what: `${n.name}.${h.name}=${m}`, node: mk(node), start: top });
      }
    }
    // 可选组（`| enums` 与 `: conds`）也各来一个
    if (n.of === 'top') {
      const a = MINI[n.name]();
      a.enums = ['e1', 'e2'];
      out.push({ what: `${n.name} + enums`, node: a, start: top });
      const b = MINI[n.name]();
      b.conds = [MINI.binop()];
      out.push({ what: `${n.name} + conds`, node: b, start: top });
    }
  }
  for (const c of out) c.src = render(c.node, lang);
  return out;
}

// ── 对账 ────────────────────────────────────────────────────────────────────
const cases = [...harvest(), ...generated()];
const mine = cases.map((c) => {
  try {
    const ast = parse(c.src, lang, c.start);
    const once = render(ast, lang);
    const twice = render(parse(once, lang, c.start), lang);
    return { v: canonTop(ast), once, idem: once === twice };
  } catch (err) {
    if (!(err instanceof ParseError) && !(err instanceof LexError)) throw err;
    return { v: 'ERR', why: err.message };
  }
});
const theirs = askOracleAll(cases);

const piles = new Map();
let same = 0;
let idem = 0;
for (const [i, c] of cases.entries()) {
  const a = mine[i].v;
  const b = (theirs[i] ?? '').trim();
  if (a === b) {
    same += 1;
    if (a === 'ERR' || mine[i].idem === true) idem += 1;
    else {
      const k = '写回去不幂等';
      if (!piles.has(k)) piles.set(k, []);
      piles.get(k).push(`${c.what}｜${c.src}`);
    }
    continue;
  }
  const key = a === 'ERR' ? `我拒它收：${mine[i].why.replace(/^\d+ 行：/, '')}`
    : b === 'ERR' ? '我收它拒'
      : '树不一样';
  if (!piles.has(key)) piles.set(key, []);
  piles.get(key).push(`${c.what}｜${c.src}｜我 ${a}｜它 ${b}`);
}

console.log(`公式子语言（${lang.name}）：语料 ${harvest().length} 条 + 生成 ${cases.length - harvest().length} 条`);
console.log(`甲 树对得上 ${same}/${cases.length}　乙 写回幂等 ${idem}/${cases.length}`);
for (const [k, v] of [...piles].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(v.length).padStart(4)}  ${k}`);
  for (const x of v.slice(0, show ? v.length : 3)) console.log(`        ${x}`);
}
process.exitCode = same === cases.length && idem === cases.length ? 0 : 1;
