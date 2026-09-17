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
