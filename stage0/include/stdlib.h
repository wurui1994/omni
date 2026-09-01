/* <stdlib.h> —— 只有我们真的 shim 了的那几个（ADR-0017 第八刀第三片）。
 * 身份与取舍见 stdio.h 头上那一节 —— 这一份是同一件事的另一半。
 *
 * 少了什么：`atoi` / `strtol` 一族（要自己写字符串到数的解析，而那正是
 * tinycc 源码里在用的，下一格）、`qsort` / `bsearch`（要通过函数指针回调进 MIR，
 * 而现在 CCALL 是「宿主调宿主」的单向门 —— 这一格要先让 libc 能**回头**调 MIR，
 * 是真的一格新东西）、`getenv` / `system`（要宿主进程环境）、
 * `atexit`（要一张退出时跑的表，而 `exit` 现在是一个抛出去的信号）。
 */
#ifndef _STDLIB_H
#define _STDLIB_H

#include <stddef.h>

#define EXIT_SUCCESS 0
#define EXIT_FAILURE 1

void *malloc(size_t n);
void *calloc(size_t nmemb, size_t size);
void *realloc(void *p, size_t n);
void free(void *p);

int abs(int v);
long labs(long v);

void exit(int code);
void abort(void);

#endif /* _STDLIB_H */
