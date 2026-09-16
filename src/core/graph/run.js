// src/core/graph/run.js —— **`omni run --engine graph`**：那十门语言从源码到跑掉的一条路
//
// 这一份是**接线**，不是新机器：语法 -> 树（`glr/`）-> 图（`ext/<lang>/tograph.js`）->
// 后端（`contract.js` 的五问）。每一步都是已经有判据的那一步，所以这儿一格新语义都不加。
//
// ## 为什么要有 `--engine`
//
// 这棵树里已经有另一条 `omni run`（asy / jnc / C / GLSL 那条：前端 -> OIR -> 后端）。
// 图那一条是**另一台机器**（ADR-0033 的节点代数 + 契约五问），两条路对同一个文件名可能
// 都说得通。默认仍然是老那条，`--engine graph` 才切过来 —— 引擎是**用户敲的**，不猜。
//
// ## 语言怎么定：`--lang` 优先，后缀只是默认
//
// `.lua` 既可能是 lua 也可能是 gsl-shell，源码还几乎同形 —— 按后缀猜必然猜错一半。
// 所以 `--lang` 一给就盖过后缀（`langs.js` 的 `pickLang`），两样都说不出来就报一句带清单的错。
//
// ## `--backend` 现在有哪几条（图这一层的答卷，全部来自 `contract.js`）
//
//   interp  默认。**它就是 `graph.eval`** —— 调度器的读法，不是"另一个后端"（§5）
//   js      降成一份 JS 源码，在本进程里跑掉
//   wat     降成 WAT 文本，交给 `frontend-wat` 读回来、用 MIR 的解释器真跑
//           （所以这一条腿的正确性由一条互不相干的已有实现来证）
//   sx      **只序列化**：印出图的那份文本，再读回来验一遍逐字节相同（不产生输出行）
//
// 缺口不是失败：某个后端接不住这份图的某个形状时，报的是那一句有名有姓的账（`Gap`），
// 退出码 3 —— 与"程序自己跑错了"分开。

import { loadGrammarTable } from '../glr/load.js';
import { lexText } from '../glr/lex.js';
import { glrParse } from '../glr/driver.js';
import { Diagnostics, SourceFile, OmniError } from '../source/diag.js';
import { readText, stdout, stderr } from '../host/native.js';
import { backends, Gap } from './contract.js';
import { LANGS, DIALECTS, pickLang, treeRoot } from './langs.js';

/** 一格 `--flag VALUE`：给了就回那个值，没给回 null（不认 `--flag=VALUE`，与别处一致）。 */
function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/** 图这一层认得的后端名单（顺序就是印出来的顺序）。 */
export function graphBackendNames() {
  return backends().map((b) => b.name);
}

/**
 * 跑一份源码。回退出码：0 = 跑通、1 = 语法/映射说不通、3 = 后端有缺口（有名有姓）。
 *
 * @param {string} path 源文件
 * @param {string[]} argv `run` 后面那些参数（`--lang` / `--backend` 在里头）
 */
export function runGraphFile(path, argv) {
  const want = argOf(argv, '--lang');
  const lang = pickLang(path, want);
  const backName = argOf(argv, '--backend') ?? 'interp';
  const back = backends().find((b) => b.name === backName);
  if (back === undefined) {
    throw new OmniError(`run --engine graph：没有 --backend ${backName} 这一条 —— `
      + `图这一层现在有 ${graphBackendNames().join(' / ')} 四条`
      + '（interp 就是 graph.eval；sx 只序列化，不出输出行）');
  }

  // ---- 1) 源码 -> 树。语法与映射都是那门语言自己的，这儿一个字不改
  const grammarPath = `${treeRoot()}/${lang.grammar}`;
  const { tb, g } = loadGrammarTable(grammarPath);
  const src = readText(path);
  const diags = new Diagnostics();
  const toks = lexText(g.lex, new SourceFile(path, src), diags);
  if (toks === null || diags.hasErrors()) {
    stderr(diags.format());
    return 1;
  }
  const tree = glrParse(tb, toks, diags);
  if (tree === null || diags.hasErrors()) {
    stderr(diags.format());
    return 1;
  }

  // ---- 2) 树 -> 图
  let graph = null;
  try {
    graph = lang.toGraph(tree);
  } catch (err) {
    throw new OmniError(`${path}: ${lang.name} 的映射说不通 —— ${err.message}`);
  }

  // ---- 3) 图 -> 那条腿。缺口与"跑错了"分开记
  let art = null;
  try {
    art = back.lower(graph);
  } catch (err) {
    if (err instanceof Gap) {
      stderr(`omni: ${backName} 这条腿接不住 —— ${err.message}\n`);
      return 3;
    }
    throw err;
  }
  if (back.runnable === false) {
    // sx：印那份文本，顺带把"读回来还是同一张图"验一遍（那是它在矩阵里的判据）
    stdout(`${art.text}\n`);
    if (typeof art.reread === 'function' && art.reread() !== art.text) {
      throw new OmniError('sx: 读回来再序列化与原文不一样 —— 序列化这一格坏了');
    }
    return 0;
  }
  const { out } = runOr(back, art, path, lang.name);
  for (const line of out) stdout(`${line}\n`);
  return 0;
}

/**
 * 真跑那一下。**跑错了与接不住是两件事**：接不住是 `Gap`（上面那一格，退出码 3），
 * 跑错了是这份源码自己的事（`unbound name: x`、缺键、越界…）—— 那也得是一句人话，
 * 不许把 JS 的调用栈糊到用户脸上。
 */
function runOr(back, art, path, langName) {
  try {
    return art.run();
  } catch (err) {
    if (err instanceof Gap) {
      throw new OmniError(`omni: ${back.name} 这条腿接不住 —— ${err.message}`);
    }
    throw new OmniError(`${path}（${langName} × ${back.name}）跑的时候错了 —— ${err.message}`);
  }
}

/** `--engine graph --help` 那几行（`cmds.js` 里引它，免得两处各写一套）。 */
export function graphEngineHelp() {
  const langs = [...LANGS.entries()].map(([n, d]) => `${n}(.${d.exts.join(' .')})`).join('  ');
  const dias = [...DIALECTS.entries()].map(([n, d]) => `${n}(按 ${d.of} 读)`).join('  ');
  return `--engine graph：走节点图那台机器（ADR-0033）—— 十门语言共用一份节点清单与一份契约。
  语言按 --lang 定，没给就按后缀猜（**--lang 优先**：.lua 既可能是 lua 也可能是 gsl-shell）：
    ${langs}
  方言（只能 --lang 点名，没有自己的后缀）：${dias}
  --backend 这一层有四条：${graphBackendNames().join(' / ')}
    interp  默认，就是 graph.eval（调度器的读法）
    js      降成 JS 源码，在本进程里跑掉
    wat     降成 WAT，交给 frontend-wat 读回来用 MIR 解释器跑（互不相干的实现来证）
    sx      只序列化：印图的文本 + 验一遍读回来逐字节相同（不出输出行）
  退出码：0 跑通 · 1 语法或映射说不通 · 3 那条腿有缺口（有名有姓）`;
}
