/* Date 里**只算数**的那两格：Date.UTC 与 Date.parse（ADR-0020 P1-c）。
 *
 * `new Date(…)` 那一格造的是**真对象**（prelude 里是 $JSObj + dateP 原型 + $ms 槽），
 * 真对象在这条腿上还不存在，所以 js_date_new / js_date_parts 照旧拒。而这两格交出来的
 * 是一个**毫秒数** —— 与真对象无关，所以能在这儿落地：`Date.UTC(2020, 0, 2)` 与
 * `Date.parse("2020-01-02T00:00:00Z")` 于是四条腿都成立。
 *
 * 日期算术不碰 libc 的 time/mktime：那一族要么带时区（本地时间那一族才需要，见下），
 * 要么在 32 位 time_t 上溢出。这里用 days-from-civil 的闭式解（Howard Hinnant 的算法，
 * 公元前后都对），全程 int64 + double。
 *
 * 本地时间那一族（new Date(y, mo, d) 是**本地**的）不在这儿：那要时区库，而"猜一个偏移"
 * 就是悄悄的错答案。 */

#include "omni.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>

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
  double yv = js_date_num(y, 1970.0, &bad);
  double mov = js_date_num(mo, 0.0, &bad);
  double dv = js_date_num(d, 1.0, &bad);
  double hv = js_date_num(h, 0.0, &bad);
  double miv = js_date_num(mi, 0.0, &bad);
  double sv = js_date_num(s, 0.0, &bad);
  double msv = js_date_num(ms, 0.0, &bad);
  if (bad) return omni_dyn_of_real((double)NAN);
  if (yv >= 0.0 && yv <= 99.0) yv += 1900.0;
  /* 月份先摊到年上，再走 days-from-civil（那格只收 1..12） */
  double ym = yv + floor(mov / 12.0);
  double mm = mov - floor(mov / 12.0) * 12.0;
  if (fabs(ym) > 400000.0) return omni_dyn_of_real((double)NAN);
  int64_t days = js_days_from_civil((int64_t)ym, (int64_t)mm + 1, 1);
  double t = ((double)days + (dv - 1.0)) * 86400000.0
           + hv * 3600000.0 + miv * 60000.0 + sv * 1000.0 + msv;
  return omni_dyn_of_real(js_time_clip(t));
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
  bool has_off = false, utc = false;

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
       本地时区在这条腿上没有，所以那一格也当场报，理由与 new Date(y, mo, d) 同一条。 */
    if (ok && !utc) {
      omni_errorf("backend-c: Date.parse of a local-time string ('%.*s') — "
                  "本地时区那一族现在只在 node 宿主上成立（ADR-0020 P1-c）；"
                  "请写成带 Z 或 ±HH:MM 的形式，或走 --backend js / 解释器",
                  (int)omni_s16_to_utf8(s).len, omni_s16_to_utf8(s).p);
      return omni_dyn_of_real((double)NAN);
    }
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
  return omni_dyn_of_real(js_time_clip(t));
}
