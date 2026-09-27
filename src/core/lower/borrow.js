// src/core/lower/borrow.js —— 借来的那门语言**用到才装**（node 源码腿那一份）
//
// 登记处（`langs.js`）只有**数据**：一门语言叫什么、语法在哪、认哪些后缀、adapter 是哪份
// 文件、要从那份文件里取哪几个导出。**代码**在这儿装 —— 而且只装被问到的那一门。
// 取导出 + 核对 + 记住那一套机制在 `borrow-core.js`（两条腿共用），这一份只提供"怎么装"。
//
// 为什么要这一格（量到的账，见 `docs/design/on-demand-loading.md`）：从前 `langs.js` 有
// 十三条 `import … from '../../../ext/…/adapter…'`，于是跑一行 `print(1)` 也要把 chez、
// sbcl、go、vlang、awk、freebasic、mojo、nim、cpp、polydraw、evaldraw 十二门别的语言的
// adapter 全装进来 —— 逐条量出来 **134.7ms**，而 `run --mode js` 一份 `.py` 一格都用不到。
// 除了慢还有一笔更要紧的：核心静态 import 了 `ext/`，于是 ext 里一份文件用了 `node:fs`
// 就能把自编译轴（`npm run check:self`）弄红（真发生过，`ext/python/adapter/pylib.js`）。
// 方向该是单向的 —— **扩展 import 核心，核心不认识它们**（ADR-0030 第 4 节）。
//
// **同步装**是靠 `createRequire`：node 22.12 起 `require()` 能装没有顶层 await 的 ESM，
// 我们所有模块都满足。刻意**不用** `import()` —— 那是异步的，会把 `pickLang` / `sxTextOf` /
// `runCli` 这条同步链整条染成 async，而我们自己的 JS 前端还明着拒动态 import
// （`the module graph is fixed at link time`）。这条与 `lang/builtin.js` 的迟装同一条路子。
//
// 这一份只给**从源码跑的那条腿**（node）：它 import `node:module`，我们自己的前端不认。
// 编产物时由 `cli.js` 的 `readModule` 换成 `borrow-fat.js`（十三条静态 import，产物里
// 一格不少）—— 规则在 `borrow-pick.js`，接缝与 `lang/builtin-pick.js` 同构。

import { createRequire } from 'node:module';
import { pickRt } from './borrow-core.js';
import { OmniError } from '../source/diag.js';

const require_ = createRequire(import.meta.url);

/** 装过的那几门（一门只装一次）。键是语言名。 */
const MEM = new Map();

/**
 * 登记处那一行 -> 这门语言的运行时那半（`{ toIR, hooks?, imports?, pre? }`）。
 *
 * 一趟 `omni` 里同一门会被问好几次（`emit sx` + `run` 那种嵌套、`--pkgs` 多份源文件），
 * 所以记住。**普通函数 + 模块级 Map**，不是"造一格带缓存的闭包" —— 返回闭包那一格不在
 * 这门语言的子集里（踩过：产物腿 `undefined is not a function`，见 `borrow-core.js` 文件头）。
 */
export function borrowRt(lang) {
  const hit = MEM.get(lang.name);
  if (hit !== undefined) return hit;
  /* 路径**相对这一份文件**算（`../../../` 就是树根，与 `langs.js` 里从前那些
     `'../../../ext/…'` 逐字一致）—— 不走 `treeRoot()`：那一格认的是布局，而 js-roundtrip
     会把整棵树重新生成到 `.omni-build/` 下（那儿没有 package.json / .git）。 */
  const rt = pickRt(lang, require_(`../../../${lang.adapter}`));
  MEM.set(lang.name, rt);
  return rt;
}

/** `{ adapter, name }` 那两格（`units` / `runFallback`）装过的模块（键是 adapter 路径）。 */
const SPEC_MEM = new Map();

/**
 * 登记处那一行的 `{ adapter, name }` 一格 -> 那一个导出（`units` / `runFallback`）。
 * 与 `borrowRt` 同一条路子：用到才装（装过的记住），名字对不上当场抛；
 * 路径同样**相对这一份文件**算，理由见上头 `borrowRt` 那段。
 */
export function borrowOne(spec) {
  let mod = SPEC_MEM.get(spec.adapter);
  if (mod === undefined) {
    mod = require_(`../../../${spec.adapter}`);
    SPEC_MEM.set(spec.adapter, mod);
  }
  const v = mod[spec.name];
  if (v === undefined) {
    throw new OmniError(`${spec.adapter} 里没有 '${spec.name}' 这个导出 —— 登记处与代码走散了`);
  }
  return v;
}
