// src/core/graph/langs.js —— **语言的登记处**（名字 · 语法 · 映射 · 文件名后缀）
//
// 现在十一格：十门语言 + 一门方言（gsl-shell —— 它的语法是 `(extends "../lua/lua.grammar")`
// 加两条产生式，所以在这张表里它与别人**一样是一门**，没有"方言"那一栏）。
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
// 于是多出一栏 `guess: false`：那门语言的源文件**确实**是这个后缀（例子文件要按它命名），
// 但它**不参与按后缀猜**（gsl-shell 就是这一格：`.lua` 归 lua，gsl-shell 只能 `--lang` 点名）。
//
// ## 这张表里**没有**"能力"这一栏
//
// 一门语言能不能跑某个例子，是它的 `tograph.js` 与图那一层说的事，不是这儿声明的。
// 声明一栏"支持哪些特性"就等于给自己开一处会过期的账（见设计文档里那几次教训）。

import { OmniError } from '../source/diag.js';
/* "镜像在哪儿"这一格由宿主答（封闭 ABI 的 `js_install_dir`）—— 见 `treeRoot()` 那段账。 */
import { installDir } from '../host/native.js';
import { chezToGraph } from '../../../ext/chez/tograph.js';
import { luaToGraph } from '../../../ext/lua/tograph.js';
import { gslShellToGraph } from '../../../ext/gsl-shell/tograph.js';
import { goToGraph } from '../../../ext/go/tograph.js';
import { sbclToGraph } from '../../../ext/sbcl/tograph.js';
import { vlangToGraph } from '../../../ext/vlang/tograph.js';
import { awkToGraph } from '../../../ext/awk/tograph.js';
import { fbToGraph } from '../../../ext/freebasic/tograph.js';
import { mojoToGraph } from '../../../ext/mojo/tograph.js';
import { nimToGraph } from '../../../ext/nim/tograph.js';
import { cppToGraph } from '../../../ext/cpp/tograph.js';

/**
 * 这棵树的根。**从宿主那格 `installDir()` 走上去**（`src/core/host` 往上三层）——
 * 从前这儿直接读 `import.meta.url`，而那一格在自编译轴上是一条硬错
 * （`import.meta is not supported`：它不在这门语言的子集里）。宿主那一格是封闭 ABI 的
 * `js_install_dir`，两代产物各自答得出来 —— 于是这一份跟着编译器被降级时也说得通。
 *
 * 明写一格边界：原生那一代的 `installDir()` 回的是**可执行文件所在目录**，布局与源码树
 * 不一样，所以那时候 `ext/*.grammar` 不在这条相对路径上 —— 那是"产物怎么装"的另一笔账
 * （与 runtime/ 和 lib/ 一样），不是这一格的事。
 */
export function treeRoot() {
  const parts = installDir().split('/');
  parts.pop();            // host
  parts.pop();            // core
  parts.pop();            // src
  return parts.join('/');
}

/**
 * 一门语言一格：`grammar` 是相对这棵树根的路径，`toGraph` 是那门语言的映射，
 * `exts` 是它的源文件后缀（不带点，`exts[0]` 就是例子文件用的那个）。
 * `guess: false` = 那些后缀**不参与按文件名猜**（见文件头）。
 */
export const LANGS = new Map([
  ['chez', { grammar: 'ext/chez/chez.grammar', toGraph: chezToGraph, exts: ['ss', 'scm'] }],
  ['sbcl', { grammar: 'ext/sbcl/sbcl.grammar', toGraph: sbclToGraph, exts: ['lisp', 'cl'] }],
  ['lua', { grammar: 'ext/lua/lua.grammar', toGraph: luaToGraph, exts: ['lua'] }],
  // 方言：语法是"继承 lua 那份 + 两条产生式"（`(extends …)`，见 glr/load.js），
  // 映射一个字不改地借 lua 的。后缀仍是 `.lua`，但**不参与猜** —— 只能 --lang 点名。
  // 量出来的账面（`/Users/wurui/Train/gsl-shell` 那 186 份 .lua）：拿 lua 的语法 139/186，
  // 加两条产生式 176/186，再叠上那一格词法（LuaJIT 的 `1i`）**186/186**。
  ['gsl-shell', {
    grammar: 'ext/gsl-shell/gsl-shell.grammar', toGraph: gslShellToGraph,
    exts: ['lua'], guess: false, extends: 'lua',
  }],
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
    if (d.guess === false) continue;      // 有后缀但不参与猜（gsl-shell 的 `.lua`）
    for (const e of d.exts) {
      const had = m.get(e);
      if (had !== undefined) throw new Error(`langs.js: 后缀 .${e} 被 ${had} 与 ${name} 抢了 —— 一个后缀只许登记在一门语言上`);
      m.set(e, name);
    }
  }
  return m;
})();

/**
 * 只能靠 `--lang` 点名的那几门（后缀被别人占着）。**它是算出来的**，不是第二张表 ——
 * 原来这儿有一张 `DIALECTS`（gsl-shell 借 lua 的语法读），那张表在方言机制落地那天就
 * 该没了：现在 gsl-shell 是 `LANGS` 里真的一门（自己的语法 `(extends "../lua/lua.grammar")`
 * + 两条短 lambda 产生式），"方言"这件事整个落在语法 DSL 里，登记处不必再知道。
 */
export const BY_NAME_ONLY = [...LANGS].filter(([, d]) => d.guess === false).map(([n]) => n);

/**
 * 按"用户敲的 --lang"与"文件名后缀"定这一份源码归哪门语言。**--lang 优先**：
 * 后缀最多只是默认（`.lua` 既可能是 lua 也可能是 gsl-shell，见文件头）。
 * 两样都说不出来就报一句带清单的错 —— 不猜。
 */
export function pickLang(path, want) {
  if (want !== null && want !== undefined && want !== '') {
    const d = LANGS.get(want);
    if (d === undefined) {
      throw new OmniError(`没有 --lang ${want} 这一门 —— 认得的是：${[...LANGS.keys()].join(' ')}`
        + `（其中 ${BY_NAME_ONLY.join(' ')} 只能这么点名，后缀归别人）`);
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
