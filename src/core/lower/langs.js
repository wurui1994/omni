// src/core/lower/langs.js —— **语言的登记处**（名字 · 语法 · 映射 · 文件名后缀）
//
// 现在十一格：十门语言 + 一门方言（gsl-shell —— 它的语法是 `(extends "../lua/lua.grammar")`
// 加两条产生式，所以在这张表里它与别人**一样是一门**，没有"方言"那一栏）。
//
// 为什么单开一份：加一门语言只改**这一处**（语法 · adapter · 后缀）。抄两份的话其中一处
// 一定会忘 —— 这条教训在图那一层的 `cases.js` 上已经交过一次学费（两份例子表分叉）。
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
// 一门语言能不能跑某个例子，是它的 adapter 与公共降级器说的事，不是这儿声明的。
// 声明一栏"支持哪些特性"就等于给自己开一处会过期的账（见设计文档里那几次教训）。

import { OmniError } from '../source/diag.js';
/* "镜像在哪儿"这一格由宿主答（封闭 ABI 的 `js_install_dir`）—— 见 `treeRoot()` 那段账。 */
import { installDir, exists } from '../host/native.js';

import { GO_RT } from '../../../ext/go/go-rt.js';
/* **迁过来的那几门**（ADR-0044）：`toIR` 是 adapter（CST → 标准 IR），语义降级走
   `src/core/lower/`。有 `toIR` 的语言**没有** `toGraph` —— 图那一层不再有它。 */
import { awkToIR, AWK_HOOKS } from '../../../ext/awk/adapter.js';
import { chezToIR } from '../../../ext/chez/adapter/index.js';
import { sbclToIR } from '../../../ext/sbcl/adapter/index.js';
import { fbToIR } from '../../../ext/freebasic/adapter/index.js';
import { mojoToIR } from '../../../ext/mojo/adapter/index.js';
import { cppToIR } from '../../../ext/cpp/adapter/index.js';
import { nimToIR, nimImports } from '../../../ext/nim/adapter/index.js';
import { vlangToIR, vlangImports } from '../../../ext/vlang/adapter/index.js';
import { goToIR, goImports } from '../../../ext/go/adapter/index.js';

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
/**
 * 这棵树的根。**从宿主那格 `installDir()` 往上找标志文件**（`package.json` / `.git`）——
 * 从前这儿直接读 `import.meta.url`，而那一格在自编译轴上是一条硬错
 * （`import.meta is not supported`：它不在这门语言的子集里）。宿主那一格是封闭 ABI 的
 * `js_install_dir`，两代产物各自答得出来 —— 于是这一份跟着编译器被降级时也说得通。
 *
 * **按布局认，不数层数**（2026-09-22 改的一个真错，与 `host/cache.js` 的 `treeRoot()`
 * 同一条规矩）：从前这儿是"往上 pop 三格"（照 `src/core/host` 数出来的），于是
 *   node src/cli.js  installDir = <repo>/src/core/host -> <repo>          ✓
 *   dist/omni        installDir = <repo>/dist          -> <repo> 的上一级 ✗
 * 症状是原生那一代 `./dist/omni build x.go` 报
 * `ENOENT: …/Train/ext/go/go.grammar`（少了 `Omni/` 那一节）。往上找标志文件两种布局都停在
 * `<repo>` 上，于是**在仓库里跑的那份 dist 产物也认得语法文件**。
 *
 * 找不着标志文件（真装到 `/usr/local/bin` 的样子）就退回老办法 —— 那一档的语法文件该由
 * "产物怎么装"那一格摆进 `share/`（与 runtime/ 和 lib/ 一样，见 `host/data.js`），
 * 不是这儿的事。
 */
export function treeRoot() {
  let d = installDir();
  for (let i = 0; i < 8; i++) {
    if (exists(`${d}/package.json`) || exists(`${d}/.git`)) return d;
    const parts = d.split('/');
    if (parts.length <= 1) break;
    parts.pop();
    const up = parts.join('/');
    if (up === d || up === '') break;
    d = up;
  }
  const parts = installDir().split('/');
  parts.pop();            // host
  parts.pop();            // core
  parts.pop();            // src
  return parts.join('/');
}

/**
 * 一门语言一格：`grammar` 是相对这棵树根的路径，`exts` 是它的源文件后缀
 * （不带点，`exts[0]` 就是例子文件用的那个）。`guess: false` = 那些后缀**不参与按文件名猜**。
 *
 * **降级那一格有两种**（ADR-0044 迁移期里两者并存）：
 *   * `toIR` + `hooks` —— 迁完了的那几门：CST → 标准 IR，语义降级走 `src/core/lower/`
 *     那一份公共降级器（默认、也是唯一的一条路）。
 *   * `toGraph` —— 还没迁的那几门：CST → 节点图 → `backend-core.js` → `.sx`。
 * 一门语言只该有其中一格。`toIR` 一落地，那门语言的 `tograph.js` 当场删掉 ——
 * 留着就是"两条路各自一套"，而那正是这一版要去掉的东西。
 */
export const LANGS = new Map([
  ['chez', { grammar: 'ext/chez/chez.grammar', toIR: chezToIR, exts: ['ss', 'scm'] }],
  ['sbcl', { grammar: 'ext/sbcl/sbcl.grammar', toIR: sbclToIR, exts: ['lisp', 'cl'] }],
  /* **lua 与 gsl-shell 不在这张表里了**（ADR-0044，2026-09-22）：
     `.lua` 的主人是那台字节码 VM + tier1 JIT（`src/lang/lua.js` 那格插件，ADR-0037 的
     `#lang gsl-shell` 也归它），比这边的映射全得多 —— `omni run x.lua` 走的一直是它。
     图那一层里那份 `ext/lua/tograph.js`（476 行）与 `ext/gsl-shell/tograph.js`（17 行，
     代理 lua）是**第二份实现**，而且在 HEAD 上就是红的（`lua->graph: 这一格还没接：sumto`、
     gsl-shell 的语法在图那条路上炸）。所以它们跟着这一版直接删掉，不补 adapter：
     一门语言有自己的前端时，"借来"那条路不该再有它。 */
  /* `imports` 是**可选**的一格（第一百五十一片第二格）：这门语言答"这份文件 import 了什么"。
     给了它，驱动那一层就能把**同目录下的同语言文件**真的读进来（`run.js` 的 `graphOf`）；
     不给就是老样子（import 那一行由映射自己丢掉 —— 标准库那几格靠映射接）。
     知识按语言分：驱动不认识 go 的 `(import (path "…"))` 与 nim 的 `(import (name …))`。 */
  ['go', {
    grammar: 'ext/go/go.grammar', toIR: goToIR, imports: goImports, exts: ['go'], jsRuntime: GO_RT,
  }],
  ['vlang', {
    grammar: 'ext/vlang/vlang.grammar', toIR: vlangToIR, imports: vlangImports, exts: ['v'],
  }],
  ['awk', {
    grammar: 'ext/awk/awk.grammar', toIR: awkToIR, hooks: AWK_HOOKS, exts: ['awk'],
  }],
  ['freebasic', { grammar: 'ext/freebasic/freebasic.grammar', toIR: fbToIR, exts: ['bas', 'bi'] }],
  ['mojo', { grammar: 'ext/mojo/mojo.grammar', toIR: mojoToIR, exts: ['mojo'] }],
  ['nim', {
    grammar: 'ext/nim/nim.grammar', toIR: nimToIR, imports: nimImports, exts: ['nim'],
  }],
  ['cpp', { grammar: 'ext/cpp/cpp.grammar', toIR: cppToIR, exts: ['cpp', 'cc', 'cxx', 'hpp'] }],
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
