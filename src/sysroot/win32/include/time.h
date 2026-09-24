/* `<time.h>` —— win32 的那一份（两个 arch 共用）（交叉编译用；形状沿用 Linux 那一套，见 ../README.md）。
 *
 * struct timespec：量到 sizeof=16。struct tm：量到 sizeof=56（glibc 末尾还有
 * `tm_gmtoff` 与 `tm_zone` 两格 POSIX 扩展）。
 * `CLOCKS_PER_SEC` 在 glibc 上是 1000000（POSIX 的值）。 */
#ifndef _TIME_H
#define _TIME_H

#include <sys/types.h>

#define CLOCKS_PER_SEC 1000000L

#define CLOCK_REALTIME 0
#define CLOCK_MONOTONIC 1

struct timespec {
  time_t tv_sec;
  long int tv_nsec;
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
  long int tm_gmtoff;
  const char *tm_zone;
};

time_t time(time_t *t);
clock_t clock(void);
int clock_gettime(int clk_id, struct timespec *tp);
struct tm *localtime_r(const time_t *t, struct tm *result);
/* `gmtime_r` / `gmtime` 也得露出来：少了这两条，`omni_fmt.c` 里那一句是**隐式声明**，
 * 回来的指针按 `int` 收 —— LLP64 上高 32 位没了（量到过
 * `implicit declaration of function 'gmtime_r'`）。 */
struct tm *gmtime_r(const time_t *t, struct tm *result);
struct tm *gmtime(const time_t *t);
size_t strftime(char *s, size_t max, const char *fmt, const struct tm *tm);

#endif
