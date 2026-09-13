// src/lang/jnc/features/props.js —— 特性：属性 / 事件 / 反应器 / alias
//
// 这四种在 jancy 里是**互相咬合**的一族（bindable 属性要一格事件、reactor 绑的是属性与事件），
// 所以它们在一个特性里；`requires` 写着 `fields` —— autoget 那一格存储就是一格字段。

import { feature } from '../../../core/frontend-engine/feature.js';

const CLASSY = ['module', 'namespace', 'class-body', 'opaque-class-body'];

export default feature({
  name: 'props',
  doc: '简单声明式属性 / 完整声明式属性 / bindable / 事件 / reactor / alias',
  requires: ['fields', 'members'],
  binding: {
    names: {
      prop: { store: 'props', doc: '属性名' },
      /* `keep` 是这一类自己的过滤：顶层那些 reactor（`cls === null`）—— 查名要在
         **走作用域链的时候**就把类里那些挑掉，所以它是名字类的一部分，不是调用点的后处理。 */
      'reactor-top': { store: 'reactors', keep: (v) => v.cls === null, doc: '顶层的 reactor' },
    },
  },
  accounts: {
    'P-001': {
      text: '结构体的成员属性上的 `autoget` / `bindable`',
      say: "结构体的成员属性 '{name}' 上的 '{mod}'（那一格要往结构体里加一格字段 / 一格事件，"
        + '而属性这一遍排在字段表定下来之后）',
      why: '那一格要往结构体里加一格字段 / 一格事件，而属性这一遍排在字段表定下来之后',
    },
    'P-002': {
      text: '结构体里的事件',
      say: "结构体里的事件 '{name}'（那一格要在造出来的时候把单子建起来，"
        + '而这一层的结构体没有构造那条路）',
      why: '那一格要在造出来的时候把单子建起来，而这一层的结构体没有构造那条路',
    },
    'P-003': {
      text: '函数体里的属性声明',
      say: '函数体里的属性声明（属性指针要一格"属性指针"类型）',
      why: '属性指针要一格"属性指针"类型（方言里还没有）',
    },
    'P-004': {
      text: '完整声明式的属性体里的这一条 —— 字段要写 `autoget`、事件要写 `bindable event`',
      say: "完整声明式的属性 '{name}' 体里的这一条 —— 字段要写 `autoget`、事件要写"
        + ' `bindable event`（prop_full.rst:34）',
      why: 'prop_full.rst:34',
    },
    'P-005': {
      text: '完整声明式的属性体里的这一条 —— 只收带体的 get / set 与 `autoget` 的字段 / `bindable` 的事件',
      say: "完整声明式的属性 '{name}' 体里的这一条 —— 只收带体的 get / set 与"
        + '`autoget` 的字段 / `bindable` 的事件（prop_full.rst:34）',
      why: 'prop_full.rst:34',
    },
    'P-006': {
      text: '完整声明式的属性里那条 alias 上既没有 get 也没有 set',
      say: "完整声明式的属性 '{name}' 里那条 alias 上既没有 'bindable' 也没有"
        + " 'autoget'（属性体里的 alias 只有这两种意思，jnc_ct_Parser.cpp:1354-1361）",
      why: '属性体里的 alias 只有这两种意思（jnc_ct_Parser.cpp:1354-1361）',
    },
    'P-007': { text: '这种类型说明符', say: '这种类型说明符', why: '见 fields（R5：这句话没位置）' },
  },
  positions: [
    // 简单声明式（autoget / bindable autoget）：类那一族与 union 收，结构体那一格欠着
    ...['property-simple', 'property-bindable'].flatMap((kind) => [
      { kind, sorts: [...CLASSY, 'union-body'], verdict: 'ok' },
      { kind, sorts: ['struct-body'], verdict: 'refuse', account: 'P-001' },
      { kind, sorts: ['fn-body'], verdict: 'refuse', account: 'P-003' },
      { kind, sorts: ['property-body'], verdict: 'refuse', account: 'P-007' },
      { kind, sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
    ]),
    /* 完整声明式（`int property p { get {…} set(int v) {…} }`）：整行都还没落 ——
       量出来落在 P-007 那句没位置的话上，那正是**下一刀该修的措辞**。 */
    {
      kind: 'property-full',
      sorts: ['module', 'namespace', 'class-body', 'struct-body', 'opaque-class-body', 'extension-body'],
      verdict: 'refuse',
      account: 'P-007',
    },
    { kind: 'property-full', sorts: ['union-body'], verdict: 'refuse', account: 'T-003' },
    { kind: 'property-full', sorts: ['fn-body'], verdict: 'refuse', account: 'S-002' },
    { kind: 'property-full', sorts: ['property-body'], verdict: 'refuse', account: 'P-005' },
    // 事件：类那一族与 union 收（第 83 刀）
    { kind: 'event', sorts: [...CLASSY, 'union-body'], verdict: 'ok' },
    { kind: 'event', sorts: ['struct-body'], verdict: 'refuse', account: 'P-002' },
    { kind: 'event', sorts: ['fn-body'], verdict: 'refuse', account: 'S-003' },
    { kind: 'event', sorts: ['property-body'], verdict: 'refuse', account: 'P-007' },
    { kind: 'event', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
    // reactor（第 85/95 刀）
    {
      kind: 'reactor',
      sorts: ['module', 'namespace', 'class-body', 'struct-body', 'opaque-class-body', 'extension-body'],
      verdict: 'ok',
    },
    { kind: 'reactor', sorts: ['union-body'], verdict: 'refuse', account: 'T-003' },
    { kind: 'reactor', sorts: ['fn-body'], verdict: 'refuse', account: 'S-002' },
    { kind: 'reactor', sorts: ['property-body'], verdict: 'refuse', account: 'P-005' },
    // alias（第 87/102/254 刀）：顶层、类、结构体、union 都收；函数体里那一格认错人
    { kind: 'alias-method', sorts: ['module'], verdict: 'ok' },
    {
      kind: 'alias-method',
      sorts: ['namespace', 'class-body', 'struct-body', 'union-body', 'opaque-class-body'],
      verdict: 'ok',
      escapes: false,
    },
    /* 函数体里的 alias：第二百六十二刀落了（矩阵 A-001 那一格挑出来的第一刀）。
       代价与体里的 typedef / enum / struct 同一笔（T-005：名字提到外面那层）。 */
    { kind: 'alias-method', sorts: ['fn-body'], verdict: 'ok', escapes: true, note: 'T-005 的代价' },
    { kind: 'alias-method', sorts: ['property-body'], verdict: 'refuse', account: 'P-006' },
    { kind: 'alias-method', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
  ],
});
