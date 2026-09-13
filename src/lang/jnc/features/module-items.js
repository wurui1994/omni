// src/lang/jnc/features/module-items.js —— 特性：模块级条目与语句（import / pragma / using / extension / 局部量）
//
// 这一份是"位置感最强"的一族：同一种要素在模块那一层是常态、在类体里是错、在函数体里各有各的账。

import { feature } from '../../../core/frontend-engine/feature.js';

const INNER = ['class-body', 'opaque-class-body'];

export default feature({
  name: 'module-items',
  doc: 'import / pragma / using namespace / extension / 局部量',
  accounts: {
    'S-001': { text: '结构体字段的默认值', why: '那一格在 jancy 那边是构造里重放的，而结构体没有构造那条路' },
    'S-004': {
      text: '写在函数体里的 `using namespace X;`',
      why: '它的作用域是这个块，要一张跟着作用域一起进出的表（第 217 刀那条界；Phase 2 的 scope graph 一并解决）',
    },
    'S-005': {
      text: '（量法）`import "…"` 那一格量不出来',
      why: '探针没给 `-I`，所以那一句报"找不着"——**这不是语言的账**，是矩阵这把尺子自己的边界。'
        + '真要量它得给探针一格 imports/ 目录（与 tests/jnc/cases/imports 同一套）',
    },
  },
  positions: [
    // import：模块与命名空间那一层是常态（这儿是**量法**的边界，见 S-005）
    { kind: 'import', sorts: ['module', 'namespace'], verdict: 'todo', note: 'S-005：探针没给 -I' },
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
  ],
});
