// src/lang/jnc/features/named-types.js —— 特性：带体的命名类型（struct / class / union / enum / typedef）
//
// **这一份就是本次质疑那句话的答案**："写在函数体里的 struct" 不是一次性发现，是下面
// `fn-body` 这一列上并排的几格。第 219（typedef）、250（enum）、260（struct）三刀补的是
// 其中三格；表在这儿之后，剩下哪几格还没补是**读出来**的。

import { feature } from '../../../core/frontend-engine/feature.js';

/** 这几种要素在这些位置上一律收：名字提到"外面那层命名空间"（代价见 T-005）。 */
const OK = ['module', 'namespace', 'class-body', 'struct-body', 'opaque-class-body', 'fn-body'];
/* 名字**留在写它那层**的那几个位置（`escapes: false`）与**漏到外面那层**的那一个
   （`fn-body`，就是 T-005 那笔代价）。这一列由 `tests/lib/jnc-matrix.js` 真量：
   把"用一下那个名字"塞进后面一个函数体里再编一遍，编得过就是漏了。
   `module` 那一格不声明 —— 它外面没有别的层，问不出这件事。 */
const KEEPS = ['namespace', 'class-body', 'struct-body', 'opaque-class-body'];
const NAMED = ['struct', 'union-named', 'class', 'enum', 'enum-anon', 'enum-bitflag',
  'typedef', 'typedef-fn', 'typedef-fnptr'];
/* 名字**由谁登记**（ADR-0029 Phase 3 的那一列）：`name` 是"名字先坐下"那一遍要调的，
   `body` 是解体那一遍。枚举与聚合各有一种机制，typedef 那一族只有体那一遍。
   `localTypeDecl` 读的就是这一列 —— 于是"函数体里能写哪几种类型声明"是这张表说的，
   不是那个函数里的一串 `if`（第 219 / 250 / 260 刀那三格就是一格一格补出来的）。 */
const REG = {
  enum: { name: 'enumName', body: 'enumDecl' },
  'enum-anon': { name: 'enumName', body: 'enumDecl' },
  'enum-bitflag': { name: 'enumName', body: 'enumDecl' },
  struct: { name: 'typeName', body: 'typeDecl' },
  'union-named': { name: 'typeName', body: 'typeDecl' },
  class: { name: 'typeName', body: 'typeDecl' },
  typedef: { body: 'typeDecl' },
  'typedef-fn': { body: 'typeDecl' },
  'typedef-fnptr': { body: 'typeDecl' },
};

export default feature({
  name: 'named-types',
  doc: '带体的命名类型：struct / class / 带名字的 union / enum（含无名与 bitflag）/ typedef 那一族',
  /* 这个特性带进来的**名字类**（ADR-0029 R2）：查名点写 `find(nm, ['class', 'struct'])`
     时问的就是这几类。`store` 是它现在存在降级器的哪张表上 —— 那十几张 Map 往后并成一张
     带 label 的表时，改这一行就够（查名点一个字都不用动）。 */
  binding: {
    names: {
      struct: { store: 'structs', doc: '结构体名 -> 字段表' },
      class: { store: 'classes', doc: '类名' },
      enum: { store: 'enums', doc: '枚举名 -> { base, members }' },
      alias: { store: 'aliases', doc: 'typedef 起的类型名 -> 解出来的那一格' },
      template: { store: 'templates', doc: '泛型声明名' },
      ns: { store: 'nsNames', doc: '命名空间名（`using namespace X;` 要先认出 X）' },
      exposed: { store: 'exposedMems', doc: '无名枚举漏到外面那层的成员名' },
    },
  },
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
    'G-002': {
      text: '`friend class X;` 这种写法（语法这一层不认）',
      why: '语料 655 份里一处没有（只在注释里提过 aliens / friends 那一套），所以这一格没有'
        + '语料作证；jancy 那边 friend 是"命名空间访问权限"那一摊的一部分（第二百四十一刀碰过'
        + '它的另一面：静态花括号）。**确切写法没查清**，所以这一格记成我们的洞（syntax-todo）'
        + '而不是"这门语言写不出来"—— 别把没查清当规格',
    },
    'T-005': {
      text: '（代价，不是拒绝）体里声明的类型，名字提到外面那层命名空间',
      why: '第 219/250/260 刀那三格共同的代价：函数外面也用得上它（拒得更松）、'
        + '同一层里两个函数各写一条同名的会撞（拒得更严）。真按作用域收要 scope graph（Phase 2）',
    },
  },
  positions: [
    ...NAMED.flatMap((kind) => [
      { kind, sorts: ['module'], verdict: 'ok', register: REG[kind] },
      { kind, sorts: KEEPS, verdict: 'ok', escapes: false, register: REG[kind] },
      {
        kind,
        sorts: ['fn-body'],
        verdict: 'ok',
        escapes: true,
        register: REG[kind],
        note: 'T-005 的代价',
      },
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
    /* 匿名 struct 是匿名 union 的**镜像**（第一百一十一刀）：只在 union 的体里写得出来 ——
       C 的老写法，一格 union 里几组字段轮流用同一段字节。别的位置也是**语法就不认**。
       这一列是矩阵后来才加上的：先前这张表里没有它，于是"这门语言有几种要素"少数了一格。 */
    { kind: 'struct-anon', sorts: ['union-body'], verdict: 'ok' },
    {
      kind: 'struct-anon',
      sorts: ['module', 'namespace', 'class-body', 'struct-body', 'opaque-class-body', 'fn-body'],
      verdict: 'syntax',
    },
    { kind: 'struct-anon', sorts: ['property-body'], verdict: 'refuse', account: 'P-005' },
    { kind: 'struct-anon', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
    /* 嵌套的 `namespace`（矩阵后加的一列）：模块与命名空间那两层收，别处各按自己那一族的话拒。 */
    { kind: 'namespace', sorts: ['module', 'namespace'], verdict: 'ok' },
    { kind: 'namespace', sorts: ['class-body', 'opaque-class-body'], verdict: 'refuse', account: 'T-002' },
    { kind: 'namespace', sorts: ['struct-body'], verdict: 'refuse', account: 'T-001' },
    { kind: 'namespace', sorts: ['union-body'], verdict: 'refuse', account: 'T-003' },
    { kind: 'namespace', sorts: ['fn-body'], verdict: 'refuse', account: 'S-002' },
    { kind: 'namespace', sorts: ['property-body'], verdict: 'refuse', account: 'P-005' },
    { kind: 'namespace', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
    /* `opaque class`（同上）：与普通 class 那一列一样，函数体里那一格也收（T-005 的代价）。 */
    {
      kind: 'class-opaque',
      sorts: ['module', 'namespace', 'class-body', 'struct-body', 'opaque-class-body', 'fn-body'],
      verdict: 'ok',
      register: REG.class,
    },
    { kind: 'class-opaque', sorts: ['union-body'], verdict: 'refuse', account: 'T-003' },
    { kind: 'class-opaque', sorts: ['property-body'], verdict: 'refuse', account: 'P-005' },
    { kind: 'class-opaque', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
    /* 带基类型的枚举（`enum E: uint16_t { … }`，语料里 io_* 那几份日志码就是这么写的）：
       与普通 enum 那一列一样 —— 这一列是矩阵后加的，加之前"表里有没有它"没人问过。 */
    {
      kind: 'enum-typed',
      sorts: ['module', 'namespace', 'class-body', 'struct-body', 'opaque-class-body', 'fn-body'],
      verdict: 'ok',
      register: REG.enum,
    },
    { kind: 'enum-typed', sorts: ['union-body'], verdict: 'refuse', account: 'T-003' },
    { kind: 'enum-typed', sorts: ['property-body'], verdict: 'refuse', account: 'P-005' },
    { kind: 'enum-typed', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
    /* `friend class X;`：整行语法不认，而且是**我们的洞**（见 G-002）。 */
    { kind: 'friend', sorts: '*', verdict: 'syntax-todo', account: 'G-002' },
    /* 多基类的类（`class C: A, B { … }`，第一百二十五刀那一套布局）：与普通 class 同一列。 */
    {
      kind: 'class-multi-base',
      sorts: ['module', 'namespace', 'class-body', 'struct-body', 'opaque-class-body', 'fn-body'],
      verdict: 'ok',
      register: REG.class,
    },
    { kind: 'class-multi-base', sorts: ['union-body'], verdict: 'refuse', account: 'T-003' },
    { kind: 'class-multi-base', sorts: ['property-body'], verdict: 'refuse', account: 'P-005' },
    { kind: 'class-multi-base', sorts: ['extension-body'], verdict: 'refuse', account: 'T-004' },
  ],
});
