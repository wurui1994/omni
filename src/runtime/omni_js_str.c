/* JS 的 String 方法（ADR-0011 第 2 节的 ABI 里 js_str_* 那一段）
 *
 * 每一条都必须和 backend-js/prelude.js 里的同名 $js_str_* 逐位对应，判据是
 * tests/oir 里拿 node 当参照跑出来一样。
 *
 * 只放"不碰容器"的那些：split 要返回 list<dynamic>、fromCharCode 要收 list，
 * 而 list<dynamic> 是生成 TU 里的宏实例，运行时的翻译单元看不见它 ——
 * 那几个 op 只能长在宏里（见 omni_dyn_bridge.h 的做法）。
 */
#include "omni.h"

static omni_s16 want_s16(omni_dyn v) { return omni_js_as_s16(v); }

/* UTF-8 的 Omni string -> JS 域的 String。字面量每次求值转一次；等不动点成立之后
   再考虑把常量提到模块级的表里。 */
omni_dyn omni_js_s16(omni_str s) { return omni_dyn_of_s16(omni_s16_of_utf8(s)); }

/* JS 的 ToIntegerOrInfinity：下标是 Number，NaN 当 0，其余截尾。
   刻意只收 REAL：JS 里字符串下标不可能是 BigInt，收到 int 说明降级写错了。 */
static int64_t to_int_arg(omni_dyn v, int64_t dflt) {
  if (v.tag == OMNI_DYN_UNDEF) return dflt;
  if (v.tag != OMNI_DYN_REAL) {
    omni_errorf("string index must be a number, found %s", omni_dyn_tag_name(v.tag));
  }
  double d = v.u.r;
  if (isnan(d)) return 0;
  if (d >= 9.2233720368547758e18) return INT64_MAX;
  if (d <= -9.2233720368547758e18) return INT64_MIN;
  return (int64_t)d;
}

/* slice 的相对下标：负数从尾部数，再夹到 [0, len] */
static int64_t rel(int64_t i, int64_t len) {
  if (i < 0) { i += len; if (i < 0) i = 0; }
  else if (i > len) i = len;
  return i;
}

omni_dyn omni_js_str_len(omni_dyn s) { return omni_dyn_of_real((double)want_s16(s).len); }

/* s[i]：越界或非整数下标都是 undefined（JS 把它当"没有这个属性"） */
omni_dyn omni_js_str_index(omni_dyn s, omni_dyn i) {
  omni_s16 v = want_s16(s);
  int64_t k = to_int_arg(i, 0);
  if (k < 0 || k >= v.len) return omni_dyn_undef();
  return omni_dyn_of_s16(omni_s16_slice(v, k, k + 1));
}

/* .at()：负下标从尾部数，越界 undefined */
omni_dyn omni_js_str_at(omni_dyn s, omni_dyn i) {
  omni_s16 v = want_s16(s);
  int64_t k = to_int_arg(i, 0);
  if (k < 0) k += v.len;
  if (k < 0 || k >= v.len) return omni_dyn_undef();
  return omni_dyn_of_s16(omni_s16_slice(v, k, k + 1));
}

/* charAt 越界给**空串**（不是 undefined，也不是 NaN）—— 规范 22.1.3.1 就是这么写的。
   与 .at() 的区别是它不认负下标：charAt(-1) 是空串，at(-1) 是最后一个字符。 */
omni_dyn omni_js_str_char_at(omni_dyn s, omni_dyn i) {
  omni_s16 v = want_s16(s);
  int64_t k = to_int_arg(i, 0);
  if (k < 0 || k >= v.len) return omni_dyn_of_s16(omni_s16_slice(v, 0, 0));
  return omni_dyn_of_s16(omni_s16_slice(v, k, k + 1));
}

/* charCodeAt 越界给 NaN —— 不是 undefined，也不是 0，这个区别会被词法器看见 */
omni_dyn omni_js_str_char_code_at(omni_dyn s, omni_dyn i) {
  omni_s16 v = want_s16(s);
  int64_t k = to_int_arg(i, 0);
  if (k < 0 || k >= v.len) return omni_dyn_of_real((double)NAN);
  return omni_dyn_of_real((double)v.p[k]);
}

/* codePointAt 越界给 undefined，且会把代理对拼成一个码点 */
omni_dyn omni_js_str_code_point_at(omni_dyn s, omni_dyn i) {
  omni_s16 v = want_s16(s);
  int64_t k = to_int_arg(i, 0);
  if (k < 0 || k >= v.len) return omni_dyn_undef();
  uint32_t c = v.p[k];
  if (c >= 0xd800 && c <= 0xdbff && k + 1 < v.len && v.p[k + 1] >= 0xdc00 && v.p[k + 1] <= 0xdfff) {
    c = 0x10000 + ((c - 0xd800) << 10) + (v.p[k + 1] - 0xdc00);
  }
  return omni_dyn_of_real((double)c);
}

/* ---------------------------------------------------------------- 切与拼 */

omni_dyn omni_js_str_slice(omni_dyn s, omni_dyn a, omni_dyn b) {
  omni_s16 v = want_s16(s);
  int64_t start = rel(to_int_arg(a, 0), v.len);
  int64_t end = rel(to_int_arg(b, v.len), v.len);
  return omni_dyn_of_s16(omni_s16_slice(v, start, end));
}

omni_dyn omni_js_str_repeat(omni_dyn s, omni_dyn n) {
  int64_t k = to_int_arg(n, 0);
  if (k < 0) omni_error("repeat count must not be negative");
  return omni_dyn_of_s16(omni_s16_repeat(want_s16(s), k));
}

omni_dyn omni_js_str_pad_start(omni_dyn s, omni_dyn n, omni_dyn fill) {
  omni_s16 f = fill.tag == OMNI_DYN_UNDEF ? omni_s16_of_utf8(omni_str_new(" ", 1)) : want_s16(fill);
  return omni_dyn_of_s16(omni_s16_pad_start(want_s16(s), to_int_arg(n, 0), f));
}

omni_dyn omni_js_str_pad_end(omni_dyn s, omni_dyn n, omni_dyn fill) {
  omni_s16 f = fill.tag == OMNI_DYN_UNDEF ? omni_s16_of_utf8(omni_str_new(" ", 1)) : want_s16(fill);
  return omni_dyn_of_s16(omni_s16_pad_end(want_s16(s), to_int_arg(n, 0), f));
}

/* replaceAll 的字符串模式那一支：替换串里的 $& / $1 一律当普通字符（prelude 那份
   也是手写的，正是为了两边同样残缺）。空模式照 JS 在每个码元之间各插一份。 */
omni_dyn omni_js_str_replace_all(omni_dyn s, omni_dyn pat, omni_dyn rep) {
  omni_s16 v = want_s16(s), p = want_s16(pat), r = want_s16(rep);
  omni_s16_buf out = { 0, 0, 0 };
  if (p.len == 0) {
    omni_s16_buf_add(&out, r);
    for (int64_t i = 0; i < v.len; i++) {
      omni_s16_buf_add(&out, omni_s16_slice(v, i, i + 1));
      omni_s16_buf_add(&out, r);
    }
    return omni_dyn_of_s16(omni_s16_buf_done(&out));
  }
  int64_t i = 0;
  for (;;) {
    int64_t at = omni_s16_index_of(v, p, i);
    if (at < 0) break;
    omni_s16_buf_add(&out, omni_s16_slice(v, i, at));
    omni_s16_buf_add(&out, r);
    i = at + p.len;
  }
  omni_s16_buf_add(&out, omni_s16_slice(v, i, v.len));
  return omni_dyn_of_s16(omni_s16_buf_done(&out));
}

/* side: 'b' 两头 / 'l' 只裁前 / 'r' 只裁后 */
omni_dyn omni_js_str_trim(int side, omni_dyn s) {
  return omni_dyn_of_s16(omni_s16_trim(want_s16(s), side != 'r', side != 'l'));
}

omni_dyn omni_js_str_lower(omni_dyn s) { return omni_dyn_of_s16(omni_s16_lower(want_s16(s))); }
omni_dyn omni_js_str_upper(omni_dyn s) { return omni_dyn_of_s16(omni_s16_upper(want_s16(s))); }

/* ---------------------------------------------------------------- 查找 */

omni_dyn omni_js_str_index_of(omni_dyn s, omni_dyn needle, omni_dyn from) {
  int64_t i = omni_s16_index_of(want_s16(s), want_s16(needle), to_int_arg(from, 0));
  return omni_dyn_of_real((double)i);
}

/* 第二个实参是「从哪一格往前找」（含），缺省从末尾找。规范 22.1.3.11：位置先夹到
   [0, len]，匹配本身可以越过它往右伸；NaN 当 +∞（也就是整串都找）。
   cli.js 的 inpPath 就是这么一段段往前切印记的。 */
omni_dyn omni_js_str_last_index_of(omni_dyn s, omni_dyn needle, omni_dyn from) {
  omni_s16 v = want_s16(s);
  omni_s16 n = want_s16(needle);
  bool whole = from.tag == OMNI_DYN_UNDEF
    || (from.tag == OMNI_DYN_REAL && !(from.u.r == from.u.r));
  if (whole) return omni_dyn_of_real((double)omni_s16_last_index_of(v, n));
  int64_t start = to_int_arg(from, 0);
  if (start < 0) start = 0;
  if (start > v.len) start = v.len;
  for (int64_t i = start; i >= 0; i--) {
    if (i + n.len > v.len) continue;
    bool eq = true;
    for (int64_t j = 0; j < n.len; j++) {
      if (v.p[i + j] != n.p[j]) { eq = false; break; }
    }
    if (eq) return omni_dyn_of_real((double)i);
  }
  return omni_dyn_of_real(-1.0);
}

bool omni_js_str_includes(omni_dyn s, omni_dyn needle) {
  return omni_s16_index_of(want_s16(s), want_s16(needle), 0) >= 0;
}

/* startsWith 的第二个实参（起始位置）是必需的：词法器的标点匹配就靠它
   （`PUNCT.find((op) => src.startsWith(op, i))`），而且在热路径上。 */
bool omni_js_str_starts_with(omni_dyn s, omni_dyn pre, omni_dyn pos) {
  omni_s16 v = want_s16(s);
  int64_t at = to_int_arg(pos, 0);
  if (at < 0) at = 0;
  if (at > v.len) at = v.len;
  return omni_s16_starts_with(omni_s16_slice(v, at, v.len), want_s16(pre));
}

bool omni_js_str_ends_with(omni_dyn s, omni_dyn suf) {
  return omni_s16_ends_with(want_s16(s), want_s16(suf));
}

/* String.fromCharCode / fromCodePoint 在 JS 里是变长的；这里只收一个实参，
   多实参由降级拆成若干次 js_add —— ABI 里不引入变长 op，省得两个后端各自
   对"实参个数"做一套约定。 */
/* substr（Annex B）：起点认负数（从末尾数），第二格是**长度**不是终点。
   与 prelude 那份对着写。 */
omni_dyn omni_js_str_substr(omni_dyn s, omni_dyn a, omni_dyn n) {
  omni_s16 v = want_s16(s);
  int64_t st = to_int_arg(a, 0);
  int64_t len;
  if (st < 0) {
    st = v.len + st;
    if (st < 0) st = 0;
  }
  if (st > v.len) st = v.len;
  len = (n.tag == OMNI_DYN_UNDEF) ? v.len - st : to_int_arg(n, 0);
  if (len <= 0) return omni_dyn_of_s16(omni_s16_slice(v, 0, 0));
  if (st + len > v.len) len = v.len - st;
  return omni_dyn_of_s16(omni_s16_slice(v, st, st + len));
}

omni_dyn omni_js_str_of_char_code(omni_dyn u) {
  return omni_dyn_of_s16(omni_s16_of_code_unit(to_int_arg(u, 0)));
}

omni_dyn omni_js_str_of_code_point(omni_dyn cp) {
  return omni_dyn_of_s16(omni_s16_of_code_point(to_int_arg(cp, 0)));
}

/* isWellFormed / toWellFormed（ES2024）：落单的代理项（没配对的 D800..DFFF）算"不良"。
   判据与 prelude 那份（转手宿主的同名方法）一样：高位后面必须紧跟低位，低位不能单独出现；
   toWellFormed 把每个落单的替成 U+FFFD，配好对的整段照抄。 */
bool omni_js_str_is_well_formed(omni_dyn s) {
  omni_s16 v = want_s16(s);
  for (int64_t i = 0; i < v.len; i++) {
    uint16_t u = v.p[i];
    if (u >= 0xD800 && u <= 0xDBFF) {
      if (i + 1 >= v.len) return false;
      uint16_t n = v.p[i + 1];
      if (n < 0xDC00 || n > 0xDFFF) return false;
      i++;
    } else if (u >= 0xDC00 && u <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

omni_dyn omni_js_str_to_well_formed(omni_dyn s) {
  omni_s16 v = want_s16(s);
  omni_s16_buf b = { NULL, 0, 0 };
  for (int64_t i = 0; i < v.len; i++) {
    uint16_t u = v.p[i];
    if (u >= 0xD800 && u <= 0xDBFF && i + 1 < v.len
        && v.p[i + 1] >= 0xDC00 && v.p[i + 1] <= 0xDFFF) {
      omni_s16_buf_add_unit(&b, u);
      omni_s16_buf_add_unit(&b, v.p[i + 1]);
      i++;
      continue;
    }
    omni_s16_buf_add_unit(&b, (u >= 0xD800 && u <= 0xDFFF) ? 0xFFFD : u);
  }
  return omni_dyn_of_s16(omni_s16_buf_done(&b));
}
