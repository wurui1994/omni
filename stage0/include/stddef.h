/* <stddef.h> —— 自带的那一份（ADR-0017 第八刀第二片、第九十一片）。
 *
 * 与 tcc 的 `include/stddef.h` 同一个位置、同一份内容：类型都从**预定义的宏**里来
 * （`__SIZE_TYPE__` 一族，见 tccdefs.js），于是「size_t 在这个目标上是什么」
 * 只有一处说法。
 *
 * 第九十一片把这一份对着 tcc 那一份**逐行对齐**了 —— 尺子是「同一份 `.c` 交给两边，
 * `-E` 出来的字节一样」，而头文件的内容直接就是输出的一部分：typedef 的**条数与次序**、
 * `offsetof` 展开成什么、有没有那句 `alloca` 的声明，都在输出里看得见。
 * 拿 tinycc 自己的源码当尺子的时候（`tests/c/selfpp.js`），这一份对不齐就是十几行差异。
 *
 * 三处值得说的：
 * - `offsetof` 走 `__builtin_offsetof`，而那个名字只在**编译**那一路上是宏
 *   （tccdefs.js 的 `COMPILE_DEFS`）—— 于是 `-E` 出来的是 `__builtin_offsetof(...)`
 *   原样，与 tcc 一致；真编的时候才展开成「0 号对象里那个成员的地址」。
 * - `ssize_t` / `intptr_t` / `uintptr_t` 也在这儿：SDK 的头里也有同名 typedef，
 *   两份的底层类型相同，C11 6.7 允许重复。
 * - 那句 `void *alloca(size_t size);`：`alloca` 在 SDK 的 `<alloca.h>` 里是宏
 *   （`__builtin_alloca`），所以先包过 `<stdlib.h>` 的程序看到的是展开后的样子 ——
 *   tcc 那边一模一样，因为这一句的文本一样。
 */
#ifndef _STDDEF_H
#define _STDDEF_H

typedef __SIZE_TYPE__ size_t;
typedef __PTRDIFF_TYPE__ ssize_t;
typedef __WCHAR_TYPE__ wchar_t;
typedef __PTRDIFF_TYPE__ ptrdiff_t;
typedef __PTRDIFF_TYPE__ intptr_t;
typedef __SIZE_TYPE__ uintptr_t;

#if __STDC_VERSION__ >= 201112L
typedef union { long long __ll; long double __ld; } max_align_t;
#endif

#ifndef NULL
#define NULL ((void*)0)
#endif

#undef offsetof
#define offsetof(type, field) __builtin_offsetof(type, field)

void *alloca(size_t size);

#endif

/* `wint_t` 那一格在守卫**外面**：老 glibc 会先 `#define __need_wint_t` 再包一次
 * `<stddef.h>`，只为拿这一个类型 —— 守卫里头的话第二次就整份跳过了。
 * `_WINT_T` 是别人已经给过的记号，认它是为了不重复定义。 */
#if defined (__need_wint_t)
#ifndef _WINT_T
#define _WINT_T
typedef __WINT_TYPE__ wint_t;
#endif
#undef __need_wint_t
#endif
