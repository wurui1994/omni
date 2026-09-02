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
export const TY_LDOUBLE = ctype(VT_LDOUBLE);

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
 * 变长数组（C99 的 VLA，`int a[n]`）：长度在**运行期**才知道，所以类型上带的不是一个数，
 * 而是「那个数在哪儿」—— `vla` 是一个 MIR 槽号，槽里放着**整个数组的字节数**。
 *
 * tcc 那边是另一位（`VT_VLA`，`tcc.h:1063`），而且 VLA **不带** `VT_ARRAY`，于是它到处
 * 要写 `t & (VT_ARRAY|VT_VLA)`。这里反过来：VLA 就是一种数组（`isArray` 成立），
 * 「长度未定」照旧是 `count < 0`。这么选是因为退化成指针、下标、`&`、转换那几条路
 * 一个字都不用改 —— 差别只在「多大」这一问上，而那一问只有 `sizeof` 与划地方在问。
 * 代价是每一处**必须是常量大小**的位置都要单独挡一次（见 `isVla` 的用处）。
 */
export function mkVla(elem, szSlot) {
  const ty = ctype(VT_PTR | VT_ARRAY, elem);
  ty.count = -1;
  ty.vla = szSlot;
  return ty;
}

/** 这个类型是不是变长数组。 */
export function isVla(ty) {
  return isArray(ty.t) && ty.vla !== undefined;
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
 * 函数类型。`ref` 是 `{ret, params, variadic}` —— tcc 那边是一个 `Sym`，形参挂在
 * `sym->next` 那条链上（`tcc.h` 的 `Sym.type` + `func_type`），同一件事。
 *
 * 函数类型在 C 里**几乎总是立刻退化成指针**（C11 6.3.2.1 第 4 段），所以它主要是
 * 声明符里的一个中间产物：`int f(void)` 的 `f` 是函数，`int (*p)(void)` 的 `p` 是
 * 指向它的指针。有了这个类型，带括号的声明符才有东西可套。
 */
export function mkFunc(ret, params, variadic) {
  return ctype(VT_FUNC, { ret, params, variadic: variadic === true });
}

/* ------------------------------------------------- 位域（`tcc.h:1087-1088`）
 * 「从第几位开始」与「几位宽」各占 6 位，就挤在 `VT_STRUCT_SHIFT` 那一段里 ——
 * 于是位域信息**跟着类型走**：`s.f` 回一个内存左值，宽度与偏移在它的 `t` 里，
 * 不必给 SValue 加一格，也不会在传递过程中掉。
 *
 * 一律用 `>>>` 而不是 `>>`：宽度那一段占到第 26-31 位，`t` 在 JS 里是 int32，
 * 带着最高位的时候 `>>` 会把符号拖进来，读出来的宽度就成了 63。 */
export function isBitfield(t) { return (t & VT_BITFIELD) !== 0; }
export function bitPosOf(t) { return (t >>> VT_STRUCT_SHIFT) & 0x3f; }
export function bitSizeOf(t) { return (t >>> (VT_STRUCT_SHIFT + 6)) & 0x3f; }

/** 给一个类型挂上位域信息。`pos`/`bits` 各 ≤ 63。 */
export function mkBitfield(ty, pos, bits) {
  const t = (ty.t & ~VT_STRUCT_MASK) | VT_BITFIELD
    | (pos << VT_STRUCT_SHIFT) | (bits << (VT_STRUCT_SHIFT + 6));
  return ctype(t, ty.ref);
}

/** 去掉位域信息，回它**声明的**那个类型 —— 值的符号性与容器宽度按它算。 */
export function bitfieldBase(ty) {
  return ctype(ty.t & ~VT_STRUCT_MASK, ty.ref);
}

/**
 * 真正**用来访问内存**的那个类型（`adjust_bf`，`tccgen.c:1828`）。
 *
 * 多数位域就是它声明的那个类型。但 PCC 的布局会把一个位域摆在声明的类型装不下的
 * 地方：`unsigned long long high8:8` 排在第 36 位，而布局那一句
 * 「装得下的 long long 位域按 int 算」（`tccgen.c:4280`）已经把它的类型改成了 4 字节 ——
 * 36 + 8 越过 32。那时布局那一遍的收尾会给这条成员挑一个**别的**访问类型
 * （`tccgen.c:4366-4436`），偏移与位置一起改过，访问类型记在成员记录的 `aux` 上。
 *
 * 挂在 `ref` 上而不是给 SValue 加一格：tcc 就是这么做的（`f->type.ref = f`），
 * 标量类型的 `ref` 本来空着，于是访问类型和位域信息一样**跟着类型走**。
 *
 * 符号性仍然跟着**声明的**类型（`sv->type.t & ~(VT_BTYPE|VT_LONG) | t`）：
 * 读出来要不要符号扩展是声明说的事，与拿几个字节读无关。
 */
export function bfAccess(ty) {
  const base = bitfieldBase(ty);
  const fd = ty.ref;
  if (fd === null || fd === undefined || typeof fd.aux !== 'number' || fd.aux < 0) return base;
  return ctype((base.t & ~(VT_BTYPE | VT_LONG)) | fd.aux, null);
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
  /* `long double` 在这个目标上**就是 double**：`tcc.h:237-241` 对 MACHO+ARM64 与 PE
   * 开 `TCC_USING_DOUBLE_FOR_LDOUBLE`（注释原话：window 与 macos 上没有十字节的
   * long double）。x86_64/i386/riscv64 是 16/12/16，跟着那几条后端一起来。 */
  if (b === VT_LDOUBLE) return { size: 8, align: 8 };
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
  if (isFunc(t)) {
    const ps = ty.ref.params.map((p) => typeText(p.ty));
    if (ty.ref.variadic) ps.push('...');
    return `${typeText(ty.ref.ret)} (${ps.length === 0 ? 'void' : ps.join(', ')})`;
  }
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

/**
 * 两个类型「相容吗」—— tcc 的 `compare_types`（`tccgen.c:4130`），整个前端只有这一处。
 *
 * `unqualified` 为真时先脱掉**最外层**的 `const`/`volatile`（赋值要的是这一问：C11
 * 6.5.16.1 说两边必须是去掉限定符之后相容的类型；`const char *` 与 `char *` 那种差别在
 * 指向的东西上，不在这一层，递归下去时就不脱了 —— tcc 也是这么分的）。
 *
 * 三处容易漏掉的、而 tcc 都做了的事：
 *   1. **枚举**：两边都是枚举就比是不是同一个（`ref` 相等）；只有一边是，那一边就换成
 *      它的底层整型 —— 所以 `enum E` 与 `int` 是相容的。
 *   2. **`signed` 写没写只对 `char` 有意义**：`signed int` 与 `int` 是同一个类型，而
 *      `char` / `signed char` / `unsigned char` 是**三个**（C11 6.2.5 第 15 段）。
 *      所以基本类型不是 `VT_BYTE` 时先把 `VT_DEFSIGN` 抹掉。
 *   3. **数组的长度**要比，但**有一边没写长度就算相容**（`int a[]` 与 `int a[10]`）——
 *      暂定定义与「先声明后补全」全靠这一条。
 *
 * 比的是 `t & ~(VT_STORAGE | VT_STRUCT_MASK)`（tcc 的 `VT_TYPE`）：存储类不是类型的一部分，
 * struct/union/enum 那一段与位域那几位也不比 —— 前者由下面的 `ref` 相等分辨，
 * 后者（位域的偏移与宽度）是**成员**的事，不是类型的事。
 */
export function compareTypes(a, b, unqualified) {
  if (isEnum(a.t)) {
    if (isEnum(b.t)) return a.ref === b.ref;
    /* 只有一边是枚举 -> 换成它的底层整型（我们的枚举底层永远是 `int`，见 `mkEnum`）：
     * 去掉 `VT_ENUM` 那两位、`ref` 也不要，剩下的就是那个整型。 */
    a = ctype(a.t & ~VT_STRUCT_MASK, null);
  } else if (isEnum(b.t)) {
    b = ctype(b.t & ~VT_STRUCT_MASK, null);
  }
  const mask = ~(VT_STORAGE | VT_STRUCT_MASK);
  let t1 = a.t & mask;
  let t2 = b.t & mask;
  if (unqualified) {
    const q = VT_CONSTANT | VT_VOLATILE;
    t1 &= ~q;
    t2 &= ~q;
  }
  if (btype(t1) !== VT_BYTE) {
    t1 &= ~VT_DEFSIGN;
    t2 &= ~VT_DEFSIGN;
  }
  if (t1 !== t2) return false;
  if (isArray(t1)) {
    const c1 = a.count === undefined ? -1 : a.count;
    const c2 = b.count === undefined ? -1 : b.count;
    if (c1 >= 0 && c2 >= 0 && c1 !== c2) return false;
  }
  const bt = btype(t1);
  if (bt === VT_PTR) {
    if (a.ref === null || b.ref === null) return a.ref === b.ref;
    return compareTypes(a.ref, b.ref, 0);
  }
  if (bt === VT_STRUCT) return a.ref === b.ref;
  if (bt === VT_FUNC) {
    if (a.ref === null || b.ref === null) return a.ref === b.ref;
    /* 老式声明（`int f();` —— tcc 的 `FUNC_OLD`）**不说**形参是什么，所以只要返回类型
     * 相容就算相容，形参一概不比（`is_compatible_func`：见到 `FUNC_OLD` 当场回 1）。 */
    if (a.ref.old === true || b.ref.old === true) return compareTypes(a.ref.ret, b.ref.ret, 1);
    /* 函数类型是**结构性**地比的：`int (*)(int)` 每写一次就是一个新的 ref 对象，
     * 而 C 说这两个类型相同（C11 6.7.6.3 第 15 段）。struct 那边相反 —— 一个 tag
     * 一个对象，所以比引用就够（见 `mkStruct`）。 */
    if (a.ref.variadic !== b.ref.variadic) return false;
    if (a.ref.params.length !== b.ref.params.length) return false;
    if (!compareTypes(a.ref.ret, b.ref.ret, 1)) return false;
    for (let i = 0; i < a.ref.params.length; i++) {
      if (!compareTypes(a.ref.params[i].ty, b.ref.params[i].ty, 1)) return false;
    }
    return true;
  }
  return true;
}

/** 两个类型「一样吗」（tcc 的 `is_compatible_types`）。 */
export function sameType(a, b) {
  return compareTypes(a, b, 0);
}

/** 「去掉最外层的 const/volatile 之后一样吗」（tcc 的 `is_compatible_unqualified_types`）。 */
export function sameTypeUnqual(a, b) {
  return compareTypes(a, b, 1);
}
