/* io.c — arm64 macOS 的文件 IO 与「跟系统要地方」（第一百四十片第五格）。
 *
 * 与 Linux 那一份逐个对应（函数名、签名、错误约定都一样），差别只有三处，都是
 * Darwin 自己的：
 *   - `open` 是**真的 open**（Linux 那边我们走 `openat(AT_FDCWD, …)`）
 *   - `stat` 落到 `stat64`（338）：Darwin 的 `struct stat` 早年换过一次布局，
 *     64 位那一版才是现在 SDK 头里那个（`include/sys/stat.h` 量过：144 字节）
 *   - **没有 brk**：`__libc_chunk` 走 `mmap`，于是要来的地方是一块块散的 ——
 *     公用那份 malloc 早就不假设连着了（见它的文件头）
 */
#include "libc.h"

int __libc_errno_val;

long write(int fd, const void *buf, unsigned long n) {
  return __libc_check(__omni_syscall(SYS_write, fd, (long)buf, (long)n));
}

long read(int fd, void *buf, unsigned long n) {
  return __libc_check(__omni_syscall(SYS_read, fd, (long)buf, (long)n));
}

int open(const char *path, int flags, ...) {
  return (int)__libc_check(__omni_syscall(SYS_open, (long)path, (long)flags, 0644));
}

int close(int fd) {
  return (int)__libc_check(__omni_syscall(SYS_close, fd));
}

int stat(const char *path, void *buf) {
  return (int)__libc_check(__omni_syscall(SYS_stat64, (long)path, (long)buf));
}

int fstat(int fd, void *buf) {
  return (int)__libc_check(__omni_syscall(SYS_fstat64, fd, (long)buf));
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
  /* Darwin 的 `pipe` 把两个 fd 回在 x0/x1 上（不写内存）。x1 这一层拿不到 ——
   * 所以这一格明着不给：拿不到第二个 fd 的 `pipe` 比没有更坏。 */
  (void)fd;
  __libc_errno_val = 78;            /* ENOSYS（Darwin 的号） */
  return -1;
}

int isatty(int fd) {
  /* `ioctl(fd, TIOCGETA, &t)`：成功说明是终端。TIOCGETA = 0x40487413（Darwin）。 */
  char t[72];
  long r = __omni_syscall(SYS_ioctl, fd, 0x40487413, (long)t);
  return r == 0 ? 1 : 0;
}

char *getcwd(char *buf, unsigned long size) {
  long r = __libc_check(__omni_syscall(SYS_getcwd, (long)buf, (long)size));
  return r < 0 ? (char *)0 : buf;
}

int fcntl(int fd, int cmd, ...) {
  return (int)__libc_check(__omni_syscall(SYS_fcntl, fd, cmd));
}

long readlink(const char *path, char *buf, unsigned long n) {
  return __libc_check(__omni_syscall(SYS_readlink, (long)path, (long)buf, (long)n));
}

/* Darwin 的 `exit`（1）本来就是退**整个进程** —— 内核没有 Linux 那种
 * 「exit 只退当前线程、exit_group 才退进程」的分家，所以这儿只有一条。 */
void _exit(int code) {
  for (;;) __omni_syscall(SYS_exit, code);
}

int *__error(void) {                /* Darwin 的名字（glibc 那边叫 __errno_location） */
  return &__libc_errno_val;
}
int *__errno_location(void) { return &__libc_errno_val; }

/* 公用那份 malloc 跟系统要地方走这一条（约定见 `libc.h`）。
 * Darwin 没有 brk，只能 `mmap`：PROT_READ|PROT_WRITE = 3，
 * MAP_PRIVATE|MAP_ANON = 0x0002 | 0x1000 = 0x1002，fd = -1。
 * 于是**两次要来的地方不连着** —— 公用那一份不许有那个假设。 */
unsigned long __libc_chunk(unsigned long least, unsigned long *got) {
  unsigned long want = (least + 16383) & ~16383UL;   /* arm64 macOS 的页是 16K */
  long r = __omni_syscall(SYS_mmap, 0, (long)want, 3, 0x1002, -1, 0);
  if (r < 0 && r >= -4095) return 0;
  *got = want;
  return (unsigned long)r;
}
