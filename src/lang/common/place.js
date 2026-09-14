// src/lang/common/place.js —— **可写位置**（place）那一层的表：读写都从它出发
//
// 家在公共这一层（ADR-0031 轴 B）："位置与值分开、读一条边写一条边"是 C 系语言的共性
// （C 的 lvalue、Rust 的 place、LLVM 的 load/store）。方言把 place 变成一格真概念之后
// （ADR-0031 §5 最后一条），这四种形状就退化成"读/写"两个算子。
//
// 从旧降级 `lvalue` / `nameLv`（`frontend-jnc/lower.js:10977-11059`）整块读出来。
// 一格可写位置有三种**形状**，读写照形状走，所以这一层答的是形状而不是文字：
//   `var`：一格名字（读 `(var x)`、写 `(set x …)`）；
//   `ptr`：一格**地址**（读 `(pload …)`、写 `(pstore …)`）——"提到堆上"的那些名字就是它；
//   `agg`：结构体与数组（那一格里放的**就是地址**：读是那个地址，写要**抄一份**）。
//
// 次序在这一层就是规则本身：谁遮住谁、谁要排在谁前面，每条都带出处。

import * as sx from './sx.js';

/**
 * **`lvalue` 的分派次序**（lower.js:10977-10994）。
 *   1. `name` → 走名字那一套；
 *   2. `this`：方法体里它就是第一个形参那一格（第五十二刀）；不在方法体里就报；
 *   3. `field` 且**整串摊得动、摊出来的名字查得着全局**：那是**命名空间里的那一格**
 *      （第五十一刀，`a.g`）—— 它在表达式里长得像一串取字段，所以这一问必须排在
 *      "取字段"**之前**；
 *   4. 别的：取字段 / 下标 / 解引用那几族。
 */
export const LVALUE_ORDER = [
  { name: 'name', why: '一格名字' },
  { name: 'this', why: '`this` —— 方法体里第一个形参那一格（第五十二刀）' },
  { name: 'ns-global', why: '`a.g` 是命名空间里的那一格（第五十一刀）—— 要排在取字段之前' },
  { name: 'member', why: '取字段 / 下标 / 解引用' },
];

/**
 * **裸名字当可写位置时的次序**（lower.js:10998-11041）。查得着的变量、形参**遮住**下面这些，
 * 所以整块排在"查名"之后。
 *   1. **bigendian 字段要排在普通字段之前**（第一百二十六刀）：它**是**一格真字段，排在后面
 *      就被普通字段那一支接走了，**字节序那一步就丢了**；
 *   2. 方法体里裸写的字段：`m_x` 就是 `this.m_x`，落在同一句 `(pfield (var $this) m_x)` 上；
 *      结构体与数组那一格是 `agg`，别的是 `ptr`；
 *   3. 字段路径别名（第一百〇四刀）；
 *   4. 位域（第一百一十二刀）；
 *   5. **属性不是一格内存**（第六十九刀）：`g_p++`、`&g_p`、复合赋值落到这儿 —— 报"未声明"
 *      是**认错人**（那个名字在，只是它那一格要走取/存两个函数），所以当场说清"接不上"；
 *   6. 那格声明自己没成（第二百三十五刀）：指回那一句，别把一件事记成好几笔；
 *   7. 都不是才报"未声明的变量"。
 */
export const NAME_LVALUE_ORDER = [
  { name: 'bigendian-field', why: 'bigendian 字段（要排在普通字段之前，否则字节序那一步丢了）' },
  { name: 'self-field', why: '方法体里裸写的字段：`m_x` 就是 `this.m_x`' },
  { name: 'alias-path', why: '字段路径别名（第一百〇四刀）' },
  { name: 'bitfield', why: '位域（第一百一十二刀）' },
  { name: 'prop-not-memory', why: '**属性不是一格内存**（第六十九刀）—— 当场说清，别报"未声明"' },
  { name: 'bad-decl', why: '那格声明自己没成（第二百三十五刀）：指回那一句' },
];

/**
 * **查着变量之后是哪种形状**（lower.js:11042-11058）。三条按次序：
 *   1. **结构体与数组是 `agg`**：那一格里放的是地址（第十二刀 / 第二十一刀）。这一条要排在
 *      "提到堆上"**之前** —— 它们本来就是一段内存，`&s` / `&a` 不用再提一次；
 *   2. **提到堆上的那些名字是 `ptr`**（不是 `var`）：于是读写自动走 `pload` / `pstore`，
 *      而 `&x` 就是它的 code。模块级那一半是第二十四刀 —— 那一格就是**全局自己**
 *      （已经发成了 `(ptr T)`），所以不用另开单元；局部那一半是第九刀，用它的单元名；
 *   3. 别的是 `var`。
 */
export function lvalueShape({
  isStruct, isArr, isGlobal, gLifted, lifted,
}) {
  if (isStruct === true || isArr === true) return 'agg';
  if (isGlobal === true) return gLifted === true ? 'ptr' : 'var';
  return lifted === true ? 'ptr' : 'var';
}

/**
 * 那格可写位置在方言里怎么写（形状 → 读/写两段文字的模板）。
 *
 * 每一格都过**契约**（`src/lang/common/sx.js`，ADR-0031 §6）：元数与形状当场校验，
 * 不再拼字符串 —— "忘了裹 `(expr …)`""`(pfield)` 与 `(pload (pfield))` 混了"这一类错
 * 在发码那一刻就炸。
 */
export const SHAPE_ACCESS = {
  var: { read: (x) => sx.varOf(x), write: (x, v) => sx.set(x, v) },
  ptr: { read: (x) => sx.pload(x), write: (x, v) => sx.pstore(x, v) },
  /* `agg` 的写不是一句 —— 结构体逐字段、数组逐格抄一份（`copyVal`，第十二刀与第二十一刀）。 */
  agg: { read: (x) => x, write: null },
  /**
   * **属性不是一格内存**（第六十九刀）：读它是**一次调用**、写它是**另一次调用**
   * （`prop.rst` 里那对 `get` / `set`）。所以它是第四种形状 —— 混进 `var` 那一格就等于
   * 把"调一次函数"悄悄换成"读一格变量"。写出来的是一整条语句（`(expr (call …))`），
   * 因为方言里调用当语句要裹 `expr`。
   *
   * 方言长出"取/存成对的位置"之后这一格就该退役（ADR-0031 §5 的第四条）。
   */
  prop: {
    read: (x) => sx.call(`${x}$get`),
    write: (x, v) => sx.exprStmt(sx.call(`${x}$set`, [v])),
  },
};
