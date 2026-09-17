/* syscall.h — Linux x86_64 系统调用号。
 *
 * 只列我们自己的 libc 直接用到的那些（第一百四十片）。号来自
 * `arch/x86/entry/syscalls/syscall_64.tbl`，六年没变过。
 */
#ifndef __OMNI_SYSCALL_H
#define __OMNI_SYSCALL_H

#define SYS_read            0
#define SYS_write           1
#define SYS_open            2
#define SYS_close           3
#define SYS_stat            4
#define SYS_fstat           5
#define SYS_lseek           8
#define SYS_mmap            9
#define SYS_munmap          11
#define SYS_brk             12
#define SYS_rt_sigaction    13
#define SYS_ioctl           16
#define SYS_access          21
#define SYS_pipe            22
#define SYS_dup2            33
#define SYS_fork            57
#define SYS_execve          59
#define SYS_exit            60
#define SYS_wait4           61
#define SYS_kill            62
#define SYS_fcntl           72
#define SYS_getcwd          79
#define SYS_rename          82
#define SYS_mkdir           83
#define SYS_rmdir           84
#define SYS_unlink          87
#define SYS_clock_gettime   228
#define SYS_exit_group      231
#define SYS_openat          257
#define SYS_pipe2           293

/* errno 翻译：内核回 -errno，libc 翻成 -1 + 全局 errno。 */
extern int __libc_errno_val;

static long __libc_check(long r) {
  if (r < 0 && r >= -4095) {
    __libc_errno_val = (int)(-r);
    return -1;
  }
  return r;
}

#endif
