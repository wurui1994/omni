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
import { JNC_BUILTINS } from '../../src/lang/jnc/builtins.js';
import { moduleIndex, moduleNames } from '../../src/lang/jnc/modules.js';
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
/* 导入这一族在**外面**解（`modules.js`）：名字从前奏那一层进来，核心一行不用改。
   `--no-import` 可以关掉它 —— 上一版的数就是那么量的，两边一比才看得出这一刀值多少。 */
const noImport = argv.includes('--no-import');
const index = noImport ? new Map() : moduleIndex([CORPUS]);
const modCache = new Map();
const parseFile = (p) => jncParse(tb, p, new Diagnostics());
let archives = 0;
let missing = 0;

let ran = 0;
let scopes = 0;
let decls = 0;
let local = 0;
let env = 0;
let envHere = 0;
let envAway = 0;
const envTop = new Map();
const hereTop = new Map();
const hereAt = new Map();
const ctxErrs = new Map();
const boom = [];

for (const f of files) {
  let tree = null;
  try { tree = jncParse(tb, f, new Diagnostics()); } catch { continue; }
  const rel = f.slice(CORPUS.length + 1);
  let out;
  try {
    let prelude = JNC_BUILTINS;
    if (!noImport) {
      const mod = moduleNames(f, { index, parse: parseFile, cache: modCache });
      archives += mod.archives.length;
      missing += mod.missing.length;
      prelude = [...JNC_BUILTINS, ...mod.names];
    }
    out = bind({ stats: normalize(tree) }, jncSemLang, { prelude });
  } catch (err) {
    boom.push([rel, err.message]);
    continue;
  }
  ran += 1;
  scopes += out.scopes.length;
  decls += out.decls.length;
  /* 答不上的名字**分两类**，这一分决定下一刀往哪儿切：
       甲 这份文件里明明声明过它（只是查不到那一层）—— 那是配方/链的问题，我能修；
       乙 这份文件里压根没有 —— 跨文件（import、基类、内建），要等导入表与成员表。 */
  const inFile = new Set(out.decls.map((d) => d.name));
  for (const u of out.uses) {
    if (u.found === 'local') { local += 1; continue; }
    env += 1;
    if (inFile.has(u.name)) {
      envHere += 1;
      hereTop.set(u.name, (hereTop.get(u.name) ?? 0) + 1);
      if (!hereAt.has(u.name)) hereAt.set(u.name, `${rel}:${u.node?.line ?? '?'}`);
    } else {
      envAway += 1;
      envTop.set(u.name, (envTop.get(u.name) ?? 0) + 1);
    }
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
if (!noImport) {
  console.log(`导入：搜索路径里 ${index.size} 个名字　打不开的归档 ${archives} 处（.jncx，记账）`
    + `　找不着的 ${missing} 处`);
}

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
  console.log(`\n答不上的分两类：**文件里有、只是查不到那一层** ${envHere} 处`
    + `　跨文件（import / 基类 / 内建）${envAway} 处`);
  if (envHere > 0) {
    const top = [...hereTop].sort((a, b) => b[1] - a[1]).slice(0, all ? 40 : 10);
    console.log('  文件里有的（这一类我能修，照头一处去看）：');
    for (const [n, c] of top) console.log(`    ${String(c).padStart(5)}  ${n}　头一处：${hereAt.get(n)}`);
  }
  const away = [...envTop].sort((a, b) => b[1] - a[1]).slice(0, all ? 60 : 15);
  console.log(`  跨文件的（等导入表与成员表）：${away.map(([n, c]) => `${n}×${c}`).join('  ')}`);
}
/* 闸门只管甲与丙：乙那一格是明账，不许拿它当红灯，也不许假装它绿。
   **账的分类是量出来的，不是猜的**（`--all` 看全）：
     - 头一刀之前"文件里有、只是查不到那一层"是 13402 处，一处实样（01_Classes.jnc）说明
       全是**体外定义**（`C1.construct(…) { m_x = x; }` 的体在文件顶层）。补上 `in-owner:`
       之后掉到 270 处，查名自解 42.6% → 64.2%。
     - 剩的 270 处里 41 处 `m_count` 在 stdt_Array.jnc：那是**泛型的头**（`class Array<T> {}`
       的名字那一格是 `tinst`），`namesOf` 少一条，于是 `Array` 压根没绑上、体外定义也认不回来。
       补上之后 126 处、64.6%。（先补 `ownerOf` 那一头**量出来一格没动** —— 记着，
       错的一头补了不算数。）
     - 现在剩的 126 处分三族，都还欠机制：继承来的成员（`m_x`，要往基类那一层查）、
       体外定义里的**泛型参数**（`Map<Key, Value>.f()` 里的 Key/Value）、扩展命名空间（`foo`）。
     - 跨文件那 21306 处（io / ui / size_t / printf 那几族）要导入表，不是这张表的活儿。 */
process.exitCode = boom.length === 0 && ctxErrs.size === 0 ? 0 : 1;
