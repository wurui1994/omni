// src/lang/jnc/features/module-items.js —— 特性：模块级条目与语句（import / pragma / using / extension / 局部量）
//
// 这一份是"位置感最强"的一族：同一种要素在模块那一层是常态、在类体里是错、在函数体里各有各的账。

import { feature } from '../../../core/frontend-engine/feature.js';

const INNER = ['class-body', 'opaque-class-body'];

export default feature({
  name: 'module-items',
  doc: 'import / pragma / using namespace / extension / 局部量',
  accounts: {
    'S-001': {
      text: '结构体字段的默认值',
      say: '结构体字段的默认值',
      why: '那一格在 jancy 那边是构造里重放的，而结构体没有构造那条路',
    },
    'S-006': {
      text: '`disposable`（jancy 那儿它给那一格开一个可弃作用域，出去时调 `dispose`）',
      say: '`disposable` 的局部量 —— jancy 那儿它给这一格开一个可弃作用域、出去的时候'
        + '（正常出去与抛出去都算）调它的 `dispose`（jnc_ct_Parser.cpp:2050-2068），'
        + '要作用域出口那一套钩子',
      match: 'disposable',
      why: '与 destruct（M-002）同一笔账：要作用域出口那一套钩子。**这一句现在认错人**：'
        + '`disposable class C { … }`（一格类声明）也落在它上面，可那不是局部量 —— '
        + '矩阵 `disposable-class` 那一列一量出来就摆在这儿（下一刀的料）',
    },
    'S-004': {
      text: '写在函数体里的 `using namespace X;`',
      say: '写在函数体里的 `using namespace X;` —— 它的作用域是这个块，要一张跟着作用域一起'
        + '进出的表（写在命名空间那一层的那一格收了，见 ADR-0016 第二百一十七刀）',
      why: '它的作用域是这个块，要一张跟着作用域一起进出的表（第 217 刀那条界；Phase 2 的 scope graph 一并解决）',
    },
    /* S-005 退役：那不是语言的账，是**尺子自己的洞**（探针没给 `-I`）。补上探针自合成的
       imports/ 与 `-I` 之后这两格量出来是 ok —— 账本上不该留一条"我量不了"当结论。 */
  },
  positions: [
    // import：模块与命名空间那一层是常态
    { kind: 'import', sorts: ['module', 'namespace'], verdict: 'ok' },
    { kind: 'import', sorts: INNER, verdict: 'refuse', account: 'T-002' },
    { kind: 'import', sorts: ['struct-body'], verdict: 'refuse', account: 'T-001' },
    { kind: 'import', sorts: ['union-body'], verdict: 'refuse', account: 'T-003' },
    { kind: 'import', sorts: ['fn-body'], verdict: 'refuse', account: 'S-002' },
    { kind: 'import', sorts: ['property-body'], verdict: 'refuse', account: 'P-005' },
    { kind: 'import', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
    // pragma / extension：模块与命名空间收，别处各有各的话
    ...['pragma', 'extension'].flatMap((kind) => [
      { kind, sorts: ['module', 'namespace'], verdict: 'ok' },
      { kind, sorts: INNER, verdict: 'refuse', account: 'T-002' },
      { kind, sorts: ['struct-body'], verdict: 'refuse', account: 'T-001' },
      { kind, sorts: ['union-body'], verdict: 'refuse', account: 'T-003' },
      { kind, sorts: ['fn-body'], verdict: 'refuse', account: 'S-002' },
      { kind, sorts: ['property-body'], verdict: 'refuse', account: 'P-005' },
      { kind, sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
    ]),
    // using namespace：模块与命名空间收（第 217 刀），函数体里那一格另有自己的话
    { kind: 'using-namespace', sorts: ['module', 'namespace'], verdict: 'ok' },
    { kind: 'using-namespace', sorts: INNER, verdict: 'refuse', account: 'T-002' },
    { kind: 'using-namespace', sorts: ['struct-body'], verdict: 'refuse', account: 'T-001' },
    { kind: 'using-namespace', sorts: ['union-body'], verdict: 'refuse', account: 'T-003' },
    { kind: 'using-namespace', sorts: ['fn-body'], verdict: 'refuse', account: 'S-004' },
    { kind: 'using-namespace', sorts: ['property-body'], verdict: 'refuse', account: 'P-005' },
    { kind: 'using-namespace', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
    /* 一格带初值的量：模块 / 命名空间 / 类体 / 函数体都是常态；结构体里那是"字段的默认值"；
       union 里**语法就不认**（那一格要 `(union …)` 的成员形状）。 */
    {
      kind: 'local-var',
      sorts: ['module', 'namespace', 'class-body', 'opaque-class-body', 'fn-body'],
      verdict: 'ok',
    },
    { kind: 'local-var', sorts: ['struct-body'], verdict: 'refuse', account: 'S-001' },
    { kind: 'local-var', sorts: ['union-body'], verdict: 'syntax' },
    { kind: 'local-var', sorts: ['property-body'], verdict: 'refuse', account: 'P-007' },
    { kind: 'local-var', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
    /* `dylib X { … }`（第二百〇三刀）：与 pragma / extension 同一列 —— 模块与命名空间那两层收。 */
    { kind: 'dylib', sorts: ['module', 'namespace'], verdict: 'ok' },
    { kind: 'dylib', sorts: INNER, verdict: 'refuse', account: 'T-002' },
    { kind: 'dylib', sorts: ['struct-body'], verdict: 'refuse', account: 'T-001' },
    { kind: 'dylib', sorts: ['union-body'], verdict: 'refuse', account: 'T-003' },
    { kind: 'dylib', sorts: ['fn-body'], verdict: 'refuse', account: 'S-002' },
    { kind: 'dylib', sorts: ['property-body'], verdict: 'refuse', account: 'P-005' },
    { kind: 'dylib', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
    /* `disposable class C { … }`：整行还不收，而且那句话**认错人**（说的是"局部量"）——
       见 S-006 的 why。 */
    {
      kind: 'disposable-class',
      sorts: ['module', 'namespace', 'class-body', 'struct-body', 'opaque-class-body',
        'extension-body'],
      verdict: 'refuse',
      account: 'S-006',
      note: '认错人：这是一格**类声明**，不是局部量',
    },
    { kind: 'disposable-class', sorts: ['union-body'], verdict: 'refuse', account: 'T-003' },
    { kind: 'disposable-class', sorts: ['fn-body'], verdict: 'refuse', account: 'S-002' },
    { kind: 'disposable-class', sorts: ['property-body'], verdict: 'refuse', account: 'P-005' },
  ],
});
