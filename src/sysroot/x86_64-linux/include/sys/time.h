/* `<sys/time.h>` —— x86_64-linux 的那一份（交叉编译用）。
 *
 * 只有 `setitimer`/`getitimer` 那一格：采样 profiler（`omni_prof.c`）要它。
 * 布局是量出来的（glibc，x86_64）：`struct timeval` 两个 `long`（16 字节），
 * `struct itimerval` 两个 timeval（32 字节）。**与 Darwin 那一份不同** ——
 * 那边 `tv_usec` 是 `int`（见 arm64-osx 那一份的注释）。 */
#ifndef _SYS_TIME_H
#define _SYS_TIME_H

#include <sys/types.h>

#define ITIMER_REAL    0
#define ITIMER_VIRTUAL 1
#define ITIMER_PROF    2

struct timeval {
  long tv_sec;
  long tv_usec;
};

struct itimerval {
  struct timeval it_interval;
  struct timeval it_value;
};

int setitimer(int which, const struct itimerval *new_value, struct itimerval *old_value);
int getitimer(int which, struct itimerval *cur);
int gettimeofday(struct timeval *tv, void *tz);

#endif
