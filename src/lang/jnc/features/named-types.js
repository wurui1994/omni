// src/lang/jnc/features/named-types.js —— 特性：带体的命名类型（struct / class / union / enum / typedef）
//
// **这一份就是本次质疑那句话的答案**："写在函数体里的 struct" 不是一次性发现，是下面
// `fn-body` 这一列上并排的几格。第 219（typedef）、250（enum）、260（struct）三刀补的是
// 其中三格；表在这儿之后，剩下哪几格还没补是**读出来**的。

import { feature } from '../../../core/frontend-engine/feature.js';

/** 这几种要素在这些位置上一律收：名字提到"外面那层命名空间"（代价见 T-005）。 */
const OK = ['module', 'namespace', 'class-body', 'struct-body', 'opaque-class-body', 'fn-body'];
const NAMED = ['struct', 'union-named', 'class', 'enum', 'enum-anon', 'enum-bitflag',
  'typedef', 'typedef-fn', 'typedef-fnptr'];

export default feature({
  name: 'named-types',
  doc: '带体的命名类型：struct / class / 带名字的 union / enum（含无名与 bitflag）/ typedef 那一族',
  accounts: {
    'T-001': {
      text: '结构体里除字段以外的成员',
      say: '结构体里除字段以外的成员',
      why: '结构体这一层还不是"一层命名空间"的全部 —— import / pragma / using / extension 那几种要它',
    },
    'T-002': { text: '类里除字段以外的成员', say: '类里除字段以外的成员', why: '同 T-001，位置不同' },
    'T-003': {
      text: 'union 体里除字段与匿名 struct 以外的成员',
      say: 'union 体里除字段与匿名 struct 以外的成员',
      why: '第 253/254 刀从这一列里挖出了方法与 alias 两格；剩下的还在这句话下面',
    },
    'T-004': {
      text: 'extension 体里除带体的方法以外的成员',
      say: 'extension 体里除带体的方法以外的成员',
      why: 'jancy 的 extension 只加方法（第 107 刀）',
    },
    'T-005': {
      text: '（代价，不是拒绝）体里声明的类型，名字提到外面那层命名空间',
      why: '第 219/250/260 刀那三格共同的代价：函数外面也用得上它（拒得更松）、'
        + '同一层里两个函数各写一条同名的会撞（拒得更严）。真按作用域收要 scope graph（Phase 2）',
    },
  },
  positions: [
    ...NAMED.flatMap((kind) => [
      { kind, sorts: OK, verdict: 'ok', note: kind === 'typedef' ? 'T-005 的代价' : '' },
      { kind, sorts: ['union-body'], verdict: 'refuse', account: 'T-003' },
      { kind, sorts: ['property-body'], verdict: 'refuse', account: 'P-005' },
      { kind, sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
    ]),
    /* 匿名 union 只在结构体的体里写得出来（第 110 刀）—— 别的位置**语法就不认**。
       `syntax` 与 `refuse` 是两回事：前者是规格（这门语言里写不出来），后者是我们欠的账。 */
    { kind: 'union-anon', sorts: ['struct-body'], verdict: 'ok' },
    {
      kind: 'union-anon',
      sorts: ['module', 'namespace', 'class-body', 'opaque-class-body', 'fn-body'],
      verdict: 'syntax',
    },
    { kind: 'union-anon', sorts: ['union-body'], verdict: 'refuse', account: 'T-003' },
    { kind: 'union-anon', sorts: ['property-body'], verdict: 'refuse', account: 'P-005' },
    { kind: 'union-anon', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
  ],
});
