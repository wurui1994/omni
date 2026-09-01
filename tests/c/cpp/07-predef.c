/* 预定义的宏（ADR-0017 第八刀第一片）。oracle 还是 `tcc -E -P` 的逐字节输出 ——
 * 于是「这个目标上 __SIZEOF_LONG__ 是几」这种事不是我们说了算，是量出来的。 */

/* ---- 目标的自述：CPU / OS / 模型 */
aarch64 __aarch64__ __arm64__ __AARCH64EL__
apple __APPLE__ __APPLE_CC__ __unix__ __unix
model __LP64__ __SIZEOF_POINTER__ __SIZEOF_LONG__ __SIZEOF_INT__ __SIZEOF_LONG_LONG__
endian __BYTE_ORDER__ __ORDER_LITTLE_ENDIAN__ __ORDER_BIG_ENDIAN__ __LITTLE_ENDIAN__

/* ---- 标准与身份 */
std __STDC__ __STDC_HOSTED__ __STDC_VERSION__
who __TINYC__ __GNUC__ __TCC_PP__ __leading_underscore

/* ---- 标准类型的底子 */
types __SIZE_TYPE__ | __PTRDIFF_TYPE__ | __INT64_TYPE__ | __INT32_TYPE__
ptr __INTPTR_TYPE__ | __UINTPTR_TYPE__
wide __WCHAR_TYPE__ __WINT_TYPE__
limits __CHAR_BIT__ __INT_MAX__ __LONG_MAX__ __LONG_LONG_MAX__

/* ---- 给系统头文件看的那几条 */
guards _DONT_USE_CTYPE_INLINE_ __FINITE_MATH_ONLY__ _FORTIFY_SOURCE
half _Float16
probe __has_builtin(x) __has_feature(y) __has_attribute(z)
null int * _Nonnull p; int * _Nullable q; int * _Null_unspecified r; int * _Nullable_result s;
redirect __REDIRECT(f, (int), g)
pretty __PRETTY_FUNCTION__

/* ---- __BASE_FILE__ 是「主输入文件」，与 __FILE__ 在这一层同一个值 */
base __BASE_FILE__

/* ---- 拿它们做条件编译 */
#if defined(__aarch64__) && __SIZEOF_POINTER__ == 8
lp64 yes
#else
lp64 no
#endif

#if __STDC_VERSION__ >= 199901L
c99 yes
#endif

#if __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
little yes
#endif

#ifdef __x86_64__
x86 yes
#else
x86 no
#endif

/* ---- 命令行之外还能被 #undef 掉 */
#undef __TINYC__
#ifdef __TINYC__
undef broken
#else
undef ok
#endif
