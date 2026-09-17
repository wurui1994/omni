/* 日历那一格的探子：`gmtime_r` 与 `strftime`，与平台 libc 逐行对账。
 *
 * 为什么单开一格：秒数掰成年月日全是**纯计算**（我们走 civil_from_days 那条封闭公式），
 * 一个 syscall 都不问，所以两边该一字不差；而这种算错了不会崩 —— 只会在某个闰年、某个
 * 世纪、某个负秒数上悄悄差一天。判据摆在「与平台 libc 比字符串」这一层。
 *
 * 三条不比（都是**说明白的**差别，不是错）：
 *   - `localtime_r`：我们没有时区库，本地时间就是 UTC；尺子跟着机器的 TZ 走。
 *   - `%Z`：我们印 "UTC"，Darwin 的 gmtime 那份印 "GMT"。
 *   - cap 不够时 `strftime` 的缓冲内容：C11 说 indeterminate，不判未规定的东西。
 *   - 认不出的转换（比如 `%Q`）：Darwin 吞掉那个 `%`、glibc 留着 —— 两台尺子自己就不一样，
 *     这种地方不设判据（我们跟 glibc 一边：原样留着，不猜）。
 *
 * 时刻挑的是边：epoch、负数、闰日、平世纪（2100-03-01）、int32 的两侧、9999 年。
 */
#include <stdio.h>
#include <time.h>

static const long long TS[] = {
  0LL,                /* 1970-01-01 00:00:00 星期四 */
  1LL,
  -1LL,               /* 负秒数：往回退一天 */
  -86400LL,
  -2208988800LL,      /* 1900-01-01：不是闰年的那个世纪 */
  68169600LL,         /* 1972-02-29：闰日 */
  951782400LL,        /* 2000-02-29：能被 400 整的世纪，是闰年 */
  1583020800LL,       /* 2020-03-01 */
  4107542400LL,       /* 2100-03-01：能被 100 整、不能被 400 整，不是闰年 */
  1234567890LL,
  1000000000LL,
  2147483647LL,       /* int32 的顶 */
  2147483648LL,
  253402300799LL      /* 9999-12-31 23:59:59 */
};
#define NTS ((int)(sizeof(TS) / sizeof(TS[0])))

static const char *FMT[] = {
  "%F %T", "%Y-%m-%d", "%y/%m/%d", "%H:%M:%S", "%j", "%Y%m%d%H%M%S", "%d%%%m"
};
#define NFMT ((int)(sizeof(FMT) / sizeof(FMT[0])))

int main(void) {
  char buf[128];
  for (int i = 0; i < NTS; i++) {
    time_t t = (time_t)TS[i];
    struct tm tm;
    gmtime_r(&t, &tm);
    printf("t=%lld y=%d mon=%d mday=%d h=%d m=%d s=%d wday=%d yday=%d dst=%d\n",
      TS[i], tm.tm_year, tm.tm_mon, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec,
      tm.tm_wday, tm.tm_yday, tm.tm_isdst);
    for (int j = 0; j < NFMT; j++) {
      unsigned long n = (unsigned long)strftime(buf, sizeof(buf), FMT[j], &tm);
      printf("  [%s] n=%lu \"%s\"\n", FMT[j], n, buf);
    }
  }
  /* 一天里每一秒都走一遍太长，改成「一年里每 3607 秒」：进位（分/时/日/月）全踩到。 */
  long long acc = 0;
  for (long long t = 0; t < 31536000LL; t += 3607LL) {
    time_t tt = (time_t)t;
    struct tm tm;
    gmtime_r(&tt, &tm);
    acc += tm.tm_year + tm.tm_mon * 31 + tm.tm_mday * 7 + tm.tm_hour * 3
         + tm.tm_min * 2 + tm.tm_sec + tm.tm_wday * 11 + tm.tm_yday * 13;
  }
  printf("1970 一年扫下来的和 = %lld\n", acc);
  return 0;
}
