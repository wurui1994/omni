/* stddef.h —— 只给 `--cc msvc` 这条腿用的那一份（第 msvc 刀）。
 *
 * 为什么不用 MSVC 自己的：它的 `stddef.h` 在 **UCRT** 里（不在 VC/include），而 UCRT 的头
 * 一进来就顺带把 `time_t`/`size_t` 一族按它的说法定一遍，与我们这套 sysroot 的定义冲突：
 *   sys/types.h(20): error C2371: 'time_t': redefinition; different basic types
 * 为什么不用 `src/include` 里那一份：那个目录里还有 `stdarg.h`，写的是
 * `typedef __builtin_va_list va_list;` —— 自带那台前端认，cl 不认。所以单独一个目录，
 * 只放"编译器该给、而我们这套又必须自己说"的那几格。
 *
 * `stdarg.h` **故意不在这儿**：那一份用 MSVC 的（VC/include 里有，且不牵扯 UCRT）。
 */
#ifndef __OMNI_MSVC_STDDEF_H
#define __OMNI_MSVC_STDDEF_H

#ifndef _SIZE_T_DEFINED
#define _SIZE_T_DEFINED
typedef unsigned long long size_t;
#endif

#ifndef _PTRDIFF_T_DEFINED
#define _PTRDIFF_T_DEFINED
typedef long long ptrdiff_t;
#endif

#ifndef _WCHAR_T_DEFINED
#define _WCHAR_T_DEFINED
typedef unsigned short wchar_t;
#endif

#ifndef NULL
#define NULL ((void *)0)
#endif

#ifndef offsetof
#define offsetof(T, m) ((size_t)((char *)&(((T *)0)->m) - (char *)0))
#endif

typedef long long max_align_t;

#endif /* __OMNI_MSVC_STDDEF_H */
