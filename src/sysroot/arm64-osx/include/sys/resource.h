/* `<sys/resource.h>` —— arm64-osx 的那一份（交叉编译用）。
 * sizeof(struct rusage)=144，ru_maxrss=32（与 Linux 数值一样，但**单位不同**：
 * macOS 上是字节，Linux 上是 KB，运行时那侧用 `#ifdef __APPLE__` 调）。 */
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
  struct timeval ru_utime;   /* 0 */
  struct timeval ru_stime;   /* 16 */
  long ru_maxrss;            /* 32 */
  long __pad[13];            /* rest to 144 */
};

typedef unsigned long rlim_t;
#define RLIM_INFINITY ((rlim_t)-1)
#define RLIMIT_STACK 3

struct rlimit {
  rlim_t rlim_cur;
  rlim_t rlim_max;
};

int getrusage(int who, struct rusage *usage);
int getrlimit(int resource, struct rlimit *rlim);

#endif
