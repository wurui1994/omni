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

export function runGraphFile(path, argv) {
  const back = pickBackend('run', argv, 'interp');
  const got = graphOf(path, argv);
  if (got.code !== undefined) return got.code;
  const { lang, graph } = got;

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
 *   js   **落不了**：现在那份文本是一格函数表达式，要外面喂十几个运行时钩子才跑得起来，
 *        不是能 `node` 直接跑的脚本。写出去等于给一份跑不起来的产物 —— 记成账，不糊过去。
 *   interp 没有产物：它就是 `graph.eval`（§5：默认解释器不是"另一个后端"）。
 */
export function buildGraphFile(path, argv) {
  const back = pickBackend('build', argv, 'wat');
  if (back.name === 'interp') {
    throw new OmniError('build --engine graph --backend interp：interp 没有产物 —— '
      + '它就是 graph.eval（要跑就 `omni run --engine graph`）');
  }
  if (back.name === 'js') {
    throw new OmniError('build --engine graph --backend js：那条腿的文本是一格**函数表达式**，'
      + '要外面喂十几个运行时钩子才跑得起来 —— 还不是能直接跑的脚本，所以这一格宁可不落产物'
      + '（要看那份文本用 `omni run --engine graph --backend js -v`；自足打包记在账上）');
  }
  const got = graphOf(path, argv);
  if (got.code !== undefined) return got.code;
  const dot = path.lastIndexOf('/') >= 0 ? path.slice(path.lastIndexOf('/') + 1) : path;
  const stem = dot.lastIndexOf('.') > 0 ? dot.slice(0, dot.lastIndexOf('.')) : dot;
  const out = cliArg(argv, '-o') ?? `${stem}.${back.name}`;
  let art = null;
  try {
    art = back.lower(got.graph);
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
    js      降成 JS 源码，在本进程里跑掉
    wat     降成 WAT，交给 frontend-wat 读回来用 MIR 解释器跑（互不相干的实现来证）
    sx      只序列化：印图的文本 + 验一遍读回来逐字节相同（不出输出行）
  退出码：0 跑通 · 1 语法或映射说不通 · 3 那条腿有缺口（有名有姓）`;
}
