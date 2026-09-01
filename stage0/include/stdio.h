/* <stdio.h> —— 只有我们真的 shim 了的那几个（ADR-0017 第八刀第三片）。
 *
 * ## 这一份与前四份不一样
 *
 * `stddef.h` / `stdarg.h` / `stdbool.h` / `float.h` 是**编译器必须自己给**的，
 * tcc 也自带；这一份不是 —— tcc 把 `<stdio.h>` 转手给系统，链接期再去 libc 里找符号。
 * 我们在解释器这条腿上没有真的 libc（指针是自家线性内存里的偏移，宿主的 libc 读不到，
 * 见 `interp/libc.js` 头上那一节），所以「有哪些 libc 函数」这件事得由我们自己说。
 *
 * 于是这一份的身份是**自述**：`interp/libc.js` 里那张表有什么，这里就声明什么，
 * **多一个都不声明**。缺的那些不会在这儿悄悄声明成 implicit int，而是在编译期报
 * `undefined symbol '...'`（照 tcc 的原话）—— 一眼看得出是进度，不是 bug。
 *
 * 所以这是一处**刻意的分岔**：tcc 转手系统头、我们自带一份小的。等到自带后端
 * 那条路（ADR 第 9-11 步）真的链上 libc，这一份就换成「转手系统的」，
 * 那时要的 `#include_next` / `__asm("_name")` / `__attribute__` 也都到位了。
 *
 * ## 少了什么，为什么
 *
 * - **没有 `FILE`**、没有 `fopen` / `fprintf` / `fputs` / `stdout` / `stderr`。
 *   它们要真的文件描述符与宿主 IO，是另一片。现在的输出只有一条路：
 *   `printRaw` 写到进程的 stdout（对账的正是这一条）。
 * - **没有 `scanf` 一族**：读进来的方向一个字节都还没做。
 */
#ifndef _STDIO_H
#define _STDIO_H

#include <stddef.h>
#include <stdarg.h>

#define EOF (-1)

int putchar(int c);
int puts(const char *s);
int printf(const char *fmt, ...);
int sprintf(char *dst, const char *fmt, ...);
int snprintf(char *dst, size_t n, const char *fmt, ...);

int vprintf(const char *fmt, va_list ap);
int vsprintf(char *dst, const char *fmt, va_list ap);
int vsnprintf(char *dst, size_t n, const char *fmt, va_list ap);

#endif /* _STDIO_H */
