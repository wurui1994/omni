/* `<stdio.h>` —— arm64-osx 的那一份（交叉编译用）。
 *
 * 三条标准流在 macOS 上不是 `stdout` 这个符号，而是 `__stdoutp`（SDK 的
 * `<stdio.h>`：`extern FILE *__stdoutp;` 加一句 `#define stdout __stdoutp`）——
 * 那也是 `.def` 里要写 `___stdoutp`（Mach-O 的名字前面还有一条下划线）的原因。 */
#ifndef _STDIO_H
#define _STDIO_H

#include <stddef.h>
#include <stdarg.h>

struct __sFILE;
typedef struct __sFILE FILE;

extern FILE *__stdinp;
extern FILE *__stdoutp;
extern FILE *__stderrp;
#define stdin __stdinp
#define stdout __stdoutp
#define stderr __stderrp

#define EOF (-1)
#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2
#define BUFSIZ 1024

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
