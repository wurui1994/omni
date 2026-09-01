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
 * - **没有 `scanf` 一族**：读进来的方向只有 `fgets` / `fgetc` / `fread`，
 *   格式化地读还没有。
 * - **文件是一份快照**（第八刀第十片）：`fopen` 时整份读进宿主的一个缓冲，
 *   `fclose`/`fflush` 时整份落盘。于是很大的文件与「边写边被别人读」不成立 ——
 *   刻意的简化，见 ADR-0017 第八刀第十片那一节。
 * - **`remove` 不真的删盘上的文件**，只把还开着的那份忘掉（同一处简化）。
 */
#ifndef _STDIO_H
#define _STDIO_H

#include <stddef.h>
#include <stdarg.h>

#define EOF (-1)

/* `fseek` 的第三个实参。值照本机的 `<stdio.h>` 量的。 */
#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2

/* 不完整类型：程序只能拿 `FILE *`，碰不到里头 —— C 就是这么规定的。 */
typedef struct __omni_FILE FILE;

FILE *__omni_stdin(void);
FILE *__omni_stdout(void);
FILE *__omni_stderr(void);

/* C 只要求这三个是 `FILE *` 类型的**表达式**（C11 7.21.1），不要求是可改的左值 ——
 * 所以宏展开成一次调用就够。`errno` 那一片不同：那个必须是左值，只能是内存。 */
#define stdin __omni_stdin()
#define stdout __omni_stdout()
#define stderr __omni_stderr()

int putchar(int c);
int puts(const char *s);
int printf(const char *fmt, ...);
int sprintf(char *dst, const char *fmt, ...);
int snprintf(char *dst, size_t n, const char *fmt, ...);

int vprintf(const char *fmt, va_list ap);
int vsprintf(char *dst, const char *fmt, va_list ap);
int vsnprintf(char *dst, size_t n, const char *fmt, va_list ap);

int fprintf(FILE *f, const char *fmt, ...);
int vfprintf(FILE *f, const char *fmt, va_list ap);
int fputs(const char *s, FILE *f);
int fputc(int c, FILE *f);
size_t fwrite(const void *p, size_t size, size_t n, FILE *f);
int fflush(FILE *f);

FILE *fopen(const char *path, const char *mode);
int fclose(FILE *f);
size_t fread(void *p, size_t size, size_t n, FILE *f);
char *fgets(char *dst, int n, FILE *f);
int fgetc(FILE *f);
int fseek(FILE *f, long off, int whence);
long ftell(FILE *f);
void rewind(FILE *f);
int feof(FILE *f);
int ferror(FILE *f);
int remove(const char *path);

/* `perror`（C11 7.21.10.4）：往 stderr 写 `前缀: 那句话\n`。前缀是空指针或空串时
 * 只写那句话，连 `: ` 都不写 —— 两条都是从 `tcc -run` 上量出来的（第八刀第十三片）。
 * 那句话与 `strerror(errno)` 是同一张表。 */
void perror(const char *s);

#endif /* _STDIO_H */
