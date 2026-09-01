// 预定义的宏 —— tcc 的 `tcc_predefs`（`tccdefs.h` 编译进二进制的那一份）加上
// `tcc_state` 里按目标补的那几条（`libtcc.c` 的 `tcc_new`）。ADR-0017 第八刀第一片。
//
// # 为什么这一份要逐条对着 `tcc -dM -E` 抄
//
// 这些宏是**目标的自述**：`__aarch64__` 决定 libc 头文件走哪一支，`__SIZEOF_LONG__`
// 决定 `size_t` 是什么，`__APPLE__` 决定要不要 `_` 前缀。少一条、多一条、值差一位，
// 系统头文件就会展开成另一份声明 —— 而那种错不会在这一层暴露，会在几千行之后
// 以「类型不匹配」的样子冒出来。所以这一份的 oracle 是 `tcc -dM -E` 的**逐行输出**，
// 顺序也照它（tcc 的 `-dM` 是**边定义边印**，不是最后 dump 一张表，所以顺序就是
// 定义顺序）。
//
// 量出来的（`tcc -dM -E /dev/null`，本机 = macOS + arm64）：50 条，见下面这张表。
// 它是**这一个目标**的样子，不是 C 的样子 —— 换目标要换表，所以表里按 tcc 那边的
// 来源分了段，每段头上写清楚是谁在管。
//
// 三类需要解释的：
//
//   - `_Nonnull` / `_Nullable` / `_Null_unspecified` / `_Nullable_result` 展开成空：
//     macOS 的头文件到处在用 clang 的 nullability 标注，tcc 不认，就抹掉。
//   - `__REDIRECT` 一族与 `__has_builtin`/`__has_feature`/`__has_attribute` 回 0：
//     同一个理由 —— 让 glibc/macOS 的头文件走「编译器什么都不会」那一支。
//   - `_Float16 short unsigned int`：tcc 没有 `_Float16`，拿一个同宽的整型顶着，
//     这样头文件里那些声明至少能过语法。**它不是一份能算的 `_Float16`**，
//     碰到真的半精度运算会算错 —— 这一条是 tcc 自己的取舍，我们照抄，并且记在这儿。
//
// 还没到：`__DATE__` / `__TIME__` 之外的时间相关宏、`-U` 抹掉预定义、
// `-dM` 的逐行输出（那要一台「边定义边印」的钩子，独立一片）。

/**
 * 这个目标上的预定义宏，**按定义顺序**。`[名字, 宏体]`，宏体 `undefined` = 空展开。
 * 函数宏把形参写在名字里（`define()` 就是拼一行 `#define`，所以形状与源码一致）。
 *
 * `__BASE_FILE__` 不在表里 —— 它是「主输入文件」，由 `installPredefs` 补在最后，
 * 与 tcc 同一个位置。
 */
export const PREDEFS = [
  // ---- tcc 自己（`libtcc.c` 的 tcc_new -> tcc_define_symbol）
  ['__TINYC__', '928'],

  // ---- 目标 CPU（`TCC_TARGET_ARM64`）
  ['__aarch64__', '1'],
  ['__arm64__', '1'],
  ['__AARCH64EL__', '1'],

  // ---- 目标 OS（`TCC_TARGET_MACHO`）
  ['__APPLE__', '1'],
  ['__unix__', '1'],
  ['__unix', '1'],
  ['__TCC_PP__', '1'],
  ['__leading_underscore', '1'],

  // ---- 模型（LP64）
  ['__SIZEOF_POINTER__', '8'],
  ['__SIZEOF_LONG__', '8'],

  // ---- C 标准（tcc 报 C99）
  ['__STDC__', '1'],
  ['__STDC_HOSTED__', '1'],
  ['__STDC_VERSION__', '199901L'],

  // ---- 标准类型的底子（`tccdefs.h`）
  ['__SIZE_TYPE__', 'unsigned long'],
  ['__PTRDIFF_TYPE__', 'long'],
  ['__LP64__', '1'],
  ['__INT64_TYPE__', 'long long'],
  ['__SIZEOF_INT__', '4'],
  ['__INT_MAX__', '0x7fffffff'],
  ['__LONG_MAX__', '0x7fffffffffffffffL'],
  ['__SIZEOF_LONG_LONG__', '8'],
  ['__LONG_LONG_MAX__', '0x7fffffffffffffffLL'],
  ['__CHAR_BIT__', '8'],
  ['__ORDER_LITTLE_ENDIAN__', '1234'],
  ['__ORDER_BIG_ENDIAN__', '4321'],
  ['__BYTE_ORDER__', '__ORDER_LITTLE_ENDIAN__'],
  ['__WCHAR_TYPE__', 'int'],
  ['__WINT_TYPE__', 'int'],

  // ---- 装成 GCC 4（头文件里那些 `__GNUC__ >= 4` 的分支要它）
  ['__GNUC__', '4'],

  // ---- macOS 的头文件要的那几条
  ['__APPLE_CC__', '1'],
  ['__LITTLE_ENDIAN__', '1'],
  ['_DONT_USE_CTYPE_INLINE_', '1'],
  ['__FINITE_MATH_ONLY__', '1'],
  ['_FORTIFY_SOURCE', '0'],
  ['_Float16', 'short unsigned int'],

  // ---- 指针类型（放在 __PTRDIFF_TYPE__ 之后，宏体里引它）
  ['__UINTPTR_TYPE__', 'unsigned __PTRDIFF_TYPE__'],
  ['__INTPTR_TYPE__', '__PTRDIFF_TYPE__'],
  ['__INT32_TYPE__', 'int'],

  // ---- glibc 的 __REDIRECT 一族（macOS 上用不到，tcc 照定，我们照抄）
  ['__REDIRECT(name,proto,alias)', 'name proto __asm__(#alias)'],
  ['__REDIRECT_NTH(name,proto,alias)', 'name proto __asm__(#alias)__THROW'],
  ['__REDIRECT_NTHNL(name,proto,alias)', 'name proto __asm__(#alias)__THROWNL'],
  ['__PRETTY_FUNCTION__', '__FUNCTION__'],

  // ---- clang 的那三个探测宏：一律回 0 = 「这编译器什么都没有」
  ['__has_builtin(x)', '0'],
  ['__has_feature(x)', '0'],
  ['__has_attribute(x)', '0'],

  // ---- clang 的 nullability 标注：抹掉
  ['_Nonnull', undefined],
  ['_Nullable', undefined],
  ['_Nullable_result', undefined],
  ['_Null_unspecified', undefined],
];
