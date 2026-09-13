// src/lang/jnc/features/fields.js —— 特性：字段（ADR-0029 的 L2 数据层）
//
// 一个特性 = 一束贡献。这一份只贡献**位置**与**账**两样（binding / types / lower 等到
// Phase 2~4 再填）。每一格的结论都由 `tests/lib/jnc-matrix.js --check` 与**实际行为**对账，
// 所以这张表不是文档，是可执行的规格：漂了就是一条测试失败。

import { feature } from '../../../core/frontend-engine/feature.js';

const ALL = ['module', 'namespace', 'class-body', 'struct-body', 'union-body',
  'opaque-class-body', 'fn-body'];
const PLAIN = ['module', 'namespace', 'class-body', 'struct-body', 'opaque-class-body', 'fn-body'];

export default feature({
  name: 'fields',
  doc: '一格字段：整数 / 字符串 / 数组 / static / const / bigendian / 类的指针与值',
  binding: { names: { global: { store: 'globals', doc: '模块级变量名 -> 类型' } } },
  accounts: {
    'F-001': {
      text: '这个位置上的位域（`: 位数` 只在结构体的字段上）',
      say: '这个位置上的位域（`: 位数` 只在结构体的字段上）',
      why: '位域是"几位挤在一格存储里"，而那格存储要按结构体的布局定下来（ADR-0016 第 112 刀）',
    },
    'F-002': {
      text: 'union 里的成员（只收整数 / 实数 / 布尔 / 枚举 / 另一个结构体）',
      say: "union 里的成员 '{name}'（只收整数 / 实数 / 布尔 / 枚举 / 另一个结构体 —— "
        + '指针、string 与数组那几种旁边还挂着表，重叠之后说不清归谁）',
      why: '指针、string 与数组那几种旁边还挂着表（ADR-0024/0026），重叠之后说不清归谁',
    },
    'F-004': {
      text: '不写长度、也没有花括号初值的数组（`int a[];`）',
      say: "'{name}' 的长度得从花括号初值数出来",
      match: '的长度得从花括号初值数出来',
      why: '这一句是**对的**（与 C 同）：`int a[]` 只有跟着 `= { … }` 时长度才数得出来',
    },
    'F-005': {
      text: '类 / 结构体的字段上不写长度的数组',
      say: "字段 '{name}' 的长度得写出来",
      match: '的长度得写出来',
      why: '同 F-004，位置不同：字段那一格的长度是**布局**的一部分，没有初值可数',
    },
    'F-003': {
      text: '结构体里放不下类的一格值',
      say: "结构体 '{owner}' 里放不下类 '{cls}' 的一格值（jancy 那边这一句就是错："
        + '`class … cannot be a struct member`，jnc_ct_StructType.cpp:303-307 —— '
        + '内嵌的对象只有类里才有）',
      match: '里放不下类',
      why: 'jancy 自己也报错：`class … cannot be a struct member`（jnc_ct_StructType.cpp:303-307）'
        + ' —— 内嵌的对象只有类里才有。这一格的 `error` 是**对的**，不是欠账',
    },
  },
  positions: [
    /* 后加的两列（矩阵是机械枚举，所以"表里少一种"本身就是账）：
       thin 指针字段 —— 与别的指针字段同一列；不写长度的数组字段 —— 两句**对的**错
       （F-004 / F-005，看位置分）。 */
    { kind: 'field-thin-ptr', sorts: PLAIN, verdict: 'ok' },
    { kind: 'field-thin-ptr', sorts: ['union-body'], verdict: 'refuse', account: 'F-002' },
    { kind: 'field-thin-ptr', sorts: ['property-body'], verdict: 'refuse', account: 'P-004' },
    { kind: 'field-thin-ptr', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
    {
      kind: 'field-array-dyn',
      sorts: ['module', 'namespace', 'fn-body'],
      verdict: 'error',
      account: 'F-004',
    },
    {
      kind: 'field-array-dyn',
      sorts: ['class-body', 'struct-body', 'opaque-class-body'],
      verdict: 'error',
      account: 'F-005',
    },
    { kind: 'field-array-dyn', sorts: ['union-body'], verdict: 'refuse', account: 'F-002' },
    { kind: 'field-array-dyn', sorts: ['property-body'], verdict: 'refuse', account: 'P-007' },
    { kind: 'field-array-dyn', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
    // 普通字段：除 union（表示宽度）与属性体 / extension 体（那两处各有自己的规矩）之外都收
    ...['field-int', 'field-static', 'field-const', 'field-bigendian'].flatMap((kind) => [
      { kind, sorts: ALL, verdict: 'ok' },
      { kind, sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
      {
        kind,
        sorts: ['property-body'],
        verdict: 'refuse',
        account: kind === 'field-int' ? 'P-007' : 'P-004',
      },
    ]),
    // string / 数组 / 类的指针：union 里那一格是 F-002（表示宽度那笔账）
    ...['field-string', 'field-array', 'field-class-ptr'].flatMap((kind) => [
      { kind, sorts: PLAIN, verdict: 'ok' },
      { kind, sorts: ['union-body'], verdict: 'refuse', account: 'F-002' },
      { kind, sorts: ['property-body'], verdict: 'refuse', account: 'P-007' },
      { kind, sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
    ]),
    // 位域：只在结构体的字段上
    { kind: 'field-bitfield', sorts: ['struct-body'], verdict: 'ok' },
    {
      kind: 'field-bitfield',
      sorts: ['module', 'namespace', 'class-body', 'union-body', 'opaque-class-body', 'fn-body'],
      verdict: 'refuse',
      account: 'F-001',
    },
    { kind: 'field-bitfield', sorts: ['property-body'], verdict: 'refuse', account: 'P-007' },
    { kind: 'field-bitfield', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
    // 类的**值**当字段：类里是内嵌对象（第 161 刀），结构体里 jancy 自己也拒
    {
      kind: 'field-class-value',
      sorts: ['module', 'namespace', 'class-body', 'opaque-class-body', 'fn-body'],
      verdict: 'ok',
    },
    { kind: 'field-class-value', sorts: ['struct-body'], verdict: 'error', account: 'F-003' },
    { kind: 'field-class-value', sorts: ['union-body'], verdict: 'refuse', account: 'F-002' },
    { kind: 'field-class-value', sorts: ['property-body'], verdict: 'refuse', account: 'P-007' },
    { kind: 'field-class-value', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
    /* 函数指针字段（矩阵后加的一列）：`int function* m_fnp(int);` —— 除 union（表示宽度那笔账）
       与属性 / extension 体之外都收。 */
    { kind: 'field-fnptr', sorts: PLAIN, verdict: 'ok' },
    { kind: 'field-fnptr', sorts: ['union-body'], verdict: 'refuse', account: 'F-002' },
    { kind: 'field-fnptr', sorts: ['property-body'], verdict: 'refuse', account: 'P-004' },
    { kind: 'field-fnptr', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
  ],
});
