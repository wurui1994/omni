// src/core/lang/grammar.js —— GLR 那两条命令（`glr-table` / `glr`）的插件外壳（ADR-0021 的 S4）
//
// 语法是数据（ADR-0014 决策 2），这两条读的都是 `.grammar` 文件。它们摆在 CLI 上不只是
// 为了调试：自举链要能让**原生编译器自己**跑一遍这条路，那是唯一能抓住封闭 ABI 违规的
// 门槛（tests/bootstrap/run.js 阶段 8、9）。
//
// 搬出来的理由与别的 lang/* 一样：驱动不该直连 glr/*。这一门不注册扩展名（`.grammar`
// 不降到 OIR），只出两格能力 —— 于是 `--builtins min` 的核心里 glr 那四份根本不进来。
// 与 lang/wat.js 同一条规矩：**不 import cli.js**，宿主服务由 register 的入参给。

import { OmniError, Diagnostics, SourceFile } from '../source/diag.js';
import { readText, exists } from '../host/native.js';
import { dumpTable } from '../glr/table.js';
import { loadGrammarTable } from '../glr/load.js';
import { lexText } from '../glr/lex.js';
import { glrParse } from '../glr/driver.js';
import { printSexpr } from '../sexpr/print.js';

/**
 * 读一份语法文件并构表。诊断在 loadGrammarTable 里就抛掉 —— 语法写错了不该拖到分析期。
 *
 * **构表结果按内容寻址缓存**：量过 asy 那份语法的构表要 780ms（433 个状态，全在项集族
 * 那一遍），而这条路是「一条 case 一个进程」——tests/asy 一轴上百次进程，不缓存就是白烧
 * 几分钟。键 = 语法文本 + 格式版本，所以改语法、改序列化形状都自动失效。
 *
 * 印那一行走注入进来的 log（asy / jnc 那两门各有一份同样形状的，不共用 —— 插件之间
 * 不许互相依赖）。
 */
function glrLoadTable(path, log) {
  const { g, tb, hit, cachePath } = loadGrammarTable(path);
  if (hit) log(`grammar ${g.name}  ${tb.states.length} states, cache hit ${cachePath}`);
  else {
    log(`grammar ${g.name}  ${tb.states.length} states, ${tb.conflicts.length} conflicts left to GLR`);
    log(`grammar ${g.name}  table cached at ${cachePath}`);
  }
  return tb;
}

/** 一棵 s-expr 的节点数。`glr --count` 的指纹，刻意只数节点：够灵敏，又不依赖排版。 */
function glrCountNodes(n) {
  if (n === null || n === undefined) return 0;
  if (n.kind !== 'list') return 1;
  let sum = 1;
  for (const x of n.items) sum += glrCountNodes(x);
  return sum;
}

/** `omni glr-table <语法>`：印状态表。`brief` 只印摘要。 */
export function glrTableText(path, brief, log) {
  return dumpTable(glrLoadTable(path, log), brief);
}

/**
 * `omni glr <语法> <输入>…`：分析一批输入，印出树。
 *
 * 收多个输入是刻意的：真实语言的表有几百个状态，建一次要一两秒，而测试轴有上百条 case。
 * 一条命令喂一批输入，表就只建一次。只给一个文件时输出与从前逐字节相同 —— 自举链
 * 阶段 9 对的是那一份。
 *
 * `countOnly` 只印一行摘要，不印树。为的是**整份真实语料**：84 个 asy 模块的树印出来是
 * 133 MB，光排版就吃掉大半时间，而覆盖率那道门槛要的只是"每份都出、且只出一棵树"。
 */
export function glrRunText(path, srcs, countOnly, log) {
  if (srcs.length === 0) throw new OmniError('glr needs a grammar file and at least one input file');
  for (const s of srcs) if (!exists(s)) throw new OmniError(`no such file: ${s}`);
  const tb = glrLoadTable(path, log);
  if (tb.grammar.lex === null) {
    throw new OmniError(`grammar '${tb.grammar.name}' has no (lex ...) form, so it cannot read source text`);
  }
  let out = '';
  for (const src of srcs) {
    const diags = new Diagnostics();
    const toks = lexText(tb.grammar.lex, new SourceFile(src, readText(src)), diags);
    diags.throwIfErrors();
    log(`lexer          ${src} -> ${toks.length} tokens`);
    const tree = glrParse(tb, toks, diags);
    diags.throwIfErrors();
    if (tree === null) throw new OmniError('glr: the parse failed without a diagnostic — that is a bug');
    if (countOnly) { out += `${src}  ${toks.length} tokens, ${glrCountNodes(tree)} nodes\n`; continue; }
    if (srcs.length > 1) out += `;; ==== ${src}\n`;
    out += printSexpr([tree]);
  }
  return out;
}

/** @param api `{ registerCap, log }` */
export function registerGrammarLang(api) {
  api.registerCap('glr.table', (path, brief) => glrTableText(path, brief, api.log));
  api.registerCap('glr.run', (path, srcs, countOnly) => glrRunText(path, srcs, countOnly, api.log));
}
