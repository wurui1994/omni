/* <stddef.h> —— 自带的那一份（ADR-0017 第八刀第二片）。
 *
 * 与 tcc 的 `include/stddef.h` 同一个位置、同一份语义：类型都从**预定义的宏**里来
 * （`__SIZE_TYPE__` 一族，见 tccdefs.js），于是「size_t 在这个目标上是什么」
 * 只有一处说法。这不是抄它的文本 —— 是同一件事的同一种做法。
 *
 * `_SIZE_T_DEFINED` 那几个守卫是给系统头文件看的：将来真的接上 macOS 的头之后，
 * 谁先来谁定义，后来的那份看见守卫就跳过。tcc 也是这么干的。 */
#ifndef _STDDEF_H
#define _STDDEF_H

#ifndef NULL
#define NULL ((void *)0)
#endif

#ifndef _SIZE_T_DEFINED
#define _SIZE_T_DEFINED
typedef __SIZE_TYPE__ size_t;
#endif

#ifndef _PTRDIFF_T_DEFINED
#define _PTRDIFF_T_DEFINED
typedef __PTRDIFF_TYPE__ ptrdiff_t;
#endif

#ifndef _WCHAR_T_DEFINED
#define _WCHAR_T_DEFINED
typedef __WCHAR_TYPE__ wchar_t;
#endif

/* 「0 号对象里那个成员的地址」—— 不解引用，所以页 0 空着也没关系。 */
#define offsetof(type, member) ((size_t) & ((type *)0)->member)

#endif /* _STDDEF_H */
