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
/* ---- 变参：`__builtin_va_*` -> MSVC 的那一套 ----
 *
 * 我们这份 libc 的 printf 一族写的是 GCC/clang/tcc 都认的 `__builtin_va_list` 与那三个
 * 内建（我们自己那台 C 前端也认）。MSVC 一个都不认：它的 `va_list` 在 `<stdarg.h>` 里，
 * 是另一个类型。量到的是
 *   src/sysroot/libc/file.c(150): error C2065: '__builtin_va_list': undeclared identifier
 *
 * 只在 `--cc msvc` 那条腿上走这一支（`_MSC_VER` 只有 cl 会定义），别的腿一个字不变。 */
/* ---- MSVC 上的 __builtin_frame_address（第 msvc 刀）----
 * MSVC 没有这一格，最接近的是 `_AddressOfReturnAddress()`（回"返回地址所在的那个槽"）。
 * 用处只有一处：Linux 的 `_start` 靠它捞栈上的 argc/argv。win32 这条腿不走那一路
 * （命令行问 `GetCommandLineA`），所以这儿只要能编过、语义对得上就够。 */
#ifdef _MSC_VER
/* 自己声明一句就够 —— MSVC 按名字认这个内建；**不 include <intrin.h>**（那一份要 UCRT）。 */
extern void *_AddressOfReturnAddress(void);
#define __builtin_frame_address(n) ((void *)_AddressOfReturnAddress())
#endif

#ifdef _MSC_VER
#include <stdarg.h>
#define __builtin_va_list va_list
#define __builtin_va_start(ap, last) va_start(ap, last)
#define __builtin_va_arg(ap, T) va_arg(ap, T)
#define __builtin_va_end(ap) va_end(ap)
#define __builtin_va_copy(d, s) va_copy(d, s)
#endif

#ifndef __OMNI_LIBC_H
#define __OMNI_LIBC_H

#include "syscall.h"

/* **和指针一样宽的无符号整数**（第 win-c-backend 刀）。
 *
 * 从前这一份到处用 `unsigned long` 当「大小 / 地址」——在 Linux 与 macOS 上那是 8 字节，
 * 没问题；可 **Windows 是 LLP64：`long` 只有 4 字节**（我们自己的 C 前端也照这个模型，
 * 见 `frontend-c/tccdefs.js` 的 `win32: { longSize: 4 … }`）。于是 `__libc_chunk` 回的
 * 那个「地方的起点」在 win32 上被截成 32 位。
 *
 * 为什么先前没炸：`VirtualAlloc(0, …)` 是**从地址空间底下往上找**的，进程早期要到的
 * 那几块都落在 4GB 以内，截了也还是原值。等到低处用完或者碎了，就会拿到高地址 ——
 * 那时候 malloc 会静静地把一个截断的指针发出去。这种 bug 不该留着等。
 *
 * 两条 Unix 腿上这个 typedef **就是 `unsigned long`**（逐字节不变）；win32 上是 8 字节。 */
#ifdef _WIN32
typedef unsigned long long __libc_usize;
#else
typedef unsigned long __libc_usize;
#endif

/* `FILE`：一个 fd 加「读到头了没有」「出过错没有」两位，再加一格 `ungetc` 的退回位。
 * **无缓冲** —— 每次读写都是一条 syscall。慢，但少一整套刷新的账，`fflush` 是空操作。
 * `back` 是 -1 表示空（C11 只保证一格退回，我们就给一格）。 */
struct __FILE {
  int fd;
  int eof;
  int err;
  int back;
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
void *malloc(__libc_usize size);
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
/** `abort` 要先给自己一枪（SIGABRT）再退 134 —— 那一枪只有目标专有那一半发得出来
 *  （`misc.c` 的 `kill`）。从前这儿是公用的 stdio.c 直接写 `__omni_syscall(SYS_kill, …)`，
 *  于是 win32 那条腿一编就停在那行：**Windows 上没有 syscall、也没有信号**。
 *  改成走 `kill` 之后，两条 Unix 腿逐字节不变，win32 上它回 ENOSYS，收场仍然是 134。 */
int kill(int pid, int sig);
/** 跟系统要一块**至少** `least` 字节的地方：回起点，回 0 是要不到；实际给了多少
 *  写回 `*got`。Linux 那边是 `brk`、macOS 那边是 `mmap`（那儿没有 brk）——
 *  所以公用的 malloc **不假设两次要来的地方是连着的**。 */
__libc_usize __libc_chunk(__libc_usize least, __libc_usize *got);
/* `atexit` 那张表在各目标的 `misc.c` 上，`exit`（公用的 stdio.c）收场时调这一条。 */
void __libc_run_atexit(void);

/* 明着没实现的那些走这一条（公用的 `stdio.c`）：往 stderr 印一句话再 `abort` ——
 * 悄悄回 0 的后果是调用方拿着假结果往下跑，那比崩在原地坏得多。 */
void __libc_unimpl(const char *what);

#endif
