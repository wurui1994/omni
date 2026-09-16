// src/core/graph/langs.js —— **十门语言的登记处**（名字 · 语法 · 映射 · 文件名后缀）
//
// 为什么单开一份：这张表原来只长在 `tests/graph/cases.js` 里，可它现在有**两个消费者** ——
// 测试矩阵与 `omni run --engine graph`。抄两份的话，加一门语言要改两处，而其中一处一定会忘
// （这条教训在 cases.js 文件头上已经写过一次，那次是 run.js 与 delete.js 共用一张例子表）。
//
// ## 后缀这一栏不是"这门语言的所有后缀"，是"我按后缀能猜到哪一门"
//
// `.lua` 是最清楚的例子：lua 与 gsl-shell 用同一个后缀，源码也几乎同形。按后缀猜必然猜错一半，
// 所以后缀只是**默认**，`--lang` 一给就盖过它（`omni run x.lua --lang gsl-shell`）。
// 一个后缀只许登记在一门语言上（下面 `EXTS` 建表时撞了就当场报错）—— 猜得含糊比报错糟。
//
// ## 这张表里**没有**"能力"这一栏
//
// 一门语言能不能跑某个例子，是它的 `tograph.js` 与图那一层说的事，不是这儿声明的。
// 声明一栏"支持哪些特性"就等于给自己开一处会过期的账（见设计文档里那几次教训）。

import { OmniError } from '../source/diag.js';
import { chezToGraph } from '../../../ext/chez/tograph.js';
import { luaToGraph } from '../../../ext/lua/tograph.js';
import { goToGraph } from '../../../ext/go/tograph.js';
import { sbclToGraph } from '../../../ext/sbcl/tograph.js';
import { vlangToGraph } from '../../../ext/vlang/tograph.js';
import { awkToGraph } from '../../../ext/awk/tograph.js';
import { fbToGraph } from '../../../ext/freebasic/tograph.js';
import { mojoToGraph } from '../../../ext/mojo/tograph.js';
import { nimToGraph } from '../../../ext/nim/tograph.js';
import { cppToGraph } from '../../../ext/cpp/tograph.js';

/**
 * 这棵树的根（`src/core/graph/langs.js` 往上三层）。
 * 走的是 `installDir()` 那一手（`import.meta.url` 切到目录），不引 `node:path` ——
 * 这一份要能跟着编译器自己被降级。
 */
export function treeRoot() {
  const url = import.meta.url;
  const p = url.startsWith('file://') ? decodeURIComponent(url.slice('file://'.length)) : url;
  const parts = p.split('/');
  parts.pop();            // langs.js
  parts.pop();            // graph
  parts.pop();            // core
  parts.pop();            // src
  return parts.join('/');
}

/**
 * 一门语言一格：`grammar` 是相对这棵树根的路径，`toGraph` 是那门语言的映射，
 * `exts` 是"按文件名能猜到它"的后缀（不带点）。
 */
export const LANGS = new Map([
  ['chez', { grammar: 'ext/chez/chez.grammar', toGraph: chezToGraph, exts: ['ss', 'scm'] }],
  ['sbcl', { grammar: 'ext/sbcl/sbcl.grammar', toGraph: sbclToGraph, exts: ['lisp', 'cl'] }],
  ['lua', { grammar: 'ext/lua/lua.grammar', toGraph: luaToGraph, exts: ['lua'] }],
  ['go', { grammar: 'ext/go/go.grammar', toGraph: goToGraph, exts: ['go'] }],
  ['vlang', { grammar: 'ext/vlang/vlang.grammar', toGraph: vlangToGraph, exts: ['v'] }],
  ['awk', { grammar: 'ext/awk/awk.grammar', toGraph: awkToGraph, exts: ['awk'] }],
  ['freebasic', { grammar: 'ext/freebasic/freebasic.grammar', toGraph: fbToGraph, exts: ['bas', 'bi'] }],
  ['mojo', { grammar: 'ext/mojo/mojo.grammar', toGraph: mojoToGraph, exts: ['mojo'] }],
  ['nim', { grammar: 'ext/nim/nim.grammar', toGraph: nimToGraph, exts: ['nim'] }],
  ['cpp', { grammar: 'ext/cpp/cpp.grammar', toGraph: cppToGraph, exts: ['cpp', 'cc', 'cxx', 'hpp'] }],
]);

/** 后缀 -> 语言名。**一个后缀只许有一门** —— 撞了当场报，不许悄悄挑一个。 */
export const EXTS = (() => {
  const m = new Map();
  for (const [name, d] of LANGS) {
    for (const e of d.exts) {
      const had = m.get(e);
      if (had !== undefined) throw new Error(`langs.js: 后缀 .${e} 被 ${had} 与 ${name} 抢了 —— 一个后缀只许登记在一门语言上`);
      m.set(e, name);
    }
  }
  return m;
})();

/**
 * **方言**：与某一门共用语法与映射，但有自己的名字 —— 只能靠 `--lang` 点名（没有后缀）。
 *
 * gsl-shell 是这一格的来由，也是"按后缀猜必然猜错"那句话的出处：它与 lua 用同一个 `.lua`。
 * 现状是量出来的（`/Users/wurui/Train/gsl-shell` 那 186 份 .lua，用 lua 的语法过一遍）：
 * **139/186 过**，没过的 47 份里 41 份是同一件事 —— gsl-shell 的**短 lambda** `|x| expr`
 * （LuaJIT 那一支加的），lua 里没有这个写法。
 *
 * 为什么不把 `|x| expr` 加进 `lua.grammar`：那会让 lua 接受它自己没有的写法（假接受比报错坏）。
 * 为什么不给 gsl-shell 单开一份语法：那要把 lua 那 113 条产生式抄一遍，而"抄两份就是两套
 * 语义"是这棵树上反复吃过的教训。**正解是给语法 DSL 一格"方言"机制**（继承一份语法 +
 * 加几条产生式），那是一笔记在账上的欠款；在它之前，`--lang gsl-shell` 就是"按 lua 读"，
 * 撞上短 lambda 会**干净地报语法错**（不猜、不假接受）。
 */
export const DIALECTS = new Map([
  ['gsl-shell', { of: 'lua', note: 'gsl-shell 与 lua 共用一份语法：短 lambda `|x| expr` 还没接（它的语料 139/186 过）' }],
]);

/**
 * 按"用户敲的 --lang"与"文件名后缀"定这一份源码归哪门语言。**--lang 优先**：
 * 后缀最多只是默认（`.lua` 既可能是 lua 也可能是 gsl-shell，见文件头）。
 * 两样都说不出来就报一句带清单的错 —— 不猜。
 */
export function pickLang(path, want) {
  if (want !== null && want !== undefined && want !== '') {
    const dia = DIALECTS.get(want);
    if (dia !== undefined) {
      // 方言：语法与映射借基准那一门的，名字仍是它自己的（报错里要认得出是谁）
      return { name: want, ...LANGS.get(dia.of), dialectOf: dia.of, note: dia.note };
    }
    const d = LANGS.get(want);
    if (d === undefined) {
      throw new OmniError(`没有 --lang ${want} 这一门 —— 认得的十门是：${[...LANGS.keys()].join(' ')}`
        + `；方言：${[...DIALECTS.keys()].join(' ')}`);
    }
    return { name: want, ...d };
  }
  const dot = String(path).lastIndexOf('.');
  const ext = dot < 0 ? '' : String(path).slice(dot + 1);
  const name = EXTS.get(ext);
  if (name === undefined) {
    throw new OmniError(`.${ext} 这个后缀不认得（要么用 --lang 说清）—— 认得的后缀：`
      + `${[...EXTS.keys()].map((e) => `.${e}`).join(' ')}`);
  }
  return { name, ...LANGS.get(name) };
}
