/* <string.h> —— 只有我们真的 shim 了的那几个（ADR-0017 第八刀第三片）。
 * 身份与取舍见 stdio.h 头上那一节。
 *
 * `strdup` 是 POSIX 而不是 C 标准里的，但它在 `interp/libc.js` 的表里
 * （tinycc 的源码在用），所以放这儿 —— 这一份跟的是那张表，不是标准的目录。
 *
 * 少了什么：`strncpy` / `strncmp` / `strchr` / `strrchr` / `strstr` /
 * `strtok`（都是 `interp/libc.js` 里还没有的，下一格连着实现一起加）。
 */
#ifndef _STRING_H
#define _STRING_H

#include <stddef.h>

size_t strlen(const char *s);
int strcmp(const char *a, const char *b);
char *strcpy(char *dst, const char *src);
char *strcat(char *dst, const char *src);
char *strdup(const char *s);

void *memcpy(void *dst, const void *src, size_t n);
void *memmove(void *dst, const void *src, size_t n);
void *memset(void *dst, int c, size_t n);
int memcmp(const void *a, const void *b, size_t n);

#endif /* _STRING_H */
