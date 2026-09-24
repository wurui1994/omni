/* `<stdlib.h>` —— win32 的那一份（两个 arch 共用）（交叉编译用；形状沿用 Linux 那一套，见 ../README.md）。
 *
 * `realpath` 在 glibc 上住在这儿（macOS 那边也一样）；`mkdtemp` 是 POSIX 的，
 * glibc 在 `__USE_MISC` 下从 `<stdlib.h>` 露出来 —— 我们照露。 */
#ifndef _STDLIB_H
#define _STDLIB_H

#include <stddef.h>

#define EXIT_SUCCESS 0
#define EXIT_FAILURE 1

void *malloc(size_t n);
void *calloc(size_t n, size_t sz);
void *realloc(void *p, size_t n);
void free(void *p);

void exit(int code);
/* `_Exit`：不跑 atexit 直接走（C99）。`omni_prof.c` 用它 —— 声明漏了会当隐式 int。 */
void _Exit(int code);
void abort(void);
int atexit(void (*fn)(void));

int atoi(const char *s);
double atof(const char *s);
long strtol(const char *s, char **end, int base);
long long strtoll(const char *s, char **end, int base);
unsigned long long strtoull(const char *s, char **end, int base);
double strtod(const char *s, char **end);

char *getenv(const char *name);
int setenv(const char *name, const char *val, int overwrite);
int system(const char *cmd);

char *mkdtemp(char *tmpl);
char *realpath(const char *path, char *resolved);

void qsort(void *base, size_t n, size_t sz, int (*cmp)(const void *, const void *));

#endif
