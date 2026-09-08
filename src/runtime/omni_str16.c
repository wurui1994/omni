/* JS 的 String：UTF-16 码元序列（ADR-0011 第 8 节）
 *
 * 为什么不复用 omni_str：`.length` / `charCodeAt` / `slice` 在 JS 里全是码元口径，
 * 而编译器自己的源码里满是中文注释 —— 一个汉字 3 个 UTF-8 字节、1 个 UTF-16 码元。
 * 两个口径下词法器切出的 token 位置不同，诊断里的列号与插入符对齐当场分叉。
 *
 * 不可变，所以 slice 直接别名原缓冲区，不拷贝。
 * 分配走 omni_alloc（对齐的那个）：uint16_t 要 2 字节对齐。
 */
#include "omni.h"

static uint16_t *alloc16(int64_t n) {
  if (n < 0) omni_error("negative string length");
  return (uint16_t *)omni_alloc((size_t)n * sizeof(uint16_t));
}

static omni_s16 mk(const uint16_t *p, int64_t len) {
  omni_s16 s; s.p = p; s.len = len; return s;
}

/* ---------------------------------------------------------------- 转码 */

/* ------------------------------------------------------------ 增量拼接 */

/* 一段一段往后拼的缓冲区。为什么不用 omni_s16_cat 串起来：replace / split 要在
   整个源文件量级的串上做（c_runtime.js 那个 include 展开就是），一次 cat 拷一遍全串
   会退化成平方级。这里按倍增分配，总拷贝是线性的。
   arena 上没有 free，所以倍增浪费的那部分等于一次编译的临时开销，可接受。 */
void omni_s16_buf_add(omni_s16_buf *b, omni_s16 s) {
  if (b->len + s.len > b->cap) {
    int64_t cap = b->cap ? b->cap : 32;
    while (cap < b->len + s.len) cap *= 2;
    uint16_t *p = alloc16(cap);
    if (b->len) memcpy(p, b->p, (size_t)b->len * sizeof(uint16_t));
    b->p = p;
    b->cap = cap;
  }
  if (s.len) memcpy(b->p + b->len, s.p, (size_t)s.len * sizeof(uint16_t));
  b->len += s.len;
}

void omni_s16_buf_add_unit(omni_s16_buf *b, uint16_t u) {
  omni_s16 one;
  one.p = &u;
  one.len = 1;
  omni_s16_buf_add(b, one);
}

omni_s16 omni_s16_buf_done(omni_s16_buf *b) {
  return mk(b->p ? b->p : alloc16(0), b->len);
}

/* 直接给码元序列建串：只给 C 后端的字面量用。
   源码里的字符串常量平时走 UTF-8（生成的 C 才不会被大括号数组撑肿），但落单的代理项
   在 UTF-8 里没有合法编码 —— JSON.stringify("\ud800") 这种用例只能按码元发。
   参数一般是复合字面量（块作用域），所以这里必须拷进 arena。 */
omni_s16 omni_s16_of_units(const uint16_t *p, int64_t len) {
  uint16_t *out = alloc16(len);
  memcpy(out, p, (size_t)len * sizeof(uint16_t));
  return mk(out, len);
}

/* UTF-8 -> UTF-16。非法字节序列按 U+FFFD 吞掉一个字节：解析器不该因为源文件里
   有一段坏字节就崩，而且 node 读文件时也是这么替换的。 */
omni_s16 omni_s16_of_utf8(omni_str s) {
  /* 上界：每个字节最多产出一个码元（4 字节序列产出 2 个，但它占了 4 个字节） */
  uint16_t *out = alloc16(s.len);
  int64_t n = 0;
  const unsigned char *p = (const unsigned char *)s.p;
  int64_t i = 0;
  while (i < s.len) {
    unsigned c = p[i];
    uint32_t cp;
    int extra;
    if (c < 0x80) { cp = c; extra = 0; }
    else if ((c & 0xe0) == 0xc0) { cp = c & 0x1fu; extra = 1; }
    else if ((c & 0xf0) == 0xe0) { cp = c & 0x0fu; extra = 2; }
    else if ((c & 0xf8) == 0xf0) { cp = c & 0x07u; extra = 3; }
    else { out[n++] = 0xfffd; i++; continue; }
    if (i + extra >= s.len) { out[n++] = 0xfffd; i++; continue; }
    bool ok = true;
    for (int k = 1; k <= extra; k++) {
      unsigned cc = p[i + k];
      if ((cc & 0xc0) != 0x80) { ok = false; break; }
      cp = (cp << 6) | (cc & 0x3fu);
    }
    if (!ok) { out[n++] = 0xfffd; i++; continue; }
    i += extra + 1;
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) { out[n++] = 0xfffd; continue; }
    if (cp <= 0xffff) {
      out[n++] = (uint16_t)cp;
    } else {
      cp -= 0x10000;
      out[n++] = (uint16_t)(0xd800 + (cp >> 10));
      out[n++] = (uint16_t)(0xdc00 + (cp & 0x3ff));
    }
  }
  return mk(out, n);
}

/* UTF-16 -> UTF-8。落单的代理项写成 U+FFFD：WTF-8 会更"无损"，但落单代理项在编译器
   源码里不存在，而 WTF-8 会让外面的工具读不懂输出。 */
omni_str omni_s16_to_utf8(omni_s16 s) {
  char *out = omni_alloc_bytes(s.len * 3 + 1);
  int64_t n = 0;
  for (int64_t i = 0; i < s.len; i++) {
    uint32_t cp = s.p[i];
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.len && s.p[i + 1] >= 0xdc00 && s.p[i + 1] <= 0xdfff) {
      cp = 0x10000 + ((cp - 0xd800) << 10) + (s.p[i + 1] - 0xdc00);
      i++;
    } else if (cp >= 0xd800 && cp <= 0xdfff) {
      cp = 0xfffd;
    }
    if (cp < 0x80) {
      out[n++] = (char)cp;
    } else if (cp < 0x800) {
      out[n++] = (char)(0xc0 | (cp >> 6));
      out[n++] = (char)(0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out[n++] = (char)(0xe0 | (cp >> 12));
      out[n++] = (char)(0x80 | ((cp >> 6) & 0x3f));
      out[n++] = (char)(0x80 | (cp & 0x3f));
    } else {
      out[n++] = (char)(0xf0 | (cp >> 18));
      out[n++] = (char)(0x80 | ((cp >> 12) & 0x3f));
      out[n++] = (char)(0x80 | ((cp >> 6) & 0x3f));
      out[n++] = (char)(0x80 | (cp & 0x3f));
    }
  }
  out[n] = '\0';
  return omni_str_new(out, n);
}

/* ---------------------------------------------------------------- 拼接与切片 */

/* 累加缓存：`s = s + piece` 一段一段往后拼是这个值域里最常见的写法（编译器自己的输出就是
   这么攒出来的），而 omni_s16 是不可变的 {p,len}，没有容量字段 —— 每次 cat 都重新分配全长
   就是**平方级**。所以这里记住最近一次 cat 产出的缓冲区（起点/长度/容量）：下一次 cat 的
   左串正好是它时，直接写进预留出来的容量里。指针+长度相同就必然是同一个串，别名安全：
   只往 len 之后写，已有码元一个都不动。
   （arena 顶那条快路径不够用：两次追加之间只要有任何别的分配，累加串就不在顶上了。） */
static uint16_t *acc_p;
static int64_t acc_len, acc_cap;

/* 超过这个长度才预留容量 —— 小串占多数，给它们留白只是浪费 */
#define S16_SLACK_MIN 512

omni_s16 omni_s16_cat(omni_s16 a, omni_s16 b) {
  if (a.len == 0) return b;
  if (b.len == 0) return a;
  if (a.p == acc_p && a.len == acc_len && acc_cap - acc_len >= b.len) {
    memcpy(acc_p + acc_len, b.p, (size_t)b.len * 2);
    acc_len += b.len;
    return mk(acc_p, acc_len);
  }
#ifndef OMNI_NO_ARENA
  /* a 正好是 arena 顶上那块时，把 b 直接追加上去 = 真正的原地扩容（同 omni_str_cat） */
  size_t bb = (size_t)b.len * sizeof(uint16_t);
  if ((const char *)(a.p + a.len) == omni_arena_ptr && bb <= (size_t)(omni_arena_end - omni_arena_ptr)) {
    memcpy(omni_arena_ptr, b.p, bb);
    omni_arena_ptr += bb;
    return mk(a.p, a.len + b.len);
  }
#endif
  int64_t need = a.len + b.len;
  int64_t cap = need >= S16_SLACK_MIN ? need * 2 : need;
  uint16_t *out = alloc16(cap);
  memcpy(out, a.p, (size_t)a.len * 2);
  memcpy(out + a.len, b.p, (size_t)b.len * 2);
  if (cap > need) { acc_p = out; acc_len = need; acc_cap = cap; }
  return mk(out, need);
}

/* start/end 必须是调用方按 JS 规则夹好的（0 <= start <= end <= len）；
   夹取逻辑在 op 层，因为 slice / substring / at 各夹得不一样。 */
omni_s16 omni_s16_slice(omni_s16 s, int64_t start, int64_t end) {
  if (start < 0) start = 0;
  if (end > s.len) end = s.len;
  if (end <= start) return mk(s.p, 0);
  return mk(s.p + start, end - start);
}

omni_s16 omni_s16_repeat(omni_s16 s, int64_t n) {
  if (n < 0) omni_error("repeat count must not be negative");
  if (n == 0 || s.len == 0) return mk(s.p, 0);
  uint16_t *out = alloc16(s.len * n);
  for (int64_t i = 0; i < n; i++) memcpy(out + i * s.len, s.p, (size_t)s.len * 2);
  return mk(out, s.len * n);
}

/* JS 的 padStart：填充串被截断到刚好补满，fill 为空则原样返回 */
omni_s16 omni_s16_pad_start(omni_s16 s, int64_t want, omni_s16 fill) {
  if (want <= s.len || fill.len == 0) return s;
  int64_t need = want - s.len;
  uint16_t *out = alloc16(want);
  for (int64_t i = 0; i < need; i++) out[i] = fill.p[i % fill.len];
  memcpy(out + need, s.p, (size_t)s.len * 2);
  return mk(out, want);
}

/* JS 的 padEnd：与 padStart 同一套截断规则，只是补在后面 */
omni_s16 omni_s16_pad_end(omni_s16 s, int64_t want, omni_s16 fill) {
  if (want <= s.len || fill.len == 0) return s;
  uint16_t *out = alloc16(want);
  memcpy(out, s.p, (size_t)s.len * 2);
  for (int64_t i = s.len; i < want; i++) out[i] = fill.p[(i - s.len) % fill.len];
  return mk(out, want);
}

/* 只折 ASCII。JS 的 toLowerCase 走完整 Unicode 大小写表，但编译器源码里只对
   ASCII 标识符与十六进制数字用它 —— 真需要更多时，测试轴会先炸出来。 */
omni_s16 omni_s16_lower(omni_s16 s) {
  uint16_t *out = alloc16(s.len);
  for (int64_t i = 0; i < s.len; i++) {
    uint16_t c = s.p[i];
    out[i] = (c >= 'A' && c <= 'Z') ? (uint16_t)(c + 32) : c;
  }
  return mk(out, s.len);
}

omni_s16 omni_s16_upper(omni_s16 s) {
  uint16_t *out = alloc16(s.len);
  for (int64_t i = 0; i < s.len; i++) {
    uint16_t c = s.p[i];
    out[i] = (c >= 'a' && c <= 'z') ? (uint16_t)(c - 32) : c;
  }
  return mk(out, s.len);
}

omni_s16 omni_s16_of_code_unit(int64_t u) {
  uint16_t *out = alloc16(1);
  out[0] = (uint16_t)(u & 0xffff);
  return mk(out, 1);
}

omni_s16 omni_s16_of_code_point(int64_t cp) {
  if (cp < 0 || cp > 0x10ffff) omni_errorf("invalid code point %lld", (long long)cp);
  if (cp <= 0xffff) return omni_s16_of_code_unit(cp);
  uint16_t *out = alloc16(2);
  int64_t v = cp - 0x10000;
  out[0] = (uint16_t)(0xd800 + (v >> 10));
  out[1] = (uint16_t)(0xdc00 + (v & 0x3ff));
  return mk(out, 2);
}

/* ---------------------------------------------------------------- 比较与查找 */

/* 按码元比较。JS 的 `<` 就是这个口径（不是码点序），所以 U+FFFF 会排在
   补充平面字符之后 —— 这不是 bug，是规范。 */
int omni_s16_cmp(omni_s16 a, omni_s16 b) {
  int64_t n = a.len < b.len ? a.len : b.len;
  for (int64_t i = 0; i < n; i++) {
    if (a.p[i] != b.p[i]) return a.p[i] < b.p[i] ? -1 : 1;
  }
  return a.len == b.len ? 0 : (a.len < b.len ? -1 : 1);
}

bool omni_s16_eq(omni_s16 a, omni_s16 b) {
  return a.len == b.len && (a.len == 0 || memcmp(a.p, b.p, (size_t)a.len * 2) == 0);
}

/* FNV-1a，按字节走：只要两边（这里与 prelude 的 $s16 键）用同一个 dict 实现就行，
   hash 值本身不出现在任何输出里，所以不需要和 JS 侧逐位相同。 */
uint64_t omni_s16_hash(omni_s16 s) {
  uint64_t h = 0xcbf29ce484222325ULL;
  for (int64_t i = 0; i < s.len; i++) {
    h ^= (uint64_t)(s.p[i] & 0xff); h *= 0x100000001b3ULL;
    h ^= (uint64_t)(s.p[i] >> 8);   h *= 0x100000001b3ULL;
  }
  return h;
}

int64_t omni_s16_index_of(omni_s16 s, omni_s16 needle, int64_t from) {
  if (from < 0) from = 0;
  if (needle.len == 0) return from <= s.len ? from : s.len;
  for (int64_t i = from; i + needle.len <= s.len; i++) {
    if (memcmp(s.p + i, needle.p, (size_t)needle.len * 2) == 0) return i;
  }
  return -1;
}

int64_t omni_s16_last_index_of(omni_s16 s, omni_s16 needle) {
  if (needle.len == 0) return s.len;
  for (int64_t i = s.len - needle.len; i >= 0; i--) {
    if (memcmp(s.p + i, needle.p, (size_t)needle.len * 2) == 0) return i;
  }
  return -1;
}

bool omni_s16_starts_with(omni_s16 s, omni_s16 pre) {
  return pre.len <= s.len && (pre.len == 0 || memcmp(s.p, pre.p, (size_t)pre.len * 2) == 0);
}

bool omni_s16_ends_with(omni_s16 s, omni_s16 suf) {
  return suf.len <= s.len
      && (suf.len == 0 || memcmp(s.p + (s.len - suf.len), suf.p, (size_t)suf.len * 2) == 0);
}

/* JS 的 trim 认这些：WhiteSpace + LineTerminator。列全了，不用 isspace ——
   isspace 受 locale 影响，而且不含 U+00A0 / U+FEFF。 */
static bool ws(uint16_t c) {
  switch (c) {
    case 0x09: case 0x0a: case 0x0b: case 0x0c: case 0x0d: case 0x20:
    case 0xa0: case 0x1680: case 0x2028: case 0x2029: case 0x202f:
    case 0x205f: case 0x3000: case 0xfeff:
      return true;
    default:
      return c >= 0x2000 && c <= 0x200a;
  }
}

omni_s16 omni_s16_trim(omni_s16 s, bool left, bool right) {
  int64_t a = 0, b = s.len;
  if (left) while (a < b && ws(s.p[a])) a++;
  if (right) while (b > a && ws(s.p[b - 1])) b--;
  return mk(s.p + a, b - a);
}
