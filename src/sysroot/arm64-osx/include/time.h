/* `<time.h>` —— arm64-osx 的那一份（交叉编译用）。
 * sizeof(struct tm)=56（与 glibc 一样），CLOCKS_PER_SEC=1000000，
 * CLOCK_MONOTONIC=**6**（Linux 上是 1）。 */
#ifndef _TIME_H
#define _TIME_H

#include <sys/types.h>

#define CLOCKS_PER_SEC 1000000L

#define CLOCK_REALTIME 0
#define CLOCK_MONOTONIC 6

struct timespec {
  time_t tv_sec;
  long tv_nsec;
};

struct tm {
  int tm_sec;
  int tm_min;
  int tm_hour;
  int tm_mday;
  int tm_mon;
  int tm_year;
  int tm_wday;
  int tm_yday;
  int tm_isdst;
  long tm_gmtoff;
  char *tm_zone;
};

time_t time(time_t *t);
clock_t clock(void);
int clock_gettime(int clk_id, struct timespec *tp);
struct tm *localtime_r(const time_t *t, struct tm *result);
size_t strftime(char *s, size_t max, const char *fmt, const struct tm *tm);

#endif
