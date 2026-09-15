// tests/graph/cases.js —— **例子表：语言 × 家族**（`run.js` 与 `delete.js` 共用一份）
//
// 抽出来的理由只有一条：**同一张表要被两条判据用**。
//   * `run.js`    —— 语言 × 后端的矩阵（输出逐行相同）
//   * `delete.js` —— **可删除测试**（删掉一格节点，不用它的例子必须照旧全绿）
// 抄两份的话，加一门语言就要改两处，而其中一处一定会忘。

import { node, lit, program, bin } from '../../src/core/graph/graph.js';
import { chezToGraph } from '../../ext/chez/tograph.js';
import { luaToGraph } from '../../ext/lua/tograph.js';
import { goToGraph } from '../../ext/go/tograph.js';
import { sbclToGraph } from '../../ext/sbcl/tograph.js';
import { vlangToGraph } from '../../ext/vlang/tograph.js';
import { awkToGraph } from '../../ext/awk/tograph.js';
import { fbToGraph } from '../../ext/freebasic/tograph.js';
import { mojoToGraph } from '../../ext/mojo/tograph.js';
import { nimToGraph } from '../../ext/nim/tograph.js';

/**
 * 期望的输出。**一个例子家族一份**，家族里所有语言、所有后端共用 ——
 * 这就是这一格的全部判据。
 *   basics  ：第一批节点（decl / func / 控制流 / 循环 / print）
 *   multi   ：多值那两格（values / pick）+ arity 契约（列表里只有最后一格展开）
 *   defer   ：scope-exit —— 逆序 + 早退也跑
 *   record  ：record-new / field-get / field-set（**与类型无关**）
 *   index   ：list-new / index-get / index-set（下标起点是语言的事）
 *   loopexit：break / continue（函数边界之外的第一格 may-early-exit）
 *   intmath ：**四条腿都跑得动的那个子集**
 */
export const BASICS = ['15', '120', '7', 'ok'];
export const MULTI = ['3', '7', '1 2'];
export const DEFER = ['in', 'b', 'a', 'out'];
export const RECORD = ['1', '5', '6'];
export const INDEX = ['10', '30', '45'];
export const LOOPEXIT = ['12', '6', '8'];
export const INTMATH = ['15', '120'];

const C = (name, grammar, file, toGraph, expect) => ({ name, grammar, file, toGraph, expect });

const G = {
  chez: ['ext/chez/chez.grammar', chezToGraph, 'ss'],
  lua: ['ext/lua/lua.grammar', luaToGraph, 'lua'],
  go: ['ext/go/go.grammar', goToGraph, 'go'],
  sbcl: ['ext/sbcl/sbcl.grammar', sbclToGraph, 'lisp'],
  vlang: ['ext/vlang/vlang.grammar', vlangToGraph, 'v'],
  awk: ['ext/awk/awk.grammar', awkToGraph, 'awk'],
  freebasic: ['ext/freebasic/freebasic.grammar', fbToGraph, 'bas'],
  mojo: ['ext/mojo/mojo.grammar', mojoToGraph, 'mojo'],
  nim: ['ext/nim/nim.grammar', nimToGraph, 'nim'],
};

/**
 * 一格例子 = 一门语言 × 一个家族。文件名是**算出来的**
 * （`ext/<lang>/examples/<家族>.<后缀>`）—— 那条命名约定因此不许破，破了当场报"文件没有"。
 */
const fam = (family, expect, langs) => langs.map((lang) => {
  const [grammar, toGraph, ext] = G[lang];
  return C(family === 'basics' ? lang : `${lang}+${family}`,
    grammar, `ext/${lang}/examples/${family}.${ext}`, toGraph, expect);
});

const ALL = Object.keys(G);

export const CASES = [
  // 第一个家族：含全部基础要素的完整例子（九门全有）
  ...fam('basics', BASICS, ALL),
  // 第二个家族：多值（生产侧 values / 消费侧一串 pick）
  ...fam('multi', MULTI, ['lua', 'go']),
  // 第三个家族：作用域出口（go/V/nim 的 defer 与 CL 的 unwind-protect 同一格节点）
  ...fam('defer', DEFER, ['go', 'sbcl', 'vlang', 'nim']),
  // 第四个家族：记录（四门语言四种字面量记号，落同一格 record-new）
  ...fam('record', RECORD, ['go', 'lua', 'vlang', 'nim']),
  // 第五个家族：列表与下标（七个提供者 —— 两门 Lisp 的向量写起来像函数调用）
  ...fam('index', INDEX, ['go', 'lua', 'vlang', 'nim', 'chez', 'sbcl', 'mojo']),
  // 第六个家族：循环的早退（break / continue 落同一格，差的只有 kind；lua 只有 break）
  ...fam('loopexit', LOOPEXIT, ['go', 'lua', 'vlang', 'nim', 'mojo']),
  // 第七个家族：**四条腿都跑得动的那个子集**（只有整数 / 函数 / if / while）
  ...fam('intmath', INTMATH, ALL),
];

/**
 * 手搭的图（不经过任何一门语言）—— 检的是**调度器自己的语义**。
 * 每一条都要有理由说明"为什么不写成语言例子"，否则它该是一份 `examples/`。
 */
const say = (s) => node('prim', { args: [lit(s)] }, { name: 'print' });
export const HAND = [
  {
    // break **穿过一格 region**：途中那格 region 的出口（scope-exit）照跑。
    // 不写成语言例子的理由：go / V 的 defer 是函数作用域、nim 的是块作用域，
    // 而图上挂的是"最近的一格 region" —— 拿谁的语法当例子都会写歪一门的语义。
    name: 'hand+break-exit',
    expect: ['in', 'cleanup', 'out'],
    graph: () => program([
      node('loop', {
        cond: lit(true),
        body: [node('region', {
          body: [
            node('scope-exit', { action: [say('cleanup')] }),
            say('in'),
            node('loop-exit', {}, { kind: 'break' }),
          ],
        })],
      }),
      say('out'),
    ]),
  },
  {
    // continue **照跑步进**（`post` 端口那一条）。语言例子里 go 那份也压到了，
    // 这一条把它单独钉住：步进缀在体末尾的老写法在这儿是死循环。
    name: 'hand+continue-post',
    expect: ['0', '2', 'done'],
    graph: () => program([
      node('bind', { init: lit(0) }, { name: 'i' }),
      node('loop', {
        cond: bin('<', node('ref', {}, { name: 'i' }), lit(3)),
        body: [node('branch', {
          cond: bin('=', node('ref', {}, { name: 'i' }), lit(1)),
          then: [node('loop-exit', {}, { kind: 'continue' })],
        }), node('prim', { args: [node('ref', {}, { name: 'i' })] }, { name: 'print' })],
        post: [node('set', { value: bin('+', node('ref', {}, { name: 'i' }), lit(1)) }, { name: 'i' })],
      }),
      say('done'),
    ]),
  },
];
