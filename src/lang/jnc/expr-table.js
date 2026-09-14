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
