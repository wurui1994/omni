/* write.c — 文件 IO 的最小子集（第一百四十片）。
 * 只实现我们的运行时与 libc 头直接需要的。 */
#include "syscall.h"

int __libc_errno_val;

long write(int fd, const void *buf, unsigned long n) {
  return __libc_check(__omni_syscall(SYS_write, fd, (long)buf, (long)n));
}

long read(int fd, void *buf, unsigned long n) {
  return __libc_check(__omni_syscall(SYS_read, fd, (long)buf, (long)n));
}

int open(const char *path, int flags, ...) {
  /* 三参形式：用 openat(AT_FDCWD, path, flags, mode)。
   * 两参形式 mode=0 也安全（只有 O_CREAT 才看 mode）。*/
  return (int)__libc_check(__omni_syscall(SYS_openat, -100, (long)path, (long)flags, 0, 0));
}

int close(int fd) {
  return (int)__libc_check(__omni_syscall(SYS_close, fd));
}

int stat(const char *path, void *buf) {
  return (int)__libc_check(__omni_syscall(SYS_stat, (long)path, (long)buf));
}

int fstat(int fd, void *buf) {
  return (int)__libc_check(__omni_syscall(SYS_fstat, fd, (long)buf));
}

long lseek(int fd, long off, int whence) {
  return __libc_check(__omni_syscall(SYS_lseek, fd, off, whence));
}

int mkdir(const char *path, unsigned int mode) {
  return (int)__libc_check(__omni_syscall(SYS_mkdir, (long)path, (long)mode));
}

int unlink(const char *path) {
  return (int)__libc_check(__omni_syscall(SYS_unlink, (long)path));
}

int rmdir(const char *path) {
  return (int)__libc_check(__omni_syscall(SYS_rmdir, (long)path));
}

int rename(const char *old, const char *new_) {
  return (int)__libc_check(__omni_syscall(SYS_rename, (long)old, (long)new_));
}

int access(const char *path, int mode) {
  return (int)__libc_check(__omni_syscall(SYS_access, (long)path, mode));
}

int dup2(int old, int new_) {
  return (int)__libc_check(__omni_syscall(SYS_dup2, old, new_));
}

int pipe(int fd[2]) {
  return (int)__libc_check(__omni_syscall(SYS_pipe, (long)fd));
}

int isatty(int fd) {
  /* ioctl(fd, TCGETS, &tmp)：成功说明是终端。 */
  char tmp[44];
  long r = __omni_syscall(SYS_ioctl, fd, 0x5401, (long)tmp);
  return r == 0 ? 1 : 0;
}

char *getcwd(char *buf, unsigned long size) {
  long r = __libc_check(__omni_syscall(SYS_getcwd, (long)buf, (long)size));
  return r < 0 ? (char *)0 : buf;
}

int fcntl(int fd, int cmd, ...) {
  /* 只支持无第三参数的 cmd（F_GETFL 等）。 */
  return (int)__libc_check(__omni_syscall(SYS_fcntl, fd, cmd));
}

int *__errno_location(void) {
  return &__libc_errno_val;
}

/* 公用那份 malloc 跟系统要地方走这一条（约定见 `libc.h`）。
 * Linux 这边是 `brk`：一路往上推，所以要来的地方其实**是**连着的 —— 但公用那一份
 * 不许依赖这一点（macOS 那边没有 brk，是一块块 `mmap` 来的）。 */
unsigned long __libc_chunk(unsigned long least, unsigned long *got) {
  static unsigned long top;
  if (top == 0) {
    long cur = __omni_syscall(SYS_brk, 0);
    if (cur <= 0) return 0;
    top = (unsigned long)cur;
  }
  unsigned long want = (least + 15) & ~15UL;
  unsigned long ne = top + want;
  long r = __omni_syscall(SYS_brk, (long)ne);
  if ((unsigned long)r < ne) return 0;
  unsigned long base = top;
  top = (unsigned long)r;
  *got = top - base;
  return base;
}

/* 收场（`exit_group` 才是「整个进程退」，`exit` 只退当前线程）。公用的 stdio.c 里
 * 那个 `exit` 跑完 atexit 之后调这一条 —— 号是这台目标的，所以住在这儿。 */
void _exit(int code) {
  __omni_syscall(SYS_exit_group, code);
  for (;;) __omni_syscall(SYS_exit, code);
}
