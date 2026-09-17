/* `<stdlib.h>` —— arm64-osx 的那一份（交叉编译用）。 */
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
