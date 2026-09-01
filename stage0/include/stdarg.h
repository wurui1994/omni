/* <stdarg.h> —— 自带的那一份（ADR-0017 第八刀第二片）。
 *
 * arm64 上 `va_start` / `va_arg` 是**编译器内建**（tcc 的 `tcctok.h:181-182`），
 * 所以这份头文件只是把标准的名字接到那几个内建上 —— 一行都不必知道变参区长什么样。
 * `__builtin_va_list` 在我们这边是一条预置的 typedef（见 tccgen.js 构造函数）。
 *
 * `va_copy` 与 `va_end` 在 C 里也是宏，不是函数 —— 标准要求它们能写成
 * `va_end(ap);` 这种语句，所以这儿也是宏。 */
#ifndef _STDARG_H
#define _STDARG_H

typedef __builtin_va_list va_list;

#define va_start(ap, last) __builtin_va_start(ap, last)
#define va_arg(ap, type) __builtin_va_arg(ap, type)
#define va_copy(dst, src) __builtin_va_copy(dst, src)
#define va_end(ap) __builtin_va_end(ap)

/* 早年的 `<varargs.h>` 写法（tcc 也带一份）：这一格还没到 —— `va_alist` /
 * `va_dcl` 要一套「形参列表里不写名字」的规则，与 K&R 的旧式声明是同一件事。 */

#endif /* _STDARG_H */
