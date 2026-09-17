/* libc.h — 我们自己那份 libc 里**公用**那一半的接口（第一百四十片第五格）。
 *
 * 目录是这么分的：
 *   `src/sysroot/libc/`              公用：一行 syscall 都没有的那些
 *                                    （string / math / strtox / stdio / file / malloc）
 *   `src/sysroot/<arch>-<os>/libc/`  这台目标专有：syscall.h、io.c、misc.c、start.c
 *
 * 分界只有一条：**这段代码认不认得内核**。`printf` 的格式化引擎认不得（它只往
 * `write` 那个口子吐字节），所以 stdio.c 是公用的；`opendir` 得知道 `getdents64`
 * 那条记录长什么样，所以 misc.c 是专有的。分完之后 math 那四十来个函数在两个目标上
 * 是**同一份文件** —— 改一次两边都跟着走，不会各飘一份。
 *
 * 用户程序看的是 `<sysroot>/include` 里那份 glibc/SDK 形状的头，与这一份刻意不共用：
 * 那边的 `FILE` 是不透明结构，我们这边就是一个 fd 加两位状态。
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

/* ---- 公用那一半自己里头互相要用的 */
unsigned long strlen(const char *s);
void *memcpy(void *d, const void *s, unsigned long n);
void *memset(void *s, int c, unsigned long n);
int strcmp(const char *a, const char *b);
char *strchr(const char *s, int c);
void *malloc(unsigned long size);
void free(void *p);

/* ---- 基 10^9 的大整数（`dec.c`）：浮点的两头共用一份。
 *
 * 打印那一头要「double 的精确十进制展开」，解析那一头要「一串十进制离哪个 double 最近」
 * —— 都是同一件事的两个方向，所以实现摆在公用的 `dec.c` 里，一份。
 * 节数的上界是量出来的（见那份的文件头）：一个 `__libc_dec` 808 字节，全在栈上。 */
#define LIBC_DEC_LIMBS 200
typedef struct { unsigned int w[LIBC_DEC_LIMBS]; int n; } __libc_dec;

void __libc_dec_set(__libc_dec *d, unsigned long long v);
void __libc_dec_add(__libc_dec *d, unsigned int v);
void __libc_dec_copy(__libc_dec *dst, const __libc_dec *src);
void __libc_dec_addbig(__libc_dec *a, const __libc_dec *b);
int __libc_dec_zero(const __libc_dec *d);
void __libc_dec_mul(__libc_dec *d, unsigned int m);
unsigned int __libc_dec_div(__libc_dec *d, unsigned int m);
int __libc_dec_cmp(const __libc_dec *a, const __libc_dec *b);
void __libc_dec_sub(__libc_dec *a, const __libc_dec *b);
void __libc_dec_pow2(__libc_dec *d, int e);
void __libc_dec_pow5(__libc_dec *d, int k);
void __libc_dec_pow10(__libc_dec *d, int k);
int __libc_dec_digits(const __libc_dec *d, char *out, int cap);
int __libc_dec_of_me(unsigned long long m, int e, char *out, int cap, int *frac);

/* ---- 每个目标的 io.c / misc.c 各给一份（这一半认得内核） */
long write(int fd, const void *buf, unsigned long n);
long read(int fd, void *buf, unsigned long n);
int open(const char *path, int flags, ...);
int close(int fd);
long lseek(int fd, long off, int whence);
void _exit(int code);
/** 跟系统要一块**至少** `least` 字节的地方：回起点，回 0 是要不到；实际给了多少
 *  写回 `*got`。Linux 那边是 `brk`、macOS 那边是 `mmap`（那儿没有 brk）——
 *  所以公用的 malloc **不假设两次要来的地方是连着的**。 */
unsigned long __libc_chunk(unsigned long least, unsigned long *got);
/* `atexit` 那张表在各目标的 `misc.c` 上，`exit`（公用的 stdio.c）收场时调这一条。 */
void __libc_run_atexit(void);

/* 明着没实现的那些走这一条（公用的 `stdio.c`）：往 stderr 印一句话再 `abort` ——
 * 悄悄回 0 的后果是调用方拿着假结果往下跑，那比崩在原地坏得多。 */
void __libc_unimpl(const char *what);

#endif
