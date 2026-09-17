/* syscall.h — arm64 macOS（Darwin）的系统调用号（第一百四十片第五格）。
 *
 * 号来自 XNU 的 `bsd/kern/syscalls.master`。arm64 上号还要带**类别位**：
 * BSD 那一类是 `2 << 24`（`SYSCALL_CLASS_UNIX`），所以这儿每个号都 `| 0x2000000`。
 * 少了那一位，`svc #0x80` 进去是「不认识的调用」。
 *
 * 与 Linux 那一份的三处不一样，都记在这儿（别的地方不用再解释）：
 *   1. 摆法：号进 **x16**、`svc #0x80`（Linux 是 x8 + `svc #0`）—— 那是后端的事
 *      （`arm64/from_mir.js` 的 `SYSCALL`）。
 *   2. 出错：Darwin **置进位标志**、x0 里是**正的** errno。后端已经把进位折进符号
 *      （`cneg x0, x0, cs`），所以到了这一层「回负数就是 -errno」与 Linux 一样。
 *   3. `brk` **没有**（早年就废了）：要地方只能 `mmap`，见 io.c 的 `__libc_chunk`。
 */
#ifndef __OMNI_SYSCALL_H
#define __OMNI_SYSCALL_H

#define SYS_CLASS_UNIX      0x2000000

#define SYS_exit            (SYS_CLASS_UNIX | 1)
#define SYS_fork            (SYS_CLASS_UNIX | 2)
#define SYS_read            (SYS_CLASS_UNIX | 3)
#define SYS_write           (SYS_CLASS_UNIX | 4)
#define SYS_open            (SYS_CLASS_UNIX | 5)
#define SYS_close           (SYS_CLASS_UNIX | 6)
#define SYS_wait4           (SYS_CLASS_UNIX | 7)
#define SYS_unlink          (SYS_CLASS_UNIX | 10)
#define SYS_chdir           (SYS_CLASS_UNIX | 12)
#define SYS_getpid          (SYS_CLASS_UNIX | 20)
#define SYS_access          (SYS_CLASS_UNIX | 33)
#define SYS_kill            (SYS_CLASS_UNIX | 37)
#define SYS_pipe            (SYS_CLASS_UNIX | 42)
#define SYS_sigaction       (SYS_CLASS_UNIX | 46)
#define SYS_ioctl           (SYS_CLASS_UNIX | 54)
#define SYS_readlink        (SYS_CLASS_UNIX | 58)
#define SYS_execve          (SYS_CLASS_UNIX | 59)
#define SYS_munmap          (SYS_CLASS_UNIX | 73)
#define SYS_dup2            (SYS_CLASS_UNIX | 90)
#define SYS_fcntl           (SYS_CLASS_UNIX | 92)
#define SYS_gettimeofday    (SYS_CLASS_UNIX | 116)
#define SYS_getrusage       (SYS_CLASS_UNIX | 117)
#define SYS_rename          (SYS_CLASS_UNIX | 128)
#define SYS_mkdir           (SYS_CLASS_UNIX | 136)
#define SYS_rmdir           (SYS_CLASS_UNIX | 137)
#define SYS_getrlimit       (SYS_CLASS_UNIX | 194)
#define SYS_mmap            (SYS_CLASS_UNIX | 197)
#define SYS_lseek           (SYS_CLASS_UNIX | 199)
#define SYS_getcwd          (SYS_CLASS_UNIX | 326)
#define SYS_stat64          (SYS_CLASS_UNIX | 338)
#define SYS_fstat64         (SYS_CLASS_UNIX | 339)
#define SYS_getdirentries64 (SYS_CLASS_UNIX | 344)

/* errno 翻译：内核（经后端那条 `cneg` 之后）回 -errno，libc 翻成 -1 + 全局 errno。 */
extern int __libc_errno_val;

static long __libc_check(long r) {
  if (r < 0 && r >= -4095) {
    __libc_errno_val = (int)(-r);
    return -1;
  }
  return r;
}

#endif
