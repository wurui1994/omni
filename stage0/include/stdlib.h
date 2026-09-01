/* <stdlib.h> —— 只有我们真的 shim 了的那几个（ADR-0017 第八刀第三片）。
 * 身份与取舍见 stdio.h 头上那一节 —— 这一份是同一件事的另一半。
 *
 * 少了什么：`strtod`（要一份十进制到 double 的正确舍入，
 * 而那与 `%f` 那一侧的分歧是同一件事）、`system`（要宿主起进程）、
 * `atexit`（要一张退出时跑的表，而 `exit` 现在是一个抛出去的信号）。
 * `getenv` 第八刀第二十二片补上了 —— 跑起来的 tinycc 一进门就问 `CPATH` 一族。
 *
 * `strtol` 一族有一格与 tcc 对不上：**溢出**。C 说回端点值并设 `errno = ERANGE`，
 * 我们回同样的值但没有 `errno`（要一份 `<errno.h>` 与一个每线程的变量，独立一格），
 * 所以用例避开溢出的输入。
 *
 * `qsort` 也有一格：C 不要求它稳定，**相等元素之间的次序是未规定的**
 * （C11 7.22.5.2）。我们是插入排序，宿主的 libc 不是，所以要逐字节对账的用例里
 * 不能有比较相等的元素。
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

void qsort(void *base, size_t n, size_t size, int (*cmp)(const void *, const void *));
void *bsearch(const void *key, const void *base, size_t n, size_t size,
              int (*cmp)(const void *, const void *));

void exit(int code);
void abort(void);

/* 环境。回的指针**不归调用方**（C11 7.22.4.6：不许改、不许 free）——
 * 解释器那边一个名字缓存一格，于是同一个名字问两次是同一个地址。
 * 宿主的环境原样透出：与三条标准流同一个道理，「环境是谁的」只有宿主答得了。 */
char *getenv(const char *name);

#endif /* _STDLIB_H */
