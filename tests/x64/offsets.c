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
int main(){
  printf("sizeof(struct stat)=%zu\n", sizeof(struct stat));
  printf("st_dev=%zu\n", offsetof(struct stat, st_dev));
  printf("st_ino=%zu\n", offsetof(struct stat, st_ino));
  printf("st_mode=%zu\n", offsetof(struct stat, st_mode));
  printf("st_nlink=%zu\n", offsetof(struct stat, st_nlink));
  printf("st_size=%zu\n", offsetof(struct stat, st_size));
  printf("st_mtim=%zu\n", offsetof(struct stat, st_mtim));
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
  printf("d_off=%zu\n", offsetof(struct dirent, d_off));
  printf("d_reclen=%zu\n", offsetof(struct dirent, d_reclen));
  printf("d_type=%zu\n", offsetof(struct dirent, d_type));
  printf("d_name=%zu\n", offsetof(struct dirent, d_name));
  printf("sizeof(struct rusage)=%zu\n", sizeof(struct rusage));
  printf("ru_maxrss=%zu\n", offsetof(struct rusage, ru_maxrss));
  printf("SIGALRM=%d\n", SIGALRM);
  printf("SIGKILL=%d\n", SIGKILL);
  printf("O_RDONLY=%d\n", O_RDONLY);
  printf("RLIM_INFINITY=%lu\n", (unsigned long)RLIM_INFINITY);
  printf("CLOCK_MONOTONIC=%d\n", CLOCK_MONOTONIC);
  printf("PATH_MAX=%d\n", PATH_MAX);
  return 0;
}
