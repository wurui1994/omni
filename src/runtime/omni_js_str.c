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

/* JS 的 ToIntegerOrInfinity（规范 7.1.5）：先 ToNumber，NaN 当 0，其余截尾。
   "1" / true / null 都收得下（量出来的："abcd".indexOf("c", "1") 两把尺子上是 2）；
   收到 bigint 才报 —— JS 里拿 BigInt 当下标本来就是 TypeError。 */
static int64_t to_int_arg(omni_dyn v, int64_t dflt) {
  if (v.tag == OMNI_DYN_UNDEF) return dflt;
  v = omni_js_num_of(v);
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

/* localeCompare（规范 22.1.3.12 的口径是"实现定义但一致"）。没有 ICU，所以照 qjs 那份：
   按**码点**比（代理对先拼起来），第一处不同给两个码点的差，一个是另一个的前缀就给码点
   个数的差。与 prelude 的 $js_str_locale_cmp 逐行对着写。 */
static uint32_t cp_at(omni_s16 v, int64_t k, int64_t *step) {
  uint32_t c = v.p[k];
  if (c >= 0xd800 && c <= 0xdbff && k + 1 < v.len && v.p[k + 1] >= 0xdc00 && v.p[k + 1] <= 0xdfff) {
    *step = 2;
    return 0x10000 + ((c - 0xd800) << 10) + (v.p[k + 1] - 0xdc00);
  }
  *step = 1;
  return c;
}

static int64_t cp_count(omni_s16 v, int64_t from) {
  int64_t n = 0;
  int64_t step = 1;
  for (int64_t k = from; k < v.len; k += step) {
    cp_at(v, k, &step);
    n++;
  }
  return n;
}

omni_dyn omni_js_str_locale_cmp(omni_dyn a, omni_dyn b) {
  omni_s16 x = want_s16(a);
  omni_s16 y = omni_js_as_s16(omni_js_str(b));
  int64_t i = 0, j = 0, si = 1, sj = 1;
  while (i < x.len && j < y.len) {
    uint32_t cx = cp_at(x, i, &si);
    uint32_t cy = cp_at(y, j, &sj);
    if (cx != cy) return omni_dyn_of_real((double)((int64_t)cx - (int64_t)cy));
    i += si;
    j += sj;
  }
  return omni_dyn_of_real((double)(cp_count(x, i) - cp_count(y, j)));
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

/* replaceAll 的字符串模式那一支**搬去了宏那一段**（omni_js_str_arr.h，紧挨 replace）：
   它要 omni_js_re_sub / omni_js_re_call 才能支持函数替换与 $ 展开，而那两格在 RE 那段
   里、只在生成的 TU 里展开 —— 这个翻译单元看不见它们。 */

/* side: 'b' 两头 / 'l' 只裁前 / 'r' 只裁后 */
omni_dyn omni_js_str_trim(int side, omni_dyn s) {
  return omni_dyn_of_s16(omni_s16_trim(want_s16(s), side != 'r', side != 'l'));
}

/* JS 的 toLowerCase / toUpperCase：**只折 ASCII，碰上非 ASCII 当场报错**。整个运行时
   没有 Unicode 大小写表（正则那边连 u 标志与 \p{...} 都是拒掉的），而半张表会撒谎：
   "Straße".toUpperCase() 按码元折出来是 "STRAßE"，两把尺子都给 "STRASSE"。
   判据与 prelude 的 $js_str_case_ascii 逐字相同。 */
/* 有大小写映射的码点（0x80 以上那一段），成对存 [起, 止]。与 prelude 的 $JS_CASED
   是同一批数字，判据就一行：
     String.fromCodePoint(cp).toLowerCase() !== ch || .toUpperCase() !== ch  */
static const uint32_t CASED[] = {
  0xb5,0xb5, 0xc0,0xd6, 0xd8,0xf6, 0xf8,0x137, 0x139,0x18c, 0x18e,0x1a9,
  0x1ac,0x1b9, 0x1bc,0x1bd, 0x1bf,0x1bf, 0x1c4,0x220, 0x222,0x233, 0x23a,0x254,
  0x256,0x257, 0x259,0x259, 0x25b,0x25c, 0x260,0x261, 0x263,0x266, 0x268,0x26c,
  0x26f,0x26f, 0x271,0x272, 0x275,0x275, 0x27d,0x27d, 0x280,0x280, 0x282,0x283,
  0x287,0x28c, 0x292,0x292, 0x29d,0x29e, 0x345,0x345, 0x370,0x373, 0x376,0x377,
  0x37b,0x37d, 0x37f,0x37f, 0x386,0x386, 0x388,0x38a, 0x38c,0x38c, 0x38e,0x3a1,
  0x3a3,0x3d1, 0x3d5,0x3f5, 0x3f7,0x3fb, 0x3fd,0x481, 0x48a,0x52f, 0x531,0x556,
  0x561,0x587, 0x10a0,0x10c5, 0x10c7,0x10c7, 0x10cd,0x10cd, 0x10d0,0x10fa, 0x10fd,0x10ff,
  0x13a0,0x13f5, 0x13f8,0x13fd, 0x1c80,0x1c8a, 0x1c90,0x1cba, 0x1cbd,0x1cbf, 0x1d79,0x1d79,
  0x1d7d,0x1d7d, 0x1d8e,0x1d8e, 0x1e00,0x1e9b, 0x1e9e,0x1e9e, 0x1ea0,0x1f15, 0x1f18,0x1f1d,
  0x1f20,0x1f45, 0x1f48,0x1f4d, 0x1f50,0x1f57, 0x1f59,0x1f59, 0x1f5b,0x1f5b, 0x1f5d,0x1f5d,
  0x1f5f,0x1f7d, 0x1f80,0x1fb4, 0x1fb6,0x1fbc, 0x1fbe,0x1fbe, 0x1fc2,0x1fc4, 0x1fc6,0x1fcc,
  0x1fd0,0x1fd3, 0x1fd6,0x1fdb, 0x1fe0,0x1fec, 0x1ff2,0x1ff4, 0x1ff6,0x1ffc, 0x2126,0x2126,
  0x212a,0x212b, 0x2132,0x2132, 0x214e,0x214e, 0x2160,0x217f, 0x2183,0x2184, 0x24b6,0x24e9,
  0x2c00,0x2c70, 0x2c72,0x2c73, 0x2c75,0x2c76, 0x2c7e,0x2ce3, 0x2ceb,0x2cee, 0x2cf2,0x2cf3,
  0x2d00,0x2d25, 0x2d27,0x2d27, 0x2d2d,0x2d2d, 0xa640,0xa66d, 0xa680,0xa69b, 0xa722,0xa72f,
  0xa732,0xa76f, 0xa779,0xa787, 0xa78b,0xa78d, 0xa790,0xa794, 0xa796,0xa7ae, 0xa7b0,0xa7dc,
  0xa7f5,0xa7f6, 0xab53,0xab53, 0xab70,0xabbf, 0xfb00,0xfb06, 0xfb13,0xfb17, 0xff21,0xff3a,
  0xff41,0xff5a, 0x10400,0x1044f, 0x104b0,0x104d3, 0x104d8,0x104fb, 0x10570,0x1057a, 0x1057c,0x1058a,
  0x1058c,0x10592, 0x10594,0x10595, 0x10597,0x105a1, 0x105a3,0x105b1, 0x105b3,0x105b9, 0x105bb,0x105bc,
  0x10c80,0x10cb2, 0x10cc0,0x10cf2, 0x10d50,0x10d65, 0x10d70,0x10d85, 0x118a0,0x118df, 0x16e40,0x16e7f,
  0x16ea0,0x16eb8, 0x16ebb,0x16ed3, 0x1e900,0x1e943,
};
static bool cased_cp(uint32_t cp) {
  for (size_t i = 0; i < sizeof(CASED) / sizeof(CASED[0]); i += 2) {
    if (cp >= CASED[i] && cp <= CASED[i + 1]) return true;
  }
  return false;
}
static omni_s16 case_ascii(omni_s16 v, const char *what) {
  for (int64_t i = 0; i < v.len; i++) {
    uint32_t cp = v.p[i];
    if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < v.len && v.p[i + 1] >= 0xDC00 && v.p[i + 1] <= 0xDFFF) {
      cp = 0x10000 + ((cp - 0xD800) << 10) + (v.p[i + 1] - 0xDC00);
      i++;
    }
    if (cp > 0x7f && cased_cp(cp)) {
      omni_errorf("%s: no Unicode case table for U+%X (ADR-0020)", what, cp);
    }
  }
  return v;
}
omni_dyn omni_js_str_lower(omni_dyn s) {
  return omni_dyn_of_s16(omni_s16_lower(case_ascii(want_s16(s), "toLowerCase")));
}
omni_dyn omni_js_str_upper(omni_dyn s) {
  return omni_dyn_of_s16(omni_s16_upper(case_ascii(want_s16(s), "toUpperCase")));
}

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

bool omni_js_str_includes(omni_dyn s, omni_dyn needle, omni_dyn pos) {
  omni_s16 v = want_s16(s);
  int64_t at = to_int_arg(pos, 0);
  if (at < 0) at = 0;
  if (at > v.len) at = v.len;
  return omni_s16_index_of(v, want_s16(needle), at) >= 0;
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

/* endsWith 的第二个实参是**终点**（不给就是长度）：`"abc".endsWith("b", 2)` 是 true */
bool omni_js_str_ends_with(omni_dyn s, omni_dyn suf, omni_dyn end) {
  omni_s16 v = want_s16(s);
  int64_t at = to_int_arg(end, v.len);
  if (at < 0) at = 0;
  if (at > v.len) at = v.len;
  return omni_s16_ends_with(omni_s16_slice(v, 0, at), want_s16(suf));
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

/* 四个 URI 全局函数（规范 19.2.6）。op 码：'e' encodeURIComponent / 'E' encodeURI /
   'd' decodeURIComponent / 'D' decodeURI —— 与 prelude 的 $js_uri 同一套判据：
   手划 UTF-8 编解码，畸形输入先自己查出来（宿主那边是 URIError，这个值域里没有）。 */
static const char *URI_KEEP = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()";
static const char *URI_RESERVED = ";/?:@&=+$,#";
static const char *URI_HEX = "0123456789ABCDEF";

static bool uri_in(const char *set, uint16_t u) {
  if (u > 0x7F) return false;
  for (const char *p = set; *p; p++) if ((uint16_t)(unsigned char)*p == u) return true;
  return false;
}

static void uri_pct(omni_s16_buf *b, int byte) {
  omni_s16_buf_add_unit(b, '%');
  omni_s16_buf_add_unit(b, (uint16_t)(unsigned char)URI_HEX[(byte >> 4) & 15]);
  omni_s16_buf_add_unit(b, (uint16_t)(unsigned char)URI_HEX[byte & 15]);
}

// v.p[i] 是 '%'：读出那一组两位十六进制的字节值
static int uri_byte(omni_s16 v, int64_t i) {
  if (i + 2 >= v.len) omni_error("URI malformed");
  int h = -1, l = -1;
  for (int k = 0; k < 16; k++) {
    uint16_t u = (uint16_t)(unsigned char)URI_HEX[k];
    uint16_t lo = (uint16_t)(unsigned char)("0123456789abcdef"[k]);
    if (v.p[i + 1] == u || v.p[i + 1] == lo) h = k;
    if (v.p[i + 2] == u || v.p[i + 2] == lo) l = k;
  }
  if (h < 0 || l < 0) omni_error("URI malformed");
  return h * 16 + l;
}

static omni_dyn uri_enc(omni_s16 v, bool keep_reserved) {
  omni_s16_buf b = { NULL, 0, 0 };
  for (int64_t i = 0; i < v.len; i++) {
    uint16_t u = v.p[i];
    if (uri_in(URI_KEEP, u) || (keep_reserved && uri_in(URI_RESERVED, u))) {
      omni_s16_buf_add_unit(&b, u);
      continue;
    }
    // 落单的代理项就是畸形；配好对的合成码点
    int64_t cp = u;
    if (u >= 0xD800 && u <= 0xDBFF) {
      if (i + 1 >= v.len || v.p[i + 1] < 0xDC00 || v.p[i + 1] > 0xDFFF) omni_error("URI malformed");
      cp = 0x10000 + ((int64_t)(u - 0xD800) << 10) + (v.p[i + 1] - 0xDC00);
      i++;
    } else if (u >= 0xDC00 && u <= 0xDFFF) {
      omni_error("URI malformed");
    }
    if (cp < 0x80) {
      uri_pct(&b, (int)cp);
    } else if (cp < 0x800) {
      uri_pct(&b, (int)(0xC0 | (cp >> 6)));
      uri_pct(&b, (int)(0x80 | (cp & 63)));
    } else if (cp < 0x10000) {
      uri_pct(&b, (int)(0xE0 | (cp >> 12)));
      uri_pct(&b, (int)(0x80 | ((cp >> 6) & 63)));
      uri_pct(&b, (int)(0x80 | (cp & 63)));
    } else {
      uri_pct(&b, (int)(0xF0 | (cp >> 18)));
      uri_pct(&b, (int)(0x80 | ((cp >> 12) & 63)));
      uri_pct(&b, (int)(0x80 | ((cp >> 6) & 63)));
      uri_pct(&b, (int)(0x80 | (cp & 63)));
    }
  }
  return omni_dyn_of_s16(omni_s16_buf_done(&b));
}

static omni_dyn uri_dec(omni_s16 v, bool keep_reserved) {
  omni_s16_buf b = { NULL, 0, 0 };
  for (int64_t i = 0; i < v.len; i++) {
    if (v.p[i] != '%') { omni_s16_buf_add_unit(&b, v.p[i]); continue; }
    int64_t start = i;
    int b0 = uri_byte(v, i);
    i += 2;
    if (b0 < 0x80) {
      if (keep_reserved && uri_in(URI_RESERVED, (uint16_t)b0)) {
        for (int64_t k = start; k <= i; k++) omni_s16_buf_add_unit(&b, v.p[k]);
      } else {
        omni_s16_buf_add_unit(&b, (uint16_t)b0);
      }
      continue;
    }
    // 首字节定长度：C2..DF 两字节、E0..EF 三字节、F0..F4 四字节（C0/C1 是过长编码）
    int n;
    if (b0 >= 0xC2 && b0 <= 0xDF) n = 1;
    else if (b0 >= 0xE0 && b0 <= 0xEF) n = 2;
    else if (b0 >= 0xF0 && b0 <= 0xF4) n = 3;
    else { omni_error("URI malformed"); }
    int64_t cp = b0 & (n == 1 ? 31 : n == 2 ? 15 : 7);
    for (int k = 0; k < n; k++) {
      i++;
      if (i >= v.len || v.p[i] != '%') omni_error("URI malformed");
      int by = uri_byte(v, i);
      i += 2;
      if (by < 0x80 || by > 0xBF) omni_error("URI malformed");
      cp = (cp << 6) | (by & 63);
    }
    // 过长编码、代理项区间、超出 10FFFF 一律算畸形
    if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) omni_error("URI malformed");
    if (n == 2 && cp < 0x800) omni_error("URI malformed");
    if (n == 3 && cp < 0x10000) omni_error("URI malformed");
    omni_s16 one = omni_s16_of_code_point(cp);
    for (int64_t k = 0; k < one.len; k++) omni_s16_buf_add_unit(&b, one.p[k]);
  }
  return omni_dyn_of_s16(omni_s16_buf_done(&b));
}

omni_dyn omni_js_uri(int op, omni_dyn s) {
  omni_s16 v = want_s16(omni_js_str(s));
  if (op == 'e') return uri_enc(v, false);
  if (op == 'E') return uri_enc(v, true);
  if (op == 'd') return uri_dec(v, false);
  return uri_dec(v, true);
}
