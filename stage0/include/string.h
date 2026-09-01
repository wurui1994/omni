/* <string.h> —— 只有我们真的 shim 了的那几个（ADR-0017 第八刀第三片）。
 * 身份与取舍见 stdio.h 头上那一节。
 *
 * `strdup` 是 POSIX 而不是 C 标准里的，但它在 `interp/libc.js` 的表里
 * （tinycc 的源码在用），所以放这儿 —— 这一份跟的是那张表，不是标准的目录。
 *
 * 少了什么：`strspn` / `strcspn` / `strtok` / `strpbrk`
 * （都是 `interp/libc.js` 里还没有的，加声明就得加实现）。
 */
#ifndef _STRING_H
#define _STRING_H

#include <stddef.h>

size_t strlen(const char *s);
int strcmp(const char *a, const char *b);
int strncmp(const char *a, const char *b, size_t n);
char *strcpy(char *dst, const char *src);
char *strncpy(char *dst, const char *src, size_t n);
char *strcat(char *dst, const char *src);
char *strncat(char *dst, const char *src, size_t n);
char *strdup(const char *s);
char *strchr(const char *s, int c);
char *strrchr(const char *s, int c);
char *strstr(const char *haystack, const char *needle);

/* `strerror` 回的是一块**共用的静态缓冲**（C11 7.24.6.2 第 3 段允许下一次调用把它
 * 改掉），所以 `printf("%s %s", strerror(1), strerror(2))` 两个 %s 是同一句话 ——
 * 真的 libc 也是这样。那一块由前端在 data 段里留（第八刀第十三片）。 */
char *strerror(int errnum);

void *memcpy(void *dst, const void *src, size_t n);
void *memmove(void *dst, const void *src, size_t n);
void *memset(void *dst, int c, size_t n);
int memcmp(const void *a, const void *b, size_t n);

#endif /* _STRING_H */
