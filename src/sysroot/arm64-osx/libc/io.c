/* io.c — arm64 macOS 的文件 IO 与「跟系统要地方」（第一百四十片第五格）。
 *
 * 与 Linux 那一份逐个对应（函数名、签名、错误约定都一样），差别只有四处，都是
 * Darwin 自己的：
 *   - `open` 是**真的 open**（Linux 那边我们走 `openat(AT_FDCWD, …)`）
 *   - `stat` 落到 `stat64`（338）：Darwin 的 `struct stat` 早年换过一次布局，
 *     64 位那一版才是现在 SDK 头里那个（`include/sys/stat.h` 量过：144 字节）
 *   - **没有 brk**：`__libc_chunk` 走 `mmap`，于是要来的地方是一块块散的 ——
 *     公用那份 malloc 早就不假设连着了（见它的文件头）
 *   - `pipe` 把两个 fd 回在**寄存器**上（x0/x1），不写用户给的数组 —— 所以它走
 *     `__omni_syscall2`（Linux 那边 `pipe(fd)` 内核自己写内存）
 */
#include "libc.h"

int __libc_errno_val;

/* 三条标准流的 **Darwin 名字**（第一百四十片第八格）。SDK 的 `<stdio.h>` 是
 * `extern FILE *__stdoutp;` 加 `#define stdout __stdoutp`，所以用户程序引的是
 * `__stdoutp`（Mach-O 里再加一条下划线，量到的原话：`macho: 符号 '___stderrp'
 * 没有定义`）。FILE 那三个**对象**在公用的 `stdio.c` 里，这儿只是三个指针指过去 ——
 * 不新开一份，否则 `printf` 与用户的 `fprintf(stderr, …)` 会各攒一半。 */
extern FILE __libc_stdin_f;
extern FILE __libc_stdout_f;
extern FILE __libc_stderr_f;
FILE *__stdinp  = &__libc_stdin_f;
FILE *__stdoutp = &__libc_stdout_f;
FILE *__stderrp = &__libc_stderr_f;

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
  /* Darwin 的 `pipe` 把两个 fd 回在 x0/x1 上（**不写内存** —— 与 Linux 的
   * `pipe2(fd, 0)` 不是同一件事）。第二个用 `__omni_syscall2` 接：池的第一格是
   * 「x1 写到哪儿」的地址，理由与 `fork` 同一条（见 misc.c 那一段）。 */
  long second = 0;
  long r = __libc_check(__omni_syscall2(SYS_pipe, (long)&second));
  if (r < 0) return -1;
  fd[0] = (int)r;
  fd[1] = (int)second;
  return 0;
}

int isatty(int fd) {
  /* `ioctl(fd, TIOCGETA, &t)`：成功说明是终端。TIOCGETA = 0x40487413（Darwin）。 */
  char t[72];
  long r = __omni_syscall(SYS_ioctl, fd, 0x40487413, (long)t);
  return r == 0 ? 1 : 0;
}

char *getcwd(char *buf, unsigned long size) {
  /* **326 号（`__getcwd`）在 arm64 macOS 上不是一个有效的调用号** —— 量到的是 SIGSYS
   * （`Bad system call: 12`），而且**连 Apple 自己的 `syscall(326, …)` 也一样崩**，
   * 所以不是我们摆错了寄存器：那个号在这台机器上就不通。上一版按 Linux 的形状照抄了
   * 一个「有 getcwd 这个 syscall」的假设，整份编译器一起来就死在这一格。
   *
   * 换成 libSystem 那条路：打开 `.`，再问这个 fd 的路径（`fcntl(F_GETPATH)`，与
   * `realpath` 同一条）。F_GETPATH 要一块 MAXPATHLEN（1024）的地方 —— 用户给的可能更小，
   * 所以先落在本地再抄回去；装不下按 POSIX 回 ERANGE。 */
  char tmp[1024];
  int fd = open(".", 0);
  if (fd < 0) return (char *)0;
  long r = __omni_syscall(SYS_fcntl, fd, 50 /* F_GETPATH */, (long)tmp);
  close(fd);
  if (r < 0) {
    __libc_errno_val = (int)-r;
    return (char *)0;
  }
  unsigned long n = strlen(tmp);
  if (n + 1 > size) {
    __libc_errno_val = 34;            /* ERANGE（Darwin 的号） */
    return (char *)0;
  }
  memcpy(buf, tmp, n + 1);
  return buf;
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
