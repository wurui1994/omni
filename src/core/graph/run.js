// src/core/graph/run.js —— **`omni run --engine graph`**：登记处那十一格从源码到跑掉的一条路
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
//   c       降成一份**自足的 C**（宿主面只有 libc 那七格），交给我们自己那台 C 前端
//           （`frontend-c`）读回来、还是那台 MIR 解释器跑 —— 与 wat 同一条判据，
//           而且一个外部 cc 都不借。缺口有名有姓（第一刀接第一批 + 早退）
//   sx      **只序列化**：印出图的那份文本，再读回来验一遍逐字节相同（不产生输出行）
//
// 缺口不是失败：某个后端接不住这份图的某个形状时，报的是那一句有名有姓的账（`Gap`），
// 退出码 3 —— 与"程序自己跑错了"分开。

import { loadGrammarTable } from '../glr/load.js';
import { lexText } from '../glr/lex.js';
import { glrParse } from '../glr/driver.js';
import { Diagnostics, SourceFile, OmniError } from '../source/diag.js';
import { readText, writeText, writeBinary, stdout, stderr } from '../host/native.js';
import { backends, Gap } from './contract.js';
import {
  graphStat, graphStatTable, graphStatJson, graphStatDot, graphStatDiff, graphStatDiffTable,
} from './stat.js';
import { shrink } from './shrink.js';
import { layerModel, layerTable } from '../cli/layers.js';
import { watToWasm } from '../wasm/assemble.js';
import { LANGS, pickLang, treeRoot } from './langs.js';

/** 一格 `--flag VALUE`：给了就回那个值，没给回 null（不认 `--flag=VALUE`，与别处一致）。
 *  名字不叫 `argOf`：`src/lang/jnc/generic.js` 里那格叫这个名字（取泛型实参，是另一件事）。 */
function cliArg(argv, name) {
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
/**
 * 源码 -> 图。回 `{ lang, graph }`，或者回 `{ code }`（语法说不通，诊断已经印了）。
 * `run` 与 `build` 共用它 —— 两条命令的前两步一个字都不该差。
 */
function graphOf(path, argv) {
  const lang = pickLang(path, cliArg(argv, '--lang'));
  const grammarPath = `${treeRoot()}/${lang.grammar}`;
  const { tb, g } = loadGrammarTable(grammarPath);
  const src = readText(path);
  const diags = new Diagnostics();
  const toks = lexText(g.lex, new SourceFile(path, src), diags);
  if (toks === null || diags.hasErrors()) { stderr(diags.format()); return { code: 1 }; }
  const tree = glrParse(tb, toks, diags);
  if (tree === null || diags.hasErrors()) { stderr(diags.format()); return { code: 1 }; }
  try {
    return { lang, graph: lang.toGraph(tree) };
  } catch (err) {
    throw new OmniError(`${path}: ${lang.name} 的映射说不通 —— ${err.message}`);
  }
}

/** 挑一条腿。名字打错就报那四条（**清单是注册出来的**，不是手写的）。 */
function pickBackend(verb, argv, dflt) {
  const backName = cliArg(argv, '--backend') ?? dflt;
  const back = backends().find((b) => b.name === backName);
  if (back === undefined) {
    throw new OmniError(`${verb} --engine graph：没有 --backend ${backName} 这一条 —— `
      + `图这一层现在有 ${graphBackendNames().join(' / ')} 四条`
      + '（interp 就是 graph.eval；sx 只序列化，不出输出行）');
  }
  return back;
}

/**
 * `--stat` / `--stat-out FILE` / `--stat-diff FILE`（第一百四十七片第三格）：图的形状与结构。
 *
 * 印到 **stderr** —— stdout 上是那份程序的输出，判据逐行比对它，多一行都不行。
 * 算在 `stat.js`（纯计算，图进数出），这儿只管接线：读开关、落文件、印那几句。
 *
 * `--stat-diff` 要**再走一遍前端**（另一份源码 -> 另一张图）。那是有代价的一步，
 * 所以只在给了这个开关时才走 —— 「变换是减法」这个量尺不该让平常那一趟变慢。
 */
function statOf(graph, argv, path) {
  const out = cliArg(argv, '--stat-out');
  const other = cliArg(argv, '--stat-diff');
  if (!argv.includes('--stat') && out === null && other === null) return null;
  const s = graphStat(graph);
  stderr(graphStatTable(s));
  if (other !== null) {
    const got = graphOf(other, argv);
    if (got.code !== undefined) throw new OmniError(`--stat-diff ${other}：那份源码自己就说不通`);
    stderr(`omni: 基线 ${path} -> 变换后 ${other}\n`);
    stderr(graphStatDiffTable(graphStatDiff(s, graphStat(got.graph))));
  }
  if (out !== null) {
    const json = out.endsWith('.json');
    writeText(out, json ? graphStatJson(s) : graphStatDot(graph));
    stderr(`omni: 图的形状 -> ${out}（${json ? 'json' : 'dot：dot -Tsvg 出图'}）\n`);
  }
  return s;
}

/**
 * `--shrink`（第一个 pass）：常量折叠 + 死绑定删除。**账当场报** ——
 * `docs/design/node-graph-shrink.md` 第三条要求的原话是「每个 pass 要能报出删了几格节点」，
 * 所以这一句不是 `-v` 才印的调试话，是这个开关本身的输出（在 stderr 上）。
 * 再给了 `--stat` 就连那张按 op 的差表一起印 —— 「哪一格少了」比「少了几格」更有用。
 */
function shrinkOf(graph, argv) {
  if (!argv.includes('--shrink')) return graph;
  const s0 = graphStat(graph);
  const r = shrink(graph);
  const s1 = graphStat(r.graph);
  stderr(`omni: shrink 折 ${r.folded} 格常量、删 ${r.dropped} 格死绑定（${r.rounds} 轮）`
    + ` —— 节点 ${s0.nodes} -> ${s1.nodes} 格\n`);
  if (argv.includes('--stat')) stderr(graphStatDiffTable(graphStatDiff(s0, s1)));
  return r.graph;
}

/**
 * 各层的账（第一百四十七片第五格）：**与 omni 那台机器同一把尺子**（`cli/layers.js`）。
 *
 * 图这一层的节点表（上面 `statOf` 那张）说的是「图定义的那 27 格节点」；这一张说的是
 * 「源码 -> 图 -> 目标文本」每层多少、比源码大几倍。两张要分开看：一张是形状，一张是胀。
 */
function statLayersGraph(path, s, textLen, argv) {
  if (!argv.includes('--stat')) return;
  const src = readText(path);
  const layers = [{ name: '图', n: s.nodes, unit: '格', bytes: null }];
  if (textLen > 0) layers.push({ name: '目标文本', n: null, unit: '', bytes: textLen });
  stderr(layerTable(layerModel({ bytes: src.length, lines: src.split('\n').length }, layers)));
}

export function runGraphFile(path, argv) {
  const back = pickBackend('run', argv, 'interp');
  const got = graphOf(path, argv);
  if (got.code !== undefined) return got.code;
  const { lang } = got;
  const graph = shrinkOf(got.graph, argv);
  const st = statOf(graph, argv, path);

  // ---- 图 -> 那条腿。缺口与"跑错了"分开记
  let art = null;
  try {
    art = back.lower(graph);
  } catch (err) {
    if (err instanceof Gap) {
      stderr(`omni: ${back.name} 这条腿接不住 —— ${err.message}\n`);
      return 3;
    }
    throw err;
  }
  /* 各层的账：这条腿的目标文本大小只有降完才知道（interp 那条没有文本 —— 报 0）。 */
  if (st !== null) statLayersGraph(path, st, typeof art.text === 'string' ? art.text.length : 0, argv);
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

/**
 * `omni build --engine graph -o OUT`：把那条腿的**产物**落成一个文件。
 *
 * 三条腿有产物、一条没有，而"没有"这件事要说清而不是含糊过去：
 *   wat  一份自足的 `.wat` 模块（宿主面就是那四格 `print_*` 导入）—— wasm 是真后端，
 *        不是只在测试里跑一跑的那种（这正是 target.md 那一条的落点）
 *   sx   一份图的序列化（`fromSx` 读得回来 —— 那是它自己的判据）
 *   js   一份**自足的 `.mjs`**（第一百五十一片）：十四个钩子的文本版摊在最前面
 *        （`js_rt.js`），`node x.mjs` 直接跑。从前这一格是"落不了"，理由是钩子得由外面喂
 *        —— 钩子有文本版之后那句话就不成立了
 *   interp 没有产物：它就是 `graph.eval`（§5：默认解释器不是"另一个后端"）。
 */
export function buildGraphFile(path, argv) {
  const back = pickBackend('build', argv, 'wat');
  if (back.name === 'interp') {
    throw new OmniError('build --engine graph --backend interp：interp 没有产物 —— '
      + '它就是 graph.eval（要跑就 `omni run --engine graph`）');
  }
  if (back.name === 'js') {
    /* 从前这儿是一句拒绝："那份文本是一格函数表达式，要外面喂十几个运行时钩子"。
     * 钩子有文本版之后（`js_rt.js` 的 `GRAPH_JS_RT`）那句话作废 —— 落的是一份**自足的
     * ESM**，`node x.mjs` 直接跑。判据 `tests/graph/js-artifact.js`：产物跑出来的 stdout
     * 与本进程那条腿逐行相同（那条判据同时钉住"文本版的钩子不许与 eval.js 分叉"）。 */
    const got = graphOf(path, argv);
    if (got.code !== undefined) return got.code;
    const graph = shrinkOf(got.graph, argv);
    statOf(graph, argv, path);
    const base = path.lastIndexOf('/') >= 0 ? path.slice(path.lastIndexOf('/') + 1) : path;
    const stem = base.lastIndexOf('.') > 0 ? base.slice(0, base.lastIndexOf('.')) : base;
    const out = cliArg(argv, '-o') ?? `${stem}.mjs`;
    const text = back.lower(graph).module(`${path}（${got.lang.name} × 图那一层的 js 后端）`);
    writeText(out, text);
    stderr(`omni: built ${out}（${text.length} 字节，${got.lang.name} × js —— 自足，node ${out} 直接跑）\n`);
    return 0;
  }
  const got = graphOf(path, argv);
  if (got.code !== undefined) return got.code;
  const graph = shrinkOf(got.graph, argv);
  statOf(graph, argv, path);
  const dot = path.lastIndexOf('/') >= 0 ? path.slice(path.lastIndexOf('/') + 1) : path;
  const stem = dot.lastIndexOf('.') > 0 ? dot.slice(0, dot.lastIndexOf('.')) : dot;
  /* js 那条腿的默认后缀是 `.mjs`（第一百五十一片）：产物离开这个仓库之后，`.js` 还要靠
   * package.json 的 `"type": "module"` 才被当模块，而 `.mjs` 在哪儿都是模块。 */
  const out = cliArg(argv, '-o') ?? `${stem}.${back.name === 'js' ? 'mjs' : back.name}`;
  let art = null;
  try {
    art = back.lower(graph);
  } catch (err) {
    if (err instanceof Gap) {
      stderr(`omni: ${back.name} 这条腿接不住 —— ${err.message}\n`);
      return 3;
    }
    throw err;
  }
  // **产物按后缀定**：`-o x.wat` 落文本，`-o x.wasm` 落**二进制**（`wasm/assemble.js` 装的）。
  // 这一格是"wasm 是真后端"最后半步：真引擎吃的是二进制，`.wat` 得先有人装。
  // 装出来的东西 V8 认（判据在 `tests/graph/wasm.js` 与 `tests/graph/cli.js`）。
  if (back.name === 'wat' && out.endsWith('.wasm')) {
    const bin = watToWasm(art.text);
    // `writeBinary` 收的是 latin1 串（宿主面就这一格），一字节一个码位
    writeBinary(out, Array.from(bin, (b) => String.fromCharCode(b)).join(''));
    stderr(`omni: built ${out}（${bin.length} 字节，${got.lang.name} × wat -> wasm 二进制）\n`);
    return 0;
  }
  writeText(out, `${art.text}\n`);
  stderr(`omni: built ${out}（${art.text.length} 字节，${got.lang.name} × ${back.name}）\n`);
  return 0;
}

/** `--engine graph --help` 那几行（`cmds.js` 里引它，免得两处各写一套）。 */export function graphEngineHelp() {
  const langs = [...LANGS.entries()].filter(([, d]) => d.guess !== false)
    .map(([n, d]) => `${n}(.${d.exts.join(' .')})`).join('  ');
  const named = [...LANGS.entries()].filter(([, d]) => d.guess === false)
    .map(([n, d]) => `${n}(.${d.exts.join(' .')} 归 ${d.extends}，只能点名)`).join('  ');
  return `--engine graph：走节点图那台机器（ADR-0033）—— ${LANGS.size} 门语言共用一份节点清单与一份契约。
  语言按 --lang 定，没给就按后缀猜（**--lang 优先**：.lua 既可能是 lua 也可能是 gsl-shell）：
    ${langs}
  只能 --lang 点名的（后缀被别人占着）：${named}
  --backend 这一层有四条：${graphBackendNames().join(' / ')}
    interp  默认，就是 graph.eval（调度器的读法）
    js      降成 JS 源码：run 在本进程里跑掉，build 落一份**自足的 .mjs**（node 直接跑）
    wat     降成 WAT，交给 frontend-wat 读回来用 MIR 解释器跑（互不相干的实现来证）
    sx      只序列化：印图的文本 + 验一遍读回来逐字节相同（不出输出行）
  退出码：0 跑通 · 1 语法或映射说不通 · 3 那条腿有缺口（有名有姓）`;
}
