/* `<stdio.h>` —— x86_64-linux 的那一份（交叉编译用）。
 *
 * `FILE` 是**不透明的**：我们的运行时只拿它的指针（`fopen`/`fclose`/`fread` …），
 * 一个字段都不碰 —— 所以这儿只要一个 `struct _IO_FILE;` 的前置声明。
 *
 * 三条标准流在 glibc 上是**真的数据符号**（`extern FILE *stdout;`，不像 macOS 那层
 * `__stdoutp` 的宏），所以 `.def` 里它们要标 `DATA 8`（copy 重定位要划那么大一块）。 */
#ifndef _STDIO_H
#define _STDIO_H

#include <stddef.h>
#include <stdarg.h>

struct _IO_FILE;
typedef struct _IO_FILE FILE;

extern FILE *stdin;
extern FILE *stdout;
extern FILE *stderr;

#define EOF (-1)
#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2
#define BUFSIZ 8192

int printf(const char *fmt, ...);
int fprintf(FILE *f, const char *fmt, ...);
int snprintf(char *s, size_t n, const char *fmt, ...);
int vsnprintf(char *s, size_t n, const char *fmt, va_list ap);
int sscanf(const char *s, const char *fmt, ...);
int puts(const char *s);
int fputs(const char *s, FILE *f);
int fputc(int c, FILE *f);
int fgetc(FILE *f);
int putchar(int c);

FILE *fopen(const char *path, const char *mode);
int fclose(FILE *f);
size_t fread(void *p, size_t sz, size_t n, FILE *f);
size_t fwrite(const void *p, size_t sz, size_t n, FILE *f);
int fseek(FILE *f, long off, int whence);
long ftell(FILE *f);
void rewind(FILE *f);
int fflush(FILE *f);
int remove(const char *path);
int rename(const char *from, const char *to);
void perror(const char *s);

#endif
