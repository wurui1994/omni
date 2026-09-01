// Omni stage0 — C 的类型（tinycc `tcc.h:1044-1104` 的等价物，ADR-0017 第六刀第二片）
//
// ## 为什么类型是**一个整数加一个引用**，而不是一棵对象树
//
// tcc 的 `CType` 只有两格：`t`（一个 32 位的位域）与 `ref`（指向一个 `Sym`）。
// 这不是省内存的小聪明，是让整个前端能靠**位运算**回答类型问题：
//   - `(t & VT_BTYPE) == VT_PTR`      —— 是不是指针
//   - `IS_ENUM(t)`                    —— 整型但其实是 enum（`tcc.h:1086`）
//   - `t & VT_UNSIGNED`               —— 无符号性，和基本类型在同一个数里
//   - `VT_ARRAY` **同时**带着 `VT_PTR`（`tcc.h:1062` 那句括号）—— 于是"数组退化成指针"
//     在绝大多数判断里是**不用写代码的**：问「是不是指针」时数组自动答是。
// 换成对象树，上面每一条都得变成一个方法调用加一次 null 判断，而 `parse_btype` 里
// 「见到一个说明符就 `t |= …`」那种写法会整段消失 —— 那正是 C 声明语法能一遍过的原因。
//
// 所以数值**照抄**（出处纪律见 ADR-0017「借什么、不借什么」：照行为与结构重写，不抄代码；
// 但一张位分配表是数据，改一位就是改一门语言）。
//
// ## 与 MIR 类型码的关系
//
// C 的类型比 MIR 的类型码多得多，两者不是一对一：
//   - `char`/`short`/`int` 在**寄存器里都是 `T_I32`**（tcc 与 wasm 都这么做），宽度只在
//     存进内存（`MSTORE` 的描述符）与显式截断（`CVT_SEXT8`/`SEXT16`）时才看得见；
//   - 指针是 `T_I64`：线性内存里的**字节偏移**。不用 `T_PTR`/`T_TPTR` —— 那两个是
//     ADR-0016 的「一块一块的分配 + 范围检查」，而 C 要的是「一整片可寻址的字节」
//     （决策四说过这两者是同一件事的两种视角，C 前端取后者）。
//   - `long`/`long long` 是 `T_I64`，`float`/`double` 是 `T_F32`/`T_F64`。
// 这条映射在 `mirTypeOf` 一处，别处不许再推一遍。

/* ------------------------------------------------- 基本类型（tcc.h:1044-1058）
 * 低 4 位。顺序有意义：`btype <= VT_LLONG` 就是「整型」，`VT_FLOAT..VT_LDOUBLE`
 * 连号就是「浮点」—— 两条区间判断代替两张集合。 */
export const VT_BTYPE = 0x000f;
export const VT_VOID = 0;
export const VT_BYTE = 1;    // signed char
export const VT_SHORT = 2;
export const VT_INT = 3;
export const VT_LLONG = 4;   // 64 位整数
export const VT_PTR = 5;
export const VT_FUNC = 6;
export const VT_STRUCT = 7;
export const VT_FLOAT = 8;
export const VT_DOUBLE = 9;
export const VT_LDOUBLE = 10;
export const VT_BOOL = 11;   // C99 的 _Bool

/* ------------------------------------------------- 修饰位（tcc.h:1060-1067） */
export const VT_UNSIGNED = 0x0010;
export const VT_DEFSIGN = 0x0020;   // 显式写了 signed / unsigned（`char` 的默认符号要靠它）
export const VT_ARRAY = 0x0040;     // 数组。**同时带 VT_PTR**，见文件头
export const VT_BITFIELD = 0x0080;
export const VT_CONSTANT = 0x0100;
export const VT_VOLATILE = 0x0200;
export const VT_VLA = 0x0400;
export const VT_LONG = 0x0800;      // 写了 long（基本类型仍是 VT_INT 或 VT_LLONG）

/* ------------------------------------------------- 存储类（tcc.h:1070-1074） */
export const VT_EXTERN = 0x00001000;
export const VT_STATIC = 0x00002000;
export const VT_TYPEDEF = 0x00004000;
export const VT_INLINE = 0x00008000;

/* ------------------------------------------------- struct/enum 的那两位（tcc.h:1077-1104）
 * 位移 20，两个 6 位段给位域的「偏移与宽度」用。`VT_UNION`/`VT_ENUM` 借同一段的低位 ——
 * 于是「这个整型其实是 enum」不占新的位，而 `IS_ENUM` 是一次掩码比较。 */
export const VT_STRUCT_SHIFT = 20;
export const VT_STRUCT_MASK = (((1 << 12) - 1) * (1 << VT_STRUCT_SHIFT)) | VT_BITFIELD;
export const VT_UNION = (1 * (1 << VT_STRUCT_SHIFT)) | VT_STRUCT;
export const VT_ENUM = 2 * (1 << VT_STRUCT_SHIFT);
export const VT_ENUM_VAL = 3 * (1 << VT_STRUCT_SHIFT);

export const VT_STORAGE = VT_EXTERN | VT_STATIC | VT_TYPEDEF | VT_INLINE;

/* ------------------------------------------------- 问句
 * 全部照 tcc 的宏，一条不多。加一条「方便的」判断的代价是：它会与已有的某条重叠，
 * 而两条重叠的判断迟早会在某个边角上给出不同的答案。 */

export function btype(t) { return t & VT_BTYPE; }
export function isPtr(t) { return btype(t) === VT_PTR; }
export function isArray(t) { return (t & VT_ARRAY) !== 0; }
export function isFunc(t) { return btype(t) === VT_FUNC; }
export function isStruct(t) { return btype(t) === VT_STRUCT; }
export function isUnion(t) { return (t & (VT_STRUCT_MASK | VT_BTYPE)) === VT_UNION; }
export function isEnum(t) { return (t & VT_STRUCT_MASK) === VT_ENUM; }
export function isUnsigned(t) { return (t & VT_UNSIGNED) !== 0; }
/** 整型（含 `_Bool` 与枚举；**不含**指针）。`tccgen.c` 的 `is_integer_btype`。 */
export function isInteger(t) {
  const b = btype(t);
  return b === VT_BYTE || b === VT_SHORT || b === VT_INT || b === VT_LLONG || b === VT_BOOL;
}
export function isFloat(t) {
  const b = btype(t);
  return b === VT_FLOAT || b === VT_DOUBLE || b === VT_LDOUBLE;
}
/** 算术类型：整型或浮点。指针不算（指针算术是另一套规则）。 */
export function isArith(t) { return isInteger(t) || isFloat(t); }

/**
 * 一个 C 类型。`t` 是上面那些位，`ref` 是「指向什么」：
 *   - 指针/数组：元素的 CType
 *   - 函数：`{ret, params, variadic}`
 *   - struct/union：`{name, fields, size, align}`
 * tcc 把这三种都塞进一个 `Sym`（靠 `t` 上的位分辨读哪几格）；这里用三种不同形状的对象，
 * 因为 JS 里没有 union，而「靠位分辨该读哪个字段」在没有 union 的语言里只会变成隐患。
 */
export function ctype(t, ref) { return { t, ref: ref === undefined ? null : ref }; }

export const TY_VOID = ctype(VT_VOID);
export const TY_INT = ctype(VT_INT);
export const TY_UINT = ctype(VT_INT | VT_UNSIGNED);
export const TY_LLONG = ctype(VT_LLONG);
export const TY_ULLONG = ctype(VT_LLONG | VT_UNSIGNED);
export const TY_CHAR = ctype(VT_BYTE);
export const TY_SCHAR = ctype(VT_BYTE | VT_DEFSIGN);
export const TY_UCHAR = ctype(VT_BYTE | VT_DEFSIGN | VT_UNSIGNED);
export const TY_SHORT = ctype(VT_SHORT);
export const TY_USHORT = ctype(VT_SHORT | VT_UNSIGNED);
export const TY_BOOL = ctype(VT_BOOL);
export const TY_FLOAT = ctype(VT_FLOAT);
export const TY_DOUBLE = ctype(VT_DOUBLE);

/** `mk_pointer`（`tccgen.c:3569`）：把一个类型套上一层指针。 */
export function mkPointer(ty) {
  return ctype(VT_PTR, ty);
}

/** 数组：`VT_PTR | VT_ARRAY`，`n < 0` 表示长度未定（`int a[]`）。 */
export function mkArray(elem, n) {
  const ty = ctype(VT_PTR | VT_ARRAY, elem);
  ty.count = n;
  return ty;
}

/**
 * struct / union。`ref` 是那张成员表 `{name, fields, size, align, done}`，
 * **一个 tag 只有一个这样的对象**（在 `tags` 里 intern）—— 于是：
 *   - `sameType` 比一次引用相等就够（tcc 那边是同一个 `Sym` 指针，同一件事）；
 *   - `struct S *p;` 出现在 `struct S {…}` 之前也能编：先建一个 `done: false` 的空壳，
 *     成员表后来填进同一个对象，`p` 手上那份类型自动跟着变完整。这正是 C 允许
 *     不完整类型的指针的实现方式，一遍过时它是必需的而不是优化。
 */
export function mkStruct(info, union) {
  return ctype(union ? VT_UNION : VT_STRUCT, info);
}

/** `enum`：底层就是 `int`（tcc 也是），`VT_ENUM` 那一位只用来记住「它本来是个枚举」。 */
export function mkEnum(info) {
  const ty = ctype(VT_INT | VT_ENUM, info);
  return ty;
}

/**
 * `type_size`（`tccgen.c:3494`）：字节数与对齐。**LP64**（arm64/x86_64 的 Darwin 与
 * Linux 都是它）：`long` 与指针都是 8 字节。这个选择要与 tcc 在本机上的选择一致，
 * 否则 `sizeof` 与 struct 布局会与 oracle 分岔。
 */
export function typeSize(ty) {
  const b = btype(ty.t);
  if (isArray(ty.t)) {
    const es = typeSize(ty.ref);
    return { size: (ty.count < 0 ? 0 : ty.count) * es.size, align: es.align };
  }
  if (b === VT_PTR || b === VT_LLONG || b === VT_DOUBLE) return { size: 8, align: 8 };
  if (b === VT_INT || b === VT_FLOAT) return { size: 4, align: 4 };
  if (b === VT_SHORT) return { size: 2, align: 2 };
  if (b === VT_BYTE || b === VT_BOOL) return { size: 1, align: 1 };
  if (b === VT_LDOUBLE) return { size: 16, align: 16 };
  if (b === VT_STRUCT) return { size: ty.ref.size, align: ty.ref.align };
  if (b === VT_VOID) return { size: 1, align: 1 };  // gcc 的 `sizeof(void)`，tcc 跟着
  if (b === VT_FUNC) return { size: 8, align: 8 };  // 函数指针
  return { size: 0, align: 1 };
}

/**
 * 印一个类型（报错消息用）。形状照 `type_to_str`（`tccgen.c:3600` 一带）的输出，
 * 但不追求逐字节相同 —— 错误消息的**关键片段**才是测试比的东西。
 */
export function typeText(ty) {
  const t = ty.t;
  if (isArray(t)) return `${typeText(ty.ref)}[${ty.count < 0 ? '' : ty.count}]`;
  if (isPtr(t)) return `${typeText(ty.ref)} *`;
  if (isFunc(t)) return `${typeText(ty.ref.ret)} ()`;
  if (isStruct(t)) return `${isUnion(t) ? 'union' : 'struct'} ${ty.ref.name}`;
  if (isEnum(t)) return `enum ${ty.ref === null ? '<anonymous>' : ty.ref.name}`;
  const u = isUnsigned(t) ? 'unsigned ' : '';
  const b = btype(t);
  if (b === VT_VOID) return 'void';
  if (b === VT_BOOL) return '_Bool';
  if (b === VT_BYTE) return `${u}char`;
  if (b === VT_SHORT) return `${u}short`;
  if (b === VT_INT) return (t & VT_LONG) !== 0 ? `${u}long` : `${u}int`;
  if (b === VT_LLONG) return `${u}long long`;
  if (b === VT_FLOAT) return 'float';
  if (b === VT_DOUBLE) return 'double';
  if (b === VT_LDOUBLE) return 'long double';
  return `<type ${t}>`;
}

/** 两个类型「一样吗」（`is_compatible_types` 的这一片）：只比类型位与指向的东西。 */
export function sameType(a, b) {
  if ((a.t & ~VT_STORAGE) !== (b.t & ~VT_STORAGE)) return false;
  if (a.ref === null || b.ref === null) return a.ref === b.ref;
  if (isPtr(a.t) || isArray(a.t)) return sameType(a.ref, b.ref);
  return a.ref === b.ref;
}
