/* `<sys/resource.h>` —— x86_64-linux 的那一份（交叉编译用）。
 *
 * struct rusage：量到 sizeof=144，ru_maxrss 在偏移 32。
 * struct rlimit：只有两个 `unsigned long` 成员。
 * 注意 Linux 上 `ru_maxrss` 的单位是 **KB**（macOS 上是字节）—— 运行时那侧已经
 * 有 `#ifdef __APPLE__` 来调单位，这一格由运行时 `.c` 里那行 `#ifdef` 管。 */
#ifndef _SYS_RESOURCE_H
#define _SYS_RESOURCE_H

#include <sys/types.h>
#include <time.h>

#define RUSAGE_SELF 0

struct timeval {
  time_t tv_sec;
  suseconds_t tv_usec;
};

struct rusage {
  struct timeval ru_utime;    /* 0 */
  struct timeval ru_stime;    /* 16 */
  long int ru_maxrss;         /* 32 */
  long int __pad[13];         /* rest to 144 */
};

typedef unsigned long int rlim_t;
#define RLIM_INFINITY ((rlim_t)-1)
#define RLIMIT_STACK 3

struct rlimit {
  rlim_t rlim_cur;
  rlim_t rlim_max;
};

int getrusage(int who, struct rusage *usage);
int getrlimit(int resource, struct rlimit *rlim);

#endif
