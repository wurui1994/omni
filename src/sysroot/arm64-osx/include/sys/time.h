/* `<sys/time.h>` —— arm64-osx 的那一份（交叉编译用）。
 *
 * 只有 `setitimer`/`getitimer` 那一格：采样 profiler（`omni_prof.c`）要它。
 * 布局是量出来的（Darwin）：`struct timeval` 是 `{ long tv_sec; int tv_usec; }` ——
 * `tv_usec` 在这边是 **int**（Linux 上是 long），补齐到 8 之后一格还是 16 字节，
 * 于是 `struct itimerval` 两边都是 32 字节。字段宽度不同这件事记在明处：
 * libc 里那格 `alarm` 就是按「四个 8 字节」写的（小端上覆盖 usec + 填充，见 misc.c）。 */
#ifndef _SYS_TIME_H
#define _SYS_TIME_H

#include <sys/types.h>

#define ITIMER_REAL    0
#define ITIMER_VIRTUAL 1
#define ITIMER_PROF    2

struct timeval {
  long tv_sec;
  int tv_usec;
};

struct itimerval {
  struct timeval it_interval;
  struct timeval it_value;
};

int setitimer(int which, const struct itimerval *new_value, struct itimerval *old_value);
int getitimer(int which, struct itimerval *cur);
int gettimeofday(struct timeval *tv, void *tz);

#endif
