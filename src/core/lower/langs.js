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

/* 这一份**一条 `ext/` 的 import 都没有**（从前有十三条）。理由与量到的账见
 * `docs/design/on-demand-loading.md`：
 *   * 跑一行 `print(1)` 也要装十二门别的语言的 adapter —— 逐条量出来 134.7ms；
 *   * 核心静态 import `ext/` 之后，ext 里一份文件用了 `node:fs` 就能把自编译轴弄红
 *     （真发生过：`ext/python/adapter/pylib.js`）。方向该是单向的（ADR-0030 第 4 节）。
 * 于是这张表只留**数据**：叫什么、语法在哪、认哪些后缀、adapter 是哪份文件、
 * 从那份文件里取哪几个导出。**代码**由 `borrow.js` 在被问到的那一刻装（一门只装一门）。 */

/* 这棵树的根的正本在 `host/treeroot.js`（它只问宿主两句话，与语言无关，
   所以它该在 `host/` 那一层；单开一份的缘由见那边的文件头）。要它的人从那儿 import。 */

/**
 * 一门语言一格：`grammar` 是相对这棵树根的路径，`exts` 是它的源文件后缀
 * （不带点，`exts[0]` 就是例子文件用的那个）。`guess: false` = 那些后缀**不参与按文件名猜**。
 *
 * **降级那一格**（ADR-0044）：`adapter` 是那门语言的 adapter 模块（相对树根的路径），
 * `exports` 是"从它那儿取哪几个名字"：
 *   toIR      必给 —— CST → 标准 IR（语义降级走 `src/core/lower/` 那一份公共降级器）
 *   hooks     可选 —— 交给公共降级器的那几格钩子（python 只有"数组的零值"一格）
 *   imports   可选 —— 答"这份文件 import 了什么"（驱动据此读同目录的同语言文件）
 *   pre       可选 —— 词法之前的预处理（EVAL 两门的 `#define` / `#if` 那一族）
 * **这儿只写名字，不 import** —— 真装是 `borrow.js` 的事，而且只装被问到的那一门。
 * 名字对不上（adapter 里没这个导出）当场抛「登记处与代码走散了」。
 *
 * 不在"一门一个 adapter 入口"里的另有两格（R 的 libR 那一档、EVAL 两门的按单元产物），
 * 各自记成 `{ adapter, name }` —— **同样只写数据**，装载走 `borrow.js` 的 `borrowOne`：
 *   runFallback 可选 —— "编译器这一档接不住时，`omni run` 还能怎么跑"（R 是 libR 那一档）
 *   units       可选 —— 按单元产物那条路的建造者（EVAL 两门，见
 *                      `docs/design/omni-serve-studio.md` §9.3/§9.4）
 */
export const LANGS = new Map([
  ['chez', {
    grammar: 'ext/chez/chez.grammar', exts: ['ss', 'scm'],
    adapter: 'ext/chez/adapter/index.js', exports: { toIR: 'chezToIR' },
  }],
  ['sbcl', {
    grammar: 'ext/sbcl/sbcl.grammar', exts: ['lisp', 'cl'],
    adapter: 'ext/sbcl/adapter/index.js', exports: { toIR: 'sbclToIR' },
  }],
  /* **lua 与 gsl-shell 不在这张表里了**（ADR-0044，2026-09-22）：
     `.lua` 的主人是 `ext/lua` 那格扩展（`omni-ext.json` + `omni-lang.js`，ADR-0030），
     比这边的映射全得多 —— `omni run x.lua` 走的一直是它。图那一层里那份
     `ext/lua/tograph.js`（476 行）与 `ext/gsl-shell/tograph.js`（17 行，代理 lua）是
     **第二份实现**，而且在 HEAD 上就是红的（`lua->graph: 这一格还没接：sumto`、
     gsl-shell 的语法在图那条路上炸）。所以它们跟着那一版直接删掉，不补 adapter：
     一门语言有自己的前端时，"借来"那条路不该再有它。 */
  /* `imports` 是**可选**的一格（第一百五十一片第二格）：这门语言答"这份文件 import 了什么"。
     给了它，驱动那一层就能把**同目录下的同语言文件**真的读进来（`drive.js` 的 `load`）；
     不给就是老样子（import 那一行由映射自己丢掉 —— 标准库那几格靠映射接）。
     知识按语言分：驱动不认识 go 的 `(import (path "…"))` 与 nim 的 `(import (name …))`。 */
  ['go', {
    grammar: 'ext/go/go.grammar', exts: ['go'],
    adapter: 'ext/go/adapter/index.js', exports: { toIR: 'goToIR', imports: 'goImports' },
  }],
  ['vlang', {
    grammar: 'ext/vlang/vlang.grammar', exts: ['v'],
    adapter: 'ext/vlang/adapter/index.js', exports: { toIR: 'vlangToIR', imports: 'vlangImports' },
  }],
  ['awk', {
    grammar: 'ext/awk/awk.grammar', exts: ['awk'],
    adapter: 'ext/awk/adapter.js', exports: { toIR: 'awkToIR', hooks: 'AWK_HOOKS' },
  }],
  ['freebasic', {
    grammar: 'ext/freebasic/freebasic.grammar', exts: ['bas', 'bi'],
    adapter: 'ext/freebasic/adapter/index.js', exports: { toIR: 'fbToIR' },
  }],
  ['mojo', {
    grammar: 'ext/mojo/mojo.grammar', exts: ['mojo'],
    adapter: 'ext/mojo/adapter/index.js', exports: { toIR: 'mojoToIR' },
  }],
  /* python（CPython 3.16 的语法）。**这一门的类型一格都不写** —— 形参与返回类型从标注或
     调用点推、模块级变量从初值推，整个扫三轮（口径在 `ext/python/adapter/index.js` 文件头）。
     `hooks` 里只有一格：数组的零值（公共那张 `zeroOf` 表上没有 `arr`，而这一门把局部量
     全提到函数体开头零初始化）。 */
  ['python', {
    grammar: 'ext/python/python.grammar', exts: ['py'],
    adapter: 'ext/python/adapter/index.js', exports: { toIR: 'pyToIR', hooks: 'PY_HOOKS' },
    /* 公共库（`ext/python/lib/*.py` 那些函数 + ucase 那张表）每份脚本一字不差 ——
       按单元产物切出去编一次、往后复用（`ext/python/units.js`，EVAL 两门同一条路）。 */
    units: { adapter: 'ext/python/units.js', name: 'pyUnitsBuild' },
  }],
  ['nim', {
    grammar: 'ext/nim/nim.grammar', exts: ['nim'],
    adapter: 'ext/nim/adapter/index.js', exports: { toIR: 'nimToIR', imports: 'nimImports' },
  }],
  ['cpp', {
    grammar: 'ext/cpp/cpp.grammar', exts: ['cpp', 'cc', 'cxx', 'hpp'],
    adapter: 'ext/cpp/adapter/index.js', exports: { toIR: 'cppToIR' },
  }],
  /* R（GNU R）。语法是**照 R 自己那份 bison 复刻的**（`r-source/src/main/gram.y`，
     ADR-0034 的导入器本来就读得动它）—— 这一门的正确性有真口径：本机有 `Rscript`，
     例子逐字节对它（`tests/r/oracle.js`）。
     后缀两格：`.R` 是主流写法，`.r` 也有（大小写在这张表里是两条）。
     `runFallback` 是**可选**的一格：这一门答"编译器这一档接不住时，`omni run` 还能怎么跑"。
     R 是两档（ADR-0046）—— 编译器那一档接不住的（`library(ggplot2)` 那种）由 `omni run`
     自己换到 libR 那一档，而不是要人手敲一串 `R_HOME=… bin/exec/R --vanilla -f …`。
     别的语言不给这一格就是老样子（接不住就报"这一格还没接"）。 */
  ['r', {
    grammar: 'ext/r/r.grammar', exts: ['R', 'r'],
    adapter: 'ext/r/adapter.js', exports: { toIR: 'rToIR' },
    runFallback: { adapter: 'ext/r/libr-run.js', name: 'runWithLibR' },
  }],
  /* **按单元产物那条路**（EVAL 两门：运行时那一层是所有脚本共用的一格，只编一次只发一次）
     —— 登记在这两格的 `units` 上，于是 `cli.js` 不必 import `ext/`（见
     `docs/design/omni-serve-studio.md` §9.3/§9.4）。 */
  /* PolyDraw 的脚本（Ken Silverman 的 EVAL）。正确性口径是那棵参考树里的
     `polydraw_src/`（`eval.c` + `eval.txt`）—— 新写的 `c_impl` / `js_impl` 有已知偏差。
     `pre` 是**预处理**那一格（`#define` / `#if` 那一族，语料里真在用）—— 词法之前跑。
     两门的 `pre` 都是 `ext/polydraw/pre.js` 的 `preprocess`，各自的 adapter 转手导出它
     （这一层只认"一门语言一格入口"，不去第二份文件里取东西）。 */
  ['polydraw', {
    grammar: 'ext/polydraw/polydraw.grammar', exts: ['pss'], asi: true,
    adapter: 'ext/polydraw/adapter.js', exports: { toIR: 'polydrawToIR', pre: 'preprocess' },
    units: { adapter: 'ext/polydraw/units.js', name: 'evalUnitsBuild' },
  }],
  /* EvalDraw（Ken 的另一个程序，**同一门语言**）—— 指的就是上面那份语法：
     它不改一条规则读下了 141/142 份 `.kc`。差别只有那张宿主表（`ext/evaldraw/adapter.js`）。
     那棵树里**没有源码**（只有 .exe），所以口径是 `evaldraw.txt` / `evaldraw_ref.md`。 */
  ['evaldraw', {
    grammar: 'ext/polydraw/polydraw.grammar', exts: ['kc'], asi: true,
    adapter: 'ext/evaldraw/adapter.js', exports: { toIR: 'evaldrawToIR', pre: 'preprocess' },
    units: { adapter: 'ext/polydraw/units.js', name: 'evalUnitsBuild' },
  }],
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
