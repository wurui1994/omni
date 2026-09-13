// ext/luajit/lang.js —— 另一张增量表：本机这台 LuaJIT 的短函数语法 `|x| -> e`
//
// 为什么会有这一份：给 gsl-shell 那张增量表找外部尺子时发现，**本机的 luajit 是另一种方言** ——
//
//   $ luajit -e 'local f = |x| x'        →  luajit: '->' expected near 'x'
//   $ luajit -e 'local f = |x| -> x  print(f(3))'  →  3
//
// 也就是说：`|参数|` 后面要一个 `->`。gsl-shell 自带的那支 LuaJIT（`GSH_SHORT_FSYNTAX`，
// 见 ../gsl-shell/lang.js 的出处）**没有**那个箭头。两支方言差一个记号。
//
// 于是这一份的用处有两层：
//   1. 它让"加一门方言 = 加一张增量表"这句话被**外部尺子**验过一次（本机 luajit 就是尺子，
//      `node ext/lua/tests/gen.js --luajit` 全格一致）；
//   2. 它把 gsl-shell 那张表"本机量不了"这件事说清楚：不是我没量，是尺子讲的是别的方言。

import { extend, luaLang } from '../lua/lang.js';
import { h, nm } from '../lua/nodes.js';

/** `|x, y| -> expr`：与 gsl-shell 的差别只有中间那个箭头。 */
export const LUAJIT_NODES = [
  {
    name: 'lambda',
    of: 'exp',
    syn: ['|', nm('names', { min: 0, vararg: true }), '|', '->', h('body')],
    sugarOf: 'function-exp',
  },
];

export const luajitLang = extend(luaLang, {
  name: 'luajit',
  doc: 'LuaJIT 2.1（本机这支）：短函数 `|x| -> e`',
  punct: ['|', '->'],
  nodes: LUAJIT_NODES,
});
