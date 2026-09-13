// src/lang/jnc/syntax.js —— jancy 的**语法词汇表**（照 jnc_ct_Parser 的 .llk 一条条抄下来）
//
// 这一份是 ADR-0029 那套形式化的 L0/L1：**这门语言到底有哪些词、哪些位置**。先前的做法是
// 一次量六列、逐步逼近 —— 那还是"照例子办"。这一份反过来：先把 jancy 自己的文法**全抄下来**，
// 再让例子从它生成、让位置矩阵从它展开。
//
// 出处（jancy 源码树 src/jnc_ct/jnc_ct_Parser/）：
//   jnc_ct_Decl.llk                  声明的三种上下文与各自收哪几族
//   jnc_ct_DeclarationSpecifier.llk  storage / access / type / type-modifier 四张词表
//   jnc_ct_Declarator.llk            声明符的各种形状
//   jnc_ct_NamedTypeSpecifier.llk    带体的命名类型
//
// **最要紧的一条**（Decl.llk:25-113）：jancy 的位置只有**三种上下文**，不是九种 ——
//
//   common_declaration       = using | pragma | named_type_specifier | attribute_block
//   global_declaration       = common | namespace | extension | global_item | ';'
//   member_block_declaration = common | friend | access(`public:`) | member_item | ';'
//   local_declaration        = common | local_item | statement | catch: | finally: | nestedscope:
//
// 我们矩阵里那九个 sort 全落在这三种之一：
//   global  ← module / namespace
//   member  ← class-body / struct-body / union-body / opaque-class-body / extension-body /
//             property-body（属性模板的体在 jancy 那儿就是一格 member_block，
//             DeclarationSpecifier.llk:237-252）
//   local   ← fn-body
//
// 于是"位置 × 要素"那张表分了两层：**语法**只按三种上下文说话（写不写得出来），
// **语义**才按九个 sort 说话（这一族类型收不收这一种成员）。先前把两层混在一栏里，
// 才有"syntax 那一栏混着规格与洞"那笔账（第 10.17 节）。

/** 三种声明上下文（Decl.llk:39/59/80）。 */
export const CONTEXTS = ['global', 'member', 'local'];

/** 我们那九个 sort 各属哪一种上下文。 */
export const SORT_CONTEXT = {
  module: 'global',
  namespace: 'global',
  'class-body': 'member',
  'struct-body': 'member',
  'union-body': 'member',
  'opaque-class-body': 'member',
  'extension-body': 'member',
  'property-body': 'member',
  'fn-body': 'local',
};

/** 只在某一种上下文里出现的那几族（Decl.llk:39-113）。 */
export const CONTEXT_ONLY = {
  global: ['namespace', 'extension', 'qualified-special-method'],
  member: ['friend', 'access-label'],
  local: ['statement', 'catch-label', 'finally-label', 'nested-scope-label'],
};

/** 三种上下文都收的那四族（Decl.llk:25-30）。 */
export const COMMON = ['using', 'pragma', 'named-type', 'attribute-block'];

/**
 * 存储说明符（DeclarationSpecifier.llk:82-123）—— 一共 10 个。
 * `ctx` 写的是"jancy 允许它出现在哪几种上下文"（照 Parser 那边的检查与文档）。
 */
export const STORAGE = {
  typedef: { text: 'typedef', ctx: ['global', 'member', 'local'] },
  alias: { text: 'alias', ctx: ['global', 'member', 'local'] },
  static: { text: 'static', ctx: ['global', 'member', 'local'] },
  threadlocal: { text: 'threadlocal', ctx: ['global', 'member', 'local'] },
  abstract: { text: 'abstract', ctx: ['member'] },
  virtual: { text: 'virtual', ctx: ['member'] },
  override: { text: 'override', ctx: ['member'] },
  mutable: { text: 'mutable', ctx: ['global', 'member', 'local'] },
  disposable: { text: 'disposable', ctx: ['local'] },
  dynamicfield: { text: 'dynamicfield', ctx: ['member'] },
};

/** 访问说明符（DeclarationSpecifier.llk:143-152）。 */
export const ACCESS = { public: { text: 'public' }, protected: { text: 'protected' } };

/** 类型说明符（DeclarationSpecifier.llk:164-218）。`sample` 是拿它写一格量的时候用的形状。 */
export const TYPES = {
  void: { text: 'void', sample: 'void' },
  class: { text: 'class', sample: 'class*' },          // StdType_AbstractClass
  anydata: { text: 'anydata', sample: 'anydata*' },    // StdType_AbstractData
  bool: { text: 'bool', sample: 'bool' },
  int: { text: 'int', sample: 'int' },
  intptr: { text: 'intptr', sample: 'intptr' },
  char: { text: 'char', sample: 'char' },
  short: { text: 'short', sample: 'short' },
  long: { text: 'long', sample: 'long' },
  float: { text: 'float', sample: 'float' },
  double: { text: 'double', sample: 'double' },
  'property-template': { text: 'property { … }', sample: 'property { int get(); }' },
  named: { text: '限定名', sample: 'Helper' },
};

/**
 * 类型修饰符（DeclarationSpecifier.llk:259-368）—— 一共 27 个。这是这门语言最大的一张词表，
 * 也是"位置 × 要素"里 `要素` 那一维的主要来源：**修饰符 × 声明符形状**。
 *
 * `on` 说的是这个词落在哪一类声明符上才有意思（data = 一格数据、fn = 一格函数、
 * prop = 一格属性、any = 都行）—— 那正是 jancy 的 `DeclTypeCalc` 分派的依据
 * （jnc_ct_DeclTypeCalc.cpp）。
 */
export const MODS = {
  unsigned: { text: 'unsigned', on: 'data' },
  bigendian: { text: 'bigendian', on: 'data' },
  const: { text: 'const', on: 'any' },
  maybeconst: { text: 'maybeconst', on: 'any' },
  autoconst: { text: 'autoconst', on: 'any' },
  readonly: { text: 'readonly', on: 'any' },
  volatile: { text: 'volatile', on: 'data' },
  weak: { text: 'weak', on: 'data' },
  thin: { text: 'thin', on: 'data' },
  safe: { text: 'safe', on: 'data' },
  unsafe: { text: 'unsafe', on: 'fn' },
  cdecl: { text: 'cdecl', on: 'fn' },
  stdcall: { text: 'stdcall', on: 'fn' },
  thiscall: { text: 'thiscall', on: 'fn' },
  jnccall: { text: 'jnccall', on: 'fn' },
  array: { text: 'array', on: 'data' },
  function: { text: 'function', on: 'fn' },
  property: { text: 'property', on: 'prop' },
  bindable: { text: 'bindable', on: 'prop' },
  autoget: { text: 'autoget', on: 'prop' },
  indexed: { text: 'indexed', on: 'prop' },
  multicast: { text: 'multicast', on: 'fn' },
  event: { text: 'event', on: 'fn' },
  autoevent: { text: 'autoevent', on: 'fn' },
  reactor: { text: 'reactor', on: 'fn' },
  errorcode: { text: 'errorcode', on: 'fn' },
  async: { text: 'async', on: 'fn' },
};

/**
 * 声明符的形状（Declarator.llk）。`kind` 是它落在哪一类（data / fn / prop），
 * `render(name, ty)` 把它写成源码 —— **例子就是从这儿生成的**（不再手写一份 KINDS）。
 */
export const DECLARATORS = {
  plain: { kind: 'data', render: (n, t) => `${t} ${n};` },
  init: { kind: 'data', render: (n, t) => `${t} ${n} = 0;` },
  ptr: { kind: 'data', render: (n, t) => `${t}* ${n};` },
  array: { kind: 'data', render: (n, t) => `${t} ${n}[4];` },
  bitfield: { kind: 'data', render: (n, t) => `${t} ${n} : 3;` },
  'fn-proto': { kind: 'fn', render: (n, t) => `${t} ${n}();` },
  'fn-body': { kind: 'fn', render: (n, t) => `${t} ${n}() {\n\t\treturn ${t === 'void' ? '' : '0'};\n\t}` },
  'fn-args': { kind: 'fn', render: (n, t) => `${t} ${n}(int a, int b);` },
  'fn-ptr': { kind: 'data', render: (n, t) => `${t} function* ${n}(int);` },
  'prop-simple': { kind: 'prop', render: (n, t) => `${t} ${n};` },
  'prop-indexed': { kind: 'prop', render: (n, t) => `${t} ${n}(int i);` },
  'prop-full': { kind: 'prop', render: (n, t) => `${t} ${n} {\n\t\tget {\n\t\t\treturn 0;\n\t\t}\n\t}` },
};

/** 带体的命名类型（NamedTypeSpecifier.llk）。 */
export const NAMED_TYPES = {
  struct: { render: (n) => `struct ${n} {\n\tint m_f;\n}` },
  union: { render: (n) => `union ${n} {\n\tint m_a;\n\tbool m_b;\n}` },
  class: { render: (n) => `class ${n} {\n\tint m_f;\n}` },
  'opaque-class': { render: (n) => `opaque class ${n} {\n\tint m_f;\n}` },
  enum: { render: (n) => `enum ${n} {\n\tE1,\n\tE2\n}` },
  'enum-bitflag': { render: (n) => `bitflag enum ${n} {\n\tB1,\n\tB2\n}` },
  'enum-typed': { render: (n) => `enum ${n}: uint16_t {\n\tT1,\n\tT2\n}` },
  'enum-anon': { render: () => 'enum {\n\tA1 = 1,\n\tA2 = 2\n}' },
  'struct-anon': { render: () => 'struct {\n\tint m_sa;\n\tbool m_sb;\n}' },
  'union-anon': { render: () => 'union {\n\tint m_ua;\n\tbool m_ub;\n}' },
  dylib: { render: (n) => `dylib ${n} {\n\tint dlFn(int);\n}` },
};

/** 特殊成员（Declarator.llk 的 special_void_method_declarator 那一族）。 */
export const SPECIALS = {
  construct: { render: () => 'construct() {\n\t}' },
  'construct-args': { render: () => 'construct(int v) {\n\t}' },
  'static-construct': { render: () => 'static construct() {\n\t}' },
  destruct: { render: () => 'destruct() {\n\t}' },
  'operator-add': { render: () => 'int operator + (int v) {\n\t\treturn v;\n\t}' },
  'operator-assign': { render: () => 'int operator := (int v) {\n\t\treturn v;\n\t}' },
  'operator-call': { render: () => 'int operator () (int v) {\n\t\treturn v;\n\t}' },
  'operator-index': { render: () => 'int get(int i) {\n\t\treturn i;\n\t}' },
  'operator-cast': { render: () => 'bool operator bool() {\n\t\treturn true;\n\t}' },
};
