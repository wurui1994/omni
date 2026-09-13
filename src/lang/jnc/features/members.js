// src/lang/jnc/features/members.js —— 特性：方法 / 构造 / 析构 / 算符
//
// 这一份里有两格**认错人**的账（M-006、S-002），它们是矩阵 E 那一栏挑出来的下一刀：
// 位置矩阵把"话说错了"与"确实不收"分开了 —— 前者是 bug，后者是账。

import { feature } from '../../../core/frontend-engine/feature.js';

const TYPES = ['module', 'namespace', 'class-body', 'struct-body', 'opaque-class-body'];
const OWNERS = ['class-body', 'struct-body', 'opaque-class-body', 'extension-body'];

export default feature({
  name: 'members',
  doc: '带体的方法 / 只有原型的方法（宿主面）/ static 方法 / errorcode 方法 / construct / destruct / 算符',
  requires: ['named-types'],
  /* 名字类（见 named-types 那份的注）：函数那一族。`method` 与 `proto-fn` 分开是因为
     语料里真有"要自由函数、不要方法"那种问法（find(nm, ['fn'], ['method'])）。 */
  binding: {
    names: {
      fn: { store: 'fns', doc: '函数全名 -> 签名' },
      method: { store: 'methods', doc: '其中属于某个类 / 结构体的那些' },
      'proto-fn': { store: 'protoFns', doc: '只有原型的那些（宿主面，ADR-0022 J4b）' },
    },
  },
  accounts: {
    'M-001': {
      text: '结构体里的 `static construct` / `destruct`',
      say: "结构体里的 '{what}'{note}",
      why: 'static construct 要一道 once 闸门；destruct 要作用域出口那一套钩子',
    },
    'M-002': {
      text: '`destruct` —— jancy 那边它是 GC 在**不确定的时刻**调的',
      say: "'{what}' —— jancy 那边它是 GC 在**不确定的时刻**调的（disposable.rst:17），"
        + '要确定时机得先有 dispose/nestedscope 那一套',
      match: '不确定的时刻',
      why: 'disposable.rst:17；要确定时机得先有 dispose / nestedscope 那一套',
    },
    'M-003': {
      text: '算符重载 `operator +` 那一族',
      say: "算符重载 '{what}'",
      why: '第 130~139 刀收了一部分，这一格是剩下的',
    },
    'M-004': {
      text: '`construct` 只能是类或结构体的成员（写在体里，或写成 `C.construct()`）',
      say: "'{what}' 只能是类或结构体的成员（写在体里，或写成 '{owner}.construct()'）",
      match: '只能是类或结构体的成员（写在体里，或写成',
      why: '这一句是**对的**（jancy 同），不是欠账 —— error 那一栏也有正确答案',
    },
    'M-005': {
      text: '`operator :=` 只能是类或结构体的成员（写在体里）',
      say: "'operator :=' 只能是类或结构体的成员（写在体里）",
      match: '只能是类或结构体的成员（写在体里）',
      why: '同 M-004',
    },
    'M-007': {
      text: '`virtual` / `abstract` 只能写在**类**的方法上（type_class.rst:178）',
      say: "'{what}' 只能写在类的方法上（type_class.rst:178）",
      match: '只能写在类的方法上',
      why: '这一句是**对的**（jancy 同）：虚派发要对象头那一格类型标签，只有类有',
    },
    'M-008': {
      text: '结构体的方法上写 `virtual` 那一族',
      say: "结构体的方法 '{name}' 上写 '{mod}'（虚派发要对象头那一格类型标签，结构体没有）",
      match: '结构体的方法',
      why: '同 M-007，只是位置不同（这一格话说得更准：点名了是结构体）',
    },
    'S-002': {
      text: '语句 `…`（函数体里的成员声明落到这句兜底上）',
      say: "语句 '{h}'",
      match: /^语句 /,
      why: '**话不够准**：体里写 construct / operator / reactor / 带体方法时，该按要素说清'
        + '（"函数体里写不了这一种成员"），而不是报一句"认不出的语句"',
    },
    'S-003': {
      text: '函数体里的 `名字(…)`：要么是一格**函数原型**，要么是"局部量后面挂构造实参"',
      say: "函数体里的这一条 '{name}(…)'：要么是一格**函数原型**"
        + '（jancy 的函数体里写不了原型 —— 那要一层"块作用域也是命名空间"），'
        + '要么是"局部量后面挂构造实参"（`T v(a, b)`，那一种只有类与结构体的变量收得下）',
      match: '函数体里的这一条',
      why: '这两种在语法上撞在一起（第二百六十二刀把话改成同时说两种读法）：函数体里写原型要一层'
        + '"块作用域也是命名空间"；`T v(a, b)` 那一种只有类与结构体的变量收得下',
    },
  },
  positions: [
    // 带体的方法 / static 方法：类与结构体收，extension 也收（那正是 extension 的用处）
    ...['method-body', 'method-static'].flatMap((kind) => [
      { kind, sorts: [...TYPES, 'extension-body'], verdict: 'ok' },
      { kind, sorts: ['union-body'], verdict: 'refuse', account: 'T-003' },
      { kind, sorts: ['fn-body'], verdict: 'refuse', account: 'S-002' },
      { kind, sorts: ['property-body'], verdict: 'refuse', account: 'P-005' },
    ]),
    // 只有原型的方法（宿主面，ADR-0022 的 J4b）：union 里那一格是第 253 刀收的
    { kind: 'method-proto', sorts: [...TYPES, 'union-body'], verdict: 'ok' },
    { kind: 'method-proto', sorts: ['fn-body'], verdict: 'refuse', account: 'S-003' },
    { kind: 'method-proto', sorts: ['property-body'], verdict: 'refuse', account: 'P-007' },
    { kind: 'method-proto', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
    // errorcode 的原型：同上；函数体里那一格是**认错人**
    { kind: 'method-errorcode', sorts: [...TYPES, 'union-body'], verdict: 'ok' },
    { kind: 'method-errorcode', sorts: ['fn-body'], verdict: 'refuse', account: 'S-003' },
    { kind: 'method-errorcode', sorts: ['property-body'], verdict: 'refuse', account: 'P-004' },
    { kind: 'method-errorcode', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
    // construct（无参 / 带参）：类与结构体的体里收，顶层要写成 `C.construct()`
    ...['construct', 'construct-args'].flatMap((kind) => [
      { kind, sorts: OWNERS, verdict: 'ok' },
      { kind, sorts: ['module', 'namespace'], verdict: 'error', account: 'M-004' },
      { kind, sorts: ['union-body'], verdict: 'refuse', account: 'T-003' },
      { kind, sorts: ['fn-body'], verdict: 'refuse', account: 'S-002' },
      { kind, sorts: ['property-body'], verdict: 'refuse', account: 'P-005' },
    ]),
    { kind: 'static-construct', sorts: ['class-body', 'opaque-class-body', 'extension-body'], verdict: 'ok' },
    { kind: 'static-construct', sorts: ['struct-body'], verdict: 'refuse', account: 'M-001' },
    { kind: 'static-construct', sorts: ['module', 'namespace'], verdict: 'error', account: 'M-004' },
    { kind: 'static-construct', sorts: ['union-body'], verdict: 'refuse', account: 'T-003' },
    { kind: 'static-construct', sorts: ['fn-body'], verdict: 'refuse', account: 'S-002' },
    { kind: 'static-construct', sorts: ['property-body'], verdict: 'refuse', account: 'P-005' },
    // destruct：整行都还不收（GC 时机那笔账）
    {
      kind: 'destruct',
      sorts: ['module', 'namespace', 'class-body', 'opaque-class-body', 'extension-body'],
      verdict: 'refuse',
      account: 'M-002',
    },
    { kind: 'destruct', sorts: ['struct-body'], verdict: 'refuse', account: 'M-001' },
    { kind: 'destruct', sorts: ['union-body'], verdict: 'refuse', account: 'T-003' },
    { kind: 'destruct', sorts: ['fn-body'], verdict: 'refuse', account: 'S-002' },
    { kind: 'destruct', sorts: ['property-body'], verdict: 'refuse', account: 'P-005' },
    // 算符：`operator +` 那一族还不收；`operator :=` 收（第 151/242 刀）
    {
      kind: 'operator-add',
      sorts: ['module', 'namespace', 'class-body', 'struct-body', 'opaque-class-body', 'extension-body'],
      verdict: 'refuse',
      account: 'M-003',
    },
    { kind: 'operator-add', sorts: ['union-body'], verdict: 'refuse', account: 'T-003' },
    { kind: 'operator-add', sorts: ['fn-body'], verdict: 'refuse', account: 'S-002' },
    { kind: 'operator-add', sorts: ['property-body'], verdict: 'refuse', account: 'P-005' },
    { kind: 'operator-assign', sorts: OWNERS, verdict: 'ok' },
    { kind: 'operator-assign', sorts: ['module', 'namespace'], verdict: 'error', account: 'M-005' },
    { kind: 'operator-assign', sorts: ['union-body'], verdict: 'refuse', account: 'T-003' },
    { kind: 'operator-assign', sorts: ['fn-body'], verdict: 'refuse', account: 'S-002' },
    { kind: 'operator-assign', sorts: ['property-body'], verdict: 'refuse', account: 'P-005' },
    /* `virtual` 的方法（矩阵后加的一列）：类那一族与 extension 收；顶层那两格是**对的错**
       （M-007，jancy 同）；结构体那一格话说得更准（M-008）。 */
    {
      kind: 'method-virtual',
      sorts: ['class-body', 'opaque-class-body', 'extension-body'],
      verdict: 'ok',
    },
    { kind: 'method-virtual', sorts: ['module', 'namespace'], verdict: 'error', account: 'M-007' },
    { kind: 'method-virtual', sorts: ['struct-body'], verdict: 'refuse', account: 'M-008' },
    { kind: 'method-virtual', sorts: ['union-body'], verdict: 'refuse', account: 'T-003' },
    { kind: 'method-virtual', sorts: ['fn-body'], verdict: 'refuse', account: 'S-002' },
    { kind: 'method-virtual', sorts: ['property-body'], verdict: 'refuse', account: 'P-005' },
    /* `abstract` 的原型（同上）。两格账记在这儿：
       ① 顶层那两格**我们收了**，而 jancy 那边 abstract 只能在类里（type_class.rst:178）——
          这是一格**疑似洞**（量出来是 ✓，规格里照实记 ok + note，别假装它是对的）；
       ② 函数体里那一格报的是 M-007（"只能写在类的方法上"），可真身是"函数体里写了个原型"
          （S-003）—— **认错人**，下一刀的料。 */
    {
      kind: 'method-abstract',
      sorts: ['class-body', 'opaque-class-body'],
      verdict: 'ok',
    },
    /* 顶层那两格先前**收了**（一格洞：jancy 只允许类里写这三个词），这一刀补上 —— 与结构体 /
       union 那两格同一句话、同一个账号。 */
    {
      kind: 'method-abstract',
      sorts: ['module', 'namespace', 'struct-body', 'union-body'],
      verdict: 'error',
      account: 'M-007',
    },
    /* 这一格先前报的是 M-007（"只能写在类的方法上"）—— 认错人，真身是"函数体里写了个原型"。
       这一刀是**读表挑出来的**：矩阵新加那一列一量出来就摆在 E 那一栏里。 */
    { kind: 'method-abstract', sorts: ['fn-body'], verdict: 'refuse', account: 'S-003' },
    { kind: 'method-abstract', sorts: ['property-body'], verdict: 'refuse', account: 'P-004' },
    { kind: 'method-abstract', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
  ],
});
