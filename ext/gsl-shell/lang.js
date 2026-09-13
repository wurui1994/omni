// ext/gsl-shell/lang.js —— **增量表**：Lua 上加 gsl-shell 那点语法，一行不改 ext/lua
//
// 判据（ext/lua/DESIGN.md 第 9 节判据 2）：加一门方言 = 加一张增量表。这一份就是那张表，
// 它只做两件事：往标点表里加 `|`，往节点表里加 `lambda`。**解析器、写回器、作用域、值规则
// 一个字都不用改** —— 因为 `lambda` 的 `syn` 以字面记号 `|` 起头、`of: 'exp'`，
// 驱动器的 `SIMPLE` 索引自动收它。
//
// 出处（读的是 gsl-shell 自带的 LuaJIT 分支，不是猜的）：
//   luajit2/src/lj_parse.c:1905-1945  `#ifdef GSH_SHORT_FSYNTAX` 的 `parse_simple_body`
//                                     形参用 `parse_params_ext(ls, 0, '|', '|')` —— 与
//                                     `( )` 那套形参机器**同一份**（所以照样收 `...`）；
//                                     函数体是**一个表达式**，隐式 `return`（`PROTO_HAS_RETURN`）
//   luajit2/src/lj_parse.c:2086-2091  `expr_simple` 里 `case '|'` —— 它是**简单表达式**的一支，
//                                     所以 `|x| e` 能出现在任何表达式位置
//
// 顺手记一笔账：`1i`（虚数）先前被我列进这份增量，读源码后**撤回** —— 它在
// `luajit2/src/lj_strscan.c:421-425`，是 LuaJIT 带 FFI 时的数字文法，属于基语言。
// 语料尺子把这两样一起报成"不认"，是尺子在替我分辨"哪笔账记在谁头上"。

import { extend, luaLang } from '../lua/lang.js';
import { h, nm } from '../lua/nodes.js';

/** gsl-shell 的短函数语法：`|x, y| expr`（形参可空、可 `...`；体是单个表达式）。 */
export const GSL_NODES = [
  {
    name: 'lambda',
    of: 'exp',
    syn: ['|', nm('names', { min: 0, vararg: true }), '|', h('body')],
    // 语义上等于 `function(names) return body end`：一格参数表 + 一格隐式 return。
    // 作用域与值规则因此**不必新写**：`scope.js` 认的是"开一层并绑形参"，
    // `values.js` 认的是"体那一格是 return 的值" —— 两条都已经在 `funcbody` 上。
    sugarOf: 'function-exp',
    // **本机量不了这一格**：这台 luajit 讲的是另一种方言（`|x| -> e`，见 ../luajit/lang.js），
    // gsl-shell 自带的那支才是 `|x| e`，而它只有源码没编。所以 gen.js 的外部尺子跳过它，
    // 由语料尺子担着（`node ext/lua/tests/sweep.js --gsl` → 112/112）。这是一笔记明的账。
    noOracle: '本机 luajit 是 `|x| -> e` 那一支，量不了 `|x| e`',
  },
];

export const gslLang = extend(luaLang, {
  name: 'gsl-shell',
  doc: 'Lua + GSH_SHORT_FSYNTAX（`|x| e`）',
  punct: ['|'],
  nodes: GSL_NODES,
});
