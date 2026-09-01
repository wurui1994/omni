/* <stdlib.h> —— 只有我们真的 shim 了的那几个（ADR-0017 第八刀第三片）。
 * 身份与取舍见 stdio.h 头上那一节 —— 这一份是同一件事的另一半。
 *
 * 少了什么：`qsort` / `bsearch`（要通过函数指针回调进 MIR，
 * 而现在 CCALL 是「宿主调宿主」的单向门 —— 这一格要先让 libc 能**回头**调 MIR，
 * 是真的一格新东西）、`strtod`（要一份十进制到 double 的正确舍入，
 * 而那与 `%f` 那一侧的分歧是同一件事）、`getenv` / `system`（要宿主进程环境）、
 * `atexit`（要一张退出时跑的表，而 `exit` 现在是一个抛出去的信号）。
 *
 * `strtol` 一族有一格与 tcc 对不上：**溢出**。C 说回端点值并设 `errno = ERANGE`，
 * 我们回同样的值但没有 `errno`（要一份 `<errno.h>` 与一个每线程的变量，独立一格），
 * 所以用例避开溢出的输入。
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

int atoi(const char *s);
long atol(const char *s);
long strtol(const char *s, char **end, int base);
unsigned long strtoul(const char *s, char **end, int base);

void exit(int code);
void abort(void);

#endif /* _STDLIB_H */
