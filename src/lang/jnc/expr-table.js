// src/lang/jnc/expr-table.js —— **表达式那两张表**：字面量的读法 + 隐式转换链
//
// 从旧降级整块读出来的（`frontend-jnc/lower.js`）：
//   `expr(n, want)`  :13104-13160 —— 取值之后按"要什么类型"过一条**有次序**的转换链；
//   `numLit(n)`      :13163-13183 —— 字面量的基数规则（jancy 的词法，不是 C 的）；
//   `intLit(n, v)`   :13198-13204 —— 整数字面量的类型：装得下 int、装不下 long。
//
// 这一层只有**表与纯函数**：类型判据由调用方给的谓词回答（`isInt` / `isArr` / …），
// 生成的文字就地拼。转换链的**次序**本身就是规则的一部分（`variant_t v = 1;` 要装一格整数，
// 不是先变实数），所以表是数组而不是对象。

/**
 * **隐式转换链**（次序要紧，从上往下第一格命中就用它）。每格：
 *   { name, why, when(v, want, ctx), emit(v, want, ctx) }
 * `v` 是 `{ code, type }`，`want` 是要的类型（可空），`ctx` 给谓词与几个小工具：
 *   { isInt, isArr, isVar, isEnum, isReal, isBool, decay, realOf, intConv, boxVar, unboxVar,
 *     constInt }
 * `emit` 答新的 `{ code, type }`；答 `null` 表示"这一格该报还不收"（调用方记账）。
 */
export const CONV_CHAIN = [
  {
    name: 'array-decay',
    /* 数组在取值这一步退化成指针（`int* p = a;`）。**要的就是数组时一个字都不退**
       （第二十一刀）：jancy 的退化不在"取值"，是在"转成目标类型"那一步
       （`Cast_DataPtr_FromArray`，CastOp_DataPtr.cpp:24），所以目标本身是 `T[N]` 时
       （数组形参、数组返回、数组之间的赋值）走的是 `Cast_Array` 那条路。 */
    why: '数组退化成指针（要的就是数组时不退）',
    when: (v, want, c) => !(want !== null && want !== undefined && c.isArr(want)),
    emit: (v, want, c) => c.decay(v),
  },
  {
    name: 'int-to-real',
    /* int → real 的隐式加宽（jancy 与 C 同）。反过来**不**做：那是丢精度，jancy 那边也要
       一次显式强制转换。 */
    why: '整数加宽成实数',
    when: (v, want, c) => c.isReal(want) && c.isInt(v.type),
    emit: (v, want, c) => ({ code: c.realOf(v.code, v.type), type: want }),
  },
  {
    name: 'variant-box',
    /* `variant_t` 的装箱与拆箱在 jancy 里**都是隐式的**（语料里就写 `*out = atoi(s);` 与
       `m_editText = in;`，两句都不写强制转换）。挂在这一处是因为它是"要一个具体类型"的取值的
       唯一入口 —— 初值、赋值、实参、返回值四处一起接上。
       **排在 int → real 之后**：`variant_t v = 1;` 要的是装一格整数，不是先变实数。 */
    why: '装进一格 variant_t',
    when: (v, want, c) => c.isVar(want) && !c.isVar(v.type),
    emit: (v, want, c) => c.boxVar(v),
  },
  {
    name: 'variant-unbox',
    why: '从一格 variant_t 里拆出来',
    when: (v, want, c) => c.isVar(v.type) && want !== null && want !== undefined && !c.isVar(want),
    emit: (v, want, c) => c.unboxVar(v, want),
  },
  {
    name: 'bool-to-int',
    /* bool → 整数（第三十七刀）：1 位那一格用**零扩展**（`m_ext_u`，
       jnc_ct_CastOp_Int.cpp:354），而扩展这一族的 getCastKind 就是 `CastKind_Implicit`
       （jnc_ct_CastOp_Int.h:63）。所以 `int b = a > 0;` 在 jancy 里合法，值是 0 或 1。 */
    why: '布尔当整数用（零扩展）',
    when: (v, want, c) => c.isInt(want) && c.isBool(v.type),
    emit: (v, want) => ({ code: `(sel ${v.code} (int 1) (int 0))`, type: want }),
  },
  {
    name: 'enum-to-int',
    /* 枚举 → 整数是**隐式**的（第三十九刀）：getArithmeticOperatorResultType 见到
       TypeKind_Enum 会递归到基类型（jnc_ct_UnOp_Arithmetic.cpp:39）。反过来要**显式**
       （type_enum.rst:60 "cast int->enum must be explicit"），所以只有这一个方向。 */
    why: '枚举当整数用',
    when: (v, want, c) => c.isInt(want) && c.isEnum(v.type),
    emit: (v, want, c) => c.intConv({ code: v.code, type: v.type.base }, want),
  },
  {
    name: 'zero-to-bitflag',
    /* **0 可以隐式赋进 bitflag 枚举**（第四十七刀）：jancy 写在 int → enum 的 getCastKind 里
       —— `(flags & EnumTypeFlag_BitFlag) && opValue.isZero()` 时是 `CastKind_Implicit`
       （jnc_ct_CastOp_Int.cpp:306-311）。它问的是**编译期常量零**，不是"运行期恰好是 0"：
       `flags = 0` 收，`flags = x` 不收（哪怕 x 这一趟正好是 0）。 */
    why: '常量 0 赋进 bitflag 枚举',
    when: (v, want, c) => c.isEnum(want) && want.bits === true && c.isInt(v.type)
      && c.constInt() === 0n,
    emit: (v, want) => ({ code: '(int 0)', type: want }),
  },
];

/**
 * **数值字面量的基数**（jancy 的词法，`Lexer.rl:429`）。答 `{ radix, digits }`；
 * 不是整数字面量答 `null`（实数那一格由 `isRealLit` 认）。
 *
 * 与 C 不同的两格，都照抄 jancy：
 *   - 打头一个 `0` 再跟一串**八进制**数字就是八进制（`CBAUD = 0010017` 是 termios 那套掩码）；
 *   - 带 8 或 9 的（`0778` / `08`）落不到那条规则上 —— ragel 取更长的匹配（`dec+`），
 *     于是它们是**十进制**（C 那边 `08` 是错）。
 */
export function intLitRadix(s) {
  if (/^0[xX][0-9a-fA-F]+$/.test(s)) return { radix: 16, digits: s.slice(2) };
  if (/^0[bB][01]+$/.test(s)) return { radix: 2, digits: s.slice(2) };
  if (/^0[oO][0-7]+$/.test(s)) return { radix: 8, digits: s.slice(2) };
  if (/^0[oO][0-9]+$/.test(s)) return { radix: null, why: '八进制字面量里有 8 或 9' };
  if (/^0[nNdD][0-9]+$/.test(s)) return { radix: 10, digits: s.slice(2) };
  if (/^0[0-7]+$/.test(s)) return { radix: 8, digits: s.slice(1) };
  if (/^[0-9]+$/.test(s)) return { radix: 10, digits: s };
  return null;
}

/** 实数字面量的形状（`1.5` / `1.` / `1e3` / `1.5e-3` —— 方言的 realLit 都收）。 */
export function isRealLit(s) {
  return /^[0-9]+\.?[0-9]*([eE][+-]?[0-9]+)?$/.test(s);
}

/**
 * **整数字面量的类型**：装得下就是 `int`（32 位），装不下就是 `long`（64 位）——C 的规矩。
 * 众所周知的后果照抄不改：`-2147483648` 是 `long`（一元减在字面量**之外**，而
 * `2147483648` 已经装不下 32 位）。
 *
 * 比 INT64_MAX 还大的那一格是 **unsigned long**，这不是 C 的规矩、是 jancy 自己的：
 * 字面量走 `setConstInt64_u`（jnc_ct_Expr.llk:856），挑类型的 `getInt64TypeKind_u` 最后一格
 * 正是 `integer <= INT64_MAX ? TypeKind_Int64 : TypeKind_Int64_u`（jnc_ct_Type.cpp:64）。
 * 位上存的还是那 64 位（`asIntN` 折一下），无符号性挂在类型上。
 */
export function intLitKind(v) {
  if (v > 0xffffffffffffffffn) return { kind: null, why: '超出 unsigned long 能装的范围' };
  if (v > 0x7fffffffffffffffn) return { kind: 'u64', value: BigInt.asIntN(64, v) };
  return { kind: v > 0x7fffffffn ? 'i64' : 'i32', value: v };
}

/* ─── `null` 按**左边要什么**定型（lower.js:13870-13905）──────────────────────
   `null` 自己没有类型。左边知道要什么时就用它；不知道时（`x == null` 里 x 是整数）
   **当场说清**，不随便挑一个。六格按次序问，`emit` 答方言那一段文字。 */
export const NULL_BY_WANT = [
  {
    /* 类引用也是一种"指针"（第五十二刀）：`C* p = null` 与 `p == null` 都要它，
       而类那一格在方言里是 `(ptr 连通分量的根)`。 */
    name: 'class',
    when: (want, c) => c.isClass(want),
    emit: (want, c) => (c.clsRoot === undefined ? null : `(pnull (ptr ${c.clsRoot(want.name)}))`),
  },
  {
    /* `variant_t data = null`（第一百一十三刀，语料 8 处）：一格**空**的 variant，标签 0。
       这一条得在这儿而不是在装箱那两条里 —— `null` 走不到"值是什么类型"那一步。 */
    name: 'variant',
    when: (want, c) => c.isVar(want),
    emit: (want, c) => (c.varBoxName === undefined ? null : `(call ${c.varBoxName('0')})`),
  },
  {
    /* 函数值那一格：方言这一侧**已经有**"空的那一格"`(null (fnty …))`
       （第三十三刀，OIR 的 `NullFn` 六条腿都认）。语料里的形状：
       `void function* onTriggered() = null`（ui_Action.jnc:39）。 */
    name: 'fn',
    when: (want, c) => c.isFn(want),
    emit: (want, c) => (c.tyText === undefined ? null : `(null ${c.tyText(want)})`),
  },
  {
    /* `null` 当一格 `string_t`（第一百六十五刀）：**字符串槽的零值本来就是 `(str "")`**，
       而这一层可观测的三件事（长度、当条件、印出来）在"空的"与"零长"上一模一样。
       所以回同一格零值，不是替 jancy 猜一个新语义。 */
    name: 'string',
    when: (want) => want !== null && want !== undefined && want.k === 'string',
    emit: () => '(str "")',
  },
  {
    name: 'ptr',
    when: (want, c) => c.isPtr(want),
    emit: (want, c) => (c.tyText === undefined ? null : `(pnull ${c.tyText(want)})`),
  },
  {
    name: 'unknown',
    when: () => true,
    emit: () => null,                    // 问不出来 —— 调用方报"null 得从左边知道自己是哪种指针"
  },
];

/* ─── **裸名字**的查名次序（lower.js:13907-13945）─────────────────────────────
   源码里一格裸名字可能是九种东西。次序**就是规则**：先查得着的变量，再往下问。
   每格给一个探子（`probe`），第一个答得出来的就是它。全没答出来才报"未声明"。
   这正是作用域图那一层的入口 —— 表在这儿，图在 `bind.js`。 */
export const NAME_LOOKUP_ORDER = [
  { name: 'var', why: '查得着的变量（局部、形参、模块级）' },
  { name: 'self-field', why: '方法体里裸写的字段名（第五十二刀，与可写那一侧同一份）' },
  { name: 'fn-value', why: '函数名当值用 = 一格函数指针（第五十五刀）；**重载过的取不出**（第七十九刀）' },
  { name: 'prop-bare', why: '方法体里裸写的属性名（第六十九刀）—— 读它就是调取值器，连基类链一起找' },
  { name: 'alias-path', why: '裸写一格字段路径别名（第一百〇四刀）' },
  { name: 'bitfield', why: '裸写一格位域（第一百一十二刀）' },
  { name: 'enum-exposed', why: '无名枚举漏出来的成员（第九十六刀）：`enum { A = 1 }` 之后裸写 `A`' },
  { name: 'c-const', why: '`with "h.h"` 收来的宏与枚举常量（第 J4d 刀）' },
  { name: 'bad-decl', why: '那格声明自己没成（第二百三十五刀）—— 别把一件事记成好几笔' },
];

/**
 * **查着变量之后怎么取值**（lower.js:13947-13963）。四条，按次序：
 *   1. 结构体与数组那一格里放的**就是地址**（第十二刀 / 第二十刀）—— `(var 名字)`，不走提格那条路；
 *   2. 模块级**提过**的（第二十四刀）：那一格自己就是 `(ptr T)`，所以 `(pload (var 名字))`；
 *   3. 局部**提过**的（第九刀）：要 `pload` 它的那格单元（`cellName`）；
 *   4. 别的：`(var 名字)`。
 */
export function nameLoad(dname, t, c) {
  if (c.isStruct(t) || c.isArr(t)) return `(var ${dname})`;
  if (c.isGlobal === true) return c.gLifted ? `(pload (var ${dname}))` : `(var ${dname})`;
  if (c.lifted === true) return `(pload (var ${c.cellName}))`;
  return `(var ${dname})`;
}
