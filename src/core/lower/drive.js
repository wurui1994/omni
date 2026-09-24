// src/core/lower/drive.js —— **借来的语言 → 核心方言那一趟**（ADR-0044 的默认路径）
//
//   源码 → GLR → CST → adapter(语言) → 标准 IR → lower(公共) → .sx text
//
// 这一份**只管接线**：读语法、解析、叫 adapter、叫公共降级器。一格语义都不加 ——
// 语言的知识在 adapter 里，方言的形状在 `sx.js` 里。
//
// 登记处是旁边那份 `langs.js`（一门语言一格：语法 · adapter · 后缀）。
// **`cli.js` 的入口是这一份的 `coreSxText` 与 `borrowedExts`**（十一门全走这条路）。

import { loadGrammarTable } from '../glr/load.js';
import { lexText } from '../glr/lex.js';
import { glrParse } from '../glr/driver.js';
import { Diagnostics, SourceFile, OmniError } from '../source/diag.js';
import {
  readText, stderr, exists, readDir,
} from '../host/native.js';
import { pickLang, treeRoot, LANGS } from './langs.js';
import { lower } from './lower.js';
/* **图形设备**：`GFX_CPU` 这一格一被引用，`host/gfx-cpu.js` 就把 **CPU 备选**那一档装在
   `globalThis.__OMNI_GFX` 上。浏览器那边页面会把它换成 **WebGL2** 那一档 —— 同一格全局、
   同一张名字表（`docs/design/eval-realtime-gpu.md` 第 2.2 节）。
   为什么装在这条路上：`.pss` / `.kc` 两门从这儿进来，而设备必须在**跑起来之前**就位。 */
import { GFX_CPU } from '../host/gfx-cpu.js';

/* 谁跑谁装：这一句把 CPU 备选那一档摆上去，**已经有设备就不动**（浏览器那边页面
   先装了 WebGL2，那一格才是默认）。 */
if (globalThis.__OMNI_GFX === undefined) globalThis.__OMNI_GFX = GFX_CPU;

/** 一份路径的目录（宿主那侧不供这一格）。 */
const dirOf = (p) => (p.lastIndexOf('/') >= 0 ? p.slice(0, p.lastIndexOf('/')) : '.');

/** 一门语言迁到公共降级器了没有（登记处那一格 `toIR` 就是答案）。 */
export function hasAdapter(lang) {
  return lang !== null && lang !== undefined && typeof lang.toIR === 'function';
}

/**
 * 一份源码 → 核心方言文本（`.sx`）。回 null = 语法说不通（诊断已经印过了）。
 * adapter 或降级器接不住的形状按 `OmniError` 抛（有名有姓，退出码 1）。
 *
 * **旁边那几份同语言的文件也读进来**（`lang.imports` 答"这份文件 import 了什么"）：
 * `import util` 里的 `util` 拼上这门语言的后缀，**就在导入方旁边**找；找着就读、找不着照旧
 * 交给 adapter（标准库那一族是这么落的）。刻意不搜索（与 ADR-0009 那套模块路径同一条纪律）。
 * 依赖在前、读过的不再读（环不挂死），全部交给 `toIR(主树, { also })`。
 *
 * @param {string} path 源文件
 * @param {string[]} argv `run` / `build` 后面那些参数（`--lang` 在里头）
 */
export function sxTextOf(path, argv = []) {
  const lang = pickLang(path, cliArg(argv, '--lang'));
  if (!hasAdapter(lang)) {
    throw new OmniError(`${lang.name} 还没有 adapter —— 这条路（ADR-0044）要登记处那一格 toIR`);
  }
  /* **`--pkgs-root` 还没接**（那是"扫主包的 import 自己找依赖"，go 编译器自举那一轴要它）。 */
  for (const flag of ['--pkg', '--pkgs-root']) {
    if (argv.includes(flag)) {
      throw new OmniError(`${flag} 还没接到公共降级器这条路上（${lang.name}）——`
        + ' 那一格是"自己去找依赖"，比 `--pkgs`（名单写在命令行上）多一层');
    }
  }
  const { tb, g } = loadGrammarTable(`${treeRoot()}/${lang.grammar}`);
  const diags = new Diagnostics();
  /* 主文件的**原文**：有几门语言的 adapter 除了树还要它 —— `.pss` 后半那些
     `@v` / `@f` 区段是着色器原文，词法层整段跳过去了（那不是这门语言的语法），
     可"把原文交给设备"这件事还是得有人做。 */
  let mainSrc = '';
  const treeOf = (p) => {
    const text = readText(p);
    if (p === path) mainSrc = text;
    /* **预处理那一格**（登记处那一行的 `pre`）：EVAL 两门有 `#define` / `#if` 那一族，
       它得在词法之前跑。行数不变，所以诊断里的行号还是原文的行号。 */
    const lexed = lang.pre === undefined ? text : lang.pre(text, p);
    const toks = lexText(g.lex, new SourceFile(p, lexed), diags);
    if (toks === null || diags.hasErrors()) return null;
    const t = glrParse(tb, toks, diags);
    return t === null || diags.hasErrors() ? null : t;
  };
  const tree = treeOf(path);
  if (tree === null) { stderr(diags.format()); return null; }

  const also = [];
  const seen = new Set([path]);
  /**
   * **`--pkgs DIR,DIR,…`**：名单上每个目录里的源文件都编进来，**次序就是名单的次序**
   * （判据里写的那一行就是拓扑序：`strconv,strings` = strconv 在前）。
   * 名字是**平的**（所有包摊进一个名字空间）—— 那是这一层与图那条路同一条口径，
   * 也是 `reference_go_stdlib_shims` 那笔账里"类型名会撞"的由来。
   */
  const pkgsRaw = cliArg(argv, '--pkgs');
  for (const dir of (pkgsRaw === null ? [] : pkgsRaw.split(',').map((s) => s.trim()).filter(Boolean))) {
    let names = [];
    try { names = readDir(dir); } catch { throw new OmniError(`--pkgs 读不了 ${dir}`); }
    for (const n of names.sort()) {
      if (!lang.exts.some((e) => n.endsWith(`.${e}`))) continue;
      if (n.endsWith('_test.go')) continue;
      const p = `${dir}/${n}`;
      if (seen.has(p)) continue;
      seen.add(p);
      const sub = treeOf(p);
      if (sub === null) { stderr(diags.format()); return null; }
      also.push(sub);
    }
  }

  const load = (p, t) => {
    if (lang.imports === undefined) return true;
    for (const spec of lang.imports(t)) {
      const rel = spec.startsWith('./') ? spec.slice(2) : spec;
      let hit = null;
      for (const e of lang.exts) {
        const cand = `${dirOf(p)}/${rel}.${e}`;
        if (exists(cand)) { hit = cand; break; }
      }
      if (hit === null || seen.has(hit)) continue;      // 标准库那一格 / 已经读过
      seen.add(hit);
      const sub = treeOf(hit);
      if (sub === null) return false;
      if (!load(hit, sub)) return false;               // 它自己的 import 先读（依赖在前）
      also.push(sub);
      stderr(`omni: import 进来的同语言文件 ${hit}\n`);
    }
    return true;
  };
  if (!load(path, tree)) { stderr(diags.format()); return null; }

  try {
    const ir = lang.toIR(tree, { also, src: mainSrc });
    return lower(ir, lang.hooks ?? {});
  } catch (err) {
    throw new OmniError(`${path}：${lang.name} 这一格还没接住 —— ${err.message}`);
  }
}

/** 一格 `--flag VALUE`（不认 `--flag=VALUE` —— 整条链一条规矩）。 */
function cliArg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/**
 * **按后缀能猜到哪一门**（登记处那张表算出来的，不在别处手抄）。
 * `cli.js` 拿它判"这份文件是借来的语言吗" —— 加一门语言只改登记处那一处。
 * `guess: false` 的那几门不参与（gsl-shell 的 `.lua` 归 lua，只能 `--lang` 点名）。
 */
export function borrowedExts() {
  const out = new Set();
  for (const [, d] of LANGS) {
    if (d.guess === false) continue;
    for (const e of d.exts) out.add(`.${e}`);
  }
  return [...out];
}

/**
 * 源码 → 核心方言文本（`.sx`）。**这是 `cli.js` 那一侧的名字**。
 *
 * `.go` 这类文件与 `.c` 一样，**就是这条链的一个前端**：译成 `.sx` 之后走的是与 `.sx`
 * 输入一模一样的那条路（lower → OIR → MIR → 原生 / js / llvm，还有 `--cc` /
 * `OMNI_MIR_OPT` / 摇树 / profile），所以下游一行都不用再写。
 */
export function coreSxText(path, argv) {
  return sxTextOf(path, argv);
}
