/* libc.h — 我们自己那份 libc 内部共用的一格（第一百四十片）。
 *
 * 只给**我们自己那几个 `.c`** 用 —— 用户程序看的是 `<sysroot>/include` 里那份
 * glibc 形状的头。两份刻意不共用：那边的 `FILE` 是 glibc 的不透明结构，
 * 我们这边就是一个 fd 加一格缓冲。
 */
#ifndef __OMNI_LIBC_H
#define __OMNI_LIBC_H

#include "syscall.h"

/* `FILE`：一个 fd 加「读到头了没有」「出过错没有」两位。**无缓冲** ——
 * 每次读写都是一条 syscall。慢，但少一整套刷新的账，而且 `fflush` 是空操作。 */
struct __FILE {
  int fd;
  int eof;
  int err;
};
typedef struct __FILE FILE;

extern FILE *stdin;
extern FILE *stdout;
extern FILE *stderr;

/* 别的 `.c` 里那几样（这一份里不许再各写一遍）。 */
unsigned long strlen(const char *s);
void *memcpy(void *d, const void *s, unsigned long n);
void *memset(void *s, int c, unsigned long n);
int strcmp(const char *a, const char *b);
char *strchr(const char *s, int c);
void *malloc(unsigned long size);
void free(void *p);
long write(int fd, const void *buf, unsigned long n);
long read(int fd, void *buf, unsigned long n);
int open(const char *path, int flags, ...);
int close(int fd);
long lseek(int fd, long off, int whence);
void _exit(int code);

/* 明着没实现的那些走这一条（`stub.c`）：往 stderr 印一句话再 `abort` ——
 * 悄悄回 0 的后果是调用方拿着假结果往下跑，那比崩在原地坏得多。 */
void __libc_unimpl(const char *what);
/* `atexit` 注册的那些（表在 `misc.c` 上，`exit` 在 `stdio.c` 里调）。 */
void __libc_run_atexit(void);

#endif
