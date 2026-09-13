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
    'F-006': {
      text: '字段 / 全局的初值里写**构造式转换**（`T(实参…)`，两边不是同一个类型）',
      say: "'{name}' 是一格类型，`类型(实参…)` 是 jancy 的**构造式转换**"
        + '（要按目标类型挑一条转换，与 `(类型)值` 那种写法同一件事）—— 这一层只收 `(类型)值` 那一种',
      match: '构造式转换',
      why: '`T v = T(实参…)`（两边同型）那一种已经落了 —— 它就是就地构造（见 localDecl 那一段）。'
        + '剩下的是**真的转换**：`string_t(p, len)` 那一族（榜上量到 128 处）要按目标类型挑一条'
        + '转换，那与 `(类型)值` 是同一件事的另一半',
    },
    'F-007': {
      text: '`weak` 指针',
      say: '`weak` 指针 —— jancy 那儿它是另一种指针（ClassPtrKind_Weak / FunctionPtrKind_Weak /'
        + ' PropertyPtrKind_Weak，jnc_ct_DeclTypeCalc.cpp:667/676/688），GC 收了对象之后它自己'
        + '变 null；这一层没有 GC，收下不看会让 `if (p)` 永远为真',
      match: 'weak',
      why: '要 GC 才有"自己变 null"这件事 —— 与 destruct（M-002）同一族的账',
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
    /* 泛型实例当表达式用（G-001 那一刀之后）：语法收了，于是这一列量出来分了家 ——
       函数体里那一格**收了**（`T v = T(实参…)` 就是就地构造），别的位置各落在自己那笔账上。 */
    { kind: 'template-ctor-expr', sorts: ['fn-body'], verdict: 'ok' },
    {
      kind: 'template-ctor-expr',
      sorts: ['module', 'namespace', 'class-body', 'opaque-class-body'],
      verdict: 'refuse',
      account: 'F-006',
    },
    { kind: 'template-ctor-expr', sorts: ['struct-body'], verdict: 'refuse', account: 'S-001' },
    { kind: 'template-ctor-expr', sorts: ['union-body'], verdict: 'syntax' },
    { kind: 'template-ctor-expr', sorts: ['property-body'], verdict: 'refuse', account: 'P-007' },
    { kind: 'template-ctor-expr', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
    /* 带初值的 static 字段（矩阵后加的一列）：与别的字段同一列；union 里**语法就不认**
       （那一格要 `(union …)` 的成员形状）。 */
    /* weak 指针字段（矩阵后加的一列）：整行还不收（F-007，要 GC）。 */
    {
      kind: 'field-weak-ptr',
      sorts: [...ALL, 'opaque-class-body'].filter((x, i, a) => a.indexOf(x) === i),
      verdict: 'refuse',
      account: 'F-007',
    },
    { kind: 'field-weak-ptr', sorts: ['property-body'], verdict: 'refuse', account: 'P-004' },
    { kind: 'field-weak-ptr', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
    { kind: 'field-static-init', sorts: PLAIN, verdict: 'ok' },
    /* union 里的 `static` 字段：语法那一层也有话说（成员上写不了初值），可这一刀之后
       降级那一遍先拒（T-003）—— 两条诊断都在，分类器取的是后者。 */
    { kind: 'field-static-init', sorts: ['union-body'], verdict: 'refuse', account: 'T-003' },
    { kind: 'field-static-init', sorts: ['property-body'], verdict: 'refuse', account: 'P-004' },
    { kind: 'field-static-init', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
    { kind: 'field-thin-ptr', sorts: PLAIN, verdict: 'ok', trace: true },
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
    /* `static` 的那一格从 ALL 里拿出来单说：union 里它先前也是**悄悄降错**（`static` 被丢掉，
       降成一格进重叠区的普通字段 —— 而静态成员根本不在那段存储里）。 */
    /* `trace`（第三问，见 positions.js 的 diff）：模块 / 命名空间那两层上 `static` 与不写它
       降出来一样（两种都是一格全局）—— **丢了是对的**；类 / 结构体 / opaque / 函数体里那几格
       留了痕（静态成员不在实例里）。 */
    {
      kind: 'field-static',
      sorts: ['module', 'namespace'],
      verdict: 'ok',
      trace: false,
    },
    {
      kind: 'field-static',
      sorts: ALL.filter((x) => x !== 'union-body' && x !== 'module' && x !== 'namespace'),
      verdict: 'ok',
      trace: true,
    },
    { kind: 'field-static', sorts: ['union-body'], verdict: 'refuse', account: 'T-003' },
    { kind: 'field-static', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
    { kind: 'field-static', sorts: ['property-body'], verdict: 'refuse', account: 'P-004' },
    /* `const` 只在编译期管事、`bigendian` 的痕迹在**访问点**上（探针只声明不读它）——
       两个都**不留痕**，而且那是对的。 */
    ...['field-const', 'field-bigendian'].flatMap((kind) => [
      { kind, sorts: ALL, verdict: 'ok', trace: false },
      { kind, sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
      { kind, sorts: ['property-body'], verdict: 'refuse', account: 'P-004' },
    ]),
    ...['field-int'].flatMap((kind) => [
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
