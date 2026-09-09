/* Date 那一族的算术（ADR-0020 P1-c / P4）：Date.UTC、Date.parse、七格实参那格构造，
 * 以及真对象上那三十几格取值面共用的两个原语（取一格字段 / 七格字段合成毫秒）。
 *
 * 真对象自己（$JSObj + dateP 原型 + $ms 槽）在 omni_js_obj.h 那一段里造，因为造对象要
 * 那个翻译单元里的 list / dict 类型。这儿只算数，交出来的都是 double 或一格串。
 *
 * 日期算术不碰 mktime：那一族在 32 位 time_t 上溢出，而且闰秒/DST 消歧的口径是实现定义的。
 * 这里用 days-from-civil 的闭式解（Howard Hinnant 的算法，公元前后都对），全程 int64 + double。
 *
 * 本地时区**只**从 localtime_r 拿 —— 那是这台机器上 node / qjs 自己也在用的那份 tz 数据，
 * 所以三把尺子在同一台机器上必然一致；"猜一个偏移"才是悄悄的错答案。反向（本地民用时间
 * → UTC 毫秒）走两趟：先按"当成 UTC"的那格时间问一次偏移、减掉，再在得到的 UTC 上问一次
 * 偏移、重新减 —— 这是不用 mktime 也能跨 DST 边界收敛的那个老办法。 */

#include "omni.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

/* 1970-01-01 之前的天数（负数也对）。规范 21.4.1.12 的 MakeDay 就是这一格。 */
static int64_t js_days_from_civil(int64_t y, int64_t m, int64_t d) {
  y -= m <= 2 ? 1 : 0;
  int64_t era = (y >= 0 ? y : y - 399) / 400;
  int64_t yoe = y - era * 400;                                  /* [0, 399] */
  int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;  /* [0, 365] */
  int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;           /* [0, 146096] */
  return era * 146097 + doe - 719468;
}

/* 规范 21.4.1.31 的 TimeClip：|t| > 8.64e15 或非有限一律 NaN，别的取整。 */
static double js_time_clip(double t) {
  if (!isfinite(t) || fabs(t) > 8.64e15) return (double)NAN;
  return trunc(t) + 0.0;
}

/* days_from_civil 的逆（同一篇里的 civil_from_days）：把 1970-01-01 起的天数摊回年月日。
   月份交出来是 1..12。 */
static void js_civil_from_days(int64_t z, int64_t *yy, int64_t *mm, int64_t *dd) {
  z += 719468;
  int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  int64_t doe = z - era * 146097;                                     /* [0, 146096] */
  int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; /* [0, 399] */
  int64_t y = yoe + era * 400;
  int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);               /* [0, 365] */
  int64_t mp = (5 * doy + 2) / 153;                                   /* [0, 11] */
  int64_t d = doy - (153 * mp + 2) / 5 + 1;                           /* [1, 31] */
  int64_t m = mp + (mp < 10 ? 3 : -9);                                /* [1, 12] */
  *yy = y + (m <= 2 ? 1 : 0);
  *mm = m;
  *dd = d;
}

/* 一格 UTC 毫秒上**当时**的本地偏移（毫秒，本地 - UTC）。只问 localtime_r —— 这台机器上
   node 与 qjs 用的是同一份 tz 数据，所以三条腿必然说同一句话。问不出来（时间出了 libc
   的量程）就交 false，调用方当场报，不拿 0 顶上。 */
static bool js_local_off(double t, double *out) {
  if (!isfinite(t)) return false;
  double secs = floor(t / 1000.0);
  if (fabs(secs) > 9.0e15) return false;
  time_t tt = (time_t)secs;
  struct tm lt;
  if (localtime_r(&tt, &lt) == NULL) return false;
  /* 把那格本地民用时间**当成 UTC** 再算一遍毫秒，差就是偏移 */
  int64_t days = js_days_from_civil((int64_t)lt.tm_year + 1900,
                                    (int64_t)lt.tm_mon + 1, (int64_t)lt.tm_mday);
  double as_utc = (double)days * 86400000.0 + (double)lt.tm_hour * 3600000.0
                + (double)lt.tm_min * 60000.0 + (double)lt.tm_sec * 1000.0;
  *out = as_utc - secs * 1000.0;
  return true;
}

/* 本地民用时间的毫秒（"当成 UTC 算出来的那个数"）→ 真正的 UTC 毫秒。两趟：先按自己问一次
   偏移，减掉；再在得到的 UTC 上问一次，重新减。跨 DST 边界的那两天靠第二趟收敛。 */
static bool js_utc_from_local(double lms, double *out) {
  double off;
  if (!js_local_off(lms, &off)) return false;
  double t = lms - off;
  if (!js_local_off(t, &off)) return false;
  *out = lms - off;
  return true;
}

static void js_tz_err(void) {
  omni_errorf("backend-c: 这个时间点上问不出本地时区偏移（libc 的 localtime_r 拒了）；"
              "这一格只能走 --backend js 或解释器（ADR-0020 P4）");
}

/* 一格字段（规范 21.4.1 那批 YearFromTime / MonthFromTime …）。
   字段号：0 年 1 月（0 起） 2 日 3 时 4 分 5 秒 6 毫秒 7 星期（0 = 周日）。 */
double omni_js_date_field_d(double t, int which, bool utc) {
  if (!isfinite(t)) return (double)NAN;
  double lt = t;
  if (!utc) {
    double off;
    if (!js_local_off(t, &off)) { js_tz_err(); return (double)NAN; }
    lt = t + off;
  }
  int64_t days = (int64_t)floor(lt / 86400000.0);
  int64_t tod = (int64_t)lt - days * 86400000;
  switch (which) {
    case 3: return (double)(tod / 3600000);
    case 4: return (double)((tod / 60000) % 60);
    case 5: return (double)((tod / 1000) % 60);
    case 6: return (double)(tod % 1000);
    case 7: {
      int64_t wd = (days + 4) % 7;                /* 1970-01-01 是周四 */
      return (double)(wd < 0 ? wd + 7 : wd);
    }
    default: {
      int64_t y, m, d;
      js_civil_from_days(days, &y, &m, &d);
      return which == 0 ? (double)y : which == 1 ? (double)(m - 1) : (double)d;
    }
  }
}

/* getTimezoneOffset()：**分钟**，而且符号与偏移相反（UTC - 本地）。 */
double omni_js_date_tzoff_d(double t) {
  double off;
  if (!isfinite(t)) return (double)NAN;
  if (!js_local_off(t, &off)) { js_tz_err(); return (double)NAN; }
  return -off / 60000.0;
}

/* 七格字段（年, 月 0 起, 日, 时, 分, 秒, 毫秒）→ 毫秒。月份溢出照规范摊到年上
   （mo = 12 就是下一年的一月），日/时/分/秒同理靠纯加法自己摊。 */
double omni_js_date_make_d(const double *f, bool utc) {
  int i;
  for (i = 0; i < 7; i++) if (!isfinite(f[i])) return (double)NAN;
  double ym = f[0] + floor(f[1] / 12.0);
  double mm = f[1] - floor(f[1] / 12.0) * 12.0;
  if (fabs(ym) > 400000.0) return (double)NAN;
  int64_t days = js_days_from_civil((int64_t)ym, (int64_t)mm + 1, 1);
  double t = ((double)days + (f[2] - 1.0)) * 86400000.0 + f[3] * 3600000.0
           + f[4] * 60000.0 + f[5] * 1000.0 + f[6];
  if (!utc) {
    double u;
    if (!isfinite(t) || fabs(t) > 9.0e15) return (double)NAN;
    if (!js_utc_from_local(t, &u)) { js_tz_err(); return (double)NAN; }
    t = u;
  }
  return js_time_clip(t);
}

/* Date 的三种**规范写死的**文本形态。kind：0 toISOString（UTC）、1 toUTCString、
   2 toDateString（本地）。toString / toTimeString 不在这儿 —— 那两格带括号里的时区**名字**，
   而三把尺子在那上面各说各话（node 给 ICU 长名、qjs 什么都不给、C 的 %Z 给缩写），
   所以它们在这条腿上当场报，见 omni_js_obj.h 里 date 那一段。 */
omni_dyn omni_js_date_fmt(double t, int kind) {
  static const char *WD[7] = { "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" };
  static const char *MO[12] = { "Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };
  char buf[64];
  if (!isfinite(t)) {
    /* toISOString 的无效日期是 RangeError（调用方先挡了），别的两格是这句话 */
    return omni_dyn_of_s16(omni_s16_of_utf8(omni_str_new("Invalid Date", 12)));
  }
  bool utc = kind != 2;
  double lt = t;
  if (!utc) {
    double off;
    if (!js_local_off(t, &off)) { js_tz_err(); return omni_dyn_undef(); }
    lt = t + off;
  }
  int64_t days = (int64_t)floor(lt / 86400000.0);
  int64_t tod = (int64_t)lt - days * 86400000;
  int64_t y, m, d;
  js_civil_from_days(days, &y, &m, &d);
  int64_t wd = (days + 4) % 7;
  if (wd < 0) wd += 7;
  int hh = (int)(tod / 3600000), mi = (int)((tod / 60000) % 60);
  int ss = (int)((tod / 1000) % 60), ms = (int)(tod % 1000);
  if (kind == 0) {
    /* 规范 21.4.1.33：0..9999 是四位，出了这个范围是 ±六位 */
    if (y >= 0 && y <= 9999) {
      snprintf(buf, sizeof buf, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
               (int)y, (int)m, (int)d, hh, mi, ss, ms);
    } else {
      snprintf(buf, sizeof buf, "%c%06d-%02d-%02dT%02d:%02d:%02d.%03dZ",
               y < 0 ? '-' : '+', (int)(y < 0 ? -y : y), (int)m, (int)d, hh, mi, ss, ms);
    }
  } else if (kind == 1) {
    /* 规范 21.4.4.43：Www, DD Mmm YYYY HH:mm:ss GMT。年份那一格是 %04d，负数在前面加号
       （量出来的：node 给 "Fri, 01 Jan -0001 00:00:00 GMT" —— 四位，不是六位） */
    snprintf(buf, sizeof buf, "%s, %02d %s %s%04d %02d:%02d:%02d GMT",
             WD[wd], (int)d, MO[m - 1], y < 0 ? "-" : "", (int)(y < 0 ? -y : y), hh, mi, ss);
  } else {
    /* 规范 21.4.4.35 的 DateString：Www Mmm DD YYYY（年份同上） */
    snprintf(buf, sizeof buf, "%s %s %02d %s%04d", WD[wd], MO[m - 1], (int)d,
             y < 0 ? "-" : "", (int)(y < 0 ? -y : y));
  }
  return omni_dyn_of_s16(omni_s16_of_utf8(omni_str_new(buf, (int64_t)strlen(buf))));
}

/* 一格实参照 ToNumber 再截断；缺席（undefined）用默认值。 */
static double js_date_num(omni_dyn v, double dflt, bool *bad) {
  if (v.tag == OMNI_DYN_UNDEF) return dflt;
  omni_dyn n = omni_js_num_of(v);
  double x = n.tag == OMNI_DYN_INT ? (double)n.u.i
           : n.tag == OMNI_DYN_UINT ? (double)omni_dyn_u64(n)
           : n.tag == OMNI_DYN_REAL ? n.u.r : (double)NAN;
  if (!isfinite(x)) { *bad = true; return 0.0; }
  return trunc(x);
}

/* Date.UTC(y[, mo, d, h, mi, s, ms])（规范 21.4.3.4）。年缺席是 NaN；0..99 映到
   1900+y（MakeFullYear）；月份溢出照规范摊到年上（mo = 12 就是下一年的一月）。 */
omni_dyn omni_js_date_utc(omni_dyn y, omni_dyn mo, omni_dyn d, omni_dyn h,
                          omni_dyn mi, omni_dyn s, omni_dyn ms) {
  if (y.tag == OMNI_DYN_UNDEF) return omni_dyn_of_real((double)NAN);
  bool bad = false;
  double f[7];
  f[0] = js_date_num(y, 1970.0, &bad);
  f[1] = js_date_num(mo, 0.0, &bad);
  f[2] = js_date_num(d, 1.0, &bad);
  f[3] = js_date_num(h, 0.0, &bad);
  f[4] = js_date_num(mi, 0.0, &bad);
  f[5] = js_date_num(s, 0.0, &bad);
  f[6] = js_date_num(ms, 0.0, &bad);
  if (bad) return omni_dyn_of_real((double)NAN);
  if (f[0] >= 0.0 && f[0] <= 99.0) f[0] += 1900.0;
  return omni_dyn_of_real(omni_js_date_make_d(f, true));
}

/* new Date(y, mo[, d, h, mi, s, ms])：与上面同一族，只是那七格是**本地时间**
   （规范 21.4.2.1 第 3 步）。交出来的是毫秒，真对象由 omni_js_date_new 包。 */
omni_dyn omni_js_date_parts(omni_dyn y, omni_dyn mo, omni_dyn d, omni_dyn h,
                            omni_dyn mi, omni_dyn s, omni_dyn ms) {
  bool bad = false;
  double f[7];
  f[0] = js_date_num(y, 1970.0, &bad);
  f[1] = js_date_num(mo, 0.0, &bad);
  f[2] = js_date_num(d, 1.0, &bad);
  f[3] = js_date_num(h, 0.0, &bad);
  f[4] = js_date_num(mi, 0.0, &bad);
  f[5] = js_date_num(s, 0.0, &bad);
  f[6] = js_date_num(ms, 0.0, &bad);
  if (bad) return omni_dyn_of_real((double)NAN);
  if (f[0] >= 0.0 && f[0] <= 99.0) f[0] += 1900.0;
  return omni_dyn_of_real(omni_js_date_make_d(f, false));
}


/* --- Date.parse ---------------------------------------------------------- */

typedef struct { const uint16_t *p; int64_t n; int64_t i; } js_dp;

static bool dp_digits(js_dp *z, int count, int64_t *out) {
  int64_t v = 0;
  for (int k = 0; k < count; k++) {
    if (z->i >= z->n) return false;
    uint16_t c = z->p[z->i];
    if (c < '0' || c > '9') return false;
    v = v * 10 + (int64_t)(c - '0');
    z->i++;
  }
  *out = v;
  return true;
}

static bool dp_ch(js_dp *z, uint16_t c) {
  if (z->i < z->n && z->p[z->i] == c) { z->i++; return true; }
  return false;
}

/* Date.parse（规范 21.4.3.2）：**只认规范里那个 Date Time String Format**
   （YYYY[-MM[-DD]][THH:mm[:ss[.sss]][Z|±HH:mm]]）。
   JS 那条腿借的是宿主的 Date.parse，它还认一大堆别的写法（RFC 2822、"Jan 1 2020"…）
   而 node 与 qjs 在那些写法上**互相都不一致**。所以这条腿：认得的照算，认不得的**当场报**，
   不给 NaN —— NaN 会让两条腿静静地分叉（一边算出数、一边算出 NaN）。 */
omni_dyn omni_js_date_parse(omni_dyn sd) {
  omni_s16 s = omni_js_as_s16(omni_js_str(sd));
  js_dp z = { s.p, s.len, 0 };
  int64_t year = 0, mon = 1, day = 1, hh = 0, mm = 0, ss = 0, ms = 0;
  bool neg_year = false, ok = true;
  int64_t off = 0;
  bool has_off = false, utc = false, has_time = false;

  if (dp_ch(&z, (uint16_t)'+') || (neg_year = dp_ch(&z, (uint16_t)'-'))) {
    ok = dp_digits(&z, 6, &year);           /* 扩展年（±YYYYYY） */
  } else {
    ok = dp_digits(&z, 4, &year);
  }
  if (ok && dp_ch(&z, (uint16_t)'-')) {
    ok = dp_digits(&z, 2, &mon);
    if (ok && dp_ch(&z, (uint16_t)'-')) ok = dp_digits(&z, 2, &day);
  }
  if (ok && dp_ch(&z, (uint16_t)'T')) {
    has_time = true;
    ok = dp_digits(&z, 2, &hh) && dp_ch(&z, (uint16_t)':') && dp_digits(&z, 2, &mm);
    if (ok && dp_ch(&z, (uint16_t)':')) ok = dp_digits(&z, 2, &ss);
    if (ok && dp_ch(&z, (uint16_t)'.')) ok = dp_digits(&z, 3, &ms);
    if (ok && dp_ch(&z, (uint16_t)'Z')) {
      utc = true;
    } else if (ok && (z.i < z.n && (z.p[z.i] == '+' || z.p[z.i] == '-'))) {
      bool minus = z.p[z.i] == '-';
      z.i++;
      int64_t oh = 0, om = 0;
      ok = dp_digits(&z, 2, &oh) && dp_ch(&z, (uint16_t)':') && dp_digits(&z, 2, &om);
      off = (minus ? -1 : 1) * (oh * 60 + om);
      has_off = true;
      utc = true;
    }
    /* 只有日期、没有时间的那一格按 UTC（规范如此）；带了时间又没写时区的按**本地** ——
       本地偏移现在从 localtime_r 拿得到了（见 js_utc_from_local），所以这一格也落地了。 */
  }
  if (!ok || z.i != z.n || mon < 1 || mon > 12 || day < 1 || day > 31
      || hh > 24 || mm > 59 || ss > 59) {
    omni_errorf("backend-c: Date.parse only understands the ISO format here "
                "（ADR-0020 P1-c：宿主那条腿还认 RFC 2822 那一族，而两把尺子在那上面"
                "互相就不一致）；这份程序请走 --backend js 或解释器");
    return omni_dyn_of_real((double)NAN);
  }
  if (neg_year) year = -year;
  int64_t days = js_days_from_civil(year, mon, day);
  double t = (double)days * 86400000.0 + (double)hh * 3600000.0
           + (double)mm * 60000.0 + (double)ss * 1000.0 + (double)ms;
  if (has_off) t -= (double)off * 60000.0;
  else if (has_time && !utc) {
    /* "带了时间、没写时区"就是**本地**（规范 21.4.3.2 → 只有日期的那格才默认 UTC） */
    double u;
    if (!js_utc_from_local(t, &u)) { js_tz_err(); return omni_dyn_of_real((double)NAN); }
    t = u;
  }
  return omni_dyn_of_real(js_time_clip(t));
}
