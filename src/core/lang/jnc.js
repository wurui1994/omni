// src/core/lang/jnc.js —— jancy 前端的插件外壳（ADR-0021 的 S4）
//
// 与 lang/wat.js / lang/sx.js / lang/asy.js 同一条规矩：**不 import cli.js**，
// 宿主服务由 `register` / `initJnc` 给一次。jnc 比 asy 干净得多 —— 没有 AST 缓存、
// 没有产物缓存那一摊，所以只要一格 log。

import { Diagnostics, SourceFile, OmniError } from '../source/diag.js';
import { join, dirname, resolve, isAbsolute } from '../host/path.js';
import { readText, exists, installDir, stderr, env } from '../host/native.js';
import { dataPath, dataTried } from '../host/data.js';
import { loadGrammarTable } from '../glr/load.js';
import { lexText } from '../glr/lex.js';
import { glrParse } from '../glr/driver.js';
import { lowerJnc } from '../frontend-jnc/lower.js';
import { lowerJncRules } from '../../lang/jnc/lower.js';
import { lowerCoreSexpr } from '../sexpr/lower.js';
/* `import … with "h.h"` 要 C 前端那一格（`c.declsOf`）。走 `cap()` 而不是直接 import：
   两门语言各是一个插件，jancy 不该在装载期就把 C 前端拖进来 —— 只有真写了 `with` 的
   源码才会问它，那时候要么它在，要么当场报"没装 C 前端"。 */
import { cap } from '../plugin.js';


/* 核心交过来的宿主服务。 */
let JNC_API = null;

/* 走哪条降级：**默认走按表那条**（`src/lang/jnc/lower.js`，第二百五十八刀翻的），
   `JNC_RULES=0` 退回旧那条（`src/core/frontend-jnc/lower.js`，已 `@deprecated`）。
   读的是宿主的 `env`，不是 `process.env` —— 这一层不许认死 node（ADR-0011 决策 2）。
   每趟现读，于是同一个进程里也能改（语料尺子两条腿轮着跑就靠这一格）。

   翻的依据：规则那条路在整份语料上与旧那条**等效**（199/199 降得下来、行为逐字节一致），
   而且已经比旧那条**多**收了几族（反应器、位域的类、`threadlocal`…）。旧那条留着当回退，
   过一个宽限期删。 */
function JNC_RULES() {
  return env('JNC_RULES') !== '0';
}

export function initJnc(api) {
  JNC_API = api;
}

/* 与 lang/asy.js 里那一份同样的十行：读表 + 印一行。两份语言各留一份而不是共用 ——
   插件之间不许互相依赖，共用就等于装 jnc 得先装 asy。表还是同一个 loadGrammarTable。 */
function jncLoadGrammar(path) {
  const { g, tb, hit, cachePath } = loadGrammarTable(path);
  if (hit) JNC_API.log(`grammar ${g.name}  ${tb.states.length} states, cache hit ${cachePath}`);
  else {
    JNC_API.log(`grammar ${g.name}  ${tb.states.length} states, ${tb.conflicts.length} conflicts left to GLR`);
    JNC_API.log(`grammar ${g.name}  table cached at ${cachePath}`);
  }
  return tb;
}

/**
 * jancy 前端（ADR-0016 分步 7）。零件比 asy 那一份少得多：只有语法表 + 词法，
 * 没有内建绑定表（jancy 的标准库这一刀不接）、也没有解析缓存（一份 `.jnc` 就是一趟，
 * 没有 base/ 那样每次都重解析的库）。模块加载有了，见 jncText 里的 find / parse（第六十刀）。
 */
export function jncFrontEnd() {
  /* 语法表是**数据**，按布局找（host/data.js）—— 与 asy 那一门同一条规矩。 */
  const rel = join('frontend-jnc', 'jnc.grammar');
  const gpath = dataPath(rel);
  if (gpath === null) throw new OmniError(`找不到 jnc 语法文件（试过 ${dataTried(rel)}）`);
  return jncLoadGrammar(gpath);
}

/**
 * 一份 `.jnc` -> 语法树。入口文件与被 import 进来的文件走的是同一条（第六十刀）。
 *
 * 抛不抛只看**这个文件自己**新添了错没有，而不是 `throwIfErrors`。一趟降级现在会解好几个
 * 文件，而前面那些文件已经记下的"还不收"不该把后面的解析掐掉 —— 掐掉的话这一趟就只报得出
 * 第一条拦路项，语料尺子跟着少数。
 */
export function jncParse(tb, path, diags) {
  const n0 = diags.errorCount();
  const file = new SourceFile(path, readText(path));
  const toks = lexText(tb.grammar.lex, file, diags);
  if (diags.errorCount() > n0) throw new OmniError(diags.format());
  JNC_API.log(`jnc lexer      ${path} -> ${toks.length} tokens`);
  const tree = glrParse(tb, toks, diags);
  if (diags.errorCount() > n0) throw new OmniError(diags.format());
  if (tree === null) throw new OmniError(`解析不了：${path}`);
  return tree;
}

/**
 * 一段**表达式源码** -> 那棵表达式的树（第六十四刀，给格式化字面量里的 `$(…)` 用）。
 *
 * 语法只有一个起点（`unit`），所以把这段源码裹成一个合法的单元再解析，再把 `return` 底下
 * 那一棵挖出来。jancy 那边是词法层做的（`lit_fmt_opener` 之后 `fcall main`，Lexer.rl:142，
 * 于是里头那段就是普通 token 流）；这一层的词法是一张 DFA，没有 fcall / fret，所以改成
 * "整块当一个 token、要用时再解析一遍"—— 认的是同一门语言。
 *
 * 裹的时候按**原文的行列**补空白：头一段占第一行，再补 line-1 个换行与 col-1 个空格，于是
 * 里头报的位置就是真文件里的真位置。字面量落在第一行时补不出来（头那段自己占着第一行），
 * 那时列往右偏 —— 行仍旧是对的。
 */
export function jncParseExpr(tb, file, text, offset, diags) {
  const n0 = diags.errorCount();
  const { line, col } = file.lineCol(offset);
  const head = 'void __fmt__() { return (';
  const pad = line > 1 ? '\n'.repeat(line - 1) + ' '.repeat(col - 1) : '';
  const wrapped = new SourceFile(file.path, `${head}${pad}${text}); }`);
  const toks = lexText(tb.grammar.lex, wrapped, diags);
  if (toks === null || diags.errorCount() > n0) return null;
  const tree = glrParse(tb, toks, diags);
  if (tree === null || diags.errorCount() > n0) return null;
  const dig = (nd) => {
    if (nd === null || typeof nd !== 'object' || !Array.isArray(nd.items)) return null;
    const h = nd.items[0];
    if (nd.items.length > 1 && h !== undefined && h !== null && h.value === 'return') return nd.items[1];
    for (const it of nd.items) {
      const r = dig(it);
      if (r !== null) return r;
    }
    return null;
  };
  return dig(tree);
}

/**
 * 一份 `.jnc` -> 核心方言的文本。`omni sx` 那条路也走它，所以降级只有一份实现。
 *
 * `needEntry`（第六十五刀）：要跑的那几条腿要一个 `int main()`；`omni sx` 只要降下来的
 * 文本，库模块本来就没有入口（语料 662 份里 408 份是这种），所以那条路上不要。
 */
export function jncText(path, dirs = [], needEntry = true) {
  const tb = jncFrontEnd();
  const diags = new Diagnostics();
  const tree = jncParse(tb, path, diags);
  // import 的找法（第六十刀定的形，第六十二刀补上 `-I`）：绝对路径原样看在不在；否则先
  // **在写这条 import 的文件自己的目录里**找，再按给的顺序逐个试 `-I` 的目录 —— 与
  // jancy 的 findImportFile 一模一样（io::findFilePath(fileName, unit->getDir(),
  // &m_importDirList, false)，jnc_ct_ImportMgr.cpp:110-119；那个 false 是
  // doFindInCurrentDir，所以**进程的当前目录不算一格**，axl_io_FilePathUtils.cpp:428-446）。
  // 路径过一遍 resolve（jancy 那边是 io::getFullFilePath，jnc_ct_Module.cpp:386）——
  // 查重认的是这一格，所以 `./a.jnc` 与 `a.jnc` 是同一个文件。
  const find = (spec, from) => {
    if (isAbsolute(spec)) return exists(spec) ? resolve(spec) : null;
    const here = join(dirname(from), spec);
    if (exists(here)) return resolve(here);
    for (const d of dirs) {
      const p = join(d, spec);
      if (exists(p)) return resolve(p);
    }
    return null;
  };
  /* **规则化的那条降级**（`src/lang/jnc/lower.js`，ADR-0030 §3）：`JNC_RULES=1` 时走它。
     两条并存是刻意的 —— 旧的留着当回退，新的按表走，两边跑的是同一份语料。 */
  if (JNC_RULES()) {
    /* `find` / `parse` 递进去：import 那一族在**规则化那条路**里也是"把那份文件的顶层条目
       并进这一个模块"（第六十刀）—— 找法与旧那条路共用同一个闭包，不另写一套。 */
    const t2 = lowerJncRules(tree, diags, {
      path,
      needEntry,
      find,
      parse: (p) => jncParse(tb, p, diags),
      /* **格式化字面量 `$"…$(x)…"`**（第二百刀）：`$(…)` 里头是一整条表达式 —— 词法那一层
         把整个字面量当一个记号，所以那一段要**再解析一遍**。入口与旧那条路共用同一个。 */
      parseExpr: (file, src, offset) => jncParseExpr(tb, file, src, offset, diags),
    });
    const w2 = diags.warnings();
    if (w2 !== '') stderr(w2);
    diags.throwIfErrors();
    return t2;
  }
  const text = lowerJnc(tree, diags, {
    path,
    unit: resolve(path),
    find,
    parse: (p) => jncParse(tb, p, diags),
    /* `import "libfoo.dylib" with "foo.h"` 的那一半（ADR-0022 的 J4d）：头文件按与 `.jnc`
       同一条规矩找（写这条 import 的文件旁边，再是 `-I` 那张表），找着了交给 `cap('c.declsOf')`
       —— 那一格用的是这个仓库里已有的那份 C 前端，所以不外挂 tcc、也不另写一个解析器。

       **找不着不等于没有**：`math.h` 这种系统头既不在源码旁边、也不在 `-I` 里，找它的规则
       就是 C 前端自己那条 include 搜索路径。所以那一路改成递一份 `#include <spec>` 进去，
       让 C 前端按它自己的规矩找 —— 真找不着时报的错也就出自那一侧（"include file not found"），
       而不是这一层含混的"找不着头文件"。 */
    decls: (spec, from) => {
      const opts = {
        includeDirs: dirs,
        sysIncludeDirs: cap('c.sysInclude')(),
        arch: 'arm64',
        os: undefined,
      };
      const p = find(spec, from);
      if (p !== null) return cap('c.declsOf')(p, opts, []);
      opts.text = `#include <${spec}>\n`;
      return cap('c.declsOf')(from, opts, []);
    },
    parseExpr: (file, src, offset) => jncParseExpr(tb, file, src, offset, diags),
    dirs,
    needEntry,
  });
  /* 警告要真的印出去（ADR-0022 的 J4d）：`import … as g` 猜签名、`with "h"` 里跳过的
     那些声明，都是"能跑但你该知道"的事。印在 **stderr** 上 —— stdout 是程序自己的输出，
     每条腿都在按字节比它。 */
  const w = diags.warnings();
  if (w !== '') stderr(w);
  diags.throwIfErrors();
  return text;
}

export function compileJnc(path, dirs = []) {
  const diags = new Diagnostics();
  const mod = lowerCoreSexpr(new SourceFile(`${path}.sx`, jncText(path, dirs)), diags);
  diags.throwIfErrors();
  JNC_API.log(`jnc front end  ${path} -> OIR  ${mod.funcs.length} funcs`);
  return { ast: null, mod, diags };
}

/** 登记：内建时核心调一次，做成动态库之后由 `omni_plugin_init` 调同一个。 */
/* 名字带前缀是**这条腿的硬约束**：自举链的链接器要求模块作用域的名字在整份程序里唯一
   （tests/bootstrap/ratchet.js 的第一条断言），而四门语言现在还都链在同一个程序里。
   等每门语言各自成一个动态库、各自独立编译，C ABI 那一层的入口才是统一的
   `omni_plugin_init`，JS 这一侧的名字就不必再避让了。 */
export function registerJncLang(api) {
  initJnc(api);
  /* 驱动要的那一格：`omni emit sx x.jnc` 印的是降到核心方言的那份文本。按名字给，
     不让驱动直接 import（理由见 plugin.js 的 CAPS）。 */
  api.registerCap('jnc.toSx', jncText);
  api.registerLang(['.jnc'], 'jnc', (path, argv) => compileJnc(path, api.incDirs(argv)));
}
