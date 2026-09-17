/* offsets.c —— 造 sysroot 用的量尺。
 *
 * 在**目标机器**上编一趟跑一次，把我们的运行时用到的那些结构体的字节数与字段偏移量出来：
 *
 *   gcc -o /tmp/offsets src/sysroot/offsets.c && /tmp/offsets      （Linux）
 *   cc  -o /tmp/offsets src/sysroot/offsets.c && /tmp/offsets      （macOS）
 *
 * 然后照量到的数写 `src/sysroot/<arch>-<os>/include/` 里那几份头 —— 不照文档抄，
 * 因为 `struct stat` 这一族的布局是**这台机器的头自己定的**（glibc 的 x86_64 那一份
 * 把 nlink 放在 mode 前面，macOS 又是另一套）。
 */
#include <stdio.h>
#include <stddef.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <signal.h>
#include <setjmp.h>
#include <pthread.h>
#include <dirent.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <limits.h>
#include <dlfcn.h>

int main(void) {
  printf("sizeof(struct stat)=%zu\n", sizeof(struct stat));
  printf("st_dev=%zu\n", offsetof(struct stat, st_dev));
  printf("st_ino=%zu\n", offsetof(struct stat, st_ino));
  printf("st_mode=%zu\n", offsetof(struct stat, st_mode));
  printf("st_nlink=%zu\n", offsetof(struct stat, st_nlink));
  printf("st_size=%zu\n", offsetof(struct stat, st_size));
#ifdef __APPLE__
  printf("st_mtimespec=%zu\n", offsetof(struct stat, st_mtimespec));
#else
  printf("st_mtim=%zu\n", offsetof(struct stat, st_mtim));
#endif
  printf("sizeof(struct timespec)=%zu\n", sizeof(struct timespec));
  printf("sizeof(struct tm)=%zu\n", sizeof(struct tm));
  printf("sizeof(jmp_buf)=%zu\n", sizeof(jmp_buf));
  printf("sizeof(sigset_t)=%zu\n", sizeof(sigset_t));
  printf("sizeof(struct sigaction)=%zu\n", sizeof(struct sigaction));
  printf("sa_handler=%zu\n", offsetof(struct sigaction, sa_handler));
  printf("sa_mask=%zu\n", offsetof(struct sigaction, sa_mask));
  printf("sa_flags=%zu\n", offsetof(struct sigaction, sa_flags));
  printf("sizeof(pthread_attr_t)=%zu\n", sizeof(pthread_attr_t));
  printf("sizeof(pthread_t)=%zu\n", sizeof(pthread_t));
  printf("sizeof(struct dirent)=%zu\n", sizeof(struct dirent));
  printf("d_ino=%zu\n", offsetof(struct dirent, d_ino));
  printf("d_reclen=%zu\n", offsetof(struct dirent, d_reclen));
  printf("d_type=%zu\n", offsetof(struct dirent, d_type));
  printf("d_name=%zu\n", offsetof(struct dirent, d_name));
  printf("sizeof(struct rusage)=%zu\n", sizeof(struct rusage));
  printf("ru_maxrss=%zu\n", offsetof(struct rusage, ru_maxrss));
  printf("sizeof(struct timeval)=%zu\n", sizeof(struct timeval));
  printf("sizeof(struct rlimit)=%zu\n", sizeof(struct rlimit));
  printf("SIGALRM=%d SIGKILL=%d\n", SIGALRM, SIGKILL);
  printf("O_RDONLY=%d O_WRONLY=%d O_CREAT=%d O_TRUNC=%d\n",
         O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC);
  printf("RTLD_NOW=%d RTLD_LOCAL=%d RTLD_GLOBAL=%d\n", RTLD_NOW, RTLD_LOCAL, RTLD_GLOBAL);
  printf("RLIMIT_STACK=%d RUSAGE_SELF=%d\n", RLIMIT_STACK, RUSAGE_SELF);
  printf("CLOCKS_PER_SEC=%ld\n", (long)CLOCKS_PER_SEC);
  printf("CLOCK_REALTIME=%d CLOCK_MONOTONIC=%d\n", CLOCK_REALTIME, CLOCK_MONOTONIC);
  printf("PATH_MAX=%d\n", PATH_MAX);
  printf("sizeof(long)=%zu sizeof(void*)=%zu sizeof(long double)=%zu\n",
         sizeof(long), sizeof(void *), sizeof(long double));
  return 0;
}
