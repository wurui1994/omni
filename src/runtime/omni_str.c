/* 字符串：不可变 UTF-8 字节序列。构造/比较/取字节/substr 在 omni.h 里（内联），
   这里放要分配或要扫描的那些。
   注意：拼接结果**不保证以 NUL 结尾** —— substr 是别名切片，本来就没这个保证，
   所以要交给 libc 的地方一律先过 omni_cstr。 */
#include "omni.h"

/*
 * 拼接。快路径解决的是一个算法问题，不是常数问题：
 * `acc = acc + x` 写在循环里，朴素实现每次都重新分配加拷贝，总代价 O(n²)。
 * V8 靠 rope（cons string）把它压到 O(n)，我们靠 arena 的一个性质：
 * 如果 a 的末尾正好就是 arena 的分配位置，那么 a 后面那段字节还没被分配过，
 * 直接把 b 拷进去、把 arena 指针推过去，就得到了 a+b，零拷贝 a。
 *
 * 这为什么是别名安全的：a 本身没被改动（它的长度还是 a.len），我们只写 a 结尾之后
 * 那段无主内存。任何还持有 a 的人看到的字节完全不变。
 * 即使 a 只是"恰好"结束在 arena 顶上（比如某个 substr 切片），结论也一样成立。
 */
omni_str omni_str_cat(omni_str a, omni_str b) {
  if (b.len == 0) return a;
  if (a.len == 0) return b;
#ifndef OMNI_NO_ARENA
  if (a.p + a.len == omni_arena_ptr && (size_t)b.len <= (size_t)(omni_arena_end - omni_arena_ptr)) {
    memcpy(omni_arena_ptr, b.p, (size_t)b.len);
    omni_arena_ptr += b.len;
    return omni_str_new(a.p, a.len + b.len);
  }
#endif
  char *buf = omni_alloc_bytes(a.len + b.len);
  memcpy(buf, a.p, (size_t)a.len);
  memcpy(buf + a.len, b.p, (size_t)b.len);
  return omni_str_new(buf, a.len + b.len);
}

/* 一次算总长、一次分配、逐段拷贝。编译器里最热的形态是 out.push(片段) 然后 join，
   逐个 + 起来即使有上面的快路径也要多走 n 次函数调用和 n 次长度检查。 */
omni_str omni_str_join(const omni_str *items, int64_t n, omni_str sep) {
  if (n <= 0) return omni_str_new("", 0);
  if (n == 1) return items[0];
  int64_t total = sep.len * (n - 1);
  for (int64_t i = 0; i < n; i++) total += items[i].len;
  char *buf = omni_alloc_bytes(total);
  int64_t w = 0;
  for (int64_t i = 0; i < n; i++) {
    if (i && sep.len) { memcpy(buf + w, sep.p, (size_t)sep.len); w += sep.len; }
    if (items[i].len) { memcpy(buf + w, items[i].p, (size_t)items[i].len); w += items[i].len; }
  }
  return omni_str_new(buf, total);
}

omni_str omni_str_fmt(const char *fmt, ...) {
  /* **先往栈上那块写，够用就只格式化一遍**。从前是 `vsnprintf(NULL,0,…)` 先量长度、
     再写一遍 —— 对 `%.17g` 来说那次 double->十进制的转换做了**两次**。
     量出来（pdb，`OMNI_PROFILE=1`）：三维清单里的 `sn` = `string(v,17)` 被调 1022 万次、
     自用 5.9s 排第一，而它的时间几乎全在这两遍上。这条路是整条 C 腿公用的
     （`string(real)` / `string(int)` / `format` 都过它），所以收益不止三维那一路。
     输出逐字节不变：同一个 vsnprintf、同一个格式串。 */
  char tmp[256];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(tmp, sizeof tmp, fmt, ap);
  va_end(ap);
  if (n < 0) omni_error("formatting failed");
  char *buf = omni_alloc_bytes((int64_t)n + 1);
  if ((size_t)n < sizeof tmp) {
    memcpy(buf, tmp, (size_t)n + 1);
  } else {
    va_start(ap, fmt);
    vsnprintf(buf, (size_t)n + 1, fmt, ap);
    va_end(ap);
  }
  return omni_str_new(buf, n);
}

/* 按字节找子串。空串在位置 0 命中，和 JS 的 indexOf 一致。 */
int64_t omni_index_of(omni_str s, omni_str needle) {
  for (int64_t i = 0; i + needle.len <= s.len; i++) {
    if (needle.len == 0 || memcmp(s.p + i, needle.p, (size_t)needle.len) == 0) return i;
  }
  return -1;
}

/* 子串。omni.h 里的 omni_substr 是 static inline，LLVM 那条腿 call 不到一个 inline 函数，
   所以这里给它一个**真符号**的外壳 —— 实现只有一行转发，两条腿因此不可能分叉
   （越界的话与检查都在那一份 inline 里）。C 那条腿仍然直接用 inline 的那个。
   omni_str_length 同理：长度就是结构体的第二个 i64，LLVM 那边本可以 extractvalue，
   但那样"取长度"就有了两份实现；多走一层符号的代价是一次调用，换的是不会分叉。 */
omni_str omni_str_sub(omni_str s, int64_t start, int64_t len) {
  return omni_substr(s, start, len);
}

int64_t omni_str_length(omni_str s) {
  return omni_str_len(s);
}

/* `(srep S N)` —— 把 S 重复 N 遍（ADR-0016 第五刀，printf 的宽度要它）。
   `n <= 0` 回空串，**不报错**：宽度就是"补到至少 N 个字符"，`max(0, N - 长度)` 常常
   是 0 或负数，那是正常情形而不是错误。JS 的 `String.repeat` 在负数上抛异常，所以
   那一侧也得先夹住 —— 五条腿一套语义，夹的位置写在两边同一个地方。
   刻意**不**接封闭 ABI 里那个 js_str_repeat：它收发 omni_dyn，从这条按类型走的路上
   用它要装箱拆箱两次。 */
omni_str omni_str_repeat(omni_str s, int64_t n) {
  if (n <= 0 || s.len == 0) return omni_str_new("", 0);
  int64_t total = s.len * n;
  char *buf = omni_alloc_bytes(total);
  for (int64_t i = 0; i < n; i++) memcpy(buf + i * s.len, s.p, (size_t)s.len);
  return omni_str_new(buf, total);
}

/* `(sbase E 进制)` —— 按某个进制印一个整数（ADR-0016 第七刀，jancy 的 `%x` / `%o` 要它）。
   **v 的位当无符号 64 位读**：那是 C 的 `%x` 的规矩（它把实参当 unsigned），所以
   `omni_str_base(-1, 16)` 是 16 个 f。要 32 位的答案就在上一层先掩一次 —— 位宽是降级
   那一层的账。数字小写，与 JS 侧 `BigInt.prototype.toString(radix)` 那张表同一套。
   进制在方言那一层就查过了（必须是 2..36 的字面量），这里不再查。
   64 位在 2 进制下最多 64 位数字，所以 65 个字节的临时缓冲一定够。 */
omni_str omni_str_base(int64_t v, int64_t base) {
  static const char digits[] = "0123456789abcdefghijklmnopqrstuvwxyz";
  uint64_t u = (uint64_t)v;
  uint64_t b = (uint64_t)base;
  char tmp[65];
  int k = 0;
  if (u == 0) tmp[k++] = '0';
  while (u != 0) { tmp[k++] = digits[u % b]; u /= b; }
  char *buf = omni_alloc_bytes(k);
  for (int i = 0; i < k; i++) buf[i] = tmp[k - 1 - i];
  return omni_str_new(buf, k);
}

/* `(supper S)` —— **只**把 ASCII 的 a-z 换成大写，别的字节一个不动。
   刻意不用 `toupper`：那看 locale。JS 那侧的 `toUpperCase()` 也不行 —— 它是 Unicode 的
   （`"ß"` 会变成两个字符，长度都变了）。定成 ASCII-only 之后四条腿是同一个函数。 */
omni_str omni_str_upper(omni_str s) {
  if (s.len == 0) return omni_str_new("", 0);
  char *buf = omni_alloc_bytes(s.len);
  for (int64_t i = 0; i < s.len; i++) {
    char c = s.p[i];
    buf[i] = (c >= 'a' && c <= 'z') ? (char)(c - 'a' + 'A') : c;
  }
  return omni_str_new(buf, s.len);
}

/* JS 的 String.fromCodePoint 对代理区返回孤立代理，写出去就是 U+FFFD，这里保持一致 */
omni_str omni_chr(int64_t cp) {
  if (cp < 0 || cp > 0x10ffff) {
    omni_errorf("chr(): code point out of range: %lld", (long long)cp);
  }
  if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
  char b[4];
  int64_t n;
  if (cp < 0x80) { b[0] = (char)cp; n = 1; }
  else if (cp < 0x800) { b[0] = (char)(0xc0 | (cp >> 6)); b[1] = (char)(0x80 | (cp & 0x3f)); n = 2; }
  else if (cp < 0x10000) {
    b[0] = (char)(0xe0 | (cp >> 12));
    b[1] = (char)(0x80 | ((cp >> 6) & 0x3f));
    b[2] = (char)(0x80 | (cp & 0x3f));
    n = 3;
  } else {
    b[0] = (char)(0xf0 | (cp >> 18));
    b[1] = (char)(0x80 | ((cp >> 12) & 0x3f));
    b[2] = (char)(0x80 | ((cp >> 6) & 0x3f));
    b[3] = (char)(0x80 | (cp & 0x3f));
    n = 4;
  }
  char *out = omni_alloc_bytes(n);
  memcpy(out, b, (size_t)n);
  return omni_str_new(out, n);
}

/* 交给 libc 之前要一份 NUL 结尾的副本：omni_str 可能是别名进来的切片 */
char *omni_cstr(omni_str s) {
  char *b = omni_alloc_bytes(s.len + 1);
  if (s.len) memcpy(b, s.p, (size_t)s.len);
  b[s.len] = 0;
  return b;
}
