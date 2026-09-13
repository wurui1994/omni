// tests/lib/jnc-scope.js —— 作用域配方的对账：**通用驱动器 + jancy 的表**跑真语料
//
// 问三件事：
//   甲  **上下文规则错没错**：语料是能编过的真代码，所以"这儿没有可以 break 出去的循环"
//       这类报错应该是 0 —— 报出来就是表里少了一格 `provides`。
//   乙  **查名查着多少**：`found: 'local'` 是这张表自己解出来的，`ENV` 是"这一层还答不上"。
//       ENV 里该有的东西：成员（`m_x` 那一族要先查 this 的类型）、import 进来的名字、
//       内建的那些（`printf` / `jnc.*`）—— 那几族要等成员表与导入表，**现在记成明账**。
//   丙  **崩没崩**：驱动器碰到表里没有的节点会当场炸，炸了就是节点表还差一格。
//
// 用法：node tests/lib/jnc-scope.js [文件数，默认 80] [--all]

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Diagnostics } from '../../src/core/source/diag.js';
import { initJnc, jncFrontEnd, jncParse } from '../../src/core/lang/jnc.js';
import { normalize } from '../../src/lang/jnc/normalize.js';
import { jncSemLang } from '../../src/lang/jnc/scope.js';
import { bind } from '../../src/core/frontend-engine/bind.js';

const EXTERNAL = '/Users/wurui/Documents/Lang/reference/jancy';
const CORPUS = existsSync(EXTERNAL) ? EXTERNAL : 'tests/jnc/cases';
const argv = process.argv.slice(2);
const limit = Number(argv.find((a) => /^\d+$/.test(a)) ?? 80);
const all = argv.includes('--all');

function walk(dir, out = []) {
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const e of names) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (e.endsWith('.jnc')) out.push(p);
  }
  return out;
}

initJnc({ log: () => {} });
const tb = jncFrontEnd();
const files = walk(CORPUS).sort().slice(0, limit);

let ran = 0;
let scopes = 0;
let decls = 0;
let local = 0;
let env = 0;
const envTop = new Map();
const ctxErrs = new Map();
const boom = [];

for (const f of files) {
  let tree = null;
  try { tree = jncParse(tb, f, new Diagnostics()); } catch { continue; }
  const rel = f.slice(CORPUS.length + 1);
  let out;
  try {
    out = bind({ stats: normalize(tree) }, jncSemLang);
  } catch (err) {
    boom.push([rel, err.message]);
    continue;
  }
  ran += 1;
  scopes += out.scopes.length;
  decls += out.decls.length;
  for (const u of out.uses) {
    if (u.found === 'local') local += 1;
    else { env += 1; envTop.set(u.name, (envTop.get(u.name) ?? 0) + 1); }
  }
  for (const e of out.errors) {
    const k = e.why;
    if (!ctxErrs.has(k)) ctxErrs.set(k, { n: 0, at: `${rel}:${e.node?.line ?? '?'}` });
    ctxErrs.get(k).n += 1;
  }
}

const uses = local + env;
console.log(`语料 ${ran}/${files.length} 份　作用域 ${scopes} 层　绑上的名字 ${decls} 个`);
console.log(`甲 上下文报错 ${[...ctxErrs.values()].reduce((a, b) => a + b.n, 0)} 处`
  + `　乙 查名 ${uses} 处：表里查着 ${local}`
  + `（${(local / Math.max(uses, 1) * 100).toFixed(1)}%）、还答不上 ${env}`
  + `　丙 炸掉的文件 ${boom.length}`);

if (ctxErrs.size > 0) {
  console.log('\n上下文报错（表里少一格 provides）：');
  for (const [why, r] of ctxErrs) console.log(`  ${String(r.n).padStart(5)}  ${why}　头一处：${r.at}`);
}
if (boom.length > 0) {
  console.log('\n炸掉的：');
  for (const [f, why] of (all ? boom : boom.slice(0, 8))) console.log(`  ${f}　${why}`);
  if (!all && boom.length > 8) console.log(`  …… 还有 ${boom.length - 8} 份（--all 全印）`);
}
if (env > 0) {
  console.log('\n还答不上的名字（明账：成员 / import / 内建那三族要等下一张表）：');
  const top = [...envTop].sort((a, b) => b[1] - a[1]).slice(0, all ? 60 : 15);
  console.log(`  ${top.map(([n, c]) => `${n}×${c}`).join('  ')}`);
}
/* 闸门只管甲与丙：乙那一格现在是明账（成员表还没有），不许拿它当红灯，也不许假装它绿。
   **那笔账查过一处实样**（samples/jnc/01_Classes.jnc）：里头的 `m_x` 全在**体外定义**里 ——
   `C1.construct(int x, int y) { m_x = x; }` 的体在文件顶层，词法链上压根没有类那一层。
   所以剩下的不是"配方漏了一步"，是真缺两张表：成员（按 `this` 的类型查）与导入
   （`io` / `ui` / `size_t` 那一族在别的文件里）。先收齐"先收齐再查"这一格只值 +0.8%，
   量出来就这样，不夸大。 */
process.exitCode = boom.length === 0 && ctxErrs.size === 0 ? 0 : 1;
